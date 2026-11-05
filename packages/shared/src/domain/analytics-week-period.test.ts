import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_PERIODS,
  ANALYTICS_SIZES,
  type AnalyticsResponse,
  type AnalyticsTile,
  analyticsResponseSchema,
  DEFAULT_ANALYTICS_PERIOD,
  isAnalyticsPeriod,
} from './analytics.ts';
import {
  type AnalyticsJob,
  type AnalyticsStepRun,
  type ComputeAnalyticsInput,
  computeAnalytics,
} from './analytics-compute.ts';
import { makeJob } from './test-fixtures.ts';
import type { UsageEntry } from './usage.ts';

// The week period of the Analytics page: the same numbers over the last 7 days and the 7 before,
// with every series by day (14 of them, today last) where the month period has weeks. Thursday 22
// October 2026, 09:00 in Israel; the 14 days are 9 to 22 October.

const ZONE = 'Asia/Jerusalem';
const NOW = Date.parse('2026-10-22T09:00:00+03:00');
const DAYS = Array.from({ length: 14 }, (_, i) => `2026-10-${String(9 + i).padStart(2, '0')}`);

/** A moment on the wall clock of Israel (UTC+3 until the clocks change on 25 October). */
const iso = (local: string) => new Date(Date.parse(`2026-${local}:00.000+03:00`)).toISOString();

function input(overrides: Partial<ComputeAnalyticsInput> = {}): ComputeAnalyticsInput {
  return {
    now: NOW,
    period: 'week',
    timeZone: ZONE,
    jobs: [],
    stepRuns: [],
    sentNotes: [],
    deliveries: [],
    usage: [],
    limits: [],
    noteTopics: {},
    ...overrides,
  };
}

/** A ready job that finished at `finished` ("MM-DDTHH:mm" in Israel), `readyMin` minutes after it was added. */
function finishedJob(
  id: string,
  client: string,
  finished: string,
  readyMin: number,
  overrides: Partial<AnalyticsJob> = {},
): AnalyticsJob {
  const finishedAt = iso(finished);
  return {
    ...makeJob({
      id,
      clientId: `client-${client}`,
      client,
      state: 'ready',
      output: {
        fileName: `${client}/${id}.mp4`,
        durationSec: 120,
        width: 1080,
        height: 1920,
        sizeBytes: 1,
      },
      addedAt: new Date(Date.parse(finishedAt) - readyMin * 60_000).toISOString(),
    }),
    startedAt: null,
    finishedAt,
    footageSec: 0,
    ...overrides,
  };
}

function checkRun(jobId: string, from: string, to: string): AnalyticsStepRun {
  return {
    jobId,
    step: 7,
    runKind: 'edit',
    round: 0,
    startedAt: iso(from),
    endedAt: iso(to),
  };
}

function tileOf(answer: AnalyticsResponse, key: AnalyticsTile['key']): AnalyticsTile {
  const found = answer.jobs.tiles.find((tile) => tile.key === key);
  if (found === undefined) throw new Error(`no tile ${key}`);
  return found;
}

// 3 jobs finished in the last 7 days ((15 Oct 09:00, 22 Oct 09:00]), 2 in the 7 days before
// ((8 Oct 09:00, 15 Oct 09:00]) and 1 older than both.
const JOBS = [
  finishedJob('w1', 'A', '10-21T12:00', 120, {
    approvedAt: iso('10-21T11:50'),
    round: 0,
    footageSec: 3600,
  }),
  finishedJob('w2', 'B', '10-21T15:00', 60, {
    approvedAt: iso('10-21T14:50'),
    round: 1,
    footageSec: 1200,
  }),
  finishedJob('w3', 'A', '10-19T10:00', 90, {
    approvedAt: iso('10-19T09:50'),
    round: 0,
    footageSec: 1800,
  }),
  finishedJob('w4', 'C', '10-12T10:00', 240, { approvedAt: iso('10-12T09:50'), round: 0 }),
  finishedJob('w5', 'C', '10-10T10:00', 480, { approvedAt: iso('10-10T09:50'), round: 2 }),
  finishedJob('w6', 'A', '10-05T10:00', 60, { approvedAt: iso('10-05T09:50'), round: 0 }),
];

const RUNS = [
  checkRun('w1', '10-21T10:50', '10-21T11:00'),
  checkRun('w3', '10-19T08:50', '10-19T09:00'),
];

describe('the answer in the week period', () => {
  const answer = computeAnalytics(input({ jobs: JOBS, stepRuns: RUNS }));

  it('says which period it is for, and is valid for the page', () => {
    expect(answer.period).toBe('week');
    expect(analyticsResponseSchema.safeParse(answer).success).toBe(true);
  });

  it('has every series by day: 14 of them, the same days everywhere, today last', () => {
    for (const tile of answer.jobs.tiles) expect(tile.series).toHaveLength(14);
    expect(answer.jobs.footage.map((bucket) => bucket.start)).toEqual(DAYS);
    expect(answer.reviews.approvedFirstTime.map((bucket) => bucket.start)).toEqual(DAYS);
    expect(answer.claudeUse.busiest.map((bucket) => bucket.start)).toEqual(DAYS);
    expect(answer.claudeUse.apiValuePerFinishedMinute.map((bucket) => bucket.start)).toEqual(DAYS);
    // The delivery calendar and the typical job's stages are the same in both periods.
    expect(answer.jobs.deliveredPerDay).toHaveLength(91);
    expect(answer.typicalJob.stages).toHaveLength(10);
  });

  it('compares the last 7 days with the 7 before on the tiles', () => {
    expect(tileOf(answer, 'jobs-finished')).toMatchObject({ value: 3, previous: 2 });
    expect(tileOf(answer, 'clients')).toMatchObject({ value: 2, previous: 1 });
    // Files in → ready: the median of 120, 60 and 90 minutes; of 240 and 480 before.
    expect(tileOf(answer, 'files-in-ready')).toMatchObject({ value: 90 * 60, previous: 360 * 60 });
    expect(tileOf(answer, 'approved-first-time')).toMatchObject({
      numerator: 2,
      denominator: 3,
      previousNumerator: 1,
      previousDenominator: 2,
    });
  });

  it('gives each tile one value per day for the last 14 days', () => {
    // 9 Oct is the first day; w5 finished on the 10th, w4 on the 12th, w3 on the 19th, w1 and w2
    // on the 21st. Every day has data: the first job was added on 5 October.
    expect(tileOf(answer, 'jobs-finished').series).toEqual([
      0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0,
    ]);
    // Clients: each day, the clients with a job finished in the 7 days up to it; today's is the
    // tile's number (A and B since 15 Oct 09:00). 9 Oct has A (w6, 5 Oct); C joins on the 10th.
    expect(tileOf(answer, 'clients').series).toEqual([1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
    // A median of nothing is a gap, a share of nothing too.
    expect(tileOf(answer, 'files-in-ready').series.slice(0, 3)).toEqual([null, 480 * 60, null]);
    expect(tileOf(answer, 'approved-first-time').series.at(-2)).toBe(0.5);
    expect(tileOf(answer, 'approved-first-time').series.at(-1)).toBeNull();
  });

  it('counts footage per day, on the day the first edit got past Check', () => {
    expect(answer.jobs.footage.map((bucket) => bucket.hours)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 1, 0,
    ]);
  });

  it('counts approvals per day: how many, and how many first time', () => {
    const days = answer.reviews.approvedFirstTime;
    expect(days.find((day) => day.start === '2026-10-21')).toEqual({
      start: '2026-10-21',
      share: 0.5,
      firstTime: 1,
      approved: 2,
      medianReruns: 0.5,
    });
    expect(days.find((day) => day.start === '2026-10-19')).toMatchObject({ share: 1, approved: 1 });
    expect(days.find((day) => day.start === '2026-10-10')).toMatchObject({ share: 0, approved: 1 });
    expect(days.find((day) => day.start === '2026-10-20')).toMatchObject({
      share: null,
      approved: 0,
    });
  });

  it('medians the typical job over the last 7 days, and the 7 before for "vs before"', () => {
    expect(answer.typicalJob).toMatchObject({
      jobsCounted: 3,
      jobsCountedBefore: 2,
      wholeSec: 90 * 60,
      wholeBeforeSec: 360 * 60,
    });
  });
});

describe('the same data in the month period', () => {
  const answer = computeAnalytics(input({ period: 'month', jobs: JOBS, stepRuns: RUNS }));

  it('has the 30-day window and weekly series as ever', () => {
    expect(answer.period).toBe('month');
    // The data began on 5 October, so the 30 days before (up to 22 September) have none.
    expect(tileOf(answer, 'jobs-finished')).toMatchObject({ value: 6, previous: null });
    expect(tileOf(answer, 'jobs-finished').series).toHaveLength(8);
    expect(answer.jobs.footage).toHaveLength(12);
    expect(answer.claudeUse.busiest).toHaveLength(8);
    expect(answer.typicalJob.jobsCounted).toBe(6);
  });

  it('is the month answer when no period is asked for', () => {
    const { period: _period, ...asked } = input({ jobs: JOBS, stepRuns: RUNS });
    expect(computeAnalytics(asked)).toEqual(answer);
    expect(DEFAULT_ANALYTICS_PERIOD).toBe('month');
  });
});

describe('days before the data began, in the week period', () => {
  it('are gaps, and the days from the first record on are real zeros', () => {
    // The only record is a job added on Sunday 18 October.
    const job = {
      ...makeJob({ id: 'x', addedAt: iso('10-18T12:00') }),
      startedAt: null,
      finishedAt: null,
      footageSec: 0,
    };
    const answer = computeAnalytics(input({ jobs: [job] }));

    const hours = answer.jobs.footage.map((day) => day.hours);
    expect(hours.slice(0, 9)).toEqual(Array.from({ length: 9 }, () => null));
    expect(hours.slice(9)).toEqual([0, 0, 0, 0, 0]);
    expect(
      tileOf(answer, 'jobs-finished')
        .series.slice(0, 9)
        .every((v) => v === null),
    ).toBe(true);
    expect(tileOf(answer, 'jobs-finished').series.slice(9)).toEqual([0, 0, 0, 0, 0]);
  });

  it('start the data day at the engine’s time zone, not UTC', () => {
    // 22:30 UTC on 20 October is 01:30 on the 21st in Israel: the 20th still has no data.
    const job = {
      ...makeJob({ id: 'y', addedAt: '2026-10-20T22:30:00.000Z' }),
      startedAt: null,
      finishedAt: null,
      footageSec: 0,
    };
    const answer = computeAnalytics(input({ jobs: [job] }));

    expect(answer.jobs.footage.at(-3)?.hours).toBeNull();
    expect(answer.jobs.footage.at(-2)?.hours).toBe(0);
  });
});

describe('API cost per finished minute, per day', () => {
  const opus = (usd: number) => ({
    'claude-opus-5-5': {
      requests: 1,
      input: 0,
      output: Math.round((usd / 20) * 1_000_000),
      cacheRead: 0,
      cacheWrite: 0,
    },
  });
  const line = (tag: UsageEntry['tag'], at: string, usd: number): UsageEntry => ({
    at: iso(at),
    from: null,
    source: tag === 'edit' || tag === 'render' ? 'app' : 'session',
    tag,
    did: `Did ${tag}`,
    session: 's1',
    usage: opus(usd),
  });
  const usage = [
    line('edit', '10-21T11:00', 6),
    line('render', '10-21T15:30', 2),
    line('development', '10-21T18:00', 12),
    line('design', '10-20T10:00', 5),
  ];
  const answer = computeAnalytics(input({ jobs: JOBS, stepRuns: RUNS, usage }));

  it('divides a day’s Client work value by the minutes finished that day', () => {
    // $8 of Client work on the 21st; w1 and w2 finished that day, 2 + 2 minutes of video.
    const days = answer.claudeUse.apiValuePerFinishedMinute;
    expect(days.find((day) => day.start === '2026-10-21')?.usdPerMinute).toBeCloseTo(2, 5);
    // The 20th has usage but no Client work and no finished video; the 19th has a job but no usage.
    expect(days.find((day) => day.start === '2026-10-20')?.usdPerMinute).toBeNull();
    expect(days.find((day) => day.start === '2026-10-19')?.usdPerMinute).toBeNull();
  });
});

describe('the lists the period is built from', () => {
  it('has the two periods, month the default', () => {
    expect(ANALYTICS_PERIODS).toEqual(['week', 'month']);
    expect(isAnalyticsPeriod('week')).toBe(true);
    expect(isAnalyticsPeriod('month')).toBe(true);
    expect(isAnalyticsPeriod('year')).toBe(false);
    expect(isAnalyticsPeriod(undefined)).toBe(false);
  });

  it('sizes the series: 8 or 12 weeks, or 14 days (the Clients tile: 60 days, or 14)', () => {
    expect(ANALYTICS_SIZES.month).toEqual({
      windowDays: 30,
      tile: 8,
      clientDays: 60,
      footage: 12,
      approval: 12,
      limit: 8,
      value: 12,
    });
    expect(ANALYTICS_SIZES.week).toEqual({
      windowDays: 7,
      tile: 14,
      clientDays: 14,
      footage: 14,
      approval: 14,
      limit: 14,
      value: 14,
    });
  });
});

describe('analyticsResponseSchema and the period', () => {
  const week = () => computeAnalytics(input());
  const month = () => computeAnalytics(input({ period: 'month' }));

  it('takes a week answer and a month answer', () => {
    expect(analyticsResponseSchema.safeParse(week()).success).toBe(true);
    expect(analyticsResponseSchema.safeParse(month()).success).toBe(true);
  });

  it('refuses a series whose length is the other period’s', () => {
    const asMonth = { ...week(), period: 'month' as const };
    const asWeek = { ...month(), period: 'week' as const };

    expect(analyticsResponseSchema.safeParse(asMonth).success).toBe(false);
    expect(analyticsResponseSchema.safeParse(asWeek).success).toBe(false);
  });

  it.each([
    ['a tile with 13 values', (a: AnalyticsResponse) => a.jobs.tiles[2]?.series.pop()],
    ['13 footage days', (a: AnalyticsResponse) => a.jobs.footage.pop()],
    ['13 approval days', (a: AnalyticsResponse) => a.reviews.approvedFirstTime.pop()],
    ['13 limit days', (a: AnalyticsResponse) => a.claudeUse.busiest.pop()],
    ['13 value days', (a: AnalyticsResponse) => a.claudeUse.apiValuePerFinishedMinute.pop()],
  ])('refuses %s in the week period', (_name, change) => {
    const answer = week();
    change(answer);
    expect(analyticsResponseSchema.safeParse(answer).success).toBe(false);
  });

  it('refuses an answer that does not say its period, or says one that is not', () => {
    const { period: _period, ...without } = week();
    expect(analyticsResponseSchema.safeParse(without).success).toBe(false);
    expect(analyticsResponseSchema.safeParse({ ...week(), period: 'year' }).success).toBe(false);
  });
});
