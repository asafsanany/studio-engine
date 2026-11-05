// The ETA estimator (E5, with the CVP-85 fallbacks): "~4 min left" when past jobs support it,
// nothing otherwise.
//
//   step_runs (timings written by the worker) --> median seconds per footage minute, per step
//   job.step + how long it has been in it     --> remaining time of the step + every later step
//
// `createEtaEstimator` plugs into the job repository (`estimateEtaSec`), which asks for it every
// time a queued or editing job is read: so a PROGRESS write is picked up as soon as the worker
// publishes the job, and nothing is stored. `createEtaTicker` re-reads the editing job every 15 s
// and publishes it when the estimate changed, because the time left shrinks without any write.
// The D3 formatter (`eta()` in @studio/shared) turns the seconds into "~4 min left".
//
// A step is TRUSTED when it has ETA_MIN_SAMPLES usable finished runs; its estimate is then the
// median of them (E5, unchanged). Real histories rarely give every step that many: every engine
// restart, Cancel and failed export leaves the running step open (an open run is never a sample),
// a resumed or retried run does not time the step it starts in, and a step video-use skips has no
// run at all. Needing three samples of EVERY remaining step kept the ETA off for many jobs (V4,
// CVP-79), so a step without a trusted rate degrades to a FALLBACK instead of switching the whole
// ETA off (CVP-85):
//
//   1. Skipped.   None of the newest ETA_MIN_SAMPLES finished (ready) jobs ran the step, not even
//                 as an interrupted run: it counts as 0.
//   2. Otherwise. An even share of a whole run: the median, over the newest finished jobs, of the
//                 run's own timed seconds per footage minute, divided by the number of steps that
//                 were not skipped. If the step has runs of its own, too few to trust, the
//                 slowest of them is used when it is larger than the share.
//
// The fallbacks need finished jobs as evidence, with the same floor as a step: no whole-run rate
// (and so no ETA, unless every step has its own) before ETA_MIN_SAMPLES finished jobs of known
// footage, so a first or second job still shows nothing.
//
// Never optimistic, so the figure errs on more time left:
//   - A trusted step is always counted, even when the newest jobs skipped it: a step that only
//     happens sometimes may be needed, and the figure then runs high, not low.
//   - The whole-run time is the sum of the run's timed steps, so time waiting in Review, in the
//     queue or for a Retry is left out; runs of the step's own can only raise its share, never
//     lower it.
//   - The one way to be low is a step counted as skipped that this job runs after all; the first
//     finished job that ran it ends the skip.
//
// Run kinds (Phase 3). The three runs of a job (edit, revise, render) are different work, so
// samples and finished runs are per kind (step_runs.run_kind; old rows are edit runs). A revise
// or render run without enough history of its own borrows the edit run's figure for the step,
// never the edit's "skipped = 0" (a Review-era edit history has no Render step at all). A run
// that ends in a preview (a revise run, or an edit run with the Review switch on) is counted
// only up to Check (7), never Render.
//
// Steps behind the job are not counted; the current step counts its estimate minus the time
// already spent in it, never below 0.

import {
  CHECK_STEP,
  type Job,
  RENDER_STEP,
  type RunKind,
  STEP_IDS,
  type StepId,
} from '@studio/shared';
import type {
  EtaEstimator,
  FinishedRun,
  JobRepository,
  StepDuration,
  StepRunRepository,
} from '../db/index.js';
import type { BusListener, EventBus } from '../events/bus.js';
import { runFinishOf } from './run-finish.js';

/** How many of the latest finished runs of a step make up its estimate. */
export const ETA_SAMPLE_LIMIT = 10;
/** A step needs this many usable runs before it is trusted. */
export const ETA_MIN_SAMPLES = 3;
/** How often the editing job's estimate is re-read and, if it moved, published. */
export const ETA_TICK_MS = 15_000;

/** `seconds` per minute of footage, or `null` when the footage length is 0, unknown or invalid. */
function perFootageMinute(seconds: number, footageSec: number): number | null {
  if (!(footageSec > 0) || !Number.isFinite(footageSec)) return null;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds / (footageSec / 60);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * The seconds per footage minute of every usable sample in `samples` (newest runs; the caller
 * limits them to {@link ETA_SAMPLE_LIMIT}).
 *
 * A sample is unusable, and left out, when its footage length is 0 or unknown (a job with no
 * audio or video, or one ffprobe could not read): there is no rate to take from it. A tiny but
 * known footage length is kept as it is; the median keeps such an outlier from deciding.
 */
export function usableRates(samples: readonly StepDuration[]): number[] {
  const rates: number[] = [];
  for (const { durationSec, footageSec } of samples) {
    const rate = perFootageMinute(durationSec, footageSec);
    if (rate !== null) rates.push(rate);
  }
  return rates;
}

/**
 * The typical seconds one step takes per minute of footage: the median of
 * `duration / footage minutes` over the usable `samples`. `null` when fewer than
 * {@link ETA_MIN_SAMPLES} are usable (the step is not trusted; see the fallbacks above).
 */
export function stepRate(samples: readonly StepDuration[]): number | null {
  const rates = usableRates(samples);
  return rates.length < ETA_MIN_SAMPLES ? null : median(rates);
}

/**
 * The typical seconds a whole run takes per minute of footage: the median over `runs` (newest
 * finished jobs) of `runSec / footage minutes`, where `runSec` is the sum of the run's own timed
 * steps. `null` when fewer than {@link ETA_MIN_SAMPLES} runs have a known footage length.
 */
export function wholeRunRate(runs: readonly FinishedRun[]): number | null {
  const rates: number[] = [];
  for (const { runSec, footageSec } of runs) {
    const rate = perFootageMinute(runSec, footageSec);
    if (rate !== null) rates.push(rate);
  }
  return rates.length < ETA_MIN_SAMPLES ? null : median(rates);
}

/**
 * The steps that none of the newest {@link ETA_MIN_SAMPLES} of `runs` (newest first) ran, not
 * even as an interrupted run. Empty while fewer finished jobs than that exist: one job that
 * skipped a step says little about the next.
 */
export function skippedSteps(runs: readonly FinishedRun[]): ReadonlySet<StepId> {
  const recent = runs.slice(0, ETA_MIN_SAMPLES);
  if (recent.length < ETA_MIN_SAMPLES) return new Set();
  return new Set(STEP_IDS.filter((id) => recent.every((run) => !run.steps.includes(id))));
}

/** What to count for a step that has no trusted rate: seconds per footage minute, `null` for none. */
export type StepFallback = (step: StepId, ownRates: readonly number[]) => number | null;

/**
 * The fallbacks of the module header, over `runs` (finished runs of one kind, newest job first).
 * `ownRates` are the step's own usable rates, too few to trust. `null` when the step is not
 * skipped and there is not enough finished-job history for a whole-run rate: the ETA stays off
 * then, as before.
 */
export function createStepFallback(runs: readonly FinishedRun[]): StepFallback {
  const skipped = skippedSteps(runs);
  const whole = wholeRunRate(runs);
  const share = whole === null ? null : whole / Math.max(1, STEP_IDS.length - skipped.size);

  return (step, ownRates) => {
    if (skipped.has(step)) return 0;
    if (share === null) return null;
    return Math.max(share, ...ownRates);
  };
}

export interface EtaInput {
  /** The step the job is in now. */
  step: StepId;
  /** The run's last step: Check (7) for a run that ends in a preview, else Render (8, the default). */
  lastStep?: StepId;
  /** This job's footage, in seconds. Must be above 0. */
  footageSec: number;
  /** How long the job has been in `step`, in seconds. */
  elapsedSec: number;
  /** {@link stepRate} of a step, `null` when it has too few samples. */
  rateOf: (step: StepId) => number | null;
  /**
   * What to count for a step `rateOf` has no rate for (a {@link StepFallback} already bound to
   * the step's own samples). `null`, or not given: that step makes the whole estimate `null`.
   */
  fallbackOf?: (step: StepId) => number | null;
}

/**
 * Seconds left: what remains of the current step (its estimate minus the time already spent in
 * it, never below 0) plus the estimate of every later step up to `lastStep`, each scaled by this
 * job's footage. `null` when the footage is unknown or any of those steps has neither a rate nor
 * a fallback.
 *
 * Steps before the current one are not counted. A step video-use skips for a job still counts
 * while it is ahead, unless the fallbacks say recent jobs skipped it (the module header), so the
 * figure can be pessimistic and is optimistic only when a step counted as skipped turns up.
 */
export function etaSecFrom({
  step,
  lastStep = RENDER_STEP,
  footageSec,
  elapsedSec,
  rateOf,
  fallbackOf,
}: EtaInput): number | null {
  if (!(footageSec > 0) || !Number.isFinite(footageSec)) return null;
  const footageMin = footageSec / 60;

  let total = 0;
  for (const id of STEP_IDS) {
    // A job already past the run's last step (an edit that failed at Render and was retried with
    // the Review switch on) still counts the step it is in.
    if (id < step || id > Math.max(lastStep, step)) continue;
    const rate = rateOf(id) ?? fallbackOf?.(id) ?? null;
    if (rate === null) return null;
    const estimate = rate * footageMin;
    total += id === step ? Math.max(0, estimate - Math.max(0, elapsedSec)) : estimate;
  }
  return total;
}

export interface EtaEstimatorOptions {
  /** Past timings, finished jobs for the fallbacks, and when the job's current step started. */
  stepRuns: Pick<StepRunRepository, 'recentDurations' | 'openRunStartedAt' | 'recentFinishedRuns'>;
  /** Defaults to the system clock. Use the same clock as `stepRuns` so elapsed time adds up. */
  clock?: () => Date;
  /** The Review switch (`Config.review`): an edit run then ends at Check. Default off. */
  review?: boolean;
  /** Defaults to {@link ETA_SAMPLE_LIMIT}. */
  sampleLimit?: number;
}

/**
 * The estimator for `JobRepository`'s `estimateEtaSec` option.
 *
 * - Only an `editing` job gets an estimate. A queued job is `null`: the table shows the ETA only
 *   inside the step progress, and "how long until it starts" depends on the job ahead of it.
 * - A job with no known footage is `null` (no way to scale the history to it).
 * - The time spent in the current step is read from its open `step_run`. A job that was resumed
 *   or retried mid-step has none (the worker does not time the step it continues from), so the
 *   time is counted from the first time this process saw the job in that step. That keeps the
 *   estimate counting down, and errs on the side of more time left.
 * - The history is that of the job's run kind (`job.runKind`), and the estimate runs to Check for a
 *   run that ends in a preview, else to Render.
 * - A step without enough runs of its own is counted by the fallbacks of the module header, read
 *   from the newest finished jobs only when a step needs them. A revise or render run with too
 *   little history of its own falls back to the edit run's figure for the step.
 * - Each call reads the history again (at most 8 step queries and 2 for the finished jobs, for one
 *   job: only one edits at a time), so a run that just finished is part of the very next estimate.
 */
export function createEtaEstimator({
  stepRuns,
  clock = () => new Date(),
  sampleLimit = ETA_SAMPLE_LIMIT,
  review = false,
}: EtaEstimatorOptions): EtaEstimator {
  // When this process first saw each editing job in its current step; for jobs with no open run.
  const firstSeen = new Map<string, { step: StepId; at: number }>();

  return (job: Job, footageSec: number): number | null => {
    if (job.state !== 'editing') {
      firstSeen.delete(job.id);
      return null;
    }
    const step = job.step ?? 1;
    const now = clock().getTime();

    let seen = firstSeen.get(job.id);
    if (seen?.step !== step) {
      seen = { step, at: now };
      firstSeen.set(job.id, seen);
    }
    const startedAt = stepRuns.openRunStartedAt(job.id, step)?.getTime() ?? seen.at;

    const kind = job.runKind;
    const lastStep: StepId = runFinishOf(kind, review) === 'preview' ? CHECK_STEP : RENDER_STEP;
    const samples = new Map<string, StepDuration[]>();
    const samplesOf = (of: RunKind, id: StepId): StepDuration[] => {
      const key = `${of}:${id}`;
      let own = samples.get(key);
      if (own === undefined) {
        own = stepRuns.recentDurations(id, sampleLimit, of);
        samples.set(key, own);
      }
      return own;
    };
    let fallback: StepFallback | undefined;

    return etaSecFrom({
      step,
      lastStep,
      footageSec,
      elapsedSec: (now - startedAt) / 1000,
      rateOf: (id) => stepRate(samplesOf(kind, id)),
      fallbackOf: (id) => {
        const ownRates = usableRates(samplesOf(kind, id));
        fallback ??= createStepFallback(stepRuns.recentFinishedRuns(kind, sampleLimit));
        const share = fallback(id, ownRates);
        if (share !== null || kind === 'edit') return share;
        // A revise or render run with too little history of its own: the slowest of its own
        // runs, else what the edit run's same step takes (more work than a revise's, the same
        // render), so the figure errs on more time left. Never the edit's "skipped = 0".
        if (ownRates.length > 0) return Math.max(...ownRates);
        const edit = samplesOf('edit', id);
        const editRates = usableRates(edit);
        return stepRate(edit) ?? (editRates.length > 0 ? Math.max(...editRates) : null);
      },
    });
  };
}

/** Interval functions, injectable so tests can run minutes of ticks in no time. */
export interface EtaTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The real timers, unreferenced: the ticker alone must not keep the process up. */
export const systemEtaTimers: EtaTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export interface EtaTickerOptions {
  bus: EventBus;
  /** Only `getEditing` is used. Reading it asks the estimator for each job's current `etaSec`. */
  jobs: Pick<JobRepository, 'getEditing'>;
  /** Defaults to {@link ETA_TICK_MS}. */
  intervalMs?: number;
  timers?: EtaTimers;
  /** Called with whatever a tick threw (a closed database, say). Defaults to ignoring it. */
  onError?: (error: unknown) => void;
}

export interface EtaTicker {
  /** Starts ticking every `intervalMs`. Does nothing if it already runs. */
  start(): void;
  /** Stops ticking and listening. Safe to call twice, or without `start`. */
  stop(): void;
  /** One tick now: publishes `job.upsert` for each editing job whose `etaSec` is not what was last announced. */
  tick(): void;
}

/**
 * Keeps the ETA on screen true while a job edits.
 *
 * `etaSec` is derived whenever a job is read, so as the clock runs it changes without any write,
 * and nothing would publish it. Every `intervalMs` this re-reads the editing jobs and publishes
 * (`job.upsert`, same `updatedAt`: an ETA is not an update) those whose estimate differs from what
 * the bus last said about them. It listens to the bus for that, so an upsert from a PROGRESS
 * counts as announced and the next tick does not repeat it. A job whose estimate has not moved
 * (no history yet, or the time left is only later steps' fixed estimates) costs a read and no
 * event; SSE streams coalesce what is published to one frame per 250 ms.
 */
export function createEtaTicker({
  bus,
  jobs,
  intervalMs = ETA_TICK_MS,
  timers = systemEtaTimers,
  onError = () => {},
}: EtaTickerOptions): EtaTicker {
  // What the bus last said about each editing job's ETA.
  const announced = new Map<string, number | null>();
  let handle: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const onEvent: BusListener = (event) => {
    if (event.type === 'job.upsert') {
      if (event.job.state === 'editing') announced.set(event.job.id, event.job.etaSec);
      else announced.delete(event.job.id);
    } else if (event.type === 'job.remove') {
      announced.delete(event.id);
    }
  };

  function tick(): void {
    try {
      const editing = jobs.getEditing();
      const ids = new Set(editing.map((job) => job.id));
      for (const id of announced.keys()) {
        if (!ids.has(id)) announced.delete(id);
      }
      for (const job of editing) {
        if ((announced.get(job.id) ?? null) === job.etaSec) continue;
        announced.set(job.id, job.etaSec);
        bus.publish({ type: 'job.upsert', job });
      }
    } catch (err) {
      onError(err);
    }
  }

  return {
    start() {
      if (handle !== null) return;
      unsubscribe = bus.subscribe(onEvent);
      handle = timers.setInterval(tick, intervalMs);
    },
    stop() {
      if (handle !== null) timers.clearInterval(handle);
      handle = null;
      unsubscribe?.();
      unsubscribe = null;
      announced.clear();
    },
    tick,
  };
}
