import { describe, expect, it } from 'vitest';
import { analyticsClaudeUseSchema, type LimitSnapshot } from './analytics.ts';
import {
  API_CREDITS_MONTHLY_USD,
  API_CREDITS_START,
  computeCredits,
  computePlan,
  FIRST_PASS_USD,
  FOLD_BELOW_SHARE,
  PLAN_WEEKLY_USD,
  planMonthSeries,
  spendList,
  TOP_JOBS,
} from './analytics-budgets.ts';
import { computeClaudeUseSection } from './analytics-claude-use.ts';
import type { ComputeAnalyticsInput } from './analytics-compute.ts';
import { startOfLocalDay } from './analytics-time.ts';
import type { UsageEntry, UsageTag } from './usage.ts';

const ZONE = 'Asia/Jerusalem';
/** Saturday 24 October 2026, noon in Israel: the app moved to the API key yesterday morning. */
const NOW = Date.parse('2026-10-24T12:00:00+03:00');
const MILLION = 1_000_000;

function input(overrides: Partial<ComputeAnalyticsInput> = {}): ComputeAnalyticsInput {
  return {
    now: NOW,
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

/** A usage line worth `usd` dollars: output tokens of Opus 5.5 ($20 per million). */
function worth(usd: number) {
  return {
    'claude-opus-5-5': {
      requests: 1,
      input: 0,
      output: Math.round((usd / 20) * MILLION),
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

function app(
  tag: UsageTag,
  at: string,
  usd: number,
  overrides: Partial<UsageEntry> = {},
): UsageEntry {
  return {
    at,
    from: null,
    source: 'app',
    tag,
    did: `Did ${tag}`,
    session: 's1',
    usage: worth(usd),
    ...overrides,
  };
}

function session(tag: UsageTag, at: string, usd: number): UsageEntry {
  return app(tag, at, usd, { source: 'session' });
}

function reading(
  at: string,
  sevenDay: number | null,
  resets: string,
  fiveHour: number | null = null,
  fiveResets = '2026-10-24T16:00:00+03:00',
): LimitSnapshot {
  return {
    at: new Date(at).toISOString(),
    status: 'allowed',
    fiveHour:
      fiveHour === null
        ? null
        : { utilization: fiveHour, resetsAt: new Date(fiveResets).toISOString() },
    sevenDay:
      sevenDay === null
        ? null
        : { utilization: sevenDay, resetsAt: new Date(resets).toISOString() },
  };
}

describe('startOfLocalDay', () => {
  it('is local midnight, whatever the time zone', () => {
    expect(new Date(startOfLocalDay('2026-10-23', ZONE)).toISOString()).toBe(
      '2026-10-22T21:00:00.000Z',
    );
    expect(new Date(startOfLocalDay('2026-10-23', 'UTC')).toISOString()).toBe(
      '2026-10-23T00:00:00.000Z',
    );
    expect(new Date(startOfLocalDay('2026-10-23', 'America/New_York')).toISOString()).toBe(
      '2026-10-23T04:00:00.000Z',
    );
  });

  it('follows a daylight saving change (Israel goes back an hour on 25 October 2026)', () => {
    expect(new Date(startOfLocalDay('2026-10-25', ZONE)).toISOString()).toBe(
      '2026-10-24T21:00:00.000Z',
    );
    expect(new Date(startOfLocalDay('2026-10-26', ZONE)).toISOString()).toBe(
      '2026-10-25T22:00:00.000Z',
    );
    expect(new Date(startOfLocalDay('2026-11-01', ZONE)).toISOString()).toBe(
      '2026-10-31T22:00:00.000Z',
    );
  });
});

describe('spendList', () => {
  const items = [
    { label: 'edit', usd: 12, runs: 3 },
    { label: 'revise', usd: 39, runs: 14 },
    { label: 'graphic', usd: 1.15, runs: 2 },
    { label: 'note-topics', usd: 0.06, runs: 10 },
    { label: 'render', usd: 0, runs: 0 },
  ];

  it('ranks by spend, biggest first, with each one’s share of the total', () => {
    const list = spendList(items);
    expect(list.totalUsd).toBeCloseTo(52.21, 6);
    expect(list.rows.map((row) => row.label)).toEqual(['revise', 'edit']);
    expect(list.rows[0]).toMatchObject({ usd: 39, runs: 14 });
    expect(list.rows[0]?.share).toBeCloseTo(39 / 52.21, 6);
    const shares = [...list.rows, ...list.folded].reduce((sum, row) => sum + row.share, 0);
    expect(shares).toBeCloseTo(1, 10);
  });

  it(`folds the rows under ${FOLD_BELOW_SHARE * 100}% of the total, still ranked, with their share`, () => {
    const list = spendList(items);
    // graphic is 2.2%: under 3%, so it folds with note-topics and render.
    expect(list.rows.map((row) => row.label)).toEqual(['revise', 'edit']);
    expect(list.folded.map((row) => row.label)).toEqual(['graphic', 'note-topics', 'render']);
    expect(list.foldedShare).toBeCloseTo((1.15 + 0.06) / 52.21, 6);
  });

  it('keeps a row at exactly the fold share', () => {
    const list = spendList([
      { label: 'a', usd: 97, runs: 1 },
      { label: 'b', usd: 3, runs: 1 },
    ]);
    expect(list.rows.map((row) => row.label)).toEqual(['a', 'b']);
    expect(list.folded).toEqual([]);
    expect(list.foldedShare).toBe(0);
  });

  it('breaks a tie by name', () => {
    const list = spendList([
      { label: 'zeta', usd: 5, runs: 1 },
      { label: 'alpha', usd: 5, runs: 1 },
    ]);
    expect(list.rows.map((row) => row.label)).toEqual(['alpha', 'zeta']);
  });

  it('folds everything, as nothing yet, when nothing is spent', () => {
    const list = spendList([
      { label: 'edit', usd: 0, runs: 0 },
      { label: 'revise', usd: 0, runs: 0 },
    ]);
    expect(list.totalUsd).toBe(0);
    expect(list.rows).toEqual([]);
    expect(list.folded).toHaveLength(2);
    expect(list.folded.every((row) => row.share === 0)).toBe(true);
  });

  it('takes only the top rows, dropping the rest, when asked (the jobs list)', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ label: `job ${i}`, usd: 10 - i, runs: 1 }));
    const list = spendList(many, { foldBelow: 0, top: TOP_JOBS });
    expect(list.rows.map((row) => row.label)).toEqual([
      'job 0',
      'job 1',
      'job 2',
      'job 3',
      'job 4',
    ]);
    expect(list.folded).toEqual([]);
    // Shares stay shares of everything, not of the five.
    expect(list.totalUsd).toBe(52);
    expect(list.rows[0]?.share).toBeCloseTo(10 / 52, 10);
  });

  it('gives each row its slice of the limit: its share times the limit’s use', () => {
    const list = spendList(
      [
        { label: 'orchestration', usd: 45, runs: 3 },
        { label: 'development', usd: 55, runs: 4 },
      ],
      { limitUse: 0.96 },
    );
    expect(list.rows[0]?.limitShare).toBeCloseTo(0.55 * 0.96, 10);
    expect(list.rows[1]?.limitShare).toBeCloseTo(0.45 * 0.96, 10);
    expect(spendList(items).rows[0]?.limitShare).toBeNull();
  });
});

describe('computeCredits', () => {
  it('counts the app’s lines from the day it moved to the API key, in October', () => {
    const credits = computeCredits(
      input({
        usage: [
          // Before the switch (22 Oct 23:59 Israel time): on the plan, not counted.
          app('edit', '2026-10-22T23:59:00+03:00', 30),
          app('edit', '2026-10-23T00:01:00+03:00', 12),
          app('revise', '2026-10-24T09:00:00+03:00', 39),
          // A session line is the plan's, never the credits'.
          session('development', '2026-10-24T09:00:00+03:00', 500),
        ],
      }),
    );
    expect(API_CREDITS_START).toBe('2026-10-23');
    expect(credits.since).toBe('2026-10-23');
    expect(credits.monthStart).toBe('2026-10-01');
    expect(credits.monthEnd).toBe('2026-10-31');
    expect(credits.monthDays).toBe(31);
    expect(credits.spentUsd).toBeCloseTo(51, 6);
    expect(credits.usedShare).toBeCloseTo(51 / 200, 6);
    expect(credits.leftUsd).toBeCloseTo(149, 6);
    expect(credits.budgetUsd).toBe(API_CREDITS_MONTHLY_USD);
  });

  it('counts the whole month from its first day once it is past the switch month', () => {
    const credits = computeCredits(
      input({
        now: Date.parse('2026-11-10T12:00:00+02:00'),
        usage: [
          app('edit', '2026-10-30T12:00:00+02:00', 90),
          app('edit', '2026-11-01T00:30:00+02:00', 7),
          app('revise', '2026-11-09T12:00:00+02:00', 3),
        ],
      }),
    );
    expect(credits.since).toBe('2026-11-01');
    expect(credits.monthEnd).toBe('2026-11-30');
    expect(credits.monthDays).toBe(30);
    expect(credits.spentUsd).toBeCloseTo(10, 6);
  });

  it('works out the share of the month gone and where now is on its axis', () => {
    const credits = computeCredits(input());
    // 23.5 days of 31.
    expect(credits.nowX).toBeCloseTo(23.5, 6);
    expect(credits.monthShare).toBeCloseTo(credits.nowX / 31, 1);
    expect(credits.monthShare).toBeGreaterThan(0.75);
    expect(credits.monthShare).toBeLessThan(0.77);
  });

  it('says how many first passes are left', () => {
    const credits = computeCredits(
      input({ usage: [app('edit', '2026-10-24T09:00:00+03:00', 51)] }),
    );
    expect(credits.firstPassUsd).toBe(FIRST_PASS_USD);
    // $149 left at $11.50 is 12.96: about 13.
    expect(credits.firstPasses).toBe(13);
    expect(computeCredits(input()).firstPasses).toBe(Math.round(200 / FIRST_PASS_USD));
  });

  it('runs out before the month ends when the pace says so ("Spending fast")', () => {
    const credits = computeCredits(
      input({ usage: [app('edit', '2026-10-24T09:00:00+03:00', 51)] }),
    );
    // 1.5 days since 23 Oct: $34 a day; $149 left lasts 4.4 days from the 24th at noon.
    expect(credits.perDayUsd).toBeCloseTo(34, 6);
    expect(credits.runOutDay).toBe('2026-10-28');
    expect(credits.runOutDaysBeforeEnd).toBe(3);
    expect(credits.status).toBe('spending-fast');
  });

  it('lasts the month when the pace is slow ("On pace")', () => {
    const credits = computeCredits(input({ usage: [app('edit', '2026-10-24T09:00:00+03:00', 6)] }));
    expect(credits.perDayUsd).toBeCloseTo(4, 6);
    expect(credits.runOutDay).toBeNull();
    expect(credits.runOutDaysBeforeEnd).toBeNull();
    expect(credits.status).toBe('on-pace');
  });

  it('counts a day at least, so the first morning does not project the month from an hour', () => {
    const credits = computeCredits(
      input({
        now: Date.parse('2026-10-23T01:00:00+03:00'),
        usage: [app('edit', '2026-10-23T00:30:00+03:00', 10)],
      }),
    );
    expect(credits.perDayUsd).toBe(10);
  });

  it('is idle with nothing spent, and used up with $200 spent', () => {
    const idle = computeCredits(input());
    expect(idle).toMatchObject({ status: 'idle', perDayUsd: null, runOutDay: null, spentUsd: 0 });
    const used = computeCredits(input({ usage: [app('edit', '2026-10-24T09:00:00+03:00', 230)] }));
    expect(used.status).toBe('used-up');
    expect(used.leftUsd).toBe(0);
    expect(used.firstPasses).toBe(0);
    expect(used.usedShare).toBeCloseTo(1.15, 6);
    expect(used.runOutDay).toBeNull();
  });

  it('ranks the tags (every app tag is listed) and the jobs that cost most', () => {
    const job = (id: string, name: string) => ({ id, name });
    const credits = computeCredits(
      input({
        usage: [
          app('revise', '2026-10-23T10:00:00+03:00', 20, {
            client: 'Falcon FPV',
            job: job('j1', 'Demo 2'),
          }),
          app('revise', '2026-10-24T10:00:00+03:00', 19, {
            client: 'Falcon FPV',
            job: job('j1', 'Demo 2'),
          }),
          app('edit', '2026-10-24T10:00:00+03:00', 12, {
            client: 'יעל כהן',
            job: job('j2', 'Demo 2'),
          }),
          app('note-topics', '2026-10-24T10:00:00+03:00', 0.06),
        ],
      }),
    );
    expect(credits.tags.rows.map((row) => row.label)).toEqual(['revise', 'edit']);
    expect(credits.tags.rows[0]).toMatchObject({ runs: 2 });
    expect(credits.tags.rows[0]?.usd).toBeCloseTo(39, 6);
    // Fourteen app tags in all: the eleven without use fold in with the tiny one.
    expect(credits.tags.rows.length + credits.tags.folded.length).toBe(14);
    expect(credits.tags.folded.some((row) => row.label === 'note-topics' && row.runs === 1)).toBe(
      true,
    );
    expect(credits.tags.folded.filter((row) => row.runs === 0)).toHaveLength(11);
    expect(credits.jobs.rows.map((row) => row.label)).toEqual([
      'Falcon FPV · Demo 2',
      'יעל כהן · Demo 2',
    ]);
    expect(credits.jobs.rows[0]).toMatchObject({ runs: 2 });
  });

  it('adds spend up through the month: flat from the start of the count, a step a day, and now', () => {
    const credits = computeCredits(
      input({
        usage: [
          app('edit', '2026-10-23T10:00:00+03:00', 12),
          app('revise', '2026-10-24T09:00:00+03:00', 39),
        ],
      }),
    );
    expect(credits.series).toHaveLength(3);
    expect(credits.series[0]).toEqual({ x: 22, usd: 0 });
    expect(credits.series[1]?.x).toBe(23);
    expect(credits.series[1]?.usd).toBeCloseTo(12, 6);
    expect(credits.series[2]?.x).toBeCloseTo(credits.nowX, 10);
    expect(credits.series[2]?.usd).toBeCloseTo(51, 6);
    // Never goes down, never leaves the month.
    const usd = credits.series.map((point) => point.usd);
    expect(usd).toEqual([...usd].sort((a, b) => a - b));
    expect(credits.series.every((point) => point.x <= credits.monthDays)).toBe(true);
  });

  it('starts the series at the month’s first day after the switch month', () => {
    const credits = computeCredits(input({ now: Date.parse('2026-11-03T12:00:00+02:00') }));
    expect(credits.series[0]).toEqual({ x: 0, usd: 0 });
    expect(credits.series.at(-1)?.usd).toBe(0);
  });
});

describe('computePlan', () => {
  const RESET = '2026-10-25T00:00:00+03:00';
  const WINDOW_START = '2026-10-18T00:00:00+03:00';

  it('has no week, and the last 7 days stand in, without a reading', () => {
    const plan = computePlan(
      input({
        usage: [
          session('development', '2026-10-20T10:00:00+03:00', 100),
          session('development', '2026-10-10T10:00:00+03:00', 900),
          app('edit', '2026-10-24T09:00:00+03:00', 50),
        ],
      }),
    );
    expect(plan).toMatchObject({ lastReadingAt: null, week: null, fiveHour: null, status: null });
    expect(plan.coveredUsd).toBeCloseTo(100, 6);
    expect(plan.tags.rows[0]).toMatchObject({ label: 'development', limitShare: null });
    expect(plan.monthlyUsd).toBe(200);
    expect(plan.weeklyUsd).toBeCloseTo(46.15, 2);
    expect(PLAN_WEEKLY_USD).toBeCloseTo(46.15, 2);
  });

  it('takes the weekly window from the newest reading, and the sessions logged in it', () => {
    const plan = computePlan(
      input({
        limits: [reading('2026-10-24T11:00:00+03:00', 0.96, RESET, 0.03)],
        usage: [
          // Before the window opened on Sunday 18 Oct at midnight: another week's.
          session('development', '2026-10-17T20:00:00+03:00', 300),
          session('orchestration', '2026-10-19T10:00:00+03:00', 470),
          session('development', '2026-10-20T10:00:00+03:00', 353),
          session('planning', '2026-10-21T10:00:00+03:00', 70),
          app('revise', '2026-10-24T09:00:00+03:00', 39),
        ],
      }),
    );
    expect(plan.week).toMatchObject({ utilization: 0.96 });
    expect(plan.week?.resetsAt).toBe(new Date(RESET).toISOString());
    // 6.5 days of 7.
    expect(plan.week?.weekShare).toBeCloseTo(
      (NOW - Date.parse(WINDOW_START)) / (7 * 86_400_000),
      6,
    );
    expect(plan.fiveHour?.utilization).toBe(0.03);
    expect(plan.status).toBe('allowed');
    expect(plan.lastReadingAt).toBe('2026-10-24T08:00:00.000Z');
    expect(plan.coveredUsd).toBeCloseTo(893, 6);
    expect(plan.tags.rows.map((row) => row.label)).toEqual([
      'orchestration',
      'development',
      'planning',
    ]);
    // Orchestration is 470 of 893 of session use: that share of the 96%.
    expect(plan.tags.rows[0]?.limitShare).toBeCloseTo((470 / 893) * 0.96, 10);
    // Every session tag is listed (eight), the unused ones folded.
    expect(plan.tags.rows.length + plan.tags.folded.length).toBe(8);
  });

  it('uses the newest reading by its time, not by its place in the file', () => {
    const plan = computePlan(
      input({
        limits: [
          reading('2026-10-24T11:00:00+03:00', 0.9, RESET),
          reading('2026-10-23T11:00:00+03:00', 0.5, RESET),
        ],
      }),
    );
    expect(plan.week?.utilization).toBe(0.9);
    expect(plan.lastReadingAt).toBe('2026-10-24T08:00:00.000Z');
  });

  it('has no week once the newest reading’s week is over, but still says when it was read', () => {
    const plan = computePlan(
      input({
        limits: [
          reading(
            '2026-10-17T11:00:00+03:00',
            0.96,
            '2026-10-18T00:00:00+03:00',
            0.2,
            '2026-10-17T14:00:00+03:00',
          ),
        ],
        usage: [session('development', '2026-10-22T10:00:00+03:00', 40)],
      }),
    );
    expect(plan.week).toBeNull();
    expect(plan.fiveHour).toBeNull();
    expect(plan.lastReadingAt).toBe('2026-10-17T08:00:00.000Z');
    expect(plan.coveredUsd).toBeCloseTo(40, 6);
    expect(plan.tags.rows[0]?.limitShare).toBeNull();
  });

  it('finds the weekly window in an earlier reading when the newest carries only the five-hour one', () => {
    const plan = computePlan(
      input({
        limits: [
          reading('2026-10-24T08:00:00+03:00', 0.8, RESET, null),
          reading('2026-10-24T11:00:00+03:00', null, RESET, 0.4),
        ],
      }),
    );
    expect(plan.week?.utilization).toBe(0.8);
    expect(plan.fiveHour?.utilization).toBe(0.4);
    expect(plan.lastReadingAt).toBe('2026-10-24T08:00:00.000Z');
  });

  it('drops a five-hour window that has reset', () => {
    const plan = computePlan(
      input({
        limits: [
          reading('2026-10-24T07:00:00+03:00', 0.5, RESET, 0.9, '2026-10-24T09:00:00+03:00'),
        ],
      }),
    );
    expect(plan.week?.utilization).toBe(0.5);
    expect(plan.fiveHour).toBeNull();
  });
});

describe('the section answers the schema', () => {
  it('with budgets filled in', () => {
    const section = computeClaudeUseSection(
      input({
        limits: [reading('2026-10-24T11:00:00+03:00', 0.5, '2026-10-25T00:00:00+03:00', 0.1)],
        usage: [
          app('edit', '2026-10-24T09:00:00+03:00', 5, {
            client: 'Kova',
            job: { id: 'j', name: 'Reel' },
          }),
          session('development', '2026-10-22T09:00:00+03:00', 15),
        ],
      }),
    );
    expect(analyticsClaudeUseSchema.parse(JSON.parse(JSON.stringify(section)))).toEqual(section);
    expect(section.credits.spentUsd).toBeCloseTo(5, 6);
    expect(section.plan.coveredUsd).toBeCloseTo(15, 6);
  });
});

describe('the credits’ slices', () => {
  it('give each tag and job its spend over the month’s credits, so the list reads like the plan’s', () => {
    const credits = computeCredits(
      input({
        usage: [
          app('revise', '2026-10-24T09:00:00+03:00', 30, {
            client: 'Kova',
            job: { id: 'a', name: 'Reel' },
          }),
          app('edit', '2026-10-24T10:00:00+03:00', 10, {
            client: 'Kova',
            job: { id: 'b', name: 'Ad' },
          }),
        ],
      }),
    );

    expect(credits.tags.rows[0]).toMatchObject({ label: 'revise' });
    expect(credits.tags.rows[0]?.limitShare).toBeCloseTo(30 / 200, 10);
    expect(credits.tags.rows[1]?.limitShare).toBeCloseTo(10 / 200, 10);
    expect(credits.jobs.rows[0]?.limitShare).toBeCloseTo(30 / 200, 10);
    // A tag nothing used has a slice of 0.
    expect(credits.tags.folded.every((row) => row.limitShare === 0)).toBe(true);
  });
});

describe('planMonthSeries', () => {
  const WEEK_1 = '2026-10-10T00:00:00+03:00';
  const WEEK_2 = '2026-10-17T00:00:00+03:00';
  const WEEK_3 = '2026-10-25T00:00:00+03:00';
  const series = (limits: LimitSnapshot[]) => planMonthSeries(limits, NOW, ZONE);

  it('has no runs without a reading this month', () => {
    expect(series([])).toEqual([]);
    expect(series([reading('2026-09-28T10:00:00+03:00', 0.9, WEEK_1)])).toEqual([]);
  });

  it('is one run per weekly window, oldest first, each climbing from 0 at the window’s start', () => {
    const runs = series([
      reading('2026-10-22T10:00:00+03:00', 0.7, WEEK_3),
      reading('2026-10-12T10:00:00+03:00', 0.3, WEEK_2),
      reading('2026-10-14T10:00:00+03:00', 0.6, WEEK_2),
    ]);

    expect(runs).toHaveLength(2);
    // The week that resets on the 17th began on the 10th at midnight: 9 days into the month.
    expect(runs[0]).toEqual([
      { x: 9, use: 0 },
      { x: 11 + 10 / 24, use: 0.3 },
      { x: 13 + 10 / 24, use: 0.6 },
    ]);
    expect(runs[1]?.[0]).toEqual({ x: 17, use: 0 });
    expect(runs[1]?.at(-1)).toEqual({ x: 21 + 10 / 24, use: 0.7 });
  });

  it('keeps the last reading of each day, and not a reading after now', () => {
    const runs = series([
      reading('2026-10-20T08:00:00+03:00', 0.4, WEEK_3),
      reading('2026-10-20T20:00:00+03:00', 0.5, WEEK_3),
      reading('2026-10-20T14:00:00+03:00', 0.45, WEEK_3),
      reading('2026-10-25T08:00:00+03:00', 0.9, WEEK_3),
    ]);

    expect(runs).toHaveLength(1);
    const uses = runs[0]?.map((point) => point.use);
    expect(uses).toEqual([0, 0.5]);
  });

  it('starts a window that began before the month where its first reading is, with no 0', () => {
    const runs = series([reading('2026-10-02T10:00:00+03:00', 0.2, '2026-10-04T00:00:00+03:00')]);

    expect(runs[0]).toHaveLength(1);
    expect(runs[0]?.[0]?.use).toBe(0.2);
  });

  it('skips a reading without the weekly window', () => {
    expect(series([reading('2026-10-20T08:00:00+03:00', null, WEEK_3, 0.2)])).toEqual([]);
  });

  it('is in the plan the section answers with, and valid for the schema', () => {
    const section = computeClaudeUseSection(
      input({ limits: [reading('2026-10-22T10:00:00+03:00', 0.7, WEEK_3)] }),
    );

    expect(section.plan.series).toHaveLength(1);
    expect(analyticsClaudeUseSchema.parse(JSON.parse(JSON.stringify(section)))).toEqual(section);
  });
});
