# Pipeline test data

## preview/: the sample composition

A small live HyperFrames composition (1080×1920, 6 s, one sub-composition) for the review player.
The dev gallery plays it at `/__dev/preview-sample/` (served by `apps/web/dev-preview-sample.ts`,
dev only), and the fake runner copies the whole folder into a fake job's `edit/preview/`. The
folder is copied as it is, so notes about it live here, not inside it. It holds exactly:

- `index.html`: the main composition. The text `Sample preview` (the `<title>` and the `#title`
  element) is what the fake runner replaces with the job name. It creates `window.__timelines` itself before it registers its timeline: a bare
  `<hyperframes-player>` loads the HyperFrames runtime only after the composition's own scripts
  have run, while `hyperframes preview` loads the runtime first and creates the registry for you.
  Tried without that line (player 0.8.181): the main script throws `Cannot set properties of
  undefined (setting 'main')`, the player still reports ready (the sub-composition's timeline
  registers later), and the main timeline's animations silently never run.
- `compositions/badge.html`: the one sub-composition (a "SAMPLE" badge from 2 s to 5 s). Its style
  and script sit inside `<template>`, as sub-compositions require.
- `cut.mp4`: a 6 s 360×640 `testsrc` clip with a 440 Hz tone that beeps every second, so a seek
  can be seen and heard. Made with ffmpeg 9.0.2 (H.264 `-crf 30`, AAC 64k, faststart); 93 KB:

  ```sh
  ffmpeg -nostdin -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc=size=360x640:rate=30:duration=6" \
    -f lavfi -i "sine=frequency=440:beep_factor=2:sample_rate=48000:duration=6" \
    -map 0:v -map 1:a \
    -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -g 30 \
    -c:a aac -b:a 64k \
    -shortest -movflags +faststart \
    apps/server/src/pipeline/testdata/preview/cut.mp4
  ```

- `vendor/gsap.min.js`: GSAP 3.15.0, byte for byte from `npm pack gsap@3.15.0`
  (`package/dist/gsap.min.js`). Its header carries the license: "Subject to the terms at
  https://gsap.com/standard-license", GreenSock's standard "no charge" license, which allows
  shipping the file inside a project.
- `assets/fonts/noto-sans-hebrew-hebrew-700-normal.woff2`: the Hebrew subset of Noto Sans Hebrew
  Bold, copied from the `@fontsource/noto-sans-hebrew` 5.3.0 package (SIL Open Font License 1.1).

- The folder has no music in it, on purpose: with the Soundtrack switch on, the fake runner writes
  the sample with one more element (`withMusicElement` in `fake-preview.ts`: an `<audio id="music"
  src="music.mp3">` over the whole 6 s at a low volume, inserted before `#progress`) and the music
  script's fake path writes `music.mp3` next to it. With the switch off the sample is copied exactly
  as it is here.

Biome ignores the folder (`biome.json`): minified GSAP and the composition HTML are not ours to
format.
