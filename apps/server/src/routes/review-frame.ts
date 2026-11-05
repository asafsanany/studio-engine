// The look on the paused frame in Review (LUTs build 2, LU11), mounted at /api/jobs while both LUTs
// switches (`luts` and `lutsInEdits`) are on:
//
//   GET /:id/review/frame?t=<seconds>[&lut=<slug>][&round=<n>]
//
// A JPEG of the job's preview at `t` (to the nearest tenth of a second): with `lut`, run through that
// LUT as the LUTs page runs its test frames; without it the plain frame, which Compare shows. `round`
// defaults to the newest, the only one that has a preview. The frames come from the round's small
// preview video (luts/review-frames.ts says why and what it costs).
//
//   400 `t` is missing or not a number of seconds (0 or more)
//   404 the job is unknown; it has no preview; the preview video is still being made; an unknown LUT
//   422 a Camera LUT: it needs log footage and is not previewed ("That LUT cannot be previewed.")
//   500 the frame could not be taken (plain sentence; the reason is logged where it is made)
//
// The answer is `no-cache` with an ETag, so a new round or a new LUT file is never shown stale and an
// unchanged frame costs a 304.

import { readFile } from 'node:fs/promises';
import { LUT_MESSAGES } from '@studio/shared';
import { type Context, Hono } from 'hono';
import type { JobRepository } from '../db/index.js';
import type { LutRepository } from '../db/lut-repository.js';
import type { PreviewSource } from '../luts/lut-previews.js';
import type { BuiltInLuts } from '../luts/lut-service.js';
import { resolveLutSource } from '../luts/lut-source.js';
import type { ReviewFrames } from '../luts/review-frames.js';

export interface ReviewFrameRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  /** Which LUTs of Yours exist, with their files' names and hashes. */
  luts: Pick<LutRepository, 'getBySlug'>;
  /** The built-in rows and their files in the skill. */
  builtIn: BuiltInLuts;
  /** The inbox, whose `_LUTs/` holds the files of Yours. */
  inboxPath: string;
  /** Takes the frames. */
  frames: ReviewFrames;
}

/** The longest time that is believed (a day), so a stray number never reaches ffmpeg. */
const MAX_SECONDS = 86_400;

export function createReviewFrameRoutes(options: ReviewFrameRouteOptions): Hono {
  const { jobs, luts, builtIn, inboxPath, frames } = options;
  const routes = new Hono();
  const fail = (c: Context, status: 400 | 404 | 422 | 500, error: string) =>
    c.json({ error }, status);

  routes.get('/:id/review/frame', async (c) => {
    const id = c.req.param('id');
    const rawTime = c.req.query('t');
    const seconds = rawTime === undefined || rawTime.trim() === '' ? Number.NaN : Number(rawTime);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) {
      return fail(c, 400, LUT_MESSAGES.frameBadTime);
    }

    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);

    const rawRound = c.req.query('round');
    let round: number | null = null;
    if (rawRound !== undefined) {
      round = /^\d{1,6}$/.test(rawRound) ? Number(rawRound) : -1;
      if (round < 0) return fail(c, 404, LUT_MESSAGES.frameNoPreview);
    }

    // The nearest tenth, and never past the end of the cut when its length is known.
    const lastTenth =
      job.preview !== null && job.preview.durationSec > 0
        ? Math.floor(job.preview.durationSec * 10)
        : Number.POSITIVE_INFINITY;
    const tenths = Math.min(Math.round(seconds * 10), lastTenth);

    const slug = c.req.query('lut');
    let lut: PreviewSource | null = null;
    if (slug !== undefined) {
      const found = await resolveLutSource(
        { luts, builtIn, inboxPath },
        slug,
        (kind) => kind !== 'camera',
      );
      if (!found.ok) return fail(c, found.status, found.error);
      if (found.source.kind === 'camera') return fail(c, 422, LUT_MESSAGES.frameCamera);
      lut = found.source;
    }

    const made = await frames.frameFor({ job, tenths, lut, round });
    if (!made.ok) return fail(c, made.status, made.error);

    const headers = { ETag: made.etag, 'Cache-Control': 'no-cache' };
    if (c.req.header('if-none-match') === made.etag) return c.body(null, 304, headers);
    let body: Buffer;
    try {
      body = await readFile(made.path);
    } catch {
      return fail(c, 500, LUT_MESSAGES.frameFailed);
    }
    return c.body(new Uint8Array(body), 200, { ...headers, 'Content-Type': 'image/jpeg' });
  });

  return routes;
}
