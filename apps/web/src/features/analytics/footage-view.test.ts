import { type AnalyticsFootageBucket, addDays } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  footageSummary,
  footageView,
  MIN_BASELINE_HOURS,
  tickText,
  weekLabel,
} from './footage-view';

/** 12 weeks from Sunday 2 August 2026 to Sunday 18 October 2026 (this week), with these hours. */
function weeks(hours: (number | null)[]): AnalyticsFootageBucket[] {
  return hours.map((value, i) => ({ start: addDays('2026-08-02', 7 * i), hours: value }));
}

const gaps = (count = 12) => Array.from({ length: count }, () => null);

/** Twelve weeks that start at `first` hours and end at `last`, with `fill` between. */
const between = (first: number | null, last: number | null, fill = 3) =>
  weeks([first, ...Array.from({ length: 10 }, () => fill), last]);

describe('weekLabel', () => {
  it('is the month and the day of the week’s Sunday', () => {
    expect(weekLabel('2026-08-23')).toBe('Aug 23');
    expect(weekLabel('2026-10-04')).toBe('Oct 4');
  });
});

describe('tickText', () => {
  it('writes hours or minutes without float noise', () => {
    expect(tickText(0, 'h')).toBe('0 h');
    expect(tickText(3, 'h')).toBe('3 h');
    expect(tickText(0.1 + 0.2, 'h')).toBe('0.3 h');
    expect(tickText(1.5, 'h')).toBe('1.5 h');
    expect(tickText(6, 'min')).toBe('6 min');
  });
});

describe('footageSummary', () => {
  it('says "Doubled since August." when the latest week is twice the first', () => {
    expect(footageSummary(between(2.1, 4.2))).toBe('Doubled since August.');
  });

  it('says "Tripled", and then how many times, rounded down to the half', () => {
    expect(footageSummary(between(2, 6.2))).toBe('Tripled since August.');
    expect(footageSummary(between(2, 5.4))).toBe('Up 2.5× since August.');
    expect(footageSummary(between(1, 4.2))).toBe('Up 4× since August.');
    expect(footageSummary(between(1, 4.9))).toBe('Up 4.5× since August.');
  });

  it('says "Halved", or "Down by more than half" for a bigger drop', () => {
    expect(footageSummary(between(4, 2, 2))).toBe('Halved since August.');
    expect(footageSummary(between(4, 1.2, 1.2))).toBe('Down by more than half since August.');
  });

  it('is nothing for a change that is not big enough to say', () => {
    expect(footageSummary(between(2, 3.5))).toBeNull();
    expect(footageSummary(between(2, 2))).toBeNull();
    expect(footageSummary(between(2, 1.5))).toBeNull();
  });

  it('is nothing without weeks to compare', () => {
    expect(footageSummary([])).toBeNull();
    expect(footageSummary(weeks(gaps()))).toBeNull();
    expect(footageSummary(weeks(Array.from({ length: 12 }, () => 0)))).toBeNull();
  });

  it('compares with the first week that has a fair amount of footage', () => {
    const tiny = MIN_BASELINE_HOURS / 5;
    expect(footageSummary(weeks([null, tiny, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.4]))).toBe(
      'Doubled since August.',
    );
  });

  it('is nothing when the two weeks are less than four weeks apart', () => {
    expect(footageSummary(weeks([...gaps(8), 1, 1, 1, 2.5]))).toBeNull();
  });

  it('is nothing when both weeks fall in the same month', () => {
    // 2 August and 30 August are both in August, four weeks apart.
    expect(footageSummary(weeks([1, 1, 1, 1, 3, ...gaps(7)]))).toBeNull();
  });

  it('counts this week only when it is already higher, so it cannot make a drop out of a half-done week', () => {
    // The last full week was fine; this week has only just begun.
    expect(footageSummary(weeks([4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3.9, 0.3]))).toBeNull();
    // This week is already higher than the last one: it counts.
    expect(footageSummary(weeks([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.2, 2.5]))).toBe(
      'Up 2.5× since August.',
    );
    // The last full week is the one that doubled, this week has only just begun.
    expect(footageSummary(weeks([2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4.2, 0.3]))).toBe(
      'Doubled since August.',
    );
  });
});

describe('footageView', () => {
  it('plots hours, with a date every third week and "now" for this one', () => {
    const view = footageView(between(2.1, 4.2));
    expect(view.hasData).toBe(true);
    expect(view.unit).toBe('h');
    expect(view.values).toEqual(between(2.1, 4.2).map((week) => week.hours));
    expect(view.labels).toEqual([
      'Aug 2',
      '',
      '',
      'Aug 23',
      '',
      '',
      'Sep 13',
      '',
      '',
      'Oct 4',
      '',
      'now',
    ]);
    expect(view.summary).toBe('Doubled since August.');
    expect(view.ariaLabel).toBe('Footage hours per week');
  });

  it('plots minutes while every week is under an hour', () => {
    const view = footageView(weeks([...gaps(8), 0, 0, 0, 0.1]));
    expect(view.unit).toBe('min');
    expect(view.values.at(-1)).toBeCloseTo(6);
    expect(view.values[8]).toBe(0);
    expect(view.values[0]).toBeNull();
    expect(view.ariaLabel).toBe('Footage minutes per week');
  });

  it('keeps hours from one hour up', () => {
    expect(footageView(weeks([1, ...Array.from({ length: 11 }, () => 0)])).unit).toBe('h');
  });

  it('has no data when every week is a gap, and has data for real zeros', () => {
    expect(footageView(weeks(gaps())).hasData).toBe(false);
    expect(footageView(weeks(Array.from({ length: 12 }, () => 0))).hasData).toBe(true);
  });

  it('draws dots only when a week stands alone between gaps', () => {
    expect(footageView(between(2, 3)).dots).toBe(false);
    expect(footageView(weeks([...gaps(11), 1])).dots).toBe(true);
    expect(footageView(weeks([1, null, 2, 2, 2, null, null, 2, 2, 2, 2, 2])).dots).toBe(true);
  });
});

describe('footageView rows and scale', () => {
  const view = footageView(weeks([2.1, 2.5, 2.3, 3, 2.9, 3.4, 3.1, 3.7, 3.4, 4, 3.8, 4.2]));

  it('has a row per week named for the hover card, the newest not over yet', () => {
    expect(view.rows).toHaveLength(12);
    expect(view.rows[0]).toEqual({ id: '2026-08-02', title: 'Week of Aug 2', value: 2.1 });
    expect(view.rows.at(-1)?.title).toBe('Week of Oct 18 · so far');
  });

  it('draws 0 up to a round number over the biggest week, in about five steps', () => {
    expect(view.scale).toEqual({ max: 5, ticks: [0, 1, 2, 3, 4, 5] });
  });

  it('keeps a week with no data as a null value', () => {
    expect(footageView(weeks([1, null, 2])).rows.map((row) => row.value)).toEqual([1, null, 2]);
  });
});
