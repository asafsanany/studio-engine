import {
  ANALYTICS_SIZES,
  type AnalyticsClaudeUse,
  type AnalyticsLimitBucket,
  type AnalyticsPeriod,
  type LimitSnapshot,
} from './analytics.ts';
import {
  API_CREDITS_MONTHLY_USD,
  API_CREDITS_START,
  appSpendByDay,
  computeCredits,
  computePlan,
} from './analytics-budgets.ts';
import type { ComputeAnalyticsInput } from './analytics-compute.ts';
import { finishedAtOf } from './analytics-finished.ts';
import {
  addDays,
  bucketIndexOf,
  bucketStartsEnding,
  DAY_MS,
  inputPeriod,
  localDayOf,
  msOf,
} from './analytics-time.ts';
import { apiValueUsd } from './api-prices.ts';
import { USAGE_TAG_INFO } from './usage.ts';

// Section "Claude use" of the Analytics page: the two budgets (analytics-budgets.ts: the API
// credits and the Max plan, each with what used it), Busiest week (AN5, from the limits log, with
// what the app spent in the same weeks) and API cost per finished minute (AN6, from the usage log;
// no card draws it any more). In the week period the last two are by day: Busiest day, API cost per
// finished minute per day.

export function computeClaudeUseSection(input: ComputeAnalyticsInput): AnalyticsClaudeUse {
  return {
    busiest: computeBusiest(
      input.limits,
      input.now,
      input.timeZone,
      inputPeriod(input),
      appSpendByDay(input),
    ),
    apiValuePerFinishedMinute: apiValuePerFinishedMinute(input),
    credits: computeCredits(input),
    plan: computePlan(input),
  };
}

// --- API cost per finished minute (AN6) ---------------------------------------------------------
//
// It reads usage.jsonl and puts a usage line in the week (or, in the week period, the day) it was
// logged in (its `at`, the end of the window it owns): a line has no finer time than that. Its
// cost is its tokens at the API list price of each model (api-prices.ts). A week with no usage
// line is a gap, not a zero: app runs only log usage since v0.13.10, so older weeks have none.

type ApiValueBuckets = AnalyticsClaudeUse['apiValuePerFinishedMinute'];

/** The bucket (an index into `starts`) a usage line was logged in, or -1 for none of them. */
function usageBucketIndex(
  at: string,
  timeZone: string,
  period: AnalyticsPeriod,
  starts: readonly string[],
): number {
  const ms = msOf(at);
  return ms === null ? -1 : bucketIndexOf(ms, timeZone, period, starts);
}

/**
 * API cost per finished minute, the last 12 weeks (week period: the last 14 days): the API value
 * of the bucket's Client work usage lines (the tags `edit` to `transcribe`) divided by the minutes
 * of video finished in it, the `output.durationSec` of the finished jobs (analytics-finished.ts)
 * whose `finishedAt` falls in the bucket. `null` when the bucket has no Client work line, or no
 * finished video.
 */
export function apiValuePerFinishedMinute(input: ComputeAnalyticsInput): ApiValueBuckets {
  const { now, timeZone, jobs, usage } = input;
  const period = inputPeriod(input);
  const starts = bucketStartsEnding(now, timeZone, period, ANALYTICS_SIZES[period].value);

  const clientUsd: (number | null)[] = starts.map(() => null);
  for (const entry of usage) {
    if (USAGE_TAG_INFO[entry.tag].group !== 'Client work') continue;
    const bucket = usageBucketIndex(entry.at, timeZone, period, starts);
    if (bucket >= 0) clientUsd[bucket] = (clientUsd[bucket] ?? 0) + apiValueUsd(entry.usage);
  }

  const finishedSec = starts.map(() => 0);
  for (const job of jobs) {
    // The same finished-job rule as the Jobs tiles (analytics-finished.ts).
    const finishedAt = finishedAtOf(job);
    if (finishedAt === null || job.output === null) continue;
    const bucket = bucketIndexOf(finishedAt, timeZone, period, starts);
    if (bucket >= 0) finishedSec[bucket] = (finishedSec[bucket] ?? 0) + job.output.durationSec;
  }

  return starts.map((start, i) => {
    const usd = clientUsd[i] ?? null;
    const minutes = (finishedSec[i] ?? 0) / 60;
    return { start, usdPerMinute: usd === null || minutes <= 0 ? null : usd / minutes };
  });
}

// --- Busiest week, Busiest day ------------------------------------------------------------------

const WEEK_MS = 7 * DAY_MS;

/** The statuses that are not a limit hit: Claude's own `allowed`, and its `allowed_warning` (nearing it). */
const NOT_A_HIT = new Set(['allowed', 'allowed_warning']);

/**
 * Whether a reading says the limit was hit: Claude said no, or the use of `window` (the weekly
 * window; the five-hour window for a day) reached 100%.
 */
function hitTheLimit(reading: LimitSnapshot, window: 'sevenDay' | 'fiveHour'): boolean {
  return !NOT_A_HIT.has(reading.status) || (reading[window]?.utilization ?? 0) >= 1;
}

/** Dollars the app's runs spent on each local day (`appSpendByDay`). */
type DailySpend = ReadonlyMap<string, number>;

/**
 * What the app spent from `first` to `last` (local days, both counted) as a share of the month's
 * credits; `null` when that span ended before the app moved to the API key.
 */
function apiShareOf(spend: DailySpend, first: string, last: string): number | null {
  if (last < API_CREDITS_START) return null;
  let usd = 0;
  for (let day = first; day <= last; day = addDays(day, 1)) usd += spend.get(day) ?? 0;
  return usd / API_CREDITS_MONTHLY_USD;
}

/**
 * The last 8 weekly limit windows, oldest first, for "Busiest week". A reading belongs to the
 * window its weekly limit resets at (`sevenDay.resetsAt`); a reading without the weekly window
 * says nothing about a week. The newest window ends at the newest reset seen (now, when none has
 * been; the next week's, when that reset is already past), each earlier one 7 days before the next.
 * A window's `peak` is the highest weekly use read in it, `null` with no reading, and `hitLimit`
 * when a reading in it hit the limit; its `apiShare` is what the app spent in its 7 days.
 */
export function computeBusiestWeeks(
  limits: readonly LimitSnapshot[],
  now: number,
  timeZone: string,
  spend: DailySpend = new Map(),
): AnalyticsLimitBucket[] {
  const resets = limits.flatMap((reading) => {
    const reset = msOf(reading.sevenDay?.resetsAt);
    return reset === null ? [] : [reset];
  });
  let newestEnd = resets.length > 0 ? Math.max(...resets) : now;
  if (newestEnd < now) newestEnd += (Math.floor((now - newestEnd) / WEEK_MS) + 1) * WEEK_MS;

  const count = ANALYTICS_SIZES.month.limit;
  const newest = count - 1;
  const weeks: AnalyticsLimitBucket[] = Array.from({ length: count }, (_, i) => {
    // The day the window started on: 7 days before it ends.
    const start = localDayOf(newestEnd - WEEK_MS * (newest - i + 1), timeZone);
    return {
      start,
      peak: null,
      hitLimit: false,
      current: i === newest,
      apiShare: apiShareOf(spend, start, addDays(start, 6)),
    };
  });
  for (const reading of limits) {
    const reset = msOf(reading.sevenDay?.resetsAt);
    if (reading.sevenDay === null || reset === null) continue;
    // Window 0 of this count is the newest: (end - 7 days, end].
    const week = weeks[newest - Math.floor((newestEnd - reset) / WEEK_MS)];
    if (week === undefined) continue;
    week.peak = Math.max(week.peak ?? 0, reading.sevenDay.utilization);
    if (hitTheLimit(reading, 'sevenDay')) week.hitLimit = true;
  }
  return weeks;
}

/**
 * The last 14 days, oldest first, for "Busiest day": a reading belongs to the local day it was
 * taken on, and says nothing about a day when it does not carry the five-hour window. A day's
 * `peak` is the highest five-hour use read on it, `null` with no reading, and `hitLimit` when a
 * reading on it hit the limit (Claude said no, or the five-hour use reached 100%), and its
 * `apiShare` is what the app spent that day. Today is the open one.
 */
export function computeBusiestDays(
  limits: readonly LimitSnapshot[],
  now: number,
  timeZone: string,
  spend: DailySpend = new Map(),
): AnalyticsLimitBucket[] {
  const days = bucketStartsEnding(now, timeZone, 'week', ANALYTICS_SIZES.week.limit);
  const bars: AnalyticsLimitBucket[] = days.map((start, i) => ({
    start,
    peak: null,
    hitLimit: false,
    current: i === days.length - 1,
    apiShare: apiShareOf(spend, start, start),
  }));
  for (const reading of limits) {
    const at = msOf(reading.at);
    if (reading.fiveHour === null || at === null) continue;
    const bar = bars[bucketIndexOf(at, timeZone, 'week', days)];
    if (bar === undefined) continue;
    bar.peak = Math.max(bar.peak ?? 0, reading.fiveHour.utilization);
    if (hitTheLimit(reading, 'fiveHour')) bar.hitLimit = true;
  }
  return bars;
}

/** The bars of "Busiest week" (month) or "Busiest day" (week). */
export function computeBusiest(
  limits: readonly LimitSnapshot[],
  now: number,
  timeZone: string,
  period: AnalyticsPeriod,
  spend: DailySpend = new Map(),
): AnalyticsLimitBucket[] {
  return period === 'week'
    ? computeBusiestDays(limits, now, timeZone, spend)
    : computeBusiestWeeks(limits, now, timeZone, spend);
}
