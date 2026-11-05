// The small MP4 of a job's live preview, for the phone's Review (the owner, 23 Oct: the live player lags
// on the phone). The engine renders the real composition (graphics, captions, music) once per
// round, then shrinks it:
//
//   <job>/edit/preview/  --hyperframes render -q draft-->  <job>/edit/.preview-full.partial.mp4
//                        --ffmpeg 540 px wide, CRF 28-->    <job>/edit/preview-lite.mp4
//
// The file is kept in edit/ and is current while it is newer than everything in edit/preview/
// (index.html, compositions/*, the baked cut cut.mp4, the music, the pictures: `newestSource`); a
// revise round or a colour-grade round changes those, so the next ask makes it again. Asking never waits for the render: it starts one (one at a time per job) and
// answers `making`; the phone asks again until `ready`. A failed render is remembered for the
// round (`failed`, with its message) so the phone falls back to the live player and does not loop.
// A video of a composition that changed while it rendered (a quick fix landing mid-render) is
// thrown away, since its file would be newer than the sources and pass for current.

import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, rename, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { Job } from '@studio/shared';
import { EDIT_DIR_NAME } from '../inbox/classify.js';
import { extraBinDirs } from '../pipeline/claude-bin.js';
import { KILL_GRACE_MS } from '../pipeline/claude-process.js';
import { resolveFfmpeg, runFfmpeg } from '../pipeline/fake-media.js';
import { PREVIEW_DIR_PATH } from '../pipeline/preview-files.js';
import { COMPOSITION_INDEX } from '../routes/composition-files.js';
import { resolveInside } from '../routes/download.js';
import { ensureEditDir, JOB_FOLDER_GONE, JobStops } from './edit-dir.js';

/** Where the small video is kept, inside the job folder. */
export const PREVIEW_VIDEO_PATH = join(EDIT_DIR_NAME, 'preview-lite.mp4');

/** How wide the small video is, in pixels. */
export const PREVIEW_VIDEO_WIDTH = 540;

/** The longest a render plus the shrink may take. */
const MAKE_TIMEOUT_MS = 20 * 60_000;

export type PreviewVideoStatus =
  | { state: 'none' }
  | { state: 'making' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; path: string };

export interface PreviewVideosOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  ffmpegBin?: string;
  /** Renders the composition in `cwd` to `out`; default `npx hyperframes render`. */
  render?: (cwd: string, out: string, signal: AbortSignal) => Promise<void>;
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0 ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * The newest change among the files the preview is made of: every file in the folder, the baked
 * cut (cut.mp4, which a colour-grade round rewrites without touching index.html), the music, the
 * sounds and the pictures included. Dot-names are not part of it: `.hyperframes/` is what a render
 * itself writes there, and `.DS_Store` is Finder's.
 */
export async function newestSource(root: string): Promise<number> {
  let newest = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else newest = Math.max(newest, (await mtimeOf(path)) ?? 0);
    }
  };
  await walk(root);
  return newest;
}

/** `npx hyperframes render` in `cwd`: a draft-quality 24 fps render to `out`. */
export function renderWithHyperframes(
  cwd: string,
  out: string,
  signal: AbortSignal,
): Promise<void> {
  return runHyperframesRender(cwd, ['-q', 'draft', '-f', '24', '--quiet', '-o', out], signal);
}

/** `npx hyperframes render <args>` in `cwd`; rejects with the tail of its stderr when it fails. */
export function runHyperframesRender(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Already stopped (the job was removed): an abort that came before the listener never fires.
    if (signal.aborted) {
      reject(new Error('the render was stopped'));
      return;
    }
    const home = process.env.HOME ?? '';
    const path = [...(process.env.PATH ?? '').split(delimiter), ...extraBinDirs(home)].join(
      delimiter,
    );
    const child = spawn('npx', ['hyperframes', 'render', ...args], {
      cwd,
      env: { ...process.env, PATH: path },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-600);
    });
    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) =>
      reject(new Error(`could not start hyperframes: ${error.message}`)),
    );
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else {
        const detail = stderr.trim();
        reject(new Error(`the render failed (${code})${detail === '' ? '' : `: ${detail}`}`));
      }
    });
  });
}

export class PreviewVideos {
  private readonly inboxPath: string;
  private readonly ffmpegBin: string;
  private readonly render: NonNullable<PreviewVideosOptions['render']>;
  private readonly making = new Map<string, Promise<void>>();
  /** Stops a make whose job was removed (`forget`). */
  private readonly stops = new JobStops();
  /** A failure, kept until the preview changes, by job id. */
  private readonly failed = new Map<string, { sourceMs: number; message: string }>();

  constructor({
    inboxPath,
    ffmpegBin = 'ffmpeg',
    render = renderWithHyperframes,
  }: PreviewVideosOptions) {
    this.inboxPath = inboxPath;
    this.ffmpegBin = ffmpegBin;
    this.render = render;
  }

  /** The video if it is current; otherwise starts making it and says so. */
  async statusFor(job: Job): Promise<PreviewVideoStatus> {
    // Before the first await: a job removed while this ask is under way stops the make it starts.
    const stop = this.stops.of(job.id);
    const jobDir = join(this.inboxPath, job.relPath);
    const root = await resolveInside(jobDir, PREVIEW_DIR_PATH);
    if (root === null || (await resolveInside(root, COMPOSITION_INDEX)) === null) {
      return { state: 'none' };
    }
    const sourceMs = await newestSource(root);
    const out = join(jobDir, PREVIEW_VIDEO_PATH);
    const outMs = await mtimeOf(out);
    if (outMs !== null && outMs >= sourceMs) return { state: 'ready', path: out };
    if (this.making.has(job.id)) return { state: 'making' };
    const failure = this.failed.get(job.id);
    if (failure !== undefined && failure.sourceMs === sourceMs) {
      return { state: 'failed', message: failure.message };
    }

    const made = this.make(jobDir, root, out, sourceMs, stop)
      .then(() => {
        this.failed.delete(job.id);
      })
      .catch((error: unknown) => {
        // Stopped because the job was removed: that says nothing about the next video of the name.
        if (stop.aborted) return;
        this.failed.set(job.id, {
          sourceMs,
          message: error instanceof Error ? error.message : 'the preview video could not be made',
        });
      })
      .finally(() => this.making.delete(job.id));
    this.making.set(job.id, made);
    return { state: 'making' };
  }

  /**
   * The job was removed (Delete, a client removed, its folder gone): a video being made for it stops
   * at once, a render it started is killed, and nothing is written into the job's folder again.
   */
  forget(jobId: string): void {
    this.stops.forget(jobId);
    this.failed.delete(jobId);
  }

  /** Resolves when the job's video is no longer being made (tests). */
  idle(jobId: string): Promise<void> {
    return this.making.get(jobId) ?? Promise.resolve();
  }

  private async make(
    jobDir: string,
    root: string,
    out: string,
    sourceMs: number,
    stop: AbortSignal,
  ): Promise<void> {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(MAKE_TIMEOUT_MS)]);
    const ffmpeg = await resolveFfmpeg(this.ffmpegBin);
    if (ffmpeg === null) throw new Error('ffmpeg was not found');
    // The job was removed while ffmpeg was being found. Checked in the same turn as the mkdir: while
    // Delete empties the folder it is still there, so a mkdir alone would make `edit/` again.
    if (stop.aborted) throw new Error(JOB_FOLDER_GONE);
    // Not recursive: a job whose folder is already gone must not get it back either.
    await ensureEditDir(jobDir);
    if (stop.aborted) throw new Error(JOB_FOLDER_GONE);
    const full = join(dirname(out), '.preview-full.partial.mp4');
    const small = join(dirname(out), '.preview-lite.partial.mp4');
    try {
      await this.render(root, full, signal);
      const result = await runFfmpeg({ bin: ffmpeg, signal, killGraceMs: KILL_GRACE_MS }, [
        '-i',
        full,
        '-vf',
        `scale=${PREVIEW_VIDEO_WIDTH}:-2`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        '-y',
        small,
      ]);
      if (result.status !== 'ok') {
        throw new Error(result.status === 'aborted' ? 'it took too long' : result.message);
      }
      if ((await newestSource(root)) > sourceMs) return;
      await rename(small, out);
    } finally {
      await rm(full, { force: true });
      await rm(small, { force: true });
    }
  }
}
