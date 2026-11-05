// The test frames of the Fonts page's "On a frame" view (Fonts plan, "The page (web)"; FN8):
//
//   GET /api/fonts/frame/<frame>.jpg    the photo, 396×704 (9:16), for frame person | street | interior
//
// They are the LUTs' frames (apps/server/assets/luts/frames/), so there is one copy of each photo
// in the app; only the plain frame is ever served here, never the flat `-log` twin the LUTs page
// keeps for Camera LUTs. A bundled photo never changes at its address, so the browser may keep it
// for good. Mounted by app.ts next to the other Fonts routes, so it is off while the Fonts switch
// is (and the route-policy row `/api/fonts/*` makes it the admin's, like the rest of Fonts).

import { readFile } from 'node:fs/promises';
import { FONT_FRAMES, type FontFrame } from '@studio/shared';
import { Hono } from 'hono';
import { lutFramePath } from '../luts/lut-frames.js';

/** The `Cache-Control` of a frame: the photo at an address is never replaced. */
export const FONT_FRAME_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** 404, an address that names none of {@link FONT_FRAMES} (or a frame file that is gone). */
export const FONT_FRAME_NOT_FOUND = 'There is no such test frame.';

/** The frame an address segment names (`person.jpg`), or `undefined` for anything else. */
export function fontFrameOf(segment: string): FontFrame | undefined {
  return FONT_FRAMES.find((frame) => `${frame}.jpg` === segment);
}

export function createFontFrameRoutes(): Hono {
  const routes = new Hono();

  routes.get('/frame/:file', async (c) => {
    const frame = fontFrameOf(c.req.param('file'));
    if (frame === undefined) return c.json({ error: FONT_FRAME_NOT_FOUND }, 404);
    let bytes: Buffer;
    try {
      bytes = await readFile(lutFramePath(frame));
    } catch {
      // A bundled file that is not there is a broken install; the page just shows no photo.
      return c.json({ error: FONT_FRAME_NOT_FOUND }, 404);
    }
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': FONT_FRAME_CACHE_CONTROL,
    });
  });

  return routes;
}
