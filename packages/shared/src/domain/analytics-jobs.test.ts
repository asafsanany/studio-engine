import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_CALENDAR_WEEKS,
  ANALYTICS_DELIVERY_DAYS,
  ANALYTICS_SIZES,
  type AnalyticsJobs,
  type AnalyticsTile,
  analyticsJobsSchema,
  tileSeriesLength,
} from './analytics.ts';
import type { AnalyticsJob, AnalyticsStepRun, ComputeAnalyticsInput } from './analytics-compute.ts';
import { computeJobsSection, median } from './analytics-jobs.ts';
import type { MoneyDelivery } from './money-compute.ts';
import type { RunKind } from './run-kind.ts';
import type { StepId } from './steps.ts';
import { makeJob } from './test-fixtures.ts';

const ZONE = 'Asia/Jerusalem';
/** Thursday 22 October 2026, 09:00 in Israel (06:00 UTC). */
const NOW = Date.parse('2026-10-22T09:00:00+03:00');
const DAY = 86_400_000;

/** A moment on the wall clock of Israel (UTC+3 until the clocks change on 25 October). */
const at = (local: string) => `2026-${local}:00.000+03:00`;
const iso = (local: string) => new Date(Date.parse(at(local))).toISOString();

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

/** A job; override what a test cares about. Not finished unless it says so. */
function job(id: string, overrides: Partial<AnalyticsJob> = {}): AnalyticsJob {
  return {
    ...makeJob({ id, clientId: 'client-a', client: 'A', addedAt: iso('10-01T09:00') }),
    startedAt: null,
    finishedAt: null,
    footageSec: 0,
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
  const finishedAt = new Date(Date.parse(at(finished))).toISOString();
  return job(id, {
    clientId: `client-${client}`,
    client,
    state: 'ready',
    output: {
      fileName: `${client}/${id}.mp4`,
      durationSec: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 1,
    },
    addedAt: new Date(Date.parse(finishedAt) - readyMin * 60_000).toISOString(),
    finishedAt,
    ...overrides,
  });
}

function run(
  jobId: string,
  step: StepId,
  from: string,
  to: string | null,
  runKind: RunKind = 'edit',
  round = 0,
): AnalyticsStepRun {
  return {
    jobId,
    step,
    runKind,
    round,
    startedAt: iso(from),
    endedAt: to === null ? null : iso(to),
  };
}

function delivery(jobId: string, deliveredAt: string): MoneyDelivery {
  return {
    jobId,
    clientId: 'client-a',
    client: 'A',
    name: jobId,
    relPath: `A/${jobId}`,
    deliveredAt: Date.parse(deliveredAt),
    price: 40,
    currency: 'ILS',
    reviewSec: 0,
    paidOn: null,
  };
}

function tileOf(jobs: AnalyticsJobs, key: AnalyticsTile['key']): AnalyticsTile {
  const found = jobs.tiles.find((tile) => tile.key === key);
  if (found === undefined) throw new Error(`no tile ${key}`);
  return found;
}

describe('median', () => {
  it('is the middle value, or the mean of the two in the middle', () => {
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('is null for nothing, and does not change what it is given', () => {
    expect(median([])).toBeNull();
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

// A month and a bit of jobs. The 30 days up to now are (22 Sep 09:00, 22 Oct 09:00] and the 30
// days before are (23 Aug 09:00, 22 Sep 09:00]. Weeks start on Sunday: this week is 18 Oct.
describe('the tiles over two windows of jobs', () => {
  const jobs = [
    // The last 30 days: A twice, B, C, and E exactly at "now" (the end is in).
    finishedJob('j1', 'A', '10-20T12:00', 120, { approvedAt: iso('10-20T11:50'), round: 0 }),
    finishedJob('j2', 'A', '10-19T10:00', 60, { approvedAt: iso('10-19T09:55'), round: 2 }),
    finishedJob('j3', 'B', '10-02T08:00', 1440, { approvedAt: iso('10-02T07:50'), round: 0 }),
    finishedJob('j4', 'C', '09-25T10:00', 30),
    finishedJob('j9', 'E', '10-22T09:00', 1),
    // The 30 days before: A, B, and D exactly 30 days before now (the start is out of the last 30).
    finishedJob('j5', 'A', '09-10T10:00', 10, { approvedAt: iso('09-10T09:55'), round: 1 }),
    finishedJob('j6', 'B', '09-01T10:00', 20),
    finishedJob('j8', 'D', '09-22T09:00', 5),
    // Older than both windows: only there to start the data early.
    finishedJob('j7', 'A', '08-20T10:00', 100),
  ];
  const stepRuns = [
    // j1: 10 min of edit + 10 min of revise; the render and the step left open are not counted.
    run('j1', 1, '10-20T10:00', '10-20T10:10'),
    run('j1', 2, '10-20T10:10', null),
    run('j1', 4, '10-20T10:20', '10-20T10:30', 'revise', 1),
    run('j1', 8, '10-20T10:40', '10-20T10:50', 'render', 1),
    run('j2', 1, '10-19T09:00', '10-19T09:10'),
    run('j4', 1, '09-25T09:30', '09-25T09:35'),
    run('j5', 1, '09-10T09:50', '09-10T09:51'),
    run('j6', 1, '09-01T09:40', '09-01T09:43'),
    // A step of a job that is gone; nobody's.
    run('gone', 1, '10-20T10:00', '10-20T11:00'),
  ];
  const answer = computeJobsSection(input({ jobs, stepRuns }));

  it('is a valid answer of the fixed shape', () => {
    expect(analyticsJobsSchema.parse(answer)).toEqual(answer);
    expect(answer.tiles.map((tile) => tile.series.length)).toEqual([8, 60, 8, 8, 8]);
    expect(tileSeriesLength('clients', 'month')).toBe(ANALYTICS_SIZES.month.clientDays);
  });

  it('counts the jobs that finished in the last 30 days and in the 30 days before', () => {
    expect(tileOf(answer, 'jobs-finished')).toMatchObject({
      unit: 'count',
      value: 5,
      previous: 3,
      numerator: null,
      denominator: null,
    });
  });

  it('counts the clients with a job finished, each once', () => {
    expect(tileOf(answer, 'clients')).toMatchObject({ unit: 'count', value: 4, previous: 3 });
  });

  it('takes the median of files in to ready, in seconds', () => {
    // Now: 1, 30, 60, 120 and 1440 minutes. Before: 5, 10 and 20 minutes.
    expect(tileOf(answer, 'files-in-ready')).toMatchObject({
      unit: 'duration-sec',
      value: 60 * 60,
      previous: 10 * 60,
    });
  });

  it('takes the median of the editor time per job: edit and revise steps, no render, no open step', () => {
    // Now: j1 20 min, j2 10 min, j4 5 min (j3 and j9 have no timed step, so they are left out).
    // Before: j5 1 min, j6 3 min (j8 has none).
    expect(tileOf(answer, 'editing-time')).toMatchObject({
      unit: 'duration-sec',
      value: 10 * 60,
      previous: 2 * 60,
    });
  });

  it('shows approved first time as x of y over the jobs approved in each window', () => {
    // Now: j1 (first time), j2 (after 2 rounds), j3 (first time). Before: j5 (after 1 round).
    expect(tileOf(answer, 'approved-first-time')).toMatchObject({
      unit: 'ratio',
      value: 2 / 3,
      previous: 0,
      numerator: 2,
      denominator: 3,
      previousNumerator: 0,
      previousDenominator: 1,
    });
  });

  it('gives the sparkline a value for each of the last 8 weeks, oldest first, this week last', () => {
    // Weeks from 30 Aug to 18 Oct.
    expect(tileOf(answer, 'jobs-finished').series).toEqual([1, 1, 0, 2, 1, 0, 0, 3]);
    // A week with no finished job has no median: a gap.
    expect(tileOf(answer, 'files-in-ready').series).toEqual([
      20 * 60,
      10 * 60,
      null,
      (30 * 60 + 5 * 60) / 2,
      1440 * 60,
      null,
      null,
      60 * 60,
    ]);
    expect(tileOf(answer, 'editing-time').series).toEqual([
      180,
      60,
      null,
      300,
      null,
      null,
      null,
      (1200 + 600) / 2,
    ]);
    // A week with nothing approved has no share.
    expect(tileOf(answer, 'approved-first-time').series).toEqual([
      null,
      0,
      null,
      null,
      1,
      null,
      null,
      0.5,
    ]);
  });

  it('gives the Clients sparkline, each day of the last 60, the clients of the 30 days up to it', () => {
    // 24 Aug to 22 Oct. A job counts from the day it finished to 29 days later: A from 20 Aug, B
    // from 1 Sep, D from 22 Sep, C from 25 Sep; B again from 2 Oct, A again from 10 Sep and 19 Oct.
    // Today's window starts at now − 30 days, which leaves D (22 Sep 09:00) out: the tile's 4.
    const runs = (...parts: [days: number, clients: number][]) =>
      parts.flatMap(([days, clients]) => Array.from({ length: days }, () => clients));
    const series = tileOf(answer, 'clients').series;
    expect(series).toEqual(runs([8, 1], [21, 2], [3, 3], [6, 4], [1, 3], [8, 4], [9, 3], [4, 4]));
    expect(series.at(-1)).toBe(tileOf(answer, 'clients').value);
  });

  it('keeps the tiles in the order of the contract', () => {
    expect(answer.tiles.map((tile) => tile.key)).toEqual([
      'jobs-finished',
      'clients',
      'files-in-ready',
      'editing-time',
      'approved-first-time',
    ]);
  });
});

describe('what counts as a finished job', () => {
  const finished = (extra: Partial<AnalyticsJob> = {}) =>
    finishedJob('j1', 'A', '10-20T12:00', 30, extra);

  it('is a ready job with an export and an end time', () => {
    const count = (jobs: AnalyticsJob[]) =>
      tileOf(computeJobsSection(input({ jobs })), 'jobs-finished').value;
    expect(count([finished()])).toBe(1);
    expect(count([finished({ output: null })])).toBe(0);
    expect(count([finished({ finishedAt: null })])).toBe(0);
    expect(count([finished({ state: 'review' })])).toBe(0);
    expect(count([finished({ state: 'failed' })])).toBe(0);
    expect(count([finished({ state: 'editing' })])).toBe(0);
  });

  it('counts an archived job, and does not count one that finishes after now', () => {
    const count = (jobs: AnalyticsJob[]) =>
      tileOf(computeJobsSection(input({ jobs })), 'jobs-finished').value;
    expect(count([finished({ archivedAt: iso('10-21T10:00') })])).toBe(1);
    expect(count([finished({ finishedAt: new Date(NOW + 1000).toISOString() })])).toBe(0);
  });

  it('measures files in to ready from when the job was added, and skips a job whose times do not add up', () => {
    const jobs = [
      finished({ id: 'a', addedAt: iso('10-20T11:00') }),
      finished({ id: 'b', addedAt: iso('10-20T13:00') }),
    ];
    expect(tileOf(computeJobsSection(input({ jobs })), 'files-in-ready').value).toBe(3600);
  });
});

describe('when there is nothing to say', () => {
  it('has no number anywhere when nothing was ever recorded', () => {
    const answer = computeJobsSection(input());
    for (const tile of answer.tiles) {
      expect(tile.value).toBeNull();
      expect(tile.previous).toBeNull();
      expect(tile.series.every((week) => week === null)).toBe(true);
    }
    expect(answer.deliveredPerDay.every((day) => day.count === null)).toBe(true);
    expect(answer.footage.every((week) => week.hours === null)).toBe(true);
  });

  it('counts a quiet window as zero jobs once there is data, and a median of nothing as null', () => {
    // A job added a long time ago and not finished: the data has begun, nothing has finished.
    const answer = computeJobsSection(
      input({ jobs: [job('j1', { addedAt: iso('07-01T10:00') })] }),
    );
    expect(tileOf(answer, 'jobs-finished')).toMatchObject({ value: 0, previous: 0 });
    expect(tileOf(answer, 'jobs-finished').series).toEqual(Array.from({ length: 8 }, () => 0));
    expect(tileOf(answer, 'clients')).toMatchObject({ value: 0, previous: 0 });
    expect(tileOf(answer, 'files-in-ready')).toMatchObject({ value: null, previous: null });
    expect(tileOf(answer, 'editing-time')).toMatchObject({ value: null, previous: null });
    expect(tileOf(answer, 'approved-first-time')).toMatchObject({
      value: null,
      previous: null,
      numerator: 0,
      denominator: 0,
      previousNumerator: 0,
      previousDenominator: 0,
    });
  });

  it('has no earlier numbers to compare with while the data is younger than the window before', () => {
    // The first job came on 20 October (a Tuesday, in the week of the 18th) and finished the next day.
    const jobs = [finishedJob('j1', 'A', '10-21T10:00', 60, { addedAt: iso('10-20T09:00') })];
    const answer = computeJobsSection(input({ jobs }));
    expect(tileOf(answer, 'jobs-finished')).toMatchObject({ value: 1, previous: null });
    expect(tileOf(answer, 'clients')).toMatchObject({ value: 1, previous: null });
    // The weeks before the data are gaps; the week it began in is a real count.
    expect(tileOf(answer, 'jobs-finished').series).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
    ]);
    expect(
      tileOf(answer, 'files-in-ready')
        .series.slice(0, 7)
        .every((v) => v === null),
    ).toBe(true);
  });

  it('starts the data at the oldest delivery or timed step when it is older than every job', () => {
    const answer = computeJobsSection(
      input({ deliveries: [delivery('gone', '2026-07-01T10:00:00+03:00')] }),
    );
    expect(tileOf(answer, 'jobs-finished').previous).toBe(0);
    expect(tileOf(answer, 'jobs-finished').series.every((week) => week === 0)).toBe(true);
  });
});

describe('jobs delivered per day', () => {
  it('lays out 91 days from a Sunday to a Saturday, 12 weeks before this week to this week', () => {
    const { deliveredPerDay: days } = computeJobsSection(input({ jobs: [job('j1')] }));
    expect(days).toHaveLength(ANALYTICS_DELIVERY_DAYS);
    expect(days).toHaveLength(ANALYTICS_CALENDAR_WEEKS * 7);
    expect(days[0]?.date).toBe('2026-07-26');
    expect(days[90]?.date).toBe('2026-10-24');
  });

  it('counts the deliveries on each local day, zero for a day with none', () => {
    const deliveries = [
      delivery('a', '2026-10-21T10:00:00+03:00'),
      delivery('b', '2026-10-21T15:30:00+03:00'),
      delivery('c', '2026-10-20T10:00:00+03:00'),
      delivery('d', '2026-09-01T10:00:00+03:00'),
    ];
    const { deliveredPerDay: days } = computeJobsSection(input({ deliveries }));
    const count = (date: string) => days.find((day) => day.date === date)?.count;
    expect(count('2026-10-21')).toBe(2);
    expect(count('2026-10-20')).toBe(1);
    expect(count('2026-10-19')).toBe(0);
    expect(count('2026-09-01')).toBe(1);
    expect(count('2026-10-22')).toBe(0);
  });

  it('puts a delivery on the day it was in the engine time zone, not in UTC', () => {
    // 22:30 UTC on the 20th is 01:30 on the 21st in Israel.
    const deliveries = [delivery('a', '2026-10-20T22:30:00Z')];
    const { deliveredPerDay: israel } = computeJobsSection(input({ deliveries }));
    expect(israel.find((day) => day.date === '2026-10-21')?.count).toBe(1);
    // The day before the first record is before the data.
    expect(israel.find((day) => day.date === '2026-10-20')?.count).toBeNull();
    const { deliveredPerDay: utc } = computeJobsSection(input({ deliveries, timeZone: 'UTC' }));
    expect(utc.find((day) => day.date === '2026-10-20')?.count).toBe(1);
    expect(utc.find((day) => day.date === '2026-10-21')?.count).toBe(0);
  });

  it('leaves the days to come, and the days before the data began, as gaps', () => {
    const deliveries = [delivery('a', '2026-10-01T10:00:00+03:00')];
    const { deliveredPerDay: days } = computeJobsSection(input({ deliveries }));
    expect(days.find((day) => day.date === '2026-10-23')?.count).toBeNull();
    expect(days.find((day) => day.date === '2026-10-24')?.count).toBeNull();
    expect(days.find((day) => day.date === '2026-09-30')?.count).toBeNull();
    expect(days.find((day) => day.date === '2026-10-01')?.count).toBe(1);
    expect(days.find((day) => day.date === '2026-10-02')?.count).toBe(0);
  });

  it('does not count a delivery that is dated after now', () => {
    const deliveries = [
      delivery('a', '2026-10-01T10:00:00+03:00'),
      delivery('b', new Date(NOW + DAY).toISOString()),
    ];
    const { deliveredPerDay: days } = computeJobsSection(input({ deliveries }));
    expect(days.reduce((total, day) => total + (day.count ?? 0), 0)).toBe(1);
  });
});

describe('footage edited per week', () => {
  const jobs = [
    job('j1', { footageSec: 7200, addedAt: iso('09-01T10:00') }),
    job('j2', { footageSec: 3600 }),
    job('j3', { footageSec: 1800 }),
    job('j4', { footageSec: 9000 }),
  ];
  const stepRuns = [
    // j1 got past Check on Tuesday 20 October (the week of the 18th).
    run('j1', 7, '10-20T10:00', '10-20T10:30'),
    // j2 on Monday 12 October (the week of the 11th); a revise round's Check later does not count.
    run('j2', 7, '10-12T10:00', '10-12T10:30'),
    run('j2', 7, '10-21T10:00', '10-21T10:30', 'revise', 1),
    // j3's Check was retried: it counts once, in the week of its last end (the 18th).
    run('j3', 7, '10-11T10:00', '10-11T10:30'),
    run('j3', 7, '10-18T10:00', '10-18T10:30'),
    // j4's Check is still going.
    run('j4', 7, '10-21T10:00', null),
    // A job that is gone.
    run('gone', 7, '10-20T10:00', '10-20T10:30'),
  ];
  const { footage: weeks } = computeJobsSection(input({ jobs, stepRuns }));

  it('lists the last 12 weeks, oldest first, this week last', () => {
    expect(weeks).toHaveLength(ANALYTICS_SIZES.month.footage);
    expect(weeks[0]?.start).toBe('2026-08-02');
    expect(weeks.at(-1)?.start).toBe('2026-10-18');
  });

  it('adds up the footage of the jobs whose first edit got past Check that week, in hours', () => {
    expect(weeks.at(-1)?.hours).toBe((7200 + 1800) / 3600);
    expect(weeks.at(-2)?.hours).toBe(1);
  });

  it('is zero for a quiet week once the data has begun, and a gap before that', () => {
    expect(weeks.at(-3)?.hours).toBe(0);
    // The data begins with j1, added on 1 September: the week of 30 August.
    expect(weeks.find((week) => week.start === '2026-08-30')?.hours).toBe(0);
    expect(weeks.find((week) => week.start === '2026-08-23')?.hours).toBeNull();
    expect(weeks[0]?.hours).toBeNull();
  });
});

describe('time zones', () => {
  it('puts a job in the week of the engine time zone', () => {
    // Saturday 17 October 22:30 in New York is already Sunday 18 October in Israel.
    const finishedAt = '2026-10-17T22:30:00-04:00';
    const jobs = [
      finishedJob('j1', 'A', '10-18T05:30', 10, { finishedAt: new Date(finishedAt).toISOString() }),
    ];
    const israel = computeJobsSection(input({ jobs, now: NOW }));
    const newYork = computeJobsSection(input({ jobs, now: NOW, timeZone: 'America/New_York' }));
    expect(tileOf(israel, 'jobs-finished').series.at(-1)).toBe(1);
    expect(tileOf(newYork, 'jobs-finished').series.at(-1)).toBe(0);
    expect(tileOf(newYork, 'jobs-finished').series.at(-2)).toBe(1);
  });
});
