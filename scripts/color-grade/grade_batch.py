#!/usr/bin/env python3
"""Fit per-shot LUTs, apply through video-use grade.py --filter, render an EDL.

Normalization uses lossless FFV1/PCM temporary trims. The following grade.py
and render.py passes both encode H.264; this deliberate extra encode keeps the
upstream helpers unmodified. No grade is applied twice. All outputs, including
upstream fitting caches, live beneath a new --output-dir.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass

HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}
# Keep byte-for-byte aligned with video-use/helpers/render.py TONEMAP_CHAIN.
TONEMAP_CHAIN = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)
# Creative looks: (color-grade-ai correction LUT, blend with identity), applied in order.
LOOKS = {
    "natural": [],
    "cinematic": [("film_contrast_80", 0.8), ("golden_warm", 0.4)],
}
SDR_TAGS = "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709"


@dataclass
class Clip:
    id: str
    path: Path
    transfer: str = "auto"
    camera_lut: Path | None = None


def resolve(value: str, base: Path) -> Path:
    path = Path(value).expanduser()
    return (path if path.is_absolute() else base / path).resolve()


def interval(start, end) -> tuple[float, float]:
    start, end = float(start), float(end)
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
        raise ValueError(f"invalid range {start!r}–{end!r}")
    return start, end


def load_inputs(args) -> tuple[list[Clip], dict, dict]:
    """Return unique sources, EDL, grading settings. Paths are input-relative."""
    if args.edl or args.manifest:
        source = (args.edl or args.manifest).expanduser().resolve()
        document = json.loads(source.read_text())
        base = source.parent
    else:
        document, base = {}, Path.cwd()
    if args.edl:
        edl = copy.deepcopy(document)
        settings = edl.get("color_grade", {})
        sources = edl.get("sources", {})
        ranges = edl.get("ranges", [])
        ids = list(dict.fromkeys(r["source"] for r in ranges))
        entries = [dict(settings.get("sources", {}).get(key, {}), id=key, path=sources[key]) for key in ids]
        # Existing output-timeline captions and overlays keep their original base.
        for overlay in edl.get("overlays", []):
            overlay["file"] = str(resolve(overlay["file"], base))
        if edl.get("subtitles"):
            edl["subtitles"] = str(resolve(edl["subtitles"], base))
    else:
        settings = document
        entries = document.get("clips", []) if args.manifest else [
            {"id": f"clip_{i:03d}", "path": str(path)} for i, path in enumerate(args.clips)
        ]
        edl = {"version": 1, "sources": {}, "ranges": [], "overlays": []}
        for entry in entries:
            ranges = entry.get("ranges", [[entry.get("start", 0), entry.get("end")]])
            for bounds in ranges:
                start, end = (bounds["start"], bounds["end"]) if isinstance(bounds, dict) else bounds
                edl["ranges"].append({"source": entry["id"], "start": start, "end": end})
    clips = []
    seen = set()
    for entry in entries:
        key = entry["id"]
        if not isinstance(key, str) or not key or key in seen:
            raise ValueError(f"source IDs must be unique nonempty strings: {key!r}")
        seen.add(key)
        transfer = entry.get("transfer", "auto")
        if transfer not in {"auto", "log", "display"}:
            raise ValueError(f"{key}: transfer must be auto, log or display")
        path = resolve(entry["path"], base)
        camera = resolve(entry["camera_lut"], base) if entry.get("camera_lut") else None
        for required in (path, camera):
            if required is not None and not required.is_file():
                raise ValueError(f"file not found: {required}")
        clips.append(Clip(key, path, transfer, camera))
    if not clips or not edl["ranges"]:
        raise ValueError("at least one clip and kept range is required")
    if settings.get("fallback_lut"):
        settings = dict(settings, fallback_lut=str(resolve(settings["fallback_lut"], base)))
    if settings.get("look_luts") is not None:
        listed = settings["look_luts"]
        if not isinstance(listed, list) or not all(isinstance(item, str) and item for item in listed):
            raise ValueError("color_grade.look_luts must be a list of .cube file paths")
        settings = dict(settings, look_luts=[str(resolve(item, base)) for item in listed])
    return clips, edl, settings


def normalization(transfer: str, camera_filter: str = "", max_width: int | None = None) -> str:
    if transfer in HDR_TRANSFERS and camera_filter:
        raise ValueError("camera log conversion cannot be combined with HLG/PQ normalization")
    parts = [TONEMAP_CHAIN] if transfer in HDR_TRANSFERS else []
    if camera_filter:
        parts.append(camera_filter)
    if max_width:
        parts.append(f"scale=w='min({max_width},iw)':h=-2")
    return ",".join(parts) or "null"


def lut_filter(relative_path: str) -> str:
    # Copied LUT paths are generated by us, relative to cwd, never user strings.
    if not all(c.isascii() and (c.isalnum() or c in "_-/.") for c in relative_path):
        raise ValueError("unsafe generated LUT path")
    return f"lut3d=file={relative_path}:interp=tetrahedral"


def select_reference(records: list[dict], requested: str | None) -> dict | None:
    eligible = [r for r in records if r["status"] == "ready"]
    if requested:
        matches = [r for r in records if r["source"] == requested]
        if not matches:
            raise ValueError(f"reference source not found: {requested}")
        if matches[0]["status"] != "ready":
            raise ValueError(f"reference {requested} has no confirmed Rec.709 normalization")
        return matches[0]
    return eligible[0] if eligible else None


def choose_correction(record: dict, anchor: dict, mode: str, available: bool) -> tuple[str | None, str]:
    """Selection is explicit; runtime failures never silently change this choice."""
    if record["status"] != "ready":
        return None, "blocked_transfer"
    if mode == "shared" and record.get("fallback"):
        return "fallback", "explicit_shared_lut"
    if not available:
        return ("fallback", "prebaked_fallback") if record.get("fallback") else (None, "dependency_unavailable")
    if record is anchor:
        return "auto", "reference_auto"
    if mode == "shared":
        return "reference", "shared_reference_lut"
    return ("auto", "independent_auto") if mode == "auto" else ("match", "matched_to_corrected_reference")



def attenuate_cube(path: Path, strength: float) -> None:
    """Blend a correction with identity; never attenuate a camera conversion."""
    if not 0 <= strength <= 1:
        raise ValueError("strength must be between 0 and 1")
    lines = path.read_text().splitlines()
    size = None
    values = []
    headers = []
    for line in lines:
        parts = line.split()
        if not parts or line.lstrip().startswith("#"):
            headers.append(line)
        elif parts[0] == "LUT_3D_SIZE":
            size = int(parts[1])
            headers.append(line)
        elif parts[0] in {"TITLE", "DOMAIN_MIN", "DOMAIN_MAX"}:
            if parts[0].startswith("DOMAIN_") and list(map(float, parts[1:])) != ([0.0] * 3 if parts[0] == "DOMAIN_MIN" else [1.0] * 3):
                raise ValueError("correction LUT domain must be 0..1")
            headers.append(line)
        else:
            if len(parts) != 3:
                raise ValueError(f"invalid correction LUT row: {line}")
            row = list(map(float, parts))
            if not all(math.isfinite(value) for value in row):
                raise ValueError("nonfinite LUT value")
            values.append(row)
    if size is None or not 2 <= size <= 129 or len(values) != size ** 3:
        raise ValueError("correction must be a complete 3D .cube LUT")
    output = headers + [f"# Applied correction strength: {strength}"]
    for i, row in enumerate(values):
        identity = [i % size / (size - 1), (i // size) % size / (size - 1), i // (size * size) / (size - 1)]
        output.append(" ".join(f"{base + (value - base) * strength:.8f}" for value, base in zip(row, identity)))
    path.write_text("\n".join(output) + "\n")


def validate_cube(path: Path) -> int:
    """Check a LUT a person supplied (--look-lut) is a complete 3D .cube; answer its grid size.

    The same rules attenuate_cube applies to a correction: 3D only, a 0..1 domain, N^3 rows of three
    finite numbers. Nothing is changed or written.
    """
    if not path.is_file():
        raise ValueError(f"look LUT not found: {path}")
    size = None
    rows = 0
    try:
        text = path.read_text()
    except UnicodeDecodeError as error:
        raise ValueError(f"look LUT is not a text .cube file: {path}") from error
    for line in text.splitlines():
        parts = line.split()
        if not parts or line.lstrip().startswith("#") or parts[0] == "TITLE":
            continue
        if parts[0] == "LUT_3D_SIZE":
            size = int(parts[1])
        elif parts[0] == "LUT_1D_SIZE":
            raise ValueError(f"look LUT is a 1D LUT, not a 3D .cube: {path}")
        elif parts[0] in {"DOMAIN_MIN", "DOMAIN_MAX", "LUT_3D_INPUT_RANGE"}:
            if parts[0] == "LUT_3D_INPUT_RANGE":
                expected = [0.0, 1.0]
            else:
                expected = [1.0] * 3 if parts[0] == "DOMAIN_MAX" else [0.0] * 3
            if list(map(float, parts[1:])) != expected:
                raise ValueError(f"look LUT domain must be 0..1: {path}")
        else:
            row = list(map(float, parts))
            if len(row) != 3 or not all(math.isfinite(value) for value in row):
                raise ValueError(f"invalid look LUT row in {path}: {line}")
            rows += 1
    if size is None or not 2 <= size <= 129 or rows != size ** 3:
        raise ValueError(f"look LUT must be a complete 3D .cube LUT: {path}")
    return size


def safe_lut_name(path: Path) -> str:
    """A file name part made of letters, digits, _ and - only (lut_filter allows no other)."""
    name = "".join(c if c.isascii() and (c.isalnum() or c in "_-") else "_" for c in path.stem)
    return name.strip("_")[:40] or "lut"


def copy_look_luts(sources: list[Path], root: Path) -> tuple[str, list[dict]]:
    """Copy each --look-lut into root/luts/lut_N_<name>.cube (N from 1, in the order given).

    Returns the ffmpeg filter that applies them in that order, each at full strength (no blend with
    identity), and the records for report.json.
    """
    chain = ""
    records = []
    for index, source in enumerate(sources, start=1):
        target = root / f"luts/lut_{index}_{safe_lut_name(source)}.cube"
        shutil.copyfile(source, target)
        chain += "," + lut_filter(str(target.relative_to(root)))
        records.append({"source": str(source), "path": str(target),
                        "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    return chain, records


# Grid of a baked look. The engine's LUTs page knows this size without baking
# (apps/server/src/luts/lut-builtin.ts, BAKED_LOOK_SIZE); a test there keeps the two equal.
BAKE_GRID = 33


def read_cube(path: Path) -> tuple[int, list[list[float]]]:
    """Read a complete 3D .cube: its grid size and its rows (red varies fastest)."""
    size = None
    rows: list[list[float]] = []
    for line in path.read_text().splitlines():
        parts = line.split()
        if not parts or line.lstrip().startswith("#") or parts[0] in {"TITLE", "DOMAIN_MIN", "DOMAIN_MAX"}:
            continue
        if parts[0] == "LUT_3D_SIZE":
            size = int(parts[1])
        else:
            rows.append(list(map(float, parts)))
    if size is None or not 2 <= size <= 129 or len(rows) != size ** 3:
        raise ValueError(f"not a complete 3D .cube LUT: {path}")
    return size, rows


def _sub(a: list[float], b: list[float]) -> list[float]:
    return [x - y for x, y in zip(a, b)]


def tetrahedral(size: int, rows: list[list[float]], rgb: list[float]) -> list[float]:
    """Look a colour up in a cube the way ffmpeg's lut3d interp=tetrahedral does."""
    pos = [min(max(value, 0.0), 1.0) * (size - 1) for value in rgb]
    base = [min(int(math.floor(value)), size - 2) for value in pos]
    dr, dg, db = (value - low for value, low in zip(pos, base))

    def at(r: int, g: int, b: int) -> list[float]:
        return rows[base[0] + r + (base[1] + g) * size + (base[2] + b) * size * size]

    c000, c111 = at(0, 0, 0), at(1, 1, 1)
    if dr > dg:
        if dg > db:
            c1, c2, c3 = _sub(at(1, 0, 0), c000), _sub(at(1, 1, 0), at(1, 0, 0)), _sub(c111, at(1, 1, 0))
        elif dr > db:
            c1, c2, c3 = _sub(at(1, 0, 0), c000), _sub(c111, at(1, 0, 1)), _sub(at(1, 0, 1), at(1, 0, 0))
        else:
            c1, c2, c3 = _sub(at(1, 0, 1), at(0, 0, 1)), _sub(c111, at(1, 0, 1)), _sub(at(0, 0, 1), c000)
    else:
        if dr > db:
            c1, c2, c3 = _sub(at(1, 1, 0), at(0, 1, 0)), _sub(at(0, 1, 0), c000), _sub(c111, at(1, 1, 0))
        elif dg > db:
            c1, c2, c3 = _sub(c111, at(0, 1, 1)), _sub(at(0, 1, 0), c000), _sub(at(0, 1, 1), at(0, 1, 0))
        else:
            c1, c2, c3 = _sub(c111, at(0, 1, 1)), _sub(at(0, 1, 1), at(0, 0, 1)), _sub(at(0, 0, 1), c000)
    return [c000[i] + c1[i] * dr + c2[i] * dg + c3[i] * db for i in range(3)]


def bake_look(name: str, upstream: Path, out: Path) -> None:
    """Write a creative look's whole chain (blends included) as one .cube.

    Each LUT of LOOKS[name] is copied and blended with identity by attenuate_cube, exactly as a
    render does, then the chain is sampled on a BAKE_GRID grid, each colour going through every LUT
    in order (tetrahedral, as ffmpeg's lut3d). The result is what the render applies, to within the
    grid's interpolation, so previews need no second copy of the blend numbers.
    """
    chain = LOOKS.get(name)
    if chain is None:
        raise ValueError(f"unknown look {name!r}; choose from {', '.join(LOOKS)}")
    if not chain:
        raise ValueError(f"look {name!r} has no LUTs to bake")
    cubes = []
    with tempfile.TemporaryDirectory() as scratch:
        for index, (lut, blend) in enumerate(chain):
            source = upstream / "correction_luts" / f"{lut}.cube"
            if not source.is_file():
                raise ValueError(f"look LUT missing: {source}")
            target = Path(scratch) / f"look_{index}.cube"
            shutil.copyfile(source, target)
            attenuate_cube(target, blend)
            cubes.append(read_cube(target))
    lines = ["# Baked from the " + name + " look: " + ", ".join(f"{lut} x {blend}" for lut, blend in chain),
             f'TITLE "{name} look"', f"LUT_3D_SIZE {BAKE_GRID}"]
    last = BAKE_GRID - 1
    for b in range(BAKE_GRID):
        for g in range(BAKE_GRID):
            for r in range(BAKE_GRID):
                color = [r / last, g / last, b / last]
                for size, rows in cubes:
                    color = tetrahedral(size, rows, color)
                lines.append(" ".join(f"{min(max(value, 0.0), 1.0):.6f}" for value in color))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n")


def image_stats(path: Path) -> dict:
    import numpy as np
    from PIL import Image
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=float) / 255
    luma = rgb @ np.array([0.2126, 0.7152, 0.0722])
    return {"median": float(np.median(luma)), "shadow": float(np.percentile(luma, 5)),
            "saturation": float(np.mean(np.max(rgb, axis=-1) - np.min(rgb, axis=-1))),
            "clipped": float(np.mean(np.max(rgb, axis=-1) >= 0.99))}


def match_excursions(before: dict, after: dict) -> list[str]:
    """Bound visible side effects separately from upstream's optimization score."""
    reasons = []
    if abs(after["median"] - before["median"]) > 0.12:
        reasons.append("median luminance changes by more than 0.12")
    if after["shadow"] - before["shadow"] > 0.05:
        reasons.append("shadow floor rises by more than 0.05")
    if before["saturation"] > 0.02 and not 0.65 <= after["saturation"] / before["saturation"] <= 1.5:
        reasons.append("saturation changes beyond 0.65–1.5x")
    if after["clipped"] - before["clipped"] > 0.02:
        reasons.append("clipped pixels increase by more than 2 percentage points")
    return reasons


def run(command: list[str], cwd: Path, env: dict, log: Path) -> str:
    completed = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
    with log.open("a") as stream:
        stream.write("\n" + " ".join(command[:2]) + "\n" + completed.stdout + completed.stderr)
    if completed.returncode:
        raise RuntimeError(f"{Path(command[0]).name} failed ({completed.returncode}); see {log}")
    return completed.stdout


def probe(path: Path, binary: str, cwd: Path, env: dict, log: Path) -> dict:
    result = json.loads(run([binary, "-v", "error", "-show_entries",
                             "stream=codec_type,color_transfer,avg_frame_rate,width,height,pix_fmt:format=duration", "-of", "json", str(path)], cwd, env, log))
    videos = [stream for stream in result.get("streams", []) if stream.get("codec_type") == "video"]
    if not videos:
        raise ValueError(f"no video stream: {path}")
    return dict(videos[0], duration=float(result["format"]["duration"]),
                has_audio=any(stream.get("codec_type") == "audio" for stream in result["streams"]))


def upstream_available(directory: Path) -> tuple[bool, list[str]]:
    missing = [name for name in ("auto_grade.py", "match_grade.py", "footage_type.py", "solve_grade.py", "bake_lut.rb") if not (directory / name).is_file()]
    for name in ("PIL", "numpy", "yaml"):
        if importlib.util.find_spec(name) is None:
            missing.append(name)
    if not shutil.which("ruby"):
        missing.append("ruby")
    return not missing, missing


def fit(tool: str, inputs: list[Path], output: Path, upstream: Path, root: Path, env: dict, log: Path) -> None:
    # Configure the upstream dependency cache without editing its installation.
    bootstrap = (
        "import runpy,sys;sys.path.insert(0,sys.argv[1]);import solve_grade;"
        "solve_grade.CACHE_DIR=sys.argv[2];sys.argv=sys.argv[3:];runpy.run_path(sys.argv[0],run_name='__main__')"
    )
    command = [sys.executable, "-c", bootstrap, str(upstream), str(root / "cache"), str(upstream / tool),
               *map(str, inputs), "--transfer", "display", "--emit", str(output)]
    run(command, root, env, log)
    if not output.is_file() or "LUT_3D_SIZE" not in output.read_text():
        raise RuntimeError(f"fitter did not emit a valid .cube: {output}")


def detect(frame: Path, assumption: str, upstream: Path, root: Path, env: dict, log: Path) -> dict:
    command = [sys.executable, "-c", "import sys,json;sys.path.insert(0,sys.argv[1]);import numpy as np;from PIL import Image;import footage_type;print(json.dumps(footage_type.detect(np.array(Image.open(sys.argv[2]).convert('RGB')),assume=sys.argv[3]).as_dict()))", str(upstream), str(frame), assumption]
    return json.loads(run(command, root, env, log))


# A frame blocks the grade as log, or as a clip the grade cannot tell from log, only when it shows
# all four log signs of footage_type.py (lifted black, rolled highlights, a narrow range, washed
# colour). The detector scores "log" as (signs + 1) / 5 and "ambiguous" as signs / 4, so each is only
# ever the three-sign value (0.8, 0.75) or the four-sign one (1.0): 0.9 is the line for both. Every
# real log frame measured so far shows all four (S-Log3: range 0.44 to 0.46; log 1.0 or ambiguous
# 1.0); the frames this lets through were not log (a calm sky in a re-encoded FPV clip, range 0.67 to
# 0.73, measured log 0.8 and ambiguous 0.75, and a generated clip, range 0.50 to 0.63). Footage
# measured that weakly is graded as display, so the report says so (weak_log) and the editor's camera
# lines can still catch a file that names its curve. A clip the EDL declares (transfer log or display)
# is never second-guessed.
LOG_BLOCK_MIN_CONFIDENCE = 0.9
WEAK_KINDS = ("log", "ambiguous")


def settle_weak_log(verdict: dict) -> dict:
    """A measured "log" or "ambiguous" on fewer than all four signs is not trusted: it counts as display.

    Only an automatic verdict of kind "log" or "ambiguous" below LOG_BLOCK_MIN_CONFIDENCE changes. It
    becomes "display" with weak_log set, the measured verdict (kind and confidence) kept under
    "measured" and one more line of evidence; its confidence is dropped (it described the old kind).
    Everything else (display, a declared transfer, a verdict on all four signs) is returned as it came.
    """
    kind = verdict.get("kind")
    confidence = verdict.get("confidence")
    if (kind not in WEAK_KINDS or verdict.get("overridden") or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float)) or confidence >= LOG_BLOCK_MIN_CONFIDENCE):
        return verdict
    note = (f"weak {kind}: measured {kind} at confidence {confidence:.2f}, but real log shows all four signs "
            f"(needs {LOG_BLOCK_MIN_CONFIDENCE:.2f}); graded as display, not blocked")
    settled = {key: value for key, value in verdict.items() if key != "confidence"}
    return dict(settled, kind="display", weak_log=True, measured={"kind": kind, "confidence": confidence},
                evidence=[*verdict.get("evidence", []), note])


def weak_log_sources(records: list[dict]) -> list[dict]:
    """The sources a weak "log" or "ambiguous" measurement was not trusted for (settle_weak_log), once
    each, so a person or the editor can look at them: the source, its input, what it measured as
    (kind) and at what confidence."""
    weak: dict[str, dict] = {}
    for record in records:
        footage = record["footage"]
        if footage.get("weak_log") and record["source"] not in weak:
            measured = footage["measured"]
            weak[record["source"]] = {"source": record["source"], "input": record["input"],
                                      "kind": measured["kind"], "confidence": measured["confidence"]}
    return list(weak.values())


def needs_camera_lut(records: list[dict]) -> list[dict]:
    """The sources that look like log and have no camera LUT: the grade is blocked on them.

    One entry per source ID (a source used by several kept ranges is listed once), with the verdict
    that put it here: "log" (the frames measure as log) or "ambiguous" (log or a very flat display
    grade: the measurement cannot tell, and real log often lands here). Studio Engine's prompt tells
    the editor what to do with each: a source whose files name a log curve is log, any other
    "ambiguous" one is for a person to say (it is not necessarily a missing camera LUT).
    """
    waiting: dict[str, dict] = {}
    for record in records:
        kind = record["footage"].get("kind")
        if kind not in ("log", "ambiguous") or record.get("camera_lut"):
            continue
        known = waiting.get(record["source"])
        if known is None or (known["kind"] == "ambiguous" and kind == "log"):
            waiting[record["source"]] = {"source": record["source"], "input": record["input"], "kind": kind}
    return list(waiting.values())


def batch(args) -> dict:
    clips, edl, settings = load_inputs(args)
    if not math.isfinite(args.strength) or not 0 <= args.strength <= 1:
        raise ValueError("strength must be between 0 and 1")
    if args.max_width is not None and args.max_width < 2:
        raise ValueError("max-width must be at least 2")
    root = args.output_dir.expanduser().resolve()
    if root.exists():
        raise ValueError(f"output directory already exists; choose a fresh edit subdirectory: {root}")
    upstream = args.color_grade_dir.expanduser().resolve()
    video_use = args.video_use_dir.expanduser().resolve()
    if not (video_use / "helpers/grade.py").is_file() or not (video_use / "helpers/render.py").is_file():
        raise ValueError(f"video-use helpers missing: {video_use}")
    available, missing = upstream_available(upstream)
    fallback = args.fallback_lut or settings.get("fallback_lut")
    fallback = Path(fallback).expanduser().resolve() if fallback else None
    if fallback and not fallback.is_file():
        raise ValueError(f"fallback LUT not found: {fallback}")
    look = args.look or settings.get("look") or "natural"
    if look not in LOOKS:
        raise ValueError(f"unknown look {look!r}; choose from {', '.join(LOOKS)}")
    # LUTs a person named (--look-lut, else color_grade.look_luts), checked before anything is made.
    look_luts = [Path(item).expanduser().resolve() for item in (args.look_lut or settings.get("look_luts") or [])]
    for look_lut in look_luts:
        validate_cube(look_lut)
    ffmpeg, ffprobe = shutil.which(args.ffmpeg), shutil.which(args.ffprobe)
    if not ffmpeg or not ffprobe:
        raise ValueError("ffmpeg and ffprobe must be available")
    root.mkdir(parents=True, exist_ok=False)
    for directory in ("frames", "luts", "graded", "tmp", "bin"):
        (root / directory).mkdir()
    # grade.py/render.py invoke bare ffmpeg/ffprobe; isolate their executable choice.
    (root / "bin/ffmpeg").symlink_to(ffmpeg)
    (root / "bin/ffprobe").symlink_to(ffprobe)
    env = dict(os.environ, PATH=str(root / "bin") + os.pathsep + os.environ.get("PATH", ""))
    log = root / "commands.log"
    # A creative look is the same for every clip and goes after the matching correction.
    look_filter = ""
    for index, (name, blend) in enumerate(LOOKS[look]):
        source = upstream / "correction_luts" / f"{name}.cube"
        if not source.is_file():
            raise ValueError(f"look LUT missing: {source}")
        target = root / f"luts/look_{index}_{name}.cube"
        shutil.copyfile(source, target)
        attenuate_cube(target, blend)
        look_filter += "," + lut_filter(str(target.relative_to(root)))
    # ... and so do the LUTs a person named: after the look's chain, in the order given, at full strength.
    named_filter, look_lut_records = copy_look_luts(look_luts, root)
    look_filter += named_filter
    report = {"look": look, "look_luts": look_lut_records, "needs_camera_lut": [], "weak_log": [], "version": 1, "status": "running", "mode": args.mode, "strength": args.strength, "dependency_missing": missing,
              "provenance": {"color_grade": str(upstream), "video_use": str(video_use), "python": sys.executable,
                             "ffmpeg": ffmpeg, "ffprobe": ffprobe,
                             "upstream_sha256": {name: hashlib.sha256((upstream / name).read_bytes()).hexdigest()
                                                 for name in ("auto_grade.py", "match_grade.py", "generate_lut.rb")
                                                 if (upstream / name).is_file()}},
              "limitations": ["Normalized trims are lossless FFV1/PCM; grade.py and render.py each encode H.264.",
                              "One representative frame is fitted per kept range; verify skin and lighting across the whole range."],
              "clips": [], "final": None}
    try:
        source_map = {clip.id: clip for clip in clips}
        for i, original in enumerate(edl["ranges"]):
            clip = source_map[original["source"]]
            info = probe(clip.path, ffprobe, root, env, log)
            start, end = interval(original["start"], original.get("end") if original.get("end") is not None else info["duration"])
            if end > info["duration"] + 0.05:
                raise ValueError(f"{clip.id}: range ends after source duration")
            key = f"s{i:03d}"
            camera_relative = ""
            if clip.camera_lut:
                camera_relative = f"luts/{key}_camera.cube"
                shutil.copyfile(clip.camera_lut, root / camera_relative)
            normalize = normalization(info.get("color_transfer", ""), lut_filter(camera_relative) if camera_relative else "", args.max_width)
            frame = root / f"frames/{key}_normalized.png"
            run([ffmpeg, "-v", "error", "-ss", str((start + end) / 2), "-i", str(clip.path), "-frames:v", "1", "-vf", normalize + ",scale=w='min(640,iw)':h=-2", str(frame)], root, env, log)
            # A camera conversion or explicit display declaration is authoritative.
            # If detection dependencies are absent, only such known conversions can
            # safely use a supplied fallback. Metadata alone cannot identify log.
            assumption = "display" if clip.camera_lut else clip.transfer
            if available:
                verdict = settle_weak_log(detect(frame, assumption, upstream, root, env, log))
            else:
                verdict = {"kind": assumption if assumption != "auto" else "ambiguous", "evidence": ["detector unavailable"]}
            status = "ready" if verdict["kind"] == "display" else "blocked"
            record = {"id": key, "source": clip.id, "input": str(clip.path), "start": start, "end": end,
                      "source_transfer": info.get("color_transfer"), "has_audio": info["has_audio"], "footage": verdict, "status": status,
                      "normalization_filter": normalize, "camera_lut": str(clip.camera_lut) if clip.camera_lut else None,
                      "analysis_downscale": "scale=w='min(640,iw)':h=-2", "normalized_frame": str(frame), "fallback": str(fallback) if fallback else None}
            report["clips"].append(record)
        anchor = select_reference(report["clips"], args.reference or settings.get("reference"))
        report["reference"] = anchor["id"] if anchor else None
        if anchor:
            # Prepare anchor first even if user chose a later range.
            ordered = [anchor] + [r for r in report["clips"] if r is not anchor]
            for record in ordered:
                choice, reason = choose_correction(record, anchor, args.mode, available)
                record["selection"] = reason
                if choice is None:
                    record["status"] = "blocked"
                    continue
                output_lut = root / f"luts/{record['id']}_correction.cube"
                if choice == "fallback":
                    shutil.copyfile(fallback, output_lut)
                elif choice == "reference":
                    shutil.copyfile(anchor["correction_lut"], output_lut)
                elif choice == "auto":
                    fit("auto_grade.py", [Path(record["normalized_frame"])], output_lut, upstream, root, env, log)
                else:
                    fit("match_grade.py", [Path(anchor["corrected_frame"]), Path(record["normalized_frame"])], output_lut, upstream, root, env, log)
                if choice == "match":
                    proposed = root / f"frames/{record['id']}_proposed_match.png"
                    run([ffmpeg, "-v", "error", "-i", record["normalized_frame"], "-vf", lut_filter(str(output_lut.relative_to(root))), "-frames:v", "1", str(proposed)], root, env, log)
                    before, after = image_stats(Path(record["normalized_frame"])), image_stats(proposed)
                    reasons = match_excursions(before, after)
                    record["match_quality"] = {"before": before, "proposed": after, "rejected_reasons": reasons}
                    if reasons:
                        shutil.copyfile(anchor["correction_lut"], output_lut)
                        record["selection"] = "shared_reference_after_match_rejection"
                        choice = "reference"
                # Shared copies are already attenuated; avoid applying strength twice.
                if choice != "reference":
                    attenuate_cube(output_lut, args.strength)
                record["correction_lut"] = str(output_lut)
                record["lut_sha256"] = hashlib.sha256(output_lut.read_bytes()).hexdigest()
                corrected = root / f"frames/{record['id']}_corrected.png"
                correction = lut_filter(str(output_lut.relative_to(root)))
                run([ffmpeg, "-v", "error", "-i", record["normalized_frame"], "-vf", correction, "-frames:v", "1", str(corrected)], root, env, log)
                record["corrected_frame"] = str(corrected)
                record["correction_filter"] = correction
        report["needs_camera_lut"] = needs_camera_lut(report["clips"])
        report["weak_log"] = weak_log_sources(report["clips"])
        if any(r["status"] == "blocked" for r in report["clips"]):
            report["status"] = "blocked"
            report["reason"] = "Correction requires confirmed display-referred Rec.709 and a usable fitter or supplied fallback LUT."
            return report
        output_edl = copy.deepcopy(edl)
        output_edl.update(sources={}, ranges=[], grade="none")
        output_edl.pop("color_grade", None)
        for original, record in zip(edl["ranges"], report["clips"]):
            duration = record["end"] - record["start"]
            normalized = root / f"tmp/{record['id']}.mkv"
            # The same normalization precedes fitting and rendering. Audio is PCM
            # here, so trims remain accurate; render.py adds its boundary fades.
            normalize = record["normalization_filter"] + "," + SDR_TAGS
            trim_command = [ffmpeg, "-v", "error", "-ss", str(record["start"]), "-i", record["input"]]
            if not record["has_audio"]:
                trim_command += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
            trim_command += ["-t", str(duration), "-map", "0:v:0", "-map", "0:a:0" if record["has_audio"] else "1:a:0",
                             "-vf", normalize, "-c:v", "ffv1", "-level", "3", "-c:a", "pcm_s16le", "-ar", "48000", str(normalized)]
            run(trim_command, root, env, log)
            # MOV supports grade.py's copied PCM audio; MP4 cannot reliably do so.
            graded = root / f"graded/{record['id']}.mov"
            grade_filter = record["correction_filter"] + look_filter + ",format=yuv420p," + SDR_TAGS
            run([sys.executable, str(video_use / "helpers/grade.py"), str(normalized), "-o", str(graded), "--filter", grade_filter], root, env, log)
            normalized.unlink()
            record["grade_filter"] = grade_filter
            record["graded_clip"] = str(graded)
            output_info = probe(graded, ffprobe, root, env, log)
            if output_info.get("color_transfer") != "bt709" or output_info.get("pix_fmt") != "yuv420p":
                raise RuntimeError(f"graded clip lacks Rec.709 tags: {graded}")
            output_edl["sources"][record["id"]] = str(graded)
            output_edl["ranges"].append(dict(original, source=record["id"], start=0, end=duration))
        output_edl["total_duration_s"] = sum(r["end"] - r["start"] for r in output_edl["ranges"])
        edl_path = root / "edl.graded.json"
        edl_path.write_text(json.dumps(output_edl, indent=2) + "\n")
        report["edl"] = str(edl_path)
        if not args.prepare_only:
            final = root / "graded.mp4"
            run([sys.executable, str(video_use / "helpers/render.py"), str(edl_path), "-o", str(final)], root, env, log)
            report["final"] = str(final)
        report["status"] = "prepared" if args.prepare_only else "complete"
        return report
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    inputs = result.add_mutually_exclusive_group()
    inputs.add_argument("--edl", type=Path)
    inputs.add_argument("--manifest", type=Path)
    inputs.add_argument("--clips", type=Path, nargs="+")
    result.add_argument("--output-dir", type=Path, help="new directory, never reused (required to grade)")
    result.add_argument("--bake-look", choices=tuple(name for name, chain in LOOKS.items() if chain),
                        help="write that look's whole chain as one .cube (--out) and exit; nothing is graded")
    result.add_argument("--out", type=Path, help="the .cube file --bake-look writes")
    result.add_argument("--reference", help="source ID; default first eligible kept range")
    result.add_argument("--mode", choices=("match", "shared", "auto"), default="match")
    result.add_argument("--fallback-lut", type=Path, help="explicit LUT for shared mode; otherwise used when fitting dependencies are unavailable")
    result.add_argument("--strength", type=float, default=0.35, help="correction blend with identity, 0..1 (default .35)")
    result.add_argument("--look", choices=tuple(LOOKS), help="creative look after the matched correction (default natural; EDL color_grade.look)")
    result.add_argument("--look-lut", type=Path, action="append", metavar="FILE.cube",
                        help="a 3D .cube LUT applied at full strength after the matched correction and the --look chain; repeat for more, applied in the order given (EDL color_grade.look_luts)")
    result.add_argument("--max-width", type=int, help="optional intermediate width bound; preserve source dimensions by default")
    result.add_argument("--prepare-only", action="store_true")
    result.add_argument("--color-grade-dir", type=Path, default=Path(os.environ.get("STUDIO_COLOR_GRADE_DIR", str(Path.home() / ".claude/skills/color-grade-ai"))))
    result.add_argument("--video-use-dir", type=Path, default=Path(os.environ.get("VIDEO_USE_DIR", str(Path.home() / "Developer/video-use"))))
    result.add_argument("--ffmpeg", default="ffmpeg")
    result.add_argument("--ffprobe", default="ffprobe")
    return result


def main(argv: list[str] | None = None) -> int:
    arguments = parser()
    args = arguments.parse_args(argv)
    if args.bake_look:
        if not args.out:
            arguments.error("--bake-look needs --out")
        try:
            bake_look(args.bake_look, args.color_grade_dir.expanduser().resolve(), args.out.expanduser().resolve())
        except (ValueError, OSError) as error:
            print(f"color-grade: {error}", file=sys.stderr)
            return 1
        print(json.dumps({"status": "baked", "look": args.bake_look, "out": str(args.out)}))
        return 0
    if not (args.edl or args.manifest or args.clips) or not args.output_dir:
        arguments.error("an input (--edl, --manifest or --clips) and --output-dir are required")
    try:
        report = batch(args)
    except (ValueError, RuntimeError, OSError, KeyError, TypeError) as error:
        print(f"color-grade: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"status": report["status"], "final": report.get("final"), "edl": report.get("edl")}))
    return 2 if report["status"] == "blocked" else 0


if __name__ == "__main__":
    sys.exit(main())
