import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_DELIVERY_DAYS,
  ANALYTICS_SIZES,
  ANALYTICS_TILES,
  analyticsResponseSchema,
  TYPICAL_JOB_STAGES,
  tileSeriesLength,
} from './analytics.ts';
import { type ComputeAnalyticsInput, computeAnalytics } from './analytics-compute.ts';
import { weekdayOf } from './analytics-time.ts';

const ZONE = 'Asia/Jerusalem';
/** Thursday 22 October 2026, 09:00 in Israel. */
const NOW = Date.parse('2026-10-22T09:00:00+03:00');

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

// AN0 gives every section an empty answer of the right shape; the cards fill them in one by one.
describe('computeAnalytics with nothing recorded', () => {
  const answer = computeAnalytics(input());

  it('is a valid response, and survives a trip through JSON', () => {
    expect(analyticsResponseSchema.parse(answer)).toEqual(answer);
    expect(analyticsResponseSchema.parse(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  });

  it('says when it was worked out and on whose calendar', () => {
    expect(answer.generatedAt).toBe(new Date(NOW).toISOString());
    expect(answer.timeZone).toBe(ZONE);
  });

  it('has the five tiles in order, each with eight weekly gaps (Clients: 60 daily ones)', () => {
    expect(answer.jobs.tiles.map((tile) => [tile.key, tile.unit])).toEqual([
      ['jobs-finished', 'count'],
      ['clients', 'count'],
      ['files-in-ready', 'duration-sec'],
      ['editing-time', 'duration-sec'],
      ['approved-first-time', 'ratio'],
    ]);
    expect(answer.jobs.tiles).toHaveLength(ANALYTICS_TILES.length);
    for (const tile of answer.jobs.tiles) {
      expect(tile.value).toBeNull();
      expect(tile.previous).toBeNull();
      expect(tile.series).toEqual(
        Array.from({ length: tileSeriesLength(tile.key, 'month') }, () => null),
      );
    }
  });

  it('gives only the ratio tile its x of y, and none of the others', () => {
    const [ratio] = answer.jobs.tiles.filter((tile) => tile.unit === 'ratio');
    expect(ratio).toMatchObject({
      numerator: 0,
      denominator: 0,
      previousNumerator: 0,
      previousDenominator: 0,
    });
    for (const tile of answer.jobs.tiles.filter((t) => t.unit !== 'ratio')) {
      expect(tile).toMatchObject({
        numerator: null,
        denominator: null,
        previousNumerator: null,
        previousDenominator: null,
      });
    }
  });

  it('lays out 91 days from a Sunday to a Saturday, all gaps', () => {
    const days = answer.jobs.deliveredPerDay;
    expect(days).toHaveLength(ANALYTICS_DELIVERY_DAYS);
    expect(days[0]).toEqual({ date: '2026-07-26', count: null });
    expect(weekdayOf(days[0]?.date ?? '')).toBe(0);
    expect(days[90]).toEqual({ date: '2026-10-24', count: null });
    expect(days.every((day) => day.count === null)).toBe(true);
  });

  it('lists the footage weeks, the approval weeks and the value weeks, ending this week', () => {
    expect(answer.jobs.footage).toHaveLength(ANALYTICS_SIZES.month.footage);
    expect(answer.jobs.footage.at(-1)).toEqual({ start: '2026-10-18', hours: null });
    expect(answer.reviews.approvedFirstTime).toHaveLength(ANALYTICS_SIZES.month.approval);
    expect(answer.reviews.approvedFirstTime.at(-1)).toEqual({
      start: '2026-10-18',
      share: null,
      firstTime: 0,
      approved: 0,
      medianReruns: null,
    });
    expect(answer.claudeUse.apiValuePerFinishedMinute).toHaveLength(ANALYTICS_SIZES.month.value);
    expect(answer.claudeUse.apiValuePerFinishedMinute.at(-1)).toEqual({
      start: '2026-10-18',
      usdPerMinute: null,
    });
    expect(answer.claudeUse.credits).toMatchObject({
      budgetUsd: 200,
      spentUsd: 0,
      status: 'idle',
      monthStart: '2026-10-01',
      since: '2026-10-23',
    });
    expect(answer.claudeUse.plan).toMatchObject({ lastReadingAt: null, week: null, coveredUsd: 0 });
  });

  it('lists every stretch of a typical job with its median missing', () => {
    expect(answer.typicalJob.stages.map((stage) => stage.key)).toEqual(
      TYPICAL_JOB_STAGES.map((stage) => stage.key),
    );
    expect(answer.typicalJob.stages.map((stage) => stage.key)).toEqual([
      'waiting-to-start',
      'brief',
      'transcribe',
      'scan',
      'plan',
      'cut',
      'preview',
      'check',
      'waiting-for-you',
      'render',
    ]);
    expect(answer.typicalJob.stages.map((stage) => stage.kind)).toEqual([
      'wait',
      'editor',
      'editor',
      'editor',
      'editor',
      'editor',
      'editor',
      'editor',
      'you',
      'render',
    ]);
    for (const stage of answer.typicalJob.stages) {
      expect(stage.medianSec).toBeNull();
      expect(stage.beforeSec).toBeNull();
    }
    expect(answer.typicalJob).toMatchObject({
      editorSec: null,
      editorBeforeSec: null,
      wholeSec: null,
      wholeBeforeSec: null,
      slowestStepKey: null,
      jobsCounted: 0,
      jobsCountedBefore: 0,
    });
  });

  it('has no note topics, and no notes waiting for one', () => {
    expect(answer.reviews).toMatchObject({ noteTopics: [], notGroupedYet: 0, notesSince: null });
  });

  it('has eight weekly limit windows, only the newest one open', () => {
    const weeks = answer.claudeUse.busiest;
    expect(weeks).toHaveLength(ANALYTICS_SIZES.month.limit);
    // The newest window ends now, so it starts on the day 7 days before.
    expect(weeks.at(-1)?.start).toBe('2026-10-15');
    expect(weeks.map((week) => week.current)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    for (const week of weeks) {
      expect(week.peak).toBeNull();
      expect(week.hitLimit).toBe(false);
    }
    const starts = weeks.map((week) => Date.parse(`${week.start}T00:00:00Z`));
    starts.slice(1).forEach((start, i) => {
      expect(start - (starts[i] ?? 0)).toBe(7 * 86_400_000);
    });
  });
});

describe('computeAnalytics', () => {
  it('is the same answer for the same input', () => {
    expect(computeAnalytics(input())).toEqual(computeAnalytics(input()));
  });

  it('follows the time zone it is given', () => {
    // Saturday night in New York is already Sunday (the next week) in Israel.
    const now = Date.parse('2026-10-24T22:30:00-04:00');
    const israel = computeAnalytics(input({ now, timeZone: ZONE }));
    const newYork = computeAnalytics(input({ now, timeZone: 'America/New_York' }));
    expect(israel.jobs.footage.at(-1)?.start).toBe('2026-10-25');
    expect(newYork.jobs.footage.at(-1)?.start).toBe('2026-10-18');
    expect(analyticsResponseSchema.safeParse(israel).success).toBe(true);
    expect(analyticsResponseSchema.safeParse(newYork).success).toBe(true);
  });
});
