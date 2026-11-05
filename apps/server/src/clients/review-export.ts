// The full-quality MP4 of a job in Review (the owner, 23 Oct: export before Approve). The same render
// Approve would do, started on request:
//
//   <job>/edit/preview/  --hyperframes render -q delivery-->  <job>/edit/review-export.mp4
//
// The file is current while it is newer than everything in the composition's folder (index.html,
// compositions/*, the baked cut cut.mp4, music.mp3, the pictures: `newestSource`), so a revise
// round or a colour-grade round makes it stale. Approve reuses a current one: the
// render run is skipped and the file becomes edit/final.mp4 (`useReviewExport`), so nothing is
// rendered twice. `start` starts it: Export MP4 in Review does, and so does the engine as soon as a
// job reaches Review, so the video is there when the owner wants it (`ReviewWarmup`, review-warmup.ts).
//
// A video is kept only when the composition did not change while it rendered (a quick fix landing
// mid-render): its file would be newer than the sources and pass for current, so it is thrown away
// and the next ask renders again.
//
// Formats (GN7, C65): a job with more than one format has an export of each, made from that format's
// own composition when Export MP4 is pressed on it (the 9:16 | 1:1 switch of Review):
//
//   main    <job>/edit/preview/        -->  <job>/edit/review-export.mp4
//   extra   <job>/edit/preview-1x1/    -->  <job>/edit/review-export-1x1.mp4
//
// Each has its own status, staleness and failure. Only the main one is ever put at edit/final.mp4
// for Approve, and not even that for a job with more than one format: its render run makes every file.

import { copyFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extraFormatsOf, extraReviewExportName, type Job } from '@studio/shared';
import { EDIT_DIR_NAME } from '../inbox/classify.js';
import { FINAL_VIDEO_PATH } from '../pipeline/finalize.js';
import { extraPreviewDirPath, PREVIEW_DIR_PATH } from '../pipeline/preview-files.js';
import { COMPOSITION_INDEX } from '../routes/composition-files.js';
import { resolveInside } from '../routes/download.js';
import { ensureEditDir, JOB_FOLDER_GONE, JobStops } from './edit-dir.js';
import { newestSource, runHyperframesRender } from './preview-video.js';

/** Where the main format's export is kept, inside the job folder. */
export const REVIEW_EXPORT_PATH = join(EDIT_DIR_NAME, 'review-export.mp4');

/** An extra format's export (C65), `edit/review-export-1x1.mp4`, beside the main one's. */
export function extraReviewExportPath(formatId: string): string {
  return join(EDIT_DIR_NAME, extraReviewExportName(formatId));
}

/** The longest a delivery render may take. */
const RENDER_TIMEOUT_MS = 60 * 60_000;

export type ReviewExportStatus =
  | { state: 'none' }
  | { state: 'idle' }
  | { state: 'making' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; path: string };

export interface ReviewExportsOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** Renders the composition in `cwd` to `out` at delivery quality; default `npx hyperframes render`. */
  render?: (cwd: string, out: string, signal: AbortSignal) => Promise<void>;
}

/** `npx hyperframes render` at delivery quality, as the render run does. */
export function renderDelivery(cwd: string, out: string, signal: AbortSignal): Promise<void> {
  return runHyperframesRender(
    cwd,
    ['-q', 'delivery', '--strict', '--no-best-effort', '--quiet', '-o', out],
    signal,
  );
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0 ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Where one format's composition is and where its export goes, inside the job folder. */
interface ExportTarget {
  /** `preview` for the main format, `preview-1x1` for an extra one. */
  previewDir: string;
  /** The export file. */
  outPath: string;
  /** The partial file the render writes first (dot-named, so nothing counts it as an export). */
  partialPath: string;
}

function targetOf(job: Job, formatId: string | undefined): ExportTarget | null {
  if (formatId === undefined) {
    return {
      previewDir: PREVIEW_DIR_PATH,
      outPath: REVIEW_EXPORT_PATH,
      partialPath: join(EDIT_DIR_NAME, '.review-export.partial.mp4'),
    };
  }
  // Only a format the job has after its main one: anything else (the main format's id, a format the
  // job no longer has) is no export at all, so a page that is out of date never gets the wrong size.
  if (!extraFormatsOf(job.formats).some((format) => format.id === formatId)) return null;
  return {
    previewDir: extraPreviewDirPath(formatId),
    outPath: extraReviewExportPath(formatId),
    partialPath: join(EDIT_DIR_NAME, `.review-export-${formatId}.partial.mp4`),
  };
}

/** What `making` and `failed` are kept under: the job, and the extra format when it is one. */
function keyOf(jobId: string, formatId: string | undefined): string {
  return formatId === undefined ? jobId : `${jobId}:${formatId}`;
}

export class ReviewExports {
  private readonly inboxPath: string;
  private readonly render: NonNullable<ReviewExportsOptions['render']>;
  private readonly making = new Map<string, Promise<void>>();
  private readonly failed = new Map<string, { sourceMs: number; message: string }>();
  /** Stops the renders of a job that was removed (`forget`): one stop per job, every format. */
  private readonly stops = new JobStops();

  constructor({ inboxPath, render = renderDelivery }: ReviewExportsOptions) {
    this.inboxPath = inboxPath;
    this.render = render;
  }

  /**
   * Where the export is, if it is current; otherwise what is going on. Never starts a render.
   * `formatId` is an extra format's id ("1x1"); left out it is the main format's export, as it
   * always was. A format the job does not have after its main one has `none`.
   */
  async statusFor(job: Job, formatId?: string): Promise<ReviewExportStatus> {
    const target = targetOf(job, formatId);
    if (target === null) return { state: 'none' };
    const jobDir = join(this.inboxPath, job.relPath);
    const root = await resolveInside(jobDir, target.previewDir);
    if (root === null || (await resolveInside(root, COMPOSITION_INDEX)) === null) {
      return { state: 'none' };
    }
    const sourceMs = await newestSource(root);
    const out = join(jobDir, target.outPath);
    const outMs = await mtimeOf(out);
    if (outMs !== null && outMs >= sourceMs) return { state: 'ready', path: out };
    const key = keyOf(job.id, formatId);
    if (this.making.has(key)) return { state: 'making' };
    const failure = this.failed.get(key);
    if (failure !== undefined && failure.sourceMs === sourceMs) {
      return { state: 'failed', message: failure.message };
    }
    return { state: 'idle' };
  }

  /** Starts the render unless the export is current or one is already running. */
  async start(job: Job, formatId?: string): Promise<ReviewExportStatus> {
    // Before the first await: a job removed while this start is under way stops the render it starts.
    const stop = this.stops.of(job.id);
    const status = await this.statusFor(job, formatId);
    if (status.state !== 'idle' && status.state !== 'failed') return status;
    const target = targetOf(job, formatId);
    if (target === null) return { state: 'none' };
    const jobDir = join(this.inboxPath, job.relPath);
    const root = await resolveInside(jobDir, target.previewDir);
    if (root === null) return { state: 'none' };
    const sourceMs = await newestSource(root);
    const key = keyOf(job.id, formatId);
    this.failed.delete(key);
    const made = this.make(jobDir, root, target, sourceMs, stop)
      .catch((error: unknown) => {
        // Stopped because the job was removed: that says nothing about the next video of the name.
        if (stop.aborted) return;
        this.failed.set(key, {
          sourceMs,
          message: error instanceof Error ? error.message : 'the video could not be made',
        });
      })
      .finally(() => this.making.delete(key));
    this.making.set(key, made);
    return { state: 'making' };
  }

  /**
   * The job was removed (Delete, a client removed, its folder gone): a render being made for it, of
   * any format, is killed, and nothing is written into the job's folder again.
   */
  forget(jobId: string): void {
    this.stops.forget(jobId);
    for (const key of [...this.failed.keys()]) {
      if (key === jobId || key.startsWith(`${jobId}:`)) this.failed.delete(key);
    }
  }

  /** Resolves when the job's export (of this extra format, or the main one) is no longer being made (tests). */
  idle(jobId: string, formatId?: string): Promise<void> {
    return this.making.get(keyOf(jobId, formatId)) ?? Promise.resolve();
  }

  /**
   * Approve's shortcut: when a current export exists, copies it to edit/final.mp4 and returns true,
   * so the render run is not needed. False when there is none. An export that is still being made
   * (it starts by itself in Review) is waited for, so the same video is not rendered a second time
   * beside it; `signal` (the run's: Cancel or shutdown) ends that wait with false.
   */
  async useFor(job: Job, signal?: AbortSignal): Promise<boolean> {
    // Formats (GN7): this export is the main format only, so a job with more than one format
    // always gets its render run, which makes a video of each.
    if (extraFormatsOf(job.formats).length > 0) return false;
    let status = await this.statusFor(job);
    if (status.state === 'making') {
      await untilAborted(this.idle(job.id), signal);
      if (signal?.aborted) return false;
      status = await this.statusFor(job);
    }
    if (status.state !== 'ready') return false;
    const target = join(this.inboxPath, job.relPath, FINAL_VIDEO_PATH);
    const partial = `${target}.partial`;
    try {
      await copyFile(status.path, partial);
      await rename(partial, target);
      return true;
    } finally {
      await rm(partial, { force: true });
    }
  }

  private async make(
    jobDir: string,
    root: string,
    target: ExportTarget,
    sourceMs: number,
    stop: AbortSignal,
  ): Promise<void> {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(RENDER_TIMEOUT_MS)]);
    // The job was removed while this waited. Checked in the same turn as the mkdir: while Delete
    // empties the folder it is still there, so a mkdir alone would make `edit/` again.
    if (stop.aborted) throw new Error(JOB_FOLDER_GONE);
    // Not recursive: a job whose folder is already gone must not get it back either.
    await ensureEditDir(jobDir);
    if (stop.aborted) throw new Error(JOB_FOLDER_GONE);
    const out = join(jobDir, target.outPath);
    const partial = join(jobDir, target.partialPath);
    try {
      await this.render(root, partial, signal);
      // The composition changed while it rendered: this video is of the old one.
      if ((await newestSource(root)) > sourceMs) return;
      await rename(partial, out);
    } finally {
      await rm(partial, { force: true });
    }
  }
}

/** Resolves when `promise` does, or when `signal` aborts. `promise` must not reject. */
function untilAborted(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    void promise.then(done);
  });
}
