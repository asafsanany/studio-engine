import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_TILES,
  type AnalyticsResponse,
  analyticsResponseSchema,
  EDITOR_STAGE_KEYS,
  limitSnapshotSchema,
  TYPICAL_JOB_STAGES,
} from './analytics.ts';
import { computeAnalytics } from './analytics-compute.ts';

const NOW = Date.parse('2026-10-22T09:00:00+03:00');

function empty(): AnalyticsResponse {
  return computeAnalytics({
    now: NOW,
    timeZone: 'Asia/Jerusalem',
    jobs: [],
    stepRuns: [],
    sentNotes: [],
    deliveries: [],
    usage: [],
    limits: [],
    noteTopics: {},
  });
}

describe('the lists the answer is built from', () => {
  it('has five tiles: Jobs finished, Clients, Files in → ready, Editing time, Approved first time', () => {
    expect(ANALYTICS_TILES.map((tile) => tile.key)).toEqual([
      'jobs-finished',
      'clients',
      'files-in-ready',
      'editing-time',
      'approved-first-time',
    ]);
  });

  it('has the editor’s seven steps, Brief to Check, between the two waits and the render', () => {
    expect(EDITOR_STAGE_KEYS).toEqual([
      'brief',
      'transcribe',
      'scan',
      'plan',
      'cut',
      'preview',
      'check',
    ]);
    expect(TYPICAL_JOB_STAGES.map((stage) => stage.label)).toEqual([
      'Waiting to start',
      'Brief',
      'Transcribe',
      'Scan',
      'Plan',
      'Cut',
      'Preview',
      'Check',
      'Waiting for you',
      'Render',
    ]);
  });
});

describe('analyticsResponseSchema', () => {
  it('takes a filled-in answer', () => {
    const answer = empty();
    const [first, ...others] = answer.jobs.tiles;
    if (first === undefined) throw new Error('no tiles');
    answer.jobs.tiles = [
      { ...first, value: 31, previous: 27, series: [1, 2, 3, null, 5, 6, 7, 8] },
      ...others,
    ];
    answer.jobs.deliveredPerDay[0] = { date: '2026-07-26', count: 2 };
    answer.typicalJob.slowestStepKey = 'cut';
    answer.reviews.noteTopics = [
      { topic: 'intro too long', count: 8, clients: [{ client: 'Kova Coffee', count: 8 }] },
    ];
    answer.claudeUse.credits.spentUsd = 51;
    answer.claudeUse.credits.tags = {
      totalUsd: 51,
      rows: [{ label: 'revise', usd: 39, share: 39 / 51, runs: 14, limitShare: null }],
      folded: [],
      foldedShare: 0,
    };
    expect(analyticsResponseSchema.safeParse(answer).success).toBe(true);
  });

  it.each([
    ['four tiles', (a: AnalyticsResponse) => a.jobs.tiles.pop()],
    ['90 days', (a: AnalyticsResponse) => a.jobs.deliveredPerDay.pop()],
    ['11 footage weeks', (a: AnalyticsResponse) => a.jobs.footage.pop()],
    ['seven series tile values', (a: AnalyticsResponse) => a.jobs.tiles[0]?.series.pop()],
    ['nine stages', (a: AnalyticsResponse) => a.typicalJob.stages.pop()],
    ['11 approval weeks', (a: AnalyticsResponse) => a.reviews.approvedFirstTime.pop()],
    ['seven limit windows', (a: AnalyticsResponse) => a.claudeUse.busiest.pop()],
    ['11 value weeks', (a: AnalyticsResponse) => a.claudeUse.apiValuePerFinishedMinute.pop()],
  ])('refuses %s', (_name, change) => {
    const answer = empty();
    change(answer);
    expect(analyticsResponseSchema.safeParse(answer).success).toBe(false);
  });

  it('refuses a value that is not a number or null (a missing value is null, not "")', () => {
    const answer = empty();
    const tile = answer.jobs.tiles[0];
    if (tile === undefined) throw new Error('no tiles');
    expect(
      analyticsResponseSchema.safeParse({
        ...answer,
        jobs: { ...answer.jobs, tiles: [{ ...tile, value: '' }, ...answer.jobs.tiles.slice(1)] },
      }).success,
    ).toBe(false);
  });

  it('refuses a negative amount, a share above 1 and a day that does not exist', () => {
    const negative = empty();
    const tile = negative.jobs.tiles[0];
    if (tile) tile.value = -1;
    expect(analyticsResponseSchema.safeParse(negative).success).toBe(false);

    const share = empty();
    const week = share.reviews.approvedFirstTime[0];
    if (week) week.share = 1.2;
    expect(analyticsResponseSchema.safeParse(share).success).toBe(false);

    const day = empty();
    const cell = day.jobs.deliveredPerDay[0];
    if (cell) cell.date = '2026-02-30';
    expect(analyticsResponseSchema.safeParse(day).success).toBe(false);
  });

  it('refuses a slowest step that is not one of the editor’s steps', () => {
    const answer = empty();
    answer.typicalJob.slowestStepKey = 'render' as 'cut';
    expect(analyticsResponseSchema.safeParse(answer).success).toBe(false);
  });

  it('refuses a share above 1 in a spend row', () => {
    const answer = empty();
    answer.claudeUse.credits.tags.rows = [
      { label: 'edit', usd: 1, share: 1.5, runs: 1, limitShare: null },
    ];
    expect(analyticsResponseSchema.safeParse(answer).success).toBe(false);
  });
});

describe('limitSnapshotSchema', () => {
  const window = { utilization: 0.42, resetsAt: '2026-10-25T06:00:00.000Z' };

  it('takes a reading with both windows, or with one of them missing', () => {
    const at = '2026-10-22T06:00:00.000Z';
    expect(
      limitSnapshotSchema.safeParse({ at, status: 'allowed', fiveHour: window, sevenDay: window })
        .success,
    ).toBe(true);
    expect(
      limitSnapshotSchema.safeParse({ at, status: 'allowed', fiveHour: null, sevenDay: window })
        .success,
    ).toBe(true);
  });

  it('refuses a reading without a time or a status', () => {
    expect(
      limitSnapshotSchema.safeParse({ status: 'allowed', fiveHour: null, sevenDay: null }).success,
    ).toBe(false);
    expect(
      limitSnapshotSchema.safeParse({
        at: '2026-10-22T06:00:00.000Z',
        status: '',
        fiveHour: null,
        sevenDay: null,
      }).success,
    ).toBe(false);
  });
});
