# edit-video skill

A Claude Code skill that edits a video from start to finish with [HyperFrames](https://github.com/heygen-com/hyperframes): raw footage in, rendered MP4 out. Hebrew and other right-to-left captions are built in.

It works on its own, and the [video-use skill](../video-use/README.md) in this repo also depends on it.

## What it covers

Twelve phases, each ending in a check that has to pass before the next one starts:

| Phase | What happens |
| --- | --- |
| 1. Brief | Aspect, length, language, story, music and captions, saved to `BRIEF.md` |
| 2. Ingest | Scaffold the project, probe every source, re-encode what needs it |
| 3. Transcribe | Word timings, then read and correct the transcript |
| 4. Rough cut | A list of kept segments, turned into clips without re-encoding the source |
| 5. Reframe and camera | Crops, punch-ins, Ken Burns |
| 6. B-roll and graphics | Overlays, titles, ready-made HyperFrames blocks, platform safe zones |
| 7. Captions | Word-timed captions with an active-word highlight |
| 8. Audio | Music, ducking under speech, sound effects, loudness, cutting to the beat |
| 9. Transitions | Hard cuts by default, then crossfades, whips and shader transitions |
| 10. Colour and look | Grades and side-by-side comparisons |
| 11. QA | Lint, runtime checks, contact sheets, a draft render |
| 12. Render and deliver | Final MP4s, verified with ffprobe |

`SKILL.md` also lists the rules that break renders when ignored, cheat sheets for the attributes and the CLI, a troubleshooting table, and places where the HyperFrames docs and code disagree.

## Right-to-left captions

The official HyperFrames caption paths are Latin-only: no `dir` handling, Latin font subsets, and highlights that sweep left to right. This skill has its own builder, `build-captions.mjs`:

- **Right word order:** every line gets `dir="auto"` with `unicode-bidi: plaintext`, so a Hebrew line runs right to left, an English line left to right, and the browser orders a mixed line.
- **Animation that doesn't break the text:** the whole line animates, and the highlight is only a color change. `inline-block` or per-word transforms on Hebrew words reverse any English inside them.
- **Captions that follow the cut:** words are re-timed onto the edit from the same `segments.json` the cut used, and words in removed ranges are dropped.
- **Fonts:** Heebo, Rubik, Assistant, Noto Sans Hebrew and Frank Ruhl Libre from Fontsource, vendored so renders work offline.
- **Transcription:** Whisper with `--language he`, because the faster Parakeet engine doesn't cover Hebrew. The filler lists include Hebrew words.
- **A final check:** word order on a mixed line, highlight order, real glyphs rather than a fallback font, and lines clear of the platform's UI.

## Helper scripts

The appendix of `SKILL.md` holds four Node scripts with no dependencies. Claude writes them to `<project>/.edit/` the first time they're needed.

| Script | What it does |
| --- | --- |
| `cut-to-clips.mjs` | Turns a list of kept segments into back-to-back `<video>` clips, with short fades at the splices and optional alternating punch-ins |
| `build-captions.mjs` | Builds the right-to-left-safe caption sub-composition |
| `duck-lane.mjs` | Makes a music volume lane that dips under speech, from word timings. It works on segment clips, where the official `carve.mjs` doesn't |
| `beat-montage.mjs` | Lays clips back to back with every cut on a beat |

## How it relates to video-use

The two skills do different jobs:

- **video-use** makes the cut decisions, working from the transcript.
- **edit-video** builds the HyperFrames side.

video-use uses edit-video in two places:

- **§3.4 captions:** it extracts `build-captions.mjs` from this skill's appendix.
- **§3.5 Mode B:** it follows Phases 5–12 here to build the final composition, for aspect changes, punch-ins and live previews.

Studio Engine's edit runs load video-use, which loads this skill when it needs it. Used on its own, this skill asks about the brief and waits for approval before the final render. Under video-use, those approval gates become Claude's own self-evaluation.

## Install

Needs Node 22+ and ffmpeg.

From the root of this repo:

```bash
mkdir -p ~/.claude/skills/edit-video
cp skills/edit-video/SKILL.md ~/.claude/skills/edit-video/
```

video-use looks for this skill only at that path. `pnpm run doctor` checks that it's there and warns if it differs from the copy in this repo.

On first use, §1 of `SKILL.md` has you check the machine with `npx hyperframes doctor`, fetch Chrome with `npx hyperframes browser ensure`, and keep a shallow clone of the HyperFrames repo for `transcript-cut.mjs`, `carve.mjs` and the sound effects library.

No API key is needed. Transcription runs locally with Whisper, and rendering runs locally too, with optional cloud rendering through HeyGen.

## Limits

- **Checked against HyperFrames CLI 0.8.178 and 0.8.179 (October 2026).** The CLI changes often. If a flag disagrees with `npx hyperframes <command> --help`, trust `--help`.
- **The Hebrew examples are the tested path.** Arabic goes through the same caption builder, but you choose the font and filler words yourself.
- **No Hebrew voiceover from the local voice tool.** It needs a cloud voice service or a recorded take.
- **No automatic face tracking.** Framing is set by hand for each shot.

## License

MIT, see [`LICENSE`](LICENSE). HyperFrames (Apache-2.0, by HeyGen) is fetched with `npx` and cloned at run time, and is not included here.
