---
name: "edit-video"
description: "Edit a video start to finish with HyperFrames — raw footage to rendered MP4: cuts, reframing, captions (incl. Hebrew/RTL), music, overlays, transitions, QA, render."
---

# /edit-video — edit a video end to end with HyperFrames

HyperFrames (`heygen-com/hyperframes`, Apache-2.0) turns an HTML page into a video: clips are HTML elements placed on a timeline with `data-*` attributes, motion is a paused GSAP timeline, and the renderer seeks headless Chrome frame by frame and encodes with FFmpeg. Editing is non-destructive: source files are never touched; a "cut" is a `<video>` element that plays a range of a file.

This skill is self-contained. It was checked against CLI **0.8.178/0.8.179 (Oct 2026)**: the helper scripts and core recipes were rendered on test projects, and the rest was checked against the source. The CLI moves fast (about one release a day), so when a flag here disagrees with `npx hyperframes <cmd> --help`, trust `--help`. If the official HyperFrames skills are installed (`/hyperframes`, `/hyperframes-core`, `/media-use`, …), they are good for deeper detail, but you do not need them.

Work through the phases in order. Each phase ends with a gate; do not move on until it passes.

---

## 0. Rules that break renders if ignored

1. **One HTML file is the edit.** The root element needs `data-composition-id`, `data-width`, `data-height`, `data-duration`. The render length is the root `data-duration`, never the GSAP length. Raise it whenever the edit gets longer.
2. **Timed media needs**: `id`, `src`, `data-start`, and exactly one of `muted` (silent/B-roll) or `data-has-audio="true"` (keep its sound). An `<audio>` without `id` is silently left out of the mix.
3. **Trim** with `data-media-start` (in-point, source seconds) + `data-duration`. There is no out-point attribute: out = `data-media-start + data-duration × rate`. Do not use `data-playback-start` on `<video>`/`<audio>` or the invented `data-trim-*`.
4. **Never script media**: no `play()`, `pause()`, `currentTime =`, `muted =`, no `autoplay`, no `crossorigin`, no self-closing `<video … />`.
5. **One paused GSAP timeline per composition**: `const tl = gsap.timeline({ paused: true }); … window.__timelines["<data-composition-id>"] = tl;`. Register after the last tween. The key must equal the composition id exactly.
6. **Deterministic only**: no `Math.random`, `gsap.utils.random`, GSAP `"random(…)"` strings, `Date.now`, `new Date()`, `performance.now`, `requestAnimationFrame`, CSS `transition`, `repeat: -1`. Use a seeded PRNG (mulberry32) if you need noise.
7. **Animate wrappers, not media.** Never tween `width/height/top/left` or transforms on a timed `<video>`; put it in an untimed `<div>` and move/scale the div. Never put a timed `<video>` inside a *timed* wrapper.
8. **Transforms and opacity only.** No tweens on `left/top/width/height/margin/fontSize/letterSpacing` (lint error). Don't combine CSS `transform: translate(-50%)` with GSAP `x/y` on one element; use `xPercent/yPercent`.
9. **Seek-safe tweens.** Use `fromTo` with explicit start states, absolute values (no `+=`), and put `opacity: 1` in the destination when revealing something hidden. Don't hide things with `tl.set(…, 0)`; hide them in CSS.
10. **Don't tween `opacity`/`visibility` on a `.clip` element itself**; tween a child inside it.
11. **Paint order is CSS `z-index`/DOM order.** `data-track-index` is only the Studio lane; the render ignores it.
12. **Relative starts need spaces**: `data-start="intro + 0.5"`. `"intro-0.5"` silently becomes 0.
13. **Sub-composition files** wrap everything (styles and scripts too) in `<template>`. Host id = inner `data-composition-id` = timeline key, or the render stalls 45 s and freezes.
14. **Fonts**: every family needs an `@font-face` (local `.woff2`) unless it is a bundled alias (Inter, Roboto, Montserrat, Poppins, Oswald, …). Hebrew needs a Hebrew-capable font (see Phase 7).
15. **Assets live inside the project.** No temporary or signed URLs, no base64 media, no runtime `fetch()`.
16. **Negative CLI numbers need `=`**: `--lufs=-14`, `--offset=-0.033` (a space makes the parser treat them as flags).

---

## 1. Setup (once per machine)

```bash
node --version                      # needs >= 22
ffmpeg -version && ffprobe -version # install separately (brew/apt/winget)
npx hyperframes doctor              # Chrome, FFmpeg, RAM, disk, whisper, TTS
npx hyperframes browser ensure      # downloads chrome-headless-shell (fast BeginFrame capture)
```

- If Chrome can't be downloaded, point at any Chromium: `export HYPERFRAMES_BROWSER_PATH=/path/to/chrome`. Renders still work, just via slower screenshot capture.
- Whisper (for `transcribe`) installs on first use: via Homebrew on macOS, otherwise by building whisper.cpp from source (needs `git`, `cmake` and a C compiler; if missing it fails with "whisper-cpp not found"). Models download from huggingface.co. English and 24 European languages can use the faster Parakeet engine instead: `npx hyperframes models install parakeet` (not Hebrew). Local TTS needs Python: `pip install kokoro-onnx soundfile`.
- Telemetry off: `export HYPERFRAMES_NO_TELEMETRY=1`. Skip the skill check during `init` (CI/agents): `export HYPERFRAMES_SKIP_SKILLS=1`.
- Some helper scripts used below ship only in the HyperFrames repo (`transcript-cut.mjs`, `carve.mjs`, the SFX library). Keep a shallow clone:
  ```bash
  HF_REPO=~/.cache/hyperframes-repo
  [ -d "$HF_REPO" ] || git clone --depth 1 https://github.com/heygen-com/hyperframes "$HF_REPO"
  git -C "$HF_REPO" pull --ff-only   # refresh occasionally
  ```
  The repo's `docs/` folder is also the best offline reference (`docs/reference/html-schema.mdx`, `docs/reference/lint-rules.mdx`).
- Write the four helper scripts from the Appendix to `<project>/.edit/` the first time you need them.

---

## 2. The pipeline at a glance

| # | Phase | Produces | Gate |
|---|---|---|---|
| 1 | Brief | `BRIEF.md` (aspect, length, language, story, music, captions) | user confirmed the must-haves |
| 2 | Ingest | project folder, normalized media in `assets/` | every file probes clean |
| 3 | Transcribe | `work/transcript.json` (word timings) | transcript read and corrected |
| 4 | Rough cut | `segments.json` → clips in `index.html` | story plays in order, no dead air |
| 5 | Reframe & camera | crops, punch-ins, Ken Burns | subject framed in every shot |
| 6 | B-roll & graphics | overlays, titles, registry blocks | `lint` clean |
| 7 | Captions | `compositions/captions.html` | snapshots read correctly |
| 8 | Audio | music, ducking, SFX, loudness | listen pass + loudness numbers |
| 9 | Transitions | seams | `check` clean |
| 10 | Colour & look | `data-color-grading` | grade-compare approved |
| 11 | QA | contact sheet, draft render | `check` passes, frames inspected |
| 12 | Render & deliver | final MP4(s) | ffprobe verified, user approved |

Small edits on an existing project skip straight to the phase they touch, then re-run Phase 11.

---

## Phase 1 — Brief

Settle these before touching footage. Ask only what you can't infer, one or two questions at a time, recommended option first.

| Field | Default if unspecified |
|---|---|
| Destination → canvas | Reels/TikTok/Shorts → `portrait` 1080×1920; feed → `square` 1080×1080 (or 1080×1350 for 4:5); YouTube/web → `landscape` 1920×1080 |
| Length | Reels 15–45 s; keep the best material, not all of it |
| fps | Match the footage (usually 30); 25 for PAL footage; never upsample to 60 for social |
| Language(s) | From the footage; captions in the spoken language |
| Story | One sentence: "This video tells [audience] that [message]." Hook in the first 1–2 s |
| Captions | On for social (most viewers watch muted); 2–3 words per line, active-word highlight |
| Music | Must be licensed for commercial use; record source and licence in `BRIEF.md` |
| Sync mode | **Edit-first** (speech drives cuts, music sits under it) for talking heads; **music-first** (cuts on beats) for montages |
| Deliverables | One MP4 per aspect ratio; SRT if requested |

After `init` (Phase 2), write `BRIEF.md` in the project root:

```markdown
---
destination: instagram-reels
aspect: 1080x1920
fps: 30
length: 30-40s
language: he   # speech; captions follow speech
sync: edit-first
music: assets/music.mp3 (licence: <source>, commercial OK)
---
## Intent
<the message, the hook, the call to action — in the user's words>
## Assets
- assets/a-roll.mp4 — main talking take
- assets/broll-*.mp4 — cutaways
## Must keep / must cut
## Notes
```

**Short-form craft defaults** (use unless the brief says otherwise): open on the strongest line or a visual hook, no intro card before it; a visible change every 2–4 s (cut, punch-in, B-roll, graphic); remove every pause over ~0.4 s and every false start; captions always on; end on a CTA or a loop-friendly last line; keep text out of the platform UI zones (Phase 6).

---

## Phase 2 — Ingest and prepare media

### 2.1 Scaffold

```bash
mkdir -p videos && cd videos
npx hyperframes init my-reel --resolution portrait --non-interactive   # landscape | portrait | square | *-4k
cd my-reel && mkdir -p assets/fonts work vendor compositions .edit
```

- Read the generated `index.html` before editing; the scaffold changes between versions (bundled blank vs remote `--example blank`).
- `init --video <file>` copies the clip to the project **root** (not `assets/`), transcodes it only if the codec isn't browser-friendly (H.264/VP8/VP9/AV1 are copied as-is), and auto-transcribes it with `small.en` (English) unless you pass `--language`. To stay in control, scaffold blank and stage media yourself (below). If you do use it, pass `--skip-transcribe`, or `--language <code>`.
- Set the frame rate on the root when it isn't 30: add `data-fps="25"` (or 24/60) next to `data-width`. Render uses root `data-fps`, else 30.
- Pinned CLI: the generated `package.json` scripts pin `hyperframes@X.Y.Z` so re-renders match. Use `npx hyperframes …` while authoring. Upgrade a pin with `npx hyperframes@latest upgrade --project . --check`, then the same without `--check`.

**Make it offline-safe.** Scaffolds load GSAP from jsDelivr; a render without network fails ("sub_timeline_script_failure"). Vendor it:

```bash
npm pack gsap@3.14.2 --silent && tar -xzf gsap-3.14.2.tgz && cp package/dist/gsap.min.js vendor/ && rm -rf package gsap-3.14.2.tgz
sed -i.bak 's#https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js#vendor/gsap.min.js#' index.html && rm index.html.bak
```

Then `grep -rn "cdn.jsdelivr" --include=*.html .` and vendor whatever is left the same way: GSAP plugins (CustomEase, MotionPathPlugin), other GSAP versions (some registry items pin 3.15.0), Lottie, Three.js. Repeat after every `hyperframes add`.

### 2.2 Probe every source

```bash
for f in raw/*; do echo "== $f"; ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate,avg_frame_rate,color_transfer:stream_side_data=rotation \
  -show_entries format=duration -of compact "$f"; done
```

Re-encode a source to an editing mezzanine when any of these hold: variable frame rate (`r_frame_rate` ≠ `avg_frame_rate`; typical for phone footage), HEVC/ProRes you want to preview smoothly, sparse keyframes (seeks freeze), rotation metadata, or an odd frame size.

```bash
ffmpeg -i raw/IMG_1234.MOV -vf "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v libx264 -crf 18 -preset medium -g 30 -keyint_min 30 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -ar 48000 -movflags +faststart assets/a-roll.mp4
```

- Re-encoding with FFmpeg applies phone rotation metadata automatically.
- Keep width and height multiples of 16 where you can; older builds cropped 8 px off non-multiple-of-16 widths.
- iPhone HDR (HLG/Dolby Vision, `color_transfer=arib-std-b67`): HyperFrames auto-detects HDR and renders HDR10 HEVC. For social, render with `--sdr` (Phase 12).
- Name files descriptively and keep everything under `assets/`. Never edit originals; work on copies.

### 2.3 Audio for transcription, and music

```bash
ffmpeg -y -i assets/a-roll.mp4 -vn -ac 1 -ar 16000 work/a-roll.wav
```

Music: copy into `assets/music.mp3`. Confirm the licence allows commercial use and note it in `BRIEF.md`. If the track is shorter than the video, pre-loop it, because `<audio loop>` works in preview but is not looped by the render mixer:

```bash
ffmpeg -stream_loop 3 -i assets/music-src.mp3 -t 90 -c:a libmp3lame -q:a 2 assets/music.mp3
```

**Gate:** every file in `assets/` probes, constant frame rate, sensible size.

---

## Phase 3 — Transcribe

```bash
# English
npx hyperframes transcribe work/a-roll.wav -d work --model small.en --json
# Any other language (Hebrew = he): multilingual model + explicit language
npx hyperframes transcribe work/a-roll.wav -d work --engine whisper --model large-v3-turbo --language he --json
```

- Output is `work/transcript.json`, a flat array `[{ "id": "w0", "text": "…", "start": 0.12, "end": 0.46 }, …]` in **source seconds**. `--json` also prints `detectedLanguage`, `wordCount`, `speechOnsetSeconds` (leading dead air).
- Without `-d`, the transcript lands next to the input file.
- **Always pass `--language` for non-English speech.** With no `--language`, the default `.en` model forces English and translates or garbles the speech. With a non-English `--language`, the CLI swaps a `.en` model for its multilingual twin automatically.
- **Hebrew**: the faster Parakeet engine doesn't cover Hebrew, and with `--engine auto` and no `--language` it is picked anyway if installed. Always pass `--language he` (and `--engine whisper`). Models: `small` (fast, weaker), `medium`, `large-v3-turbo` (good default), `large-v3` (best, slow).
- Keep `-d` pointed at `work/`: `transcribe` rewrites any `.html` in that folder that contains an inline `const script = […]` or `const TRANSCRIPT = […]` array.
- Optional pause map (no ASR): `npx hyperframes audio work/a-roll.wav --only silence --json` gives `silence: [{start,end}]` (−50 dBFS, ≥200 ms).
- Import an existing transcript or subtitles: `npx hyperframes transcribe subs.srt -d work`. Export a sidecar: `npx hyperframes transcribe work/transcript.json --to srt -o out/captions.srt`.

**Then read the transcript yourself.** Fix misheard names, brand terms and numbers in `text`; keep `start`/`end`. Whisper has no vocabulary prompt. Watch for hallucinated filler ("Thank you." repeated over silence) and drop those words. Retry a bad transcript once with a larger model.

**Gate:** the transcript reads correctly, end to end.

---

## Phase 4 — Rough cut

### 4.1 Decide what stays

Read the transcript as a script and decide the story: hook first, then the best take of each point, then the CTA. Note the cut decisions explicitly:

- **Takes**: when a sentence is repeated, keep the last complete version. Drop false starts and stutters, and self-corrections up to the correction.
- **Fillers**: English `um, uh, er, ah, hmm`; Hebrew `אממ, אה, אהה, אמ, אמממ`. Context-dependent words ("like", "you know", "כאילו", "בעצם", "נו") are removed by word index or time range only after you read them in context.
- **Pauses**: cut gaps longer than ~0.4–0.6 s for social, ~0.8 s for calm/long-form.
- **Reorder**: allowed. Segments don't need to be chronological.

### 4.2 Compile the cut list (kept segments, source seconds)

Use the official cut-list compiler in plan mode (no encode):

```bash
node "$HF_REPO/skills/media-use/scripts/transcript-cut.mjs" --transcript work/transcript.json \
  --remove-fillers "um,uh,אממ,אה" --cut-silence 0.5 \
  --remove "0-1.8,42.1-47.9" --remove-words "118-131" --plan > work/segments.json
```

Behaviour verified in source and tests:
- `--remove a-b,…` seconds; `--remove-words i-j,…` inclusive 0-based word indices; `--remove-fillers` single tokens only (case and punctuation ignored, multi-word fillers silently match nothing); `--cut-silence X` removes the middle of gaps longer than X, keeping 0.15 s handles; `--keep a-b,…` inverse mode (exclusive with removals).
- Filler and word removals are cut tight to Whisper's word edges with no padding, so they can clip a syllable. Listen at those cuts.
- Kept pieces shorter than 0.2 s vanish silently. Speech before the first word is kept; audio after the last word is dropped. Remove leading dead air yourself with `--remove 0-<speechOnset−0.1>`.
- Output: `[{"start":0,"end":1.35},{"start":2.4,"end":5.35},…]`.

To reorder, hand-edit `work/segments.json`: array order is timeline order. You can also write the file by hand from transcript times. Keep ~0.08–0.15 s of handle before the first syllable and after the last.

### 4.3 Turn segments into clips (non-destructive)

```bash
node .edit/cut-to-clips.mjs --segments work/segments.json --src assets/a-roll.mp4 \
  --punch 1.12 --pos "50% 40%" > work/clips.html
# stderr: {"clips":N,"end":T,"duration":T,"cuts":[...]}
```

Paste `work/clips.html` inside the root `<div>` and set root `data-duration` to the printed `end` (plus any outro). Each clip is `wrap (untimed, overflow hidden) > zoom (untimed, scale) > <video data-start data-duration data-media-start data-has-audio>`, with 30 ms audio fades at interior splices (`data-fade-in/out`) to stop clicks. `--punch 1.12` alternates 100%/112% framing so jump cuts read as intentional. `--pos` sets the crop anchor for `object-fit: cover` (see Phase 5). `--muted` makes silent B-roll clips.

**Baked alternative.** For very long edits (hundreds of segments) or a mezzanine for another tool, encode the cut instead:

```bash
node "$HF_REPO/skills/media-use/scripts/transcript-cut.mjs" --input assets/a-roll.mp4 \
  --transcript work/transcript.json --remove-fillers "um,uh" --cut-silence 0.5 --out assets/a-roll.cut.mp4 --json
```

It writes frame-accurate H.264 with 30 ms splice fades. Don't use `--copy` (keyframe-snapped, can silently drop cuts). Re-transcribe the cut file before captioning.

### 4.4 Surgical edits afterwards

Print the edit as tracks: `npx hyperframes timeline` (`--json` for machine use). Edit by element ref:

```bash
npx hyperframes timeline split '#seg-3' 12.4          # cut a clip in two at a global second
npx hyperframes timeline move  '#seg-5' 20.0 --plan   # dry run first; refusals exit 2 and write nothing
npx hyperframes timeline trim  '#seg-5' --duration 2.1
npx hyperframes timeline delete '#seg-5'              # or --start A --end B for a range
npx hyperframes timeline set '#music' --volume 0.4
npx hyperframes timeline apply edits.json             # atomic batch: [{verb, ref, …}]
```

- No ripple: deleting leaves a gap. Shift every later `data-start` (and root `data-duration`) yourself, or regenerate the clips from `segments.json`, which is usually simplest.
- `timeline trim --start` moves `data-start` but **does not advance `data-media-start`**. For front-trims, change `data-media-start` by hand or split and delete.
- Group your edits into undoable turns: `npx hyperframes history begin --who claude --label "tighten intro"` … `npx hyperframes history end`; undo with `npx hyperframes history undo --who claude`.

### 4.5 Other cut recipes

- **Speed**: `data-playback-rate="0.5"` (0.1–10, pitch kept; consumed source = duration × rate). For a ramp, add a `rate` lane: `data-automation='{"version":1,"lanes":[{"target":"rate","points":[{"t":0,"v":1},{"t":1,"v":3},{"t":2,"v":1}]}]}'` (`t` is clip-local seconds, log-interpolated, overrides the constant rate). No reverse playback; pre-render reversed footage with `ffmpeg -vf reverse -af areverse`.
- **Freeze frame**: extract a still (`ffmpeg -ss T -i src -frames:v 1 assets/freeze.jpg`) and place it as an `<img class="clip">` for the hold.
- **J/L cut** (sound leads or trails picture): make the videos `muted` and give each its own `<audio id=… src=same file data-media-start=…>` so picture and sound cut at different times.
- **Crossfade**: overlap two clips by 0.3–0.5 s, fade the incoming *wrapper*'s opacity 0→1 in the timeline, and give each video an opposing `volume` lane.

**Gate:** `npx hyperframes lint` clean; snapshot the cut points; story reads in order.

---

## Phase 5 — Reframe and camera

**16:9 footage on a 9:16 canvas.** `object-fit: cover` fills the height and crops the sides; `object-position: X% Y%` chooses what stays. Pick X per shot from a snapshot: 50% centered; lower X keeps the left side. Override per clip by editing that clip's inline style. A fixed crop window: `clip-path: inset(…)` on the wrapper.

**Punch-in / zoom / Ken Burns.** Animate the untimed wrapper, never the `<video>`:

```js
// 0.18 s punch on a cut at t=12.4
tl.fromTo("#seg-7-zoom", { scale: 1 }, { scale: 1.15, duration: 0.18, ease: "power2.out" }, 12.4);
// slow push across a whole shot (B-roll or still)
tl.fromTo("#broll-2-zoom", { scale: 1.0, xPercent: 0 }, { scale: 1.12, xPercent: -4, duration: 4, ease: "none" }, 8.0);
```

If a zoom wrapper already has a static `transform: scale()` in CSS (from `--punch`), don't also tween it from GSAP; tween the outer `-wrap` instead, or remove the static scale. Mark intentionally oversized wrappers `data-layout-allow-overflow` (the generated ones already are) so `check` doesn't flag them.

**Destructive crop** (only if needed for another tool): `ffmpeg -i in.mp4 -vf "crop=ih*9/16:ih:(iw-ih*9/16)*0.5:0,scale=1080:1920" out.mp4`. HyperFrames has no automatic face tracking; framing is authored geometry.

**Gate:** snapshot every shot (`npx hyperframes snapshot --at <mid of each clip>`) and check the subject is framed and headroom is consistent.

---

## Phase 6 — B-roll, titles, overlays, registry blocks

### 6.1 B-roll and stills

```html
<div id="broll-1-wrap" style="position:absolute;inset:0;overflow:hidden;z-index:5">
  <div id="broll-1-zoom" data-layout-allow-overflow style="position:absolute;inset:0">
    <video id="broll-1" src="assets/broll-desk.mp4" data-start="6.2" data-duration="2.4" data-media-start="3"
      data-track-index="1" muted playsinline
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
  </div>
</div>
<img id="photo-1" class="clip" src="assets/photo.jpg" data-start="9" data-duration="2"
  data-track-index="1" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:5" />
```

The A-roll audio keeps playing under muted B-roll because sound lives on the A-roll clips. Images without `data-duration` default to 3 s. Place cutaways on transcript moments: when the speaker names a thing, show the thing.

### 6.2 Titles and text

Untimed text that the timeline reveals and hides is the simplest and lint-clean pattern:

```html
<div id="hook" dir="auto" style="position:absolute;left:80px;right:80px;top:300px;z-index:30;opacity:0;
     font:800 104px/1.05 'Heebo',sans-serif;color:#fff;text-align:center;text-shadow:0 6px 30px rgba(0,0,0,.6)">
  3 טעויות שכולם עושים
</div>
```
```js
tl.fromTo("#hook", { opacity: 0, y: -40 }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, 0.1);
tl.to("#hook", { opacity: 0, y: -20, duration: 0.3, ease: "power2.in" }, 2.2);
```

A timed text clip (`class="clip" data-start …`) with an inner element also works, but nested markup inside a root-level clip triggers the `nested_structure_needs_subcomposition` warning. Move bigger graphics into a sub-composition (6.4).

### 6.3 Safe zones (9:16, 1080×1920)

Platform UI covers roughly the top ~220 px, the bottom ~420 px (caption, audio, buttons) and the right ~140 px (like/comment/share). Keep titles in the upper-middle band (top 250–700 px) and captions in the lower-middle band (about 560–720 px above the bottom edge). Studio overlays title-safe (80%) and action-safe (90%) guides.

### 6.4 Registry blocks and components

There are 450+ ready-made pieces: lower thirds, follow/subscribe cards, titles, counters, charts, maps, transitions and caption styles.

```bash
npx hyperframes catalog --query "instagram follow card" --json    # English query, ranked
npx hyperframes catalog --type block --tag social                  # browse by tag
npx hyperframes add instagram-follow --no-clipboard                # exact name; prints a mount snippet
```

Mount the printed snippet and **add timing and stacking yourself** (the snippet has neither):

```html
<div id="ig-follow" data-composition-id="instagram-follow" data-composition-src="compositions/instagram-follow.html"
     data-start="24.5" data-duration="4.5" data-width="1080" data-height="1920" data-track-index="3"
     style="position:absolute;inset:0;z-index:40"></div>
```

- Blocks install to `compositions/<name>.html`, components to `compositions/components/`. Assets go to their fixed paths. `add` needs network.
- Use exact names. A bare tag (`add captions`) installs every item with that tag.
- The host `data-duration` should be at least the block's own length, or its exit animation is cut.
- Most social overlays and lower thirds have hard-coded placeholder text and avatars (for example "HeyGen", "Dr. Maya Chen"). Edit the installed HTML (text, `assets/avatar.jpg`, colors) and re-snapshot. Blocks that declare `data-composition-variables` take per-mount `data-variable-values='{"name":"…"}'`.
- 27 blocks use the root id `main`. If your root is also `main`, rename the block's composition id in its file and in the mount.
- Replace any jsDelivr GSAP `<script>` in an installed block with `vendor/gsap.min.js` for offline renders.
- Useful for reels: `instagram-follow`, `tiktok-follow`, `yt-lower-third`, `lt-clean-bar`, `lt-soft-pill`, `lt-dark-card`, `headline-slam`, `per-word-rise`, `titlecard-lockup`, `count-up`, `mk-progress-stat`, `chart-story`, `cta-lockup`, `cta-close`, `grain-overlay`, `vignette`, `whip-pan-cut`. Most are designed 1920×1080. Check `--json` `dimensions` and prefer portrait ones for 9:16, or scale them in a wrapper.

**Gate:** `npx hyperframes lint` → 0 errors; snapshot each overlay at its midpoint.

---

## Phase 7 — Captions

Pick one path:

| Situation | Path |
|---|---|
| Any language, incl. **Hebrew/Arabic/mixed**, edited footage (default for reels) | **A: `build-captions.mjs`** (Appendix), word-timed karaoke highlight, RTL-safe |
| English, built-from-scratch motion video | B: registry `caption-*` components (`caption-highlight`, `caption-pill-karaoke`, `caption-kinetic-slam`, `caption-clip-wipe`). Their timings live in an inline `WORDS` array you must fill |
| English single-speaker talking head, untouched footage, cinematic styles | C: the official `/embedded-captions` skill (WhisperX, matte, 35 styles) |

The official caption paths (B, C) are Latin-only today: no `dir` handling, Latin font subsets, left-to-right highlight sweeps. Use A for Hebrew.

### Path A

1. **Font with Hebrew glyphs.** Fontsource packages on npm work offline and deterministically (Heebo, Rubik, Assistant, Noto Sans Hebrew, Frank Ruhl Libre):
   ```bash
   npm pack @fontsource/heebo --silent && mkdir -p _f && tar -xzf fontsource-heebo-*.tgz -C _f
   cp _f/package/files/heebo-{hebrew,latin}-800-normal.woff2 assets/fonts/ && rm -rf _f fontsource-heebo-*.tgz
   cat > assets/fonts/heebo-800.css <<'EOF'
   @font-face { font-family: "Heebo"; font-style: normal; font-weight: 800; font-display: block;
     src: url("assets/fonts/heebo-hebrew-800-normal.woff2") format("woff2");
     unicode-range: U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F; }
   @font-face { font-family: "Heebo"; font-style: normal; font-weight: 800; font-display: block;
     src: url("assets/fonts/heebo-latin-800-normal.woff2") format("woff2");
     unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2212, U+FEFF, U+FFFD; }
   EOF
   ```
   Paste the same CSS into `index.html`'s `<style>` if titles use the font. Paths are project-root-relative.
2. **Build the caption sub-composition.** Pass the same `segments.json` used for the cut so source-time words are re-timed onto the edit (words inside removed ranges are dropped):
   ```bash
   node .edit/build-captions.mjs --words work/transcript.json --map work/segments.json \
     --out compositions/captions.html --width 1080 --height 1920 --duration <root duration> \
     --font Heebo --font-css assets/fonts/heebo-800.css --size 84 --bottom 600 \
     --max-words 3 --max-chars 16 --accent "#ffd60a"
   ```
   If you baked the cut (4.3 alternative), re-transcribe the cut file and omit `--map`.
3. **Mount it** above everything:
   ```html
   <div id="captions-host" data-composition-id="captions" data-composition-src="compositions/captions.html"
        data-start="0" data-duration="<root duration>" data-track-index="5" data-track-kind="captions"
        style="position:absolute;inset:0;z-index:50"></div>
   ```

How it stays correct for Hebrew: every caption line gets `dir="auto"` plus `unicode-bidi: plaintext`, so a Hebrew line runs right-to-left, an English line left-to-right, and the browser orders a mixed line ("היום נדבר על Claude Code"). Words are plain inline spans and the highlight is a color change only. **Don't** add `display:inline-block`, per-word transforms or left-anchored sweeps on Hebrew words: inline-block words become bidi-neutral and reverse the order of embedded English phrases. Animate the whole line (as the script does) instead.

Style knobs: `--size`, `--bottom`, `--color`, `--accent`, `--stroke`, `--max-words`, `--max-chars`, `--gap` (break on a pause longer than this), `--min-hold` (minimum on-screen time). For a different look, edit the generated CSS. The timing logic is in the inline `CAPTION_GROUPS` array.

**Fixing caption text**: correct `work/transcript.json` and re-run the builder (it overwrites the file). Don't hand-edit words inside `compositions/captions.html` unless it's the final pass.

**Gate:** snapshot several caption moments, including a mixed-language line, and confirm word order, highlight order (right to left for Hebrew), glyphs (no tofu or fallback font), and that lines clear the UI zones.

---

## Phase 8 — Audio

### 8.1 Layers

- **Dialogue** rides on the A-roll `<video data-has-audio="true">` clips, so it is cut with the picture, with 30 ms splice fades.
- **Music**: one `<audio id="music" src="assets/music.mp3" data-start="0" data-duration="<D>" data-fade-in="0.5" data-fade-out="1.5" data-track-index="10">`. Name it `music`/`bgm`; the tools detect it by name. `data-media-start` picks where in the song the edit starts.
- **SFX**: one `<audio id="sfx-…">` per hit, `data-start` on the visual event (whoosh on a transition, pop on a title). Offline library: `$HF_REPO/skills/media-use/audio/assets/sfx/` (19 files, Pixabay licence: whoosh, whoosh-short, whoosh-cinematic, pop, click, click-soft, chime, ping, impact-bass-1/2, riser (10.03 s; start it at climax − 10.03), glitch-1..3, sparkle, notification, typing, key-press, error). Copy what you use into `assets/sfx/`.
- Level: `data-volume` (linear: 1 = 0 dB, 0.5 ≈ −6 dB, max 3.98 = +12 dB). **A `volume` lane in `data-automation` replaces `data-volume` entirely** (lane values are absolute gains). Once a track has a lane, change its loudness by editing the lane. Edge fades `data-fade-in`/`data-fade-out` (seconds) still multiply on top.

### 8.2 Ducking music under speech (one owner per track)

**Default: duck lane from the transcript** (`duck-lane.mjs`, Appendix). It works with segment-clip edits because it uses the same `segments.json` map as the captions:

```bash
node .edit/duck-lane.mjs --words work/transcript.json --map work/segments.json \
  --duration <root duration> --music-start 0 --level 0.8 --duck 0.22
# prints the attribute value; paste it as  data-automation="…"  on <audio id="music">
```

`--level` is the music gain with no speech, `--duck` the gain under speech (0.22 vs 0.8 ≈ −11 dB; verified by render), with `--attack`/`--release` ramps (0.15/0.4 s). Speech gaps shorter than `--merge` (0.8 s) stay ducked. Re-run it after every re-cut.

**Carve (spectral EQ notches plus level), only when the voice is one untrimmed clip**: a voiceover `<audio>`, a baked cut (4.3 alternative), or a single untouched talking-head clip. `carve.mjs` decodes each voice's *whole source file* at its `data-start` and ignores `data-media-start`/`data-duration`, so on segment clips it carves against the wrong audio. When the voice is a single clip:

```bash
npm i -D @hyperframes/core      # same version as the CLI
node "$HF_REPO/skills/hyperframes-audio/scripts/carve.mjs" --comp index.html --bed music --voice vo --dry-run
node "$HF_REPO/skills/hyperframes-audio/scripts/carve.mjs" --comp index.html --bed music --voice vo [--strength 0.8]
```

Always name `--bed` and `--voice`: auto-detect falls back to every overlapping `<video>`, including muted B-roll, and aborts on a file with no audio stream. It writes `data-fx-carve`, `data-fx-chain` and `data-automation` onto the bed and re-running replaces only its own nodes. The CLI default strength is 0.8 (Studio's is 0.25); if the bed sounds hollow, lower it. For several voiceover clips, give each `data-audio-group="vo"`, declare `<hf-audio-group id="vo" data-label="Voiceover"></hf-audio-group>` (plus CSS `hf-audio-group{display:none!important}`), and pass the clips with `--voice`; the script writes the group as the carve source.

Hand-written lanes: `t` is seconds from the clip's own start; write JSON attributes double-quoted with `&quot;`; hold the first and last values explicitly. Use either a lane or a GSAP tween on volume, never both.

### 8.3 Voice polish and loudness

- Voice FX: `data-fx-chain` takes JSON `{"version":1,"nodes":[…]}` on a clip, group or the root (master). Presets such as `voice-clean` (highpass → de-mud → compressor → presence → limiter), `voice-broadcast`, `rumble-cut` and `room-gate` are expanded into nodes, which is what Studio's Audio panel writes. A bare `data-fx-chain="voice-clean"` is invalid, and **an unparseable chain fails the whole render mix**. Syntax and node types: `$HF_REPO/docs/reference/audio-effects.mdx`. Prefer applying presets in Studio and keeping the result.
- Match levels: `npx hyperframes normalize-audio --target music --lufs=-16` (dry run; add `--write`), or `--reference <voiceId> --target music` to match one track to another. It changes only `data-volume`, which a volume lane overrides.
- Measure the render: `npx hyperframes audio renders/out.mp4 --only loudness --json` → `lufsIntegrated`, `truePeakDb`. Social target ≈ −14 LUFS integrated, true peak ≤ −1 dBTP (the mixer limits to −1 dBTP). Adjust levels or lanes and re-render.
- Voiceover from text: `npx hyperframes tts "…" -o assets/vo.wav --voice af_heart` is English/European/Asian Kokoro voices only, **no Hebrew**. Hebrew narration needs a cloud TTS (HeyGen/ElevenLabs) with a voice you've listened to, or a recorded take.

### 8.4 Music sync

- Beats: `npx hyperframes beats --json` finds the music element and writes `beats/<audio path>.json` (`{beats:[{time,strength}]}`, plus `bpm` in the JSON output). `npx hyperframes audio assets/music.mp3 --only beats,downbeats,bpm,sections --json` gives sections and downbeats (downbeats are low confidence).
- **Beat times are seconds in the audio file**, not composition time: `comp time = beat + music data-start − music data-media-start`.
- **Edit-first** (talking head): keep speech cuts where they are; snap B-roll entries, title hits and SFX to the nearest beat in comp time (about one frame early reads as on-beat). Choose the music's `data-media-start` so a strong section lands on the hook.
- **Music-first** (montage): generate shots that cut on every Nth beat with `beat-montage.mjs` (Appendix). Put the file→comp shift and the one-frame lead into `--offset`:
  ```bash
  # music data-start=0, data-media-start=12 → offset = 0 − 12 − 0.033
  node .edit/beat-montage.mjs --beats beats/assets/music.mp3.json --clips work/clips.json \
    --every 2 --from 0 --to 15 --offset=-12.033 > work/montage.html
  ```
  `work/clips.json` = `[{"src":"assets/broll-1.mp4","in":2.0},{"src":"assets/photo.jpg"}]`, reused round-robin. Faster sections can use `--every 1`; calm sections `--every 4`.

**Gate:** listen to the draft render end to end (dialogue intelligible over music, no clicks at cuts, no double audio), and check loudness numbers.

---

## Phase 9 — Transitions

- **Default to hard cuts** for talking heads. Make seams interesting with punch-ins (Phase 5), B-roll, and a whoosh on a hard cut.
- **Crossfade / dip**: overlap clips, then tween the incoming wrapper's opacity 0→1 over 0.3–0.5 s (both visible during the window; never fade the outgoing one out first).
- **Whip / push / zoom-through / blur** between shots: tween the wrappers at the same time `T`, the outgoing `x`/`yPercent`/`scale`/`filter: blur()` out and the incoming one in, with `.in` easing out and `.out` easing in. Recipes: `$HF_REPO/skills/hyperframes-animation/transitions/css-*.md` (32 named patterns). The registry `whip-pan-cut` component wraps two scenes in one seam.
- **Shader transitions** (`@hyperframes/shader-transitions`: `whip-pan`, `cinematic-zoom`, `glitch`, `light-leak`, `domain-warp`, `chromatic-split`, `flash-through-white`, …) are built for scene-based graphic videos. `HyperShader.init({bgColor, scenes:[ids with class "scene"], transitions:[{time, shader, duration}]})` needs `scenes.length === transitions.length + 1` and matching scene backgrounds. Use runtime names, not catalog block names (`domain-warp`, not `domain-warp-dissolve`). The package has no `<video>` handling, so test any scene with footage before relying on it.
- Durations: calm 0.5–0.8 s, medium 0.3–0.5 s, energetic 0.15–0.3 s. One primary transition for most seams plus one or two accents; at most two shader styles per video.

**Gate:** `npx hyperframes check --at-transitions` clean; snapshot each seam at its midpoint.

---

## Phase 10 — Colour and look

Use the CLI rather than hand-writing grades. It validates and merges:

```bash
npx hyperframes media-treatment --capabilities --json                       # what's available
npx hyperframes media-treatment --selector '#seg-1' --analyze --json        # measure before grading
npx hyperframes media-treatment --selector 'video' --grading '{"preset":"warm-daylight","intensity":0.6}' --dry-run --json
npx hyperframes media-treatment --selector 'video' --grading '{"preset":"warm-daylight","intensity":0.6}' --apply --json
npx hyperframes media-treatment --selector '#seg-1' --clear
npx hyperframes grade-compare --for frame.png --grades grades.json          # labelled sheet; grades.json = [{"label":"warm","grading":{…}}, …]
```

- A selector that matches several media elements patches each one. Grade the A-roll as one look so cuts match.
- Presets: `neutral, warm-daylight, clean-studio, skin-soft, food-pop, night-lift, muted-editorial, vintage-wash, mono-clean, mono-fade, soft-boost, bright-pop, deep-contrast, creator-camcorder, vhs-playback, home-movie-8mm, editorial-halftone, two-ink-print`.
- Payload sections (keys must sit inside them): `adjust` (exposure −2..2; contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation −1..1), `wheels`, `curves`, `hueCurves`, `secondaries`, `details` (grain, vignette), `effects` (bloom, blur, …), `lut: {src, intensity}` (.cube ≤64³, same-origin path).
- `data-color-grading` goes on the `<video>`/`<img>` itself, never on a wrapper. It's whole-frame (no masks) and SDR only.
- Animate a grade with CSS variables. Set the starting value inline on the element first (`style="--hf-color-grading-intensity:1"`), then `tl.fromTo("#seg-1", {"--hf-color-grading-intensity": 1}, {"--hf-color-grading-intensity": 0, duration: 1}, 10)`. `intensity` doesn't ramp grain, bloom or other texture effects.

**Gate:** grade-compare or snapshots approved; skin tones natural; cuts between graded clips don't jump.

---

## Phase 11 — QA (always, after any change)

```bash
npx hyperframes lint                          # static; exit 1 on errors; --json for parsing
npx hyperframes check                         # lint + runtime + layout + motion + WCAG contrast in Chrome
npx hyperframes check --snapshots             # also saves audited frames + crops of findings
npx hyperframes snapshot --at 0.5,3.2,7.9,15 --no-end -o .edit/snaps   # exact moments + contact-sheet.jpg; -o dir is wiped each run unless --keep
npx hyperframes preview --background          # Studio at http://localhost:3002 (agent-safe); --status / --stop
npx hyperframes render -q draft -o renders/draft.mp4
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -show_entries format=duration -of compact renders/draft.mp4
```

Then **look at the frames**: read the contact sheet and spot-check stills at every cut, every caption change, every overlay entrance and the last second. Passing gates is necessary, not sufficient.

Checklist:
- [ ] Duration equals root `data-duration`; no black or frozen frames at cuts (`media-start` past source end holds the last frame).
- [ ] Hook visible and legible by ~0.5 s; text clear of UI zones; contrast passes.
- [ ] Captions match speech word-for-word, read in the right direction, never cover faces.
- [ ] Dialogue clean at every splice; music ducked; no echo (`video_audio_double_source`); loudness ≈ −14 LUFS.
- [ ] Every overlay's placeholder content replaced.
- [ ] `check` passes (warnings reviewed, intentional ones waived with `data-layout-allow-*`).

Preview in Studio: the user can scrub, trim and move clips, and the edits write back to the same `index.html`. If they made changes there, re-read the file before your next edit. Studio refuses agent writes while an external change is pending. `npx hyperframes preview --selection --json` returns what they've selected.

---

## Phase 12 — Render and deliver

Render only after the user approves the preview or draft. By default `render` is best-effort: missing or unready media still renders, with warnings only. Finals use `--strict --no-best-effort`.

```bash
npx hyperframes render -q delivery --strict --no-best-effort -o renders/<name>-9x16.mp4   # final: fail on lint errors or missing/unready media
npx hyperframes render -q delivery --sdr -o renders/<name>.mp4          # force SDR when sources are iPhone HDR
npx hyperframes render --format mov -o renders/overlay.mov             # ProRes 4444 with alpha (transparent)
npx hyperframes render --format webm -o renders/overlay.webm           # VP9 with alpha
npx hyperframes render --resolution portrait-4k -o renders/<name>-4k.mp4   # supersample a 1080x1920 comp to 2160x3840
```

| Quality | Encoder | Use |
|---|---|---|
| `draft` | x264 ultrafast, CRF 28 | iteration |
| `looks` (default) | standard, CRF 16 | first real look |
| `delivery` (= `high`) | slow, CRF 15 | final |

- Other flags: `--fps`, `--crf`/`--video-bitrate` (mutually exclusive), `--workers <n|auto>` (each ~256 MB+; on ≤8 GB RAM use `--workers 1` or `--low-memory-mode`), `--docker` (pinned environment, needs Docker running), `--format gif|png-sequence|hls`.
- No partial or range renders: split long films into sub-compositions and iterate with `draft`.
- **Other aspect ratios** can't be produced by a flag (`--resolution` only scales, same aspect). Copy the project (`cp -r my-reel my-reel-16x9`), change root `data-width/height` plus the `html, body` CSS size and viewport meta (or scaffold a fresh project with `init --resolution landscape` and move the clips over), then re-check framing, `object-position`, captions and overlays.
- Variants from one template: declare `data-composition-variables` on `<html>`, bind with `data-var-text`/`data-var-src`, render with `--variables '{"title":"…"}'` or `--batch rows.json`.
- Cloud (no local Chrome or FFmpeg): `npx hyperframes auth login`, then `npx hyperframes cloud render -o renders/x.mp4 --quality high` (HeyGen credits; zip ≤ 200 MB; `--dry-run` shows the upload). Cloud quality names are `draft|standard|high`. The aspect ratio is detected from the root size; if the log doesn't print "Detected aspect ratio: 9:16", pass `--aspect-ratio 9:16`, otherwise the server defaults to 16:9. Self-hosted: `hyperframes lambda …` / `hyperframes cloudrun …`.
- Verify every deliverable: `test -s file`, ffprobe (dimensions, codec, duration = root duration, audio stream present), loudness, then watch it. Deliver the file path plus actual duration and a contact sheet.
- Captions file for platforms that take one: `npx hyperframes transcribe <final.mp4> --model <…> --language <…> --to srt -o renders/<name>.srt`.

---

## Iterating on feedback

Turn felt notes into one measurable change per pass and say what you changed:

| They say | Change |
|---|---|
| "start the B-roll later" | its `data-start` |
| "end the logo sooner" / "cut that line" | `data-duration` / remove the segment from `segments.json` and regenerate |
| "skip the first second of that shot" | `data-media-start` (media clips only) |
| "it drags here" | cut pauses tighter at that spot (`--cut-silence`), add a punch-in or B-roll |
| "music too loud" | lower `--level`/`--duck` and regenerate the duck lane (a lane overrides `data-volume`) |
| "captions too small / too low" | `--size` / `--bottom`, regenerate |
| "make it pop" | ask which element; then one change (size, accent color, entrance) |

Freeze what already works, re-run Phase 11, and only re-render after approval. Questions get answers, not edits; "hold" means change nothing.

---

## Reference A — attribute cheat sheet

| Attribute | On | Meaning |
|---|---|---|
| `data-composition-id` | root, sub-comp root, host | id; equals timeline key |
| `data-fps` | root | frame rate (default 30) |
| `data-width` / `data-height` | root | canvas px |
| `data-duration` | root, clips, hosts | seconds; root = render length |
| `data-start` | timed elements | seconds or `"id + n"`; makes the element timed |
| `data-media-start` | `<video>`/`<audio>` | source in-point (trim) |
| `data-playback-rate` | media | 0.1–10 constant speed |
| `data-has-audio="true"` / `muted` | `<video>` | keep its sound / silent (exactly one) |
| `data-volume` | media, `hf-audio-group` | linear gain 0–3.98 (ignored when a `volume` lane exists) |
| `data-fade-in` / `data-fade-out` | media | linear edge fades, seconds |
| `data-automation` | media, groups | lanes: `volume`, `rate`, `fx.<node>.<param>` |
| `data-audio-group` / `<hf-audio-group id>` | media / bus | submix (carve sources) |
| `data-fx-chain` | media, groups, root (master) | audio effects JSON `{version,nodes}` |
| `data-fx-carve` | media clips only | carve settings (written by carve.mjs) |
| `data-color-grading` | `<video>`/`<img>` | grade JSON |
| `data-composition-src` | host div | sub-composition file (project-root path) |
| `data-variable-values` | host | per-mount variable values (JSON) |
| `data-track-index` | anything | Studio lane only (not stacking) |
| `data-track-kind="captions"` | caption host | marks the caption lane |
| `data-hidden` | clip/group | hides in preview **and** render |
| `data-no-timeline` | static composition root | skip the 45 s timeline wait |
| `data-layout-allow-overflow` / `-overlap` / `-occlusion` | element | waive a `check` finding (scope narrowly) |

## Reference B — CLI cheat sheet

```
init <name> [--resolution …] [--example blank] [--video f] [--skip-transcribe] [--non-interactive]
doctor | browser ensure | info | upgrade --project . [--check]
transcribe <media|transcript> [-d dir] [--engine whisper] [--model m] [--language xx] [--json] [--to srt|vtt -o f]
audio <files> [--only silence,loudness,beats,bpm,sections,onsets] [--json] [--element '#id'] [--place-at t]
beats [--json] | normalize-audio --target id [--lufs=-16 | --reference id] [--write]
timeline [--json] | timeline split|move|trim|delete|set|duplicate|apply|undo … [--plan] [--json]
history [begin --who x --label y | end | undo --who x | show | restore]
catalog [--query "…"] [--type block|component] [--tag t] [--json] | add <name> [--vars '{…}'] [--force]
media-treatment --selector s (--grading '{…}' --apply | --analyze | --clear | --capabilities) [--dry-run] [--json]
grade-compare --for frame.png (--grades g.json | --luts a.cube,b.cube) | compare dirA dirB --at t
remove-background in.mp4 -o out.webm [--background-output plate.webm]   # people only; output has no audio
tts "text" -o out.wav [--voice v] [--list]
lint [--json] [--verbose] | check [--snapshots] [--at …] [--range a,b] [--at-transitions] [--strict] [--json]
snapshot [--at t1,t2] [--frames n] [--range a,b] [--zoom '#sel'] [--no-end] [-o dir]
preview [--background|--status|--stop] [--port 3002] [--selection --json]
render [-q draft|looks|delivery] [-o f] [--format mp4|webm|mov|gif|png-sequence|hls] [--fps n] [--resolution …]
       [--sdr|--hdr] [--workers n] [--strict] [--docker] [--variables '{…}'] [--batch rows.json]
cloud render | lambda … | cloudrun …
# helpers (Appendix): node .edit/cut-to-clips.mjs | build-captions.mjs | duck-lane.mjs | beat-montage.mjs
```

Exit codes: 0 ok, 1 failure, 2 refused/conflict (`timeline`, `history`). `doctor --json` always exits 0, so read `.ok`.

## Reference C — troubleshooting

| Symptom | Fix |
|---|---|
| Render fails `sub_timeline_script_failure` / GSAP not defined | CDN unreachable; vendor GSAP locally (Phase 2.1) |
| Render waits ~45 s then static frames | timeline key ≠ `data-composition-id`, sub-comp id mismatch, or static comp without `data-no-timeline` |
| Animation fine in preview, missing in render | registered before the async build finished; `fromTo` without `opacity: 1`; `tl.set(…,0)` hide; relative `+=` values |
| Video freezes / wrong frames | tweening the `<video>` box; timed wrapper around timed video; sparse keyframes (re-encode with `-g 30`) |
| Last frame held / black at a cut | `data-media-start` + duration × rate beyond the source end |
| Silent render | `<audio>` without `id`; video without `data-has-audio`; `muted` together with `data-has-audio` (silences preview) |
| Echo | `<audio>` and audible `<video>` on the same file at the same time |
| Clicks at cuts | add `data-fade-in/out="0.03"` at splices |
| Fallback font / tofu boxes | missing `@font-face` or no Hebrew subset; check `unicode-range` and paths |
| Hebrew words in the wrong order | per-word `inline-block`/transforms; use plain inline spans and `dir="auto"` on the line |
| Element jumps off-center | CSS `translate(-50%)` plus GSAP `x`; use `xPercent` |
| HDR/washed colors on social | sources are HDR; render with `--sdr` |
| "Chrome not found" | `npx hyperframes browser ensure` or `HYPERFRAMES_BROWSER_PATH` |
| Out of memory / "Target closed" | `--workers 1`, `--low-memory-mode`, `--protocol-timeout 600000` |
| Black preview, render fine | browser can't decode HEVC/ProRes; keep auto-proxy on (`hyperframes.json` `media.autoProxy`) |
| `Unknown flag: -1` | negative value passed with a space; use `--flag=-1` |
| Music level ignores `data-volume` | the track has a `volume` lane; edit the lane values |
| Render mix fails on an audio error | invalid `data-fx-chain` JSON; fix or remove the chain |
| Snapshots vanished | `snapshot -o dir` clears the dir; use `--keep` or a new dir |

## Reference D — verified gotchas (docs vs code)

- Render default quality is `looks` (CRF 16), not `standard`. Default output path is timestamped under `renders/`.
- `transcribe` without `-d` writes next to the input. Its default model `small.en` is English-only.
- `timeline trim --start` doesn't advance `data-media-start`; `timeline delete` doesn't ripple.
- `add <tag>` installs every item with that tag, components included. Snippets lack `data-start`/`data-track-index`. `wiring-blocks.md` wrongly says track index sets layering.
- The registry has 210 blocks and 237 components (some skill docs say 180). Caption components are Latin-only.
- Carve default strength: CLI 0.8, Studio/docs 0.25. `carve.mjs` decodes each voice's whole file at its `data-start` (ignores `data-media-start`), so it's wrong for segment clips; auto-detect also counts muted B-roll as voices.
- A `volume` lane replaces `data-volume` (verified by render). `beats` times are relative to the audio file, not the composition.
- `<audio loop>` isn't looped by the render mixer (verified: a 2 s looped clip in a 6 s render is silent after 2 s); pre-loop the file. `<video loop>` is handled.
- `normalize-audio` defaults to −16 LUFS (the docs only mention reference mode).
- Shader-transition `init()` rejects catalog block names; easing presets like `snappy`/`luxe` exist only in docs.
- The lint warning `nested_structure_needs_subcomposition` fires on a root-level clip with nested markup. It's a warning; a sub-composition or an untimed element avoids it.
- `check` flags scaled wrappers as `container_overflow`; mark intentional ones `data-layout-allow-overflow`.

---

## Appendix — helper scripts

Write these to `<project>/.edit/` (plain Node ≥ 18, no dependencies). All four were run on test projects with this CLI version: lint clean, `check` passed, rendered and measured.

### `.edit/cut-to-clips.mjs`

```js
#!/usr/bin/env node
// cut-to-clips.mjs — turn a kept-segment list into back-to-back HyperFrames <video> clips.
// Non-destructive: the source file is never re-encoded; each kept range becomes one clip.
//
//   node cut-to-clips.mjs --segments segments.json --src assets/a-roll.mp4 \
//        [--prefix seg] [--start 0] [--fade 0.03] [--muted] [--punch 1.12] \
//        [--fit cover] [--pos "50% 50%"] [--z 1] [--group voice]
//
// segments.json: [{ "start": 1.2, "end": 4.8 }, ...]  (source seconds — the output of
// `transcript-cut.mjs --plan`, or hand-written). Prints an HTML fragment to stdout and a
// summary (clip count, total duration, cut times) to stderr.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    segments: { type: "string" },
    src: { type: "string" },
    prefix: { type: "string", default: "seg" },
    start: { type: "string", default: "0" },
    fade: { type: "string", default: "0.03" },
    muted: { type: "boolean", default: false },
    punch: { type: "string", default: "1" },
    fit: { type: "string", default: "cover" },
    pos: { type: "string", default: "50% 50%" },
    z: { type: "string", default: "1" },
    group: { type: "string" },
  },
});
if (!a.segments || !a.src) {
  console.error("usage: cut-to-clips.mjs --segments segments.json --src assets/a-roll.mp4 [options]");
  process.exit(1);
}
const raw = JSON.parse(readFileSync(a.segments, "utf8"));
const segs = (Array.isArray(raw) ? raw : raw.segments)
  .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
  .filter((s) => s.end - s.start >= 0.05);
const r6 = (n) => Math.round(n * 1e6) / 1e6; // keep sub-frame precision (as transcript-cut does)
const fade = Number(a.fade);
const punch = Number(a.punch);
let t = Number(a.start);
const cuts = [];
const out = segs.map((s, i) => {
  const dur = r6(s.end - s.start);
  const id = `${a.prefix}-${i + 1}`;
  const scale = punch !== 1 && i % 2 === 1 ? punch : 1; // alternate punch-in hides jump cuts
  const audio = a.muted ? "muted" : 'data-has-audio="true"';
  const group = a.group && !a.muted ? ` data-audio-group="${a.group}"` : ""; // lets carve.mjs duck music against the group
  const fades = a.muted || fade <= 0 ? "" : ` data-fade-in="${i > 0 ? fade : 0}" data-fade-out="${i < segs.length - 1 ? fade : 0}"`;
  const html =
    `  <div id="${id}-wrap" class="seg-wrap" style="position:absolute;inset:0;overflow:hidden;z-index:${a.z}">\n` +
    `    <div id="${id}-zoom" data-layout-allow-overflow style="position:absolute;inset:0;transform:scale(${scale});transform-origin:50% 40%">\n` +
    `      <video id="${id}" src="${a.src}" data-start="${r6(t)}" data-duration="${dur}" data-media-start="${r6(s.start)}"` +
    ` data-track-index="0" ${audio}${group}${fades} playsinline\n` +
    `        style="position:absolute;inset:0;width:100%;height:100%;object-fit:${a.fit};object-position:${a.pos}"></video>\n` +
    `    </div>\n  </div>`;
  t += dur;
  if (i < segs.length - 1) cuts.push(r6(t));
  return html;
});
console.log(out.join("\n"));
console.error(
  JSON.stringify({ clips: segs.length, end: r6(t), duration: r6(t - Number(a.start)), cuts }, null, 0),
);
```

### `.edit/build-captions.mjs`

```js
#!/usr/bin/env node
// build-captions.mjs — word-timed captions as a HyperFrames sub-composition, Hebrew/RTL-safe.
//
//   node build-captions.mjs --words words.json --out compositions/captions.html \
//        --width 1080 --height 1920 --duration 30 [--map segments.json] \
//        [--max-words 3] [--max-chars 16] [--gap 0.5] [--min-hold 0.5] \
//        [--font "Heebo"] [--font-css assets/fonts/heebo-800.css] [--size 84] \
//        [--bottom 560] [--color "#ffffff"] [--accent "#ffd60a"] [--stroke 8] [--gsap vendor/gsap.min.js]
//
// words.json: [{text,start,end}] or {words:[...]} (hyperframes transcribe output works as-is).
// --map: the kept-segment list used for the cut. Word times are SOURCE times; with --map they are
//   re-timed onto the edited timeline and words inside removed ranges are dropped.
// Each caption group gets dir="auto", so Hebrew lines run right-to-left and English lines
// left-to-right, and a mixed line is ordered by the browser's bidi algorithm. Words are plain
// inline spans (never inline-block/transform), which is what keeps mixed Hebrew+English order right.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    words: { type: "string" }, out: { type: "string" }, map: { type: "string" },
    width: { type: "string", default: "1080" }, height: { type: "string", default: "1920" },
    duration: { type: "string" }, id: { type: "string", default: "captions" },
    "max-words": { type: "string", default: "3" }, "max-chars": { type: "string", default: "16" },
    gap: { type: "string", default: "0.5" }, "min-hold": { type: "string", default: "0.5" },
    font: { type: "string", default: "Heebo" }, "font-css": { type: "string" },
    "font-weight": { type: "string", default: "800" }, size: { type: "string", default: "84" },
    bottom: { type: "string", default: "560" }, color: { type: "string", default: "#ffffff" },
    accent: { type: "string", default: "#ffd60a" }, stroke: { type: "string", default: "8" },
    gsap: { type: "string", default: "vendor/gsap.min.js" },
  },
});
if (!a.words || !a.out || !a.duration) {
  console.error("usage: build-captions.mjs --words words.json --out compositions/captions.html --duration <sec> [options]");
  process.exit(1);
}
const r3 = (n) => Math.round(n * 1000) / 1000;
const raw = JSON.parse(readFileSync(a.words, "utf8"));
let words = (Array.isArray(raw) ? raw : raw.words)
  .filter((w) => (w.type ?? "word") === "word" && String(w.text).trim())
  .map((w) => ({ text: String(w.text).trim(), start: Number(w.start), end: Number(w.end) }));

if (a.map) {
  // source time -> edited time, using the same kept segments the cut used
  const segs = JSON.parse(readFileSync(a.map, "utf8"));
  let acc = 0;
  const table = segs.map((s) => { const row = { ...s, offset: acc - s.start }; acc += s.end - s.start; return row; });
  words = words.flatMap((w) => {
    const mid = (w.start + w.end) / 2;
    const seg = table.find((s) => mid >= s.start && mid < s.end);
    if (!seg) return []; // word was cut
    return [{ ...w, start: r3(Math.max(seg.start, w.start) + seg.offset), end: r3(Math.min(seg.end, w.end) + seg.offset) }];
  });
}
words.sort((x, y) => x.start - y.start); // segments may be reordered: group in edited-timeline order

// group words into short caption lines
const maxW = Number(a["max-words"]), maxC = Number(a["max-chars"]), gap = Number(a.gap);
const groups = [];
for (const w of words) {
  const g = groups.at(-1);
  const chars = g ? g.words.map((x) => x.text).join(" ").length + 1 + w.text.length : 0;
  const breakHere = !g || g.words.length >= maxW || chars > maxC || w.start - g.words.at(-1).end > gap ||
    /[.!?…]$/.test(g.words.at(-1).text);
  if (breakHere) groups.push({ words: [w] }); else g.words.push(w);
}
const total = Number(a.duration), minHold = Number(a["min-hold"]);
groups.forEach((g, i) => {
  g.in = g.words[0].start;
  const next = groups[i + 1]?.words[0].start ?? total;
  g.out = Math.min(next, Math.max(g.words.at(-1).end + 0.15, g.in + minHold));
});

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const id = a.id;
// @font-face rules (url() paths relative to the project root), inlined so the sub-composition is self-contained
const fontFace = a["font-css"] ? readFileSync(a["font-css"], "utf8").trim() + "\n      " : "";
const groupsHtml = groups
  .map((g, i) => `      <div id="${id}-g${i}" class="cap-group" dir="auto">${g.words.map((w, j) => `<span id="${id}-g${i}w${j}" class="cap-word">${esc(w.text)}</span>`).join(" ")}</div>`)
  .join("\n");
const data = JSON.stringify(groups.map((g) => ({ in: r3(g.in), out: r3(g.out), w: g.words.map((w) => r3(w.start)) })));

const html = `<template id="${id}-template">
  <div id="${id}-root" data-composition-id="${id}" data-width="${a.width}" data-height="${a.height}" data-duration="${total}">
    <style>
      ${fontFace}[data-composition-id="${id}"] .cap-group {
        position: absolute; left: 60px; right: 60px; bottom: ${a.bottom}px;
        text-align: center; font-family: "${a.font}", sans-serif; font-weight: ${a["font-weight"]};
        font-size: ${a.size}px; line-height: 1.15; color: ${a.color};
        -webkit-text-stroke: ${a.stroke}px #000; paint-order: stroke fill;
        opacity: 0; visibility: hidden; unicode-bidi: plaintext;
      }
      [data-composition-id="${id}"] .cap-word { color: ${a.color}; }
    </style>
${groupsHtml}
    <script src="${a.gsap}"></script>
    <script>
      (function () {
        var CAPTION_GROUPS = ${data};
        var tl = gsap.timeline({ paused: true });
        CAPTION_GROUPS.forEach(function (g, i) {
          var el = "#${id}-g" + i;
          tl.fromTo(el, { opacity: 0, visibility: "hidden", y: 24 },
            { opacity: 1, visibility: "visible", y: 0, duration: 0.12, ease: "power2.out" }, g.in);
          g.w.forEach(function (t, j) {
            tl.set("#${id}-g" + i + "w" + j, { color: "${a.accent}" }, t);
          });
          tl.set(el, { opacity: 0, visibility: "hidden" }, g.out);
        });
        window.__timelines["${id}"] = tl;
      })();
    </script>
  </div>
</template>
`;
mkdirSync(dirname(a.out), { recursive: true });
writeFileSync(a.out, html);
console.error(JSON.stringify({ groups: groups.length, words: words.length, out: a.out }));
```

### `.edit/duck-lane.mjs`

```js
#!/usr/bin/env node
// duck-lane.mjs — a music `volume` lane that dips under speech, built from word timings.
// Works with segment-clip edits (where carve.mjs can't: it ignores data-media-start).
//
//   node duck-lane.mjs --words work/transcript.json [--map work/segments.json] \
//        --duration 34.2 [--music-start 0] [--level 0.8] [--duck 0.22] \
//        [--attack 0.15] [--release 0.4] [--merge 0.8] [--json]
//
// Lane values are ABSOLUTE gains (a lane replaces data-volume): --level = music with no speech,
// --duck = music under speech (0.22 ≈ -13 dB relative to 1.0). --map re-times source-time words
// onto the edit exactly like build-captions.mjs. --music-start = the music <audio>'s data-start
// (lane t is clip-local). Prints the data-automation attribute value, HTML-escaped and ready to
// paste as data-automation="…" (or raw JSON with --json).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    words: { type: "string" }, map: { type: "string" }, duration: { type: "string" },
    "music-start": { type: "string", default: "0" }, level: { type: "string", default: "0.8" },
    duck: { type: "string", default: "0.22" }, attack: { type: "string", default: "0.15" },
    release: { type: "string", default: "0.4" }, merge: { type: "string", default: "0.8" },
    json: { type: "boolean", default: false },
  },
});
if (!a.words || !a.duration) {
  console.error("usage: duck-lane.mjs --words transcript.json [--map segments.json] --duration <sec> [options]");
  process.exit(1);
}
const r3 = (n) => Math.round(n * 1000) / 1000;
const raw = JSON.parse(readFileSync(a.words, "utf8"));
let words = (Array.isArray(raw) ? raw : raw.words)
  .filter((w) => (w.type ?? "word") === "word" && String(w.text).trim())
  .map((w) => ({ start: Number(w.start), end: Number(w.end) }));
if (a.map) {
  const segs = JSON.parse(readFileSync(a.map, "utf8"));
  let acc = 0;
  const table = segs.map((s) => { const row = { ...s, offset: acc - s.start }; acc += s.end - s.start; return row; });
  words = words.flatMap((w) => {
    const mid = (w.start + w.end) / 2;
    const seg = table.find((s) => mid >= s.start && mid < s.end);
    return seg ? [{ start: Math.max(seg.start, w.start) + seg.offset, end: Math.min(seg.end, w.end) + seg.offset }] : [];
  });
}
words.sort((x, y) => x.start - y.start);
const D = Number(a.duration), m0 = Number(a["music-start"]);
const level = Number(a.level), duck = Number(a.duck), att = Number(a.attack), rel = Number(a.release);
let merge = Number(a.merge);
const build = () => {
  const spans = [];
  for (const w of words) {
    const last = spans.at(-1);
    if (last && w.start - last.end <= merge) last.end = Math.max(last.end, w.end);
    else spans.push({ start: w.start, end: w.end });
  }
  // lane points in clip-local time (t = composition time - music data-start)
  const pts = [];
  const end = r3(D - m0);
  const add = (t, v, skipIfBehind = false) => {
    const lt = r3(Math.max(t - m0, 0));
    if (lt > end) return; // past the end of the music clip
    if (pts.length && lt <= pts.at(-1).t) { if (!skipIfBehind) pts.at(-1).v = v; return; }
    pts.push({ t: lt, v });
  };
  const inSpeech = spans.some((s) => s.start - att <= m0 && m0 < s.end + rel);
  add(m0, inSpeech ? duck : level);
  for (const s of spans) {
    add(s.start - att, level, true); // start of the dip (skipped if already ducking)
    add(s.start, duck);
    add(s.end, duck);
    add(s.end + rel, level);
  }
  if (pts.at(-1).t < end) pts.push({ t: end, v: pts.at(-1).v }); // hold to the end
  return pts;
};
let pts = build();
while (pts.length > 512) { merge *= 1.5; pts = build(); } // lanes cap at 512 points
const lane = { version: 1, lanes: [{ target: "volume", points: pts }] };
const json = JSON.stringify(lane);
console.log(a.json ? json : json.replace(/"/g, "&quot;"));
console.error(JSON.stringify({ points: pts.length, merge }));
```

### `.edit/beat-montage.mjs`

```js
#!/usr/bin/env node
// beat-montage.mjs — music-first cutting: lay clips back-to-back with every cut on a beat.
//
//   node beat-montage.mjs --beats beats/assets/music.mp3.json --clips clips.json \
//        [--every 2] [--from 0] [--to 15] [--offset=-0.033] [--min-strength 0] [--prefix bm] [--z 1]
//
// beats file: output of `npx hyperframes beats` ({beats:[{time,strength}]}) or a plain [sec,...] array.
// clips.json: [{ "src": "assets/broll-1.mp4", "in": 2.0 }, { "src": "assets/photo.jpg" }, ...]
//   video -> muted <video> with data-media-start=in; image -> <img>. Clips are reused round-robin.
// --every N: beats per shot (2 = cut every second beat). --offset shifts every cut (e.g. -0.033 to land
// a frame early, which reads as "on the beat"; pass negatives with "="). Times are composition seconds;
// --from is where the montage starts on the timeline and --to where it must end.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    beats: { type: "string" }, clips: { type: "string" },
    every: { type: "string", default: "2" }, from: { type: "string", default: "0" },
    to: { type: "string" }, offset: { type: "string", default: "0" },
    "min-strength": { type: "string", default: "0" }, prefix: { type: "string", default: "bm" },
    z: { type: "string", default: "1" }, fit: { type: "string", default: "cover" },
  },
});
if (!a.beats || !a.clips) {
  console.error("usage: beat-montage.mjs --beats beats.json --clips clips.json [--every 2] [--from 0] [--to 15]");
  process.exit(1);
}
const r3 = (n) => Math.round(n * 1000) / 1000;
const rawBeats = JSON.parse(readFileSync(a.beats, "utf8"));
const minS = Number(a["min-strength"]);
const beats = (Array.isArray(rawBeats) ? rawBeats : rawBeats.beats)
  .map((b) => (typeof b === "number" ? { time: b, strength: 1 } : b))
  .filter((b) => (b.strength ?? 1) >= minS)
  .map((b) => b.time + Number(a.offset));
const from = Number(a.from), to = a.to != null ? Number(a.to) : beats.at(-1);
const every = Math.max(1, Number(a.every));
// cut points: montage start, then every Nth beat strictly inside (from, to), then the end
const inner = beats.filter((t) => t > from + 0.2 && t < to - 0.2).filter((_, i) => (i + 1) % every === 0);
const marks = [from, ...inner, to];
const clips = JSON.parse(readFileSync(a.clips, "utf8"));
const isImg = (s) => /\.(jpe?g|png|webp|avif|gif|svg)$/i.test(s);
const style = `position:absolute;inset:0;width:100%;height:100%;object-fit:${a.fit};z-index:${a.z}`;
const html = [];
for (let i = 0; i < marks.length - 1; i++) {
  const c = clips[i % clips.length];
  const start = r3(marks[i]), dur = r3(marks[i + 1] - marks[i]);
  const id = `${a.prefix}-${i + 1}`;
  html.push(isImg(c.src)
    ? `  <img id="${id}" class="clip" src="${c.src}" data-start="${start}" data-duration="${dur}" data-track-index="1" style="${style}" />`
    : `  <video id="${id}" src="${c.src}" data-start="${start}" data-duration="${dur}" data-media-start="${r3(c.in ?? 0)}" data-track-index="1" muted playsinline style="${style}"></video>`);
}
console.log(html.join("\n"));
console.error(JSON.stringify({ shots: marks.length - 1, cuts: inner.map(r3), from, to }));
```