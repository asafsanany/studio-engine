// The preview stills of the LUTs page (LUTs plan, "Previews"), mounted at /api/luts while the LUTs
// switch is on. OWNER: LU2.
//
//   GET /:slug/preview/:frame/:which.jpg    frame person|street|interior, which before|after
//
// It makes the still on the first request (luts/lut-previews.ts), shares concurrent requests and
// caches by the file's hash. An unknown LUT is 404 LUT_MESSAGES.notFound, an unknown frame or side
// 404 previewNotFound, a still that cannot be made 500 previewFailed. Mounted before
// routes/luts.ts, under the same /api/luts.
//
// Caching: the summary and detail the API answers carry `previewKey`, which the page puts on the
// address as `?v=<previewKey>` (it is a hash of the LUT's file and kind). A request whose `v` is the
// current one gets `public, max-age=31536000, immutable`: the address changes when the still would.
// Any other request gets `no-cache` and an ETag, so the browser asks and a 304 costs nothing.

import { readFile } from 'node:fs/promises';
import {
  LUT_FRAMES,
  LUT_MESSAGES,
  LUT_PREVIEW_SIDES,
  type LutFrame,
  type LutKind,
  type LutPreviewSide,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import type { LutRepository } from '../db/lut-repository.js';
import { lutStillNeedsGrade } from '../luts/lut-frames.js';
import type { LutPreviews } from '../luts/lut-previews.js';
import type { BuiltInLuts } from '../luts/lut-service.js';
import { resolveLutSource } from '../luts/lut-source.js';

export interface LutPreviewRouteOptions {
  /** Which LUTs of Yours exist, with their files' names and hashes. */
  luts: LutRepository;
  /** The built-in rows and their files in the skill. */
  builtIn: BuiltInLuts;
  /** Makes the stills. */
  previews: LutPreviews;
  /** The inbox, whose `_LUTs/` holds the files of Yours. */
  inboxPath: string;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function createLutPreviewRoutes(options: LutPreviewRouteOptions): Hono {
  const { luts, builtIn, previews, inboxPath } = options;
  const routes = new Hono();

  const resolve = (slug: string, needsFile: (kind: LutKind) => boolean) =>
    resolveLutSource({ luts, builtIn, inboxPath }, slug, needsFile);

  const fail = (c: Context, status: 404 | 500, error: string) => c.json({ error }, status);

  routes.get('/:slug/preview/:frame/:which', async (c) => {
    const slug = c.req.param('slug');
    const frame = LUT_FRAMES.find((f) => f === c.req.param('frame')) as LutFrame | undefined;
    const side = LUT_PREVIEW_SIDES.find((s) => `${s}.jpg` === c.req.param('which')) as
      | LutPreviewSide
      | undefined;

    // The LUT first, so a slug that is not one says so whatever else is wrong with the address.
    const lut = await resolve(slug, (kind) => side !== undefined && lutStillNeedsGrade(side, kind));
    if (!lut.ok) return fail(c, lut.status, lut.error);
    if (frame === undefined || side === undefined) {
      return fail(c, 404, LUT_MESSAGES.previewNotFound);
    }

    // Without a hash of the file there is nothing to say a still is unchanged: no ETag, no 304.
    const etag = lut.version === null ? null : `"${lut.version}-${frame}-${side}"`;
    const cacheControl =
      lut.version !== null && c.req.query('v') === lut.version ? IMMUTABLE : 'no-cache';
    const tagged: Record<string, string> = etag === null ? {} : { ETag: etag };
    if (etag !== null && c.req.header('if-none-match') === etag) {
      return c.body(null, 304, { ...tagged, 'Cache-Control': cacheControl });
    }

    let body: Buffer;
    try {
      body = await readFile(await previews.still(lut.source, frame, side));
    } catch {
      // The reason is logged where the still is made; the page gets a plain sentence.
      return fail(c, 500, LUT_MESSAGES.previewFailed);
    }
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': cacheControl,
      ...tagged,
    });
  });

  return routes;
}
