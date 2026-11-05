import {
  type AnalyticsStage,
  type AnalyticsTypicalJob,
  EDITOR_STAGE_KEYS,
  TYPICAL_JOB_STAGES,
  type TypicalJobStageKey,
} from './analytics.ts';
import type { AnalyticsJob, AnalyticsStepRun, ComputeAnalyticsInput } from './analytics-compute.ts';
import { finishedAtOf } from './analytics-finished.ts';
import {
  inputPeriod,
  inWindow,
  msOf,
  type TimeWindow,
  trailingWindows,
  windowDaysOf,
} from './analytics-time.ts';
import { CHECK_STEP, RENDER_STEP, STEPS, type StepId } from './steps.ts';

// Section "A typical job, step by step" of the Analytics page (Analytics plan, "Typical job (J1)"):
// the medians of each stretch of a finished job (analytics-finished.ts), over the jobs finished in the last 30 days and
// over the 30 days before ("vs before"); in the week period over the last 7 days and the 7 before.
// A job is cut into these stretches:
//
//   Waiting to start   the first step's start, minus when the job was added (the queue)
//   Brief ... Check    steps 1 to 7 of the round-0 edit run, one stretch per step
//   Waiting for you    from the end of round-0 Check to the approval, minus the revise runs' step
//                      time (the editor's time, not yours)
//   Render             the render's step 8
//
// The medians are taken one stretch at a time, over the jobs that have that stretch. A job without
// one (no approval, a step that never finished) is left out of that stretch only. A stretch no job
// has is `null`, never 0. The editor's total is the median of each job's own editing time (edit and
// revise runs, every round, steps 1 to 7: the same number as the Editing time tile), the whole job
// is the median of files in to ready, as on the Files in → ready tile.

/** One timed run with its times read as milliseconds. `endMs` is `null` for a run left open. */
interface TimedRun {
  step: StepId;
  kind: AnalyticsStepRun['runKind'];
  round: number;
  startMs: number;
  endMs: number | null;
}

/** A finished job's stretches, in seconds. A stretch the job does not have is not in the map. */
interface JobTimes {
  stages: ReadonlyMap<TypicalJobStageKey, number>;
  /** All of the job's edit and revise step time (steps 1 to 7); `null` when no such step finished. */
  editorSec: number | null;
  /** Files in to ready. */
  wholeSec: number | null;
}

const STEP_STAGE_KEYS = new Map<StepId, TypicalJobStageKey>(
  STEPS.filter((step) => step.id <= CHECK_STEP).map((step) => [
    step.id,
    step.label.toLowerCase() as TypicalJobStageKey,
  ]),
);

/** The middle value (the mean of the two middle ones for an even count), whole seconds; `null` for none. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const middle =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(middle);
}

function secondsBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / 1000;
}

/** How long a run took; `null` for one that is still open, left open, or has times that do not add up. */
function lengthOf(run: TimedRun): number | null {
  if (run.endMs === null || run.endMs < run.startMs) return null;
  return secondsBetween(run.startMs, run.endMs);
}

/** The runs' lengths added up; `null` when none of them has finished. */
function totalOf(runs: readonly TimedRun[]): number | null {
  let total: number | null = null;
  for (const run of runs) {
    const length = lengthOf(run);
    if (length !== null) total = (total ?? 0) + length;
  }
  return total;
}

function timedRuns(runs: readonly AnalyticsStepRun[]): TimedRun[] {
  return runs.flatMap((run) => {
    const startMs = msOf(run.startedAt);
    if (startMs === null) return [];
    return [
      { step: run.step, kind: run.runKind, round: run.round, startMs, endMs: msOf(run.endedAt) },
    ];
  });
}

/** What one finished job contributes to each stretch. */
function timesOf(job: AnalyticsJob, finishedMs: number, runs: readonly TimedRun[]): JobTimes {
  const stages = new Map<TypicalJobStageKey, number>();
  const addedMs = msOf(job.addedAt);
  const edit = runs.filter((run) => run.kind === 'edit' && run.round === 0);

  // Waiting to start: from the job being added to the first step beginning.
  if (addedMs !== null && edit.length > 0) {
    const firstStart = Math.min(...edit.map((run) => run.startMs));
    if (firstStart >= addedMs) stages.set('waiting-to-start', secondsBetween(addedMs, firstStart));
  }

  // Brief to Check: the round-0 edit run's own steps.
  for (const [step, key] of STEP_STAGE_KEYS) {
    const sec = totalOf(edit.filter((run) => run.step === step));
    if (sec !== null) stages.set(key, sec);
  }

  // Waiting for you: from the end of round-0 Check to the approval, less the revise runs' time.
  const approvedMs = msOf(job.approvedAt);
  const checkEnds = edit.flatMap((run) =>
    run.step === CHECK_STEP && run.endMs !== null ? [run.endMs] : [],
  );
  if (approvedMs !== null && checkEnds.length > 0) {
    const revised = totalOf(runs.filter((run) => run.kind === 'revise')) ?? 0;
    const waiting = secondsBetween(Math.max(...checkEnds), approvedMs) - revised;
    if (waiting >= 0) stages.set('waiting-for-you', waiting);
  }

  // Render: the final step. With Review off it is a step of the edit run, so it is any run's.
  const render = totalOf(runs.filter((run) => run.step === RENDER_STEP));
  if (render !== null) stages.set('render', render);

  // The editor's own time: every edit and revise step before the render.
  const editorSec = totalOf(runs.filter((run) => run.step < RENDER_STEP));
  const wholeSec = addedMs === null ? null : secondsBetween(addedMs, finishedMs);
  return { stages, editorSec, wholeSec: wholeSec !== null && wholeSec >= 0 ? wholeSec : null };
}

/** The times of the jobs that finished in `window`, with how many jobs that was. */
function timesIn(
  window: TimeWindow,
  jobs: readonly AnalyticsJob[],
  runsByJob: ReadonlyMap<string, readonly TimedRun[]>,
): { counted: number; times: JobTimes[] } {
  const times: JobTimes[] = [];
  for (const job of jobs) {
    // The same finished-job rule as the Jobs tiles (analytics-finished.ts).
    const finishedMs = finishedAtOf(job);
    if (finishedMs === null || !inWindow(finishedMs, window)) continue;
    times.push(timesOf(job, finishedMs, runsByJob.get(job.id) ?? []));
  }
  return { counted: times.length, times };
}

function medianOf(values: readonly (number | null | undefined)[]): number | null {
  return median(values.filter((value): value is number => typeof value === 'number'));
}

/** The editor's step with the longest median; the first of them when two are alike. */
function slowestStep(stages: readonly AnalyticsStage[]): AnalyticsTypicalJob['slowestStepKey'] {
  let slowest: AnalyticsStage | null = null;
  for (const stage of stages) {
    if (stage.kind !== 'editor' || stage.medianSec === null) continue;
    if (slowest === null || stage.medianSec > (slowest.medianSec ?? 0)) slowest = stage;
  }
  const key = slowest?.key;
  return EDITOR_STAGE_KEYS.find((editorKey) => editorKey === key) ?? null;
}

export function computeTypicalJobSection(input: ComputeAnalyticsInput): AnalyticsTypicalJob {
  const { now, jobs, stepRuns } = input;
  const runsByJob = new Map<string, AnalyticsStepRun[]>();
  for (const run of stepRuns) {
    const own = runsByJob.get(run.jobId);
    if (own === undefined) runsByJob.set(run.jobId, [run]);
    else own.push(run);
  }
  const timed = new Map<string, TimedRun[]>(
    [...runsByJob].map(([jobId, runs]) => [jobId, timedRuns(runs)]),
  );

  const { current, before } = trailingWindows(now, windowDaysOf(inputPeriod(input)));
  const last = timesIn(current, jobs, timed);
  const earlier = timesIn(before, jobs, timed);

  const stages: AnalyticsStage[] = TYPICAL_JOB_STAGES.map((stage) => ({
    ...stage,
    medianSec: medianOf(last.times.map((job) => job.stages.get(stage.key))),
    beforeSec: medianOf(earlier.times.map((job) => job.stages.get(stage.key))),
  }));

  return {
    stages,
    editorSec: medianOf(last.times.map((job) => job.editorSec)),
    editorBeforeSec: medianOf(earlier.times.map((job) => job.editorSec)),
    wholeSec: medianOf(last.times.map((job) => job.wholeSec)),
    wholeBeforeSec: medianOf(earlier.times.map((job) => job.wholeSec)),
    slowestStepKey: slowestStep(stages),
    jobsCounted: last.counted,
    jobsCountedBefore: earlier.counted,
  };
}
