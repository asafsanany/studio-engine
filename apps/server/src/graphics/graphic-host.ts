// The host page of a graphic (Graphics plan, "Preview"). OWNER: GR3.
//
// A graphic is a templated sub-composition (compositions/lib-<id>.html). It plays inside a host:
//
//   - a root composition sized 1080×1920, 1920×1080 or 1080×1080, with data-duration = length +
//     0.8 s, so the loop breathes;
//   - the timeline registry line and vendor/gsap.min.js;
//   - a background div that is not a clip: the sample frame image, a CSS checkerboard or black;
//   - one mount of compositions/lib-<id>.html with data-variable-values from `values`, and an
//     empty paused root timeline.
//
// The preview serves it at GET /api/graphics/:id/v/:n/host.html?size=…&bg=…&vars=… (routes/
// graphic-files.ts), and the worker writes it as work/index.html (9:16, no background) before every
// run (GR1). Every path in it is relative to the project root, so the same page plays from the
// preview route and from a folder on disk.
//
// The mount is sized by CSS (`#graphic { position: absolute; inset: 0 }`), never by the graphic: a
// graphic's root has no data-width/data-height, because both runtimes would stamp that size onto
// the mount whatever the host's size is (GR2's spike).

import {
  GRAPHIC_SIZE_PIXELS,
  type GraphicBackground,
  type GraphicSize,
  type GraphicVars,
} from '@studio/shared';

/**
 * The line that creates HyperFrames' timeline registry, first in the head. It is the same text the
 * preview routes put into a root composition (composition-files.ts's TIMELINE_REGISTRY_SCRIPT, which
 * graphic-host.test.ts holds this equal to), so a page that has it is served unchanged. It is here,
 * not imported, so this file depends on nothing but the shared package: the dev gallery loads it too.
 */
export const HOST_REGISTRY_SCRIPT =
  '<script>window.__timelines = window.__timelines || {};</script>';

/** The extra time after the graphic's length, so the loop breathes. */
export const HOST_TAIL_SEC = 0.8;

/** Where the sample frames are served (routes/graphic-files.ts: GET /assets/:file). */
export const SAMPLE_FRAMES_BASE = '/api/graphics/assets';

/** The sample frame's file for a size: `sample-9x16.svg`, `sample-16x9.svg`, `sample-1x1.svg`. */
export function sampleFrameFile(size: GraphicSize): string {
  return `sample-${size}.svg`;
}

export interface GraphicHostOptions {
  /** The graphic's id (12 hex): it mounts compositions/lib-<id>.html. */
  id: string;
  /** The graphic's length in seconds (about.json's `lengthSec`). */
  lengthSec: number;
  size: GraphicSize;
  /** What is behind the graphic; `null` for nothing (the run's work/index.html). */
  background: GraphicBackground | null;
  /** The text fields' values (variable id → text); left out, a field keeps its default. */
  values: GraphicVars;
  /**
   * Where the sample frames are served from, for the `frame` background. Default
   * {@link SAMPLE_FRAMES_BASE}; only the dev gallery, which has no engine, says otherwise.
   */
  assetsBase?: string;
}

/** Text for a double-quoted HTML attribute or an element's content. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The rule that paints `#background`, or '' for no background. */
function backgroundRule(options: GraphicHostOptions, width: number, height: number): string {
  switch (options.background) {
    case null:
      return '';
    case 'frame': {
      const base = (options.assetsBase ?? SAMPLE_FRAMES_BASE).replace(/\/+$/, '');
      const url = `${base}/${sampleFrameFile(options.size)}`;
      return `background: #2a2521 url("${url}") center / cover no-repeat;`;
    }
    case 'checker': {
      // The board's checkerboard: 20 squares across the short side.
      const cell = Math.max(10, Math.round(Math.min(width, height) / 20));
      return `background-color: #27272a; background-image: repeating-conic-gradient(#3f3f46 0 25%, transparent 0 50%); background-size: ${cell}px ${cell}px;`;
    }
    case 'black':
      return 'background: #000;';
  }
}

/**
 * The host page for one graphic: a whole HTML document. The background is a plain div, not a clip,
 * so it never takes part in the timeline; the graphic is the only thing HyperFrames mounts. The
 * values go into `data-variable-values` as JSON, escaped for a double-quoted attribute.
 */
export function renderGraphicHost(options: GraphicHostOptions): string {
  const { width, height } = GRAPHIC_SIZE_PIXELS[options.size];
  const lib = escapeHtml(`lib-${options.id}`);
  const duration = Math.round((options.lengthSec + HOST_TAIL_SEC) * 1000) / 1000;
  const rule = backgroundRule(options, width, height);
  const background = rule === '' ? '' : '\n      <div id="background"></div>';
  const backgroundStyle =
    rule === '' ? '' : `\n      #background { position: absolute; inset: 0; ${rule} }`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${lib}</title>
    ${HOST_REGISTRY_SCRIPT}
    <script src="vendor/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: transparent; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; }${backgroundStyle}
      #graphic { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${duration}">${background}
      <div id="graphic" data-composition-id="${lib}" data-composition-src="compositions/${lib}.html" data-start="0" data-duration="${options.lengthSec}" data-track-index="1" data-width="${width}" data-height="${height}" data-variable-values="${escapeHtml(JSON.stringify(options.values))}"></div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}
