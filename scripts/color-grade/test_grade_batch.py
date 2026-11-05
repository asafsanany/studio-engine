"""Tests for grade_batch.py's --bake-look (LUTs page, Cinematic preview) and --look-lut (a LUT a
note names). Standard library only.

Run: python3 -m unittest scripts/color-grade/test_grade_batch.py   (pnpm vitest runs it too).
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("grade_batch", HERE / "grade_batch.py")
grade_batch = importlib.util.module_from_spec(SPEC)
sys.modules["grade_batch"] = grade_batch  # dataclasses looks its module up here
SPEC.loader.exec_module(grade_batch)


def write_cube(path: Path, size: int, fn) -> None:
    """A .cube whose row for (r, g, b) in 0..1 is fn(r, g, b). Red varies fastest."""
    lines = ['TITLE "test"', f"LUT_3D_SIZE {size}"]
    for b in range(size):
        for g in range(size):
            for r in range(size):
                out = fn(r / (size - 1), g / (size - 1), b / (size - 1))
                lines.append(" ".join(f"{value:.8f}" for value in out))
    path.write_text("\n".join(lines) + "\n")


def make_skill(root: Path, film, golden) -> Path:
    """A stand-in colour-grade skill with the two LUTs the cinematic look reads."""
    luts = root / "correction_luts"
    luts.mkdir(parents=True)
    write_cube(luts / "film_contrast_80.cube", 5, film)
    write_cube(luts / "golden_warm.cube", 9, golden)
    return root


def scale(kr, kg, kb):
    return lambda r, g, b: (r * kr, g * kg, b * kb)


class BakeLookTest(unittest.TestCase):
    def setUp(self):
        self._scratch = tempfile.TemporaryDirectory()
        self.root = Path(self._scratch.name)

    def tearDown(self):
        self._scratch.cleanup()

    def bake(self, skill: Path) -> tuple[int, list[list[float]]]:
        out = self.root / "out" / "cinematic.cube"
        grade_batch.bake_look("cinematic", skill, out)
        return grade_batch.read_cube(out)

    def test_the_chain_is_the_look_with_its_blends(self):
        # Linear LUTs are exact under any interpolation, so the answer can be worked out by hand:
        # a blend s of "x -> k*x" with identity is x -> (1 + (k-1)*s) * x.
        skill = make_skill(self.root / "skill", scale(0.5, 0.5, 0.5), scale(0.9, 1.0, 1.1))
        film_blend, golden_blend = (blend for _, blend in grade_batch.LOOKS["cinematic"])
        film = 1 + (0.5 - 1) * film_blend
        golden = (1 + (0.9 - 1) * golden_blend, 1.0, 1 + (1.1 - 1) * golden_blend)
        size, rows = self.bake(skill)
        self.assertEqual(size, grade_batch.BAKE_GRID)
        self.assertEqual(len(rows), size ** 3)
        last = size - 1
        for i in (0, 1, size, size * size, size ** 3 // 2, size ** 3 - 1):
            r, g, b = i % size / last, i // size % size / last, i // (size * size) / last
            expected = [min(1.0, film * golden[0] * r), film * golden[1] * g, min(1.0, film * golden[2] * b)]
            for got, want in zip(rows[i], expected):
                self.assertAlmostEqual(got, want, places=5)

    def test_it_matches_running_each_lut_in_turn(self):
        # Non-linear LUTs: the bake samples the chain, so it agrees with applying the attenuated
        # LUTs one after the other to within the grid's interpolation.
        def film(r, g, b):
            return (r ** 1.4, g ** 1.4, b ** 1.4)

        def golden(r, g, b):
            return (min(1.0, r * 1.08 + 0.02), g, max(0.0, b * 0.9 - 0.01))

        skill = make_skill(self.root / "skill", film, golden)
        size, rows = self.bake(skill)
        chain = []
        for index, (name, blend) in enumerate(grade_batch.LOOKS["cinematic"]):
            target = self.root / f"step_{index}.cube"
            target.write_text((skill / "correction_luts" / f"{name}.cube").read_text())
            grade_batch.attenuate_cube(target, blend)
            chain.append(grade_batch.read_cube(target))
        for rgb in ([0.1, 0.5, 0.9], [0.8, 0.2, 0.4], [0.33, 0.33, 0.34], [0.95, 0.9, 0.05], [0.02, 0.03, 0.04]):
            expected = rgb
            for chain_size, chain_rows in chain:
                expected = grade_batch.tetrahedral(chain_size, chain_rows, expected)
            got = grade_batch.tetrahedral(size, rows, rgb)
            for a, b in zip(got, expected):
                self.assertAlmostEqual(a, b, delta=0.01)

    def test_identity_luts_bake_an_identity_cube(self):
        skill = make_skill(self.root / "skill", lambda r, g, b: (r, g, b), lambda r, g, b: (r, g, b))
        size, rows = self.bake(skill)
        last = size - 1
        for i, row in enumerate(rows):
            for got, want in zip(row, (i % size / last, i // size % size / last, i // (size * size) / last)):
                self.assertAlmostEqual(got, want, places=5)

    def test_tetrahedral_is_exact_on_the_grid_and_in_every_corner_ordering(self):
        size = 4
        rows = [[(r * 3 + g * 5 + b * 7) % 11 / 10 for _ in range(3)] for b in range(size) for g in range(size) for r in range(size)]
        for i, row in enumerate(rows):
            r, g, b = i % size, i // size % size, i // (size * size)
            got = grade_batch.tetrahedral(size, rows, [r / (size - 1), g / (size - 1), b / (size - 1)])
            for a, want in zip(got, row):
                self.assertAlmostEqual(a, want, places=6)
        # One point for each of the six orderings of the fractions: a linear cube is exact.
        linear = [[r + 2 * g + 3 * b for _ in range(3)] for b in range(size) for g in range(size) for r in range(size)]
        for fractions in ([0.7, 0.4, 0.1], [0.7, 0.1, 0.4], [0.4, 0.1, 0.7], [0.1, 0.7, 0.4], [0.1, 0.4, 0.7], [0.4, 0.7, 0.1]):
            rgb = [(f + 1) / (size - 1) for f in fractions]
            want = sum(coefficient * (f + 1) for coefficient, f in zip((1, 2, 3), fractions))
            self.assertAlmostEqual(grade_batch.tetrahedral(size, linear, rgb)[0], want, places=6)

    def test_refusals(self):
        out = self.root / "x.cube"
        skill = make_skill(self.root / "skill", scale(1, 1, 1), scale(1, 1, 1))
        with self.assertRaisesRegex(ValueError, "unknown look"):
            grade_batch.bake_look("nope", skill, out)
        with self.assertRaisesRegex(ValueError, "no LUTs"):
            grade_batch.bake_look("natural", skill, out)
        (skill / "correction_luts" / "golden_warm.cube").unlink()
        with self.assertRaisesRegex(ValueError, "look LUT missing"):
            grade_batch.bake_look("cinematic", skill, out)
        self.assertFalse(out.exists())

    def test_the_command_line(self):
        skill = make_skill(self.root / "skill", scale(0.8, 0.8, 0.8), scale(1, 1, 1))
        out = self.root / "baked.cube"
        with contextlib.redirect_stdout(io.StringIO()) as stdout:
            code = grade_batch.main(["--bake-look", "cinematic", "--color-grade-dir", str(skill), "--out", str(out)])
        self.assertEqual(code, 0)
        self.assertIn('"baked"', stdout.getvalue())
        self.assertEqual(grade_batch.read_cube(out)[0], grade_batch.BAKE_GRID)
        # Without --out it is a usage error; a missing skill is a plain failure.
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            grade_batch.main(["--bake-look", "cinematic"])
        self.assertEqual(raised.exception.code, 2)
        with contextlib.redirect_stderr(io.StringIO()):
            code = grade_batch.main(["--bake-look", "cinematic", "--color-grade-dir", str(self.root / "none"), "--out", str(self.root / "y.cube")])
        self.assertEqual(code, 1)

    def test_a_grade_still_needs_its_input_and_output_dir(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            grade_batch.main(["--output-dir", str(self.root / "o")])
        self.assertEqual(raised.exception.code, 2)


class LookLutTest(unittest.TestCase):
    """--look-lut (LU9): a LUT a note names, applied after the matched correction and the look."""

    def setUp(self):
        self._scratch = tempfile.TemporaryDirectory()
        # resolve(): on macOS the temp folder is behind a symlink, and the wrapper resolves paths.
        self.root = Path(self._scratch.name).resolve()

    def tearDown(self):
        self._scratch.cleanup()

    def cube(self, name: str, size: int = 3, fn=None) -> Path:
        path = self.root / name
        write_cube(path, size, fn or (lambda r, g, b: (r, g, b)))
        return path

    def test_a_complete_3d_cube_passes(self):
        self.assertEqual(grade_batch.validate_cube(self.cube("ok.cube", 5)), 5)

    def test_a_cube_with_the_header_lines_people_ship_passes(self):
        path = self.root / "headers.cube"
        path.write_text(
            '# made by someone\nTITLE "x y"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n'
            "LUT_3D_INPUT_RANGE 0 1\n" + "\n".join("0 0 0" for _ in range(8)) + "\n"
        )
        self.assertEqual(grade_batch.validate_cube(path), 2)

    def test_what_is_not_a_complete_3d_cube_is_refused(self):
        whole = self.cube("whole.cube", 3).read_text().splitlines()
        cases = {
            "short.cube": "\n".join(whole[:-1]) + "\n",
            "long.cube": "\n".join(whole + ["0 0 0"]) + "\n",
            "one_d.cube": "LUT_1D_SIZE 4\n0 0 0\n1 1 1\n0 0 0\n1 1 1\n",
            "no_size.cube": "\n".join(whole[:1] + whole[2:]) + "\n",
            "domain.cube": "\n".join([whole[0], whole[1], "DOMAIN_MAX 2.0 2.0 2.0"] + whole[2:]) + "\n",
            "range.cube": "\n".join([whole[0], whole[1], "LUT_3D_INPUT_RANGE 0 2"] + whole[2:]) + "\n",
            "nan.cube": "\n".join(whole[:-1] + ["nan 0 0"]) + "\n",
            "wide.cube": "\n".join(whole[:-1] + ["0 0 0 0"]) + "\n",
            "huge.cube": "LUT_3D_SIZE 130\n",
        }
        for name, text in cases.items():
            path = self.root / name
            path.write_text(text)
            with self.subTest(name), self.assertRaises(ValueError):
                grade_batch.validate_cube(path)
        with self.assertRaisesRegex(ValueError, "not found"):
            grade_batch.validate_cube(self.root / "missing.cube")
        binary = self.root / "binary.cube"
        binary.write_bytes(b"\xff\xfe\x00\x80 not text")
        with self.assertRaises(ValueError):
            grade_batch.validate_cube(binary)

    def test_the_copy_name_is_safe_and_numbered_from_one(self):
        self.assertEqual(grade_batch.safe_lut_name(Path("Golden Hour Warm.cube")), "Golden_Hour_Warm")
        self.assertEqual(grade_batch.safe_lut_name(Path("a:b'c,é.cube")), "a_b_c")
        self.assertEqual(grade_batch.safe_lut_name(Path("...cube")), "lut")
        self.assertLessEqual(len(grade_batch.safe_lut_name(Path("x" * 200 + ".cube"))), 40)

    def test_the_luts_are_copied_in_order_and_chained_at_full_strength(self):
        first = self.cube("Golden Hour Warm.cube", 3, lambda r, g, b: (r * 0.9, g, b))
        second = self.cube("b.cube", 4, lambda r, g, b: (r, g, b * 0.8))
        out = self.root / "out"
        (out / "luts").mkdir(parents=True)
        chain, records = grade_batch.copy_look_luts([first, second], out)
        self.assertEqual(
            chain,
            ",lut3d=file=luts/lut_1_Golden_Hour_Warm.cube:interp=tetrahedral"
            ",lut3d=file=luts/lut_2_b.cube:interp=tetrahedral",
        )
        # Whole files, byte for byte: no attenuate_cube, so no blend with identity.
        self.assertEqual((out / "luts/lut_1_Golden_Hour_Warm.cube").read_bytes(), first.read_bytes())
        self.assertEqual((out / "luts/lut_2_b.cube").read_bytes(), second.read_bytes())
        self.assertNotIn("Applied correction strength", (out / "luts/lut_1_Golden_Hour_Warm.cube").read_text())
        self.assertEqual([r["sha256"] for r in records], [hashlib.sha256(p.read_bytes()).hexdigest() for p in (first, second)])
        self.assertEqual([r["source"] for r in records], [str(first), str(second)])
        self.assertEqual([r["path"] for r in records], [str(out / "luts/lut_1_Golden_Hour_Warm.cube"), str(out / "luts/lut_2_b.cube")])

    def test_no_luts_add_nothing(self):
        out = self.root / "out"
        (out / "luts").mkdir(parents=True)
        self.assertEqual(grade_batch.copy_look_luts([], out), ("", []))

    def test_the_option_repeats_and_keeps_the_order(self):
        args = grade_batch.parser().parse_args(["--look-lut", "a.cube", "--look-lut", "b.cube"])
        self.assertEqual(args.look_lut, [Path("a.cube"), Path("b.cube")])
        self.assertIsNone(grade_batch.parser().parse_args([]).look_lut)

    def test_the_edl_can_carry_them_and_they_are_read_from_its_folder(self):
        source = self.root / "clip.mp4"
        source.write_bytes(b"x")
        edl = self.root / "edit" / "edl.json"
        edl.parent.mkdir()
        document = {"sources": {"c": str(source)}, "ranges": [{"source": "c", "start": 0, "end": 1}]}
        edl.write_text(json.dumps(dict(document, color_grade={"look_luts": ["luts/a.cube", "/abs/b.cube"]})))
        args = grade_batch.parser().parse_args(["--edl", str(edl)])
        _clips, _edl, settings = grade_batch.load_inputs(args)
        self.assertEqual(settings["look_luts"], [str(edl.parent / "luts/a.cube"), "/abs/b.cube"])
        for bad in ("a.cube", [3], [""], {"a": 1}):
            edl.write_text(json.dumps(dict(document, color_grade={"look_luts": bad})))
            with self.subTest(bad), self.assertRaisesRegex(ValueError, "look_luts"):
                grade_batch.load_inputs(args)

    def test_a_bad_look_lut_stops_the_grade_before_anything_is_made(self):
        source = self.root / "clip.mp4"
        source.write_bytes(b"x")
        edl = self.root / "edl.json"
        edl.write_text(json.dumps({"sources": {"c": str(source)}, "ranges": [{"source": "c", "start": 0, "end": 1}]}))
        helpers = self.root / "vu" / "helpers"
        helpers.mkdir(parents=True)
        (helpers / "grade.py").write_text("")
        (helpers / "render.py").write_text("")
        broken = self.root / "broken.cube"
        broken.write_text("LUT_3D_SIZE 3\n0 0 0\n")
        out = self.root / "out"
        common = ["--edl", str(edl), "--output-dir", str(out), "--video-use-dir", str(self.root / "vu"),
                  "--color-grade-dir", str(self.root / "skill"), "--prepare-only"]
        for lut in (broken, self.root / "missing.cube"):
            with self.subTest(lut.name), contextlib.redirect_stderr(io.StringIO()) as stderr:
                code = grade_batch.main(common + ["--look-lut", str(lut)])
            self.assertEqual(code, 1)
            self.assertIn("look LUT", stderr.getvalue())
            self.assertFalse(out.exists())


class NeedsCameraLutTest(unittest.TestCase):
    """The report says which sources wait for a camera LUT (LU10): log footage with none."""

    def setUp(self):
        self._scratch = tempfile.TemporaryDirectory()
        self.root = Path(self._scratch.name).resolve()

    def tearDown(self):
        self._scratch.cleanup()

    @staticmethod
    def record(source: str, kind: str, camera: str | None = None, key: str = "s000") -> dict:
        return {"id": key, "source": source, "input": f"/footage/{source}.mp4", "footage": {"kind": kind}, "camera_lut": camera}

    def test_log_and_ambiguous_footage_without_a_camera_lut_waits_and_says_which(self):
        records = [
            self.record("a", "log"),
            self.record("b", "display"),
            self.record("c", "ambiguous"),
            self.record("d", "log", camera="/luts/d.cube"),
            self.record("e", "ambiguous", camera="/luts/e.cube"),
        ]
        self.assertEqual(
            grade_batch.needs_camera_lut(records),
            [{"source": "a", "input": "/footage/a.mp4", "kind": "log"}, {"source": "c", "input": "/footage/c.mp4", "kind": "ambiguous"}],
        )

    def test_a_source_used_by_several_ranges_is_listed_once_with_its_surest_verdict(self):
        records = [
            self.record("a", "ambiguous", key="s000"),
            self.record("a", "log", key="s001"),
            self.record("a", "ambiguous", key="s002"),
            self.record("b", "log", key="s003"),
        ]
        self.assertEqual(
            [(item["source"], item["kind"]) for item in grade_batch.needs_camera_lut(records)],
            [("a", "log"), ("b", "log")],
        )

    def blocked_report(self, kind: str, confidence: float = 1.0) -> dict:
        """A whole grade of one clip, with every external tool stood in for, up to the blocked report."""
        clip = self.root / "clip.mp4"
        clip.write_bytes(b"x")
        edl = self.root / "edl.json"
        edl.write_text(json.dumps({"sources": {"cam": str(clip)}, "ranges": [{"source": "cam", "start": 0, "end": 2}]}))
        vu = self.root / "vu" / "helpers"
        vu.mkdir(parents=True)
        (vu / "grade.py").write_text("")
        (vu / "render.py").write_text("")
        out = self.root / "out"
        args = grade_batch.parser().parse_args(
            ["--edl", str(edl), "--output-dir", str(out), "--video-use-dir", str(self.root / "vu"),
             "--color-grade-dir", str(self.root / "skill"), "--ffmpeg", "true", "--ffprobe", "true", "--prepare-only"]
        )
        info = {"color_transfer": "unknown", "has_audio": False, "duration": 10.0}
        with mock.patch.object(grade_batch, "probe", return_value=info), \
                mock.patch.object(grade_batch, "run", return_value=""), \
                mock.patch.object(grade_batch, "detect", return_value={"kind": kind, "confidence": confidence, "evidence": ["test"]}), \
                mock.patch.object(grade_batch, "upstream_available", return_value=(True, [])):
            report = grade_batch.batch(args)
        self.assertEqual(json.loads((out / "report.json").read_text())["needs_camera_lut"], report["needs_camera_lut"])
        return report

    def test_a_log_clip_without_a_camera_lut_blocks_the_grade_and_the_report_says_so(self):
        report = self.blocked_report("log", 1.0)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual([item["source"] for item in report["needs_camera_lut"]], ["cam"])

    def test_a_clip_the_grade_cannot_tell_blocks_too_and_is_listed_as_ambiguous(self):
        # Real log often lands here (a clip encoded with Sony's S-Log3 curve measured "ambiguous" at 1.00:
        # all four log signs). Ambiguous on fewer signs is graded as display (WeakLogTest).
        report = self.blocked_report("ambiguous", 1.0)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual([(item["source"], item["kind"]) for item in report["needs_camera_lut"]], [("cam", "ambiguous")])


# Measured shapes (footage_type.measure) and the verdict the detector gave them, as report.json holds
# them. FPV3 is a calm sky and hill shot of Falcon FPV's "3 Part ref" (FPV3_pic.mp4, 25 fps 1440x1080
# once re-encoded), CVP-438; the S-Log3 ones are a clip encoded with Sony's S-Log3 curve (the LU13
# QA clip) and a real S-Log3 frame (c1640, from color-grade-ai's own test of real footage).
FPV3_SKY = {"kind": "log", "confidence": 0.8, "overridden": False,
            "evidence": ["black point lifted to 0.070 (> 0.06)", "highlights stop at 0.783 (< 0.8)",
                         "low saturation, mean purity 0.264 (< 0.35)", "median sits high in the range at 0.698 (> 0.52), as a log curve places it"],
            "stats": {"black_point": 0.0703, "white_point": 0.7834, "range": 0.7131, "median": 0.5681, "midpoint_position": 0.698, "purity": 0.264}}
# The same clip, a different second (t=3.5 s): three signs again but the median sits low, so the detector
# says "ambiguous" 0.75 instead of "log" 0.8.
FPV3_SKY_AMBIGUOUS = {"kind": "ambiguous", "confidence": 0.75, "overridden": False,
                      "evidence": ["black point lifted to 0.066 (> 0.06)", "highlights stop at 0.792 (< 0.8)",
                                   "low saturation, mean purity 0.266 (< 0.35)"],
                      "stats": {"black_point": 0.0657, "white_point": 0.7921, "range": 0.7264, "median": 0.2742, "midpoint_position": 0.286, "purity": 0.266}}
S_LOG3_CLEAR = {"kind": "log", "confidence": 1.0, "overridden": False, "evidence": ["all four signs and a high median"],
                "stats": {"black_point": 0.1849, "white_point": 0.6241, "range": 0.4392, "median": 0.4641, "midpoint_position": 0.6358, "purity": 0.0592}}
S_LOG3_ENCODED = {"kind": "ambiguous", "confidence": 1.0, "overridden": False, "evidence": ["all four signs, median not high"],
                  "stats": {"black_point": 0.0863, "white_point": 0.5317, "range": 0.4454, "median": 0.2279, "midpoint_position": 0.3179, "purity": 0.2794}}
ORDINARY_DISPLAY = {"kind": "display", "confidence": 0.5, "overridden": False, "evidence": ["two signs"]}


class WeakLogTest(unittest.TestCase):
    """A flat sky measured log or ambiguous on three of four signs must not fail a finished edit (CVP-438, C75)."""

    def test_the_line_is_between_three_signs_and_four(self):
        # footage_type.py scores log as (signs + 1) / 5 and ambiguous as signs / 4: 0.8 or 0.75 on three
        # signs, 1.0 on four.
        self.assertLess(0.8, grade_batch.LOG_BLOCK_MIN_CONFIDENCE)
        self.assertLess(grade_batch.LOG_BLOCK_MIN_CONFIDENCE, 1.0)

    def test_a_log_verdict_on_three_signs_counts_as_display_and_says_why(self):
        settled = grade_batch.settle_weak_log(FPV3_SKY)
        self.assertEqual(settled["kind"], "display")
        self.assertTrue(settled["weak_log"])
        self.assertEqual(settled["measured"], {"kind": "log", "confidence": 0.8})
        self.assertNotIn("confidence", settled)
        self.assertEqual(settled["stats"], FPV3_SKY["stats"])
        self.assertEqual(settled["evidence"][:4], FPV3_SKY["evidence"])
        self.assertIn("weak log", settled["evidence"][4])
        self.assertEqual(FPV3_SKY["kind"], "log", "the detector's own verdict is not edited in place")

    def test_an_ambiguous_verdict_on_three_signs_counts_as_display_and_says_why(self):
        settled = grade_batch.settle_weak_log(FPV3_SKY_AMBIGUOUS)
        self.assertEqual(settled["kind"], "display")
        self.assertTrue(settled["weak_log"])
        self.assertEqual(settled["measured"], {"kind": "ambiguous", "confidence": 0.75})
        self.assertNotIn("confidence", settled)
        self.assertEqual(settled["stats"], FPV3_SKY_AMBIGUOUS["stats"])
        self.assertEqual(settled["evidence"][:3], FPV3_SKY_AMBIGUOUS["evidence"])
        self.assertIn("weak ambiguous", settled["evidence"][3])
        self.assertEqual(FPV3_SKY_AMBIGUOUS["kind"], "ambiguous", "the detector's own verdict is not edited in place")

    def test_a_verdict_on_all_four_signs_stays_as_it_is_and_keeps_blocking(self):
        for verdict in (
            dict(S_LOG3_CLEAR, confidence=1.0),
            dict(S_LOG3_CLEAR, confidence=0.95),
            dict(S_LOG3_CLEAR, confidence=grade_batch.LOG_BLOCK_MIN_CONFIDENCE),
            S_LOG3_ENCODED,  # ambiguous 1.00
            dict(S_LOG3_ENCODED, confidence=grade_batch.LOG_BLOCK_MIN_CONFIDENCE),
        ):
            with self.subTest(kind=verdict["kind"], confidence=verdict["confidence"]):
                self.assertIs(grade_batch.settle_weak_log(verdict), verdict)

    def test_display_and_declared_footage_are_untouched(self):
        for verdict in (
            ORDINARY_DISPLAY,
            # transfer: log in the EDL is a person's word, whatever the confidence field says.
            {"kind": "log", "confidence": 0.5, "overridden": True, "evidence": []},
            {"kind": "log", "evidence": ["detector unavailable"]},
            {"kind": "ambiguous", "evidence": ["detector unavailable"]},
        ):
            with self.subTest(verdict=verdict):
                self.assertIs(grade_batch.settle_weak_log(verdict), verdict)

    @staticmethod
    def record(source: str, verdict: dict, key: str = "s000") -> dict:
        return {"id": key, "source": source, "input": f"/footage/{source}.mp4", "footage": grade_batch.settle_weak_log(verdict), "camera_lut": None}

    def test_a_weak_source_is_not_waiting_for_a_camera_lut_but_is_listed_as_weak_with_what_it_measured(self):
        records = [self.record("sky", FPV3_SKY), self.record("sky", FPV3_SKY, key="s001"), self.record("real", S_LOG3_CLEAR),
                   self.record("dim", FPV3_SKY_AMBIGUOUS), self.record("flat", S_LOG3_ENCODED), self.record("plain", ORDINARY_DISPLAY)]
        self.assertEqual(
            grade_batch.needs_camera_lut(records),
            [{"source": "real", "input": "/footage/real.mp4", "kind": "log"}, {"source": "flat", "input": "/footage/flat.mp4", "kind": "ambiguous"}],
        )
        self.assertEqual(
            grade_batch.weak_log_sources(records),
            [{"source": "sky", "input": "/footage/sky.mp4", "kind": "log", "confidence": 0.8},
             {"source": "dim", "input": "/footage/dim.mp4", "kind": "ambiguous", "confidence": 0.75}],
        )

    def grade(self, verdict: dict) -> dict:
        """A whole grade of one clip with every external tool stood in for, as far as the report."""
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name).resolve()
        clip = root / "clip.mp4"
        clip.write_bytes(b"x")
        edl = root / "edl.json"
        edl.write_text(json.dumps({"sources": {"cam": str(clip)}, "ranges": [{"source": "cam", "start": 0, "end": 2}]}))
        vu = root / "vu" / "helpers"
        vu.mkdir(parents=True)
        (vu / "grade.py").write_text("")
        (vu / "render.py").write_text("")
        out = root / "out"
        args = grade_batch.parser().parse_args(
            ["--edl", str(edl), "--output-dir", str(out), "--video-use-dir", str(root / "vu"),
             "--color-grade-dir", str(root / "skill"), "--ffmpeg", "true", "--ffprobe", "true", "--prepare-only"]
        )
        info = {"color_transfer": "bt709", "pix_fmt": "yuv420p", "has_audio": False, "duration": 10.0}

        def fake_run(command, cwd, env, log):
            if str(command[-1]).endswith(".mkv"):  # the lossless trim the grade step then deletes
                Path(command[-1]).write_bytes(b"x")
            return ""

        def fake_fit(tool, inputs, output, upstream, root, env, log):
            write_cube(output, 2, lambda r, g, b: (r, g, b))

        with mock.patch.object(grade_batch, "probe", return_value=info), \
                mock.patch.object(grade_batch, "run", side_effect=fake_run), \
                mock.patch.object(grade_batch, "fit", side_effect=fake_fit), \
                mock.patch.object(grade_batch, "detect", return_value=verdict), \
                mock.patch.object(grade_batch, "upstream_available", return_value=(True, [])):
            report = grade_batch.batch(args)
        self.assertEqual(json.loads((out / "report.json").read_text())["weak_log"], report["weak_log"])
        return report

    def test_a_flat_sky_measured_log_on_three_signs_gets_its_grade(self):
        report = self.grade(FPV3_SKY)
        self.assertEqual(report["status"], "prepared")
        self.assertEqual(report["needs_camera_lut"], [])
        self.assertEqual([(item["source"], item["kind"]) for item in report["weak_log"]], [("cam", "log")])
        self.assertEqual(report["clips"][0]["status"], "ready")
        self.assertEqual(report["clips"][0]["footage"]["kind"], "display")

    def test_a_flat_sky_measured_ambiguous_on_three_signs_gets_its_grade(self):
        report = self.grade(FPV3_SKY_AMBIGUOUS)
        self.assertEqual(report["status"], "prepared")
        self.assertEqual(report["needs_camera_lut"], [])
        self.assertEqual([(item["source"], item["kind"], item["confidence"]) for item in report["weak_log"]], [("cam", "ambiguous", 0.75)])
        self.assertEqual(report["clips"][0]["status"], "ready")
        self.assertEqual(report["clips"][0]["footage"]["kind"], "display")
        self.assertEqual(report["clips"][0]["footage"]["measured"], {"kind": "ambiguous", "confidence": 0.75})

    def test_real_log_on_all_four_signs_still_blocks_the_grade(self):
        report = self.grade(S_LOG3_CLEAR)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual([(item["source"], item["kind"]) for item in report["needs_camera_lut"]], [("cam", "log")])
        self.assertEqual(report["weak_log"], [])

    def test_a_clip_the_grade_cannot_tell_on_all_four_signs_still_blocks_as_ambiguous(self):
        report = self.grade(S_LOG3_ENCODED)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual([(item["source"], item["kind"]) for item in report["needs_camera_lut"]], [("cam", "ambiguous")])
        self.assertEqual(report["weak_log"], [])

    def test_ordinary_display_footage_is_graded_as_before(self):
        report = self.grade(ORDINARY_DISPLAY)
        self.assertEqual(report["status"], "prepared")
        self.assertEqual(report["weak_log"], [])


if __name__ == "__main__":
    unittest.main()
