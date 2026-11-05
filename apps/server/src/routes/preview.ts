// The live preview of a job (Phase 3 · Review), mounted at /api/jobs:
//
//   GET|HEAD /:id/preview/<path>   the file <inbox>/<job.relPath>/edit/preview/<path>, read-only
//   GET|HEAD /:id/preview/<format>/<path>
//                                  Formats (GN7): the same for an extra format of a job with two or
//                                  more (`Job.formats`, `<format>` is a format's id such as `1x1`):
//                                  the file edit/preview-<format>/<path>. Its page loads its assets
//                                  by relative path from there. Any other first segment is a path
//                                  of the main preview, so today's URLs are what they were
//   GET|HEAD /:id/preview-poster   one JPEG of the preview's first frame, kept as edit/poster.jpg
//                                  (JobStills.posterFor): 404 with no preview or no video in it,
//                                  500 when ffmpeg fails. The phone's Review shows it until the
//                                  first play, since an iPhone loads no video before a tap.
//
// The player in the browser loads edit/preview/index.html from here, and every asset it loads by a
// relative path (scripts, styles, fonts, video, audio, images) comes through the same route.
//
// It serves in any state: the route never looks at the job's state, only at the folder. The
// preview exists while edit/preview/index.html does; otherwise every path answers 404.
//
// Nothing outside edit/preview/ can be read. The path is percent-decoded exactly once (by Hono),
// refused when it is empty, has a NUL byte, is absolute or has a `..` segment, and then resolved
// against the real path of the preview folder, so a symlink that points out is refused too. Every
// refusal answers the same 404 text, so the answers do not reveal what exists outside.
//
// Every file is sent with `Cache-Control: no-cache` and an ETag, so a new round's files are
// fetched again and unchanged ones are answered 304. Byte ranges work as in the download, so video
// seeks.
//
// Every file is sent as it is on disk, except two kinds of page:
// - the root index.html (W2) is sent with the timeline registry put first in its head
//   (`injectTimelineRegistry`), because the player loads the HyperFrames runtime after the page's
//   own scripts;
// - every page (the root and the sub-compositions under it) has `playsinline webkit-playsinline`
//   added to each <video> tag that lacks them (`injectPlaysInline`, PH9): without them iPhone
//   Safari plays a video in its own full-screen player instead of in the preview.
// Such a page has an ETag made from the bytes it sends, since they differ from the file's; a
// sub-composition that needs no change is sent as a file, like the rest. The changes happen only
// on the way out and are never written into the job's folder, so lint judges the run's own file.
//
// The serving rules themselves (safe names, content types, the registry, ranges, revalidation) live
// in routes/composition-files.ts, which the Graphics preview uses too. Their names are exported
// from here as well, as they always were.

import { join } from 'node:path';
import { extraFormatsOf, type Job, reviewExportFileName } from '@studio/shared';
import { Hono } from 'hono';
import { type JobStills, StillError } from '../clients/job-still.js';
import type { PreviewVideos } from '../clients/preview-video.js';
import type { ReviewExports } from '../clients/review-export.js';
import type { JobRepository } from '../db/index.js';
import { logger } from '../logger.js';
import { extraPreviewDirPath, PREVIEW_DIR_PATH } from '../pipeline/preview-files.js';
import { COMPOSITION_INDEX, serveCompositionFile } from './composition-files.js';
import { resolveInside, serveFile } from './download.js';

export {
  injectPlaysInline,
  injectTimelineRegistry,
  isSafePreviewPath,
  PLAYS_INLINE_ATTRIBUTES,
  PREVIEW_CONTENT_TYPES,
  previewContentType,
  TIMELINE_REGISTRY_SCRIPT,
} from './composition-files.js';

/** The preview's root composition. The preview exists only while this file does. */
export const PREVIEW_INDEX = COMPOSITION_INDEX;
export const NO_PREVIEW_MESSAGE = 'This job has no preview.';
export const PREVIEW_FILE_MISSING_MESSAGE = 'The preview file is missing.';

/**
 * The real path of a job's edit/preview (or, with `dirPath`, of an extra format's edit/preview-<id>), or null when it is missing, has no index.html, or
 * leaves the job folder (edit/ or edit/preview/ is a symlink that points out).
 */
export async function findPreviewRoot(
  jobDir: string,
  dirPath: string = PREVIEW_DIR_PATH,
): Promise<string | null> {
  const root = await resolveInside(jobDir, dirPath);
  if (root === null) return null;
  return (await resolveInside(root, PREVIEW_INDEX)) === null ? null : root;
}

export interface PreviewRouteOptions {
  jobs: JobRepository;
  /** Config.inboxPath: a job's folder is <inboxPath>/<job.relPath>. */
  inboxPath: string;
  /** Makes the posters (the engine's `JobStills`); without it the poster route answers 404. */
  posters?: Pick<JobStills, 'posterFor'>;
  /** Makes the small MP4 of the preview (the engine's `PreviewVideos`); without it the routes answer 404. */
  videos?: Pick<PreviewVideos, 'statusFor'>;
  /** The full-quality MP4 made on request in Review; without it the export routes answer 404. */
  exports?: Pick<ReviewExports, 'statusFor' | 'start'>;
  /**
   * Why Export MP4 must wait for the job, or `null`: a quick fix is queued or running and is
   * changing the preview (quick fixes, QF3). Default: never.
   */
  reviewBlock?: (job: Job) => string | null;
}

/** What the poster route answers when there is no frame to show. */
export const NO_POSTER_MESSAGE = 'This preview has no poster.';

/** What the export file route answers when there is no current export. */
export const NO_REVIEW_EXPORT_MESSAGE = 'This job has no exported video yet.';

/** What the small-video routes answer when there is none to make. */
export const NO_PREVIEW_VIDEO_MESSAGE = 'This preview has no video.';

/** What the export routes answer to `?format=` naming a size the job does not have (C65). */
export const NO_EXPORT_FORMAT_MESSAGE = 'This job has no such format.';

/**
 * Which format a `?format=<id>` of the export routes asks for (Formats, C65): `undefined` is the
 * main format, whether the query is absent or names the main format's own id; otherwise the id of
 * one of the job's extra formats. `null` for any size the job does not have, so a page that is out
 * of date, or a job with one format, never gets the other size by mistake.
 */
export function exportFormatOf(job: Job, requested: string | undefined): string | undefined | null {
  if (requested === undefined || requested === '') return undefined;
  if (job.formats?.[0]?.id === requested) return undefined;
  return extraFormatsOf(job.formats).some((format) => format.id === requested) ? requested : null;
}

export function createPreviewRoutes({
  jobs,
  inboxPath,
  posters,
  videos,
  exports,
  reviewBlock,
}: PreviewRouteOptions): Hono {
  const routes = new Hono();

  // Formats (GN7): `/:id/preview/1x1/index.html` is the extra format's composition. A first segment
  // that is not one of the job's extra formats is a path of the main preview: this hands the request
  // on to the route below, which serves it exactly as it always did.
  routes.get('/:id/preview/:format/:path{.+}', async (c, next) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);

    const format = extraFormatsOf(job.formats).find((one) => one.id === c.req.param('format'));
    if (format === undefined) {
      await next();
      return;
    }
    const root = await findPreviewRoot(
      join(inboxPath, job.relPath),
      extraPreviewDirPath(format.id),
    );
    if (root === null) return c.json({ error: NO_PREVIEW_MESSAGE }, 404);

    return serveCompositionFile(c, {
      root,
      name: c.req.param('path'),
      missingMessage: PREVIEW_FILE_MISSING_MESSAGE,
    });
  });

  // `:path{.+}` is the rest of the URL, slashes included, percent-decoded once by Hono.
  // Hono answers HEAD with this GET handler; serveFile then sends the headers only.
  routes.get('/:id/preview/:path{.+}', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);

    const root = await findPreviewRoot(join(inboxPath, job.relPath));
    if (root === null) return c.json({ error: NO_PREVIEW_MESSAGE }, 404);

    return serveCompositionFile(c, {
      root,
      name: c.req.param('path'),
      missingMessage: PREVIEW_FILE_MISSING_MESSAGE,
    });
  });

  routes.get('/:id/preview-poster', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);

    let path: string | null = null;
    try {
      path = (await posters?.posterFor(job)) ?? null;
    } catch (err) {
      if (!(err instanceof StillError)) throw err;
      logger.warn({ err, jobId: id }, 'could not make the poster of a preview');
      return c.json({ error: err.message }, 500);
    }
    if (path === null) return c.json({ error: NO_POSTER_MESSAGE }, 404);
    return serveFile(c, {
      path,
      contentType: 'image/jpeg',
      disposition: 'inline',
      missingMessage: NO_POSTER_MESSAGE,
      cache: 'revalidate',
    });
  });

  // The small MP4 of the preview (the phone's Review). The status never waits for the render:
  // `making` until it is there, then `ready`; `failed` carries the reason and the phone falls back
  // to the live player. The file itself: inline for the player, `?download=1` as a download.
  routes.get('/:id/preview-video', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    if (videos === undefined) return c.json({ error: NO_PREVIEW_VIDEO_MESSAGE }, 404);
    const status = await videos.statusFor(job);
    if (status.state === 'none') return c.json({ error: NO_PREVIEW_VIDEO_MESSAGE }, 404);
    return c.json(status.state === 'ready' ? { state: 'ready' } : status, 200, {
      'Cache-Control': 'no-store',
    });
  });

  routes.get('/:id/preview-video.mp4', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const status = (await videos?.statusFor(job)) ?? { state: 'none' };
    if (status.state !== 'ready') return c.json({ error: NO_PREVIEW_VIDEO_MESSAGE }, 404);
    return serveFile(c, {
      path: status.path,
      contentType: 'video/mp4',
      disposition:
        c.req.query('download') === undefined
          ? 'inline'
          : { attachment: `${job.name} (preview).mp4` },
      missingMessage: NO_PREVIEW_VIDEO_MESSAGE,
      cache: 'revalidate',
    });
  });

  // The full-quality MP4 (Export MP4 in Review): POST starts the render and answers its status
  // (`making`; `ready` when a current one exists); GET answers the status without starting; the
  // .mp4 is the file, saved as `<job>.mp4`. A new round makes a ready one stale (`idle`). POST answers
  // 409 while a quick fix is queued or running for the job (`reviewBlock`).
  //
  // Formats (C65): on a job with two or more, `?format=1x1` is the export of that extra format (its
  // own status, its own file, saved as `<job> (1x1).mp4`); no `format`, or the main format's id, is
  // the main format's, exactly as before. A size the job does not have answers 404.
  routes.post('/:id/review-export', async (c) => {
    const job = jobs.get(c.req.param('id'));
    if (job === null) return c.json({ error: `Job ${c.req.param('id')} not found` }, 404);
    if (exports === undefined) return c.json({ error: NO_PREVIEW_VIDEO_MESSAGE }, 404);
    const format = exportFormatOf(job, c.req.query('format'));
    if (format === null) return c.json({ error: NO_EXPORT_FORMAT_MESSAGE }, 404);
    // The video would be made from files a quick fix is still changing.
    const blocked = reviewBlock?.(job);
    if (blocked !== null && blocked !== undefined) return c.json({ error: blocked }, 409);
    const status = await exports.start(job, format);
    if (status.state === 'none') return c.json({ error: NO_PREVIEW_MESSAGE }, 404);
    return c.json(status.state === 'ready' ? { state: 'ready' } : status, 200, {
      'Cache-Control': 'no-store',
    });
  });

  routes.get('/:id/review-export', async (c) => {
    const job = jobs.get(c.req.param('id'));
    if (job === null) return c.json({ error: `Job ${c.req.param('id')} not found` }, 404);
    if (exports === undefined) return c.json({ error: NO_PREVIEW_VIDEO_MESSAGE }, 404);
    const format = exportFormatOf(job, c.req.query('format'));
    if (format === null) return c.json({ error: NO_EXPORT_FORMAT_MESSAGE }, 404);
    const status = await exports.statusFor(job, format);
    if (status.state === 'none') return c.json({ error: NO_PREVIEW_MESSAGE }, 404);
    return c.json(status.state === 'ready' ? { state: 'ready' } : status, 200, {
      'Cache-Control': 'no-store',
    });
  });

  routes.get('/:id/review-export.mp4', async (c) => {
    const job = jobs.get(c.req.param('id'));
    if (job === null) return c.json({ error: `Job ${c.req.param('id')} not found` }, 404);
    const format = exportFormatOf(job, c.req.query('format'));
    if (format === null) return c.json({ error: NO_EXPORT_FORMAT_MESSAGE }, 404);
    const status = (await exports?.statusFor(job, format)) ?? { state: 'none' };
    if (status.state !== 'ready') return c.json({ error: NO_REVIEW_EXPORT_MESSAGE }, 404);
    return serveFile(c, {
      path: status.path,
      contentType: 'video/mp4',
      disposition: { attachment: reviewExportFileName(job.name, format) },
      missingMessage: NO_REVIEW_EXPORT_MESSAGE,
      cache: 'revalidate',
    });
  });

  return routes;
}
