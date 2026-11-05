---
name: "video-use"
description: "Edit raw footage with browser-use/video-use (Scribe transcripts, cuts, grade, mix, self-eval) plus HyperFrames for graphics and RTL captions; decides on judgment and never stops to ask. Use for any 'edit this video' request."
---

# video-use (bootstrap + operating mode + HyperFrames graphics + field notes)

This skill installs the open-source editor https://github.com/browser-use/video-use and uses its own SKILL.md for the editing method, with two changes: it runs start to finish on judgment without asking questions (§0), and it builds graphics with HyperFrames (§3). Where this file and the upstream SKILL.md disagree, this file wins.

## 0. Operating mode: judgment, not questions

Upstream is built around ask → confirm → execute. Here it runs straight through.

- **No questions.** Don't call AskUserQuestion and don't end a turn on a question. Wherever upstream says ask, propose and wait, confirm, or let the user choose (process steps 3–4, Hard Rule 11, the palette, the music bed, the delivery format, "continue the last session?", "final render on confirmation"), decide with the defaults below and record the decision.
- **Hard Rule 11 becomes "plan before cutting".** Write the strategy (4–8 sentences, as in upstream step 4) to `<edit>/project.md` before touching the cut, opening with an `Assumptions:` line for anything you had to guess. Then execute. Hard Rules 1–10 and 12 still hold.
- **Read before deciding:** the user's message; `<edit>/project.md` (carry earlier sessions' canvas, fonts, palette and caption look forward unless told otherwise); any brief, notes, brand files or reference videos in the footage folder; and the footage itself (packed transcript plus `timeline_view` at decision points).
- **Ambiguity → the most likely reading**, stated once in the hand-off. Vague feedback ("make it pop") → pick the most likely element, change one thing, say which.
- **Stop only for a real blocker, and report it rather than ask:** no footage reachable, no transcription path when the edit depends on speech (§2), every source unreadable. First finish everything that doesn't depend on it (probe, inventory, contact sheet), then say in one or two lines what is missing and what it unblocks.
- **Nothing irreversible:** sources are read-only, outputs go to `edit/`, and an earlier final is never overwritten (write `final_v2.mp4`).
- **Quote every path.** `<edit>`, the footage folder and every path under them can contain spaces and Hebrew (client and job names). In Bash, put each path and each variable that holds one inside double quotes (`"$SH/vendor"`, never `$SH/vendor`), as every snippet below does, and never `cd` into or write to a folder above `<edit>/`: a stray folder in the client folder or the inbox is picked up as a new job.
- **Deliver finished work.** After self-eval passes, plus the critic pass for anything that will be posted (reels, promos, ads), render the final, not just a preview. The hand-off is the file, its actual duration, aspect and loudness, the assumptions made, and anything left undone.

### Defaults when nothing says otherwise

| Decision | Default |
|---|---|
| Canvas | Vertical source, or "reel / short / TikTok / story" → 1080×1920. Otherwise match the source aspect. Square or 4:5 only when asked. Changing aspect needs Mode B (§3.1). |
| Length | Reels 20–45 s: keep the best, not everything. Long-form: tighten pauses and retakes, keep every point. Montage: the music's length, or ~30 s. |
| fps | Match the source. |
| Language | Detected from speech; captions in the spoken language. Hebrew → `--language he`. |
| Captions | On for anything with speech headed to social; off for a wordless montage. 2–3 words a line, active-word highlight. Hebrew, Arabic or mixed lines → HyperFrames captions (§3.4). |
| Hook | Open on the strongest line, with no title card in front of it. |
| Grade | `none`, unless frames show a real problem (underexposure, colour cast, flat log) → a corrective grade only, checked on skin. |
| Music | Only files the user supplied (footage folder or chat). Never download or generate music unasked; with no music file, ship without and say so. Several files → pick the one that fits the pacing and note the other. Duck under speech. |
| SFX | Only when tied to a visible event; skip without a library. |
| Graphics | §3.1, restraint first. |
| Look | Brand files or `project.md` first. Otherwise one accent (sampled from the footage, or `#FFD60A`), white text with a soft shadow, Heebo 800 for Hebrew/mixed or Inter for English-only. Record it in `project.md` as the house style. |
| Deliverables | `final.mp4` (H.264, yuv420p, AAC, −14 LUFS / −1 dBTP) plus `final.srt` when captions are burned in. |

## 1. Install (once per session)

```bash
test -d ~/Developer/video-use || git clone --depth 1 https://github.com/browser-use/video-use ~/Developer/video-use
cd ~/Developer/video-use && (uv sync || pip install -e .)
mkdir -p ~/.claude/skills && ln -sfn ~/Developer/video-use ~/.claude/skills/video-use
~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/timeline_view.py --help >/dev/null && ffprobe -version | head -1
```

Then **read `~/Developer/video-use/SKILL.md` in full** and follow it as amended by §0 and §3. Helpers live in `~/Developer/video-use/helpers/`. Run them with the repo's `.venv/bin/python`. Set up HyperFrames (§3.2) as soon as the plan includes a graphic.

## 2. ElevenLabs key + network

- Transcription needs `ELEVENLABS_API_KEY`, from the environment or `~/Developer/video-use/.env`. If neither has it and the edit depends on speech, that is a §0 blocker: do the inventory, then say the key is needed (pasted in chat, or put in that `.env`). When the user pastes one, write it with `chmod 600`. Never echo the key, and never write it into the footage folder. An edit without speech (a music montage) goes ahead untranscribed.
- The cloud workspace blocks `api.elevenlabs.io` unless the user adds it under claude.ai Settings → Capabilities → allowed domains. Test with `curl -s -o /dev/null -w '%{http_code}' https://api.elevenlabs.io/v1/models`. `000` means blocked: report it as a blocker and name the domain to allow. `401 missing_permissions` on /v1/user or /v1/models is fine for a scoped key: speech-to-text still works.
- Hugging Face and the OpenAI model CDNs are blocked too, so there is no offline Whisper fallback (HyperFrames' own `transcribe` downloads its models from Hugging Face as well). Don't hunt for model mirrors.
- Hebrew: pass `--language he`. Scribe diarization separates an off-camera producer (S0) from the speaker (S1), which is useful for dropping interruptions.

## 3. Graphics with HyperFrames

HyperFrames (`heygen-com/hyperframes`) renders an HTML page with a paused GSAP timeline to video, frame by frame in headless Chrome. Upstream already lists it as one animation engine; here it is the default for graphics. Everything in §3 was checked end to end with CLI 0.8.180 (Oct 2026) in the cloud workspace: slot render, alpha composite through render.py's exact filter, Hebrew and mixed-language text, the caption layer. The CLI ships almost daily, so when a flag here disagrees with `npx hyperframes <cmd> --help`, trust `--help`.

### 3.1 Judgment: what, which engine, which mode

**What earns a graphic:** a hook title when the opening line doesn't hook on its own; a lower third the first time a person or product is named; a callout when the speaker says a number, a list or a step; an end card when there is a call to action. At most one new graphic element every ~3 s, the payoff landing on the spoken word (upstream's payoff-timing rule), the final frame held ≥ 1 s. No graphics at all when the footage carries itself.

| Engine | Use for |
|---|---|
| **HyperFrames** (default) | Anything with text or layout: titles, lower thirds, callouts, counters and stats, lists, charts, end cards, follow/subscribe cards, progress bars, kinetic type, any Hebrew/RTL text, styled captions. Check the registry first (§3.3). |
| Manim | Equations, formal diagrams, graph morphs (upstream vendors a Manim skill). |
| PIL | A trivial static card, or when no Chrome can run at all. |
| Remotion | Only if asked, or an existing Remotion brand system is in play. |

**Mode A, overlay slots (default).** video-use owns the picture (cut, grade, HDR tone-map, scale, mix). Each graphic is a transparent HyperFrames clip that `render.py` composites. Right whenever graphics sit on top of the footage.

**Mode B, HyperFrames finish.** video-use makes the cut decisions and HyperFrames composes the final. Choose it when graphics have to move or reframe the footage itself: changing aspect (render.py only scales, it never crops, so 16:9 footage stays 16:9), punch-ins, split-screen or picture-in-picture, B-roll moving with graphics, shader transitions. Also choose it when there are more than ~8 graphic elements. See §3.5.

### 3.2 Environment

```bash
export HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_SKIP_SKILLS=1   # init's --skip-skills flag is ignored; the env var works
npx --yes hyperframes browser ensure || \
  export HYPERFRAMES_BROWSER_PATH="$(ls -d /opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell | tail -1)"
```

- In the cloud workspace `browser ensure` fails (storage.googleapis.com is blocked), but a Playwright headless shell is preinstalled under `/opt/pw-browsers/`, which is the fallback above. Node 22 and ffmpeg are present. Re-export these variables in every Bash call and every sub-agent brief, because shell state doesn't persist.
- `cdn.jsdelivr.net` is blocked, and the `init` scaffold and every registry block load GSAP from it, so their renders fail. Vendor GSAP and fonts once into `<edit>/animations/_shared/` and copy them into every slot:
  ```bash
  SH="<edit>/animations/_shared"; mkdir -p "$SH/vendor" "$SH/assets/fonts" && cd "$SH" || exit 1
  [ -f vendor/gsap.min.js ] || { npm pack gsap@3 --silent >/dev/null && tar -xzf gsap-*.tgz && cp package/dist/gsap.min.js vendor/ && rm -rf package gsap-*.tgz; }
  [ -f assets/fonts/heebo-hebrew-800-normal.woff2 ] || { npm pack @fontsource/heebo --silent >/dev/null && tar -xzf fontsource-heebo-*.tgz && cp package/files/heebo-{hebrew,latin}-{400,800}-normal.woff2 assets/fonts/ && rm -rf package fontsource-heebo-*.tgz; }
  ```
  Then write `assets/fonts/heebo.css` with one `@font-face` per weight and subset, `url("heebo-hebrew-800-normal.woff2")` style paths (relative to the CSS file), `font-display: block`, Hebrew `unicode-range: U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F`, Latin `unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2212, U+FEFF, U+FFFD`. Other Fontsource families work the same way (`rubik`, `assistant`, `noto-sans-hebrew`, `frank-ruhl-libre`). Inter, Roboto, Montserrat, Poppins and Oswald are bundled and need no file.
- A slot needs no `init`: a folder holding `index.html`, `vendor/` and `assets/` renders.
- Speed here: about 6 s of wall time per second of 1080×1920 alpha output (2 cores, screenshot capture). A full-length caption layer for a 40 s reel takes 4–5 min. Parallel slot renders share the CPU.
- On the user's Mac `browser ensure` and jsDelivr work, but vendoring still costs nothing and keeps renders offline and deterministic, so do it there too.

### 3.3 Mode A: one slot, end to end

1. **Canvas = the base render.py builds,** because it overlays at 0,0 without scaling. Portrait sources become 1920 tall and landscape sources 1920 wide, the other side following the source aspect (ffprobe the source, mind rotation tags). Build every slot full-frame at exactly that size, transparent everywhere except the graphic. `render.py --draft` builds a 1280 base, so overlays land wrong there: check overlays with `--preview`.
2. **Scaffold:** `mkdir -p "<edit>/animations/slot_<id>" && cd "<edit>/animations/slot_<id>" && cp -r ../_shared/vendor ../_shared/assets .`, then write `index.html` from the skeleton below.
3. **Registry first.** `npx hyperframes catalog --query "<what you need>" --json` (447 items; works here), then `npx hyperframes add <exact-name> --no-clipboard`, which installs `compositions/<name>.html` and prints a mount snippet. After adding: point GSAP at the vendored copy (`sed -i 's#https://cdn.jsdelivr.net/npm/gsap@[^"]*/dist/gsap.min.js#vendor/gsap.min.js#' compositions/*.html`); replace placeholder text, avatars and colours; give the mount `data-start`, `data-duration` (≥ the block's own length) and a z-index, which the snippet lacks; rename the block's composition id in its file and mount if it is `main`; most blocks are 1920×1080, so prefer portrait ones for 9:16 or scale them in a wrapper. Useful for reels: `lt-clean-bar`, `lt-soft-pill`, `lt-dark-card`, `headline-slam`, `per-word-rise`, `titlecard-lockup`, `count-up`, `mk-progress-stat`, `chart-story`, `cta-lockup`, `cta-close`, `instagram-follow`, `tiktok-follow`.
4. **Check and render:**
   ```bash
   npx hyperframes lint                                    # 0 errors
   npx hyperframes snapshot --at <t1>,<t2> -o snaps        # transparency shows as white here: judge white text in the composite instead
   npx hyperframes render --format mov -o render.mov       # ProRes 4444 with alpha
   ffprobe -v error -show_entries stream=pix_fmt,width,height -show_entries format=duration -of compact render.mov
   ```
   Gate: `pix_fmt` starts with `yuva` (it is `yuva444p12le`), the size equals the base, the duration equals the slot length.
5. **EDL entry:** `{"file": "/abs/path/to/edit/animations/slot_<id>/render.mov", "start_in_output": T, "duration": D}`. Use absolute paths: render.py resolves overlay paths against the EDL's own folder, so upstream's `edit/animations/…` example becomes `edit/edit/…`. List order is stacking order (later is on top). `T` = the payoff word's output time minus the reveal time.
6. **Never `.webm` for render.py overlays.** Verified: ffmpeg's default VP9 decoder drops the alpha, and during the overlay window the whole frame turns black. MOV only.

Skeleton (1080×1920; change the four size spots for another base):

```html
<!doctype html>
<html lang="he">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1080, height=1920" />
  <script src="vendor/gsap.min.js"></script>
  <link rel="stylesheet" href="assets/fonts/heebo.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1080px; height: 1920px; overflow: hidden; background: transparent; }
    #title { position: absolute; left: 80px; right: 80px; top: 320px; opacity: 0;
      font: 800 96px/1.08 "Heebo", sans-serif; color: #fff; text-align: center;
      text-shadow: 0 6px 30px rgba(0,0,0,.55); unicode-bidi: plaintext; }
    #title .hl { color: #111; background: #ffd60a; padding: 0 18px; border-radius: 14px; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="slot_1" data-start="0" data-duration="3.5" data-width="1080" data-height="1920">
    <div id="title" dir="auto">3 טעויות <span class="hl">שכולם</span> עושים</div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#title", { opacity: 0, y: -40 }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, 0.1);
    tl.to("#title", { opacity: 0, y: -20, duration: 0.3, ease: "power2.in" }, 3.0);
    window.__timelines["slot_1"] = tl;
  </script>
</body>
</html>
```

Rules that break slot renders (condensed from the edit-video skill's §0):

- The root needs `data-composition-id`, `data-width`, `data-height` and `data-duration`. The render length is the root `data-duration`, never the GSAP length.
- One paused timeline, registered after the last tween as `window.__timelines["<composition id>"]`. A key that doesn't match the id makes the render wait ~45 s and then freeze.
- Deterministic only: no `Math.random`, `Date`, `performance.now`, `requestAnimationFrame`, CSS `transition` or `repeat: -1`. Use a seeded PRNG for noise.
- Tween transforms and opacity only. Use `fromTo` with an explicit start state and absolute values, and put `opacity: 1` in the destination of a reveal. Hide things in CSS, not with `tl.set(…, 0)`. Don't mix CSS `translate(-50%)` with GSAP `x` (use `xPercent`), and don't tween opacity on a `.clip` element itself.
- Relative starts need spaces: `"intro + 0.5"`.
- A sub-composition file wraps everything, styles and scripts too, in `<template>`. Host id = inner `data-composition-id` = timeline key.
- Every font family has a local `@font-face` unless it is bundled. Assets live inside the slot: no URLs, base64 media or `fetch()`. Negative CLI numbers need `=` (`--offset=-0.03`).
- Hebrew and mixed text: `dir="auto"` plus `unicode-bidi: plaintext` on the line, words as plain inline spans. Never `inline-block` or per-word transforms on Hebrew words, which reverses embedded English. Animate the whole line.
- 9:16 safe zones: platform UI covers about 220 px at the top, 420 px at the bottom and 140 px on the right. Titles go in the 250–700 px band.

**Sub-agent brief for a slot:** upstream's 10-point animation brief, plus the env exports from §3.2, the slot path and the `_shared` copy step, the exact canvas size and duration, the palette and font from `project.md`, the rules above, the render-and-ffprobe gate, and its closing line: "Do not ask questions. If anything is ambiguous, pick the most obvious interpretation and proceed."

### 3.4 Captions as a HyperFrames layer

render.py's burned SRT (libass, Helvetica, UPPERCASE) is fine for plain English. For Hebrew, Arabic, mixed lines or word-highlight captions, render the captions in HyperFrames and composite them as the **last** overlay, which is how Hard Rule 1 holds in this mode, and drop `subtitles` from the EDL.

1. **Words onto the output timeline** (Hard Rule 5's math; a word stays only if its midpoint is inside a kept range). Writes `words_out.json` for the builder and `words_out.srt` as the upload sidecar:
   ```bash
   python3 - "<edit>/edl.json" "<edit>/animations/words_out.json" <<'EOF'
   import json, sys, pathlib
   edl_p, out_p = map(pathlib.Path, sys.argv[1:3]); edl = json.loads(edl_p.read_text()); tdir = edl_p.parent / "transcripts"
   words, off = [], 0.0
   for i, r in enumerate(edl["ranges"]):
       s, e = float(r["start"]), float(r["end"]); tp = tdir / f'{r["source"]}.json'
       if tp.exists():
           for w in json.loads(tp.read_text()).get("words", []):
               if w.get("type", "word") != "word" or not str(w.get("text", "")).strip(): continue
               if s <= (w["start"] + w["end"]) / 2 < e:
                   words.append({"text": w["text"].strip(), "start": round(max(s, w["start"]) - s + off, 3),
                                 "end": round(min(e, w["end"]) - s + off, 3), "r": i})
       off += e - s
   out_p.write_text(json.dumps(words, ensure_ascii=False))
   groups = []   # SRT cues: <=3 words; break on a 0.5 s pause, a sentence end, or a cut
   for w in words:
       g = groups[-1] if groups else None
       if not g or len(g) >= 3 or w["r"] != g[-1]["r"] or w["start"] - g[-1]["end"] > 0.5 or g[-1]["text"][-1] in ".!?…": groups.append([w])
       else: g.append(w)
   def ts(t):
       ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
       return f"{h:02}:{m:02}:{s:02},{ms:03}"
   out_p.with_suffix(".srt").write_text("\n".join(f"{i}\n{ts(g[0]['start'])} --> {ts(g[-1]['end'])}\n{' '.join(x['text'] for x in g)}\n" for i, g in enumerate(groups, 1)))
   print(f"{len(words)} words, {len(groups)} cues, timeline {off:.3f}s")
   EOF
   ```
2. **Get the caption builder** from the edit-video skill's Appendix:
   ```bash
   S="<edit>/animations/slot_captions"; mkdir -p "$S/compositions" && cd "$S" && cp -r ../_shared/vendor ../_shared/assets . || exit 1
   EV=$(ls -d /mnt/skills/*/edit-video ~/.claude/skills/edit-video 2>/dev/null | head -1)/SKILL.md
   awk '/^### `\.edit\/build-captions\.mjs`/{f=1;next} f&&/^```js/{c=1;next} f&&c&&/^```/{exit} f&&c{print}' "$EV" > build-captions.mjs
   ```
   If edit-video isn't installed, fall back to render.py's SRT path with a Hebrew-capable font (see the libass field notes).
3. **Build it.** `--font-css` gets inlined, so give it a copy of `heebo.css` whose `url()` paths are rewritten to `assets/fonts/…` (project-root relative):
   ```bash
   sed 's#url("#url("assets/fonts/#' assets/fonts/heebo.css > assets/fonts/heebo-root.css
   node build-captions.mjs --words ../words_out.json --out compositions/captions.html \
     --width 1080 --height 1920 --duration <total> --font Heebo --font-css assets/fonts/heebo-root.css \
     --size 84 --bottom 600 --max-words 3 --max-chars 16 --accent "#ffd60a"
   ```
   For a Hebrew-primary video, force a right-to-left base so a line that starts with an English word still reads right to left (verified: "Claude Code וזה" renders as an RTL line):
   `sed -i 's/class="cap-group" dir="auto"/class="cap-group" dir="rtl"/; s/unicode-bidi: plaintext/unicode-bidi: isolate/' compositions/captions.html`
4. **Host and render.** `index.html` is the skeleton's head and transparent body, a root with `data-composition-id="slot_captions"` and the base size and total duration, containing one mount:
   ```html
   <div id="captions-host" data-composition-id="captions" data-composition-src="compositions/captions.html"
        data-start="0" data-duration="<total>" data-track-kind="captions" style="position:absolute;inset:0;z-index:50"></div>
   ```
   plus an empty paused timeline registered as `window.__timelines["slot_captions"]`. Render as in §3.3 and add it **last** in `overlays` with `start_in_output: 0`.
5. **Gate:** in the composited preview, check a mixed-language line for word order, highlight order (right to left for Hebrew), real Heebo glyphs (no tofu or fallback face), and lines clear of the UI zones and faces. Copy `words_out.srt` next to the final as `final.srt`.

To fix caption text, correct the transcript JSON and re-run steps 1 and 3 (Hard Rule 9 is about not re-transcribing; correcting words is fine).

### 3.5 Mode B: HyperFrames finish

1. Make the cut decisions as usual, ending in `edl.json`.
2. **Bake the cut without graphics:** copy the EDL to `edl_cut.json` with `"overlays": []` and no `subtitles`, then `render.py edl_cut.json -o "<edit>/cut.mp4" --no-subtitles --no-loudnorm`. This keeps video-use's word-snapped ranges, 30 ms fades, grade and HDR tone-map. Cut points on the output timeline are the running sums of the range durations.
   Exception: when you will crop hard (16:9 → 9:16, punch-ins past ~1.15) and the sources are larger than 1920, skip the bake, since it throws away the resolution you are cropping into. Place the EDL ranges as clips straight from the sources instead (edit-video's `cut-to-clips.mjs`, once per run of same-source ranges, `--start` at that run's output offset, a unique `--prefix` each time), grade with `media-treatment`, and render with `--sdr` for iPhone HDR.
3. **Build the HyperFrames project by the `edit-video` skill** (load it; Phases 5–12): `cut.mp4` as one A-roll clip with `data-has-audio="true"`, reframing with `object-position`, punch-ins on wrappers at the cut points, graphics as sub-compositions, captions from `words_out.json` without `--map`, music with a duck lane. Its "user confirmed/approved" gates become your own self-eval under §0, and its vendoring and browser notes are covered by §3.2.
4. **Final:** `npx hyperframes render -q delivery --strict --no-best-effort -o "<edit>/final.mp4"`, then upstream's self-eval on the render (`timeline_view` at every cut, `ebur128` loudness per section), the critic pass, at most 3 fix passes.

## 4. Working with the user's computer

Footage usually sits in a connected folder. Stage the sources into the container, because you need to view frames and run long renders there; HyperFrames renders run there too. Do the work in `<work>/edit/`, then copy the deliverables back to `<their folder>/edit/` with device_commit_files: final.mp4, final.srt, edl.json, project.md, transcripts, takes_packed.md, scripts, and the HyperFrames sources (`animations/*/index.html`, `compositions/`, `words_out.*`). Leave the `.mov` slot renders in the container: ProRes 4444 runs up to ~7 MB per second. Also send final.mp4 with SendUserFile.

## 5. Field notes (bugs hit in practice)

- **iPhone footage is often HLG** (`color_transfer=arib-std-b67`). If you bypass render.py, prepend its TONEMAP_CHAIN (zscale + hable) to every extract, including blurred title backgrounds. Tag the output `-color_primaries bt709 -color_trc bt709 -colorspace bt709`.
- **A/V drift at joins:** AAC segments joined with concat `-c copy` drift 30–65 ms per segment. Snap every range to the source frame grid, extract with `-frames:v N` and PCM audio in `.mov` (`atrim=end_sample=` to the exact length), then concat. Measure drift by cross-correlating the output audio against the source for each range.
- **Stereo SFX/music + `adelay=N` only delays channel 1.** Convert to mono (`aformat=...:channel_layouts=mono`) before `adelay`, or use `adelay=N:all=1`.
- **libass + RTL + inline size overrides:** runs with different `\fs` are laid out left-to-right in the order written, while each run is RTL inside. For Hebrew/Arabic emphasis, group words into same-size runs and write the runs in reverse order. Verify the burned pixels, because reading the frame back is unreliable: render each cue and each word alone, then match blobs by glyph correlation. (HyperFrames captions, §3.4, avoid this class of bug.)
- **libass font size ≠ PIL px size** (it normalises by ascent+descent). Calibrate by rendering a known line and measuring ink height and width against the reference.
- **Dynamic loudnorm wrecks a mix.** When linear mode can't reach the target, it pumps quiet SFX up and squashes hits. Instead: light voice compression, one static gain to the target (−16/−17 LUFS for talking heads), then a 4×-oversampled `alimiter` at −1.5 dBFS with `level=false`. Check what share of 50 ms windows sits near the ceiling.
- **Matching an existing series:** measure the references instead of guessing. Use frame crops for font, size and position. Use cross-correlation of the reference audio against the music/SFX files to find where each sound starts, its gain relative to speech, and whether the music is back-timed to end on the last frame.
- **Critic pass:** for anything published, spawn a separate critic sub-agent with the render, EDL and references. Verify its claims before acting, because some are measurement artefacts. Fix, re-render, and cap at 3 passes.
- **Alpha overlays:** MOV/ProRes 4444 only (WebM goes black through render.py), built at the exact base size, absolute paths in the EDL, checked with `--preview` rather than `--draft`.