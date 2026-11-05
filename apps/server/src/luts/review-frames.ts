// The look on the paused frame in Review (LUTs build 2, LU11). OWNER: LU11.
//
//   GET /api/jobs/:id/review/frame?t=12.3&lut=cinematic    a JPEG of the preview at 12.3 s, with the look
//   GET /api/jobs/:id/review/frame?t=12.3                  the same frame, plain (Compare)
//
// Where the frames come from. A review round has three candidates:
//   - the live composition (edit/preview/index.html): a still of it means starting a browser
//     (`hyperframes snapshot`), several seconds per frame;
//   - the poster (edit/poster.jpg): only the first frame of the first clip;
//   - the small MP4 of the preview (edit/preview-lite.mp4, 540 px wide): the engine already renders
//     it from the real composition (graphics, captions, music) as soon as a job reaches Review, for
//     the phone, and keeps it for the round (clients/preview-video.ts).
// The MP4 is the simplest honest source: it is the round's own picture, and one ffmpeg run takes
// a frame from it in a fraction of a second. Its price is its size (540 px wide, draft quality), so
// the still is softer than the live player; it is a preview of the colour, not of the sharpness.
// While the MP4 is still being rendered (the first minutes of a round) there is no frame to give.
//
// One run takes the frame and, for a look, runs it through `lut3d` (tetrahedral, as the LUTs page
// does; Cinematic through its baked cube). The answer is cached by (job, round, the MP4's age, the
// time to a tenth of a second, the LUT's file hash), so the same pause is free the second time and a
// changed LUT file or a new round never shows an old frame. A job keeps the frames of its newest
// preview only: the first frame of a new one removes the folders of the old ones.
//
// The fake engine (`runner: fake`) needs no ffmpeg: the plain frame is the LUTs page's test photo and
// the look is its flat -log twin (a visibly different picture), as the fake LUT stills are.

import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Job, LUT_MESSAGES } from '@studio/shared';
import type { PreviewVideos } from '../clients/preview-video.js';
import type { Config } from '../config.js';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import { PREVIEW_DIR_PATH } from '../pipeline/preview-files.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { resolveInside } from '../routes/download.js';
import { lutFramePath } from './lut-frames.js';
import { lutPreviewKey, type PreviewSource, runFfmpeg } from './lut-previews.js';
import { createStillQueue } from './lut-still-queue.js';

/** What is asked of the maker: a frame of the job's newest preview. */
export interface ReviewFrameRequest {
  job: Job;
  /** The frame's time in tenths of a second (the route rounds to the nearest). */
  tenths: number;
  /** The look to run it through; `null` is the plain frame. A Camera LUT never gets here. */
  lut: PreviewSource | null;
  /** The round asked for; `null` is the newest. Only the newest round has a preview. */
  round: number | null;
}

export type ReviewFrameResult =
  | { ok: true; path: string; etag: string }
  | { ok: false; status: 404 | 500; error: string };

export interface ReviewFrames {
  frameFor(request: ReviewFrameRequest): Promise<ReviewFrameResult>;
}

/** `<data>/review-frames`: where the frames are kept, one folder per job and preview. */
export function reviewFramesRoot(dataDir: string): string {
  return join(dataDir, 'review-frames');
}

const notThere = (error: string): ReviewFrameResult => ({ ok: false, status: 404, error });

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The frame's name inside its preview's folder: `t123.jpg`, or `t123-<look>.jpg`. */
function frameName(tenths: number, lut: PreviewSource | null): string {
  return lut === null ? `t${tenths}.jpg` : `t${tenths}-${lutPreviewKey(lut.key, lut.sha256)}.jpg`;
}

/** Keeps the frames of a job's newest preview only: the first ask for a new one clears the others. */
function createPruner(dataDir: string): (jobId: string, generation: string) => Promise<void> {
  const current = new Map<string, string>();
  return async (jobId, generation) => {
    if (current.get(jobId) === generation) return;
    current.set(jobId, generation);
    const folder = join(reviewFramesRoot(dataDir), jobId);
    try {
      for (const name of await readdir(folder)) {
        if (name !== generation) await rm(join(folder, name), { recursive: true, force: true });
      }
    } catch {
      // No folder yet, or it is going: nothing to clear.
    }
  };
}

/** The shared half of both makers: the answer's path and tag, and the cache check. */
async function cached(
  dataDir: string,
  prune: (jobId: string, generation: string) => Promise<void>,
  request: ReviewFrameRequest,
  generation: string,
  make: (outPath: string) => Promise<void>,
  run: <T>(key: string, work: () => Promise<T>) => Promise<T>,
  fail: (err: unknown) => ReviewFrameResult,
): Promise<ReviewFrameResult> {
  const { job, tenths, lut } = request;
  const name = frameName(tenths, lut);
  const outPath = join(reviewFramesRoot(dataDir), job.id, generation, name);
  const etag = `"${generation}/${name}"`;
  if (await exists(outPath)) return { ok: true, path: outPath, etag };
  await prune(job.id, generation);
  try {
    await run(outPath, async () => {
      if (await exists(outPath)) return;
      await mkdir(join(reviewFramesRoot(dataDir), job.id, generation), { recursive: true });
      await make(outPath);
    });
  } catch (err) {
    return fail(err);
  }
  return { ok: true, path: outPath, etag };
}

// --- the real maker --------------------------------------------------------------------------------

export interface ReviewFramesOptions {
  /** `<data>`, whose `review-frames/` is the cache. */
  dataDir: string;
  /** The engine's small preview videos: the frames are taken from the one of the job's round. */
  videos: Pick<PreviewVideos, 'statusFor'>;
  ffmpegBin?: string;
  logger?: WorkerLogger;
  /** How long one ffmpeg run may take. Default 20 s. */
  timeoutMs?: number;
  /** How many ffmpeg runs go at a time. Default 2. */
  concurrency?: number;
}

/** The real maker for `claude`, the fake one for `fake` (as the LUT stills pick theirs). */
export function createReviewFrames(
  config: Pick<Config, 'runner' | 'dataDir' | 'inboxPath'>,
  options: Partial<ReviewFramesOptions> & Pick<ReviewFramesOptions, 'videos'>,
): ReviewFrames {
  if (config.runner === 'fake') {
    return createFakeReviewFrames({
      dataDir: config.dataDir,
      inboxPath: config.inboxPath,
      logger: options.logger,
    });
  }
  return createRealReviewFrames({ dataDir: config.dataDir, ...options });
}

/**
 * The ffmpeg maker: one run per frame, `-ss` before `-i` (a seek, not a decode of the whole video),
 * through `lut3d` when there is a look. The cube is copied to the generated name `lut.cube` in a
 * private work folder, so no file name of the owner's reaches a filter string. A time past the end of
 * the video gives no frame; the last one is taken then.
 */
export function createRealReviewFrames(options: ReviewFramesOptions): ReviewFrames {
  const { dataDir, videos, ffmpegBin = 'ffmpeg', logger, timeoutMs = 20_000 } = options;
  const queue = createStillQueue(options.concurrency ?? 2);
  const prune = createPruner(dataDir);

  async function grab(
    bin: string,
    video: string,
    atSec: number,
    lut: PreviewSource | null,
    outPath: string,
  ): Promise<void> {
    const scratch = join(reviewFramesRoot(dataDir), '.work');
    await mkdir(scratch, { recursive: true });
    const work = await mkdtemp(join(scratch, 'run-'));
    try {
      if (lut !== null) {
        if (lut.cubePath === null) throw new Error('the LUT has no file to run');
        await copyFile(lut.cubePath, join(work, 'lut.cube'), constants.COPYFILE_FICLONE);
      }
      const filter = lut === null ? [] : ['-vf', 'lut3d=file=lut.cube:interp=tetrahedral'];
      const take = (seek: string[]) =>
        runFfmpeg(
          bin,
          [
            '-v',
            'error',
            '-y',
            ...seek,
            '-i',
            video,
            '-frames:v',
            '1',
            ...filter,
            '-q:v',
            '3',
            'out.jpg',
          ],
          work,
          timeoutMs,
          'now',
        );
      try {
        await take(['-ss', atSec.toFixed(1)]);
      } catch {
        // Past the end of the video ffmpeg finds no frame and fails. Take the last one instead
        // (if the video itself is the trouble, this fails too and the error is its).
      }
      if (!(await exists(join(work, 'out.jpg')))) await take(['-sseof', '-0.2']);
      await rename(join(work, 'out.jpg'), outPath);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  return {
    async frameFor(request) {
      const { job, tenths, lut, round } = request;
      if (round !== null && round !== job.round) return notThere(LUT_MESSAGES.frameNoPreview);
      const status = await videos.statusFor(job);
      if (status.state === 'none' || status.state === 'failed') {
        return notThere(LUT_MESSAGES.frameNoPreview);
      }
      if (status.state === 'making') return notThere(LUT_MESSAGES.frameMaking);

      let generation: string;
      try {
        const info = await stat(status.path);
        generation = `${job.round}-${Math.round(info.mtimeMs)}-${info.size}`;
      } catch {
        return notThere(LUT_MESSAGES.frameNoPreview);
      }
      const bin = await resolveFfmpeg(ffmpegBin);
      return cached(
        dataDir,
        prune,
        request,
        generation,
        async (outPath) => {
          if (bin === null) throw new Error('ffmpeg was not found');
          await grab(bin, status.path, tenths / 10, lut, outPath);
        },
        (key, work) => queue.run(key, 'now', work),
        (err) => {
          logger?.warn({ err, jobId: job.id }, 'could not take a frame of the preview');
          return { ok: false, status: 500, error: LUT_MESSAGES.frameFailed };
        },
      );
    },
  };
}

// --- the fake maker --------------------------------------------------------------------------------

export interface FakeReviewFramesOptions {
  dataDir: string;
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  logger?: WorkerLogger;
}

/**
 * The fake maker: no ffmpeg, no video. The job needs a preview (its composition is there); the
 * plain frame is the test photo "person" and a look is its flat twin, so a test or the e2e can tell
 * the two apart by their bytes.
 */
export function createFakeReviewFrames(options: FakeReviewFramesOptions): ReviewFrames {
  const { dataDir, inboxPath, logger } = options;
  const queue = createStillQueue(8);
  const prune = createPruner(dataDir);
  return {
    async frameFor(request) {
      const { job, lut, round } = request;
      if (round !== null && round !== job.round) return notThere(LUT_MESSAGES.frameNoPreview);
      const composition = await resolveInside(
        join(inboxPath, job.relPath),
        join(PREVIEW_DIR_PATH, 'index.html'),
      );
      if (composition === null) return notThere(LUT_MESSAGES.frameNoPreview);
      return cached(
        dataDir,
        prune,
        request,
        `${job.round}-fake`,
        (outPath) => copyFile(lutFramePath('person', lut !== null), outPath),
        (key, work) => queue.run(key, 'now', work),
        (err) => {
          logger?.warn({ err, jobId: job.id }, 'could not make the fake frame of the preview');
          return { ok: false, status: 500, error: LUT_MESSAGES.frameFailed };
        },
      );
    },
  };
}
