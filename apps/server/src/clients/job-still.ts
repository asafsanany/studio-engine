// A finished job's still (Phase 2 plan §5, "Undo, retry and stills"): one JPEG frame of its
// export, taken at 25% of its length and 360 px wide, for the Now and New stills of the Use this
// look dialog.
//
//   <exportsDir>/<job.output.fileName>  --ffmpeg, one frame-->  <job>/edit/still.jpg
//
// The frame is made once and kept as edit/still.jpg (edit/ is the editor's workspace, which the
// inbox scan never counts). A still older than the export is made again, so a re-exported job
// shows its new video. ffmpeg writes a hidden partial file that is renamed into place, so a
// still cut short is never served.
//
// The same is done for the live preview's poster: the first frame of the video the preview's
// root composition starts with, 720 px wide, kept as edit/poster.jpg. An iPhone loads no video
// before a tap, so the phone's Review shows it until the first play (CVP: The owner, 22 Oct).
//
//   <job>/edit/preview/<the first <video> of index.html>  --ffmpeg, one frame-->  <job>/edit/poster.jpg

import { readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Job } from '@studio/shared';
import { EDIT_DIR_NAME } from '../inbox/classify.js';
import { KILL_GRACE_MS } from '../pipeline/claude-process.js';
import { resolveFfmpeg, runFfmpeg } from '../pipeline/fake-media.js';
import { PREVIEW_DIR_PATH } from '../pipeline/preview-files.js';
import { COMPOSITION_INDEX } from '../routes/composition-files.js';
import { resolveInside } from '../routes/download.js';
import { ensureEditDir } from './edit-dir.js';

/** Where the still is kept, inside the job folder. */
export const STILL_PATH = join(EDIT_DIR_NAME, 'still.jpg');

/** How wide the still is, in pixels; the height follows the video. */
export const STILL_WIDTH = 360;

/** Where in the video the frame is taken, as a share of its length. */
export const STILL_AT = 0.25;

/** Where the preview's poster is kept, inside the job folder. */
export const POSTER_PATH = join(EDIT_DIR_NAME, 'poster.jpg');

/** How wide the poster is, in pixels: sharp on a phone's screen; the height follows the video. */
export const POSTER_WIDTH = 720;

/**
 * The `src` of the first `<video>` in a composition's HTML, or null when it has none. The one that
 * starts at 0 is preferred (a later clip is not what the preview opens on). Pure.
 */
export function firstVideoSrc(html: string): string | null {
  const tags = html.match(/<video\b[^>]*>/gi) ?? [];
  const srcOf = (tag: string) => tag.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const startsAtZero = (tag: string) => /\sdata-start\s*=\s*["']0(?:\.0+)?["']/i.test(tag);
  const ordered = [...tags.filter(startsAtZero), ...tags.filter((tag) => !startsAtZero(tag))];
  for (const tag of ordered) {
    const found = srcOf(tag);
    const src = found?.[1] ?? found?.[2] ?? '';
    if (src !== '' && !/^[a-z]+:/i.test(src)) return src;
  }
  return null;
}

/** How long ffmpeg may take for one frame. */
const STILL_TIMEOUT_MS = 60_000;

/** The still could not be made although the job has an export; the route answers 500. */
export class StillError extends Error {
  override readonly name = 'StillError';
}

export interface JobStillsOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** `Config.exportsDir`: `job.output.fileName` is relative to it. */
  exportsDir: string;
  /** The ffmpeg executable: a bare name looked up on PATH, then in Homebrew's folders (default). */
  ffmpegBin?: string;
}

async function modifiedMs(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0 ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Makes and keeps the jobs' stills. One still is made at a time per job. */
export class JobStills {
  private readonly inboxPath: string;
  private readonly exportsDir: string;
  private readonly ffmpegBin: string;
  /** The frames being made, by `still:<job id>` or `poster:<job id>`. */
  private readonly making = new Map<string, Promise<string | null>>();

  constructor({ inboxPath, exportsDir, ffmpegBin = 'ffmpeg' }: JobStillsOptions) {
    this.inboxPath = inboxPath;
    this.exportsDir = exportsDir;
    this.ffmpegBin = ffmpegBin;
  }

  /**
   * The path of the job's still, made now if it is missing or older than the export. Null when
   * the job has no export (or its file is gone). Rejects with {@link StillError} when ffmpeg is
   * missing or fails.
   */
  stillFor(job: Job): Promise<string | null> {
    return this.once(`still:${job.id}`, async () => {
      if (job.output === null) return null;
      const video = await resolveInside(this.exportsDir, job.output.fileName);
      if (video === null) return null;
      const at = Math.max(0, job.output.durationSec * STILL_AT);
      return this.frame(job, { video, out: STILL_PATH, atSec: at, width: STILL_WIDTH });
    });
  }

  /**
   * The path of the preview's poster: the first frame of the video its root composition starts
   * with, made now if it is missing or older than that video. Null when the job has no preview, or
   * its composition no video. Rejects with {@link StillError} when ffmpeg is missing or fails.
   */
  posterFor(job: Job): Promise<string | null> {
    return this.once(`poster:${job.id}`, async () => {
      const root = await resolveInside(join(this.inboxPath, job.relPath), PREVIEW_DIR_PATH);
      const index = root === null ? null : await resolveInside(root, COMPOSITION_INDEX);
      if (root === null || index === null) return null;
      let html: string;
      try {
        html = await readFile(index, 'utf8');
      } catch {
        return null;
      }
      const src = firstVideoSrc(html);
      const video = src === null ? null : await resolveInside(root, decodeURI(src));
      if (video === null) return null;
      return this.frame(job, { video, out: POSTER_PATH, atSec: 0, width: POSTER_WIDTH });
    });
  }

  /** One making of a frame at a time per key: a second ask waits for the first. */
  private once(key: string, make: () => Promise<string | null>): Promise<string | null> {
    const pending = this.making.get(key);
    if (pending !== undefined) return pending;
    const made = make().finally(() => this.making.delete(key));
    this.making.set(key, made);
    return made;
  }

  /**
   * `out` (inside the job folder) as one JPEG frame of `video` at `atSec`, `width` px wide: kept
   * while it is newer than the video, made again otherwise. Null when the video is gone.
   */
  private async frame(
    job: Job,
    { video, out, atSec, width }: { video: string; out: string; atSec: number; width: number },
  ): Promise<string | null> {
    const videoMs = await modifiedMs(video);
    if (videoMs === null) return null;

    const jobDir = join(this.inboxPath, job.relPath);
    // Never make a job folder that is gone: the inbox would take it for a new job.
    if (!(await isDirectory(jobDir))) throw new StillError('The job folder is missing.');
    const still = join(jobDir, out);
    const stillMs = await modifiedMs(still);
    if (stillMs !== null && stillMs >= videoMs) return still;

    const bin = await resolveFfmpeg(this.ffmpegBin);
    if (bin === null) throw new StillError('ffmpeg was not found, so there is no still.');
    // Not recursive, and after the ffmpeg lookup: the folder may have been deleted since the check above.
    await ensureEditDir(jobDir);
    const partial = join(dirname(still), `.${basename(still)}.partial`);
    const at = atSec;
    const result = await runFfmpeg(
      { bin, signal: AbortSignal.timeout(STILL_TIMEOUT_MS), killGraceMs: KILL_GRACE_MS },
      [
        '-ss',
        at.toFixed(3),
        '-i',
        video,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-2`,
        '-q:v',
        '3',
        '-c:v',
        'mjpeg',
        '-f',
        'image2',
        '-y',
        partial,
      ],
    );
    if (result.status !== 'ok') {
      await rm(partial, { force: true });
      throw new StillError(
        result.status === 'aborted' ? 'ffmpeg took too long.' : `ffmpeg failed: ${result.message}`,
      );
    }
    await rename(partial, still);
    return still;
  }
}
