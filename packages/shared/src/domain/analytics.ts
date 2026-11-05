import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';
import { calendarDaySchema } from './money.ts';
import { SERVICE_COSTS } from './services.ts';
import { STEPS } from './steps.ts';

// The Analytics page's numbers (Analytics plan, "Data and definitions"): `GET /api/analytics`
// answers one `AnalyticsResponse` with the four sections the page shows, Jobs, A typical job,
// Reviews and Claude use. This module is the shape of that answer (the zod schema) and the fixed
// lists it is built from; `analytics-compute.ts` fills it in from the engine's data.
//
// The shape is the contract that every later card fills, so it is complete from the start: a card
// changes its own numbers, never the shape.
//
// - The answer is for one period (`period`): `month` compares the last 30 days with the 30 before
//   and draws its charts by calendar week; `week` compares the last 7 days with the 7 before and
//   draws them by day. A series point is a bucket, a week or a day, named by its first day, `start`
//   (YYYY-MM-DD).
// - Time is local time in the engine's time zone (`timeZone`, the same one the Money page uses).
//   Calendar weeks start on Sunday; a week is named by its Sunday.
// - Series run oldest first, and always have the same length for the period (`ANALYTICS_SIZES`),
//   so the page draws a gap where a value is missing instead of a shorter chart.
// - A value that is not there is `null`, never 0: the page shows it as a gap. A zero is a real
//   zero (no job finished that week).

// --- the period and the sizes ------------------------------------------------------------------

/** The two periods the page can be asked for: the default `month` is the page as it was. */
export const ANALYTICS_PERIODS = ['week', 'month'] as const;
export const analyticsPeriodSchema = z.enum(ANALYTICS_PERIODS);
export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>;
export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriod = 'month';

/** Whether `value` is one of the periods (`week` or `month`). */
export function isAnalyticsPeriod(value: unknown): value is AnalyticsPeriod {
  return analyticsPeriodSchema.safeParse(value).success;
}

/** How big a period is: the window of the tiles and how many points each series has. */
export interface AnalyticsSizes {
  /** Days in a tile's window: "last 30 days" against the 30 days before it (week: 7 against 7). */
  windowDays: number;
  /** Values in a tile's sparkline: 8 weeks (week: 14 days). */
  tile: number;
  /** Values in the Clients tile's sparkline, one a day: the last 60 days (week: 14). */
  clientDays: number;
  /** Points in `footage`: 12 weeks (week: 14 days). */
  footage: number;
  /** Points in `approvedFirstTime`: 12 weeks (week: 14 days). */
  approval: number;
  /** Points in `busiest`: 8 weekly windows (week: 14 days). */
  limit: number;
  /** Points in `apiValuePerFinishedMinute`: 12 weeks (week: 14 days). */
  value: number;
}

export const ANALYTICS_SIZES = {
  month: {
    windowDays: 30,
    tile: 8,
    clientDays: 60,
    footage: 12,
    approval: 12,
    limit: 8,
    value: 12,
  },
  week: {
    windowDays: 7,
    tile: 14,
    clientDays: 14,
    footage: 14,
    approval: 14,
    limit: 14,
    value: 14,
  },
} as const satisfies Record<AnalyticsPeriod, AnalyticsSizes>;

/** Weeks in the delivery calendar: 13 weeks of 7 days (the same in both periods). */
export const ANALYTICS_CALENDAR_WEEKS = 13;
/** Local days in `deliveredPerDay`: the {@link ANALYTICS_CALENDAR_WEEKS} weeks, Sunday to Saturday. */
export const ANALYTICS_DELIVERY_DAYS = ANALYTICS_CALENDAR_WEEKS * 7;

// --- Jobs --------------------------------------------------------------------------------------

/** What a tile's number is: a count of things, a time in seconds, or "x of y". */
export const ANALYTICS_TILE_UNITS = ['count', 'duration-sec', 'ratio'] as const;
export const analyticsTileUnitSchema = z.enum(ANALYTICS_TILE_UNITS);
export type AnalyticsTileUnit = z.infer<typeof analyticsTileUnitSchema>;

/** The five tiles of the top row, left to right, and the unit each one counts in. */
export const ANALYTICS_TILES = [
  { key: 'jobs-finished', unit: 'count' },
  { key: 'clients', unit: 'count' },
  { key: 'files-in-ready', unit: 'duration-sec' },
  { key: 'editing-time', unit: 'duration-sec' },
  { key: 'approved-first-time', unit: 'ratio' },
] as const satisfies readonly { key: string; unit: AnalyticsTileUnit }[];

export type AnalyticsTileKey = (typeof ANALYTICS_TILES)[number]['key'];
export const analyticsTileKeySchema = z.enum(ANALYTICS_TILES.map((tile) => tile.key));

/** Whether a tile's sparkline has a value a day: in the week period every tile, in both the Clients tile. */
export function tileSeriesByDay(key: AnalyticsTileKey, period: AnalyticsPeriod): boolean {
  return period === 'week' || key === 'clients';
}

/** How many values a tile's sparkline has in a period (`ANALYTICS_SIZES`). */
export function tileSeriesLength(key: AnalyticsTileKey, period: AnalyticsPeriod): number {
  const size = ANALYTICS_SIZES[period];
  return key === 'clients' ? size.clientDays : size.tile;
}

const countOrNull = z.number().int().nonnegative().nullable();
const amountOrNull = z.number().nonnegative().nullable();

/**
 * One tile of the top row: the last 30 days against the 30 days before, and eight weekly values
 * for the sparkline. In the week period it is the last 7 days against the 7 before, and 14 daily
 * values.
 */
export const analyticsTileSchema = z.object({
  key: analyticsTileKeySchema,
  unit: analyticsTileUnitSchema,
  /**
   * The last 30 days (week period: 7): a count (`count`), seconds (`duration-sec`, a median) or a
   * share from 0 to 1 (`ratio`). `null` when there is nothing to say, e.g. no job finished.
   */
  value: amountOrNull,
  /** The same for the 30 days before (week period: the 7 before); `null` when there is nothing to compare with. */
  previous: amountOrNull,
  /** `ratio` only ("19 of 24"): the jobs approved first time in the window. `null` for other units. */
  numerator: countOrNull,
  /** `ratio` only: the jobs approved in the window, first time or not. `null` for other units. */
  denominator: countOrNull,
  /** `ratio` only ("was 14 of 21"): the numerator for the window before. `null` for other units. */
  previousNumerator: countOrNull,
  /** `ratio` only: the denominator for the window before. `null` for other units. */
  previousDenominator: countOrNull,
  /**
   * The sparkline: the tile's number for each of the last 8 calendar weeks (Sunday to Saturday),
   * oldest first, this week last (it is not over yet); in the week period for each of the last 14
   * days, today last. `null` for a bucket with nothing to say.
   *
   * The Clients tile instead has a value for each day (`tileSeriesLength`), today last: the
   * clients with a job finished in the window that ends that day (the 30 days up to it; week
   * period: the 7). Today's is the tile's number.
   */
  series: z.array(amountOrNull),
});
export type AnalyticsTile = z.infer<typeof analyticsTileSchema>;

/** One local day of the delivery calendar. */
export const analyticsDaySchema = z.object({
  date: calendarDaySchema,
  /** Jobs marked delivered that day; `null` for a day that has not come yet. */
  count: countOrNull,
});
export type AnalyticsDay = z.infer<typeof analyticsDaySchema>;

/** One point of the footage chart: a week, or a day in the week period. */
export const analyticsFootageBucketSchema = z.object({
  /** The week's Sunday (week period: the day). */
  start: calendarDaySchema,
  /** Hours of raw footage whose edit got past the Check step in that bucket (round 0); `null` for no data. */
  hours: amountOrNull,
});
export type AnalyticsFootageBucket = z.infer<typeof analyticsFootageBucketSchema>;

export const analyticsJobsSchema = z.object({
  /** The five tiles, in the order of {@link ANALYTICS_TILES}. */
  tiles: z.array(analyticsTileSchema).length(ANALYTICS_TILES.length),
  /**
   * Jobs delivered per local day, 91 days (13 calendar weeks) oldest first: the first is a Sunday
   * 12 weeks before this week's, the last is this week's Saturday (days after today are `null`).
   */
  deliveredPerDay: z.array(analyticsDaySchema).length(ANALYTICS_DELIVERY_DAYS),
  /**
   * Footage edited per week, the last 12 weeks, oldest first, this week last (week period: per
   * day, the last 14 days, today last).
   */
  footage: z.array(analyticsFootageBucketSchema),
});
export type AnalyticsJobs = z.infer<typeof analyticsJobsSchema>;

// --- A typical job -----------------------------------------------------------------------------

/**
 * Who a stretch of a typical job belongs to: `wait` the queue (the job waiting to start), `editor`
 * a step of the edit run, `you` the time before the owner approves (their review), `render` the final render.
 */
export const TYPICAL_JOB_KINDS = ['wait', 'editor', 'you', 'render'] as const;
export const typicalJobKindSchema = z.enum(TYPICAL_JOB_KINDS);
export type TypicalJobKind = z.infer<typeof typicalJobKindSchema>;

/** The edit run's steps 1 to 7 as stages (the render, step 8, is a stage of its own). */
const EDITOR_STAGES = STEPS.filter((step) => step.id <= 7).map((step) => ({
  key: step.label.toLowerCase(),
  label: step.label,
  kind: 'editor' as const,
}));

/**
 * The stretches a typical job is made of, in the order they happen. The answer always lists every
 * one, so a missing median is a gap and not a missing row.
 */
export const TYPICAL_JOB_STAGES = [
  { key: 'waiting-to-start', label: 'Waiting to start', kind: 'wait' },
  ...EDITOR_STAGES,
  { key: 'waiting-for-you', label: 'Waiting for you', kind: 'you' },
  { key: 'render', label: 'Render', kind: 'render' },
] as const satisfies readonly { key: string; label: string; kind: TypicalJobKind }[];

export type TypicalJobStageKey = (typeof TYPICAL_JOB_STAGES)[number]['key'];
export const typicalJobStageKeySchema = z.enum(TYPICAL_JOB_STAGES.map((stage) => stage.key));

/** The stage keys of the editor's steps (Brief to Check): where the slowest step is found. */
export const EDITOR_STAGE_KEYS = TYPICAL_JOB_STAGES.filter((stage) => stage.kind === 'editor').map(
  (stage) => stage.key,
);
export const editorStageKeySchema = z.enum(EDITOR_STAGE_KEYS);
export type EditorStageKey = z.infer<typeof editorStageKeySchema>;

export const analyticsStageSchema = z.object({
  key: typicalJobStageKeySchema,
  label: z.string().min(1),
  kind: typicalJobKindSchema,
  /** The median of this stretch over the jobs finished in the last 30 days (week period: 7), in seconds; `null` for no data. */
  medianSec: amountOrNull,
  /** The same over the 30 days before ("vs before"; week period: the 7 before); `null` for no data. */
  beforeSec: amountOrNull,
});
export type AnalyticsStage = z.infer<typeof analyticsStageSchema>;

export const analyticsTypicalJobSchema = z.object({
  /** Every stretch of {@link TYPICAL_JOB_STAGES}, in order. */
  stages: z.array(analyticsStageSchema).length(TYPICAL_JOB_STAGES.length),
  /** The editor's time on a typical job (the median of each job's edit and revise time), seconds. */
  editorSec: amountOrNull,
  /** The editor's time over the 30 days before. */
  editorBeforeSec: amountOrNull,
  /** The whole job, files in to ready (the median), seconds. */
  wholeSec: amountOrNull,
  /** The whole job over the 30 days before. */
  wholeBeforeSec: amountOrNull,
  /** The editor's slowest step (drawn in orange); `null` when no step has a median. */
  slowestStepKey: editorStageKeySchema.nullable(),
  /** The jobs finished in the last 30 days (week period: 7) that the medians are over. */
  jobsCounted: z.number().int().nonnegative(),
  /** The jobs finished in the 30 days before (week period: the 7 before) that the "before" medians are over. */
  jobsCountedBefore: z.number().int().nonnegative(),
});
export type AnalyticsTypicalJob = z.infer<typeof analyticsTypicalJobSchema>;

// --- Reviews -----------------------------------------------------------------------------------

/** One week of "Approved first time, by week" (week period: one day, "by day"). */
export const analyticsApprovalBucketSchema = z.object({
  /** The week's Sunday (week period: the day). */
  start: calendarDaySchema,
  /** `firstTime` over `approved`, from 0 to 1; `null` when no job was approved in that bucket. */
  share: z.number().min(0).max(1).nullable(),
  /** Jobs approved in that bucket with no notes sent (round 0). */
  firstTime: z.number().int().nonnegative(),
  /** Jobs approved in that bucket, first time or not. */
  approved: z.number().int().nonnegative(),
  /** The median number of re-runs (rounds of notes sent) of the jobs approved in that bucket; `null` when none. */
  medianReruns: z.number().nonnegative().nullable(),
});
export type AnalyticsApprovalBucket = z.infer<typeof analyticsApprovalBucketSchema>;

/** One topic of "What your notes are about" and who got it. */
export const analyticsNoteTopicSchema = z.object({
  /** A short English topic, e.g. "intro too long". */
  topic: z.string().min(1),
  /** Sent notes with this topic. */
  count: z.number().int().positive(),
  /** The clients whose jobs got these notes, most notes first. */
  clients: z.array(z.object({ client: z.string().min(1), count: z.number().int().positive() })),
});
export type AnalyticsNoteTopic = z.infer<typeof analyticsNoteTopicSchema>;

export const analyticsReviewsSchema = z.object({
  /** The last 12 weeks, oldest first, this week last (week period: the last 14 days, today last). */
  approvedFirstTime: z.array(analyticsApprovalBucketSchema),
  /** Topics, most notes first. */
  noteTopics: z.array(analyticsNoteTopicSchema),
  /** Sent notes that have no topic yet (the topic pass has not read them). */
  notGroupedYet: z.number().int().nonnegative(),
  /** The day the oldest sent note was sent ("Your review notes since September"); `null` with no notes. */
  notesSince: calendarDaySchema.nullable(),
});
export type AnalyticsReviews = z.infer<typeof analyticsReviewsSchema>;

// --- Claude use --------------------------------------------------------------------------------

/**
 * One bar of "Busiest week": a weekly limit window, or, in the week period, a day ("Busiest day")
 * with the highest use of the five-hour window read on it.
 */
export const analyticsLimitBucketSchema = z.object({
  /**
   * The local day the bar starts on. A weekly window starts 7 days before it ends: the newest
   * window ends at the latest known reset of the weekly limit (in the future while it is open; now
   * when no limit has been seen), and each earlier one ends 7 days before the next. A day is
   * itself.
   */
  start: calendarDaySchema,
  /**
   * The highest use of the weekly limit in the window (week period: of the five-hour window on the
   * day), from 0 to 1 (more when over); `null` for a bucket with no data.
   */
  peak: amountOrNull,
  /** The limit was hit in that bucket: Claude said no, or use reached 100%. Drawn in red. */
  hitLimit: z.boolean(),
  /** The bucket is still open (its bar is drawn lighter). */
  current: z.boolean(),
  /**
   * What the app's own runs spent in the bucket, as a share of the month's API credits (0.12 is
   * $24 of the $200); `null` for a bucket that ended before the app moved to the API key.
   */
  apiShare: amountOrNull,
});
export type AnalyticsLimitBucket = z.infer<typeof analyticsLimitBucketSchema>;

/** One week of "API value per finished minute" (week period: one day). */
export const analyticsValueBucketSchema = z.object({
  /** The week's Sunday (week period: the day). */
  start: calendarDaySchema,
  /**
   * Dollars of API value of that bucket's Client work usage per minute of video finished in it;
   * `null` when it has no usage logged or no finished video.
   */
  usdPerMinute: amountOrNull,
});
export type AnalyticsValueBucket = z.infer<typeof analyticsValueBucketSchema>;

// --- the two budgets ---------------------------------------------------------------------------
//
// Claude use is two budgets. The app's own runs bill to the Anthropic API ($200 of credits a
// month, spent in real dollars); the owner's Claude Code sessions run on the Max plan ($200 a month),
// whose level is the plan's weekly limit. `analytics-budgets.ts` works both out.

/** One row of a "what used it" list: a tag, or a job. */
export const analyticsSpendRowSchema = z.object({
  /** The tag (`revise`) or the job (`Client · Job name`). */
  label: z.string().min(1),
  /** Dollars: API credits spent (the app's runs), or API value (the sessions). */
  usd: z.number().nonnegative(),
  /** Its share of the list's total, 0 to 1. */
  share: z.number().min(0).max(1),
  /** How many usage lines (runs, or session logs) it is made of. */
  runs: z.number().int().nonnegative(),
  /**
   * Its slice of the budget, so the two lists read alike: the plan's list has the share of session
   * use times the use of the weekly limit (0.44 is "about 44% of the limit"), `null` without a
   * reading; the credits' lists have its spend over the month's credits (0.12 is $24 of the $200).
   */
  limitShare: z.number().nonnegative().nullable(),
});
export type AnalyticsSpendRow = z.infer<typeof analyticsSpendRowSchema>;

/**
 * A list ranked by spend, biggest first. Rows under `FOLD_BELOW_SHARE` of the total are `folded`
 * (the page hides them in a "N smaller tags" row), so the dramatic ones show first.
 */
export const analyticsSpendListSchema = z.object({
  totalUsd: z.number().nonnegative(),
  rows: z.array(analyticsSpendRowSchema),
  folded: z.array(analyticsSpendRowSchema),
  /** The folded rows' share of the total, 0 to 1. */
  foldedShare: z.number().min(0).max(1),
});
export type AnalyticsSpendList = z.infer<typeof analyticsSpendListSchema>;

/** Where the credits stand: `idle` nothing spent yet, `on-pace`, `spending-fast`, `used-up`. */
export const CREDITS_STATUSES = ['idle', 'on-pace', 'spending-fast', 'used-up'] as const;
export const creditsStatusSchema = z.enum(CREDITS_STATUSES);
export type CreditsStatus = z.infer<typeof creditsStatusSchema>;

const amount = z.number().nonnegative();

export const analyticsCreditsSchema = z.object({
  /** The month's credits in dollars. */
  budgetUsd: amount,
  /** The calendar month the credits are for: its first and last day. */
  monthStart: calendarDaySchema,
  monthEnd: calendarDaySchema,
  /** Days in the month. */
  monthDays: z.number().int().positive(),
  /** The day the count starts: the month's first day, or the day the app moved to the API key. */
  since: calendarDaySchema,
  /** The app's runs since `since`, in dollars. */
  spentUsd: amount,
  /** `spentUsd` over `budgetUsd` (more than 1 when over). */
  usedShare: amount,
  /** What is left, never below 0. */
  leftUsd: amount,
  /** How many first passes (an average first edit) the rest would pay for. */
  firstPasses: z.number().int().nonnegative(),
  firstPassUsd: z.number().positive(),
  /** How much of the month has passed, 0 to 1: the white tick on the gauge. */
  monthShare: z.number().min(0).max(1),
  /** Dollars a day since `since` (at least one day is counted); `null` when nothing is spent. */
  perDayUsd: amount.nullable(),
  /** The day the credits run out at this pace; `null` when they last the month (or nothing is spent). */
  runOutDay: calendarDaySchema.nullable(),
  /** Days between the run-out day and the end of the month; `null` with `runOutDay`. */
  runOutDaysBeforeEnd: z.number().int().nonnegative().nullable(),
  status: creditsStatusSchema,
  /** The app's tags, every one of them, ranked by spend. */
  tags: analyticsSpendListSchema,
  /** The jobs that cost the most, biggest first (a few, not all). */
  jobs: analyticsSpendListSchema,
  /**
   * Spend added up through the month: points `x` days from the start of the month (0 to
   * `monthDays`), from `since` to now. The last is now.
   */
  series: z.array(z.object({ x: z.number().nonnegative(), usd: amount })),
  /** Where now is on the month's axis, in days from its start. */
  nowX: z.number().nonnegative(),
});
export type AnalyticsCredits = z.infer<typeof analyticsCreditsSchema>;

/** One window of the plan: how much of it is used, and when it resets. */
export const analyticsPlanWindowSchema = z.object({
  utilization: z.number().nonnegative(),
  resetsAt: isoTimestampSchema,
});

export const analyticsPlanSchema = z.object({
  /** The plan's price a month, and a week of it. */
  monthlyUsd: amount,
  weeklyUsd: amount,
  /** When the newest reading was taken; `null` when there never was one. */
  lastReadingAt: isoTimestampSchema.nullable(),
  /**
   * The weekly window as the newest reading says it, still open: its use, its reset and how much
   * of the 7 days has passed (the white tick). `null` when no reading says so (none yet, or the
   * newest one's week is over); then the list below covers the last 7 days.
   */
  week: analyticsPlanWindowSchema.extend({ weekShare: z.number().min(0).max(1) }).nullable(),
  /** The five-hour window, when a reading has one that is still open. */
  fiveHour: analyticsPlanWindowSchema.nullable(),
  /** Claude's word for where use stands in the newest reading (`allowed` or a limit that was hit). */
  status: z.string().nullable(),
  /** The sessions' API value this week (the window above, else the last 7 days). */
  coveredUsd: amount,
  /** The session tags, every one of them, ranked by API value, each with its slice of the limit. */
  tags: analyticsSpendListSchema,
  /**
   * The weekly limit's use through the calendar month, for the chart of both budgets: one run of
   * points per weekly window (use starts again at 0 when a window resets), a point for each day
   * with a reading, `x` the days from the month's start. Empty with no reading this month.
   */
  series: z.array(
    z.array(z.object({ x: z.number().nonnegative(), use: z.number().nonnegative() })),
  ),
});
export type AnalyticsPlan = z.infer<typeof analyticsPlanSchema>;

export const analyticsClaudeUseSchema = z.object({
  /** The last 8 weekly windows, oldest first (week period: the last 14 days, today last). */
  busiest: z.array(analyticsLimitBucketSchema),
  /** The last 12 weeks, oldest first, this week last (week period: the last 14 days, today last). */
  apiValuePerFinishedMinute: z.array(analyticsValueBucketSchema),
  /** The $200 a month of API credits the app's own runs are paid from. */
  credits: analyticsCreditsSchema,
  /** The Max plan the Claude Code sessions run on, this week. */
  plan: analyticsPlanSchema,
});
export type AnalyticsClaudeUse = z.infer<typeof analyticsClaudeUseSchema>;

// --- services ----------------------------------------------------------------------------------

// The Services section: every API the engine talks to, paid or free (services.ts), with its plan
// from money.json, what it cost in the period and what it was used for. Worked out by
// `computeAnalyticsServices` (analytics-services.ts) and added to the answer by the server.

export const analyticsServicePlanSchema = z.object({
  name: z.string().min(1),
  /** "$6.00 a month", "₪899.90 a month", "$120.00 a year". */
  price: z.string().min(1),
});
export type AnalyticsServicePlan = z.infer<typeof analyticsServicePlanSchema>;

export const analyticsServiceRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** What the engine uses it for, in one line. */
  forWhat: z.string().min(1),
  cost: z.enum(SERVICE_COSTS),
  /** Its plans in money.json (none for a free one, or one paid by use only). */
  plans: z.array(analyticsServicePlanSchema),
  /** A paid service that is meant to have a plan in money.json and has none yet. */
  planMissing: z.boolean(),
  /** What it cost in the period, in shekels: renewals of its plans and the money its use took. `null` when free. */
  ils: z.number().nullable(),
  /** What it was used for in the period, in words; `null` when the use is not counted. */
  uses: z.string().min(1).nullable(),
  /** Paid only: what is not connected to the Money page yet. */
  gap: z.string().min(1).nullable(),
});
export type AnalyticsServiceRow = z.infer<typeof analyticsServiceRowSchema>;

export const analyticsServicesSchema = z.object({
  /** Every service of the registry, paid ones first, each group in the registry's order. */
  rows: z.array(analyticsServiceRowSchema),
  /** The subscriptions of money.json that are no service's plan (ChatGPT). */
  otherPlans: z.array(analyticsServicePlanSchema.extend({ ils: z.number() })),
  /** Everything paid in the period, in shekels: the services' and the other plans'. */
  totalIls: z.number(),
});
export type AnalyticsServices = z.infer<typeof analyticsServicesSchema>;

// --- the answer --------------------------------------------------------------------------------

type Path = (string | number)[];

/**
 * The series of an answer whose length does not fit its period (`ANALYTICS_SIZES`), each with the
 * path it is at. Nothing for an answer whose series all fit.
 */
function lengthIssues(answer: {
  period: AnalyticsPeriod;
  jobs: { tiles: { key: AnalyticsTileKey; series: unknown[] }[]; footage: unknown[] };
  reviews: { approvedFirstTime: unknown[] };
  claudeUse: {
    busiest: unknown[];
    apiValuePerFinishedMinute: unknown[];
  };
}): { path: Path; message: string }[] {
  const size = ANALYTICS_SIZES[answer.period];
  const issues: { path: Path; message: string }[] = [];
  const check = (path: Path, values: unknown[], length: number) => {
    if (values.length !== length) {
      issues.push({
        path,
        message: `Expected ${length} values for the ${answer.period} period, got ${values.length}`,
      });
    }
  };
  for (const [i, tile] of answer.jobs.tiles.entries()) {
    check(['jobs', 'tiles', i, 'series'], tile.series, tileSeriesLength(tile.key, answer.period));
  }
  check(['jobs', 'footage'], answer.jobs.footage, size.footage);
  check(['reviews', 'approvedFirstTime'], answer.reviews.approvedFirstTime, size.approval);
  check(['claudeUse', 'busiest'], answer.claudeUse.busiest, size.limit);
  check(
    ['claudeUse', 'apiValuePerFinishedMinute'],
    answer.claudeUse.apiValuePerFinishedMinute,
    size.value,
  );
  return issues;
}

/** `GET /api/analytics?period=week|month`: everything the Analytics page shows. */
export const analyticsResponseSchema = z
  .object({
    /** When the numbers were worked out. */
    generatedAt: isoTimestampSchema,
    /** The IANA time zone whose calendar the days and weeks are on. */
    timeZone: z.string().min(1),
    /** Which period the numbers are for: it decides the tiles' window and how long every series is. */
    period: analyticsPeriodSchema,
    jobs: analyticsJobsSchema,
    typicalJob: analyticsTypicalJobSchema,
    reviews: analyticsReviewsSchema,
    claudeUse: analyticsClaudeUseSchema,
    /**
     * Every API and subscription the engine uses, in the period (CLAUDE.md › APIs and services).
     * Left out by a server that is not wired to the money file; the page then hides the section.
     */
    services: analyticsServicesSchema.optional(),
  })
  .superRefine((answer, ctx) => {
    for (const { path, message } of lengthIssues(answer)) {
      ctx.addIssue({ code: 'custom', path, message });
    }
  });
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;

// --- inputs the engine records for the page ---------------------------------------------------

/** One reading of Claude's rate limits, logged when a Claude run reports a change (limits.jsonl). */
export const limitWindowSchema = z.object({
  /** How much of the limit is used: 0 to 1 (more when over). */
  utilization: z.number().nonnegative(),
  /** When the window resets. */
  resetsAt: isoTimestampSchema,
});
export type LimitWindow = z.infer<typeof limitWindowSchema>;

export const limitSnapshotSchema = z.object({
  /** When it was read. */
  at: isoTimestampSchema,
  /** Claude's own word for where use stands: `allowed` or anything else (a limit was hit). */
  status: z.string().min(1),
  /** The five-hour window; `null` when the reading did not carry it. */
  fiveHour: limitWindowSchema.nullable(),
  /** The weekly window; `null` when the reading did not carry it. */
  sevenDay: limitWindowSchema.nullable(),
});
export type LimitSnapshot = z.infer<typeof limitSnapshotSchema>;
