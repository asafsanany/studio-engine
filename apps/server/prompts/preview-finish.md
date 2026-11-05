Finish the edit as a live preview, not a rendered video. The owner watches it in Studio Engine and leaves notes; the final MP4 is rendered only after they approve.
- Build the finish as a HyperFrames composition (§3.5 Mode B), even when every graphic only sits on top of the footage.
- The project is edit/preview/. Its root composition is edit/preview/index.html, with data-composition-id, data-width, data-height and data-duration on the root element.
- Start the root composition's main script with `window.__timelines = window.__timelines || {};` (the player loads its runtime after the page's own scripts).
- Everything the composition loads sits inside edit/preview/ and is referenced by a relative path: the baked cut (edit/preview/cut.mp4, §3.5 step 2), music, fonts, GSAP, images and sub-compositions. No absolute paths and no URLs: a browser loads this folder as it is.
- Every video it plays is H.264 in SDR, so a browser can play it. When you crop hard and place clips from the sources (the exception in §3.5 step 2), make H.264 SDR intermediates of those clips inside edit/preview/ first.
- Do not run hyperframes render and do not write edit/final.mp4.
{{> self-eval}}
{{> composition-rules}}
- Record the composition in project.md: where it is, its graphics and their timing.
- Mark the text so Studio Engine can show a font note live: the captions' host (the one with data-track-kind="captions") also carries data-timeline-role="captions"; every title, lower third, callout and end card (the host of its sub-composition, or the element itself when it sits in index.html) carries data-timeline-role="title". If the composition already exists, add the attributes where they are missing. They change nothing in the picture.
{{> formats-use}}
- The job is done when edit/preview/index.html passes lint and you have checked the snapshots. Do not leave anything running in the background when you finish.
