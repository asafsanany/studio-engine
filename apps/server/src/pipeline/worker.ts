// The queue worker (architecture §4 and §6): one edit at a time, or two with `atOnce: 2` (the
// Two jobs at once switch), nothing else.
//
// Each of its `atOnce` lanes does this, in order, for as long as there is work:
//   1. Picks the next job: first the jobs a crash left in `editing` (the resume-flagged ones, run
//      as `resume` with no START), then the queued job that joined the queue first. Before it
//      starts a queued job it asks `beforeStart` whether to wait: an edit of a client whose style
//      is still being learned waits for that, so its Brief step copies the new style (C10).
//   2. Applies START, then the Brief step (B4, `BriefRun`): edit/brief.json and edit/brief.md are
//      written, or reused when nothing changed. A Brief failure fails the job at step 1. Only an
//      edit run has a Brief step; a revise or render run (`job.runKind`, Phase 3) works on the
//      edit that is there and skips it.
//      A job whose brief says `production: generate` (Generated videos, GN5; only while the Generate
//      switch is on, i.e. a `generate` step was given) goes through the Generate step next
//      (`GenerateRun`, generate-step.ts): the shots, the voice and the clips are made in
//      edit/generate/ and handed off, or reused when a Retry or a Resume finds them. The job stays
//      at step 1 while it works (its text is "Generate · clips 4/6 · $1.65"); the stage is not
//      timed as a step; a failure there fails the job at step 1 with the stage's plain sentence.
//      The edit then starts as for any job, with Transcribe's N counting the voice (voice.mp3).
//   3. Hands the job to the injected `Runner` with an AbortController's signal and a progress
//      callback, and waits for it to end. A job at step 1 (fresh, or failed or cancelled at Brief)
//      has no edit progress as far as `job.step` says, so the edit's own files decide (CVP-132):
//      with work in edit/ it carries on as resume or retry and the progress tracker replays the
//      real step; with none it runs as `start` whatever the queue's mode. See `editModeAtBrief`.
//   4. Turns the outcome into the state machine's events: success -> PREVIEW_READY with the
//      composition the run left, for a run that ends in Review (a revise run, or an edit run with
//      the Review switch on, `runFinishOf`), otherwise the export (`finalize`) then SUCCEED (a
//      render run, or an edit run with the switch off); failure -> FAIL; stopped by `cancel()` ->
//      CANCEL; stopped by `stop()` -> nothing, the job stays `editing` and resumes at the next
//      boot.
//   5. A job that reached `ready` (an edit run with the Review switch off, or a render run after
//      Approve) goes to `afterReady` before the next job is picked: it queues a Learn pass that
//      adds the job's look to its client's style (Phase 2 plan §5, C10). Nothing there changes the
//      job. A job that ends in Review is not finished, so it does not go there. Reaching ready is
//      not a delivery: that is recorded only when the owner marks the job delivered (Phase 4 §2).
//
// With two lanes, the second takes the job at the head of the line while the first is still
// editing, so the line keeps its order and a job's place says how many start before it. While one
// lane is in `afterReady` the other picks nothing, so the next edit of that client still waits
// for its Learn pass. A job at the head of the line that waits (`beforeStart`) is waited for by
// both lanes, and starts once.
//
// One shortcut (CVP-84): a retried job whose edit had already finished and only the export failed
// (the job log's last run ended `succeeded`, it failed at the Render step, `edit/final.mp4` is
// still a non-empty file) skips the Brief step and the runner: the worker goes straight to step 4
// with a success, so Retry costs an export and not a new Claude session. See `canReexport`. Only
// a run that delivers final.mp4 has an export to retry: a render run, or an edit run while the
// Review switch is off.
//
// Step timings (E5, W3): each timing is stored under the run's kind. The first report of a fresh
// revise or render run repeats the step START gave it and `onProgress` skips repeats, so that
// first step is timed from the start of the run (there is no Brief step to begin it); a resumed
// or retried step is never timed.
//
// Who calls what: the boot wiring creates the worker and calls `start()`; anything that makes a
// job queued (settle timer, Release, Retry, Resume) calls `notify()`; the cancel route calls
// `cancel(id)` and awaits it; shutdown calls `stop()`.
//
// The worker is the only code that applies START, PROGRESS, SUCCEED and FAIL. It never sets a
// job's state itself: every change goes through `JobRepository.applyTransition`.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Brief,
  extraFormatsOf,
  InvalidTransition,
  type Job,
  type JobEvent,
  type JobOutput,
  type JobPreview,
  jobPreviewSchema,
  PREVIEW_STEP,
  RENDER_STEP,
  type RunKind,
  STEP_IDS,
  type StepId,
} from '@studio/shared';
import { JobNotFoundError, type JobRepository, type StepRunRepository } from '../db/index.js';
import { BRIEF_STEP, BRIEF_STOPPED, type BriefOutcome, type BriefRun } from './brief-step.js';
import { PREVIEW_NOT_REPORTED } from './failure.js';
import { FINAL_VIDEO_PATH } from './finalize.js';
import type { GenerateRun } from './generate-step.js';
import { JobLog, jobLogPath, readLastEnd } from './job-log.js';
import { extraFinalPath } from './preview-files.js';
import { hasEditProgress } from './progress-evidence.js';
import { transcribeTotal } from './progress-reducer.js';
import { runFinishOf } from './run-finish.js';
import { runModeFor } from './run-mode.js';
import type { AbortReason, RunContext, RunMode, Runner, RunOutcome } from './runner.js';

/** The part of a pino logger the worker uses. Defaults to logging nothing. */
export interface WorkerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

/**
 * Exports a finished edit (E6): copies `edit/final.mp4` to `_Exports/<Client>/<Job>.mp4` and
 * describes it. Called once the runner reports success, with the job still `editing`; the worker
 * applies SUCCEED with what it returns. Rejecting fails the job at Render, the last step. `signal`
 * aborts when the job is cancelled or the engine shuts down, so a long copy can stop early.
 */
export type Finalize = (job: Job, signal: AbortSignal) => Promise<JobOutput>;

/**
 * Where the worker finds a job's folders, to look at what an earlier run left:
 * - whether a retried job only needs its export again (CVP-84);
 * - whether a job back at Brief already has the edit's work in `edit/`, so its edit carries on
 *   instead of starting over (CVP-132).
 * Leave it out and neither is checked: every Retry runs the runner, and a job at Brief edits as
 * `start`, as before.
 */
export interface ReexportOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** `Config.logsDir`: a job's log is `<logsDir>/jobs/<jobId>.log`. */
  logsDir: string;
}

export interface WorkerOptions {
  jobs: JobRepository;
  /** Timings of the steps, for the ETA (E5). */
  stepRuns: StepRunRepository;
  /** Does the editing: E3's Claude runner or E7's fake one (see `createRunner`). */
  runner: Runner;
  /**
   * The Brief step (B4, see `createBriefStep`), run before the runner on every run. Left out (some
   * tests), the runner runs alone.
   */
  brief?: BriefRun;
  /**
   * The Generate step (Generated videos, GN5), run after the Brief step for a job whose brief says
   * `production: generate`. Left out (the Generate switch is off, or a test's stand-in runner), the
   * edit goes straight on after the Brief step, whatever the brief says.
   */
  generate?: GenerateRun;
  finalize: Finalize;
  /**
   * Asked first on a render run (Approve): true when the render already exists (Export MP4 made it
   * in Review) and has been put at edit/final.mp4, so the run needs no Claude session and goes
   * straight to the export. A throw or false runs the render as usual. The signal is the run's:
   * the render in Review may still be going, and Cancel or shutdown must not wait for it.
   */
  reuseRender?: (job: Job, signal: AbortSignal) => Promise<boolean>;
  /** Lets Retry export again without a new run when only the export failed. Off when left out. */
  reexport?: ReexportOptions;
  /**
   * The Review switch (`Config.review`): on, an edit run ends in Review (PREVIEW_READY) and is not
   * exported. Off when left out.
   */
  review?: boolean;
  /**
   * Called with the job and its composition just before a run that ends in Review applies
   * PREVIEW_READY: the boot wiring keeps a version of the preview here (`createVersionService`).
   * Best effort: a rejection is logged and the run goes on.
   */
  captureVersion?: (job: Job, preview: JobPreview) => Promise<unknown>;
  /**
   * Called with a job when a run of it has ended, however it ended and before the outcome is
   * applied: the boot wiring refreshes a generated job's spend here (C67), since a revise round can
   * make new takes. Best effort: a rejection is logged and the run's outcome is applied as usual.
   */
  afterRun?: (job: Job) => Promise<unknown>;
  /**
   * Called with a job that has just reached `ready`; the worker waits for it before it picks the
   * next job. The boot wiring queues the job's Learn pass here (`createLearnOnReady`). It must not
   * change the job. A rejection is logged and ignored, and `stop()` stops the wait.
   */
  afterReady?: (job: Job) => Promise<void>;
  /**
   * Asked about the queued job at the head of the line before the worker starts it: something to
   * wait for first, or null to start it now. After a wait the worker looks at the line again and
   * starts the job at its head, asking again only about another job. The boot wiring waits here
   * while the job's client has a Learn pass queued or running (`createLearnWait`). It must not
   * change the job. A throw or a rejection is logged and the job starts, and `stop()` ends the
   * wait.
   */
  beforeStart?: (job: Job) => Promise<void> | null;
  /**
   * Called with a job whenever the worker changes it (START, each PROGRESS, SUCCEED, FAIL,
   * CANCEL), once per change. The boot wiring publishes it as `job.upsert`; the queued jobs whose
   * `placeInLine` moves up because the one ahead started are not reported here, the bus's
   * `followQueuePlaces` republishes them. A listener that throws is logged and ignored.
   */
  onJobChanged?: (job: Job) => void;
  /**
   * How many jobs edit at the same time: 1 (left out) or 2, `Config.twoJobsAtOnce`. Each one is a
   * run of its own, with its own Cancel.
   */
  atOnce?: number;
  logger?: WorkerLogger;
}

/** A run in progress. */
interface ActiveRun {
  readonly jobId: string;
  /** The kind of run (`job.runKind` when it was picked); its step timings are stored under it. */
  readonly runKind: RunKind;
  readonly controller: AbortController;
  abortReason: AbortReason | null;
  /** Where the job is, as last applied; used to skip repeated progress reports. */
  step: StepId | null;
  sub: string | null;
  /** The step whose duration is being timed, if this run saw it from its start. */
  timedStep: StepId | null;
  /** The Brief run has reported, so step 1 is shown and timed. */
  briefRunning: boolean;
  /**
   * The brief of a job that goes through the Generate step (its brief says `production: generate`
   * and the step is there); `null` for every other job.
   */
  generated: Brief | null;
  /** The Generate step has reported, so step 1 shows its text; the step it carries on from is put back after it. */
  generateShown: boolean;
  /**
   * The edit carries on from work in edit/ but the job is at Brief, so the tracker's first report
   * is where that work really is (a replay). That step is already partly done and is not timed.
   */
  replaying: boolean;
  /**
   * Transcribe's N from this run's brief (the footage files it lists), handed to the runner so the
   * progress tracker counts toward it; `null` without a brief (CVP-134).
   */
  transcribeTotal: number | null;
  /** Settles when the run is over and its last transition has been applied. */
  readonly done: Promise<void>;
}

interface Pick {
  job: Job;
  mode: RunMode;
  /** START was applied for this pick (a queued job), as opposed to a job found `editing`. */
  started: boolean;
}

/** The job at the head of the line waits for `until` before it starts (`beforeStart`). */
interface Wait {
  jobId: string;
  until: Promise<void>;
}

function describeError(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.trim() === '' ? fallback : text;
}

function isStepId(value: unknown): value is StepId {
  return STEP_IDS.includes(value as StepId);
}

/** The step the export belongs to (Render, the last step): where a failed export leaves the job. */
const EXPORT_STEP: StepId = RENDER_STEP;

const STOPPED_BEFORE_START: RunOutcome = { ok: false, error: 'Stopped before the edit started.' };

export class QueueWorker {
  private readonly jobs: JobRepository;
  private readonly stepRuns: StepRunRepository;
  private readonly runner: Runner;
  private readonly brief: BriefRun | undefined;
  private readonly generate: GenerateRun | undefined;
  private readonly finalize: Finalize;
  private readonly reexport: ReexportOptions | undefined;
  private readonly reuseRender: WorkerOptions['reuseRender'];
  private readonly review: boolean;
  private readonly captureVersion: WorkerOptions['captureVersion'];
  private readonly afterRun: WorkerOptions['afterRun'];
  private readonly afterReady: ((job: Job) => Promise<void>) | undefined;
  private readonly beforeStart: ((job: Job) => Promise<void> | null) | undefined;
  private readonly onJobChanged: ((job: Job) => void) | undefined;
  private readonly atOnce: number;
  private readonly logger: WorkerLogger;

  private accepting = false;
  /**
   * How many lanes are working, at most `atOnce`. A lane takes itself off in the same turn that it
   * finds nothing to pick, so a `notify()` can never fall between "nothing left" and "lane ended".
   */
  private laneCount = 0;
  /** The lanes' promises, for `stop()` and `idle()` to wait on. */
  private readonly lanes = new Set<Promise<void>>();
  /** The runs in progress, by job id. */
  private readonly active = new Map<string, ActiveRun>();
  /** Ids of jobs a crash left in `editing`, still to be resumed, in the order they will run. */
  private recovery: string[] = [];
  /** The wait in progress for the job at the head of the line (`beforeStart`), shared by the lanes. */
  private waiting: Wait | null = null;
  /** The queued job the worker last waited for (`beforeStart`): it starts without asking again. */
  private waitedFor: string | null = null;
  /** `afterReady` calls in progress: no lane picks a queued job until they are over. */
  private readonly readying = new Set<Promise<void>>();
  /** Resolves when `stop()` is called: ends a wait for `afterReady`. */
  private readonly stopping: Promise<void>;
  private requestStop: () => void = () => {};

  constructor({
    jobs,
    stepRuns,
    runner,
    brief,
    generate,
    finalize,
    reexport,
    reuseRender,
    review = false,
    captureVersion,
    afterRun,
    afterReady,
    beforeStart,
    onJobChanged,
    atOnce = 1,
    logger = SILENT,
  }: WorkerOptions) {
    this.jobs = jobs;
    this.stepRuns = stepRuns;
    this.runner = runner;
    this.brief = brief;
    this.generate = generate;
    this.finalize = finalize;
    this.reexport = reexport;
    this.reuseRender = reuseRender;
    this.review = review;
    this.captureVersion = captureVersion;
    this.afterRun = afterRun;
    this.afterReady = afterReady;
    this.beforeStart = beforeStart;
    this.onJobChanged = onJobChanged;
    this.atOnce = Math.max(1, Math.floor(atOnce));
    this.logger = logger;
    this.stopping = new Promise((resolve) => {
      this.requestStop = resolve;
    });
  }

  /** The job being edited right now (the one that started first), if any. */
  get activeJobId(): string | null {
    return this.activeJobIds[0] ?? null;
  }

  /** Every job being edited right now, the one that started first first. */
  get activeJobIds(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Boot. Flags the jobs left in `editing` (the engine died mid-edit) to run first, then starts
   * working. Does nothing if already started.
   */
  start(): void {
    if (this.accepting) return;
    this.accepting = true;
    this.recovery = this.jobs.getEditing().map((job) => job.id);
    if (this.recovery.length > 0) {
      this.logger.info({ jobIds: this.recovery }, 'resuming jobs left in editing');
    }
    this.notify();
  }

  /**
   * Something may be waiting: call it when a job becomes queued. Cheap and safe to call any time,
   * as often as you like; the worker never runs more than `atOnce` jobs at once. Ignored until
   * `start()` and after `stop()`.
   */
  notify(): void {
    // At most `atOnce` tries: a lane that finds nothing ends in this same turn and frees its place.
    // The count is read again each time, because starting a job publishes it and a listener may
    // call `notify()` in that same turn.
    for (let i = 0; i < this.atOnce && this.accepting && this.laneCount < this.atOnce; i++) {
      this.laneCount += 1;
      const lane: Promise<void> = this.lane().finally(() => this.lanes.delete(lane));
      this.lanes.add(lane);
    }
  }

  /**
   * Cancels the job and waits until the runner has actually stopped and CANCEL has been applied.
   * Returns the job as it is then, normally `cancelled`; it can be `ready` or `failed` if the run
   * ended on its own first, so callers answering the user should look at its `state`.
   *
   * Handles the job being edited now and one flagged for resume that has not been picked yet.
   * Returns `null` for any other job (the worker has nothing to stop): the cancel route then
   * applies CANCEL itself, which answers 409 for a state that does not allow it.
   */
  async cancel(jobId: string): Promise<Job | null> {
    const active = this.active.get(jobId);
    if (active !== undefined) {
      this.abort(active, 'cancel');
      await active.done;
      return this.jobs.get(jobId);
    }

    const index = this.recovery.indexOf(jobId);
    if (index === -1) return null;
    this.recovery.splice(index, 1);
    return this.apply(jobId, { type: 'CANCEL' }) ?? this.jobs.get(jobId);
  }

  /**
   * Shutdown. Aborts the current runs and waits for them to stop, and starts nothing more. Their
   * jobs stay `editing` (they are not cancelled), so the next boot resumes them.
   */
  async stop(): Promise<void> {
    this.accepting = false;
    this.requestStop();
    for (const active of this.active.values()) this.abort(active, 'shutdown');
    await this.idle();
  }

  /** Resolves when the worker has nothing running and nothing it can pick. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.laneCount > 0) await Promise.all(this.lanes);
  }

  private abort(active: ActiveRun, reason: AbortReason): void {
    if (active.abortReason !== null) return;
    active.abortReason = reason;
    // The reason travels with the signal, so the runner can tell a shutdown from a cancel.
    active.controller.abort(reason);
  }

  // One lane's loop. `laneCount` goes down in `finally`, in the same turn that `pickNext` found
  // nothing, so a `notify()` can never fall between "nothing left" and "lane ended".
  private async lane(): Promise<void> {
    try {
      while (this.accepting) {
        // The other lane's job has just reached ready: its Learn pass is queued before anything
        // else starts, so the next edit of that client waits for it (`beforeStart`).
        if (this.readying.size > 0) {
          await Promise.all(this.readying);
          continue;
        }
        const pick = this.pickNext();
        if (pick === null) break;
        if ('until' in pick) {
          await this.waitBeforeStart(pick);
          continue;
        }
        const ready = await this.run(pick);
        if (ready !== null) await this.whenReady(ready);
      }
    } catch (err) {
      this.logger.error({ err }, 'queue worker stopped on an unexpected error');
    } finally {
      this.laneCount -= 1;
    }
  }

  /**
   * The next job to edit: a flagged `editing` job first, then the queued job at the head of the
   * line. The line is the repository's own order (`nextQueued`: oldest `settledAt`, then
   * `addedAt`, then id), the same one it uses for `placeInLine`, so the job shown as #1 is the
   * one that runs. Held jobs are not `queued`, so they are never found. A queued job that has to
   * wait first (`beforeStart`) comes back as a `Wait`, not started; the other lane finding it
   * there gets the same `Wait`, so it is asked about once and started once.
   */
  private pickNext(): Pick | Wait | null {
    while (this.recovery.length > 0) {
      const id = this.recovery.shift() as string;
      const job = this.jobs.get(id);
      if (job?.state === 'editing') return { job, mode: 'resume', started: false };
    }

    for (;;) {
      const queued = this.jobs.nextQueued();
      if (queued === null) {
        this.waitedFor = null;
        return null;
      }
      if (this.waiting?.jobId === queued.id) return this.waiting;
      const until = this.waitBefore(queued);
      if (until !== null) {
        this.logger.info({ jobId: queued.id }, 'the next job waits for its client’s style');
        this.waiting = { jobId: queued.id, until };
        return this.waiting;
      }

      // Read before START: starting a fresh job gives it a step.
      const meta = this.jobs.getMeta(queued.id);
      const mode = runModeFor(queued, meta ?? { attempt: 1 });
      try {
        const job = this.jobs.applyTransition(queued.id, { type: 'START' });
        this.waitedFor = null;
        return { job, mode, started: true };
      } catch (err) {
        // Held, edited or removed between looking and starting: look again.
        if (err instanceof InvalidTransition || err instanceof JobNotFoundError) {
          this.logger.warn({ jobId: queued.id, err }, 'queued job changed before it could start');
          continue;
        }
        throw err;
      }
    }
  }

  /** Runs one picked job to its end. Returns the job when it reached `ready`, else null. */
  private async run({ job, mode, started }: Pick): Promise<Job | null> {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: ActiveRun = {
      jobId: job.id,
      runKind: job.runKind,
      controller: new AbortController(),
      abortReason: null,
      step: job.step,
      sub: job.subProgress,
      timedStep: null,
      briefRunning: false,
      generated: null,
      generateShown: false,
      replaying: false,
      transcribeTotal: null,
      done,
    };
    // Set before anything is published, so a listener that calls `cancel` finds the run.
    this.active.set(job.id, active);

    try {
      this.logger.info({ jobId: job.id, mode }, 'edit starting');
      if (started) this.publish(job);
      // A revise or render run has no Brief step, and the tracker's first report repeats the step
      // START gave it, which onProgress skips: so a fresh run's first step is timed from here.
      // A resumed or retried step is never timed.
      if (started && mode === 'start' && job.runKind !== 'edit' && job.step !== null) {
        this.beginTimedStep(active, job.step);
      }
      // Step 1 is timed only while a Brief run actually runs (not when the brief is reused or
      // skipped), the edit's steps from the moment the runner reports them. A resumed or retried
      // run's first step is already partly done, so it is not timed: its duration would be a
      // misleading sample.

      const outcome = await this.edit(job, mode, active);
      const ended = await this.conclude(active, outcome);
      return ended?.state === 'ready' ? ended : null;
    } catch (err) {
      this.logger.error({ err, jobId: job.id }, 'could not record how the edit ended');
      return null;
    } finally {
      this.active.delete(job.id);
      finish();
    }
  }

  /** What `job` waits for before it starts, or null to start it now (see `beforeStart`). */
  private waitBefore(job: Job): Promise<void> | null {
    const beforeStart = this.beforeStart;
    if (beforeStart === undefined || this.waitedFor === job.id) return null;
    try {
      return beforeStart(job);
    } catch (err) {
      this.logger.warn({ jobId: job.id, err }, 'could not tell whether the next job has to wait');
      return null;
    }
  }

  /**
   * Waits for what the job at the head of the line waits for, or for `stop()`. Once it is over the
   * job starts without being asked about again.
   */
  private async waitBeforeStart(wait: Wait): Promise<void> {
    try {
      await Promise.race([wait.until, this.stopping]);
    } catch (err) {
      // Both lanes may wait on it: the first to wake says so.
      if (this.waiting === wait) {
        this.logger.warn({ jobId: wait.jobId, err }, 'the wait before the next job failed');
      }
    }
    if (this.waiting === wait) {
      this.waiting = null;
      this.waitedFor = wait.jobId;
    }
  }

  /**
   * Hands a job that just reached `ready` to `afterReady` and waits for it, or for `stop()`.
   * Whatever happens there, the job stays as it is.
   */
  private async whenReady(job: Job): Promise<void> {
    const afterReady = this.afterReady;
    if (afterReady === undefined || !this.accepting) return;
    const over = (async () => {
      try {
        await Promise.race([Promise.resolve().then(() => afterReady(job)), this.stopping]);
      } catch (err) {
        this.logger.warn({ jobId: job.id, err }, 'the step after a finished job failed');
      }
    })();
    this.readying.add(over);
    try {
      await over;
    } finally {
      this.readying.delete(over);
    }
  }

  /**
   * Does the editing and says how it went: the Brief step, then normally the runner's own outcome.
   * A retry that only needs its export again gets a success without either, which sends it
   * straight to `finalize`.
   */
  private async edit(job: Job, mode: RunMode, active: ActiveRun): Promise<RunOutcome> {
    // A listener of the START notification may already have cancelled the job, or the engine
    // started shutting down: then there is nothing to stop and the runner is never started.
    if (active.abortReason !== null) return STOPPED_BEFORE_START;

    if (mode === 'retry' && (await this.canReexport(job))) {
      // The checks above took a moment; Cancel or shutdown may have come in meanwhile.
      if (active.abortReason !== null) return STOPPED_BEFORE_START;
      await this.markReexport(job);
      this.logger.info({ jobId: job.id }, 'export failed earlier: exporting again without a run');
      return { ok: true };
    }

    if (job.runKind === 'render' && (await this.renderAlreadyMade(job, active))) {
      if (active.abortReason !== null) return STOPPED_BEFORE_START;
      this.logger.info({ jobId: job.id }, 'the render already exists: exporting it without a run');
      return { ok: true };
    }

    // Only an edit run has a Brief step; a revise or render run works on the edit that is there
    // (Phase 3 §1).
    const brief = job.runKind === 'edit' ? this.brief : undefined;

    // Without a Brief step the runner starts in the same turn as START, as it always did.
    if (brief !== undefined) {
      const briefFailure = await this.prepareBrief(brief, job, active);
      if (briefFailure !== null) return briefFailure;
      if (active.abortReason !== null) return STOPPED_BEFORE_START;
    }

    // The Brief run is over: its timing ends here, before anything else is looked at.
    if (brief !== undefined) this.afterBrief(active, job);

    // Generated videos (GN5): a job with no footage gets its shots, voice and clips made now. The
    // stage is not timed (the Brief's timing ended above), and the job is put back at the step it
    // carries on from when the stage showed itself over one that was further on.
    if (active.generated !== null && this.generate !== undefined) {
      const generateFailure = await this.prepareGenerate(
        this.generate,
        job,
        active.generated,
        active,
      );
      this.afterGenerate(active, job);
      if (generateFailure !== null) return generateFailure;
      if (active.abortReason !== null) return STOPPED_BEFORE_START;
    }

    // Only a job that has run before and is at Brief needs a look at edit/ to pick the mode.
    let editMode: RunMode = mode;
    if (mode !== 'start' && (job.step ?? BRIEF_STEP) <= BRIEF_STEP) {
      editMode = await this.editModeAtBrief(job, mode, active);
      // The look took a moment; Cancel or shutdown may have come in meanwhile.
      if (active.abortReason !== null) return STOPPED_BEFORE_START;
    }
    // The job as it is now: the brief's progress, or the step it carries on from.
    const current = brief === undefined ? job : (this.jobs.get(job.id) ?? job);
    const outcome = await this.invokeRunner(current, editMode, active);
    // Draft & chat (DR4): the Draft read the instructions itself and wrote edit/brief.json over the
    // placeholder; it is taken in however the run ended, so a Retry or a Resume finds it.
    if (brief?.adopt !== undefined) {
      const adopted = await brief.adopt(current);
      if (adopted !== 'off') this.logger.info({ jobId: job.id, adopted }, 'the Draft’s brief');
    }
    return outcome;
  }

  /** Whether Approve's render was already made in Review (`reuseRender`). Never throws. */
  private async renderAlreadyMade(job: Job, active: ActiveRun): Promise<boolean> {
    if (this.reuseRender === undefined) return false;
    try {
      return await this.reuseRender(job, active.controller.signal);
    } catch (err) {
      this.logger.warn({ jobId: job.id, err }, 'could not use the render made in Review');
      return false;
    }
  }

  /**
   * The mode the edit runs in for a job that has run before (`mode` is `resume` or `retry`) and
   * sits at Brief (1). A job past Brief carries on as the queue said, and one that has never run
   * starts; neither comes here. This one got to step 1 because its brief failed or was stopped,
   * perhaps after the edit had got much further (a retry's fresh brief failed, and the job fell
   * back to Brief). `job.step` says nothing about the edit then, so the edit's own files do:
   * with work in edit/ it carries on as `mode`, and the runner replays that work to find the real
   * step, for the progress tracker and for the step the prompt names (CVP-138); with none it is a
   * first edit and runs as `start`. If edit/ cannot be read, the
   * job is not made to start over: it keeps `mode`.
   */
  private async editModeAtBrief(job: Job, mode: RunMode, active: ActiveRun): Promise<RunMode> {
    const options = this.reexport;
    if (options === undefined) return 'start';
    let progressed: boolean;
    try {
      // A generated job's project.md may be the Generate run's assumptions, not the edit's plan.
      progressed = await hasEditProgress(join(options.inboxPath, job.relPath, 'edit'), {
        generated: active.generated !== null,
      });
    } catch (err) {
      this.logger.warn(
        { jobId: job.id, err },
        'could not look for edit work in edit/: carrying on as before',
      );
      active.replaying = true;
      return mode;
    }
    if (!progressed) return 'start';
    this.logger.info(
      { jobId: job.id, mode },
      'job is back at Brief with edit work in edit/: carrying on, not starting over',
    );
    // The tracker replays edit/ and reports the step it finds.
    active.replaying = true;
    return mode;
  }

  /**
   * Runs the Brief step. Returns `null` when the brief is ready (written, reused or skipped), or
   * the failure at step 1 that ends the run.
   */
  private async prepareBrief(
    brief: BriefRun,
    job: Job,
    active: ActiveRun,
  ): Promise<RunOutcome | null> {
    let outcome: BriefOutcome;
    try {
      outcome = await brief.prepare(job, {
        signal: active.controller.signal,
        progress: (sub) => this.onBriefProgress(active, sub),
      });
    } catch (err) {
      outcome = { ok: false, error: `${BRIEF_STOPPED} ${describeError(err, 'unknown error')}` };
    }
    if (!outcome.ok) return { ok: false, error: outcome.error, step: BRIEF_STEP };
    this.keepFormats(job, outcome.brief);
    active.generated =
      this.generate !== undefined && outcome.brief.production === 'generate' ? outcome.brief : null;
    // A brief that said "generate" before and now doesn’t takes the Generate stage off the job.
    if (active.generated === null && this.generate?.forget?.(job) === true) {
      this.publish(this.jobs.get(job.id) ?? job);
    }
    this.countFootage(active, outcome.brief);
    this.logger.info({ jobId: job.id, brief: outcome.source }, 'brief ready');
    return null;
  }

  /**
   * Formats (GN7): the sizes the brief asks for, when it explicitly asks for more than one, are kept
   * on the job so the prompts, the preview check, the render and the export all know them. Saved
   * each time the brief is ready, so a note that changes the ask changes the job. Best effort:
   * a failure to save is logged and the job keeps the formats it had.
   */
  private keepFormats(job: Job, brief: Brief): void {
    try {
      const { job: saved, changed } = this.jobs.setFormats(job.id, brief.formats);
      if (changed) this.publish(saved);
    } catch (err) {
      this.logger.warn({ jobId: job.id, err }, 'could not keep the brief’s formats on the job');
    }
  }

  /**
   * A brief says which files are footage. Voice notes and ignored clips never get a transcript in
   * edit/transcripts/, so Transcribe's N must not include them (CVP-134). The Brief step runs
   * before every edit, a resume or a retry after a restart included, so a replay counts toward
   * the same N. Best effort, like the step timings: a count that cannot be made leaves the
   * runner to count the job's audio and video files, and never stops the edit.
   */
  private countFootage(active: ActiveRun, brief: Brief): void {
    try {
      // A generated job has no footage: what the edit transcribes is the voice (voice.mp3, GN5).
      active.transcribeTotal = transcribeTotal(brief) + (active.generated === null ? 0 : 1);
    } catch (err) {
      this.logger.warn({ jobId: active.jobId, err }, 'could not count the brief’s footage files');
    }
  }

  /** The Brief run reports: the job shows step 1 with `sub`, and step 1 is timed from now. */
  private onBriefProgress(active: ActiveRun, sub: string): void {
    if (this.active.get(active.jobId) !== active || active.abortReason !== null) return;
    if (!active.briefRunning) {
      active.briefRunning = true;
      // A job already at step 1 does not switch steps, so its timing starts here. One at a later
      // step (a re-brief before a retry) switches to step 1, which starts it.
      if (active.step === BRIEF_STEP) this.beginTimedStep(active, BRIEF_STEP);
    }
    this.onProgress(active, BRIEF_STEP, sub);
  }

  /**
   * The Brief run is over. Its timing ends here, so step 1 is the Brief run alone. A job that was
   * past step 1 and showed Brief for a new brief goes back to the step it carries on from, untimed
   * (a resumed or retried step is never a sample).
   */
  private afterBrief(active: ActiveRun, job: Job): void {
    if (!active.briefRunning) return;
    this.endTimedStep(active);
    this.restoreStep(active, job);
  }

  /**
   * Runs the Generate step. Returns `null` when the footage is made (or was there already), or the
   * failure at step 1 that ends the run. Never throws.
   */
  private async prepareGenerate(
    generate: GenerateRun,
    job: Job,
    brief: Brief,
    active: ActiveRun,
  ): Promise<RunOutcome | null> {
    let outcome: Awaited<ReturnType<GenerateRun['prepare']>>;
    try {
      outcome = await generate.prepare(job, brief, {
        signal: active.controller.signal,
        progress: (sub) => this.onGenerateProgress(active, sub),
      });
    } catch (err) {
      outcome = { ok: false, error: `Generate stopped: ${describeError(err, 'unknown error')}` };
    }
    if (!outcome.ok) return { ok: false, error: outcome.error, step: BRIEF_STEP };
    this.logger.info({ jobId: job.id, generate: outcome.source }, 'generated footage ready');
    return null;
  }

  /** The Generate step reports: the job shows step 1 with its text. The stage is not a timed step. */
  private onGenerateProgress(active: ActiveRun, sub: string): void {
    if (this.active.get(active.jobId) !== active || active.abortReason !== null) return;
    active.generateShown = true;
    this.onProgress(active, BRIEF_STEP, sub);
  }

  /** The Generate step is over: a job that was past step 1 and showed it goes back to its own step. */
  private afterGenerate(active: ActiveRun, job: Job): void {
    if (!active.generateShown) return;
    this.restoreStep(active, job);
  }

  /** Puts a job that showed step 1 (Brief or Generate) over a later step back at that step. */
  private restoreStep(active: ActiveRun, job: Job): void {
    const step = job.step;
    if (step === null || step === BRIEF_STEP || active.step === step) return;
    try {
      const restored = this.jobs.applyTransition(active.jobId, {
        type: 'PROGRESS',
        step,
        sub: job.subProgress,
      });
      active.step = step;
      active.sub = job.subProgress;
      this.publish(restored);
    } catch (err) {
      this.logger.warn({ jobId: active.jobId, step, err }, 'could not record progress');
    }
  }

  /**
   * Whether this retried job only needs its export again, so no Claude run. All of these hold:
   * - it failed at Render (the last step), where a failed export (and a missing export file)
   *   leaves a job, and Retry keeps the step;
   * - the last run in its log ended `succeeded`: the editor itself finished. RETRY clears the
   *   job's `error`, so the log is where this is recorded. A run that failed at Render itself
   *   ended `failed`, and its `final.mp4` can't be trusted; no log or no `end` marker means
   *   nothing is known, and the runner runs as it always did;
   * - `edit/final.mp4` is still a non-empty file (the video itself is checked by `finalize`; if it
   *   fails again the job fails at Render as before).
   * Any doubt, or any error while checking, answers no: a full run is the safe default.
   */
  private async canReexport(job: Job): Promise<boolean> {
    const options = this.reexport;
    if (options === undefined || job.step !== EXPORT_STEP) return false;
    // Only a run that delivers final.mp4 has an export to retry: a render run, or an edit run
    // while the Review switch is off.
    if (runFinishOf(job.runKind, this.review) !== 'final') return false;
    try {
      const video = await stat(join(options.inboxPath, job.relPath, FINAL_VIDEO_PATH));
      if (!video.isFile() || video.size === 0) return false;
      // Formats (GN7): a render run of a job with more formats has a video of each to export.
      if (job.runKind === 'render') {
        for (const format of extraFormatsOf(job.formats)) {
          const extra = await stat(join(options.inboxPath, job.relPath, extraFinalPath(format.id)));
          if (!extra.isFile() || extra.size === 0) return false;
        }
      }
      const lastEnd = await readLastEnd(jobLogPath(options.logsDir, job.id));
      return lastEnd?.outcome === 'succeeded';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ jobId: job.id, err }, 'could not check whether only the export failed');
      }
      return false;
    }
  }

  /** Writes the "re-exported without a run" marker to the job's log. Best effort. */
  private async markReexport(job: Job): Promise<void> {
    if (this.reexport === undefined) return;
    let log: JobLog | null = null;
    try {
      log = await JobLog.open(jobLogPath(this.reexport.logsDir, job.id));
      log.marker('reexport', {
        jobId: job.id,
        step: job.step,
        file: FINAL_VIDEO_PATH,
        note: 'The edit had finished and only the export failed: exported again without a new Claude run',
      });
    } catch (err) {
      this.logger.warn(
        { jobId: job.id, err },
        'could not write the re-export marker to the job log',
      );
    } finally {
      await log?.close();
    }
  }

  private async invokeRunner(job: Job, mode: RunMode, active: ActiveRun): Promise<RunOutcome> {
    const context: RunContext = {
      signal: active.controller.signal,
      progress: (step, sub) => this.onProgress(active, step, sub ?? null),
      ...(active.transcribeTotal === null ? {} : { transcribeTotal: active.transcribeTotal }),
    };
    try {
      const outcome = await this.runner.start(job, mode, context);
      if (typeof outcome !== 'object' || outcome === null || typeof outcome.ok !== 'boolean') {
        return { ok: false, error: 'The runner ended without saying how it went.' };
      }
      return outcome;
    } catch (err) {
      return { ok: false, error: describeError(err, 'The runner stopped with an error.') };
    }
  }

  /** Turns how the run ended into the job's next state. Returns the job as it is then, if known. */
  private async conclude(active: ActiveRun, outcome: RunOutcome): Promise<Job | null> {
    const { jobId } = active;
    let failure: { step: StepId; error: string };

    if (this.afterRun !== undefined) {
      const ended = this.jobs.get(jobId);
      if (ended !== null) {
        try {
          await this.afterRun(ended);
        } catch (err) {
          this.logger.warn({ jobId, err }, 'could not look after a run that ended');
        }
      }
    }

    if (outcome.ok) {
      const job = this.jobs.get(jobId);
      if (job === null) {
        this.logger.warn({ jobId }, 'job was removed while it was being edited');
        return null;
      }
      if (runFinishOf(job.runKind, this.review) === 'preview') {
        // A run that ends in Review: the composition is the result, and nothing is exported.
        const preview = jobPreviewSchema.safeParse(outcome.preview);
        if (preview.success) {
          // The edit is done: a cancel that arrived too late does not undo it.
          this.endTimedStep(active);
          await this.keepVersion(job, preview.data);
          return this.apply(jobId, { type: 'PREVIEW_READY', preview: preview.data });
        }
        failure = { step: PREVIEW_STEP, error: PREVIEW_NOT_REPORTED };
      } else {
        try {
          const output = await this.finalize(job, active.controller.signal);
          // The edit is done: a cancel that arrived too late does not undo it.
          this.endTimedStep(active);
          return this.apply(jobId, { type: 'SUCCEED', output });
        } catch (err) {
          failure = {
            step: EXPORT_STEP,
            error: `Export failed: ${describeError(err, 'unknown error')}`,
          };
        }
      }
    } else {
      failure = {
        step: isStepId(outcome.step) ? outcome.step : (active.step ?? 1),
        error: describeError(outcome.error, 'The runner stopped with an error.'),
      };
    }

    switch (active.abortReason) {
      case 'cancel':
        return this.apply(jobId, { type: 'CANCEL' });
      case 'shutdown':
        // Not the job's fault and not the user's choice: leave it `editing`, as a crash would.
        this.logger.info({ jobId }, 'edit stopped for shutdown, it resumes at the next start');
        return null;
      case null:
        this.logger.warn({ jobId, step: failure.step, error: failure.error }, 'edit failed');
        return this.apply(jobId, { type: 'FAIL', step: failure.step, error: failure.error });
    }
  }

  /** Keeps a version of the preview a run has just left. Best effort: a failure is logged, never fails the run. */
  private async keepVersion(job: Job, preview: JobPreview): Promise<void> {
    if (this.captureVersion === undefined) return;
    try {
      await this.captureVersion(job, preview);
    } catch (err) {
      this.logger.warn({ jobId: job.id, err }, 'could not keep a version of the preview');
    }
  }

  /** The runner's `progress` callback. Never throws: a hiccup here must not break the edit. */
  private onProgress(active: ActiveRun, step: StepId, sub: string | null): void {
    if (this.active.get(active.jobId) !== active || active.abortReason !== null) return;
    if (!isStepId(step)) {
      this.logger.warn({ jobId: active.jobId, step }, 'ignored progress for an unknown step');
      return;
    }
    const text = sub === '' ? null : sub;
    if (step === active.step && text === active.sub) return;

    try {
      const job = this.jobs.applyTransition(active.jobId, { type: 'PROGRESS', step, sub: text });
      if (step !== active.step) {
        // The first report of a run carried on from Brief is where the old work stands: that step
        // was started in an earlier run, so its duration would be a misleading sample.
        if (active.replaying) this.endTimedStep(active);
        else this.switchTimedStep(active, step);
        active.replaying = false;
      }
      active.step = step;
      active.sub = text;
      this.publish(job);
    } catch (err) {
      this.logger.warn({ jobId: active.jobId, step, err }, 'could not record progress');
    }
  }

  // Step timings are best effort: a failure to record one is logged, never allowed to stop the
  // edit. A step left open by a failed, cancelled or interrupted run is dropped when the same step
  // is started again, and is never read as a sample (see StepRunRepository).
  private beginTimedStep(active: ActiveRun, step: StepId): void {
    try {
      this.stepRuns.start(active.jobId, step, active.runKind);
      active.timedStep = step;
    } catch (err) {
      this.logger.warn({ jobId: active.jobId, step, err }, 'could not start timing a step');
    }
  }

  private endTimedStep(active: ActiveRun): void {
    if (active.timedStep === null) return;
    const step = active.timedStep;
    active.timedStep = null;
    try {
      this.stepRuns.end(active.jobId, step);
    } catch (err) {
      this.logger.warn({ jobId: active.jobId, step, err }, 'could not finish timing a step');
    }
  }

  private switchTimedStep(active: ActiveRun, step: StepId): void {
    this.endTimedStep(active);
    this.beginTimedStep(active, step);
  }

  /**
   * Applies `event` and publishes the result. A job that was held, removed or otherwise moved on
   * under the worker is logged and skipped (`null`); anything else is a real error.
   */
  private apply(jobId: string, event: JobEvent): Job | null {
    try {
      const job = this.jobs.applyTransition(jobId, event);
      this.publish(job);
      return job;
    } catch (err) {
      if (err instanceof InvalidTransition || err instanceof JobNotFoundError) {
        this.logger.warn(
          { jobId, event: event.type, err },
          'job changed while it was being edited',
        );
        return null;
      }
      throw err;
    }
  }

  private publish(job: Job): void {
    try {
      this.onJobChanged?.(job);
    } catch (err) {
      this.logger.error({ err, jobId: job.id }, 'onJobChanged listener threw');
    }
  }
}
