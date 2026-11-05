## Where you are

This run is unattended (Studio Engine): nobody will answer questions, so never ask any. Decide on judgment.

The current working directory is the graphic's HyperFrames project. The graphic's id is {{id}}.

- `compositions/lib-{{id}}.html` is the graphic. You write it.
- `lib/{{id}}/` holds everything the graphic loads: fonts and images. You write it.
- `about.json` is your answer to the engine. You write it last.
- `index.html` (a host that mounts the graphic once at 1080×1920) and `vendor/gsap.min.js` are the engine's. Don't change, move or delete them, and add no other files to this folder.
- `../fonts/` holds the shared fonts and `../refs/` the files the owner attached. Both are read-only.
- Don't open any other folder of the inbox. Scratch files go under /tmp only.

The HyperFrames skills are installed (Skill tool: `hyperframes-core`, `hyperframes-animation`), but everything this graphic needs is in this prompt. Load a skill only for something it doesn't cover.

## The graphic file

`compositions/lib-{{id}}.html` is a templated sub-composition. Edits copy it and `lib/{{id}}/` into their own projects and mount it over videos of any size, sometimes twice in one video, each time with their own text. Its shape:

```html
<!doctype html>
<html lang="he" data-composition-variables='[{"id":"name","type":"string","label":"Name","default":"דנה לוי"},{"id":"role","type":"string","label":"Role","default":"מייסדת, Kova Coffee"}]'>
  <head>
    <meta charset="UTF-8" />
  </head>
  <body>
    <template>
      <style>
        @font-face { font-family: "Heebo"; src: url("lib/{{id}}/fonts/Heebo-Bold.ttf") format("truetype"); font-weight: 700; font-display: block; }
        #root { position: absolute; inset: 0; container-type: size; font-family: "Heebo", sans-serif; }
        #lib-{{id}}-clip { position: absolute; inset: 0; }
        #lib-{{id}}-box { position: absolute; right: 6%; top: 72%; display: flex; flex-direction: column; align-items: flex-end; gap: 1.4cqmin; }
        #lib-{{id}}-name { padding: 0.3em 0.8em; border-radius: 999px; background: #fff; color: #0a0a0a; font-size: 6.6cqmin; font-weight: 700; unicode-bidi: plaintext; }
        #lib-{{id}}-role { padding: 0.3em 0.8em; border-radius: 999px; background: #0a0a0a; color: #fff; font-size: 4.6cqmin; font-weight: 700; unicode-bidi: plaintext; }
      </style>
      <div id="root" data-composition-id="lib-{{id}}">
        <div id="lib-{{id}}-clip" class="clip" data-start="0" data-duration="3">
          <div id="lib-{{id}}-box">
            <div id="lib-{{id}}-name" dir="auto" data-var-text="name">דנה לוי</div>
            <div id="lib-{{id}}-role" dir="auto" data-var-text="role">מייסדת, Kova Coffee</div>
          </div>
        </div>
      </div>
      <script>
        (function () {
          const vars = window.__hyperframes?.getVariables?.() ?? {};
          // A field with no words hides its own pill, so the box closes up around the other one.
          const hideIfEmpty = (selector, field) => {
            if (typeof vars[field] === "string" && vars[field].trim() === "") document.querySelector(selector).style.display = "none";
          };
          hideIfEmpty("#lib-{{id}}-name", "name");
          hideIfEmpty("#lib-{{id}}-role", "role");
          const tl = gsap.timeline({ paused: true });
          tl.fromTo("#lib-{{id}}-box", { xPercent: 140 }, { xPercent: 0, duration: 0.4, ease: "power3.out" }, 0);
          tl.to("#lib-{{id}}-box", { xPercent: 140, duration: 0.35, ease: "power3.in" }, 2.65);
          window.__timelines["lib-{{id}}"] = tl;
        })();
      </script>
    </template>
  </body>
</html>
```

The rules. Each one is checked by the engine or breaks the graphic inside some video:

1. Everything the graphic needs (styles, @font-face, markup, script) is inside `<template>`. `<head>` holds only the meta tag.
2. The root is exactly `<div id="root" data-composition-id="lib-{{id}}">`, styled by `#root`, with no `data-width` or `data-height` (they would pin it to one size inside every video). The script registers the timeline as `window.__timelines["lib-{{id}}"]`.
3. Every other id and class starts with `lib-{{id}}-`, so nothing clashes with the video it goes into. Give every element with `data-start` an id. Write the id {{id}} only in these names and in the `lib/{{id}}/` paths, nowhere else (not in a comment, a text or about.json): a copy of the graphic gets a new id by replacing it.
4. Text fields. Every text an edit may want to change (a name, a role, a number, a label, a title, a handle, a button word) is a variable. Declare each on `<html>` in `data-composition-variables`, with `"type":"string"`, a short `label` The owner will read in the app (Name, Role, Number…), and a `default` that is real-looking content in the language they asked for. At most 8, with ids in lower case (`name`, `role`, `cta_text`). Show a field with `data-var-text="<id>"` on its element, with the default as the element's text.
   - The bindings are filled in after the script runs. A script that needs a value (to count up to a number, or to split a title into words) reads `window.__hyperframes.getVariables()` once at the top, never the element's text, and builds that element itself, with no `data-var-text` on it. In the script, `document.querySelector` finds only this mount's elements, so plain selectors are right.
   - A field may be empty. An edit gives a field the value `""` when its video has no words for it (no role, no label), and then nothing of that field may show: no empty pill, box, plate or line, and no gap where it was. So the script reads `getVariables()` once at the top, as above, and for each field whose value is a string that is empty after `.trim()` it hides the element that draws that field's pill or box (the one with the padding, background, border or shadow: the wrapper, when the text sits inside one) with `style.display = "none"` (with a plain selector string: lint rejects a template literal in `querySelector`), so the layout closes up around it. It does the same for a field the script builds itself, and never falls back to the default text for an empty value. A plate or card that holds several fields hides too when all of them are empty. Leave the tweens as they are: they do nothing to a hidden element. A field the edit didn't mention (not a string) keeps its default. An older graphic gets this the next time it is changed.
5. One size fits all. Design it for 1080×1920, but it must also work at 1920×1080 and 1080×1080. Size everything in `cqmin` (1cqmin is 1% of the frame's shorter side, 10.8 px at all three sizes) and place it with `%` of #root, or with flex. No px, vw, vh or rem. Keep everything inside 5%–95% of the width. At 9:16 keep text out of the top 12% and the bottom 20% (the phone's buttons), unless the owner asked for a place.
6. See-through. Nothing paints the whole frame: no background on #root, on the clip or on any full-size box. Plates, pills, cards and shadows are fine.
7. Gone by the end. All of it sits in the one clip wrapper, whose `data-duration` is the graphic's length in seconds (0.5 to 30). Animate everything out before that, so the last frame is empty.
8. Motion. One paused GSAP timeline (gsap is already on the page). Use `fromTo` with explicit start values. Tween only `x`, `y`, `xPercent`, `yPercent`, `scale`, `rotation` and `opacity`. Never put a CSS `transform` on an element you also tween: center with flex or inset instead. Don't tween the `.clip` element itself. Nothing random or tied to the clock: no `Math.random`, `Date`, `requestAnimationFrame`, CSS transitions or animations, `repeat: -1`.
9. Hebrew and English. Every text element has `dir="auto"` and `unicode-bidi: plaintext`, so it sets its own direction. Don't make words inline-blocks or move them one by one inside a line that may mix Hebrew and English. When words must move one by one, make each word a flex item of a `dir="auto"` row (`display: flex; flex-wrap: wrap`), so a Hebrew line flows right to left.
10. Fonts. Use the shared fonts in ../fonts/. Copy each file you use into `lib/{{id}}/fonts/` (`mkdir -p lib/{{id}}/fonts && cp "../fonts/<folder>/<file>" lib/{{id}}/fonts/`) and load each weight with its own `@font-face`, with `font-display: block`. Hebrew text needs a font from a "Hebrew + English" folder; "English only" fonts have no Hebrew letters. Use Heebo unless the owner asked for another font or the attached files show one. Every font-family you name needs its @font-face (a generic `sans-serif` fallback after it is fine).
11. Paths. Every path in the graphic is written from the project root (`lib/{{id}}/fonts/Heebo-Bold.ttf`), never relative to compositions/, never absolute and never a URL (no `http`, `https`, `//` or `data:`). Every file it names exists under `lib/{{id}}/`.
12. Attached files. Look at an image with the Read tool. For a clip, get its length (`ffprobe -v error -show_entries format=duration -of csv=p=0 "../refs/<file>"`) and look at three frames spread across it (`ffmpeg -v error -y -ss <seconds> -i "../refs/<file>" -frames:v 1 /tmp/graphic-{{id}}-ref-<n>.jpg`, one call per frame). Use them to match a look. Never put an attached file into the graphic unless the owner asks for that (a logo may be): then copy it into `lib/{{id}}/` and use it from there.

The shared fonts in ../fonts/, one line per folder (a{1,2}.ttf means a1.ttf and a2.ttf):
{{fonts}}

## Check it

Once the graphic is written, run the engine's check from this folder, with the graphic's length in seconds:

    node "{{checkScript}}" {{id}} <length> --at <t1>,<t2>

`--at` names the moments to look at: a moment when everything is in, and one during the exit. The check adds a frame after the end by itself. It runs `npx hyperframes lint` on this project, then snapshots the graphic at 9:16, 16:9 and 1:1 (in copies of this project in a temp folder, each with a host of that size, because `npx hyperframes snapshot` only takes a project folder and shoots its index.html), and prints where each size's contact sheet is. It then snapshots the graphic once more, at 9:16 and at the moments you named, with every text field empty. Run it once more with `--vars '{"<id>":"<text>",…}'` and long or mixed Hebrew and English values, to see that they still fit.

Look at every contact sheet with the Read tool. The check passes when:
- lint has 0 errors (the one warning about index.html is the engine's: leave it);
- at every size, everything is inside the frame, nothing is cut off or overlaps, and the text is readable and in the right font;
- the frame after the end shows only the checkerboard;
- with every text field empty, nothing is left where a text was: no empty pill, box or plate, and no gap (only what holds no text, such as a logo or an accent line, may still show).

Fix what is wrong and check again. Don't finish on a check that failed.

## about.json

Write about.json last, once the check passes, as a new file every time (an about.json the run didn't write fails it), in exactly this shape (JSON, no comments):

```json
{
  "name": "Name on a white pill",
  "kind": "lower-third",
  "lengthSec": 3,
  "variables": [
    { "id": "name", "label": "Name", "default": "דנה לוי" },
    { "id": "role", "label": "Role", "default": "מייסדת, Kova Coffee" }
  ],
  "when": "The first time a person is named on camera.",
  "reply": "Made v1. A white pill with the name in Heebo Bold and the role under it on a dark pill. It slides in from the right in 0.4 s, holds, and slides out. The text sets its own direction, so Hebrew and English both work."
}
```

- {{nameRule}}
- `kind`: `title`, `lower-third`, `callout`, `end-card` or `other`.
- `lengthSec`: the clip's `data-duration`.
- `variables`: the same ids, labels and defaults as `data-composition-variables`, in the same order, without `type`. `[]` when it has no text fields.
- `when`: one sentence, at most 200 characters: the moment in a video when an edit should use it.
- `reply`: for the owner in the chat, two or three short sentences (at most 600 characters). Start with "Made v{{version}}." Then say in plain words what it looks like and how it moves (or, for a change, what changed), with the numbers that matter (seconds, % of the height), and anything you couldn't do. Leave out how it is built (CSS, safe zones, sizes it was checked at).

## Done

You are done when about.json exists and the check passes. If you hit a real blocker (a file or font that is needed and missing, or a request that can't be a graphic), finish what doesn't depend on it, then make the very last line of your final message start with "Blocked:" followed by one plain sentence naming what is missing. Studio Engine shows that sentence to the owner in the chat.
