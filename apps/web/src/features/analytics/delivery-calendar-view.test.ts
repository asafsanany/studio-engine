import { type AnalyticsDay, addDays } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  CALENDAR_WEEKDAYS,
  DELIVERY_LEGEND_COLORS,
  DELIVERY_LEVEL_COLORS,
  dayText,
  deliveryBars,
  deliveryCalendar,
  deliveryLevel,
  monthLabels,
} from './delivery-calendar-view';

/** 91 days from Sunday 26 July 2026 (the calendar of Thursday 22 October 2026), counts by day. */
function days(count: (date: string, i: number) => number | null): AnalyticsDay[] {
  return Array.from({ length: 91 }, (_, i) => {
    const date = addDays('2026-07-26', i);
    return { date, count: count(date, i) };
  });
}

describe('deliveryLevel', () => {
  it('is 0, 1, 2 and then 3 for three and more', () => {
    expect([0, 1, 2, 3, 4, 17].map(deliveryLevel)).toEqual([0, 1, 2, 3, 3, 3]);
  });
});

describe('the colours', () => {
  it('are the board blues: a faint tint for none, then deeper to lighter', () => {
    expect(DELIVERY_LEVEL_COLORS).toEqual({
      0: 'rgba(255,255,255,0.05)',
      1: '#256abf',
      2: '#5598e7',
      3: '#86b6ef',
    });
  });

  it('have a legend from the tint of 0 through eight blues, which holds the three used', () => {
    expect(DELIVERY_LEGEND_COLORS).toHaveLength(9);
    expect(DELIVERY_LEGEND_COLORS[0]).toBe(DELIVERY_LEVEL_COLORS[0]);
    for (const level of [1, 2, 3] as const) {
      expect(DELIVERY_LEGEND_COLORS).toContain(DELIVERY_LEVEL_COLORS[level]);
    }
  });
});

describe('dayText', () => {
  it('writes the weekday, the day and the month', () => {
    expect(dayText('2026-10-20')).toBe('Tue 20 Oct');
    expect(dayText('2026-07-26')).toBe('Sun 26 Jul');
    expect(dayText('2026-10-03')).toBe('Sat 3 Oct');
  });
});

describe('deliveryCalendar', () => {
  const calendar = deliveryCalendar(days((_, i) => (i % 5 === 0 ? 2 : 0)));

  it('is 13 columns of 7 days, a week each, Sunday first', () => {
    expect(calendar.weeks).toHaveLength(13);
    for (const week of calendar.weeks) expect(week).toHaveLength(7);
    expect(calendar.weeks[0]?.[0]?.date).toBe('2026-07-26');
    expect(calendar.weeks[12]?.[6]?.date).toBe('2026-10-24');
    expect(CALENDAR_WEEKDAYS).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });

  it('gives each day its level and a tooltip', () => {
    const [first, second] = calendar.weeks[0] ?? [];
    expect(first).toMatchObject({
      date: '2026-07-26',
      count: 2,
      level: 2,
      title: 'Sun 26 Jul: 2 jobs delivered',
    });
    expect(second).toMatchObject({
      count: 0,
      level: 0,
      title: 'Mon 27 Jul: no jobs delivered',
    });
  });

  it('says "1 job" in the singular', () => {
    const one = deliveryCalendar(days((_, i) => (i === 0 ? 1 : 0)));
    expect(one.weeks[0]?.[0]?.title).toBe('Sun 26 Jul: 1 job delivered');
    expect(one.summary).toBe('1 job delivered in the last 13 weeks');
  });

  it('adds up the jobs for the screen reader', () => {
    // Days 0, 5, ..., 90 are 19 days of 2 jobs.
    expect(calendar.total).toBe(38);
    expect(calendar.summary).toBe('38 jobs delivered in the last 13 weeks');
  });

  it('leaves a day with no data empty, with no level and no tooltip', () => {
    const partial = deliveryCalendar(
      days((date) => (date > '2026-10-22' || date < '2026-10-01' ? null : 1)),
    );
    const saturday = partial.weeks[12]?.[6];
    expect(saturday).toEqual({ date: '2026-10-24', count: null, level: null, title: '' });
    expect(partial.weeks[0]?.[0]).toMatchObject({ count: null, level: null });
    expect(partial.hasData).toBe(true);
  });

  it('has no data when every day is a gap, and says so', () => {
    const empty = deliveryCalendar(days(() => null));
    expect(empty.hasData).toBe(false);
    expect(empty.total).toBeNull();
    expect(empty.summary).toBe('No jobs delivered');
  });

  it('has data, and says "No jobs", when the days are real zeros', () => {
    const quiet = deliveryCalendar(days(() => 0));
    expect(quiet.hasData).toBe(true);
    expect(quiet.total).toBe(0);
    expect(quiet.summary).toBe('No jobs delivered in the last 13 weeks');
  });
});

describe('monthLabels', () => {
  const sundays = (from: string, count: number) =>
    Array.from({ length: count }, (_, i) => addDays(from, 7 * i));

  it('names a month over the first column that starts it', () => {
    // 26 Jul is the last Sunday of July, so the first column leaves its name to August.
    expect(monthLabels(sundays('2026-07-26', 13))).toEqual([
      '',
      'Aug',
      '',
      '',
      '',
      '',
      'Sep',
      '',
      '',
      '',
      'Oct',
      '',
      '',
    ]);
  });

  it('names the first column when the next one is still in the same month', () => {
    expect(monthLabels(sundays('2026-08-02', 13))).toEqual([
      'Aug',
      '',
      '',
      '',
      '',
      'Sep',
      '',
      '',
      '',
      'Oct',
      '',
      '',
      '',
    ]);
  });

  it('copes with no columns', () => {
    expect(monthLabels([])).toEqual([]);
  });
});

describe('deliveryBars', () => {
  /** 91 days from Sunday 26 July 2026; those up to 22 October have come. */
  const all: AnalyticsDay[] = Array.from({ length: 91 }, (_, i) => {
    const date = addDays('2026-07-26', i);
    return { date, count: date > '2026-10-22' ? null : i % 4 };
  });
  const bars = deliveryBars(all);

  it('is the last 14 days that have come, today last, the days to come left off', () => {
    expect(bars.rows).toHaveLength(14);
    expect(bars.rows[0]?.id).toBe('2026-10-09');
    expect(bars.rows.at(-1)).toMatchObject({ id: '2026-10-22', title: 'Oct 22 · today' });
  });

  it('dates every third day and says today under the last', () => {
    expect(bars.labels.filter((label) => label !== '')).toEqual([
      'Oct 9',
      'Oct 12',
      'Oct 15',
      'Oct 18',
      'today',
    ]);
  });

  it('counts the jobs in whole numbers up to a round number over the busiest day', () => {
    expect(bars.scale).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(bars.hasData).toBe(true);
  });

  it('has no data when no day has come', () => {
    expect(deliveryBars(all.map((day) => ({ ...day, count: null }))).hasData).toBe(false);
  });
});
