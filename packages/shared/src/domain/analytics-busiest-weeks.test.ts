import { describe, expect, it } from 'vitest';
import { ANALYTICS_SIZES, analyticsClaudeUseSchema, type LimitSnapshot } from './analytics.ts';
import {
  computeBusiest,
  computeBusiestDays,
  computeBusiestWeeks,
  computeClaudeUseSection,
} from './analytics-claude-use.ts';
import { addDays, DAY_MS } from './analytics-time.ts';

// "Busiest week": the highest weekly use in each of the last 8 weekly limit windows.

const NOW = Date.parse('2026-10-22T09:00:00Z');
// The weekly limit of these tests resets on Saturdays at 18:00 UTC.
const RESET = Date.parse('2026-10-24T18:00:00Z');
const WEEK = 7 * DAY_MS;
const ZONE = 'UTC';

/** A reading of the weekly limit: `use` of it is used, and it resets at `reset` (ms). */
function reading(
  use: number | null,
  reset: number,
  { status = 'allowed', at = NOW }: { status?: string; at?: number } = {},
): LimitSnapshot {
  return {
    at: new Date(at).toISOString(),
    status,
    fiveHour: { utilization: 0.2, resetsAt: new Date(NOW + 3_600_000).toISOString() },
    sevenDay: use === null ? null : { utilization: use, resetsAt: new Date(reset).toISOString() },
  };
}

const peaks = (limits: readonly LimitSnapshot[], now = NOW) =>
  computeBusiestWeeks(limits, now, ZONE).map((week) => week.peak);

describe('the windows', () => {
  it('are 8, oldest first, with the newest the only one still open', () => {
    const weeks = computeBusiestWeeks([reading(0.4, RESET)], NOW, ZONE);

    expect(weeks).toHaveLength(ANALYTICS_SIZES.month.limit);
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
  });

  it('end at the newest reset seen, each 7 days before the next, and start on the day 7 days before their end', () => {
    const weeks = computeBusiestWeeks([reading(0.4, RESET), reading(0.2, RESET - WEEK)], NOW, ZONE);

    // The newest window ends Sat 24 Oct 18:00 UTC, so it starts on Sat 17 Oct.
    expect(weeks[7]?.start).toBe('2026-10-17');
    expect(weeks[6]?.start).toBe('2026-10-10');
    expect(weeks[0]?.start).toBe('2026-08-29');
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i]?.start).toBe(addDays(weeks[i - 1]?.start ?? '', 7));
    }
  });

  it('start on the day of the engine’s time zone, not of UTC', () => {
    // A window that ends at 01:00 UTC on Sun 25 Oct began at 18:00 on Sat 17 Oct in Los Angeles
    // (UTC-7) and at 04:00 on Sun 18 Oct in Israel (UTC+3).
    const reset = Date.parse('2026-10-25T01:00:00Z');
    expect(computeBusiestWeeks([reading(0.4, reset)], NOW, 'America/Los_Angeles')[7]?.start).toBe(
      '2026-10-17',
    );
    expect(computeBusiestWeeks([reading(0.4, reset)], NOW, 'Asia/Jerusalem')[7]?.start).toBe(
      '2026-10-18',
    );
  });

  it('with no reading at all end now, as an empty page does, and say nothing of any week', () => {
    const weeks = computeBusiestWeeks([], NOW, ZONE);

    // The newest window ends now (Thu 22 Oct), so it starts on Thu 15 Oct.
    expect(weeks[7]?.start).toBe('2026-10-15');
    expect(weeks[0]?.start).toBe('2026-08-27');
    expect(weeks.every((week) => week.peak === null && !week.hitLimit)).toBe(true);
    expect(weeks[7]?.current).toBe(true);
  });

  it('move on to the week now is in when the newest reset seen is already past', () => {
    // The last reading was in the window that reset on Sat 24 Oct; it is now Thu 29 Oct.
    const later = Date.parse('2026-10-29T09:00:00Z');
    const weeks = computeBusiestWeeks([reading(0.6, RESET)], later, ZONE);

    expect(weeks[7]).toMatchObject({ start: '2026-10-24', peak: null, current: true });
    expect(weeks[6]).toMatchObject({ start: '2026-10-17', peak: 0.6 });
    // Many weeks later too: the open window is always the one that ends after now, so it starts
    // within the 7 days before now.
    const muchLater = Date.parse('2026-12-01T09:00:00Z');
    const far = computeBusiestWeeks([reading(0.6, RESET)], muchLater, ZONE);
    const farStart = far[7]?.start ?? '';
    expect(farStart <= '2026-12-01' && farStart > '2026-11-23').toBe(true);
  });

  it('make the section valid for the page', () => {
    const section = computeClaudeUseSection({
      now: NOW,
      timeZone: 'UTC',
      jobs: [],
      stepRuns: [],
      sentNotes: [],
      deliveries: [],
      usage: [],
      limits: [reading(0.3, RESET)],
      noteTopics: {},
    });

    expect(analyticsClaudeUseSchema.parse(section).busiest[7]?.peak).toBe(0.3);
  });
});

describe('the peak of a window', () => {
  it('is the highest weekly use read in it, whatever order the readings come in', () => {
    const limits = [
      reading(0.2, RESET),
      reading(0.55, RESET),
      reading(0.4, RESET),
      reading(0.9, RESET - WEEK),
      reading(0.1, RESET - WEEK),
    ];

    expect(peaks(limits)).toEqual([null, null, null, null, null, null, 0.9, 0.55]);
    expect(peaks([...limits].reverse())).toEqual(peaks(limits));
  });

  it('is null for a week with no reading, a gap and not a zero', () => {
    const limits = [reading(0.3, RESET), reading(0.5, RESET - 3 * WEEK)];

    expect(peaks(limits)).toEqual([null, null, null, null, 0.5, null, null, 0.3]);
  });

  it('keeps a real zero', () => {
    expect(peaks([reading(0, RESET)])[7]).toBe(0);
  });

  it('can be above 1, when the use went over', () => {
    expect(peaks([reading(1.04, RESET)])[7]).toBe(1.04);
  });

  it('puts readings in the window their weekly limit resets in, even when the weeks are not exactly 7 days apart', () => {
    // The limit resets 7 days after the first use of a window, so resets can be 7 days and more apart.
    const limits = [
      reading(0.3, RESET),
      reading(0.5, RESET - 9 * DAY_MS),
      reading(0.7, RESET - 16 * DAY_MS),
      reading(0.8, RESET - 22 * DAY_MS - 3_600_000),
    ];

    expect(peaks(limits)).toEqual([null, null, null, null, 0.8, 0.7, 0.5, 0.3]);
  });

  it('puts a reset exactly 7 days before the newest in the window before it, and one a second later in the newest', () => {
    expect(peaks([reading(0.3, RESET), reading(0.5, RESET - WEEK)])).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      0.5,
      0.3,
    ]);
    expect(peaks([reading(0.3, RESET), reading(0.5, RESET - WEEK + 1000)])[7]).toBe(0.5);
  });

  it('leaves out readings older than the 8 windows, and readings with no weekly window', () => {
    const limits = [
      reading(0.9, RESET - 8 * WEEK),
      reading(0.9, RESET - 20 * WEEK),
      reading(null, RESET),
      reading(0.25, RESET),
    ];

    expect(peaks(limits)).toEqual([null, null, null, null, null, null, null, 0.25]);
  });

  it('ignores a reading whose time cannot be read', () => {
    const odd = reading(0.9, RESET);
    if (odd.sevenDay) odd.sevenDay.resetsAt = 'soon';

    expect(peaks([odd, reading(0.1, RESET)])[7]).toBe(0.1);
  });
});

describe('the week the limit was hit', () => {
  const hit = (limits: readonly LimitSnapshot[]) =>
    computeBusiestWeeks(limits, NOW, ZONE).map((week) => week.hitLimit);

  it('is the window with a reading Claude refused, or with the weekly use at 100%', () => {
    const limits = [
      reading(0.5, RESET - WEEK),
      reading(0.95, RESET - WEEK, { status: 'rejected' }),
      reading(0.5, RESET - 2 * WEEK),
      reading(1, RESET - 2 * WEEK),
      reading(0.8, RESET),
    ];

    expect(hit(limits)).toEqual([false, false, false, false, false, true, true, false]);
  });

  it('stays red for the whole week once a reading hit, whatever came after', () => {
    const limits = [
      reading(1, RESET, { at: NOW - 2 * DAY_MS }),
      reading(0.3, RESET, { at: NOW - DAY_MS }),
    ];

    expect(hit(limits)[7]).toBe(true);
    expect(peaks(limits)[7]).toBe(1);
  });

  it('is not a warning, nor 99%', () => {
    const limits = [
      reading(0.97, RESET, { status: 'allowed_warning' }),
      reading(0.99, RESET - WEEK),
    ];

    expect(hit(limits)).toEqual([false, false, false, false, false, false, false, false]);
  });
});

describe('Busiest day (the week period)', () => {
  const ZONE_IL = 'Asia/Jerusalem';
  /** A reading of the five-hour limit taken at `at` (ms), `use` of it used. */
  function fiveHour(
    use: number | null,
    at: number,
    { status = 'allowed' }: { status?: string } = {},
  ): LimitSnapshot {
    return {
      at: new Date(at).toISOString(),
      status,
      fiveHour:
        use === null
          ? null
          : { utilization: use, resetsAt: new Date(at + 3_600_000).toISOString() },
      sevenDay: { utilization: 0.3, resetsAt: new Date(RESET).toISOString() },
    };
  }
  const days = (limits: readonly LimitSnapshot[], now = NOW) =>
    computeBusiestDays(limits, now, ZONE);

  it('are the last 14 days, oldest first, with today the only one still open', () => {
    const bars = days([fiveHour(0.4, NOW)]);

    expect(bars).toHaveLength(ANALYTICS_SIZES.week.limit);
    expect(bars.map((bar) => bar.start)).toEqual([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
    expect(bars.map((bar) => bar.current)).toEqual([...Array(13).fill(false), true]);
  });

  it('have as peak the highest five-hour use read on the day, whatever order the readings come in', () => {
    const limits = [
      fiveHour(0.2, Date.parse('2026-10-21T08:00:00Z')),
      fiveHour(0.7, Date.parse('2026-10-21T13:00:00Z')),
      fiveHour(0.4, Date.parse('2026-10-21T18:00:00Z')),
      fiveHour(0.1, Date.parse('2026-10-20T09:00:00Z')),
      fiveHour(0.35, NOW),
    ];

    const peakOf = (bars: ReturnType<typeof days>) => bars.map((bar) => bar.peak).slice(-3);
    expect(peakOf(days(limits))).toEqual([0.1, 0.7, 0.35]);
    expect(peakOf(days([...limits].reverse()))).toEqual(peakOf(days(limits)));
  });

  it('is null for a day with no reading (a gap, not a zero), and 0 for a real zero', () => {
    const bars = days([fiveHour(0, Date.parse('2026-10-20T09:00:00Z'))]);

    expect(bars.at(-3)?.peak).toBe(0);
    expect(bars.at(-2)?.peak).toBeNull();
    expect(bars.at(-1)?.peak).toBeNull();
  });

  it('leaves out readings with no five-hour window, older than the 14 days or from tomorrow on', () => {
    const limits = [
      fiveHour(null, NOW),
      fiveHour(0.9, Date.parse('2026-10-08T12:00:00Z')),
      fiveHour(0.9, Date.parse('2026-10-23T12:00:00Z')),
      fiveHour(0.25, NOW),
    ];

    const bars = days(limits);
    expect(bars.map((bar) => bar.peak)).toEqual([...Array(13).fill(null), 0.25]);
  });

  it('puts a reading on the day of the engine’s time zone, not of UTC', () => {
    // 22:30 UTC on Wed 21 Oct is 01:30 on Thu 22 Oct in Israel.
    const late = fiveHour(0.6, Date.parse('2026-10-21T22:30:00Z'));

    expect(computeBusiestDays([late], NOW, ZONE).at(-2)?.peak).toBe(0.6);
    const israel = computeBusiestDays([late], NOW, ZONE_IL);
    expect(israel.at(-1)?.start).toBe('2026-10-22');
    expect(israel.at(-1)?.peak).toBe(0.6);
    expect(israel.at(-2)?.peak).toBeNull();
  });

  it('are red on a day with a reading Claude refused, or with the five-hour use at 100%', () => {
    const limits = [
      fiveHour(0.5, Date.parse('2026-10-20T08:00:00Z')),
      fiveHour(0.95, Date.parse('2026-10-20T12:00:00Z'), { status: 'rejected' }),
      fiveHour(1, Date.parse('2026-10-18T12:00:00Z')),
      fiveHour(0.8, NOW),
    ];

    // Sun 18 Oct (100% of the five hours), Tue 20 Oct (Claude said no); not the rest.
    const hit = days(limits).map((bar) => bar.hitLimit);
    expect(hit.slice(-5)).toEqual([true, false, true, false, false]);
    expect(hit.slice(0, -5).some(Boolean)).toBe(false);
  });

  it('stay red for the whole day once a reading hit, whatever came after', () => {
    const limits = [
      fiveHour(1, Date.parse('2026-10-21T08:00:00Z')),
      fiveHour(0.3, Date.parse('2026-10-21T20:00:00Z')),
    ];

    expect(days(limits).at(-2)).toMatchObject({ hitLimit: true, peak: 1 });
  });

  it('are not red for a warning, nor for 99%', () => {
    const limits = [
      fiveHour(0.97, Date.parse('2026-10-21T08:00:00Z'), { status: 'allowed_warning' }),
      fiveHour(0.99, NOW),
    ];

    expect(days(limits).some((bar) => bar.hitLimit)).toBe(false);
  });

  it('are not touched by the weekly use: a week at 100% with a calm day is not red', () => {
    const limit: LimitSnapshot = {
      at: new Date(NOW).toISOString(),
      status: 'allowed',
      fiveHour: { utilization: 0.2, resetsAt: new Date(NOW + 3_600_000).toISOString() },
      sevenDay: { utilization: 1, resetsAt: new Date(RESET).toISOString() },
    };

    expect(days([limit]).at(-1)).toMatchObject({ peak: 0.2, hitLimit: false });
  });

  it('are what computeBusiest gives for the week period, and the weekly windows for the month', () => {
    const limits = [fiveHour(0.4, NOW)];

    expect(computeBusiest(limits, NOW, ZONE, 'week')).toEqual(days(limits));
    expect(computeBusiest(limits, NOW, ZONE, 'month')).toEqual(
      computeBusiestWeeks(limits, NOW, ZONE),
    );
  });

  it('make the section valid for the page, in the week period', () => {
    const section = computeClaudeUseSection({
      now: NOW,
      period: 'week',
      timeZone: ZONE,
      jobs: [],
      stepRuns: [],
      sentNotes: [],
      deliveries: [],
      usage: [],
      limits: [fiveHour(0.3, NOW)],
      noteTopics: {},
    });

    expect(section.busiest).toHaveLength(ANALYTICS_SIZES.week.limit);
    expect(section.busiest.at(-1)?.peak).toBe(0.3);
    expect(section.apiValuePerFinishedMinute).toHaveLength(ANALYTICS_SIZES.week.value);
  });
});

describe('what the app spent', () => {
  // The app moved to the API key on 23 Oct, so the newest window (17 to 23 Oct) is the first with credits.
  const spend = new Map([
    ['2026-10-17', 20],
    ['2026-10-23', 10],
  ]);

  it('is each window’s spend over the month’s credits, null for a window before the API key', () => {
    const weeks = computeBusiestWeeks([reading(0.4, RESET)], NOW, ZONE, spend);

    expect(weeks[7]?.apiShare).toBeCloseTo(30 / 200, 10);
    // 10 to 16 Oct ended before the switch: no data, not 0.
    expect(weeks[6]?.apiShare).toBeNull();
    expect(weeks.slice(0, 7).every((week) => week.apiShare === null)).toBe(true);
  });

  it('is 0 for a window after the API key in which nothing was spent', () => {
    const later = Date.parse('2026-11-05T09:00:00Z');
    const weeks = computeBusiestWeeks([reading(0.4, RESET + 2 * WEEK)], later, ZONE, spend);

    // The newest window runs 31 Oct to 6 Nov; the one before it, 24 to 30 Oct, nothing spent.
    expect(weeks[7]?.apiShare).toBe(0);
    expect(weeks[6]?.apiShare).toBe(0);
    // 17 to 23 Oct holds both lines.
    expect(weeks[5]?.apiShare).toBeCloseTo(30 / 200, 10);
  });

  it('is each day’s spend by day, null for a day before the API key', () => {
    const now = Date.parse('2026-10-26T09:00:00Z');
    const bars = computeBusiestDays([], now, ZONE, spend);

    expect(bars).toHaveLength(ANALYTICS_SIZES.week.limit);
    const share = (day: string) => bars.find((bar) => bar.start === day)?.apiShare;
    expect(share('2026-10-22')).toBeNull();
    expect(share('2026-10-23')).toBeCloseTo(10 / 200, 10);
    expect(share('2026-10-24')).toBe(0);
    // 17 Oct is before the switch: the line on it is not counted, the day is a gap.
    expect(share('2026-10-17')).toBeNull();
  });

  it('is nothing at all when no map is given: every window after the switch is 0, before it null', () => {
    const weeks = computeBusiestWeeks([reading(0.4, RESET)], NOW, ZONE);
    expect(weeks[7]?.apiShare).toBe(0);
    expect(weeks[6]?.apiShare).toBeNull();
  });

  it('comes from the usage log in the section', () => {
    const now = Date.parse('2026-10-26T09:00:00Z');
    const section = computeClaudeUseSection({
      now,
      period: 'week',
      timeZone: ZONE,
      jobs: [],
      stepRuns: [],
      sentNotes: [],
      deliveries: [],
      usage: [
        {
          at: '2026-10-24T10:00:00.000Z',
          from: null,
          source: 'app',
          tag: 'edit',
          did: 'Did edit',
          session: 's1',
          usage: {
            'claude-opus-5-5': {
              requests: 1,
              input: 0,
              output: 1_000_000,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
      ],
      limits: [],
      noteTopics: {},
    });

    // A million output tokens of Opus 5.5 is $20: a tenth of the $200.
    expect(section.busiest.find((bar) => bar.start === '2026-10-24')?.apiShare).toBeCloseTo(0.1, 6);
  });
});
