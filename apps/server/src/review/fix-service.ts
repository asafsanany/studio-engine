// The fix service (quick fixes plan, section 3; QF3): fixes a review note that the router called
// quick, by itself, while the job stays in Review. Built in engine.ts only while the `quickFixes`
// switch is on; hooked into the router's `onRouted` (note-routing.ts). Modelled on the music
// service (music/music-service.ts): allowed only in Review, one call at a time per job, and a
// `reviewBlock` that keeps Approve and Send from starting while the files are changing.
//
//   enqueue(job, note)    a note routed `quick` on a job in Review on Auto gets a QuickFix (queued,
//                         round = job.round + 1, model and effort from TIER_RUNS.quick) and joins the
//                         job's queue. The queue runs in the order the notes were added, one fix at a
//                         time per job, and at most FIX_LIMITS.jobsAtOnce jobs at once. It runs beside
//                         the edit queue, never through it, and the job stays in Review
//   list(job)             GET /api/jobs/:id/fixes: this round's fixes, oldest first
//   undo(job, fixId)      POST /api/jobs/:id/fixes/:fixId/undo: the newest fixed fix only, and only
//                         when nothing is queued or running for the job; its copy goes back
//   comparePath(...)      GET /api/jobs/:id/fixes/:fixId/compare/:file: before.png or after.png
//   reviewBlock(jobId)    FIX_MESSAGES.busy while a fix is queued, running or being undone: Approve,
//                         Send, a version restore, Export MP4 and the music's Make/Pick wait
//   beforeNoteEdit/beforeNoteDelete   the note rules (below), asked by the review service
//   stopJob(jobId)        the job left Review, was cancelled, archived or deleted, or left Auto: the
//                         running fix is stopped (its copy put back) and the queued ones cancelled
//   clearRound(jobId)     removes edit/review/fixes/ of the job; QF4 calls it after Send and Approve
//   start() / stop()      boot: stop what an earlier engine left, mark its running fixes failed and
//                         put their copies back, cancel its queued fixes; shutdown: stop what runs
//
// Around each run (the folder of a fix is edit/review/fixes/<fixId>/, see quick-fix-files.ts):
//
//   1. before/preview/ is an APFS clone of edit/preview/ (versions/version-service.ts `cloneTree`,
//      never hardlinks) and before/project.md a copy of edit/project.md, what Undo puts back;
//   2. runner.run({ job, note, fix, signal, onStep }) changes the composition and checks itself;
//   3. fixed: the fix is saved (said, durationSec, hasCompare, endedAt) and so are the note's
//      fixId / fixedAt; the preview is touched (below); `job.fix` and `note.upsert` go out.
//      escalated or failed: whatever the run changed is put back from the copy (preview and
//      project.md) and the status and the reason are saved; the note waits for Send. A run that
//      changed nothing has nothing to put back, so the copy is dropped and the exports stay current.
//      After either, the job's next queued fix starts.
//
// Stale exports: the small MP4 of the phone's Review, the poster and Export MP4 are current while
// they are newer than everything in edit/preview/ (`newestSource`). Files put back by Undo keep
// their old dates and a removed file leaves no date, so a fixed fix, an undone one and a copy put
// back touch edit/preview/index.html, the way a version restore does.
//
// The note rules (review-service.ts asks): the text of a note with a fix cannot change (409
// editFixed; Undo first), nor while its fix runs (409 busy); a note whose fix is queued gives it up
// (the fix is cancelled, and the new words are sorted again). Deleting a note: its queued fix is
// cancelled, a running one is 409 busy, a fixed one is allowed for the newest fix only, which is
// undone first (else 409 deleteFixed).
//
// A fix waits (stays queued) while the music is being made or picked for its job, since both write
// edit/preview/; the music service refuses the other way round while a fix is queued or running.
//
// Every change of a fix goes out as `job.fix` on the bus, steps included (events/client-stream.ts
// forwards it to the browsers).

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FIX_LIMITS,
  FIX_MESSAGES,
  type FixCompareFile,
  type Job,
  type QuickFix,
  type ReviewNote,
  TIER_RUNS,
} from '@studio/shared';
import type { NoteRepository, QuickFixRepository } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import { PREVIEW_INDEX_PATH } from '../pipeline/preview-files.js';
import { resolveInside } from '../routes/download.js';
import { cloneTree } from '../versions/version-service.js';
import {
  FIX_PREVIEW_PATH,
  FIX_PROJECT_PATH,
  FIXES_DIR_PATH,
  fixDirPath,
} from './quick-fix-files.js';
import {
  type QuickFixOutcome,
  type QuickFixRunner,
  type QuickFixStep,
  quickFixStepLabel,
} from './quick-fix-run.js';
import { type Listing, listJobFolder } from './verify-quick-fix.js';

/** What the fix service says in its own words (the shared FIX_MESSAGES has the rest). */
export const FIX_SERVICE_MESSAGES = {
  /** 409, Undo on a job that is not in Review. */
  notInReview: 'A fix can only be undone while the job is in Review.',
  /** 409, a call while the engine shuts down. */
  stopping: 'The engine is stopping.',
  /** 409, Undo when the copy of the edit from before the fix is gone. */
  noCopy: 'The copy of the edit from before this fix is gone, so it cannot be undone.',
  /** What a fix says when it cannot save the copy it would go back to. */
  noCopyMade: 'it could not save a copy of the edit to go back to',
  /** What a fix says when there is no preview to change. */
  noPreview: 'there is no preview to change',
  /** What a fix says when the run stopped because the engine did. */
  engineStopped: 'The engine stopped while this fix was running.',
} as const;

export function fixNotFoundMessage(fixId: string): string {
  return `Fix ${fixId} not found`;
}

/** What an Undo came to: the fix, now undone, or the refusal to answer. */
export type UndoResult =
  | { ok: true; fix: QuickFix }
  | { ok: false; status: 404 | 409; error: string };

export interface FixService {
  /**
   * A note was routed (the router's `onRouted`). Queues a fix for it when it is a quick, unsent,
   * unfixed note of a job in Review on Auto, and returns it; else `null`. Never throws.
   */
  enqueue(job: Job, note: ReviewNote): QuickFix | null;
  /** The fixes of the job's next round (`job.round + 1`), oldest first. */
  list(job: Pick<Job, 'id' | 'round'>): QuickFix[];
  /** One fix of the job, or `null` (unknown, or another job's). */
  find(jobId: string, fixId: string): QuickFix | null;
  /** Takes back the newest fixed fix. */
  undo(job: Job, fixId: string): Promise<UndoResult>;
  /** The real path of the fix's before.png or after.png, or `null` when it is not there. */
  comparePath(jobId: string, fixId: string, file: FixCompareFile): Promise<string | null>;
  /** Why Approve, Send, a restore, Export MP4 and the music must wait for this job, or `null`. */
  reviewBlock(jobId: string): string | null;
  /**
   * The text of an unsent note is about to change: the 409 text when it may not (it has a fix, or
   * its fix runs), else `null`, with a queued fix of the note cancelled.
   */
  beforeNoteEdit(note: ReviewNote): string | null;
  /**
   * An unsent note is about to be deleted: the 409 text when it may not (its fix runs, it is fixed
   * but not the newest, or the undo it needs is refused), else `null`: a queued fix of the note is
   * cancelled and a fixed newest one undone.
   */
  beforeNoteDelete(note: ReviewNote): Promise<string | null>;
  /** The job's running fix is stopped (its copy put back) and its queued ones cancelled. Resolves once nothing is left. */
  stopJob(jobId: string): Promise<void>;
  /** Removes edit/review/fixes/ of the job (QF4 calls it after Send and Approve). Does nothing while a fix is queued or running. */
  clearRound(jobId: string): Promise<void>;
  /** Boot: recovers what an earlier engine left, then lets the queues run. Never rejects. */
  start(): Promise<void>;
  /** Looks at the queues again: something that held a fix back (the music) is done. */
  poke(): void;
  /**
   * Follows the bus: a job that leaves Review, is cancelled, archived or deleted loses its fixes, one
   * that leaves Auto loses its queued ones, and a finished music make lets a held fix go. Returns the stop function.
   */
  listen(bus: Pick<EventBus, 'subscribe'>): () => void;
  /** Shutdown: no new calls, and what runs is stopped (its copy put back). */
  stop(): Promise<void>;
}

export interface FixServiceOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  jobs: { get(id: string): Job | null };
  notes: Pick<NoteRepository, 'get' | 'setFix'>;
  fixes: Pick<
    QuickFixRepository,
    | 'insert'
    | 'update'
    | 'get'
    | 'listForRound'
    | 'listQueued'
    | 'newestFixed'
    | 'markRunningFailed'
  >;
  /** Publishes `job.fix` and `note.upsert`. */
  bus: Pick<EventBus, 'publish'>;
  /** The run and its checks (createQuickFixRunner; the fake one in dev, tests and e2e). */
  runner: QuickFixRunner;
  logger?: RunnerLogger;
  clock?: () => Date;
  /** Fix ids. Default `randomUUID`; tests pass f1, f2, … */
  newId?: () => string;
  /** Most jobs fixing at once. Default {@link FIX_LIMITS}.jobsAtOnce. */
  jobsAtOnce?: number;
  /**
   * Whether something else is writing the job's preview now (the music being made or picked): a
   * fix waits while it answers true. Default: never. Asked from memory.
   */
  holdOff?: (jobId: string) => boolean;
  /** Boot: stops the runs an earlier engine left (`reapQuickFixRuns`). Default: nothing. */
  reap?: () => Promise<unknown>;
}

/** A fix waiting its turn. */
interface Waiting {
  fixId: string;
  noteId: string;
  /** When the note was added: the queue runs in this order. */
  noteAt: string;
}

type StopReason = 'job' | 'shutdown';

/** What a job is doing for a fix right now: a run, or an Undo. */
interface Active {
  kind: 'run' | 'undo';
  fixId: string;
  noteId: string;
  controller: AbortController;
  stopReason: StopReason | null;
  /** Resolves once the run or the Undo has ended and its files are as they will stay. */
  done: Promise<void>;
}

interface JobQueue {
  queue: Waiting[];
  active: Active | null;
}

/** What the preview and project.md looked like just before a run, to tell whether it changed them. */
interface Snapshot {
  preview: Listing;
  project: { size: number; mtimeMs: number } | null;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** A path with a dot-named part (`.hyperframes/`, `.DS_Store`, a temporary file) is tool state, not the composition. */
function isToolState(path: string): boolean {
  return path.split('/').some((part) => part.startsWith('.'));
}

function sameListing(a: Listing, b: Listing): boolean {
  const keep = (listing: Listing) => new Map([...listing].filter(([path]) => !isToolState(path)));
  const left = keep(a);
  const right = keep(b);
  if (left.size !== right.size) return false;
  for (const [path, stamp] of left) {
    const other = right.get(path);
    if (other === undefined || other.size !== stamp.size || other.mtimeMs !== stamp.mtimeMs) {
      return false;
    }
  }
  return true;
}

async function stampOf(path: string): Promise<Snapshot['project']> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

export function createFixService(options: FixServiceOptions): FixService {
  const {
    inboxPath,
    jobs,
    notes,
    fixes,
    bus,
    runner,
    logger = SILENT_LOGGER,
    clock = () => new Date(),
    newId = randomUUID,
    jobsAtOnce = FIX_LIMITS.jobsAtOnce,
    holdOff = () => false,
    reap,
  } = options;

  /** Jobs with a fix queued or under way. Insertion order is the order jobs get their turn. */
  const states = new Map<string, JobQueue>();
  let started = false;
  let stopped = false;

  const jobDirOf = (job: Pick<Job, 'relPath'>): string => join(inboxPath, job.relPath);

  // --- the bus ---------------------------------------------------------------------------------

  /**
   * What the Jobs list says of each job's fixes, as the page last heard it (`summaryKey`): only a job
   * whose fixes say something is in here. Kept from every `job.upsert` on the bus (`listen`), ours
   * included, so a job another part of the engine announced after its fixes changed is not announced twice.
   */
  const told = new Map<string, string>();

  /** The part of a job the row's line of detail reads from its fixes (`Job.fixing`, `Job.fixedCount`); `''` for none. */
  const summaryKey = (job: Pick<Job, 'fixing' | 'fixedCount'>): string =>
    job.fixing === null && job.fixedCount === 0
      ? ''
      : `${job.fixing?.atSec ?? '-'}|${job.fixedCount}`;

  function remember(job: Pick<Job, 'id' | 'fixing' | 'fixedCount'>): void {
    const key = summaryKey(job);
    if (key === '') told.delete(job.id);
    else told.set(job.id, key);
  }

  /**
   * The job stays in Review while its notes are fixed, so the Jobs list hears of a fix only through
   * the job (C57): `job.upsert` goes out when a fix being worked on or the count of fixed notes
   * changed (the repository reads both from `quick_fixes`), not for a new step of the same fix.
   */
  function tellJob(jobId: string): void {
    const job = jobs.get(jobId);
    if (job === null) {
      told.delete(jobId);
      return;
    }
    if ((told.get(jobId) ?? '') === summaryKey(job)) return;
    remember(job);
    bus.publish({ type: 'job.upsert', job });
  }

  function publishFix(fix: QuickFix): void {
    bus.publish({ type: 'job.fix', jobId: fix.jobId, fix });
    tellJob(fix.jobId);
  }

  function publishNote(note: ReviewNote | null): void {
    if (note !== null) bus.publish({ type: 'note.upsert', note });
  }

  /** Saves a change of a fix. Not published: the caller does, once the job's state says the same. */
  function update(id: string, patch: Parameters<QuickFixRepository['update']>[1]): QuickFix | null {
    try {
      return fixes.update(id, patch);
    } catch (err) {
      logger.error({ err, fixId: id }, 'could not save a quick fix');
      return null;
    }
  }

  // --- the queues --------------------------------------------------------------------------------

  function stateOf(jobId: string): JobQueue {
    let state = states.get(jobId);
    if (state === undefined) {
      state = { queue: [], active: null };
      states.set(jobId, state);
    }
    return state;
  }

  /** Forgets a job with nothing queued and nothing going on. */
  function tidy(jobId: string): void {
    const state = states.get(jobId);
    if (state !== undefined && state.queue.length === 0 && state.active === null) {
      states.delete(jobId);
    }
  }

  function isBusy(jobId: string): boolean {
    const state = states.get(jobId);
    return state !== undefined && (state.active !== null || state.queue.length > 0);
  }

  /** The job's active call, when it is for this note. */
  function runningFor(noteId: string): Active | null {
    for (const state of states.values()) {
      if (state.active?.kind === 'run' && state.active.noteId === noteId) return state.active;
    }
    return null;
  }

  function queuedFor(noteId: string): Waiting | null {
    for (const state of states.values()) {
      const waiting = state.queue.find((entry) => entry.noteId === noteId);
      if (waiting !== undefined) return waiting;
    }
    return null;
  }

  /** A fix that never ran: cancelled, taken out of its queue first so the job's block reads true. */
  function cancelQueued(jobId: string, fixId: string): void {
    const state = states.get(jobId);
    if (state !== undefined) state.queue = state.queue.filter((entry) => entry.fixId !== fixId);
    tidy(jobId);
    const fix = update(fixId, { status: 'cancelled', endedAt: clock().toISOString() });
    if (fix !== null) publishFix(fix);
  }

  function cancelAllQueued(jobId: string): void {
    const state = states.get(jobId);
    if (state === undefined) return;
    const waiting = state.queue.splice(0);
    tidy(jobId);
    for (const entry of waiting) {
      const fix = update(entry.fixId, { status: 'cancelled', endedAt: clock().toISOString() });
      if (fix !== null) publishFix(fix);
    }
  }

  function runningJobs(): number {
    let count = 0;
    for (const state of states.values()) if (state.active?.kind === 'run') count += 1;
    return count;
  }

  /** Starts the next fix of every job that is free, while there is room. */
  function pump(): void {
    if (!started || stopped) return;
    for (const [jobId, state] of [...states]) {
      if (runningJobs() >= jobsAtOnce) return;
      if (state.active !== null || state.queue.length === 0) continue;
      if (holdOff(jobId)) continue;
      startNext(jobId, state);
    }
  }

  function startNext(jobId: string, state: JobQueue): void {
    const next = state.queue.shift();
    if (next === undefined) return;
    const active: Active = {
      kind: 'run',
      fixId: next.fixId,
      noteId: next.noteId,
      controller: new AbortController(),
      stopReason: null,
      done: Promise.resolve(),
    };
    state.active = active;
    active.done = execute(jobId, active).catch((err: unknown) => {
      logger.error({ err, jobId, fixId: next.fixId }, 'a quick fix broke unexpectedly');
      // Whatever broke, the fix is over: it must not keep the job blocked for good.
      let failed: QuickFix | null = null;
      try {
        const left = fixes.get(next.fixId);
        if (left !== null && (left.status === 'running' || left.status === 'queued')) {
          failed = update(next.fixId, {
            status: 'failed',
            step: null,
            stepLabel: null,
            why: 'it could not run',
            endedAt: clock().toISOString(),
          });
        }
      } catch (inner) {
        logger.error({ err: inner, jobId, fixId: next.fixId }, 'could not end a broken quick fix');
      }
      release(jobId, active);
      if (failed !== null) publishFix(failed);
      pump();
    });
  }

  /** The job's run or Undo is over: it is free for its next fix, and goes to the back of the line. */
  function release(jobId: string, active: Active): void {
    const state = states.get(jobId);
    if (state === undefined || state.active !== active) return;
    state.active = null;
    if (state.queue.length === 0) {
      states.delete(jobId);
    } else {
      // The job that just fixed waits behind the others that are queued.
      states.delete(jobId);
      states.set(jobId, state);
    }
  }

  // --- the files of a fix --------------------------------------------------------------------------

  /** Makes edit/preview/index.html newer than the small MP4, the poster and the export made from it. */
  async function touchPreview(jobDir: string): Promise<void> {
    const now = clock();
    try {
      await utimes(join(jobDir, PREVIEW_INDEX_PATH), now, now);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') logger.warn({ err, jobDir }, 'could not touch the preview');
    }
  }

  /** The copy Undo goes back to, and how the files stood. Throws when the copy cannot be made. */
  async function takeSnapshot(jobDir: string, fixDir: string): Promise<Snapshot> {
    const before = join(fixDir, 'before');
    await rm(before, { recursive: true, force: true });
    await mkdir(before, { recursive: true });
    await cloneTree(join(jobDir, FIX_PREVIEW_PATH), join(before, 'preview'), true, logger);
    try {
      await cloneTree(join(jobDir, FIX_PROJECT_PATH), join(before, 'project.md'), false, logger);
    } catch (err) {
      // A job without project.md has nothing to keep; putting back removes the one a run makes.
      if (errorCode(err) !== 'ENOENT') throw err;
    }
    return {
      preview: await listJobFolder(join(jobDir, FIX_PREVIEW_PATH)),
      project: await stampOf(join(jobDir, FIX_PROJECT_PATH)),
    };
  }

  /** Whether the run changed the preview or project.md since the snapshot. */
  async function changedSince(jobDir: string, snapshot: Snapshot): Promise<boolean> {
    const preview = await listJobFolder(join(jobDir, FIX_PREVIEW_PATH));
    if (!sameListing(snapshot.preview, preview)) return true;
    const project = await stampOf(join(jobDir, FIX_PROJECT_PATH));
    if (snapshot.project === null || project === null) return snapshot.project !== project;
    return snapshot.project.size !== project.size || snapshot.project.mtimeMs !== project.mtimeMs;
  }

  /**
   * Puts the copy of the fix back as the live preview and project.md. The preview is swapped in
   * with renames, so a crash leaves a usable one (or none, and the next put back makes one from
   * the copy): clone the copy next to it, move the live one aside, move the clone in, drop the old.
   * Throws when the copy is gone.
   */
  async function putBack(jobDir: string, fixDir: string): Promise<void> {
    const before = join(fixDir, 'before');
    const saved = join(before, 'preview');
    if (!(await isDirectory(saved))) throw new Error(FIX_SERVICE_MESSAGES.noCopy);
    const editDir = join(jobDir, 'edit');
    const live = join(editDir, 'preview');
    const clone = join(editDir, '.preview-fix.tmp');
    const aside = join(editDir, '.preview-fix-replaced');

    await rm(clone, { recursive: true, force: true });
    await rm(aside, { recursive: true, force: true });
    await cloneTree(saved, clone, true, logger);
    try {
      if (await exists(live)) await rename(live, aside);
      await rename(clone, live);
    } catch (err) {
      // Nothing was lost: the old one is moved back if it was moved away.
      if (!(await exists(live)) && (await exists(aside))) await rename(aside, live).catch(() => {});
      await rm(clone, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    await rm(aside, { recursive: true, force: true }).catch((err: unknown) =>
      logger.warn({ err, jobDir }, 'could not remove the preview a fix replaced'),
    );

    const project = join(jobDir, FIX_PROJECT_PATH);
    const savedProject = join(before, 'project.md');
    if (await exists(savedProject)) {
      const temporary = `${project}.fix.tmp`;
      await rm(temporary, { force: true });
      await cloneTree(savedProject, temporary, false, logger);
      await rename(temporary, project);
    } else {
      await rm(project, { force: true });
    }
    await touchPreview(jobDir);
  }

  /** The copy is no longer needed (the files are back, or the fix is undone). */
  async function dropCopy(fixDir: string): Promise<void> {
    await rm(join(fixDir, 'before'), { recursive: true, force: true }).catch((err: unknown) =>
      logger.warn({ err, fixDir }, 'could not remove the copy of a fix'),
    );
  }

  // --- a run ---------------------------------------------------------------------------------------

  /** Why a queued fix must not run now (it is cancelled), or `null`. */
  function whyNotRun(job: Job | null, note: ReviewNote | null): string | null {
    if (job === null) return 'the job is gone';
    if (job.state !== 'review' || job.archivedAt !== null) return 'the job left Review';
    if (job.reviewEffort !== null) return 'the job left Auto';
    if (note === null || note.round !== null) return 'the note is gone';
    return null;
  }

  async function execute(jobId: string, active: Active): Promise<void> {
    const { signal } = active.controller;
    let fix = fixes.get(active.fixId);
    const job = jobs.get(jobId);
    const note = fix === null ? null : notes.get(fix.noteId);
    const jobDir = job === null ? null : jobDirOf(job);

    // Cancelled while it waited, or the world changed since it was queued: it never starts.
    let skip: string | null = null;
    if (fix === null || fix.status !== 'queued') skip = 'it is not queued any more';
    else skip = whyNotRun(job, note);
    if (skip === null && (jobDir === null || !(await isDirectory(jobDir)))) {
      skip = 'the job folder is gone';
    }
    if (skip !== null || fix === null || job === null || jobDir === null || note === null) {
      const cancelled =
        fix !== null && fix.status === 'queued'
          ? update(fix.id, { status: 'cancelled', endedAt: clock().toISOString() })
          : null;
      release(jobId, active);
      if (cancelled !== null) publishFix(cancelled);
      pump();
      return;
    }

    const startedAt = clock();
    fix = update(fix.id, {
      status: 'running',
      startedAt: startedAt.toISOString(),
      step: 0,
      stepLabel: quickFixStepLabel(0, null),
    });
    if (fix === null) {
      release(jobId, active);
      pump();
      return;
    }
    publishFix(fix);
    const fixId = fix.id;
    const fixDir = join(jobDir, fixDirPath(fixId));

    let outcome: QuickFixOutcome;
    let snapshot: Snapshot | null = null;
    if (!(await exists(join(jobDir, PREVIEW_INDEX_PATH)))) {
      outcome = { status: 'failed', why: FIX_SERVICE_MESSAGES.noPreview, hasCompare: false };
    } else {
      try {
        snapshot = await takeSnapshot(jobDir, fixDir);
        outcome = signal.aborted
          ? { status: 'failed', why: 'the fix was stopped', hasCompare: false }
          : await runSafely(job, note, fix, signal, (step, label) => {
              const moved = update(fixId, { step, stepLabel: label });
              if (moved !== null) publishFix(moved);
            });
      } catch (err) {
        logger.error({ err, jobId, fixId }, 'could not copy the edit before a quick fix');
        outcome = { status: 'failed', why: FIX_SERVICE_MESSAGES.noCopyMade, hasCompare: false };
        snapshot = null;
      }
    }

    // The engine's own stop beats the run's word: files may have changed after its checks.
    const stoppedBy = active.stopReason;
    const aborted = signal.aborted || stoppedBy !== null;
    const endedAt = clock();
    const durationSec = Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 1000);
    const times = { endedAt: endedAt.toISOString(), durationSec, step: null, stepLabel: null };

    if (outcome.status === 'fixed' && !aborted) {
      await touchPreview(jobDir);
      const saved = update(fixId, {
        ...times,
        status: 'fixed',
        said: outcome.said,
        why: null,
        hasCompare: outcome.hasCompare,
      });
      let changedNote: ReviewNote | null = null;
      try {
        changedNote = notes.setFix(note.id, { fixId, fixedAt: endedAt.toISOString() });
      } catch (err) {
        logger.error({ err, jobId, fixId }, 'could not save the fix on its note');
      }
      release(jobId, active);
      publishNote(changedNote);
      if (saved !== null) publishFix(saved);
      logger.info({ jobId, fixId, durationSec }, 'a quick fix landed');
      pump();
      return;
    }

    // Not fixed: whatever the run changed goes back, then the status says why.
    const why = aborted
      ? stoppedBy === 'shutdown'
        ? FIX_SERVICE_MESSAGES.engineStopped
        : 'the fix was stopped'
      : outcome.status === 'fixed'
        ? 'the fix was stopped'
        : outcome.why;
    const status = !aborted && outcome.status === 'escalated' ? 'escalated' : 'failed';
    try {
      // No snapshot: the copy was never made, so the run never started and nothing changed.
      if (snapshot !== null && (await changedSince(jobDir, snapshot))) {
        await putBack(jobDir, fixDir);
      }
    } catch (err) {
      logger.error({ err, jobId, fixId }, 'could not put the edit back after a quick fix');
    }
    await dropCopy(fixDir);
    const saved = update(fixId, {
      ...times,
      status,
      said: null,
      why,
      hasCompare: outcome.hasCompare,
    });
    release(jobId, active);
    if (saved !== null) publishFix(saved);
    logger.info({ jobId, fixId, status, why }, 'a quick fix did not land');
    pump();
  }

  /** The run, whose throwing (it should not) is a failed fix. */
  async function runSafely(
    job: Job,
    note: ReviewNote,
    fix: QuickFix,
    signal: AbortSignal,
    onStep: (step: QuickFixStep, label: string) => void,
  ): Promise<QuickFixOutcome> {
    // The service has said step 0 already.
    let last: { step: QuickFixStep; label: string } = {
      step: 0,
      label: quickFixStepLabel(0, null),
    };
    try {
      return await runner.run({
        job,
        note,
        fix,
        signal,
        onStep: (step, label) => {
          // The same step twice is not news.
          if (last.step === step && last.label === label) return;
          last = { step, label };
          onStep(step, label);
        },
      });
    } catch (err) {
      logger.error({ err, jobId: job.id, fixId: fix.id }, 'the quick fix run threw');
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        why: `it could not run: ${message}`.slice(0, 160),
        hasCompare: false,
      };
    }
  }

  // --- the service ----------------------------------------------------------------------------------

  function enqueue(job: Job, routed: ReviewNote): QuickFix | null {
    try {
      if (stopped) return null;
      const now = jobs.get(job.id);
      const note = notes.get(routed.id);
      if (now === null || note === null) return null;
      // Only a quick, unsent, unfixed note of a job in Review on Auto.
      if (now.state !== 'review' || now.archivedAt !== null || now.reviewEffort !== null)
        return null;
      if (note.jobId !== now.id || note.round !== null || note.fixId !== null) return null;
      if (note.routeStatus !== 'routed' || note.route?.tier !== 'quick') return null;
      if ((note.text?.trim() ?? '') === '') return null;
      if (queuedFor(note.id) !== null || runningFor(note.id) !== null) return null;

      const fix: QuickFix = fixes.insert({
        id: newId(),
        jobId: now.id,
        noteId: note.id,
        round: now.round + 1,
        status: 'queued',
        step: null,
        stepLabel: null,
        said: null,
        why: null,
        model: TIER_RUNS.quick.model ?? 'sonnet',
        effort: TIER_RUNS.quick.effort,
        startedAt: null,
        endedAt: null,
        durationSec: null,
        hasCompare: false,
      });
      // In the order the notes were added: the router may answer out of order.
      const state = stateOf(now.id);
      const entry: Waiting = { fixId: fix.id, noteId: note.id, noteAt: note.createdAt };
      let at = state.queue.length;
      while (at > 0 && (state.queue[at - 1]?.noteAt ?? '') > entry.noteAt) at -= 1;
      state.queue.splice(at, 0, entry);
      publishFix(fix);
      pump();
      return fix;
    } catch (err) {
      logger.error({ err, noteId: routed.id }, 'could not queue a quick fix');
      return null;
    }
  }

  function list(job: Pick<Job, 'id' | 'round'>): QuickFix[] {
    return fixes.listForRound(job.id, job.round + 1);
  }

  function find(jobId: string, fixId: string): QuickFix | null {
    const fix = fixes.get(fixId);
    return fix !== null && fix.jobId === jobId ? fix : null;
  }

  async function undo(job: Job, fixId: string): Promise<UndoResult> {
    const fix = find(job.id, fixId);
    if (fix === null) return { ok: false, status: 404, error: fixNotFoundMessage(fixId) };
    if (stopped) return { ok: false, status: 409, error: FIX_SERVICE_MESSAGES.stopping };
    const now = jobs.get(job.id);
    if (now === null) return { ok: false, status: 404, error: fixNotFoundMessage(fixId) };
    if (now.state !== 'review') {
      return { ok: false, status: 409, error: FIX_SERVICE_MESSAGES.notInReview };
    }
    // From here to the claim nothing waits, so two Undos cannot both pass.
    if (isBusy(now.id)) return { ok: false, status: 409, error: FIX_MESSAGES.busy };
    if (
      fix.status !== 'fixed' ||
      fix.round !== now.round + 1 ||
      fixes.newestFixed(now.id, fix.round)?.id !== fix.id
    ) {
      return { ok: false, status: 409, error: FIX_MESSAGES.notNewest };
    }

    const jobDir = jobDirOf(now);
    const fixDir = join(jobDir, fixDirPath(fix.id));
    let finish: () => void = () => {};
    const active: Active = {
      kind: 'undo',
      fixId: fix.id,
      noteId: fix.noteId,
      controller: new AbortController(),
      stopReason: null,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    stateOf(now.id).active = active;
    try {
      try {
        await putBack(jobDir, fixDir);
      } catch (err) {
        if (err instanceof Error && err.message === FIX_SERVICE_MESSAGES.noCopy) {
          release(now.id, active);
          return { ok: false, status: 409, error: FIX_SERVICE_MESSAGES.noCopy };
        }
        throw err;
      }
      // endedAt moves to now, so the web's rev (the newest endedAt of a fixed or undone fix) changes
      // at an Undo and the player reloads the put-back composition.
      const undone = update(fix.id, { status: 'undone', endedAt: clock().toISOString() });
      let changedNote: ReviewNote | null = null;
      try {
        changedNote = notes.setFix(fix.noteId, { fixId: null, fixedAt: null });
      } catch (err) {
        logger.error({ err, jobId: now.id, fixId: fix.id }, 'could not clear the fix of its note');
      }
      await dropCopy(fixDir);
      release(now.id, active);
      publishNote(changedNote);
      const result = undone ?? { ...fix, status: 'undone' as const };
      publishFix(result);
      logger.info({ jobId: now.id, fixId: fix.id }, 'a quick fix was undone');
      return { ok: true, fix: result };
    } finally {
      // Whatever went wrong, the job is not left claimed.
      release(now.id, active);
      finish();
      pump();
    }
  }

  async function comparePath(
    jobId: string,
    fixId: string,
    file: FixCompareFile,
  ): Promise<string | null> {
    const fix = find(jobId, fixId);
    const job = fix === null ? null : jobs.get(jobId);
    if (fix === null || job === null) return null;
    return resolveInside(jobDirOf(job), `${fixDirPath(fix.id)}/${file}`);
  }

  function reviewBlock(jobId: string): string | null {
    return isBusy(jobId) ? FIX_MESSAGES.busy : null;
  }

  function beforeNoteEdit(note: ReviewNote): string | null {
    if (note.fixId !== null) return FIX_MESSAGES.editFixed;
    if (runningFor(note.id) !== null) return FIX_MESSAGES.busy;
    const waiting = queuedFor(note.id);
    if (waiting !== null) cancelQueued(note.jobId, waiting.fixId);
    return null;
  }

  async function beforeNoteDelete(note: ReviewNote): Promise<string | null> {
    if (runningFor(note.id) !== null) return FIX_MESSAGES.busy;
    const waiting = queuedFor(note.id);
    if (waiting !== null) {
      cancelQueued(note.jobId, waiting.fixId);
      return null;
    }
    if (note.fixId === null) return null;
    const job = jobs.get(note.jobId);
    const fix = find(note.jobId, note.fixId);
    // A mark with no fix behind it (the row is gone) has nothing to take back.
    if (job === null || fix === null) return null;
    if (fix.status !== 'fixed') return null;
    if (fixes.newestFixed(job.id, fix.round)?.id !== fix.id) return FIX_MESSAGES.deleteFixed;
    const undone = await undo(job, fix.id);
    return undone.ok ? null : undone.error;
  }

  async function stopJob(jobId: string): Promise<void> {
    const state = states.get(jobId);
    if (state === undefined) return;
    cancelAllQueued(jobId);
    const active = states.get(jobId)?.active ?? null;
    if (active !== null) {
      active.stopReason ??= 'job';
      if (!active.controller.signal.aborted) active.controller.abort('cancel');
      await active.done;
    }
  }

  async function clearRound(jobId: string): Promise<void> {
    if (isBusy(jobId)) return;
    const job = jobs.get(jobId);
    if (job === null) return;
    const jobDir = jobDirOf(job);
    if (!(await isDirectory(jobDir))) return;
    try {
      await rm(join(jobDir, FIXES_DIR_PATH), { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, jobId }, 'could not remove the fixes of a finished round');
    }
  }

  /** The folders of fixes an earlier engine stopped in the middle: their copies go back, unless the job is gone. */
  async function recover(): Promise<void> {
    for (const fix of fixes.markRunningFailed()) {
      publishFix(fix);
      const job = jobs.get(fix.jobId);
      if (job === null) continue;
      const jobDir = jobDirOf(job);
      if (!(await isDirectory(jobDir))) continue;
      const fixDir = join(jobDir, fixDirPath(fix.id));
      try {
        await putBack(jobDir, fixDir);
        await dropCopy(fixDir);
        logger.warn(
          { jobId: job.id, fixId: fix.id },
          'put back the edit of a fix the engine stopped',
        );
      } catch (err) {
        logger.error(
          { err, jobId: job.id, fixId: fix.id },
          'could not put back the edit of a stopped fix',
        );
      }
    }
    // Queued by an earlier engine: its queue is gone. (A note routed since the boot is in memory.)
    for (const fix of fixes.listQueued()) {
      if (queuedFor(fix.noteId)?.fixId === fix.id) continue;
      const cancelled = update(fix.id, { status: 'cancelled', endedAt: clock().toISOString() });
      if (cancelled !== null) publishFix(cancelled);
    }
  }

  async function start(): Promise<void> {
    if (started || stopped) return;
    try {
      await reap?.();
    } catch (err) {
      logger.warn({ err }, 'could not stop the quick fix runs an earlier engine left');
    }
    try {
      await recover();
    } catch (err) {
      logger.error({ err }, 'could not recover the quick fixes an earlier engine left');
    }
    started = true;
    pump();
  }

  function listen(bus: Pick<EventBus, 'subscribe'>): () => void {
    const quietly = (jobId: string, work: Promise<unknown>): void => {
      work.catch((err: unknown) => {
        logger.warn({ err, jobId }, 'could not stop the quick fixes of a job');
      });
    };
    return bus.subscribe((event) => {
      if (event.type === 'job.remove') {
        told.delete(event.id);
        quietly(event.id, stopJob(event.id));
      } else if (event.type === 'job.upsert') {
        const { job } = event;
        remember(job);
        if (!states.has(job.id)) return;
        if (job.state !== 'review' || job.archivedAt !== null) quietly(job.id, stopJob(job.id));
        // Off Auto, the queued notes wait for Send as they do on any manual level; a fix that runs finishes.
        else if (job.reviewEffort !== null) cancelAllQueued(job.id);
      } else if (event.type === 'job.music') {
        pump();
      }
    });
  }

  async function stop(): Promise<void> {
    stopped = true;
    const running: Promise<void>[] = [];
    for (const state of states.values()) {
      state.queue = [];
      const active = state.active;
      if (active === null) continue;
      active.stopReason ??= 'shutdown';
      if (!active.controller.signal.aborted) active.controller.abort('shutdown');
      running.push(active.done);
    }
    await Promise.all(running);
  }

  return {
    enqueue,
    list,
    find,
    undo,
    comparePath,
    reviewBlock,
    beforeNoteEdit,
    beforeNoteDelete,
    stopJob,
    clearRound,
    start,
    poke: pump,
    listen,
    stop,
  };
}
