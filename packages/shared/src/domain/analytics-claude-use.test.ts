import { describe, expect, it } from 'vitest';
import { analyticsClaudeUseSchema, analyticsResponseSchema } from './analytics.ts';
import { apiValuePerFinishedMinute, computeClaudeUseSection } from './analytics-claude-use.ts';
import {
  type AnalyticsJob,
  type ComputeAnalyticsInput,
  computeAnalytics,
} from './analytics-compute.ts';
import { makeJob } from './test-fixtures.ts';
import { USAGE_TAG_INFO, type UsageEntry, type UsageTag } from './usage.ts';

const ZONE = 'Asia/Jerusalem';
/** Thursday 22 October 2026, 09:00 in Israel: this week started on Sunday 18 October. */
const NOW = Date.parse('2026-10-22T09:00:00+03:00');
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
function opusWorth(usd: number) {
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

function line(
  tag: UsageTag,
  at: string,
  usd: number,
  overrides: Partial<UsageEntry> = {},
): UsageEntry {
  return {
    at,
    from: null,
    source: USAGE_TAG_INFO[tag].group === 'Client work' ? 'app' : 'session',
    tag,
    did: `Did ${tag}`,
    session: 's1',
    usage: opusWorth(usd),
    ...overrides,
  };
}

/** A finished job: it has an export of `durationSec` seconds and finished at `finishedAt`. */
function finished(
  durationSec: number,
  finishedAt: string | null,
  overrides: Partial<AnalyticsJob> = {},
): AnalyticsJob {
  return {
    ...makeJob({
      state: 'ready',
      output: {
        fileName: 'Client/Job.mp4',
        durationSec,
        width: 1080,
        height: 1920,
        sizeBytes: 1000,
      },
    }),
    startedAt: '2026-10-19T08:00:00.000Z',
    finishedAt,
    footageSec: 600,
    ...overrides,
  };
}

const THIS_WEEK_TUESDAY = '2026-10-20T10:00:00+03:00';
const LAST_WEEK_TUESDAY = '2026-10-13T10:00:00+03:00';

describe('apiValuePerFinishedMinute', () => {
  it('lists the last 12 weeks, oldest first, this week last, all gaps without data', () => {
    const weeks = apiValuePerFinishedMinute(input());
    expect(weeks).toHaveLength(12);
    expect(weeks[0]).toEqual({ start: '2026-08-02', usdPerMinute: null });
    expect(weeks.at(-1)).toEqual({ start: '2026-10-18', usdPerMinute: null });
    expect(weeks.every((week) => week.usdPerMinute === null)).toBe(true);
  });

  it("is the week's Client work API value over the minutes finished that week", () => {
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [line('edit', THIS_WEEK_TUESDAY, 6), line('revise', THIS_WEEK_TUESDAY, 4)],
        jobs: [finished(120, THIS_WEEK_TUESDAY), finished(180, '2026-10-21T08:00:00+03:00')],
      }),
    );
    // $10 of Client work over 2 + 3 = 5 minutes.
    expect(weeks.at(-1)?.usdPerMinute).toBeCloseTo(2, 6);
    expect(weeks.slice(0, -1).every((week) => week.usdPerMinute === null)).toBe(true);
  });

  it('counts only the Client work tags', () => {
    const clientTags = (Object.keys(USAGE_TAG_INFO) as UsageTag[]).filter(
      (tag) => USAGE_TAG_INFO[tag].group === 'Client work',
    );
    const otherTags = (Object.keys(USAGE_TAG_INFO) as UsageTag[]).filter(
      (tag) => USAGE_TAG_INFO[tag].group !== 'Client work',
    );
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [
          ...clientTags.map((tag) => line(tag, THIS_WEEK_TUESDAY, 1)),
          ...otherTags.map((tag) => line(tag, THIS_WEEK_TUESDAY, 100)),
        ],
        jobs: [finished(60, THIS_WEEK_TUESDAY)],
      }),
    );
    expect(weeks.at(-1)?.usdPerMinute).toBeCloseTo(clientTags.length, 6);
  });

  it('puts each side in the week it belongs to: usage where it was logged, video where it finished', () => {
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [line('edit', LAST_WEEK_TUESDAY, 9), line('edit', THIS_WEEK_TUESDAY, 5)],
        jobs: [finished(180, LAST_WEEK_TUESDAY), finished(60, THIS_WEEK_TUESDAY)],
      }),
    );
    expect(weeks.at(-2)).toEqual({ start: '2026-10-11', usdPerMinute: expect.closeTo(3, 6) });
    expect(weeks.at(-1)).toEqual({ start: '2026-10-18', usdPerMinute: expect.closeTo(5, 6) });
  });

  it('is a gap when there is usage but no video finished that week', () => {
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [line('edit', THIS_WEEK_TUESDAY, 5)],
        jobs: [finished(60, LAST_WEEK_TUESDAY)],
      }),
    );
    expect(weeks.at(-1)?.usdPerMinute).toBeNull();
    // Last week has the video but no usage line: older weeks were never logged.
    expect(weeks.at(-2)?.usdPerMinute).toBeNull();
  });

  it('is a gap when video finished but no Client work was logged, however much else was', () => {
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [line('development', THIS_WEEK_TUESDAY, 50)],
        jobs: [finished(60, THIS_WEEK_TUESDAY)],
      }),
    );
    expect(weeks.at(-1)?.usdPerMinute).toBeNull();
  });

  it('is a real $0 when Client work was logged at no value (a transcription ran no Claude)', () => {
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [line('transcribe', THIS_WEEK_TUESDAY, 0, { session: null, usage: {} })],
        jobs: [finished(60, THIS_WEEK_TUESDAY)],
      }),
    );
    expect(weeks.at(-1)?.usdPerMinute).toBe(0);
  });

  it('counts a job as finished only with an export and a finish time', () => {
    const noExport = { ...finished(60, THIS_WEEK_TUESDAY), output: null, state: 'review' as const };
    const noFinish = finished(60, null);
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [line('edit', THIS_WEEK_TUESDAY, 5)],
        jobs: [noExport, noFinish],
      }),
    );
    expect(weeks.at(-1)?.usdPerMinute).toBeNull();
  });

  it('counts an archived job, and a job with no length as no video', () => {
    const archived = finished(120, THIS_WEEK_TUESDAY, { archivedAt: '2026-10-21T00:00:00.000Z' });
    expect(
      apiValuePerFinishedMinute(
        input({ usage: [line('edit', THIS_WEEK_TUESDAY, 4)], jobs: [archived] }),
      ).at(-1)?.usdPerMinute,
    ).toBeCloseTo(2, 6);
    expect(
      apiValuePerFinishedMinute(
        input({
          usage: [line('edit', THIS_WEEK_TUESDAY, 4)],
          jobs: [finished(0, THIS_WEEK_TUESDAY)],
        }),
      ).at(-1)?.usdPerMinute,
    ).toBeNull();
  });

  it('goes by the calendar of the time zone: Saturday night is still last week, Sunday morning is this one', () => {
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [
          line('edit', '2026-10-17T23:30:00+03:00', 3),
          line('edit', '2026-10-18T00:30:00+03:00', 8),
        ],
        jobs: [
          finished(60, '2026-10-17T23:45:00+03:00'),
          finished(60, '2026-10-18T00:15:00+03:00'),
        ],
      }),
    );
    expect(weeks.at(-2)?.usdPerMinute).toBeCloseTo(3, 6);
    expect(weeks.at(-1)?.usdPerMinute).toBeCloseTo(8, 6);
  });

  it('leaves out anything older than the 12 weeks or newer than this week', () => {
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [
          line('edit', '2026-07-30T10:00:00+03:00', 5),
          line('edit', '2026-10-26T10:00:00+02:00', 5),
        ],
        jobs: [
          finished(60, '2026-07-30T10:00:00+03:00'),
          finished(60, '2026-10-26T10:00:00+02:00'),
        ],
      }),
    );
    expect(weeks.every((week) => week.usdPerMinute === null)).toBe(true);
  });

  it('prices an unknown model at $0 rather than failing', () => {
    const future = {
      'claude-future-9': { requests: 1, input: 0, output: MILLION, cacheRead: 0, cacheWrite: 0 },
    };
    const weeks = apiValuePerFinishedMinute(
      input({
        usage: [line('edit', THIS_WEEK_TUESDAY, 0, { usage: future })],
        jobs: [finished(60, THIS_WEEK_TUESDAY)],
      }),
    );
    expect(weeks.at(-1)?.usdPerMinute).toBe(0);
  });
});

describe('the Claude use section', () => {
  it('answers the contract, with and without data', () => {
    const withData = computeClaudeUseSection(
      input({
        usage: [line('edit', THIS_WEEK_TUESDAY, 5), line('development', THIS_WEEK_TUESDAY, 15)],
        jobs: [finished(120, THIS_WEEK_TUESDAY)],
      }),
    );
    expect(analyticsClaudeUseSchema.parse(withData)).toEqual(withData);
    expect(withData.apiValuePerFinishedMinute.at(-1)?.usdPerMinute).toBeCloseTo(2.5, 6);

    const answer = computeAnalytics(
      input({
        usage: [line('edit', THIS_WEEK_TUESDAY, 5)],
        jobs: [finished(120, THIS_WEEK_TUESDAY)],
      }),
    );
    expect(analyticsResponseSchema.parse(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  });
});
