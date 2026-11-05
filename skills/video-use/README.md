# video-use skill, Studio Engine version

A version of the [video-use](https://github.com/browser-use/video-use/tree/main) skill by Browser Use for Claude Code. It adds:

- right-to-left captions and graphics (Hebrew, Arabic and mixed lines)
- a mode that edits start to finish without asking questions
- HyperFrames as the default for graphics

## How it relates to the original

This is a layer on top of the original, not a fork. `SKILL.md` installs the original to `~/Developer/video-use`, reads its `SKILL.md`, and follows it with the changes below. Where the two disagree, this file wins.

No code is patched. The Python helpers (`render.py`, `transcribe.py` and the rest) are the original's, unchanged. Everything here is instructions to Claude. The comparison below is against the original's commit [`43cfc56`](https://github.com/browser-use/video-use/tree/43cfc56).

## What changed

| Area | Original | This version |
| --- | --- | --- |
| Way of working | Ask, propose a plan, wait for approval before cutting (Hard Rule 11) | Never asks. Writes the plan to `project.md` with an `Assumptions:` line, then edits. Stops only for a real blocker, such as no footage or no transcription key, and reports it |
| Choices | Asks about format, palette, music and the final render | A table of defaults: canvas, length, captions, hook, grade, look, deliverables |
| Right-to-left text | Not covered. Burned subtitles are Helvetica in capitals, through libass | Full workflow, see below |
| Graphics engine | Pick per animation: HyperFrames, Remotion, Manim or PIL | HyperFrames by default, with rules for what earns a graphic and how often |
| Transparent overlays | `.webm` when alpha is needed, relative paths in the EDL | `.mov` (ProRes 4444) only, absolute paths. WebM alpha turns the frame black through `render.py`, and relative paths resolve to `edit/edit/…` |
| Changing the aspect, punch-ins, split-screen | Not covered: `render.py` only scales | Mode B: video-use makes the cut, HyperFrames composes the final |
| Music | Offers two contrasting beds to choose from | Only files the user supplied, ducked under speech. With none, ships without music and says so |
| Final video | Rendered on confirmation | Always rendered after self-eval. An earlier final is never overwritten (`final_v2.mp4`) |
| File paths | Not covered | Every path is quoted, because client and job names can hold spaces and Hebrew. Never writes above `edit/` |
| Cloud workspace | Not covered | Which hosts are blocked and the fallbacks for each. GSAP and fonts are vendored so renders work offline |

## Right-to-left support

The original has no mention of Hebrew, Arabic or right-to-left text, in its `SKILL.md` or in `render.py`. This version adds:

- **Transcription:** `--language he` for Hebrew, and captions in the spoken language.
- **Captions as a HyperFrames layer:** Hebrew, Arabic and mixed lines are rendered in HTML and composited as the last overlay, which keeps the original's "subtitles last" rule. Burned libass subtitles stay for plain English.
- **Right word order:** `dir="auto"` with `unicode-bidi: plaintext` on each line. A Hebrew-first video can force a right-to-left base, so a line that opens with an English word still reads right to left.
- **Animation that doesn't break the text:** the whole line animates. `inline-block` or per-word transforms on Hebrew words reverse any English inside them.
- **Fonts:** Heebo is vendored with the Hebrew and Latin `unicode-range` values. Rubik, Assistant, Noto Sans Hebrew and Frank Ruhl Libre work the same way.
- **A final check:** word order on a mixed line, highlight order, real glyphs rather than a fallback font, and lines clear of the platform's UI.
- **Sidecar file:** `words_out.srt` maps the words onto the output timeline and is delivered as `final.srt`.
- **When libass has to be used:** a field note on how runs of different sizes get laid out, and how to order them for right-to-left emphasis.

## Other additions

From real edits, in `SKILL.md` §5:

- iPhone HLG footage needs tone-mapping if you bypass `render.py`.
- AAC segments joined with `-c copy` drift 30–65 ms each, and how to avoid it.
- `adelay` on stereo files delays only one channel.
- libass font sizes don't match PIL pixel sizes.
- Dynamic loudnorm can wreck a mix, with a static-gain recipe instead.
- How to measure an existing series so a new episode matches it.

§3 also has the HyperFrames rules that break renders when ignored, 9:16 safe zones, and a slot skeleton.

## What stayed the same

These all come straight from the original:

- Audio-first cutting and the packed transcript
- Hard Rules 1–10 and 12
- The EDL format and per-segment extraction
- Color grading and self-eval on the rendered output
- The helpers themselves

## Install

Needs Node 22+, ffmpeg, Python with `uv` or `pip`, and an ElevenLabs key for transcription.

From the root of this repo:

```bash
mkdir -p ~/.claude/skills/video-use ~/.claude/skills/edit-video
cp skills/video-use/SKILL.md ~/.claude/skills/video-use/
cp skills/edit-video/SKILL.md ~/.claude/skills/edit-video/
```

Copy the video-use file, don't symlink it. §1 of `SKILL.md` links the original to that same path, which would replace a symlink.

The first run clones the original to `~/Developer/video-use`. Put your key in `~/Developer/video-use/.env` as `ELEVENLABS_API_KEY=...`.

## Limits

- **It needs the [`edit-video`](../edit-video/README.md) skill for its best captions.** The HyperFrames caption builder (`build-captions.mjs`, §3.4) and Mode B (§3.5) come from it. Without it, captions fall back to `render.py`'s burned subtitles with a Hebrew-capable font, so right-to-left captions are much weaker, and Mode B isn't available.
- **§2, §3.2 and §4 are partly written for Claude's cloud workspace.** On your own machine the blocked-host notes don't apply, and neither does the part of §4 about copying files back.
- **The HyperFrames steps were checked with CLI 0.8.180 (October 2026).** The CLI changes often. If a flag disagrees with `npx hyperframes <command> --help`, trust `--help`.

## License

The original is MIT licensed by Browser Use, and its license is kept in [`LICENSE`](LICENSE). HyperFrames (Apache-2.0, by HeyGen) is fetched with `npx` and not included here.
