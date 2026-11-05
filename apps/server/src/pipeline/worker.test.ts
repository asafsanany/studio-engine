import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type BriefFileRole,
  type Job,
  type JobOutput,
  type JobPreview,
  SETTLE_MS,
  type StepId,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRepository, StepRunRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import type { BriefContext, BriefOutcome, BriefRun } from './brief-step.js';
import { PREVIEW_NOT_REPORTED } from './failure.js';
import { FINAL_VIDEO_PATH } from './finalize.js';
import { jobLogPath } from './job-log.js';
import { startProgressTracker } from './progress.js';
import {
  type AbortReason,
  abortReasonOf,
  type RunContext,
  type RunMode,
  type Runner,
  type RunOutcome,
} from './runner.js';
import { type Finalize, QueueWorker, type ReexportOptions, type WorkerLogger } from './worker.js';

// Everything here is driven by promises the test settles itself: no timers, no sleeping. The real
// repositories run on an in-memory database; only the runner is a stand-in.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. The worker does no I/O, so one turn is enough. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Call {
  job: Job;
  mode: RunMode;
  context: RunContext;
  /** The signal fired. */
  aborted: boolean;
  /** Why it fired, as the runner reads it from the signal; `null` while it has not. */
  abortReason: AbortReason | null;
  /** Ends the run the way a runner would. */
  end(outcome: RunOutcome): void;
  crash(reason: unknown): void;
}

/** A runner that does nothing until the test ends each run. */
class ScriptedRunner implements Runner {
  readonly calls: Call[] = [];
  running = 0;
  maxRunning = 0;
  /** When true an abort ends the run at once with a failure, as a killed process would. */
  stopOnAbort = true;

  start(job: Job, mode: RunMode, context: RunContext): Promise<RunOutcome> {
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    const run = deferred<RunOutcome>();
    const call: Call = {
      job,
      mode,
      context,
      aborted: false,
      abortReason: null,
      end: run.resolve,
      crash: run.reject,
    };
    this.calls.push(call);
    context.signal.addEventListener('abort', () => {
      call.aborted = true;
      call.abortReason = abortReasonOf(context.signal);
      if (this.stopOnAbort) run.resolve({ ok: false, error: 'killed' });
    });
    return run.promise.finally(() => {
      this.running -= 1;
    });
  }

  get ids(): string[] {
    return this.calls.map((call) => call.job.id);
  }

  call(index: number): Call {
    const call = this.calls[index];
    if (call === undefined) throw new Error(`the runner has no call #${index}`);
    return call;
  }
}

interface BriefCall {
  job: Job;
  context: BriefContext;
  end(outcome: BriefOutcome): void;
}

/** A Brief step that does nothing until the test ends each one; an abort ends it at once. */
class ScriptedBrief implements BriefRun {
  readonly calls: BriefCall[] = [];
  /** Ends every call at once with this, instead of waiting for the test. */
  autoEnd: BriefOutcome | null = null;

  prepare(job: Job, context: BriefContext): Promise<BriefOutcome> {
    const run = deferred<BriefOutcome>();
    this.calls.push({ job, context, end: run.resolve });
    context.signal.addEventListener('abort', () =>
      run.resolve({ ok: false, error: 'Brief stopped: the brief was stopped.' }),
    );
    if (this.autoEnd !== null) run.resolve(this.autoEnd);
    return run.promise;
  }

  call(index: number): BriefCall {
    const call = this.calls[index];
    if (call === undefined) throw new Error(`the brief has no call #${index}`);
    return call;
  }
}

type ReadyBrief = Extract<BriefOutcome, { ok: true }>['brief'];

/** A brief that worked, with these files (the worker only looks at `ok`, `source` and the roles). */
function briefReady(files: { path: string; role: BriefFileRole }[] = []): BriefOutcome {
  return {
    ok: true,
    source: 'ran',
    brief: { files: files.map((file) => ({ ...file, note: null })) } as unknown as ReadyBrief,
  };
}

/** What a brief that worked hands back. */
const BRIEF_READY: BriefOutcome = briefReady();

const OUTPUT: JobOutput = {
  fileName: 'Client/Job.mp4',
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 65_011_712,
};

const opened: StudioDb[] = [];
const workers: QueueWorker[] = [];
const runners: ScriptedRunner[] = [];

afterEach(async () => {
  // A run left open by a test must end when stop() aborts it, or the hook would wait for ever.
  for (const runner of runners.splice(0)) runner.stopOnAbort = true;
  for (const worker of workers.splice(0)) await worker.stop();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

interface SetupOptions {
  /** The Brief step; left out, the runner runs alone. */
  brief?: BriefRun;
  finalize?: Finalize;
  reexport?: ReexportOptions;
  reuseRender?: (job: Job) => Promise<boolean>;
  /** The Review switch: handed to the repository (the machine) and the worker, as engine.ts does. */
  review?: boolean;
  captureVersion?: (job: Job, preview: JobPreview) => Promise<unknown>;
  afterRun?: (job: Job) => Promise<unknown>;
  afterReady?: (job: Job) => Promise<void>;
  beforeStart?: (job: Job) => Promise<void> | null;
  onJobChanged?: (job: Job) => void;
  /** How many jobs edit at once (Two jobs at once); left out, one. */
  atOnce?: number;
  logger?: WorkerLogger;
}

function setup(options: SetupOptions = {}) {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock, review: options.review });
  const stepRuns = new StepRunRepository(db, { clock });
  const runner = new ScriptedRunner();
  runners.push(runner);
  const finalize: Finalize = options.finalize ?? vi.fn(async () => OUTPUT);

  /** A worker on this database; call it again to simulate a restart of the engine. */
  function newWorker(): QueueWorker {
    const worker = new QueueWorker({
      jobs,
      stepRuns,
      runner,
      brief: options.brief,
      finalize,
      reexport: options.reexport,
      reuseRender: options.reuseRender,
      review: options.review,
      captureVersion: options.captureVersion,
      afterRun: options.afterRun,
      afterReady: options.afterReady,
      beforeStart: options.beforeStart,
      onJobChanged: options.onJobChanged,
      atOnce: options.atOnce,
      logger: options.logger,
    });
    workers.push(worker);
    return worker;
  }

  /** Scans a job and lets it settle into the queue. Returns its id. */
  function enqueue(name: string): string {
    const { job } = jobs.upsertFromScan(makeScan('Client', name));
    clock.tick(SETTLE_MS);
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    return job.id;
  }

  function get(id: string): Job {
    const job = jobs.get(id);
    if (job === null) throw new Error(`no job ${id}`);
    return job;
  }

  return {
    clock,
    db,
    jobs,
    stepRuns,
    runner,
    finalize,
    worker: newWorker(),
    newWorker,
    enqueue,
    get,
  };
}

describe('one at a time, in queue order', () => {
  it('runs three queued jobs strictly one after another, oldest first', async () => {
    const { worker, runner, enqueue, get } = setup();
    const [a, b, c] = [enqueue('A'), enqueue('B'), enqueue('C')] as [string, string, string];
    expect([a, b, c].map((id) => get(id).placeInLine)).toEqual([1, 2, 3]);

    worker.start();
    await settle();

    expect(runner.ids).toEqual([a]);
    expect(runner.call(0).mode).toBe('start');
    expect(get(a).state).toBe('editing');
    expect(get(b)).toMatchObject({ state: 'queued', placeInLine: 1 });
    expect(get(c)).toMatchObject({ state: 'queued', placeInLine: 2 });

    runner.call(0).end({ ok: true });
    await settle();

    expect(runner.ids).toEqual([a, b]);
    expect(get(a).state).toBe('ready');
    expect(get(b).state).toBe('editing');
    expect(get(c).placeInLine).toBe(1);

    runner.call(1).end({ ok: true });
    await settle();
    expect(runner.ids).toEqual([a, b, c]);

    runner.call(2).end({ ok: true });
    await worker.idle();

    expect([a, b, c].map((id) => get(id).state)).toEqual(['ready', 'ready', 'ready']);
    expect(runner.maxRunning).toBe(1);
    expect(worker.activeJobId).toBeNull();
  });

  it('runs jobs in the order placeInLine shows, including ties on settledAt', async () => {
    const { worker, runner, jobs, clock, get } = setup();
    // Added C, A, B but all settled in the same instant: the tie goes to who was added first.
    const ids = ['C', 'A', 'B'].map((name) => {
      const id = jobs.upsertFromScan(makeScan('Client', name)).job.id;
      clock.tick(1_000);
      return id;
    }) as [string, string, string];
    clock.tick(SETTLE_MS);
    for (const id of ids) jobs.applyTransition(id, { type: 'SETTLED' });
    expect(new Set(ids.map((id) => get(id).settledAt)).size).toBe(1);
    expect(ids.map((id) => get(id).placeInLine)).toEqual([1, 2, 3]);

    worker.start();
    for (let i = 0; i < 3; i++) {
      await settle();
      runner.call(i).end({ ok: true });
    }
    await worker.idle();

    expect(runner.ids).toEqual(ids);
  });

  it('puts a released job at the back of the line, and runs it there', async () => {
    const { worker, runner, jobs, clock, enqueue, get } = setup();
    const [a, b, c] = [enqueue('A'), enqueue('B'), enqueue('C')] as [string, string, string];
    jobs.applyTransition(a, { type: 'HOLD' });
    clock.tick(1_000);
    jobs.applyTransition(a, { type: 'RELEASE' });
    expect([b, c, a].map((id) => get(id).placeInLine)).toEqual([1, 2, 3]);

    worker.start();
    for (let i = 0; i < 3; i++) {
      await settle();
      runner.call(i).end({ ok: true });
    }
    await worker.idle();

    expect(runner.ids).toEqual([b, c, a]);
  });

  it('never runs two jobs at once, whatever the notifications', async () => {
    const { worker, runner, enqueue } = setup();
    for (const name of ['A', 'B', 'C', 'D']) enqueue(name);

    worker.start();
    worker.notify();
    worker.notify();
    await Promise.resolve();
    worker.notify();
    await settle();
    expect(runner.calls).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      // A notification in the very turn the run ends, and more after it.
      worker.notify();
      runner.call(i).end({ ok: true });
      worker.notify();
      await Promise.resolve();
      worker.notify();
      await settle();
    }
    await worker.idle();

    expect(runner.calls).toHaveLength(4);
    expect(new Set(runner.ids).size).toBe(4);
    expect(runner.maxRunning).toBe(1);
  });

  it('wakes when a job becomes queued, and picks up the next one by itself when a run ends', async () => {
    const { worker, runner, enqueue, get } = setup();
    worker.start();
    await settle();
    expect(runner.calls).toHaveLength(0);

    const a = enqueue('A');
    worker.notify();
    await settle();
    expect(runner.ids).toEqual([a]);

    // Queued while A runs, without any notification of its own beyond the first.
    const b = enqueue('B');
    worker.notify();
    await settle();
    expect(runner.ids).toEqual([a]);

    runner.call(0).end({ ok: true });
    await settle();

    expect(runner.ids).toEqual([a, b]);
    expect(get(b).state).toBe('editing');
  });

  it('ignores notifications before start and after stop', async () => {
    const { worker, runner, enqueue } = setup();
    enqueue('A');

    worker.notify();
    await settle();
    expect(runner.calls).toHaveLength(0);

    worker.start();
    worker.start();
    await settle();
    expect(runner.calls).toHaveLength(1);

    runner.call(0).end({ ok: true });
    await worker.idle();
    await worker.stop();
    enqueue('B');
    worker.notify();
    await settle();
    expect(runner.calls).toHaveLength(1);
  });
});

describe('held jobs', () => {
  it('skips a job held while it waits, and runs it after Release', async () => {
    const { worker, runner, jobs, enqueue, get } = setup();
    const [a, b, c] = [enqueue('A'), enqueue('B'), enqueue('C')] as [string, string, string];
    worker.start();
    await settle();
    expect(runner.ids).toEqual([a]);

    jobs.applyTransition(b, { type: 'HOLD' });
    expect(get(c).placeInLine).toBe(1);
    worker.notify();
    runner.call(0).end({ ok: true });
    await settle();

    expect(runner.ids).toEqual([a, c]);
    runner.call(1).end({ ok: true });
    await worker.idle();
    expect(runner.ids).toEqual([a, c]);
    expect(get(b).state).toBe('held');

    jobs.applyTransition(b, { type: 'RELEASE' });
    worker.notify();
    await settle();

    expect(runner.ids).toEqual([a, c, b]);
    expect(get(b).state).toBe('editing');
  });

  it('moves on when the job it was about to start has just been held', async () => {
    const { worker, runner, jobs, enqueue, get } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    jobs.applyTransition(a, { type: 'HOLD' });
    // The worker looked, then A was held: START finds a held job and must not run it.
    vi.spyOn(jobs, 'nextQueued').mockReturnValueOnce({ ...get(a), state: 'queued' });

    worker.start();
    await settle();

    expect(runner.ids).toEqual([b]);
    expect(get(a).state).toBe('held');
  });
});

describe('cancel', () => {
  it('stops the active job, then the next one starts', async () => {
    const { worker, runner, enqueue, get } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    const cancelled = await worker.cancel(a);

    expect(runner.call(0).aborted).toBe(true);
    expect(cancelled).toMatchObject({ id: a, state: 'cancelled', stoppedAt: 1 });
    expect(get(a).state).toBe('cancelled');
    await settle();
    expect(runner.ids).toEqual([a, b]);
    expect(get(b).state).toBe('editing');
    expect(runner.maxRunning).toBe(1);
  });

  it('tells the runner it was a cancel', async () => {
    const { worker, runner, enqueue } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();
    expect(runner.call(0).abortReason).toBeNull();

    await worker.cancel(a);

    expect(runner.call(0).abortReason).toBe('cancel');
  });

  it('waits until the runner has actually stopped before cancelling and moving on', async () => {
    const { worker, runner, enqueue, get } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    runner.stopOnAbort = false;
    worker.start();
    await settle();

    let done = false;
    const cancelling = worker.cancel(a).then((job) => {
      done = true;
      return job;
    });
    await settle();

    expect(runner.call(0).aborted).toBe(true);
    expect(done).toBe(false);
    expect(get(a).state).toBe('editing');
    expect(runner.ids).toEqual([a]);

    runner.call(0).end({ ok: false, error: 'killed' });
    const job = await cancelling;

    expect(job?.state).toBe('cancelled');
    await settle();
    expect(runner.ids).toEqual([a, b]);
  });

  it('keeps the step the job had been reported at as the one it stopped at', async () => {
    const { worker, runner, enqueue } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).context.progress(5, '2/5');

    const job = await worker.cancel(a);

    expect(job).toMatchObject({ state: 'cancelled', step: 5, stoppedAt: 5 });
  });

  it('answers null for a job it is not running, so the caller can answer 409', async () => {
    const { worker, enqueue, jobs } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    expect(await worker.cancel(b)).toBeNull();
    expect(await worker.cancel('nope')).toBeNull();
    expect(jobs.get(b)?.state).toBe('queued');
    expect(jobs.get(a)?.state).toBe('editing');
  });

  it('two cancels of one job wait for the same stop', async () => {
    const { worker, enqueue } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();

    const [first, second] = await Promise.all([worker.cancel(a), worker.cancel(a)]);

    expect(first?.state).toBe('cancelled');
    expect(second?.state).toBe('cancelled');
  });

  it('lets an edit that finished first stay finished', async () => {
    const { worker, runner, enqueue } = setup();
    const a = enqueue('A');
    runner.stopOnAbort = false;
    worker.start();
    await settle();

    const cancelling = worker.cancel(a);
    runner.call(0).end({ ok: true });
    const job = await cancelling;

    expect(job).toMatchObject({ state: 'ready', output: OUTPUT });
  });

  it('cancels during the export too: the export is told to stop', async () => {
    const exporting = deferred<JobOutput>();
    let exportSignal: AbortSignal | undefined;
    const finalize: Finalize = (_job, signal) => {
      exportSignal = signal;
      signal.addEventListener('abort', () => exporting.reject(new Error('export aborted')));
      return exporting.promise;
    };
    const { worker, runner, enqueue } = setup({ finalize });
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).end({ ok: true });
    await settle();
    expect(exportSignal?.aborted).toBe(false);

    const job = await worker.cancel(a);

    expect(exportSignal?.aborted).toBe(true);
    expect(job?.state).toBe('cancelled');
  });
});

describe('how a run ends', () => {
  it('exports on success, then saves the output and marks the job ready', async () => {
    const finalize = vi.fn(async () => OUTPUT);
    const { worker, runner, enqueue, get } = setup({ finalize });
    const a = enqueue('A');
    worker.start();
    await settle();
    expect(finalize).not.toHaveBeenCalled();

    runner.call(0).end({ ok: true });
    await worker.idle();

    expect(finalize).toHaveBeenCalledTimes(1);
    const [job, signal] = finalize.mock.calls[0] as unknown as [Job, AbortSignal];
    expect(job).toMatchObject({ id: a, state: 'editing' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(get(a)).toMatchObject({ state: 'ready', step: 8, output: OUTPUT });
  });

  it('fails the job at the step the runner names, with its error', async () => {
    const { worker, runner, enqueue, get } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).context.progress(2);

    runner.call(0).end({ ok: false, error: 'no transcript came back', step: 3 });
    await worker.idle();

    expect(get(a)).toMatchObject({
      state: 'failed',
      failedAt: 3,
      step: 3,
      error: 'no transcript came back',
    });
  });

  it('fails at the last reported step when the runner names none', async () => {
    const { worker, runner, enqueue, get } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).context.progress(5, null);

    runner.call(0).end({ ok: false, error: 'claude exited with code 1' });
    await worker.idle();

    expect(get(a)).toMatchObject({ state: 'failed', failedAt: 5 });
  });

  it('fails at step 1 when nothing was reported and the runner names no step', async () => {
    const { worker, runner, enqueue, get } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).end({ ok: false, error: 'could not start' });
    await worker.idle();

    expect(get(a)).toMatchObject({ state: 'failed', failedAt: 1, error: 'could not start' });
  });

  it('treats a rejecting runner as a failure with the error message', async () => {
    const { worker, runner, enqueue, get } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    runner.call(0).crash(new Error('spawn claude ENOENT'));
    await settle();

    expect(get(a)).toMatchObject({ state: 'failed', error: 'spawn claude ENOENT' });
    expect(runner.ids).toEqual([a, b]);
  });

  it('treats a runner that throws at once, or rejects with a string, as a failure', async () => {
    const { worker, runner, jobs, enqueue, get } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    vi.spyOn(runner, 'start').mockImplementationOnce(() => {
      throw new Error('bad prompt template');
    });
    worker.start();
    await settle();
    expect(get(a)).toMatchObject({ state: 'failed', error: 'bad prompt template' });
    expect(get(b).state).toBe('editing');

    runner.call(0).crash('plain string');
    await settle();
    expect(jobs.get(b)).toMatchObject({ state: 'failed', error: 'plain string' });
  });

  it('treats a runner that returns nothing as a failure', async () => {
    const { worker, runner, enqueue, get } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).end(undefined as unknown as RunOutcome);
    await settle();

    expect(get(a).state).toBe('failed');
    expect(get(a).error).toMatch(/without saying/);
  });

  it('fails at Render when the export fails, and goes on to the next job', async () => {
    const finalize = vi
      .fn<Finalize>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(OUTPUT);
    const { worker, runner, enqueue, get } = setup({ finalize });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    runner.call(0).end({ ok: true });
    await settle();

    expect(get(a)).toMatchObject({
      state: 'failed',
      failedAt: 8,
      error: 'Export failed: disk full',
    });
    expect(runner.ids).toEqual([a, b]);
  });

  it('still starts the next job when the first one failed', async () => {
    const { worker, runner, enqueue } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    runner.call(0).end({ ok: false, error: 'boom' });
    await settle();

    expect(runner.ids).toEqual([a, b]);
  });
});

// W2 (CVP-108): with the Review switch on, an edit run ends in Review (PREVIEW_READY) with the
// composition the runner reports, and nothing is exported.
describe('how a run ends with the Review switch on', () => {
  it('applies PREVIEW_READY with the preview: review, Check (7), finished, nothing exported', async () => {
    const finalize = vi.fn(async () => OUTPUT);
    const { worker, runner, enqueue, get, jobs } = setup({ review: true, finalize });
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).context.progress(6);
    runner.call(0).context.progress(7, 'pass 1/3');

    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await worker.idle();

    expect(finalize).not.toHaveBeenCalled();
    expect(get(a)).toMatchObject({
      state: 'review',
      step: 7,
      subProgress: null,
      preview: SAMPLE_PREVIEW,
      runKind: 'edit',
      output: null,
      error: null,
      failedAt: null,
    });
    expect(jobs.getMeta(a)?.finishedAt).not.toBeNull();
    expect(worker.activeJobId).toBeNull();
  });

  it('keeps a version of the preview just before PREVIEW_READY, and a failure to do so does not fail the run', async () => {
    const stateAtCapture: string[] = [];
    const captureVersion = vi.fn(async (job: Job) => {
      stateAtCapture.push(job.state);
      throw new Error('disk full');
    });
    const warn = vi.fn();
    const { worker, runner, enqueue, get } = setup({
      review: true,
      captureVersion,
      logger: { info() {}, warn, error() {} },
    });
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await worker.idle();

    expect(captureVersion).toHaveBeenCalledOnce();
    expect(captureVersion).toHaveBeenCalledWith(expect.objectContaining({ id: a }), SAMPLE_PREVIEW);
    expect(stateAtCapture).toEqual(['editing']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: a }),
      'could not keep a version of the preview',
    );
    expect(get(a)).toMatchObject({ state: 'review', preview: SAMPLE_PREVIEW, error: null });
  });

  it('tells afterRun when a run ends, whether it worked or failed, and a rejection changes nothing (C67)', async () => {
    const afterRun = vi.fn(async (job: Job) => {
      if (job.name === 'B') throw new Error('unreadable');
    });
    const warn = vi.fn();
    const { worker, runner, enqueue, get } = setup({
      review: true,
      afterRun,
      logger: { info() {}, warn, error() {} },
    });
    const a = enqueue('A');
    const b = enqueue('B');
    worker.start();
    await settle();

    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await settle();
    runner.call(1).end({ ok: false, error: 'boom' });
    await worker.idle();

    expect(afterRun).toHaveBeenCalledTimes(2);
    expect(afterRun).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: a }));
    expect(afterRun).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: b }));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: b }),
      'could not look after a run that ended',
    );
    expect(get(a).state).toBe('review');
    expect(get(b)).toMatchObject({ state: 'failed', error: 'boom' });
  });

  it('keeps no version when the run fails', async () => {
    const captureVersion = vi.fn(async () => {});
    const { worker, runner, enqueue, get } = setup({ review: true, captureVersion });
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).end({ ok: false, error: 'boom' });
    await worker.idle();

    expect(captureVersion).not.toHaveBeenCalled();
    expect(get(a).state).toBe('failed');
  });

  it('closes the timing of the running step, so Check counts toward the ETA', async () => {
    const { worker, runner, stepRuns, clock, enqueue } = setup({ review: true });
    const a = enqueue('A');
    worker.start();
    await settle();
    const { progress } = runner.call(0).context;

    clock.tick(1_000);
    progress(6);
    clock.tick(4_000);
    progress(7, 'pass 1/3');
    clock.tick(9_000);
    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await worker.idle();

    expect(stepRuns.recentDurations(6, 10, 'edit')).toEqual([
      { jobId: a, durationSec: 4, footageSec: 540.5 },
    ]);
    expect(stepRuns.recentDurations(7, 10, 'edit')).toEqual([
      { jobId: a, durationSec: 9, footageSec: 540.5 },
    ]);
    expect(stepRuns.recentDurations(8, 10, 'edit')).toEqual([]);
  });

  it('goes on to the next job, which waits for no export', async () => {
    const { worker, runner, enqueue, get } = setup({ review: true });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await settle();

    expect(get(a).state).toBe('review');
    expect(runner.ids).toEqual([a, b]);
    expect(get(b).state).toBe('editing');
  });

  it('fails at Preview (6) when the runner says ok but reports no composition', async () => {
    const finalize = vi.fn(async () => OUTPUT);
    const { worker, runner, enqueue, get } = setup({ review: true, finalize });
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).end({ ok: true });
    await worker.idle();

    expect(finalize).not.toHaveBeenCalled();
    expect(get(a)).toMatchObject({
      state: 'failed',
      failedAt: 6,
      step: 6,
      error: PREVIEW_NOT_REPORTED,
    });
  });

  it.each([
    ['a zero length', { durationSec: 0, width: 1080, height: 1920 }],
    ['a fractional width', { durationSec: 6, width: 1080.5, height: 1920 }],
    ['a missing height', { durationSec: 6, width: 1080 }],
    ['text', 'not a preview'],
    ['null', null],
  ])('fails at Preview (6) for a malformed preview: %s', async (_label, preview) => {
    const { worker, runner, enqueue, get } = setup({ review: true });
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).end({ ok: true, preview } as unknown as RunOutcome);
    await worker.idle();

    expect(get(a)).toMatchObject({ state: 'failed', failedAt: 6, error: PREVIEW_NOT_REPORTED });
    expect(get(a).preview).toBeNull();
  });

  it('keeps the usual rules for a failure: it fails at the step the runner names', async () => {
    const { worker, runner, enqueue, get } = setup({ review: true });
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).context.progress(5);

    runner.call(0).end({
      ok: false,
      error: 'Finished without a preview: edit/preview/index.html is missing.',
      step: 6,
    });
    await worker.idle();

    expect(get(a)).toMatchObject({
      state: 'failed',
      failedAt: 6,
      error: 'Finished without a preview: edit/preview/index.html is missing.',
    });
  });

  it('fails at the last reported step when the runner names none', async () => {
    const { worker, runner, enqueue, get } = setup({ review: true });
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).context.progress(6);

    runner.call(0).end({ ok: false, error: 'claude exited with code 1' });
    await worker.idle();

    expect(get(a)).toMatchObject({ state: 'failed', failedAt: 6 });
  });

  it('is not undone by a cancel that arrives after the run succeeded', async () => {
    const { worker, runner, enqueue, get } = setup({ review: true });
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.stopOnAbort = false;

    const cancelling = worker.cancel(a);
    await settle();
    expect(runner.call(0).aborted).toBe(true);
    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    const result = await cancelling;

    expect(result).toMatchObject({ id: a, state: 'review' });
    expect(get(a)).toMatchObject({ state: 'review', preview: SAMPLE_PREVIEW });
  });

  it('still cancels a run that was stopped', async () => {
    const { worker, enqueue, get } = setup({ review: true });
    const a = enqueue('A');
    worker.start();
    await settle();

    await worker.cancel(a);

    expect(get(a).state).toBe('cancelled');
  });

  it('leaves a job editing when the engine stops mid-run, as before', async () => {
    const { worker, runner, enqueue, get } = setup({ review: true });
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).context.progress(5);

    await worker.stop();

    expect(get(a)).toMatchObject({ state: 'editing', step: 5 });
  });

  it('resumes a job a crash left in editing, and it ends in Review', async () => {
    const { runner, jobs, enqueue, get, newWorker, finalize } = setup({ review: true });
    const a = enqueue('A');
    jobs.applyTransition(a, { type: 'START' });
    jobs.applyTransition(a, { type: 'PROGRESS', step: 6, sub: null });

    const rebooted = newWorker();
    rebooted.start();
    await settle();

    expect(runner.call(0).mode).toBe('resume');
    expect(runner.call(0).job).toMatchObject({ id: a, runKind: 'edit', step: 6 });

    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await rebooted.idle();

    expect(get(a)).toMatchObject({ state: 'review', step: 7, preview: SAMPLE_PREVIEW });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('publishes the job once for PREVIEW_READY', async () => {
    const seen: Array<[string, string]> = [];
    const { worker, runner, enqueue } = setup({
      review: true,
      onJobChanged: (job) => seen.push([job.id, job.state]),
    });
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await worker.idle();

    expect(seen).toEqual([
      [a, 'editing'],
      [a, 'review'],
    ]);
  });
});

describe('how a run ends with the Review switch off (the default)', () => {
  it('exports and marks the job ready, whatever preview the runner mentions', async () => {
    const finalize = vi.fn(async () => OUTPUT);
    const { worker, runner, enqueue, get } = setup({ finalize });
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await worker.idle();

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(get(a)).toMatchObject({ state: 'ready', step: 8, output: OUTPUT, preview: null });
  });

  it('exports with review: false given, too', async () => {
    const finalize = vi.fn(async () => OUTPUT);
    const { worker, runner, enqueue, get } = setup({ review: false, finalize });
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).end({ ok: true });
    await worker.idle();

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(get(a).state).toBe('ready');
  });
});

describe('the mode a job runs in', () => {
  it('is start for a fresh job, retry after Retry and resume after Resume', async () => {
    const { worker, runner, jobs, enqueue, get } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();
    expect(runner.call(0).mode).toBe('start');

    // A fails at step 4 and is retried; B is cancelled at step 3 and resumed.
    runner.call(0).end({ ok: false, error: 'boom', step: 4 });
    await settle();
    runner.call(1).context.progress(3);
    await worker.cancel(b);
    await settle();
    jobs.applyTransition(a, { type: 'RETRY' });
    jobs.applyTransition(b, { type: 'RESUME' });
    worker.notify();
    await settle();

    expect(runner.ids).toEqual([a, b, a]);
    expect(runner.call(2).mode).toBe('retry');
    expect(runner.call(2).job).toMatchObject({ id: a, state: 'editing', step: 4 });
    runner.call(2).end({ ok: true });
    await settle();

    expect(runner.ids).toEqual([a, b, a, b]);
    expect(runner.call(3).mode).toBe('resume');
    expect(get(b).step).toBe(3);
  });

  // B4: a job still at step 1 failed or was stopped at Brief, before the edit began, so there is
  // no edit to carry on: after its brief, the edit runs with the start prompt.
  it('is start for a job failed or cancelled at Brief, whatever brought it back', async () => {
    const { worker, runner, jobs, enqueue } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();
    runner.call(0).end({ ok: false, error: 'Brief stopped: no brief.json', step: 1 });
    await settle();
    await worker.cancel(b);
    jobs.applyTransition(a, { type: 'RETRY' });
    jobs.applyTransition(b, { type: 'RESUME' });
    worker.notify();
    await settle();

    expect(runner.call(2)).toMatchObject({ mode: 'start', job: { id: a, step: 1 } });
    runner.call(2).end({ ok: true });
    await settle();
    expect(runner.call(3)).toMatchObject({ mode: 'start', job: { id: b, step: 1 } });
  });
});

describe('the Brief step (B4)', () => {
  it('runs before the runner, which starts only once the brief is ready', async () => {
    const brief = new ScriptedBrief();
    const { worker, runner, enqueue, get } = setup({ brief });
    const a = enqueue('A');
    worker.start();
    await settle();

    expect(brief.calls).toHaveLength(1);
    expect(brief.call(0).job).toMatchObject({ id: a, state: 'editing', step: 1 });
    expect(runner.calls).toHaveLength(0);
    expect(get(a)).toMatchObject({ state: 'editing', step: 1 });

    brief.call(0).end(BRIEF_READY);
    await settle();
    expect(runner.call(0)).toMatchObject({ mode: 'start', job: { id: a, step: 1 } });
  });

  it('runs on retry and resume too, and the edit carries on from its own step', async () => {
    const brief = new ScriptedBrief();
    brief.autoEnd = BRIEF_READY;
    const { worker, runner, jobs, enqueue } = setup({ brief });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();
    runner.call(0).end({ ok: false, error: 'boom', step: 4 });
    await settle();
    runner.call(1).context.progress(5);
    await worker.cancel(b);
    jobs.applyTransition(a, { type: 'RETRY' });
    jobs.applyTransition(b, { type: 'RESUME' });
    worker.notify();
    await settle();
    runner.call(2).end({ ok: true });
    await settle();

    expect(brief.calls.map((call) => call.job.id)).toEqual([a, b, a, b]);
    expect(runner.call(2)).toMatchObject({ mode: 'retry', job: { id: a, step: 4 } });
    expect(runner.call(3)).toMatchObject({ mode: 'resume', job: { id: b, step: 5 } });
  });

  // CVP-134: Transcribe's N is the brief's footage files, handed to the runner for its tracker.
  describe("hands the brief's footage count to the runner (Transcribe's N)", () => {
    const FILES: { path: string; role: BriefFileRole }[] = [
      ...['a', 'b', 'c', 'd'].map((name) => ({ path: `${name}.mp4`, role: 'footage' as const })),
      { path: 'e.mp4', role: 'ignore' },
      { path: 'voice-1.opus', role: 'instructions' },
      { path: 'voice-2.opus', role: 'instructions' },
    ];

    it('4 footage files, 1 ignored clip and 2 voice notes make N = 4', async () => {
      const brief = new ScriptedBrief();
      brief.autoEnd = briefReady(FILES);
      const { worker, runner, enqueue } = setup({ brief });
      enqueue('A');
      worker.start();
      await settle();

      expect(runner.call(0).context.transcribeTotal).toBe(4);
    });

    it('a retry and a resume (a replay after a restart) count toward the same N', async () => {
      const brief = new ScriptedBrief();
      brief.autoEnd = briefReady(FILES);
      const { worker, runner, jobs, enqueue } = setup({ brief });
      const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
      worker.start();
      await settle();
      runner.call(0).end({ ok: false, error: 'boom', step: 4 });
      await settle();
      runner.call(1).context.progress(5);
      await worker.cancel(b);
      jobs.applyTransition(a, { type: 'RETRY' });
      jobs.applyTransition(b, { type: 'RESUME' });
      worker.notify();
      await settle();

      expect(runner.call(2)).toMatchObject({ mode: 'retry' });
      expect(runner.call(2).context.transcribeTotal).toBe(4);
      runner.call(2).end({ ok: true });
      await settle();
      expect(runner.call(3)).toMatchObject({ mode: 'resume' });
      expect(runner.call(3).context.transcribeTotal).toBe(4);
    });

    it('the job shows Transcribe 0/4 up to 4/4 and never waits for the 7th file', async () => {
      const root = mkdtempSync(join(tmpdir(), 'studio-worker-total-'));
      try {
        const brief = new ScriptedBrief();
        brief.autoEnd = briefReady(FILES);
        const { worker, runner, enqueue, get } = setup({ brief });
        const id = enqueue('A');
        worker.start();
        await settle();

        // What the Claude runner does with the context: the tracker counts toward its total.
        const call = runner.call(0);
        const editDir = join(root, 'edit');
        mkdirSync(join(editDir, 'transcripts'), { recursive: true });
        const tracker = startProgressTracker(
          {
            job: call.job,
            mode: call.mode,
            editDir,
            signal: call.context.signal,
            progress: call.context.progress,
            transcribeTotal: call.context.transcribeTotal,
          },
          { pollIntervalMs: 60_000 },
        );
        await tracker.ready;
        expect(get(id)).toMatchObject({ step: 2, subProgress: '0/4' });

        for (const name of ['a', 'b', 'c', 'd']) {
          writeFileSync(join(editDir, 'transcripts', `${name}.json`), '{}');
        }
        await tracker.stop();
        expect(get(id)).toMatchObject({ step: 2, subProgress: '4/4' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('each job gets the count of its own brief', async () => {
      const brief = new ScriptedBrief();
      const { worker, runner, enqueue } = setup({ brief });
      enqueue('A');
      enqueue('B');
      worker.start();
      await settle();
      brief.call(0).end(briefReady(FILES));
      await settle();
      runner.call(0).end({ ok: true });
      await settle();
      brief.call(1).end(briefReady([{ path: 'solo.mp4', role: 'footage' }]));
      await settle();

      expect(runner.call(0).context.transcribeTotal).toBe(4);
      expect(runner.call(1).context.transcribeTotal).toBe(1);
    });

    it('leaves it out without a Brief step: the runner counts the job’s audio and video files', async () => {
      const { worker, runner, enqueue } = setup();
      enqueue('A');
      worker.start();
      await settle();

      expect(runner.call(0).context).not.toHaveProperty('transcribeTotal');
    });

    it('a brief it cannot count does not stop the edit', async () => {
      const brief = new ScriptedBrief();
      brief.autoEnd = { ok: true, source: 'ran', brief: {} as ReadyBrief };
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const { worker, runner, enqueue } = setup({ brief, logger });
      enqueue('A');
      worker.start();
      await settle();

      expect(runner.calls).toHaveLength(1);
      expect(runner.call(0).context).not.toHaveProperty('transcribeTotal');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('footage'),
      );
    });
  });

  it("shows step 1 with the Brief run's progress, and times step 1 only when one ran", async () => {
    const brief = new ScriptedBrief();
    const { worker, runner, stepRuns, clock, enqueue, get } = setup({ brief });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    const { progress } = brief.call(0).context;
    progress('reading 2 files');
    expect(get(a)).toMatchObject({ step: 1, subProgress: 'reading 2 files' });
    clock.tick(3_000);
    progress('voice notes 1/2');
    expect(get(a)).toMatchObject({ step: 1, subProgress: 'voice notes 1/2' });
    clock.tick(2_000);
    brief.call(0).end(BRIEF_READY);
    await settle();
    clock.tick(1_000);
    runner.call(0).context.progress(2, '0/3');
    clock.tick(4_000);
    runner.call(0).end({ ok: true });
    await settle();

    // B's brief is reused: no progress, so step 1 gets no sample from it.
    brief.call(1).end({ ...BRIEF_READY, source: 'reused' } as BriefOutcome);
    await settle();
    expect(get(b)).toMatchObject({ step: 1, subProgress: null });
    runner.call(1).context.progress(2);
    runner.call(1).end({ ok: true });
    await worker.idle();

    expect(stepRuns.recentDurations(1, 10, 'edit')).toEqual([
      { jobId: a, durationSec: 5, footageSec: 540.5 },
    ]);
    expect(stepRuns.recentDurations(2, 10, 'edit').map((run) => run.jobId)).toEqual([b, a]);
  });

  it('fails the job at Brief with the error, and never starts the runner', async () => {
    const brief = new ScriptedBrief();
    const { worker, runner, enqueue, get } = setup({ brief });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();
    brief.call(0).context.progress('reading 1 file');
    const error = 'Brief stopped: brief.json didn’t match the schema (goal: missing).';
    brief.call(0).end({ ok: false, error });
    await settle();

    expect(get(a)).toMatchObject({ state: 'failed', failedAt: 1, step: 1, error });
    expect(runner.ids).toEqual([]);
    // The queue moves on.
    expect(brief.call(1).job.id).toBe(b);
  });

  it('fails at Brief with "Brief stopped:" when the step itself throws', async () => {
    const brief: BriefRun = {
      prepare: async () => {
        throw new Error('disk on fire');
      },
    };
    const { worker, runner, enqueue, get } = setup({ brief });
    const a = enqueue('A');
    worker.start();
    await worker.idle();

    expect(get(a)).toMatchObject({
      state: 'failed',
      failedAt: 1,
      error: 'Brief stopped: disk on fire',
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('cancels during the Brief run: the brief is stopped, the job is cancelled at step 1', async () => {
    const brief = new ScriptedBrief();
    const { worker, runner, enqueue, get } = setup({ brief });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();
    brief.call(0).context.progress('reading 3 files');

    const cancelled = await worker.cancel(a);

    expect(brief.call(0).context.signal.aborted).toBe(true);
    expect(cancelled).toMatchObject({ id: a, state: 'cancelled', stoppedAt: 1 });
    expect(get(a).stoppedAt).toBe(1);
    expect(runner.ids).toEqual([]);
    await settle();
    expect(brief.call(1).job.id).toBe(b);
  });

  it('a shutdown during the Brief run leaves the job editing; the next boot briefs it again', async () => {
    const brief = new ScriptedBrief();
    const { worker, runner, enqueue, get, newWorker } = setup({ brief });
    const a = enqueue('A');
    worker.start();
    await settle();
    brief.call(0).context.progress('reading 1 file');

    await worker.stop();
    expect(get(a)).toMatchObject({ state: 'editing', step: 1 });
    expect(runner.calls).toHaveLength(0);

    const rebooted = newWorker();
    rebooted.start();
    await settle();
    expect(brief.calls).toHaveLength(2);
    brief.call(1).end(BRIEF_READY);
    await settle();
    // Recovered as `resume`, but still at Brief: there is no edit to resume yet.
    expect(runner.call(0)).toMatchObject({ mode: 'start', job: { id: a } });
  });

  it('a new brief before a retry shows Brief, then the step it carries on from, untimed', async () => {
    const brief = new ScriptedBrief();
    brief.autoEnd = BRIEF_READY;
    const { worker, runner, jobs, stepRuns, clock, enqueue, get } = setup({ brief });
    const seen: Array<[number | null, string | null]> = [];
    const a = enqueue('A');
    worker.start();
    await settle();
    runner.call(0).end({ ok: false, error: 'render crashed', step: 5 });
    await settle();
    expect(get(a)).toMatchObject({ state: 'failed', step: 5 });

    // The owner changed the note, so the retry's brief has to run again.
    brief.autoEnd = null;
    jobs.applyTransition(a, { type: 'RETRY' });
    worker.notify();
    await settle();
    seen.push([get(a).step, get(a).subProgress]);
    brief.call(1).context.progress('reading 2 files');
    seen.push([get(a).step, get(a).subProgress]);
    clock.tick(7_000);
    brief.call(1).end(BRIEF_READY);
    await settle();
    seen.push([get(a).step, get(a).subProgress]);

    expect(seen).toEqual([
      [5, null],
      [1, 'reading 2 files'],
      [5, null],
    ]);
    expect(runner.call(1)).toMatchObject({ mode: 'retry', job: { id: a, step: 5 } });
    clock.tick(3_000);
    runner.call(1).context.progress(6);
    runner.call(1).end({ ok: true });
    await worker.idle();

    expect(stepRuns.recentDurations(1, 10, 'edit')).toEqual([
      { jobId: a, durationSec: 7, footageSec: 540.5 },
    ]);
    expect(stepRuns.recentDurations(5, 10, 'edit')).toEqual([]);
  });
});

// CVP-132: a job whose fresh brief failed (or was stopped) falls back to step 1 with everything the
// edit made still in edit/. Its next edit carries on from that work and does not start over; only
// a job with nothing of the edit in edit/ edits with the start prompt.
describe('a job back at Brief with edit work in edit/ (CVP-132)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Waits for `condition` through a few turns of the event loop (the worker reads files). */
  async function until(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 200 && !condition(); turn += 1) await settle();
    expect(condition()).toBe(true);
  }

  function folders(): ReexportOptions {
    const root = mkdtempSync(join(tmpdir(), 'studio-worker-brief-'));
    tempDirs.push(root);
    return { inboxPath: join(root, 'inbox'), logsDir: join(root, 'logs') };
  }

  function editDirOf(folder: ReexportOptions, job: Job): string {
    return join(folder.inboxPath, job.relPath, 'edit');
  }

  /** Writes files into the job's edit/ folder, as the edit run and the Brief step do. */
  function write(folder: ReexportOptions, job: Job, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      const full = join(editDirOf(folder, job), path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }

  /** What an edit that got to Cut (5) leaves, with one of its two graphics rendered. */
  const CUT_WORK = {
    'brief.json': '{}',
    'brief.md': '# Brief',
    'transcripts/a.json': '{}',
    'takes_packed.md': 'packed',
    'project.md': 'plan',
    'edl.json': '{"overlays":[{},{}]}',
    'animations/slot_1/index.html': '<html></html>',
    'animations/slot_1/render.mov': 'mov',
    'animations/slot_2/index.html': '<html></html>',
  };

  /** Runs job A until its edit fails at Cut (5), with that work in edit/. */
  async function failedAtCut(brief: ScriptedBrief) {
    const folder = folders();
    brief.autoEnd = BRIEF_READY;
    const result = setup({ brief, reexport: folder });
    const id = result.enqueue('A');
    result.worker.start();
    await until(() => result.runner.calls.length === 1);
    expect(result.runner.call(0).mode).toBe('start');
    write(folder, result.get(id), CUT_WORK);
    result.runner.call(0).context.progress(5, 'graphics 1/2');
    result.runner.call(0).end({ ok: false, error: 'render crashed', step: 5 });
    await result.worker.idle();
    expect(result.get(id)).toMatchObject({ state: 'failed', failedAt: 5, step: 5 });
    return { ...result, folder, id };
  }

  /** Presses Retry and wakes the worker, as the retry route does. */
  function retry(result: ReturnType<typeof setup>, id: string): void {
    result.jobs.applyTransition(id, { type: 'RETRY' });
    result.worker.notify();
  }

  it('a failed fresh brief, then Retry: the edit retries and the progress jumps to the replayed step', async () => {
    const brief = new ScriptedBrief();
    const result = await failedAtCut(brief);
    const { runner, stepRuns, clock, folder, id, get } = result;

    // The owner changes the note; the fresh brief fails, and the job drops to step 1.
    const error = 'Brief stopped: the brief run ended without brief.json.';
    brief.autoEnd = { ok: false, error };
    retry(result, id);
    await result.worker.idle();
    expect(get(id)).toMatchObject({ state: 'failed', failedAt: 1, step: 1, error });
    expect(runner.calls).toHaveLength(1);

    // Retry again, this time the brief works. The edit is not a first edit.
    brief.autoEnd = BRIEF_READY;
    retry(result, id);
    await until(() => runner.calls.length === 2);
    const call = runner.call(1);
    expect(call.mode).toBe('retry');
    expect(call.job).toMatchObject({ id, state: 'editing', step: 1 });

    // The progress tracker the real runner starts replays edit/ and finds the real step.
    const tracker = startProgressTracker(
      {
        job: call.job,
        mode: call.mode,
        editDir: editDirOf(folder, call.job),
        signal: call.context.signal,
        progress: call.context.progress,
      },
      { pollIntervalMs: 60_000 },
    );
    await tracker.ready;
    expect(get(id)).toMatchObject({ state: 'editing', step: 5, subProgress: 'graphics 1/2' });

    // That step was begun in the earlier run: it is not timed, the ones after it are.
    clock.tick(4_000);
    call.context.progress(6);
    clock.tick(2_000);
    call.end({ ok: true });
    await tracker.stop();
    await result.worker.idle();
    expect(get(id).state).toBe('ready');
    expect(stepRuns.recentDurations(5, 10, 'edit')).toEqual([]);
    expect(stepRuns.recentDurations(6, 10, 'edit')).toEqual([
      { jobId: id, durationSec: 2, footageSec: 540.5 },
    ]);
  });

  it('a cancelled fresh brief, then Resume: the edit carries on', async () => {
    const brief = new ScriptedBrief();
    const result = await failedAtCut(brief);
    const { worker, runner, jobs, id, get } = result;

    // The retry's brief runs and shows Brief, then is cancelled: the job drops to step 1.
    brief.autoEnd = null;
    retry(result, id);
    await until(() => brief.calls.length === 2);
    brief.call(1).context.progress('reading 2 files');
    await worker.cancel(id);
    expect(get(id)).toMatchObject({ state: 'cancelled', stoppedAt: 1, step: 1 });
    expect(runner.calls).toHaveLength(1);

    brief.autoEnd = BRIEF_READY;
    jobs.applyTransition(id, { type: 'RESUME' });
    worker.notify();
    await until(() => runner.calls.length === 2);
    // Retried once before, so the queue calls it `retry` (the documented limit of `runModeFor`).
    expect(runner.call(1)).toMatchObject({ mode: 'retry', job: { id, step: 1 } });
  });

  it('a shutdown during a fresh brief, after the edit got to Cut: the next boot resumes the edit', async () => {
    const brief = new ScriptedBrief();
    const result = await failedAtCut(brief);
    const { worker, runner, id, get, newWorker } = result;

    brief.autoEnd = null;
    retry(result, id);
    await until(() => brief.calls.length === 2);
    brief.call(1).context.progress('reading 2 files');
    await worker.stop();
    expect(get(id)).toMatchObject({ state: 'editing', step: 1 });

    const rebooted = newWorker();
    rebooted.start();
    await until(() => brief.calls.length === 3);
    brief.call(2).end(BRIEF_READY);
    await until(() => runner.calls.length === 2);
    // Recovered as `resume`, at Brief, with the edit's work in edit/.
    expect(runner.call(1)).toMatchObject({ mode: 'resume', job: { id, step: 1 } });
  });

  it('does not time the first step reported after carrying on from Brief, only the ones after it', async () => {
    const brief = new ScriptedBrief();
    const result = await failedAtCut(brief);
    const { runner, stepRuns, clock, id } = result;
    brief.autoEnd = { ok: false, error: 'Brief stopped: x' };
    retry(result, id);
    await result.worker.idle();
    brief.autoEnd = BRIEF_READY;
    retry(result, id);
    await until(() => runner.calls.length === 2);

    const call = runner.call(1);
    clock.tick(5_000);
    call.context.progress(5);
    clock.tick(5_000);
    call.context.progress(6);
    clock.tick(3_000);
    call.end({ ok: true });
    await result.worker.idle();

    expect(stepRuns.recentDurations(5, 10, 'edit')).toEqual([]);
    expect(stepRuns.recentDurations(6, 10, 'edit')).toEqual([
      { jobId: id, durationSec: 3, footageSec: 540.5 },
    ]);
  });

  it('a job at Brief with only the Brief step’s files in edit/ still starts', async () => {
    const brief = new ScriptedBrief();
    const folder = folders();
    brief.autoEnd = { ok: false, error: 'Brief stopped: no brief.json' };
    const result = setup({ brief, reexport: folder });
    const { worker, runner, enqueue, get } = result;
    const id = enqueue('A');
    worker.start();
    await worker.idle();
    expect(get(id)).toMatchObject({ state: 'failed', failedAt: 1 });
    write(folder, get(id), {
      'brief.json': '{}',
      'brief.md': '# Brief',
      'brief/transcripts/note.json': '{}',
    });

    brief.autoEnd = BRIEF_READY;
    retry(result, id);
    await until(() => runner.calls.length === 1);

    expect(runner.call(0)).toMatchObject({ mode: 'start', job: { id, step: 1 } });
  });

  it('a job at Brief with no edit/ folder at all still starts', async () => {
    const brief = new ScriptedBrief();
    brief.autoEnd = { ok: false, error: 'Brief stopped: no brief.json' };
    const result = setup({ brief, reexport: folders() });
    const { worker, runner, enqueue } = result;
    const id = enqueue('A');
    worker.start();
    await worker.idle();

    brief.autoEnd = BRIEF_READY;
    retry(result, id);
    await until(() => runner.calls.length === 1);

    expect(runner.call(0)).toMatchObject({ mode: 'start', job: { id, step: 1 } });
  });

  it('a job that has never run starts, whatever is lying in edit/', async () => {
    const brief = new ScriptedBrief();
    brief.autoEnd = BRIEF_READY;
    const folder = folders();
    const { worker, runner, jobs, clock } = setup({ brief, reexport: folder });
    const { job } = jobs.upsertFromScan(makeScan('Client', 'A'));
    write(folder, job, CUT_WORK);
    clock.tick(SETTLE_MS);
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    worker.start();
    await until(() => runner.calls.length === 1);

    expect(runner.call(0)).toMatchObject({ mode: 'start', job: { id: job.id, step: 1 } });
  });

  it('keeps the mode it came with when edit/ cannot be read, and says so', async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const brief = new ScriptedBrief();
    const result = await failedAtCut(brief);
    const { runner, jobs, folder, id, get } = result;
    brief.autoEnd = { ok: false, error: 'Brief stopped: x' };
    retry(result, id);
    await result.worker.idle();
    expect(get(id)).toMatchObject({ failedAt: 1 });

    // A worker with a logger on the same database; edit/ is made unreadable.
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const worker = new QueueWorker({
      jobs,
      stepRuns: result.stepRuns,
      runner,
      brief,
      finalize: result.finalize,
      reexport: folder,
      logger,
    });
    workers.push(worker);
    const editDir = editDirOf(folder, get(id));
    chmodSync(editDir, 0o000);
    try {
      brief.autoEnd = BRIEF_READY;
      jobs.applyTransition(id, { type: 'RETRY' });
      worker.start();
      await until(() => runner.calls.length === 2);
    } finally {
      chmodSync(editDir, 0o755);
    }

    expect(runner.call(1).mode).toBe('retry');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id }),
      expect.stringMatching(/could not look for edit work/),
    );
  });
});

describe('after a crash', () => {
  it('resumes a job left in editing first, without a START, then the queue', async () => {
    const { runner, jobs, enqueue, get, newWorker } = setup();
    const [a, b, c] = [enqueue('A'), enqueue('B'), enqueue('C')] as [string, string, string];
    // The engine was running B (at step 4) when it died.
    jobs.applyTransition(b, { type: 'START' });
    jobs.applyTransition(b, { type: 'PROGRESS', step: 4, sub: '2/5' });
    const before = get(b);

    const rebooted = newWorker();
    rebooted.start();
    await settle();

    expect(runner.ids).toEqual([b]);
    expect(runner.call(0).mode).toBe('resume');
    expect(runner.call(0).job).toEqual(before);
    expect(get(b)).toEqual(before);
    expect(get(a).placeInLine).toBe(1);

    runner.call(0).end({ ok: true });
    await settle();
    runner.call(1).end({ ok: true });
    await settle();
    runner.call(2).end({ ok: true });
    await rebooted.idle();

    expect(runner.ids).toEqual([b, a, c]);
    expect(runner.calls.map((call) => call.mode)).toEqual(['resume', 'start', 'start']);
    expect(runner.maxRunning).toBe(1);
    expect(rebooted.activeJobId).toBeNull();
  });

  it('runs several left-over jobs one after another, the earliest started first', async () => {
    const { runner, jobs, clock, enqueue, newWorker } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    jobs.applyTransition(b, { type: 'START' });
    jobs.applyTransition(b, { type: 'PROGRESS', step: 3, sub: null });
    clock.tick(5_000);
    jobs.applyTransition(a, { type: 'START' });
    jobs.applyTransition(a, { type: 'PROGRESS', step: 2, sub: null });

    const rebooted = newWorker();
    rebooted.start();
    await settle();
    expect(runner.ids).toEqual([b]);
    runner.call(0).end({ ok: true });
    await settle();

    expect(runner.ids).toEqual([b, a]);
    expect(runner.calls.map((call) => call.mode)).toEqual(['resume', 'resume']);
  });

  it('cancels a left-over job that has not been picked yet, without running it', async () => {
    const { runner, jobs, clock, enqueue, get, newWorker } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    jobs.applyTransition(a, { type: 'START' });
    clock.tick(5_000);
    jobs.applyTransition(b, { type: 'START' });

    const rebooted = newWorker();
    rebooted.start();
    await settle();
    expect(runner.ids).toEqual([a]);

    const cancelled = await rebooted.cancel(b);
    expect(cancelled).toMatchObject({ id: b, state: 'cancelled' });
    runner.call(0).end({ ok: true });
    await rebooted.idle();

    expect(runner.ids).toEqual([a]);
    expect(get(b).state).toBe('cancelled');
  });

  it('resumes the job a shutdown interrupted, at the next start', async () => {
    const { worker, runner, enqueue, get, newWorker } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();
    runner.call(0).context.progress(2, '1/3');

    await worker.stop();

    expect(runner.call(0).aborted).toBe(true);
    expect(get(a)).toMatchObject({ state: 'editing', step: 2 });
    expect(get(b).state).toBe('queued');
    expect(runner.ids).toEqual([a]);

    const rebooted = newWorker();
    rebooted.start();
    await settle();

    expect(runner.ids).toEqual([a, a]);
    expect(runner.call(1).mode).toBe('resume');
    expect(runner.call(1).job.step).toBe(2);
  });
});

describe('stop', () => {
  it('waits for the runner to stop and starts nothing more', async () => {
    const { worker, runner, enqueue, get } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    runner.stopOnAbort = false;
    worker.start();
    await settle();

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(runner.call(0).aborted).toBe(true);
    expect(stopped).toBe(false);

    runner.call(0).end({ ok: false, error: 'killed' });
    await stopping;

    expect(stopped).toBe(true);
    expect(runner.ids).toEqual([a]);
    expect(get(a).state).toBe('editing');
    expect(get(b).state).toBe('queued');
  });

  it('tells the runner it was a shutdown, not a cancel', async () => {
    const { worker, runner, enqueue } = setup();
    enqueue('A');
    worker.start();
    await settle();

    await worker.stop();

    expect(runner.call(0).abortReason).toBe('shutdown');
  });

  it('keeps the first reason when a cancel and a shutdown come together', async () => {
    const { worker, runner, enqueue } = setup();
    const a = enqueue('A');
    runner.stopOnAbort = false;
    worker.start();
    await settle();

    const cancelling = worker.cancel(a);
    const stopping = worker.stop();
    await settle();
    runner.call(0).end({ ok: false, error: 'killed' });
    await Promise.all([cancelling, stopping]);

    expect(runner.call(0).abortReason).toBe('cancel');
  });

  it('is fine with nothing running, and can be called twice', async () => {
    const { worker } = setup();

    await worker.stop();
    worker.start();
    await worker.stop();
    await worker.stop();
  });
});

describe('progress', () => {
  it('records the step and count, and tells the listener', async () => {
    const { worker, runner, enqueue, get } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();

    runner.call(0).context.progress(2, '1/4');
    expect(get(a)).toMatchObject({ state: 'editing', step: 2, subProgress: '1/4' });

    runner.call(0).context.progress(2);
    expect(get(a)).toMatchObject({ step: 2, subProgress: null });

    runner.call(0).context.progress(3, '');
    expect(get(a)).toMatchObject({ step: 3, subProgress: null });
  });

  it('ignores a report that repeats the current step and count', async () => {
    const changed = vi.fn();
    const { worker, runner, enqueue, get } = setup({ onJobChanged: changed });
    const a = enqueue('A');
    worker.start();
    await settle();
    const { progress } = runner.call(0).context;

    progress(1);
    expect(changed).toHaveBeenCalledTimes(1); // only the start
    progress(2, '1/4');
    const updatedAt = get(a).updatedAt;
    progress(2, '1/4');
    progress(2, '1/4');

    expect(changed).toHaveBeenCalledTimes(2);
    expect(get(a).updatedAt).toBe(updatedAt);
  });

  it('ignores progress after the run ended or was cancelled, and for an unknown step', async () => {
    const { worker, runner, enqueue, get } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    runner.stopOnAbort = false;
    worker.start();
    await settle();
    const first = runner.call(0).context;
    first.progress(2);

    first.progress(9 as StepId);
    expect(get(a).step).toBe(2);

    const cancelling = worker.cancel(a);
    first.progress(4);
    expect(get(a).step).toBe(2);
    runner.call(0).end({ ok: false, error: 'killed' });
    await cancelling;
    await settle();
    first.progress(5);
    expect(get(a)).toMatchObject({ state: 'cancelled', step: 2 });

    // The late report from A's run does not touch B, which is now running.
    expect(get(b).state).toBe('editing');
    first.progress(6);
    expect(get(b).step).toBe(1);
  });

  it('survives a repository that fails while recording progress', async () => {
    const warn = vi.fn();
    const logger: WorkerLogger = { info() {}, warn, error() {} };
    const { worker, runner, jobs, enqueue } = setup({ logger });
    enqueue('A');
    worker.start();
    await settle();
    vi.spyOn(jobs, 'applyTransition').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    expect(() => runner.call(0).context.progress(3)).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 3 }),
      'could not record progress',
    );
  });
});

describe('step timings', () => {
  it('times each step of a fresh run as the runner reports it, to the end of the export', async () => {
    const { worker, runner, stepRuns, clock, enqueue } = setup();
    const a = enqueue('A');
    worker.start();
    await settle();
    const { progress } = runner.call(0).context;

    // Without a Brief run step 1 has nothing to time.
    clock.tick(4_000);
    progress(2, '1/3');
    clock.tick(1_000);
    progress(2, '2/3'); // the same step: no new timing
    clock.tick(5_000);
    progress(3);
    clock.tick(7_000);
    runner.call(0).end({ ok: true });
    await worker.idle();

    expect(stepRuns.recentDurations(1, 10, 'edit')).toEqual([]);
    expect(stepRuns.recentDurations(2, 10, 'edit')).toEqual([
      { jobId: a, durationSec: 6, footageSec: 540.5 },
    ]);
    expect(stepRuns.recentDurations(3, 10, 'edit')).toEqual([
      { jobId: a, durationSec: 7, footageSec: 540.5 },
    ]);
  });

  it('does not time the step a resumed run carries on from, only the ones after it', async () => {
    const { runner, jobs, stepRuns, clock, enqueue, newWorker } = setup();
    const a = enqueue('A');
    jobs.applyTransition(a, { type: 'START' });
    jobs.applyTransition(a, { type: 'PROGRESS', step: 4, sub: null });
    const rebooted = newWorker();
    rebooted.start();
    await settle();
    const { progress } = runner.call(0).context;

    clock.tick(3_000);
    progress(4, '2/5'); // still the step it resumed at
    clock.tick(3_000);
    progress(5);
    clock.tick(2_000);
    runner.call(0).end({ ok: true });
    await rebooted.idle();

    expect(stepRuns.recentDurations(4, 10, 'edit')).toEqual([]);
    expect(stepRuns.recentDurations(5, 10, 'edit')).toEqual([
      { jobId: a, durationSec: 2, footageSec: 540.5 },
    ]);
    expect(rebooted.activeJobId).toBeNull();
  });

  it('leaves the running step untimed when the run fails or is cancelled', async () => {
    const { worker, runner, stepRuns, clock, enqueue } = setup();
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    clock.tick(2_000);
    runner.call(0).context.progress(2);
    clock.tick(2_000);
    runner.call(0).context.progress(3);
    clock.tick(2_000);
    runner.call(0).end({ ok: false, error: 'boom' });
    await settle();
    clock.tick(2_000);
    runner.call(1).context.progress(2);
    clock.tick(2_000);
    await worker.cancel(b);

    expect(stepRuns.recentDurations(2, 10, 'edit')).toEqual([
      { jobId: a, durationSec: 2, footageSec: 540.5 },
    ]);
    expect(stepRuns.recentDurations(3, 10, 'edit')).toEqual([]);
  });

  it('keeps editing when timing cannot be recorded', async () => {
    const { worker, runner, stepRuns, enqueue, get } = setup();
    const a = enqueue('A');
    vi.spyOn(stepRuns, 'start').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    worker.start();
    await settle();

    runner.call(0).context.progress(2);
    runner.call(0).end({ ok: true });
    await worker.idle();

    expect(get(a).state).toBe('ready');
  });
});

describe('change notifications', () => {
  it('reports every transition of the jobs it works on, once, and not the queued ones behind them', async () => {
    // The queued jobs whose place moves up are the bus's business (followQueuePlaces, which tells
    // them once); the worker reporting them too made every browser get each of them twice.
    const seen: string[] = [];
    const onJobChanged = (job: Job) => {
      seen.push(
        `${job.name} ${job.state}${job.placeInLine === null ? '' : ` #${job.placeInLine}`}`,
      );
    };
    const { worker, runner, enqueue } = setup({ onJobChanged });
    enqueue('A');
    enqueue('B');
    enqueue('C');

    worker.start();
    await settle();
    expect(seen).toEqual(['A editing']);

    seen.length = 0;
    runner.call(0).context.progress(2, '1/3');
    runner.call(0).end({ ok: true });
    await settle();

    expect(seen).toEqual(['A editing', 'A ready', 'B editing']);
  });

  it('reports CANCEL and FAIL', async () => {
    const seen: string[] = [];
    const { worker, runner, enqueue } = setup({
      onJobChanged: (job) => seen.push(`${job.name} ${job.state}`),
    });
    const a = enqueue('A');
    enqueue('B');
    worker.start();
    await settle();
    await worker.cancel(a);
    await settle();
    runner.call(1).end({ ok: false, error: 'boom' });
    await settle();

    expect(seen).toContain('A cancelled');
    expect(seen).toContain('B failed');
  });

  it('keeps working when a listener throws', async () => {
    const error = vi.fn();
    const logger: WorkerLogger = { info() {}, warn() {}, error };
    const { worker, runner, enqueue, get } = setup({
      logger,
      onJobChanged: () => {
        throw new Error('listener bug');
      },
    });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    runner.call(0).end({ ok: true });
    await settle();

    expect(get(a).state).toBe('ready');
    expect(get(b).state).toBe('editing');
    expect(error).toHaveBeenCalledWith(expect.anything(), 'onJobChanged listener threw');
  });

  it('lets a listener cancel the job it was just told has started, without starting the runner', async () => {
    let worker: QueueWorker | undefined;
    const cancels: Promise<Job | null>[] = [];
    const setupResult = setup({
      onJobChanged: (job) => {
        if (job.state === 'editing' && cancels.length === 0) {
          cancels.push(worker?.cancel(job.id) as Promise<Job | null>);
        }
      },
    });
    worker = setupResult.worker;
    setupResult.enqueue('A');

    worker.start();
    await settle();

    expect(setupResult.runner.calls).toHaveLength(0);
    expect((await cancels[0])?.state).toBe('cancelled');
  });
});

describe('unexpected errors', () => {
  it('logs a repository failure while picking, and works again on the next notify', async () => {
    const error = vi.fn();
    const logger: WorkerLogger = { info() {}, warn() {}, error };
    const { worker, runner, jobs, enqueue } = setup({ logger });
    const a = enqueue('A');
    vi.spyOn(jobs, 'nextQueued').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    worker.start();
    await settle();
    expect(runner.calls).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'queue worker stopped on an unexpected error',
    );

    worker.notify();
    await settle();
    expect(runner.ids).toEqual([a]);
  });
});

// Helpers of the tests about a retry that only exports again (CVP-84) and about the runs after
// Review (W3), which check the same shortcut. The runner is a stand-in that never writes a log, so
// the tests write the `end` marker a real run would have left, and the `edit/final.mp4`, in
// temporary folders.
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Waits for `condition` through a few turns of the event loop (the checks read files). */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn += 1) await settle();
  expect(condition()).toBe(true);
}

function folders(): ReexportOptions {
  const root = mkdtempSync(join(tmpdir(), 'studio-worker-reexport-'));
  tempDirs.push(root);
  return { inboxPath: join(root, 'inbox'), logsDir: join(root, 'logs') };
}

function writeFinalVideo(folder: ReexportOptions, job: Job, bytes = 'not really a video') {
  const path = join(folder.inboxPath, job.relPath, FINAL_VIDEO_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** What the Claude runner leaves in the log when a run ends. */
function writeEnd(
  folder: ReexportOptions,
  job: Job,
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'stopped',
) {
  const path = jobLogPath(folder.logsDir, job.id);
  mkdirSync(dirname(path), { recursive: true });
  const marker = {
    type: 'studio_engine',
    event: 'end',
    at: '2026-10-20T10:00:00.000Z',
    outcome,
    ...(outcome === 'failed' ? { error: 'render crashed' } : {}),
    exitCode: 0,
    signal: null,
    durationMs: 1_000,
    sessionId: null,
  };
  writeFileSync(path, `{"type":"studio_engine","event":"start"}\n${JSON.stringify(marker)}\n`);
}

function readMarkers(folder: ReexportOptions, job: Job): Array<Record<string, unknown>> {
  return readFileSync(jobLogPath(folder.logsDir, job.id), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === 'studio_engine');
}

/** Presses Retry on the job and wakes the worker, as the retry route does. */
function retry(setupResult: ReturnType<typeof setup>, id: string): void {
  setupResult.jobs.applyTransition(id, { type: 'RETRY' });
  setupResult.worker.notify();
}

// CVP-84: a retry after a failed export exports again and starts no run.
describe('retry after a failed export', () => {
  /** Runs job A to its export, which fails, as the first attempt in these tests. */
  async function failedAtExport(
    options: { finalize: Finalize; finalVideo?: string | null; end?: 'succeeded' | 'failed' } & {
      logger?: WorkerLogger;
      brief?: BriefRun;
    },
  ) {
    const folder = folders();
    const setupResult = setup({
      finalize: options.finalize,
      reexport: folder,
      logger: options.logger,
      brief: options.brief,
    });
    const id = setupResult.enqueue('A');
    setupResult.worker.start();
    await settle();

    const job = setupResult.get(id);
    if (options.finalVideo !== null) writeFinalVideo(folder, job, options.finalVideo);
    if (options.end !== undefined) writeEnd(folder, job, options.end);
    setupResult.runner.call(0).end({ ok: true });
    await setupResult.worker.idle();
    return { ...setupResult, folder, id };
  }

  it('exports again without starting the runner, and says so in the job log', async () => {
    const finalize = vi
      .fn<Finalize>()
      .mockRejectedValueOnce(new Error("Can't make the client folder in _Exports"))
      .mockResolvedValue(OUTPUT);
    const result = await failedAtExport({ finalize, finalVideo: 'video bytes', end: 'succeeded' });
    const { runner, id, get, folder } = result;
    expect(get(id)).toMatchObject({ state: 'failed', failedAt: 8 });
    expect(get(id).error).toMatch(/^Export failed: /);
    expect(runner.calls).toHaveLength(1);

    retry(result, id);
    await until(() => get(id).state === 'ready');

    expect(runner.calls).toHaveLength(1);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(get(id)).toMatchObject({ state: 'ready', step: 8, output: OUTPUT, error: null });
    const [secondJob] = finalize.mock.calls[1] as unknown as [Job];
    expect(secondJob).toMatchObject({ id, state: 'editing', step: 8 });

    // The log keeps its last `end` (a later retry decides from it) and gains the marker.
    const markers = readMarkers(folder, get(id));
    expect(markers.map((marker) => marker.event)).toEqual(['start', 'end', 'reexport']);
    expect(markers[2]).toMatchObject({
      jobId: id,
      step: 8,
      file: FINAL_VIDEO_PATH,
      note: expect.stringMatching(/without a new Claude run/),
    });
  });

  it('skips the Brief step too: only the export runs again', async () => {
    const brief = new ScriptedBrief();
    brief.autoEnd = BRIEF_READY;
    const finalize = vi
      .fn<Finalize>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(OUTPUT);
    const result = await failedAtExport({
      finalize,
      finalVideo: 'video bytes',
      end: 'succeeded',
      brief,
    });
    const { runner, id, get } = result;
    expect(brief.calls).toHaveLength(1);

    retry(result, id);
    await until(() => get(id).state === 'ready');

    expect(brief.calls).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
  });

  it('exports again, with no run, a job whose export file went missing at startup', async () => {
    const finalize = vi.fn<Finalize>(async () => OUTPUT);
    const result = await failedAtExport({ finalize, finalVideo: 'video bytes', end: 'succeeded' });
    const { runner, jobs, id, get } = result;
    expect(get(id).state).toBe('ready');

    // W3's startup check found the export gone: failed at Render, "Exported file is missing".
    jobs.applyTransition(id, { type: 'EXPORT_MISSING' });
    expect(get(id)).toMatchObject({
      state: 'failed',
      failedAt: 8,
      error: 'Exported file is missing',
    });
    retry(result, id);
    await until(() => get(id).state === 'ready');

    expect(runner.calls).toHaveLength(1);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(get(id)).toMatchObject({ output: OUTPUT, error: null });
  });

  it('fails at Render as before when the export fails again, and the next Retry exports again', async () => {
    const finalize = vi
      .fn<Finalize>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('still full'))
      .mockResolvedValue(OUTPUT);
    const result = await failedAtExport({ finalize, finalVideo: 'video bytes', end: 'succeeded' });
    const { runner, id, get } = result;

    retry(result, id);
    await until(() => get(id).error === 'Export failed: still full');
    expect(get(id)).toMatchObject({ state: 'failed', failedAt: 8, step: 8 });
    expect(runner.calls).toHaveLength(1);

    retry(result, id);
    await until(() => get(id).state === 'ready');
    expect(runner.calls).toHaveLength(1);
    expect(finalize).toHaveBeenCalledTimes(3);
  });

  it('runs the runner on a retry when edit/final.mp4 is gone', async () => {
    const finalize = vi.fn<Finalize>().mockRejectedValueOnce(new Error('no final.mp4'));
    const result = await failedAtExport({ finalize, finalVideo: null, end: 'succeeded' });
    const { runner, id, get } = result;
    finalize.mockResolvedValue(OUTPUT);

    retry(result, id);
    await until(() => runner.calls.length === 2);

    expect(runner.call(1)).toMatchObject({ mode: 'retry' });
    expect(runner.call(1).job).toMatchObject({ id, state: 'editing', step: 8 });
    expect(finalize).toHaveBeenCalledTimes(1);

    runner.call(1).end({ ok: true });
    await result.worker.idle();
    expect(get(id).state).toBe('ready');
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it('runs the runner on a retry when edit/final.mp4 is empty', async () => {
    const finalize = vi.fn<Finalize>().mockRejectedValueOnce(new Error('empty'));
    const result = await failedAtExport({ finalize, finalVideo: '', end: 'succeeded' });

    retry(result, result.id);
    await until(() => result.runner.calls.length === 2);

    expect(result.runner.call(1).mode).toBe('retry');
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('runs the runner on a retry when the last run itself failed, even if a final.mp4 is there', async () => {
    const finalize = vi.fn<Finalize>(async () => OUTPUT);
    const folder = folders();
    const result = setup({ finalize, reexport: folder });
    const id = result.enqueue('A');
    result.worker.start();
    await settle();
    writeFinalVideo(folder, result.get(id));
    writeEnd(folder, result.get(id), 'failed');
    // The render step itself failed (step 8), and whatever final.mp4 holds is not to be trusted.
    result.runner.call(0).end({ ok: false, error: 'render crashed', step: 8 });
    await result.worker.idle();
    expect(result.get(id)).toMatchObject({ state: 'failed', failedAt: 8 });

    retry(result, id);
    await until(() => result.runner.calls.length === 2);

    expect(result.runner.call(1).mode).toBe('retry');
    expect(finalize).not.toHaveBeenCalled();
  });

  it('runs the runner on a retry when the last run was stopped by a shutdown (CVP-89)', async () => {
    // Only a run that ended `succeeded` lets Retry skip the runner; `stopped` is not that.
    const finalize = vi.fn<Finalize>(async () => OUTPUT);
    const folder = folders();
    const result = setup({ finalize, reexport: folder });
    const id = result.enqueue('A');
    result.worker.start();
    await settle();
    writeFinalVideo(folder, result.get(id));
    writeEnd(folder, result.get(id), 'stopped');
    result.runner.call(0).end({ ok: false, error: 'render crashed', step: 8 });
    await result.worker.idle();
    expect(result.get(id)).toMatchObject({ state: 'failed', failedAt: 8 });

    retry(result, id);
    await until(() => result.runner.calls.length === 2);

    expect(result.runner.call(1).mode).toBe('retry');
    expect(finalize).not.toHaveBeenCalled();
  });

  it('runs the runner on a retry when the job has no log to say its edit finished', async () => {
    const finalize = vi.fn<Finalize>().mockRejectedValueOnce(new Error('disk full'));
    const result = await failedAtExport({ finalize, finalVideo: 'video bytes' });

    retry(result, result.id);
    await until(() => result.runner.calls.length === 2);

    expect(result.runner.call(1).mode).toBe('retry');
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('runs the runner on a retry of a failure before Render', async () => {
    const finalize = vi.fn<Finalize>(async () => OUTPUT);
    const folder = folders();
    const result = setup({ finalize, reexport: folder });
    const id = result.enqueue('A');
    result.worker.start();
    await settle();
    // An older run ended succeeded and left a video, but this one failed at step 4.
    writeFinalVideo(folder, result.get(id));
    writeEnd(folder, result.get(id), 'succeeded');
    result.runner.call(0).end({ ok: false, error: 'no transcript', step: 4 });
    await result.worker.idle();

    retry(result, id);
    await until(() => result.runner.calls.length === 2);

    expect(result.runner.call(1)).toMatchObject({ mode: 'retry' });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('runs the runner on every Retry when the worker is not told where the folders are', async () => {
    const finalize = vi.fn<Finalize>().mockRejectedValueOnce(new Error('disk full'));
    const result = setup({ finalize });
    const id = result.enqueue('A');
    result.worker.start();
    await settle();
    result.runner.call(0).end({ ok: true });
    await result.worker.idle();

    retry(result, id);
    await until(() => result.runner.calls.length === 2);

    expect(result.runner.call(1).mode).toBe('retry');
  });

  it('cancels a re-export that is stopped, still without a run', async () => {
    const exporting = deferred<void>();
    const finalize = vi
      .fn<Finalize>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementationOnce(
        (_job, signal) =>
          new Promise<JobOutput>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('The export was stopped')));
            exporting.resolve();
          }),
      );
    const result = await failedAtExport({ finalize, finalVideo: 'video bytes', end: 'succeeded' });
    const { worker, runner, id, get } = result;

    retry(result, id);
    await exporting.promise;
    expect(get(id).state).toBe('editing');
    const cancelled = await worker.cancel(id);

    expect(cancelled?.state).toBe('cancelled');
    expect(runner.calls).toHaveLength(1);
  });
});

describe('after a job is ready (C4)', () => {
  /** An `afterReady` the test ends itself, one call at a time. */
  function scriptedAfterReady() {
    const calls: { job: Job; done: ReturnType<typeof deferred<void>> }[] = [];
    const afterReady = (job: Job): Promise<void> => {
      const done = deferred<void>();
      calls.push({ job, done });
      return done.promise;
    };
    return { calls, afterReady };
  }

  it('hands the ready job over and picks the next job only once that is over', async () => {
    const { calls, afterReady } = scriptedAfterReady();
    const { worker, runner, enqueue, get } = setup({ afterReady });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();
    runner.call(0).end({ ok: true });
    await settle();

    expect(calls.map((call) => call.job.id)).toEqual([a]);
    expect(calls[0]?.job.state).toBe('ready');
    expect(get(a).state).toBe('ready');
    // The next job waits.
    expect(runner.ids).toEqual([a]);
    expect(get(b).state).toBe('queued');
    expect(worker.activeJobId).toBeNull();

    calls[0]?.done.resolve();
    await settle();
    expect(runner.ids).toEqual([a, b]);
    expect(get(b).state).toBe('editing');
  });

  it('leaves the job ready when the step after it fails, and goes on with the next job', async () => {
    const warnings: string[] = [];
    const logger: WorkerLogger = {
      info() {},
      warn: (_obj, msg) => warnings.push(msg),
      error() {},
    };
    const afterReady = vi.fn(async () => {
      throw new Error('Style stopped: no style.md.new');
    });
    const { worker, runner, enqueue, get } = setup({ afterReady, logger });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();
    runner.call(0).end({ ok: true });
    await settle();

    expect(afterReady).toHaveBeenCalledTimes(1);
    expect(get(a)).toMatchObject({ state: 'ready', error: null, output: OUTPUT });
    expect(warnings).toContain('the step after a finished job failed');
    expect(runner.ids).toEqual([a, b]);
  });

  it('is not called for a job that ends in Review: it is not finished yet', async () => {
    const afterReady = vi.fn(async () => {});
    const { worker, runner, enqueue, get } = setup({ review: true, afterReady });
    const a = enqueue('A');

    worker.start();
    await settle();
    runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await worker.idle();

    expect(get(a).state).toBe('review');
    expect(afterReady).not.toHaveBeenCalled();
  });

  it('is not called for a job that failed or was cancelled', async () => {
    const afterReady = vi.fn(async () => {});
    const { worker, runner, enqueue, get } = setup({ afterReady });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();
    runner.call(0).end({ ok: false, error: 'boom', step: 3 });
    await settle();
    await worker.cancel(b);
    await worker.idle();

    expect([get(a).state, get(b).state]).toEqual(['failed', 'cancelled']);
    expect(afterReady).not.toHaveBeenCalled();
  });

  it('stops waiting when the engine shuts down, and starts nothing more', async () => {
    const { calls, afterReady } = scriptedAfterReady();
    const { worker, runner, enqueue, get } = setup({ afterReady });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();
    runner.call(0).end({ ok: true });
    await settle();
    expect(calls).toHaveLength(1);

    // The wait never ends on its own: stop() must not hang on it.
    await worker.stop();

    expect(get(a).state).toBe('ready');
    expect(get(b).state).toBe('queued');
    expect(runner.ids).toEqual([a]);
  });
});

describe('before a queued job starts (C10)', () => {
  /** A `beforeStart` that holds back the jobs named in `held`, each until the test lets it go. */
  function holdBack(...held: string[]) {
    const asked: string[] = [];
    const waits: { name: string; done: ReturnType<typeof deferred<void>> }[] = [];
    const beforeStart = (job: Job): Promise<void> | null => {
      asked.push(job.name);
      if (!held.includes(job.name)) return null;
      const done = deferred<void>();
      waits.push({ name: job.name, done });
      return done.promise;
    };
    return { asked, waits, beforeStart };
  }

  it('starts a job nothing holds back at once', async () => {
    const { asked, beforeStart } = holdBack();
    const { worker, runner, enqueue } = setup({ beforeStart });
    const a = enqueue('A');

    worker.start();
    await settle();

    expect(asked).toEqual(['A']);
    expect(runner.ids).toEqual([a]);
  });

  it('waits before the job at the head of the line, keeps its place, and starts it without asking again', async () => {
    const { asked, waits, beforeStart } = holdBack('A');
    const { worker, runner, enqueue, get } = setup({ beforeStart });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();

    // A waits, and B does not jump ahead of it.
    expect(waits.map((wait) => wait.name)).toEqual(['A']);
    expect(runner.ids).toEqual([]);
    expect([get(a).state, get(b).state]).toEqual(['queued', 'queued']);
    expect(get(a).placeInLine).toBe(1);
    worker.notify();
    await settle();
    expect(runner.ids).toEqual([]);

    waits[0]?.done.resolve();
    await settle();
    expect(runner.ids).toEqual([a]);
    expect(asked).toEqual(['A']);

    runner.call(0).end({ ok: true });
    await settle();
    expect(runner.ids).toEqual([a, b]);
    expect(asked).toEqual(['A', 'B']);
  });

  it('asks about the new head when the one it waited for left the line meanwhile', async () => {
    const { asked, waits, beforeStart } = holdBack('A');
    const { worker, runner, jobs, enqueue } = setup({ beforeStart });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();
    jobs.applyTransition(a, { type: 'HOLD' });
    waits[0]?.done.resolve();
    await settle();

    expect(asked).toEqual(['A', 'B']);
    expect(runner.ids).toEqual([b]);
  });

  it('asks again about a job it waited for once another job has started', async () => {
    const { asked, waits, beforeStart } = holdBack('A');
    const { worker, runner, jobs, enqueue } = setup({ beforeStart });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();
    jobs.applyTransition(a, { type: 'HOLD' });
    waits[0]?.done.resolve();
    await settle();
    expect(runner.ids).toEqual([b]);

    // Released while B runs: A is first in line again, and waits again.
    jobs.applyTransition(a, { type: 'RELEASE' });
    runner.call(0).end({ ok: true });
    await settle();
    expect(asked).toEqual(['A', 'B', 'A']);
    expect(waits).toHaveLength(2);
    expect(runner.ids).toEqual([b]);
  });

  it('never asks about a job a crash left in editing: it resumes first', async () => {
    const { asked, beforeStart } = holdBack('A', 'B');
    const { runner, jobs, enqueue, newWorker } = setup({ beforeStart });
    const [, b] = [enqueue('A'), enqueue('B')] as [string, string];
    jobs.applyTransition(b, { type: 'START' });
    jobs.applyTransition(b, { type: 'PROGRESS', step: 4, sub: null });

    const rebooted = newWorker();
    rebooted.start();
    await settle();

    expect(runner.ids).toEqual([b]);
    expect(runner.call(0).mode).toBe('resume');
    expect(asked).toEqual([]);
  });

  it('stops waiting when the engine shuts down, and starts nothing', async () => {
    const { waits, beforeStart } = holdBack('A');
    const { worker, runner, enqueue, get } = setup({ beforeStart });
    const a = enqueue('A');

    worker.start();
    await settle();
    expect(waits).toHaveLength(1);

    // The wait never ends on its own: stop() must not hang on it.
    await worker.stop();

    expect(runner.ids).toEqual([]);
    expect(get(a).state).toBe('queued');
  });

  it('logs a wait that fails, or a hook that throws, and starts the job', async () => {
    const warnings: string[] = [];
    const logger: WorkerLogger = {
      info() {},
      warn: (_obj, msg) => warnings.push(msg),
      error() {},
    };
    const beforeStart = vi.fn((job: Job): Promise<void> | null => {
      if (job.name === 'A') return Promise.reject(new Error('the style worker broke'));
      throw new Error('no style worker');
    });
    const { worker, runner, enqueue } = setup({ beforeStart, logger });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();
    expect(runner.ids).toEqual([a]);
    runner.call(0).end({ ok: true });
    await settle();

    expect(runner.ids).toEqual([a, b]);
    expect(beforeStart).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([
      'the wait before the next job failed',
      'could not tell whether the next job has to wait',
    ]);
  });
});

// W3 (CVP-110): after Send notes the job runs a revise run (steps 4 to 7, ends in Review again),
// after Approve a render run (step 8, then the export). Neither runs the Brief step.
describe('runs of each kind (Review switch on)', () => {
  const REVISED_PREVIEW = { durationSec: 9, width: 1080, height: 1920 };

  /** Runs job A as an edit run to Review, with `brief` and the rest as the test gave them. */
  async function inReview(options: SetupOptions = {}) {
    const brief = new ScriptedBrief();
    brief.autoEnd = BRIEF_READY;
    const result = setup({ review: true, brief, ...options });
    const id = result.enqueue('A');
    result.worker.start();
    await settle();
    // The edit run reports its steps with a second between them: 2 .. 7.
    for (const step of [2, 3, 4, 5, 6, 7] as const) {
      result.clock.tick(1_000);
      result.runner.call(0).context.progress(step);
    }
    result.runner.call(0).end({ ok: true, preview: SAMPLE_PREVIEW });
    await result.worker.idle();
    expect(result.get(id)).toMatchObject({ state: 'review', runKind: 'edit', round: 0 });
    return { ...result, brief, id };
  }

  type InReview = Awaited<ReturnType<typeof inReview>>;

  /** Send notes: SEND_NOTES, and a notification to the worker, as the route does. */
  async function sendNotes(ctx: InReview) {
    ctx.jobs.applyTransition(ctx.id, { type: 'SEND_NOTES' });
    ctx.worker.notify();
    await settle();
  }

  async function approve(ctx: InReview) {
    ctx.jobs.applyTransition(ctx.id, { type: 'APPROVE' });
    ctx.worker.notify();
    await settle();
  }

  describe('a revise run', () => {
    it('runs the runner alone: no Brief call, mode start, at Plan (4) with its kind and round', async () => {
      const ctx = await inReview();
      expect(ctx.brief.calls).toHaveLength(1);

      await sendNotes(ctx);

      expect(ctx.brief.calls).toHaveLength(1);
      expect(ctx.runner.calls).toHaveLength(2);
      expect(ctx.runner.call(1)).toMatchObject({
        mode: 'start',
        job: { id: ctx.id, state: 'editing', runKind: 'revise', round: 1, step: 4 },
      });
      expect(ctx.get(ctx.id)).toMatchObject({ state: 'editing', step: 4, runKind: 'revise' });
    });

    it('ends in Review at round 1 with the new preview, and exports nothing', async () => {
      const ctx = await inReview();
      await sendNotes(ctx);

      ctx.runner.call(1).end({ ok: true, preview: REVISED_PREVIEW });
      await ctx.worker.idle();

      expect(ctx.finalize).not.toHaveBeenCalled();
      expect(ctx.get(ctx.id)).toMatchObject({
        state: 'review',
        step: 7,
        runKind: 'revise',
        round: 1,
        preview: REVISED_PREVIEW,
        output: null,
        error: null,
      });
      expect(ctx.worker.activeJobId).toBeNull();
    });

    it('times its steps from the start under revise, and leaves the edit’s timings alone', async () => {
      const ctx = await inReview();
      const editPlan = ctx.stepRuns.recentDurations(4, 10, 'edit');
      expect(editPlan).toEqual([{ jobId: ctx.id, durationSec: 1, footageSec: 540.5 }]);

      await sendNotes(ctx);
      const { progress } = ctx.runner.call(1).context;
      ctx.clock.tick(3_000);
      progress(5);
      ctx.clock.tick(4_000);
      progress(6);
      ctx.clock.tick(5_000);
      progress(7, 'pass 1/3');
      ctx.clock.tick(6_000);
      ctx.runner.call(1).end({ ok: true, preview: REVISED_PREVIEW });
      await ctx.worker.idle();

      const seconds = (step: StepId) =>
        ctx.stepRuns.recentDurations(step, 10, 'revise').map((run) => run.durationSec);
      // Plan was timed from the start of the run, though the tracker's first report repeats it.
      expect(seconds(4)).toEqual([3]);
      expect(seconds(5)).toEqual([4]);
      expect(seconds(6)).toEqual([5]);
      expect(seconds(7)).toEqual([6]);
      expect(seconds(8)).toEqual([]);
      expect(ctx.stepRuns.recentDurations(4, 10, 'edit')).toEqual(editPlan);
      expect(ctx.stepRuns.recentDurations(7, 10, 'edit')).toHaveLength(1);
      expect(ctx.stepRuns.recentDurations(7, 10, 'render')).toEqual([]);
    });

    // CVP-262: the job sheet found a revise run whose Plan and Check were still open although the
    // job had been in Review for a while. The sequence below is the real one (the editing agent
    // reported Preview and Check only), run through the current worker.
    describe('leaves no step open (CVP-262)', () => {
      /** The revise run's step runs, oldest first, as `GET /api/jobs/:id/steps` lists them. */
      const reviseRuns = (ctx: InReview) =>
        ctx.stepRuns
          .listForJob(ctx.id)
          .filter((run) => run.round === 1)
          .map((run) => [run.step, run.endedAt === null ? 'open' : 'ended'] as const);

      it('when the agent reports Preview and Check only, so Plan, Preview and Check all end', async () => {
        const ctx = await inReview();
        await sendNotes(ctx);
        const { progress } = ctx.runner.call(1).context;
        ctx.clock.tick(150_000);
        progress(6);
        ctx.clock.tick(1_000);
        progress(7);
        ctx.clock.tick(60_000);
        ctx.runner.call(1).end({ ok: true, preview: REVISED_PREVIEW });
        await ctx.worker.idle();

        expect(ctx.get(ctx.id)).toMatchObject({ state: 'review', round: 1 });
        expect(reviseRuns(ctx)).toEqual([
          [4, 'ended'],
          [6, 'ended'],
          [7, 'ended'],
        ]);
      });

      it.each([
        [4, [[4, 'open']]],
        [7, [[7, 'open']]],
      ] as const)(
        'but a restart that cuts the run in two leaves open the step the first half began at %i: the resumed half never times it, so it is never a sample',
        async (restartedAt, stillOpen) => {
          const ctx = await inReview();
          await sendNotes(ctx);
          const first = ctx.runner.call(1).context.progress;
          if (restartedAt === 7) {
            ctx.clock.tick(150_000);
            first(6);
            ctx.clock.tick(1_000);
            first(7);
          }

          // The engine restarts: the job stays `editing` and the next boot resumes it.
          await ctx.worker.stop();
          expect(ctx.get(ctx.id)).toMatchObject({ state: 'editing', step: restartedAt });
          const rebooted = ctx.newWorker();
          rebooted.start();
          await settle();
          expect(ctx.runner.call(2)).toMatchObject({ mode: 'resume', job: { round: 1 } });

          const second = ctx.runner.call(2).context.progress;
          if (restartedAt === 4) {
            ctx.clock.tick(150_000);
            second(6);
            ctx.clock.tick(1_000);
            second(7);
          } else {
            second(7);
          }
          ctx.clock.tick(60_000);
          ctx.runner.call(2).end({ ok: true, preview: REVISED_PREVIEW });
          await rebooted.idle();

          expect(ctx.get(ctx.id)).toMatchObject({ state: 'review', round: 1 });
          expect(reviseRuns(ctx).filter(([, status]) => status === 'open')).toEqual(stillOpen);
          // The run that stayed open is not a sample for the ETA.
          expect(ctx.stepRuns.recentDurations(restartedAt, 10, 'revise')).toEqual([]);
        },
      );
    });

    it('fails at Preview (6) when the runner says ok but reports no composition', async () => {
      const ctx = await inReview();
      await sendNotes(ctx);

      ctx.runner.call(1).end({ ok: true });
      await ctx.worker.idle();

      expect(ctx.finalize).not.toHaveBeenCalled();
      expect(ctx.get(ctx.id)).toMatchObject({
        state: 'failed',
        failedAt: 6,
        error: PREVIEW_NOT_REPORTED,
        runKind: 'revise',
        round: 1,
      });
    });

    it('fails at the step the runner names, and Retry runs the revise again as a retry', async () => {
      const ctx = await inReview();
      await sendNotes(ctx);
      ctx.runner
        .call(1)
        .end({ ok: false, error: 'Plan failed: edit/review/round-1.md is missing', step: 4 });
      await ctx.worker.idle();
      expect(ctx.get(ctx.id)).toMatchObject({ state: 'failed', failedAt: 4, runKind: 'revise' });

      ctx.jobs.applyTransition(ctx.id, { type: 'RETRY' });
      ctx.worker.notify();
      await settle();

      expect(ctx.brief.calls).toHaveLength(1);
      expect(ctx.runner.call(2)).toMatchObject({
        mode: 'retry',
        job: { runKind: 'revise', round: 1, step: 4 },
      });
    });

    it('cancelled at Preview (6) and resumed: no Brief, mode resume, step 6, still the same round', async () => {
      const ctx = await inReview();
      await sendNotes(ctx);
      ctx.runner.call(1).context.progress(6);

      const cancelled = await ctx.worker.cancel(ctx.id);
      expect(cancelled).toMatchObject({ state: 'cancelled', step: 6, runKind: 'revise', round: 1 });

      ctx.jobs.applyTransition(ctx.id, { type: 'RESUME' });
      ctx.worker.notify();
      await settle();

      expect(ctx.brief.calls).toHaveLength(1);
      expect(ctx.runner.call(2)).toMatchObject({
        mode: 'resume',
        job: { id: ctx.id, runKind: 'revise', round: 1, step: 6 },
      });
      // The resumed step is not timed: its start was in the run that was cancelled.
      ctx.runner.call(2).end({ ok: true, preview: REVISED_PREVIEW });
      await ctx.worker.idle();
      expect(ctx.get(ctx.id)).toMatchObject({ state: 'review', round: 1 });
      expect(ctx.stepRuns.recentDurations(6, 10, 'revise')).toEqual([]);
    });

    it('a second round is a revise run at round 2', async () => {
      const ctx = await inReview();
      await sendNotes(ctx);
      ctx.runner.call(1).end({ ok: true, preview: REVISED_PREVIEW });
      await ctx.worker.idle();

      await sendNotes(ctx);

      expect(ctx.runner.call(2)).toMatchObject({
        mode: 'start',
        job: { runKind: 'revise', round: 2, step: 4 },
      });
      expect(ctx.brief.calls).toHaveLength(1);
    });
  });

  describe('a render run', () => {
    it('skips the runner when the render was already made in Review, and exports it', async () => {
      const reuseRender = vi.fn(async () => true);
      const ctx = await inReview({ reuseRender });
      await approve(ctx);
      await ctx.worker.idle();

      expect(reuseRender).toHaveBeenCalledTimes(1);
      expect(ctx.runner.calls).toHaveLength(1);
      expect(ctx.finalize).toHaveBeenCalledTimes(1);
      expect(ctx.get(ctx.id)).toMatchObject({ state: 'ready', runKind: 'render', output: OUTPUT });
    });

    it('runs the render when none was made in Review', async () => {
      const ctx = await inReview({ reuseRender: async () => false });
      await approve(ctx);
      expect(ctx.runner.calls).toHaveLength(2);
    });

    it('runs the runner alone at Render (8): no Brief call, mode start', async () => {
      const ctx = await inReview();
      await approve(ctx);

      expect(ctx.brief.calls).toHaveLength(1);
      expect(ctx.runner.call(1)).toMatchObject({
        mode: 'start',
        job: { state: 'editing', runKind: 'render', step: 8 },
      });
      expect(ctx.runner.call(1).job.approvedAt).not.toBeNull();
    });

    it('exports on success and marks the job ready with the output', async () => {
      const ctx = await inReview();
      await approve(ctx);
      ctx.clock.tick(20_000);

      ctx.runner.call(1).end({ ok: true });
      await ctx.worker.idle();

      expect(ctx.finalize).toHaveBeenCalledTimes(1);
      expect(ctx.get(ctx.id)).toMatchObject({
        state: 'ready',
        step: 8,
        runKind: 'render',
        output: OUTPUT,
        error: null,
      });
    });

    it('times Render from the start under render, to the end of the export', async () => {
      const ctx = await inReview();
      await approve(ctx);
      ctx.clock.tick(20_000);
      ctx.runner.call(1).end({ ok: true });
      await ctx.worker.idle();

      expect(ctx.stepRuns.recentDurations(8, 10, 'render')).toEqual([
        { jobId: ctx.id, durationSec: 20, footageSec: 540.5 },
      ]);
      expect(ctx.stepRuns.recentDurations(8, 10, 'edit')).toEqual([]);
    });

    it('does not export when the runner fails: failed at the step it names', async () => {
      const ctx = await inReview();
      await approve(ctx);

      ctx.runner.call(1).end({ ok: false, error: 'Finished without a final video.', step: 8 });
      await ctx.worker.idle();

      expect(ctx.finalize).not.toHaveBeenCalled();
      expect(ctx.get(ctx.id)).toMatchObject({ state: 'failed', failedAt: 8, runKind: 'render' });
    });

    it('fails at Render (8) with “Export failed: …” when the export fails', async () => {
      const finalize = vi.fn<Finalize>().mockRejectedValue(new Error('disk full'));
      const ctx = await inReview({ finalize });
      await approve(ctx);

      ctx.runner.call(1).end({ ok: true });
      await ctx.worker.idle();

      expect(ctx.get(ctx.id)).toMatchObject({
        state: 'failed',
        failedAt: 8,
        error: 'Export failed: disk full',
        runKind: 'render',
      });
    });
  });

  // The CVP-84 shortcut belongs to the runs that deliver final.mp4.
  describe('Retry after a failed export', () => {
    /** An edit run with the switch on, to Review and on through Approve to a render run. */
    async function renderWithFailedExport(finalize: Finalize) {
      const folder = folders();
      const ctx = await inReview({ finalize, reexport: folder });
      await approve(ctx);
      const job = ctx.get(ctx.id);
      writeFinalVideo(folder, job, 'video bytes');
      writeEnd(folder, job, 'succeeded');
      ctx.runner.call(1).end({ ok: true });
      await ctx.worker.idle();
      return { ...ctx, folder };
    }

    it('exports again without a run for a render run', async () => {
      const finalize = vi
        .fn<Finalize>()
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValue(OUTPUT);
      const ctx = await renderWithFailedExport(finalize);
      expect(ctx.get(ctx.id)).toMatchObject({ state: 'failed', failedAt: 8, runKind: 'render' });

      retry(ctx, ctx.id);
      await until(() => ctx.get(ctx.id).state === 'ready');

      expect(ctx.runner.calls).toHaveLength(2);
      expect(ctx.brief.calls).toHaveLength(1);
      expect(finalize).toHaveBeenCalledTimes(2);
      expect(ctx.get(ctx.id)).toMatchObject({ state: 'ready', runKind: 'render', output: OUTPUT });
      expect(readMarkers(ctx.folder, ctx.get(ctx.id)).map((marker) => marker.event)).toContain(
        'reexport',
      );
    });

    it('does not export an edit run again while the switch is on: the runner runs', async () => {
      // An edit that failed at Render, as one can when the switch was turned on after it.
      const finalize = vi.fn<Finalize>(async () => OUTPUT);
      const folder = folders();
      const ctx = setup({ review: true, finalize, reexport: folder });
      const id = ctx.enqueue('A');
      ctx.worker.start();
      await settle();
      writeFinalVideo(folder, ctx.get(id), 'video bytes');
      writeEnd(folder, ctx.get(id), 'succeeded');
      ctx.runner.call(0).end({ ok: false, error: 'Export failed: disk full', step: 8 });
      await ctx.worker.idle();
      expect(ctx.get(id)).toMatchObject({ state: 'failed', failedAt: 8, runKind: 'edit' });

      retry(ctx, id);
      await until(() => ctx.runner.calls.length === 2);

      // It ran as an edit run, which ends in Review, and was not "exported" without a composition.
      expect(ctx.runner.call(1)).toMatchObject({
        mode: 'retry',
        job: { runKind: 'edit', step: 8 },
      });
      expect(finalize).not.toHaveBeenCalled();
      expect(ctx.get(id).state).toBe('editing');

      ctx.runner.call(1).end({ ok: true, preview: SAMPLE_PREVIEW });
      await ctx.worker.idle();
      expect(ctx.get(id)).toMatchObject({ state: 'review', preview: SAMPLE_PREVIEW });
    });

    it('still exports an edit run again while the switch is off, as before', async () => {
      const finalize = vi
        .fn<Finalize>()
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValue(OUTPUT);
      const folder = folders();
      const ctx = setup({ review: false, finalize, reexport: folder });
      const id = ctx.enqueue('A');
      ctx.worker.start();
      await settle();
      writeFinalVideo(folder, ctx.get(id), 'video bytes');
      writeEnd(folder, ctx.get(id), 'succeeded');
      ctx.runner.call(0).end({ ok: true });
      await ctx.worker.idle();
      expect(ctx.get(id)).toMatchObject({ state: 'failed', failedAt: 8 });

      retry(ctx, id);
      await until(() => ctx.get(id).state === 'ready');
      expect(ctx.runner.calls).toHaveLength(1);
    });

    it('never exports a revise run again: it has no final.mp4 to export', async () => {
      const finalize = vi.fn<Finalize>(async () => OUTPUT);
      const folder = folders();
      const ctx = await inReview({ finalize, reexport: folder });
      await sendNotes(ctx);
      // Whatever an earlier render left in edit/ and in the log does not make it exportable.
      writeFinalVideo(folder, ctx.get(ctx.id), 'video bytes');
      writeEnd(folder, ctx.get(ctx.id), 'succeeded');
      ctx.runner.call(1).end({ ok: false, error: 'lint failed', step: 8 });
      await ctx.worker.idle();
      expect(ctx.get(ctx.id)).toMatchObject({ state: 'failed', failedAt: 8, runKind: 'revise' });

      retry(ctx, ctx.id);
      await until(() => ctx.runner.calls.length === 3);

      expect(ctx.runner.call(2)).toMatchObject({ mode: 'retry', job: { runKind: 'revise' } });
      expect(finalize).not.toHaveBeenCalled();
    });
  });

  it('with the switch off an edit run is exported and ready as before', async () => {
    const finalize = vi.fn<Finalize>(async () => OUTPUT);
    const ctx = setup({ review: false, finalize });
    const id = ctx.enqueue('A');
    ctx.worker.start();
    await settle();
    ctx.runner.call(0).end({ ok: true });
    await ctx.worker.idle();

    expect(ctx.get(id)).toMatchObject({ state: 'ready', runKind: 'edit' });
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

describe('the Draft’s brief (Draft & chat, DR4)', () => {
  it('is taken in after the edit run, however it ended', async () => {
    const brief = new ScriptedBrief();
    brief.autoEnd = BRIEF_READY;
    const adopt = vi.fn<NonNullable<BriefRun['adopt']>>(async () => 'adopted');
    const withAdopt: BriefRun = { prepare: (job, context) => brief.prepare(job, context), adopt };
    const { worker, runner, enqueue } = setup({ brief: withAdopt });
    const id = enqueue('A');
    worker.start();
    await settle();
    expect(adopt).not.toHaveBeenCalled();

    runner.call(0).end({ ok: false, error: 'ffmpeg exited 1' });
    await settle();
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0]?.[0]).toMatchObject({ id });
  });
});

describe('two jobs at once', () => {
  it('runs the first two in line side by side, and the next one when either ends', async () => {
    const { worker, runner, enqueue, get } = setup({ atOnce: 2 });
    const [a, b, c] = [enqueue('A'), enqueue('B'), enqueue('C')] as [string, string, string];

    worker.start();
    await settle();

    expect(runner.ids).toEqual([a, b]);
    expect([get(a).state, get(b).state]).toEqual(['editing', 'editing']);
    expect(get(c)).toMatchObject({ state: 'queued', placeInLine: 1 });
    expect(worker.activeJobIds).toEqual([a, b]);

    // The second one ends first: the third takes its place while the first goes on.
    runner.call(1).end({ ok: true });
    await settle();
    expect(runner.ids).toEqual([a, b, c]);
    expect([get(a).state, get(b).state, get(c).state]).toEqual(['editing', 'ready', 'editing']);

    runner.call(0).end({ ok: true });
    runner.call(2).end({ ok: true });
    await worker.idle();

    expect([a, b, c].map((id) => get(id).state)).toEqual(['ready', 'ready', 'ready']);
    expect(runner.maxRunning).toBe(2);
    expect(worker.activeJobIds).toEqual([]);
  });

  it('never runs more than two, whatever the notifications', async () => {
    const { worker, runner, enqueue } = setup({ atOnce: 2 });
    for (const name of ['A', 'B', 'C', 'D', 'E']) enqueue(name);

    worker.start();
    worker.notify();
    await Promise.resolve();
    worker.notify();
    await settle();
    expect(runner.calls).toHaveLength(2);

    for (let i = 0; i < 5; i++) {
      worker.notify();
      runner.call(i).end({ ok: true });
      worker.notify();
      await Promise.resolve();
      worker.notify();
      await settle();
    }
    await worker.idle();

    expect(runner.calls).toHaveLength(5);
    expect(new Set(runner.ids).size).toBe(5);
    expect(runner.maxRunning).toBe(2);
  });

  it('never runs more than two when a listener of a started job notifies in the same turn', async () => {
    let worker: QueueWorker | null = null;
    // As the engine's bus does: the queued jobs that moved up are published, and that notifies.
    const result = setup({ atOnce: 2, onJobChanged: () => worker?.notify() });
    worker = result.worker;
    for (const name of ['A', 'B', 'C', 'D']) result.enqueue(name);

    worker.start();
    await settle();

    expect(result.runner.calls).toHaveLength(2);
    expect(result.runner.maxRunning).toBe(2);
    expect(result.get(result.runner.ids[1] as string).state).toBe('editing');
  });

  it('starts a job queued while one edits at once, beside it', async () => {
    const { worker, runner, enqueue } = setup({ atOnce: 2 });
    worker.start();
    const a = enqueue('A');
    worker.notify();
    await settle();
    expect(runner.ids).toEqual([a]);

    const b = enqueue('B');
    worker.notify();
    await settle();
    expect(runner.ids).toEqual([a, b]);
    expect(runner.running).toBe(2);
  });

  it('cancels only the job asked for; the other edit goes on', async () => {
    const { worker, runner, enqueue, get } = setup({ atOnce: 2 });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    const cancelled = await worker.cancel(b);

    expect(cancelled?.state).toBe('cancelled');
    expect(runner.call(1).aborted).toBe(true);
    expect(runner.call(0).aborted).toBe(false);
    expect(get(a).state).toBe('editing');

    runner.call(0).end({ ok: true });
    await worker.idle();
    expect(get(a).state).toBe('ready');
  });

  it('keeps each run’s progress on its own job', async () => {
    const { worker, runner, enqueue, get } = setup({ atOnce: 2 });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();

    runner.call(0).context.progress(3, 'A at 3');
    runner.call(1).context.progress(5, 'B at 5');

    expect(get(a)).toMatchObject({ step: 3, subProgress: 'A at 3' });
    expect(get(b)).toMatchObject({ step: 5, subProgress: 'B at 5' });
  });

  it('on shutdown leaves both jobs editing, and the next boot resumes both side by side', async () => {
    const { worker, runner, enqueue, get, newWorker } = setup({ atOnce: 2 });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];
    worker.start();
    await settle();
    // Past Brief, so the next boot carries on with the work instead of starting over.
    runner.call(0).context.progress(3, null);
    runner.call(1).context.progress(4, null);

    await worker.stop();
    expect(runner.calls.map((call) => call.abortReason)).toEqual(['shutdown', 'shutdown']);
    expect([get(a).state, get(b).state]).toEqual(['editing', 'editing']);

    const rebooted = newWorker();
    rebooted.start();
    await settle();
    expect(runner.ids.slice(2)).toEqual([a, b]);
    expect(runner.calls.slice(2).map((call) => call.mode)).toEqual(['resume', 'resume']);
  });

  it('asks once about the job at the head of the line that has to wait, and starts it once', async () => {
    const asked: string[] = [];
    const wait = deferred<void>();
    const beforeStart = (job: Job): Promise<void> | null => {
      asked.push(job.name);
      return job.name === 'A' ? wait.promise : null;
    };
    const { worker, runner, enqueue, get } = setup({ atOnce: 2, beforeStart });
    const [a, b] = [enqueue('A'), enqueue('B')] as [string, string];

    worker.start();
    await settle();
    worker.notify();
    await settle();

    // Both lanes wait for A: B does not jump ahead of it.
    expect(asked).toEqual(['A']);
    expect(runner.ids).toEqual([]);
    expect(get(b).state).toBe('queued');

    wait.resolve();
    await settle();
    expect(runner.ids).toEqual([a, b]);
    expect(asked).toEqual(['A', 'B']);
  });

  it('picks nothing while the other lane hands its ready job over', async () => {
    const handed: { job: Job; done: ReturnType<typeof deferred<void>> }[] = [];
    const afterReady = (job: Job): Promise<void> => {
      const done = deferred<void>();
      handed.push({ job, done });
      return done.promise;
    };
    const { worker, runner, enqueue, get } = setup({ atOnce: 2, afterReady });
    const [a, , c] = [enqueue('A'), enqueue('B'), enqueue('C')] as [string, string, string];
    worker.start();
    await settle();

    runner.call(0).end({ ok: true });
    await settle();
    expect(handed.map((call) => call.job.id)).toEqual([a]);
    // B fails: its lane is free, but C waits until A's Learn pass is queued.
    runner.call(1).end({ ok: false, error: 'no' });
    await settle();
    expect(runner.calls).toHaveLength(2);
    expect(get(c).state).toBe('queued');

    handed[0]?.done.resolve();
    await settle();
    expect(runner.ids).toHaveLength(3);
    expect(runner.call(2).job.id).toBe(c);
    expect(runner.running).toBe(1);
  });
});
