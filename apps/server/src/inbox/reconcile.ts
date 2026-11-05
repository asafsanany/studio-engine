import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { extraFormatsOf, type Job } from '@studio/shared';
import type { JobRepository } from '../db/index.js';
import { sameInputs } from '../db/mapping.js';
import type { EventBus } from '../events/bus.js';
import { extraPreviewIndexPath, PREVIEW_INDEX_PATH } from '../pipeline/preview-files.js';
import type { DurationCache } from './probe.js';
import { scanInbox } from './scan.js';
import { FOLDER_REMOVED_ERROR, type WatcherLogger } from './watcher.js';

// Startup reconciliation (architecture §3, W3). The engine can be off while files are copied in,
// moved out or deleted, and it can die in the middle of an edit. Before the watcher starts, this
// brings the database in line with the disk so that after a restart the list matches the folders
// and nothing is lost or stuck:
//
//   full scan (W1) ─▶ compare with the jobs we know ─▶ apply the rules below ─▶ summary
//
//   folder is new                          -> arriving (its settle timer starts now)
//   files changed (counts or size)         -> back to arriving (queued/arriving: timer restarts;
//                                             held: stays held, remembers the change)
//   folder is gone                         -> the job is removed
//   arriving and quiet for `settleMs`      -> queued (the watcher would have settled it)
//   ready but its export file is gone      -> failed at Render, "Exported file is missing"
//   review but edit/preview/index.html gone -> failed at Preview, "Preview is missing"
//   editing and its folder is gone         -> failed, "Folder was removed" (as the watcher does)
//   editing, folder still there            -> LEFT AS IT IS, on purpose: see below
//
// A job the engine was editing when it died stays `editing`. The state machine has no
// editing -> queued edge and does not need one: the queue worker (E2) reads `getEditing()` when
// it starts and runs those jobs first, in `resume` mode, without a START. So "queued at the front
// of the line with a resume flag" is what the worker already does with a job left `editing`;
// moving it here would only get in its way. (Orchestrator decision on CVP-56.)
//
// Everything goes through `JobRepository` (so through the shared state machine) and every change
// is published on the bus as `job.upsert` / `job.remove`. Nothing is listening at boot yet, the
// watcher included: it arms the settle timers itself from the database afterwards (`armAll`).
//
// Not knowing is not the same as a job being gone: a folder the scan could not read is left
// alone, and a missing inbox stops the reconciliation before it touches anything.

/** What reconciliation did, in jobs. Each job in the database afterwards is counted exactly once. */
export interface ReconcileSummary {
  /** New folders on disk: now `arriving`. */
  created: number;
  /** Jobs whose files changed while the engine was away (queued ones went back to `arriving`). */
  changed: number;
  /** Jobs whose folder is gone: dropped from the list. Not counted in the others. */
  removed: number;
  /** `arriving` jobs that were quiet long enough: now `queued`. */
  settled: number;
  /** `ready` jobs whose export file is gone: now `failed` at Render. */
  failedMissingExport: number;
  /** `review` jobs whose edit/preview/index.html is gone: now `failed` at Preview. */
  failedMissingPreview: number;
  /** `editing` jobs whose folder is gone: now `failed`. */
  failedFolderRemoved: number;
  /** `editing` jobs left as they are, for the queue worker to resume. */
  resuming: number;
  /** Everything else: nothing to do. */
  unchanged: number;
}

/** The repository methods reconciliation uses. */
export type ReconcileRepository = Pick<
  JobRepository,
  'get' | 'getAll' | 'upsertFromScan' | 'applyTransition' | 'remove'
>;

export interface ReconcileOptions {
  /** The inbox root, `Config.inboxPath`. It must exist. */
  inboxPath: string;
  /** The exports folder, `Config.exportsDir`: skipped by the scan, and where `ready` jobs' files are. */
  exportsDir: string;
  /**
   * How long an `arriving` job must have been quiet to be queued, `Config.settleMs`. This is the
   * same value the watcher's timers use and the one the repository derives `settlesAt` from (the
   * engine passes it to both).
   */
  settleMs: number;
  repo: ReconcileRepository;
  bus: EventBus;
  /** The time. Defaults to the system clock; tests pass the fake they gave the repository. */
  clock?: () => Date;
  /** Where footage lengths are probed and remembered. Defaults to W1's shared cache (ffprobe on PATH). */
  durations?: DurationCache;
  logger?: WatcherLogger;
  /**
   * Called after an `editing` job lost its folder and was marked failed, like the watcher's hook
   * of the same name: the boot wiring asks the worker (E2) to stop a run already in progress.
   */
  onFolderRemovedWhileEditing?: (job: Job) => void;
  /**
   * The series name rule (Series plan §2, `assignSeries` in clients/series-assign.ts), run on a job
   * when it is first found and when it settles. It answers the job as it is afterwards, which is
   * what gets published. Left out, jobs keep their series.
   */
  assignSeries?: (job: Job) => Job;
  /**
   * The Generate switch (`Config.generate`): passed to the scan, where it keeps the videos under a
   * job's `reference/` folder out of its footage (`ScanOptions.generate`). Left out, off.
   */
  generate?: boolean;
}

/** What happened to a job, for the summary. Jobs not in the map are `resuming` or `unchanged`. */
type Handled =
  | 'created'
  | 'changed'
  | 'settled'
  | 'failedMissingExport'
  | 'failedMissingPreview'
  | 'failedFolderRemoved';

const silentLogger: WatcherLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A path in a form that compares equal across NFC/NFD spellings. */
function pathKey(path: string): string {
  return resolve(path).normalize('NFC');
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

type FileState = 'present' | 'missing' | 'unknown';

/** Whether `path` is a file. */
async function fileState(path: string): Promise<FileState> {
  try {
    return (await stat(path)).isFile() ? 'present' : 'missing';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Gone, or a part of the path is not a folder. Anything else (permissions, a drive that went
    // away) does not say the file is gone.
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
  }
}

/** The worst of the states, for a job that has several files to check: missing, then unknown. */
function worstOf(states: readonly FileState[]): FileState {
  if (states.includes('missing')) return 'missing';
  return states.includes('unknown') ? 'unknown' : 'present';
}

/**
 * Whether the export of a `ready` job is a file in the exports folder. A job with more than one
 * format (GN7) has a file for each, and one that is gone makes the export missing.
 */
async function checkExport(exportsDir: string, job: Job): Promise<FileState> {
  if (job.output === null) return 'missing';
  const names = [job.output.fileName, ...(job.output.outputs ?? []).map((one) => one.fileName)];
  const states = await Promise.all(names.map((name) => fileState(resolve(exportsDir, name))));
  return worstOf(states);
}

/**
 * Whether a `review` job's composition (edit/preview/index.html) is a file in its folder, and, for
 * a job with more than one format (GN7), the composition of each extra format too.
 */
async function checkPreview(inbox: string, job: Job): Promise<FileState> {
  const paths = [
    PREVIEW_INDEX_PATH,
    ...extraFormatsOf(job.formats).map((format) => extraPreviewIndexPath(format.id)),
  ];
  const states = await Promise.all(paths.map((path) => fileState(join(inbox, job.relPath, path))));
  return worstOf(states);
}

/**
 * Brings the jobs in the repository in line with the inbox on disk and returns what it did.
 * Run it once at boot, before the watcher starts. Throws when the inbox folder does not exist
 * or cannot be read, before any job is touched; a failure on one job is logged and the others
 * are still reconciled.
 */
export async function reconcile(options: ReconcileOptions): Promise<ReconcileSummary> {
  const { inboxPath, exportsDir, settleMs, repo, bus, durations, onFolderRemovedWhileEditing } =
    options;
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger ?? silentLogger;
  const assignSeries = options.assignSeries ?? ((job: Job) => job);
  const inbox = resolve(inboxPath);

  if (!(await isDirectory(inbox))) throw new Error(`The inbox folder does not exist: ${inbox}`);

  const skipped: string[] = [];
  const scanned = await scanInbox(inbox, {
    exportsDir,
    durations,
    generate: options.generate,
    onSkip: (path, error) => {
      skipped.push(pathKey(path));
      logger.warn({ path, err: error }, 'skipped a folder that could not be read');
    },
  });
  const onDisk = new Set(scanned.map((scan) => scan.id));

  /** A job whose folder could not be read: the scan says nothing reliable about it. */
  const isUnreadable = (job: Job): boolean => {
    const client = pathKey(join(inbox, job.client));
    const folder = pathKey(join(inbox, job.relPath));
    return skipped.some(
      (path) => path === client || path === folder || path.startsWith(`${folder}${sep}`),
    );
  };

  const handled = new Map<string, Handled>();
  let removed = 0;

  /** One job's worth of work; whatever goes wrong with it must not stop the others. */
  const guarded = (jobId: string, work: () => void): void => {
    try {
      work();
    } catch (error) {
      logger.error({ jobId, err: error }, 'could not reconcile the job');
    }
  };
  const publishUpsert = (job: Job): void => bus.publish({ type: 'job.upsert', job });

  // 1. Folders on disk: new ones arrive, changed ones start over.
  for (const scan of scanned) {
    guarded(scan.id, () => {
      const before = repo.get(scan.id);
      if (before !== null && isUnreadable(before)) {
        logger.warn({ jobId: before.id, relPath: before.relPath }, 'job folder unreadable; kept');
        return;
      }

      const { job: upserted, outcome } = repo.upsertFromScan(scan);
      let job = upserted;
      if (before === null) {
        logger.info({ jobId: job.id, relPath: job.relPath }, 'new job folder found');
        handled.set(job.id, 'created');
        job = assignSeries(job);
      } else if (!sameInputs(before.inputs, job.inputs) || before.sizeBytes !== job.sizeBytes) {
        // Only states that react to file changes store the new counts (see `upsertFromScan`).
        logger.info(
          { jobId: job.id, relPath: job.relPath, state: job.state },
          'files changed while the engine was away',
        );
        handled.set(job.id, 'changed');
      }
      // A re-spelled folder name (NFC/NFD) is shown too, though it is not a change of the job.
      if (outcome !== 'unchanged') publishUpsert(job);
    });
  }

  // 2. Jobs whose folder is gone. (Read after the scan: the worker may have moved jobs meanwhile.)
  for (const job of repo.getAll()) {
    if (onDisk.has(job.id)) continue;
    guarded(job.id, () => {
      if (isUnreadable(job)) {
        logger.warn({ jobId: job.id, relPath: job.relPath }, 'job folder unreadable; kept');
        return;
      }

      if (job.state === 'editing') {
        logger.warn(
          { jobId: job.id, relPath: job.relPath },
          'folder removed while editing; marking failed',
        );
        const failed = repo.applyTransition(job.id, {
          type: 'FAIL',
          step: job.step ?? 1,
          error: FOLDER_REMOVED_ERROR,
        });
        handled.set(job.id, 'failedFolderRemoved');
        publishUpsert(failed);
        try {
          onFolderRemovedWhileEditing?.(failed);
        } catch (error) {
          logger.error({ jobId: job.id, err: error }, 'onFolderRemovedWhileEditing threw');
        }
        return;
      }

      logger.info({ jobId: job.id, relPath: job.relPath, state: job.state }, 'job folder is gone');
      if (repo.remove(job.id)) {
        removed += 1;
        bus.publish({ type: 'job.remove', id: job.id });
      }
    });
  }

  // 3. Jobs that were waiting out their settle time, and jobs whose export or preview may be gone.
  const now = clock().getTime();
  const ready: Job[] = [];
  const reviewing: Job[] = [];
  for (const job of repo.getAll()) {
    if (job.state === 'ready') {
      ready.push(job);
    } else if (job.state === 'review') {
      reviewing.push(job);
    } else if (
      job.state === 'arriving' &&
      !handled.has(job.id) &&
      now - Date.parse(job.lastChangeAt) >= settleMs
    ) {
      guarded(job.id, () => {
        if (isUnreadable(job)) return;
        const queued = assignSeries(repo.applyTransition(job.id, { type: 'SETTLED' }));
        logger.info({ jobId: job.id, relPath: job.relPath }, 'quiet long enough; queued');
        handled.set(job.id, 'settled');
        publishUpsert(queued);
      });
    }
  }

  for (const job of ready) {
    const state = await checkExport(exportsDir, job);
    if (state === 'unknown') {
      logger.warn({ jobId: job.id, relPath: job.relPath }, 'could not check the export; kept');
    }
    if (state !== 'missing') continue;
    guarded(job.id, () => {
      logger.warn({ jobId: job.id, relPath: job.relPath }, 'the exported file is missing');
      const failed = repo.applyTransition(job.id, { type: 'EXPORT_MISSING' });
      handled.set(job.id, 'failedMissingExport');
      publishUpsert(failed);
    });
  }

  for (const job of reviewing) {
    if (isUnreadable(job)) continue;
    const state = await checkPreview(inbox, job);
    if (state === 'unknown') {
      logger.warn({ jobId: job.id, relPath: job.relPath }, 'could not check the preview; kept');
    }
    if (state !== 'missing') continue;
    guarded(job.id, () => {
      logger.warn({ jobId: job.id, relPath: job.relPath }, 'the preview is missing');
      const failed = repo.applyTransition(job.id, { type: 'PREVIEW_MISSING' });
      handled.set(job.id, 'failedMissingPreview');
      publishUpsert(failed);
    });
  }

  const summary: ReconcileSummary = {
    created: 0,
    changed: 0,
    removed,
    settled: 0,
    failedMissingExport: 0,
    failedMissingPreview: 0,
    failedFolderRemoved: 0,
    resuming: 0,
    unchanged: 0,
  };
  for (const job of repo.getAll()) {
    const what = handled.get(job.id);
    if (what !== undefined) summary[what] += 1;
    else if (job.state === 'editing') summary.resuming += 1;
    else summary.unchanged += 1;
  }

  logger.info(summary, 'inbox reconciled');
  return summary;
}
