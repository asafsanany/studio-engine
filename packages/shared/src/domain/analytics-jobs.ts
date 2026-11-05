import {
  ANALYTICS_CALENDAR_WEEKS,
  ANALYTICS_SIZES,
  ANALYTICS_TILES,
  type AnalyticsJobs,
  type AnalyticsPeriod,
  type AnalyticsTile,
  tileSeriesLength,
} from './analytics.ts';
import type { AnalyticsJob, AnalyticsStepRun, ComputeAnalyticsInput } from './analytics-compute.ts';
import { finishedAtOf } from './analytics-finished.ts';
import {
  addDays,
  bucketIndexOf,
  bucketLastDay,
  bucketStartsEnding,
  calendarDays,
  DAY_MS,
  inputPeriod,
  inWindow,
  localDayOf,
  msOf,
  startOfLocalDay,
  type TimeWindow,
  trailingWindows,
  windowDaysOf,
} from './analytics-time.ts';
import { CHECK_STEP } from './steps.ts';

// Section "Jobs" of the Analytics page (Analytics plan, "Data and definitions"): the five tiles
// (Jobs finished, Clients, Files in → ready, Editing time, Approved first time), the delivery
// calendar and the footage chart.
//
// - A finished job is a ready job with an export (`output`); it finished at its `finishedAt`, the
//   end of its final run. A job that was started again is not finished until the new run ends.
// - A tile's number covers the last 30 days; `previous` the 30 days before. Its eight weekly
//   values are the same number for each of the last 8 calendar weeks. In the week period the
//   window is 7 days, `previous` the 7 before, and the 14 values are for the last 14 days.
// - The Clients tile's values are by day in both periods: each day's is the clients with a job
//   finished in the window that ends that day (30 days, week period 7), so today's is its number.
// - The data begins the day the first job was added (or the first delivery or timed step, if one is
//   older). Before that, a window, a week or a day has no data and is `null`; from then on a quiet
//   one is a real zero (a count) or has nothing to say (a median, a share of nothing: `null`).
// - Nothing that has not happened yet (after `now`) is counted.

/** One finished job, with what the tiles take from it. */
interface Finished {
  clientId: string;
  /** When it finished: milliseconds since the epoch. */
  at: number;
  /** Files in → ready: `finishedAt` − `addedAt`, seconds; `null` when the times do not add up. */
  readySec: number | null;
  /** The editor's time: its edit and revise steps added up, seconds; `null` with none timed. */
  editingSec: number | null;
}

/** One approval (Approve, in Review): first time means no notes were sent before it. */
interface Approval {
  at: number;
  firstTime: boolean;
}

/** The middle value of `values` (the mean of the two in the middle for an even count); `null` for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return high;
  return ((sorted[middle - 1] ?? 0) + high) / 2;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** The step runs of every job, by job id. */
function runsByJob(stepRuns: readonly AnalyticsStepRun[]): Map<string, AnalyticsStepRun[]> {
  const byJob = new Map<string, AnalyticsStepRun[]>();
  for (const run of stepRuns) {
    const own = byJob.get(run.jobId);
    if (own === undefined) byJob.set(run.jobId, [run]);
    else own.push(run);
  }
  return byJob;
}

/**
 * The editor's time on a job: the seconds of its `edit` and `revise` steps, every round, added up.
 * A step that was left open (a crash) has no end to time it by and is not counted; `null` when no
 * step of the job is timed at all. The render is not the editor's time.
 */
function editingSecOf(runs: readonly AnalyticsStepRun[] | undefined): number | null {
  const seconds: number[] = [];
  for (const run of runs ?? []) {
    if (run.runKind === 'render') continue;
    const start = msOf(run.startedAt);
    const end = msOf(run.endedAt);
    if (start === null || end === null || end < start) continue;
    seconds.push((end - start) / 1000);
  }
  return seconds.length === 0 ? null : sum(seconds);
}

function finishedJobs(
  jobs: readonly AnalyticsJob[],
  runs: ReadonlyMap<string, AnalyticsStepRun[]>,
  now: number,
): Finished[] {
  const finished: Finished[] = [];
  for (const job of jobs) {
    const at = finishedAtOf(job);
    if (at === null || at > now) continue;
    const added = msOf(job.addedAt);
    finished.push({
      clientId: job.clientId,
      at,
      readySec: added === null || at < added ? null : (at - added) / 1000,
      editingSec: editingSecOf(runs.get(job.id)),
    });
  }
  return finished;
}

function approvals(jobs: readonly AnalyticsJob[], now: number): Approval[] {
  const approved: Approval[] = [];
  for (const job of jobs) {
    const at = msOf(job.approvedAt);
    if (at === null || at > now) continue;
    approved.push({ at, firstTime: job.round === 0 });
  }
  return approved;
}

/** The first moment anything was recorded: the oldest job, delivery or timed step; `null` for nothing. */
function dataStart(input: ComputeAnalyticsInput): number | null {
  const moments: number[] = [];
  for (const job of input.jobs) {
    const added = msOf(job.addedAt);
    if (added !== null) moments.push(added);
  }
  for (const delivery of input.deliveries) {
    if (Number.isFinite(delivery.deliveredAt)) moments.push(delivery.deliveredAt);
  }
  for (const run of input.stepRuns) {
    const started = msOf(run.startedAt);
    if (started !== null) moments.push(started);
  }
  return moments.length === 0 ? null : Math.min(...moments);
}

/** What the tiles know about the time they cover. */
interface Span {
  timeZone: string;
  period: AnalyticsPeriod;
  current: TimeWindow;
  before: TimeWindow;
  /** The first days of the last 8 weeks (Sundays), or of the last 14 days, oldest first. */
  buckets: string[];
  /** The first moment anything was recorded; `null` when nothing was. */
  start: number | null;
}

/** Whether any data could exist in a window: it ends after the data began. */
function windowHasData(span: Span, window: TimeWindow): boolean {
  return span.start !== null && span.start < window.upTo;
}

/** Whether any data could exist in the week (or day) that starts on `bucketStart`: it ends after the data began. */
function bucketHasData(span: Span, bucketStart: string): boolean {
  return (
    span.start !== null &&
    bucketLastDay(bucketStart, span.period) >= localDayOf(span.start, span.timeZone)
  );
}

/** The events by the week (or day) they fall in: element `i` is the events of `span.buckets[i]`. */
function bucketed<E extends { at: number }>(span: Span, events: readonly E[]): E[][] {
  const byBucket: E[][] = span.buckets.map(() => []);
  for (const event of events) {
    byBucket[bucketIndexOf(event.at, span.timeZone, span.period, span.buckets)]?.push(event);
  }
  return byBucket;
}

/**
 * A tile built from events (finished jobs or approvals) that each have a moment: `measure` turns
 * the events of a window, or of a week (or day), into the tile's number. Where no data could exist the
 * number is `null` without asking `measure`.
 */
function eventTile<E extends { at: number }>(
  def: (typeof ANALYTICS_TILES)[number],
  span: Span,
  events: readonly E[],
  measure: (events: readonly E[]) => number | null,
): AnalyticsTile {
  const over = (window: TimeWindow) =>
    windowHasData(span, window)
      ? measure(events.filter((event) => inWindow(event.at, window)))
      : null;
  const byBucket = bucketed(span, events);
  return {
    key: def.key,
    unit: def.unit,
    value: over(span.current),
    previous: over(span.before),
    numerator: null,
    denominator: null,
    previousNumerator: null,
    previousDenominator: null,
    series: span.buckets.map((start, i) =>
      bucketHasData(span, start) ? measure(byBucket[i] ?? []) : null,
    ),
  };
}

/**
 * The Clients tile: the clients with a job finished in the window, each once. Its sparkline has a
 * value for each of the last days (`tileSeriesLength`), today last: the clients over the window
 * that ends at the end of that day (today's ends now, so it is the tile's number). A day whose
 * window ends before the data began is `null`.
 */
function clientsTile(
  def: (typeof ANALYTICS_TILES)[number],
  span: Span,
  finished: readonly Finished[],
): AnalyticsTile {
  const clients = (window: TimeWindow) =>
    windowHasData(span, window)
      ? new Set(finished.filter((job) => inWindow(job.at, window)).map((job) => job.clientId)).size
      : null;
  const now = span.current.upTo;
  const windowMs = windowDaysOf(span.period) * DAY_MS;
  const days = bucketStartsEnding(
    now,
    span.timeZone,
    'week',
    tileSeriesLength(def.key, span.period),
  );
  return {
    key: def.key,
    unit: def.unit,
    value: clients(span.current),
    previous: clients(span.before),
    numerator: null,
    denominator: null,
    previousNumerator: null,
    previousDenominator: null,
    series: days.map((day) => {
      const upTo = Math.min(startOfLocalDay(addDays(day, 1), span.timeZone), now);
      return clients({ after: upTo - windowMs, upTo });
    }),
  };
}

/** The "x of y" tile: approvals that came first time, of all the approvals. */
function ratioTile(
  def: (typeof ANALYTICS_TILES)[number],
  span: Span,
  approved: readonly Approval[],
): AnalyticsTile {
  const counts = (events: readonly Approval[]) => ({
    firstTime: events.filter((event) => event.firstTime).length,
    all: events.length,
  });
  const share = ({ firstTime, all }: { firstTime: number; all: number }) =>
    all === 0 ? null : firstTime / all;
  const over = (window: TimeWindow) =>
    counts(
      windowHasData(span, window) ? approved.filter((event) => inWindow(event.at, window)) : [],
    );
  const current = over(span.current);
  const before = over(span.before);
  const byBucket = bucketed(span, approved);
  return {
    key: def.key,
    unit: def.unit,
    value: share(current),
    previous: share(before),
    numerator: current.firstTime,
    denominator: current.all,
    previousNumerator: before.firstTime,
    previousDenominator: before.all,
    series: span.buckets.map((start, i) =>
      bucketHasData(span, start) ? share(counts(byBucket[i] ?? [])) : null,
    ),
  };
}

function tiles(span: Span, input: ComputeAnalyticsInput): AnalyticsTile[] {
  const finished = finishedJobs(input.jobs, runsByJob(input.stepRuns), input.now);
  const approved = approvals(input.jobs, input.now);
  const seconds = (pick: (job: Finished) => number | null) => (events: readonly Finished[]) =>
    median(events.flatMap((job) => pick(job) ?? []));
  const measures = {
    'jobs-finished': (events: readonly Finished[]) => events.length,
    'files-in-ready': seconds((job) => job.readySec),
    'editing-time': seconds((job) => job.editingSec),
  } as const;
  return ANALYTICS_TILES.map((def) =>
    def.key === 'approved-first-time'
      ? ratioTile(def, span, approved)
      : def.key === 'clients'
        ? clientsTile(def, span, finished)
        : eventTile(def, span, finished, measures[def.key]),
  );
}

/**
 * Jobs marked delivered on each local day of the calendar. A day that has not come yet, and one
 * before the data began, is `null`.
 */
function deliveredPerDay(
  span: Span,
  input: ComputeAnalyticsInput,
): AnalyticsJobs['deliveredPerDay'] {
  const counts = new Map<string, number>();
  for (const delivery of input.deliveries) {
    if (delivery.deliveredAt > input.now) continue;
    const day = localDayOf(delivery.deliveredAt, span.timeZone);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const firstDay = span.start === null ? null : localDayOf(span.start, span.timeZone);
  return calendarDays(input.now, span.timeZone, ANALYTICS_CALENDAR_WEEKS).map(
    ({ date, future }) => ({
      date,
      count: future || firstDay === null || date < firstDay ? null : (counts.get(date) ?? 0),
    }),
  );
}

/**
 * The step-7 (Check) end of each job's first edit run, which is when the editor got through the
 * footage: the latest end of a Check step of round 0 (a retried Check counts once, at its last end).
 */
function checkEnds(stepRuns: readonly AnalyticsStepRun[], now: number): Map<string, number> {
  const ends = new Map<string, number>();
  for (const run of stepRuns) {
    if (run.step !== CHECK_STEP || run.runKind !== 'edit' || run.round !== 0) continue;
    const end = msOf(run.endedAt);
    if (end === null || end > now) continue;
    ends.set(run.jobId, Math.max(ends.get(run.jobId) ?? end, end));
  }
  return ends;
}

/**
 * Hours of footage per week (per day in the week period): the footage of each job, in the week (or
 * day) its first edit got past Check. A bucket before the data began is `null`; a quiet one after
 * that is 0.
 */
function footage(span: Span, input: ComputeAnalyticsInput): AnalyticsJobs['footage'] {
  const starts = bucketStartsEnding(
    input.now,
    span.timeZone,
    span.period,
    ANALYTICS_SIZES[span.period].footage,
  );
  const footageSec = starts.map(() => 0);
  const footageOf = new Map(input.jobs.map((job) => [job.id, job.footageSec]));
  for (const [jobId, end] of checkEnds(input.stepRuns, input.now)) {
    const bucket = bucketIndexOf(end, span.timeZone, span.period, starts);
    const seconds = footageOf.get(jobId);
    if (bucket >= 0 && seconds !== undefined && Number.isFinite(seconds)) {
      footageSec[bucket] = (footageSec[bucket] ?? 0) + Math.max(0, seconds);
    }
  }
  return starts.map((start, i) => ({
    start,
    hours: bucketHasData(span, start) ? (footageSec[i] ?? 0) / 3600 : null,
  }));
}

export function computeJobsSection(input: ComputeAnalyticsInput): AnalyticsJobs {
  const period = inputPeriod(input);
  const { current, before } = trailingWindows(input.now, windowDaysOf(period));
  const span: Span = {
    timeZone: input.timeZone,
    period,
    current,
    before,
    buckets: bucketStartsEnding(input.now, input.timeZone, period, ANALYTICS_SIZES[period].tile),
    start: dataStart(input),
  };
  return {
    tiles: tiles(span, input),
    deliveredPerDay: deliveredPerDay(span, input),
    footage: footage(span, input),
  };
}
