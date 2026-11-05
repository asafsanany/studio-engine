import type {
  AnalyticsCredits,
  AnalyticsPlan,
  AnalyticsSpendList,
  AnalyticsSpendRow,
  LimitSnapshot,
} from './analytics.ts';
import type { ComputeAnalyticsInput } from './analytics-compute.ts';
import {
  addDays,
  DAY_MS,
  daysBetween,
  localDayOf,
  msOf,
  startOfLocalDay,
} from './analytics-time.ts';
import { apiValueUsd } from './api-prices.ts';
import { APP_USAGE_TAGS, SESSION_USAGE_TAGS, type UsageEntry } from './usage.ts';

// The two budgets of "Claude use" (Analytics plan, the budgets redesign).
//
//   API credits: $200 a month. Every run the app starts bills to the Anthropic API since
//   `API_CREDITS_START`, so the app's usage lines (`source: 'app'`) priced at the API list prices
//   (api-prices.ts) are real dollars spent. The credit month is the calendar month and resets on
//   the 1st; in the month of the switch only lines from the switch day on are counted.
//
//   Max plan: $200 a month. It covers the owner's Claude Code sessions (`source: 'session'`). Its level
//   is the plan's own weekly limit and five-hour limit, read from limits.jsonl; the sessions' API
//   value is what that use would have cost at the API.
//
// Both pages' lists are ranked by spend, biggest first, and rows under `FOLD_BELOW_SHARE` of the
// total are folded away, so what is dramatic shows first.

/** The month's API credits in dollars. */
export let API_CREDITS_MONTHLY_USD = 200;

/** The day the app's runs started billing to the API key; earlier app lines were on the plan. */
export const API_CREDITS_START = '2026-10-23';

/** What a first pass (the first edit of a job) costs on average: "13 more first passes at $11.50". */
export const FIRST_PASS_USD = 11.5;

/** The Max plan's price a month, and a week of it (twelve months over 52 weeks). */
export let PLAN_MONTHLY_USD = 200;
export let PLAN_WEEKLY_USD = (PLAN_MONTHLY_USD * 12) / 52;

/** The budgets from config.json (`apiCreditsMonthlyUsd`, `planMonthlyUsd`), set once at boot. */
export function setClaudeBudgets(budgets: {
  apiCreditsMonthlyUsd?: number | undefined;
  planMonthlyUsd?: number | undefined;
}): void {
  if (budgets.apiCreditsMonthlyUsd !== undefined) {
    API_CREDITS_MONTHLY_USD = budgets.apiCreditsMonthlyUsd;
  }
  if (budgets.planMonthlyUsd !== undefined) {
    PLAN_MONTHLY_USD = budgets.planMonthlyUsd;
    PLAN_WEEKLY_USD = (PLAN_MONTHLY_USD * 12) / 52;
  }
}

/** A row under this share of its list's total is folded into "N smaller tags". */
export const FOLD_BELOW_SHARE = 0.03;

/** How many jobs "what the API credits paid for" lists. */
export const TOP_JOBS = 5;

const WEEK_MS = 7 * DAY_MS;

/** A thing a list is made of, before it is ranked. */
interface SpendItem {
  label: string;
  usd: number;
  runs: number;
}

/**
 * Ranks items by spend, biggest first (a tie by name), with each one's share of the total. Rows
 * under `foldBelow` of the total go to `folded`; `top` keeps only the biggest rows and drops the
 * rest. `limitUse` (the plan's weekly use, 0 to 1) gives each row its slice of the limit: its share
 * times that use. `budgetUsd` (the month's credits) gives it its slice of the credits instead: its
 * spend over that.
 */
export function spendList(
  items: readonly SpendItem[],
  options: {
    foldBelow?: number;
    top?: number;
    limitUse?: number | null;
    budgetUsd?: number;
  } = {},
): AnalyticsSpendList {
  const { foldBelow = FOLD_BELOW_SHARE, top, limitUse = null, budgetUsd } = options;
  const totalUsd = items.reduce((sum, item) => sum + item.usd, 0);
  const ranked: AnalyticsSpendRow[] = [...items]
    .sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label))
    .map((item) => {
      const share = totalUsd > 0 ? item.usd / totalUsd : 0;
      return {
        label: item.label,
        usd: item.usd,
        share,
        runs: item.runs,
        limitShare:
          budgetUsd !== undefined
            ? item.usd / budgetUsd
            : limitUse === null
              ? null
              : share * limitUse,
      };
    });
  const kept = top === undefined ? ranked : ranked.slice(0, top);
  // With nothing spent every row is 0%: they are all "nothing yet", all folded.
  const rows = kept.filter((row) => totalUsd > 0 && row.share >= foldBelow);
  const folded = kept.filter((row) => !rows.includes(row));
  return {
    totalUsd,
    rows,
    folded,
    foldedShare: folded.reduce((sum, row) => sum + row.share, 0),
  };
}

/** Every tag of `tags` as an item, with the use and the lines of `entries` (a tag unused is a 0). */
function tagItems(tags: readonly string[], entries: readonly UsageEntry[]): SpendItem[] {
  const byTag = new Map<string, SpendItem>(
    tags.map((tag) => [tag, { label: tag, usd: 0, runs: 0 }]),
  );
  for (const entry of entries) {
    const item = byTag.get(entry.tag);
    if (item === undefined) continue;
    item.usd += apiValueUsd(entry.usage);
    item.runs += 1;
  }
  return [...byTag.values()];
}

/** The jobs of `entries` as items: the client and the job's name, with their spend and runs. */
function jobItems(entries: readonly UsageEntry[]): SpendItem[] {
  const byJob = new Map<string, SpendItem>();
  for (const entry of entries) {
    if (entry.job === undefined) continue;
    const label =
      entry.client === undefined ? entry.job.name : `${entry.client} · ${entry.job.name}`;
    const item = byJob.get(entry.job.id) ?? { label, usd: 0, runs: 0 };
    item.usd += apiValueUsd(entry.usage);
    item.runs += 1;
    byJob.set(entry.job.id, item);
  }
  return [...byJob.values()];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The calendar month `today` is in: its first and last day, and how many days it has. */
function monthOf(today: string): { start: string; end: string; days: number; next: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${today.slice(0, 8)}${pad2(days)}`;
  return { start: `${today.slice(0, 8)}01`, end, days, next: addDays(end, 1) };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The API credits: the app's runs this calendar month (from `API_CREDITS_START` in the month of
 * the switch), against the $200. The pace is the spend per day since the count started (a day is
 * the least that is counted, so the first morning does not project the whole month from an hour);
 * at that pace the credits run out on `runOutDay`, or last the month.
 */
export function computeCredits(input: ComputeAnalyticsInput): AnalyticsCredits {
  const { now, timeZone } = input;
  const today = localDayOf(now, timeZone);
  const month = monthOf(today);
  const since = month.start < API_CREDITS_START ? API_CREDITS_START : month.start;
  const monthStartMs = startOfLocalDay(month.start, timeZone);
  const monthEndMs = startOfLocalDay(month.next, timeZone);
  const sinceMs = startOfLocalDay(since, timeZone);

  const entries = input.usage.filter((entry) => {
    const at = msOf(entry.at);
    return entry.source === 'app' && at !== null && at >= sinceMs && at < monthEndMs;
  });
  const spentUsd = entries.reduce((sum, entry) => sum + apiValueUsd(entry.usage), 0);
  const leftUsd = Math.max(0, API_CREDITS_MONTHLY_USD - spentUsd);

  const elapsedDays = Math.max(1, (now - sinceMs) / DAY_MS);
  const perDayUsd = spentUsd > 0 ? spentUsd / elapsedDays : null;
  let runOutDay: string | null = null;
  if (perDayUsd !== null && leftUsd > 0) {
    const runOutMs = now + (leftUsd / perDayUsd) * DAY_MS;
    const day = runOutMs < monthEndMs ? localDayOf(runOutMs, timeZone) : null;
    // Running out on the month's last day is the month: it lasts.
    if (day !== null && day < month.end) runOutDay = day;
  }
  const status: AnalyticsCredits['status'] =
    spentUsd >= API_CREDITS_MONTHLY_USD
      ? 'used-up'
      : spentUsd <= 0
        ? 'idle'
        : runOutDay !== null
          ? 'spending-fast'
          : 'on-pace';

  // Spend added up through the month: flat from the start of the count, a step at the end of each
  // day that spent something, and now.
  const nowX = (now - monthStartMs) / DAY_MS;
  const sinceX = daysBetween(month.start, since);
  const spentOn = new Map<string, number>();
  for (const entry of entries) {
    const at = msOf(entry.at) ?? now;
    const day = localDayOf(at, timeZone);
    spentOn.set(day, (spentOn.get(day) ?? 0) + apiValueUsd(entry.usage));
  }
  const series: AnalyticsCredits['series'] = [{ x: sinceX, usd: 0 }];
  let running = 0;
  for (let day = since; day <= today; day = addDays(day, 1)) {
    running += spentOn.get(day) ?? 0;
    const x = day === today ? nowX : daysBetween(month.start, day) + 1;
    series.push({ x: Math.max(x, sinceX), usd: running });
  }

  return {
    budgetUsd: API_CREDITS_MONTHLY_USD,
    monthStart: month.start,
    monthEnd: month.end,
    monthDays: month.days,
    since,
    spentUsd,
    usedShare: spentUsd / API_CREDITS_MONTHLY_USD,
    leftUsd,
    firstPasses: Math.round(leftUsd / FIRST_PASS_USD),
    firstPassUsd: FIRST_PASS_USD,
    monthShare: clamp01((now - monthStartMs) / (monthEndMs - monthStartMs)),
    perDayUsd,
    runOutDay,
    runOutDaysBeforeEnd: runOutDay === null ? null : daysBetween(runOutDay, month.end),
    status,
    // Each row's slice of the budget is its spend over the credits.
    tags: spendList(tagItems(APP_USAGE_TAGS, entries), { budgetUsd: API_CREDITS_MONTHLY_USD }),
    jobs: spendList(jobItems(entries), {
      foldBelow: 0,
      top: TOP_JOBS,
      budgetUsd: API_CREDITS_MONTHLY_USD,
    }),
    series,
    nowX,
  };
}

/** The newest of some readings (by the time it was read), or `null`. */
function newest(readings: readonly LimitSnapshot[]): LimitSnapshot | null {
  let best: LimitSnapshot | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const reading of readings) {
    const at = msOf(reading.at);
    if (at !== null && at >= bestAt) {
      best = reading;
      bestAt = at;
    }
  }
  return best;
}

/**
 * The Max plan this week. The weekly window is the newest reading's, while its reset is still to
 * come; the sessions' API value in it ("covered this week") and each session tag's slice of the
 * limit come from the usage lines logged in the window. Without an open window (no reading yet, or
 * the newest one's week is over) the last 7 days stand in and no slice of the limit is claimed.
 */
export function computePlan(input: ComputeAnalyticsInput): AnalyticsPlan {
  const { now, limits } = input;
  const open = (reading: LimitSnapshot, window: 'sevenDay' | 'fiveHour') => {
    const resets = msOf(reading[window]?.resetsAt);
    return resets !== null && resets > now;
  };
  const weekly = newest(limits.filter((reading) => open(reading, 'sevenDay')));
  const fiveHourReading = newest(limits.filter((reading) => open(reading, 'fiveHour')));
  const latest = newest(limits);

  const week = weekly?.sevenDay ?? null;
  const resetsMs = msOf(week?.resetsAt);
  const windowStart = resetsMs === null ? now - WEEK_MS : resetsMs - WEEK_MS;
  const entries = input.usage.filter((entry) => {
    const at = msOf(entry.at);
    return entry.source === 'session' && at !== null && at > windowStart && at <= now;
  });
  const coveredUsd = entries.reduce((sum, entry) => sum + apiValueUsd(entry.usage), 0);

  return {
    monthlyUsd: PLAN_MONTHLY_USD,
    weeklyUsd: PLAN_WEEKLY_USD,
    lastReadingAt: latest?.at ?? null,
    week:
      week === null
        ? null
        : {
            utilization: week.utilization,
            resetsAt: week.resetsAt,
            weekShare: clamp01((now - windowStart) / WEEK_MS),
          },
    fiveHour: fiveHourReading?.fiveHour ?? null,
    status: weekly?.status ?? latest?.status ?? null,
    coveredUsd,
    tags: spendList(tagItems(SESSION_USAGE_TAGS, entries), { limitUse: week?.utilization ?? null }),
    series: planMonthSeries(limits, now, input.timeZone),
  };
}

/**
 * The weekly limit's use through the calendar month `now` is in: one run of points per weekly
 * window (named by its reset), each the last reading of a local day, and a 0 at the window's start
 * when that is inside the month. The runs are oldest first. A reading without the weekly window
 * says nothing about it.
 */
export function planMonthSeries(
  limits: readonly LimitSnapshot[],
  now: number,
  timeZone: string,
): AnalyticsPlan['series'] {
  const month = monthOf(localDayOf(now, timeZone));
  const monthStartMs = startOfLocalDay(month.start, timeZone);
  const windows = new Map<string, Map<string, { at: number; use: number }>>();
  for (const reading of limits) {
    const at = msOf(reading.at);
    if (reading.sevenDay === null || at === null || at < monthStartMs || at > now) continue;
    const days = windows.get(reading.sevenDay.resetsAt) ?? new Map();
    const day = localDayOf(at, timeZone);
    if ((days.get(day)?.at ?? Number.NEGATIVE_INFINITY) <= at) {
      days.set(day, { at, use: reading.sevenDay.utilization });
    }
    windows.set(reading.sevenDay.resetsAt, days);
  }
  const x = (ms: number) => (ms - monthStartMs) / DAY_MS;
  return [...windows.entries()]
    .sort(([a], [b]) => (msOf(a) ?? 0) - (msOf(b) ?? 0))
    .map(([resetsAt, days]) => {
      const points = [...days.values()].sort((a, b) => a.at - b.at);
      const startMs = (msOf(resetsAt) ?? 0) - WEEK_MS;
      const first = points[0];
      const fromZero =
        first !== undefined && startMs >= monthStartMs && startMs < first.at
          ? [{ x: x(startMs), use: 0 }]
          : [];
      return [...fromZero, ...points.map((point) => ({ x: x(point.at), use: point.use }))];
    });
}

/**
 * Dollars the app's own runs spent on each local day, since the app moved to the API key: what
 * "Busiest week" and "Busiest day" count against the month's credits.
 */
export function appSpendByDay(input: ComputeAnalyticsInput): Map<string, number> {
  const { timeZone } = input;
  const sinceMs = startOfLocalDay(API_CREDITS_START, timeZone);
  const spent = new Map<string, number>();
  for (const entry of input.usage) {
    const at = msOf(entry.at);
    if (entry.source !== 'app' || at === null || at < sinceMs) continue;
    const day = localDayOf(at, timeZone);
    spent.set(day, (spent.get(day) ?? 0) + apiValueUsd(entry.usage));
  }
  return spent;
}
