# Color grading (color-grade-ai)

Every edit run grades its clips before baking: one reference clip sets the look, every other
range is matched to it with a `.cube` LUT, and video-use bakes the result with `grade.py --filter`
(so video-use's own auto-grade never stacks on top).

## Install (once)

```bash
pnpm color-grade:install
```

Clones [color-grade-ai](https://github.com/isaacrowntree/color-grade-ai) (pinned commit) into
`~/.claude/skills/color-grade-ai` and builds a Python venv in `~/.studio-engine/color-grade/`
(Pillow, NumPy, PyYAML; needs video-use's Python 3.12 venv). Fitted LUTs need Ruby 2.7+ and
HLG/PQ needs FFmpeg with `zscale`: `brew install ruby@3.4 ffmpeg-full` (`run.sh` uses them without
changing your defaults).

## Run by hand

```bash
pnpm color-grade --edl path/to/edl.json --output-dir path/to/new-dir --prepare-only
```

- `--mode match` (default) matches each range to the reference; `shared` uses one LUT for everything
  (the fallback when matching is poor); `--fallback-lut` supplies your own.
- `--look natural|cinematic` (default natural; or `color_grade.look` in the EDL) adds a creative look after the matching: `cinematic` is film contrast plus a light golden warmth.
- `--look-lut FILE.cube` (repeatable; or `color_grade.look_luts` in the EDL, a list of paths read
  from the EDL's folder) applies a LUT you name, at full strength, after the matched correction and
  after the `--look` chain, in the order given. Each file must be a complete 3D `.cube` (checked
  before anything is made) and is copied to `luts/lut_N_<name>.cube` in the output folder; `report.json`
  lists them as `look_luts` (source, path, sha256). The engine uses it when a review or job note names
  a LUT (`@luts/name`). Passing `--look-lut` replaces the EDL's `look_luts`, it does not add to them.
- `--bake-look cinematic --out FILE.cube` writes the look's whole chain as one 33-point `.cube`
  and exits (the LUTs page uses it for the Cinematic preview); nothing is graded.
- `--strength` blends the correction with identity (default 0.35, conservative).
- Log footage needs its camera LUT in the EDL's `color_grade.sources`; it is never guessed. A log
  source without one blocks the grade. `report.json` lists such a source under `needs_camera_lut`
  (`source`, `input`, and the `kind` that put it there: `log`, or `ambiguous` when the frames cannot
  say log from a very flat display grade, which real log often does). Studio Engine reads the
  footage's tags and file names for the curve ("S-Log3") and, with `lutsInEdits` on, hands the
  editor the one Camera LUT of the library that names it; a job that has none ends as "Waiting for
  a camera LUT: the clips are Sony S-Log3." and goes on after the LUT is imported.
- A frame blocks the grade as "log" or "ambiguous" only when it shows all four log signs (lifted black,
  rolled highlights, a narrow range, washed colour: confidence 1.0). A "log" (0.8) or "ambiguous" (0.75)
  measured on three of the four, for example a calm sky, whose range is wide, is graded as display instead:
  its `footage.kind` is `display`, `footage.weak_log` is `true`, the detector's verdict is kept under
  `footage.measured` (`kind`, `confidence`), and the source is listed under the report's `weak_log`
  (`source`, `input`, `kind` it measured as, `confidence`). The key keeps its name; it holds weakly
  measured log and ambiguous clips. The line sits at `LOG_BLOCK_MIN_CONFIDENCE` (0.9) in
  `grade_batch.py`. Every real log frame measured so far (S-Log3: range 0.44 to 0.46) shows all four
  (log 1.0 or ambiguous 1.0); the frames this lets through were not log (a sky at range 0.67 to 0.73). A
  source the EDL declares (`transfer`) is never changed by this.
- Output: `report.json`, before/after `frames/`, `luts/`, `graded/` and `edl.graded.json`
  (top-level `grade: "none"`). Bake from that EDL.
- `--output-dir` must be new; each run is reproducible and recorded in `report.json`.

## Naming a LUT in a note

`@luts/name` works in notes by default (the `lutsInEdits` switch; `STUDIO_LUTS_IN_EDITS=0` turns it
off, and it does nothing while `luts` is off). Type `@` in a Review note or the job note, pick a LUT
from the list (Yours, the built-in ones, Cinematic) and the note carries `@luts/name`.

- When the run starts, each LUT the notes name is copied whole into the job as
  `<job>/edit/luts/<slug>.cube` (a stale copy is replaced). The Cinematic look has no file: it is
  the wrapper's own `--look cinematic`.
- The editor applies the copies with the wrapper's `--look-lut ./edit/luts/<slug>.cube` (repeatable,
  in the order the notes name them), after the matched correction, so the look lands on top of the
  match. A name that points at nothing is reported to the editor as missing; it never fails the run.
- A use is counted in the LUTs list ("Used in") only once the run succeeded.
- In Review the player shows the look on the paused frame, with Compare for the frame as it was.

## Checking

Open `frames/*_normalized.png` against `frames/*_corrected.png`. Look at faces: skin tone is the
main risk, and one frame is fitted per range.
