// The progress tracker (E4): while a job edits, works out its step (2-8, Transcribe to Render) and
// the count inside it from what video-use writes into `<job>/edit/` and from the run's stream, and
// reports it to the worker through `progress(step, sub)`. The worker turns each report into a
// PROGRESS transition and the step timings (step_runs) the ETA needs; it ignores repeats and
// anything after the run.
//
//   stream events --(progress-signals.ts)--\
//                                            >--> reducer (progress-reducer.ts) --> progress()
//   edit/ polls   --(progress-watcher.ts)--/      only when the step or its text changed
//
// It plugs into the Claude runner as its `track` hook (engine.ts). The runner calls it once the
// process has started, passes every stream event to `onEvent`, and calls `stop()` once the
// process has exited. It also works without a stream (files only), for any runner that has an
// edit/ folder: call `startProgressTracker` and `stop()` yourself.

import type { StepId } from '@studio/shared';
import type { RunnerLogger, RunTracker, TrackedRun } from './claude-runner.js';
import {
  CHECK_STEP,
  initialProgress,
  type ProgressReport,
  type ProgressSignal,
  type ProgressState,
  passFromSub,
  progressReport,
  reduceProgress,
} from './progress-reducer.js';
import { signalsFromStreamEvent } from './progress-signals.js';
import { EditWatcher } from './progress-watcher.js';
import type { StreamEvent } from './stream-parser.js';

export interface ProgressTrackerOptions {
  logger?: RunnerLogger;
  /** How often edit/ is looked at. Default 1 s. */
  pollIntervalMs?: number;
}

/** The part of a `TrackedRun` the tracker uses (no process needed). */
export type ProgressRun = Pick<
  TrackedRun,
  'job' | 'mode' | 'editDir' | 'signal' | 'progress' | 'transcribeTotal' | 'finish'
>;

export interface ProgressTracker extends Required<RunTracker> {
  /** The state so far (for tests and logs). */
  readonly state: ProgressState;
  /** Resolves once the first look at edit/ has been taken and reported. */
  readonly ready: Promise<void>;
}

const SILENT: RunnerLogger = { info() {}, warn() {}, error() {} };

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'unknown';
}

function describeSignal(signal: ProgressSignal): string {
  switch (signal.type) {
    case 'file':
      return `${signal.change} ${signal.path}`;
    case 'edl':
      return `edl.json with ${signal.overlays} overlays`;
    case 'render':
      return `${signal.target} render started`;
    case 'review':
      return 'review sub-agent started';
    case 'composition':
      return `hyperframes ${signal.tool}`;
    case 'pass':
      return `earlier check rounds: pass ${signal.n}`;
    case 'music':
      return 'making the music';
  }
}

/** Starts tracking one run. Never throws, and nothing it does can break the run. */
export function startProgressTracker(
  run: ProgressRun,
  options: ProgressTrackerOptions = {},
): ProgressTracker {
  const logger = options.logger ?? SILENT;
  const { job } = run;
  // What the worker shows: Brief (1) for a fresh job. The reducer starts such a run at Transcribe.
  const floor: StepId = job.step ?? 1;

  // Transcribe's N: the brief's footage files (the worker counts them, CVP-134), because voice
  // notes and ignored clips never get a transcript in edit/transcripts/. Without a brief, every
  // audio and video file in the job folder.
  let state = initialProgress({
    floor,
    sources: run.transcribeTotal ?? job.inputs.video + job.inputs.audio,
    pass: floor === CHECK_STEP ? passFromSub(job.subProgress) : 0,
    finish: run.finish ?? 'final',
  });
  // What the worker already shows, so the first report is only sent if it says something new.
  let reported: ProgressReport = { step: floor, sub: job.subProgress };
  let ended = false;
  const failures = new Set<string>();

  const report = (cause: ProgressSignal | null): void => {
    if (ended) return;
    const next = progressReport(state);
    if (next.step === reported.step && next.sub === reported.sub) return;
    if (next.step !== reported.step) {
      logger.info(
        {
          jobId: job.id,
          step: next.step,
          sub: next.sub,
          cause: cause ? describeSignal(cause) : null,
        },
        'edit progress',
      );
    }
    reported = next;
    try {
      run.progress(next.step, next.sub);
    } catch (err) {
      // `progress` never throws, by contract; a broken one must still not break the run.
      logger.warn({ jobId: job.id, err }, 'progress callback threw');
    }
  };

  const apply = (signals: readonly ProgressSignal[]): void => {
    let cause: ProgressSignal | null = null;
    for (const signal of signals) {
      const next = reduceProgress(state, signal);
      if (next.step !== state.step) cause = signal;
      state = next;
    }
    report(cause);
  };

  const fail = (err: unknown, what: string): void => {
    const key = `${what}:${errorCode(err)}`;
    if (failures.has(key)) return;
    failures.add(key);
    logger.warn({ jobId: job.id, err, editDir: run.editDir }, what);
  };

  const watcher = new EditWatcher({
    editDir: run.editDir,
    // A fresh run starts from nothing; a resumed or retried one carries on from what is there.
    // A revise run works over the previous round's files (composition, verify/ frames), which say
    // nothing about this run, so even a resumed or retried one counts only what it writes from now.
    baseline: run.mode === 'start' || run.job.runKind === 'revise',
    intervalMs: options.pollIntervalMs,
    onSignals: (signals) => apply(signals),
    onError: (err) => fail(err, 'could not look at the edit folder; progress may lag'),
  });

  let stopping: Promise<void> | null = null;
  const halt = (finalLook: boolean): Promise<void> => {
    stopping ??= watcher.stop({ finalLook }).then(() => {
      ended = true;
    });
    return stopping;
  };

  const onAbort = (): void => {
    void halt(false);
  };
  if (run.signal.aborted) onAbort();
  else run.signal.addEventListener('abort', onAbort, { once: true });

  // A fresh run is at Transcribe with nothing written yet: say how many sources there are.
  const ready = watcher.start().then(() => report(null));
  if (run.mode === 'start') report(null);

  return {
    get state() {
      return state;
    },
    ready,
    onEvent(event: StreamEvent): void {
      if (ended) return;
      try {
        const signals = signalsFromStreamEvent(event);
        if (signals.length > 0) apply(signals);
      } catch (err) {
        fail(err, 'progress tracker could not read a stream event');
      }
    },
    async stop(): Promise<void> {
      run.signal.removeEventListener('abort', onAbort);
      // The process has exited: one last look, unless the run was cancelled or stopped.
      await halt(!run.signal.aborted);
    },
  };
}

/** The runner's `track` hook: one tracker per run (engine.ts passes it to `createRunner`). */
export function createProgressTracker(
  options: ProgressTrackerOptions = {},
): (run: TrackedRun) => RunTracker {
  return (run) => startProgressTracker(run, options);
}
