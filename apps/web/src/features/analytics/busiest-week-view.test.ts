import type { AnalyticsLimitBucket } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { busiestWeekFooter, busiestWeekView, OPEN_WINDOW_OPACITY } from './busiest-week-view';
import { CHART_ORANGE, CHART_RED } from './charts/chart-colors';

const DAY = 86_400_000;
// Weekly windows that start on Saturdays, the newest on 17 Oct (it ends on the 24th).
const NEWEST_START = Date.UTC(2026, 9, 17);
// Days, the newest 22 Oct.
const TODAY = Date.UTC(2026, 9, 22);

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Eight weekly windows, oldest first, with the given peaks (`null` for a gap), the ones that hit
 * the limit and what the app spent in each (a share of the credits; none by default).
 */
function windows(
  peaks: (number | null)[],
  hits: number[] = [],
  spent: (number | null)[] = [],
): AnalyticsLimitBucket[] {
  return peaks.map((peak, i) => ({
    start: dayOf(NEWEST_START - 7 * DAY * (peaks.length - 1 - i)),
    peak,
    hitLimit: hits.includes(i),
    current: i === peaks.length - 1,
    apiShare: spent[i] ?? null,
  }));
}

/** Fourteen days, oldest first (the week period). */
function days(
  peaks: (number | null)[],
  hits: number[] = [],
  spent: (number | null)[] = [],
): AnalyticsLimitBucket[] {
  return peaks.map((peak, i) => ({
    start: dayOf(TODAY - DAY * (peaks.length - 1 - i)),
    peak,
    hitLimit: hits.includes(i),
    current: i === peaks.length - 1,
    apiShare: spent[i] ?? null,
  }));
}

const WEEK_BASE =
  'Plan: the highest use each week. API: what the app spent that week, of the month’s credits.';
const DAY_BASE =
  'Plan: the highest five-hour use each day. API: what the app spent that day, of the month’s credits.';

describe('busiestWeekFooter', () => {
  it('says what the bars are, and names the week the limit was hit', () => {
    expect(busiestWeekFooter([])).toBe(WEEK_BASE);
    expect(busiestWeekFooter(['Sep 12'])).toBe(`${WEEK_BASE} Week of Sep 12 hit the limit (red).`);
    expect(busiestWeekFooter(['Sep 12', 'Oct 3'])).toBe(
      `${WEEK_BASE} Weeks of Sep 12 and Oct 3 hit the limit (red).`,
    );
    expect(busiestWeekFooter(['Sep 12', 'Oct 3', 'Oct 10'])).toBe(
      `${WEEK_BASE} Weeks of Sep 12, Oct 3 and Oct 10 hit the limit (red).`,
    );
  });

  it('says what the bars are by day, and names the days the limit was hit', () => {
    expect(busiestWeekFooter([], 'week')).toBe(DAY_BASE);
    expect(busiestWeekFooter(['Oct 15'], 'week')).toBe(`${DAY_BASE} Oct 15 hit the limit (red).`);
    expect(busiestWeekFooter(['Oct 15', 'Oct 20'], 'week')).toBe(
      `${DAY_BASE} Oct 15 and Oct 20 hit the limit (red).`,
    );
  });
});

describe('busiestWeekView', () => {
  const peaks = [0.52, 0.67, 1, 0.34, 0.3, 0.84, 0.36, 0.32];
  const view = busiestWeekView(windows(peaks, [2]));

  it('takes the peaks as the bars, a gap staying a gap', () => {
    expect(view.hasData).toBe(true);
    expect(view.values).toEqual(peaks);
    expect(busiestWeekView(windows([null, 0.4, null, null, 0.2, null, null, null])).values).toEqual(
      [null, 0.4, null, null, 0.2, null, null, null],
    );
  });

  it('has no data when no window has a reading and the app spent nothing', () => {
    expect(busiestWeekView(windows(Array(8).fill(null))).hasData).toBe(false);
    // A window with nothing spent still has an `apiShare` of 0: that is not data.
    expect(busiestWeekView(windows(Array(8).fill(null), [], Array(8).fill(0))).hasData).toBe(false);
  });

  it('has data when only the app spent something, the plan having no reading', () => {
    const spent = [null, null, null, 0, 0.04, 0, 0.12, 0.2];
    const onlyApi = busiestWeekView(windows(Array(8).fill(null), [], spent));
    expect(onlyApi.hasData).toBe(true);
    expect(onlyApi.values).toEqual(Array(8).fill(null));
  });

  it('takes what the app spent as the other bar, a window before the API key staying a gap', () => {
    const spent = [null, null, null, 0, 0.04, 0, 0.12, 0.2];
    expect(busiestWeekView(windows(peaks, [2], spent)).apiValues).toEqual(spent);
  });

  it('draws the week the limit was hit in red and the rest orange', () => {
    expect(view.colors).toEqual([
      CHART_ORANGE,
      CHART_ORANGE,
      CHART_RED,
      CHART_ORANGE,
      CHART_ORANGE,
      CHART_ORANGE,
      CHART_ORANGE,
      CHART_ORANGE,
    ]);
    expect(CHART_RED).toBe('#d03b3b');
  });

  it('draws the window that is not over yet lighter', () => {
    expect(view.opacities).toEqual([1, 1, 1, 1, 1, 1, 1, OPEN_WINDOW_OPACITY]);
  });

  it('puts a date under every second bar from the oldest, and "now" under the open window', () => {
    // As on the board: the week of Aug 29, Sep 12, Sep 26, Oct 10, then now.
    expect(view.labels).toEqual(['Aug 29', '', 'Sep 12', '', 'Sep 26', '', 'Oct 10', 'now']);
  });

  it('names the week it hit the limit by the day it started on', () => {
    expect(view.footer).toBe(`${WEEK_BASE} Week of Sep 12 hit the limit (red).`);
    expect(busiestWeekView(windows(peaks)).footer).toBe(WEEK_BASE);
  });
});

describe('busiestWeekView by day (the week period)', () => {
  const peaks = [0.5, 0.6, null, 0.3, 0.4, 0.5, 0.2, 0.7, 0.8, 1, 0.5, 0.4, 0.6, 0.3];
  const view = busiestWeekView(days(peaks, [9]), 'week');

  it('has a bar for each of the 14 days, a gap staying a gap, and the day the limit was hit in red', () => {
    expect(view.hasData).toBe(true);
    expect(view.values).toEqual(peaks);
    expect(view.colors[9]).toBe(CHART_RED);
    expect(view.colors.filter((color) => color === CHART_RED)).toHaveLength(1);
  });

  it('draws today lighter', () => {
    expect(view.opacities.at(-1)).toBe(OPEN_WINDOW_OPACITY);
    expect(view.opacities.slice(0, -1).every((opacity) => opacity === 1)).toBe(true);
  });

  it('puts a date under every third bar from the oldest, and "today" under the last', () => {
    // Oct 9, 12, 15 and 18, then today: the 21st is left out, it would touch "today".
    expect(view.labels).toEqual([
      'Oct 9',
      '',
      '',
      'Oct 12',
      '',
      '',
      'Oct 15',
      '',
      '',
      'Oct 18',
      '',
      '',
      '',
      'today',
    ]);
  });

  it('names the day it hit the limit', () => {
    expect(view.footer).toBe(`${DAY_BASE} Oct 18 hit the limit (red).`);
  });

  it('has no data when no day has a reading', () => {
    expect(busiestWeekView(days(Array(14).fill(null)), 'week').hasData).toBe(false);
  });
});

describe('busiestWeekView rows (the hover card)', () => {
  it('dates a weekly window by its seven days, and says the open one is not over', () => {
    const { rows } = busiestWeekView(windows([0.5, 0.6, 0.7], [], [0.1, 0.2, 0.05]), 'month', 200);
    expect(rows.map((row) => row.title)).toEqual([
      'Oct 3 – Oct 9',
      'Oct 10 – Oct 16',
      'Oct 17 – Oct 23 · so far',
    ]);
    expect(rows.at(-1)).toMatchObject({ id: '2026-10-17', plan: 0.7, api: 0.05, opacity: 0.55 });
  });

  it('says what the app spent in dollars when the credits are known, and a gap as null', () => {
    const known = busiestWeekView(windows([0.5, null], [], [0.12, null]), 'month', 200).rows;
    expect(known[0]?.apiUsd).toBeCloseTo(24, 5);
    expect(known[1]).toMatchObject({ api: null, apiUsd: null, plan: null });
    const unknown = busiestWeekView(windows([0.5], [], [0.12]), 'month').rows;
    expect(unknown[0]?.apiUsd).toBeNull();
  });

  it('colours the plan’s bar red for a window that hit the limit', () => {
    const { rows } = busiestWeekView(windows([0.5, 1, 0.3], [1]), 'month');
    expect(rows.map((row) => row.planColor)).toEqual([CHART_ORANGE, CHART_RED, CHART_ORANGE]);
    expect(rows[1]?.hitLimit).toBe(true);
  });

  it('is a day each in the week period, with today named', () => {
    const { rows } = busiestWeekView(days([0.2, 0.9, 0.4]), 'week');
    expect(rows.map((row) => row.title)).toEqual(['Oct 20', 'Oct 21', 'Oct 22 · today']);
  });
});
