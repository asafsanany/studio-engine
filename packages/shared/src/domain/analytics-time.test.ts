import { describe, expect, it } from 'vitest';
import {
  addDays,
  bucketIndexOf,
  bucketLastDay,
  bucketStartOf,
  bucketStartsEnding,
  calendarDays,
  DAY_MS,
  inputPeriod,
  inWindow,
  localDayOf,
  msOf,
  trailingWindows,
  weekdayOf,
  weekIndexOf,
  weekStartOf,
  weekStartOfMs,
  weekStartsEnding,
  windowDaysOf,
} from './analytics-time.ts';

const ZONE = 'Asia/Jerusalem';
/** Thursday 22 October 2026, 09:00 in Israel. */
const NOW = Date.parse('2026-10-22T09:00:00+03:00');

describe('localDayOf', () => {
  it('reads the day on the wall clock of the time zone', () => {
    // 23:30 on the 21st in New York is already the 22nd in Israel, and 02:30 on the 22nd in UTC.
    const at = Date.parse('2026-10-22T02:30:00Z');
    expect(localDayOf(at, 'UTC')).toBe('2026-10-22');
    expect(localDayOf(at, ZONE)).toBe('2026-10-22');
    expect(localDayOf(at, 'America/New_York')).toBe('2026-10-21');
  });

  it('puts the minutes around local midnight on the right side of it', () => {
    expect(localDayOf(Date.parse('2026-10-21T23:59:59+03:00'), ZONE)).toBe('2026-10-21');
    expect(localDayOf(Date.parse('2026-10-22T00:00:00+03:00'), ZONE)).toBe('2026-10-22');
  });

  it('follows daylight saving: Israel falls back on Sunday 25 October 2026', () => {
    expect(localDayOf(Date.parse('2026-10-25T00:30:00+03:00'), ZONE)).toBe('2026-10-25');
    expect(localDayOf(Date.parse('2026-10-25T23:30:00+02:00'), ZONE)).toBe('2026-10-25');
    expect(localDayOf(Date.parse('2026-10-24T23:30:00+03:00'), ZONE)).toBe('2026-10-24');
  });

  it('throws for a time zone it does not know', () => {
    expect(() => localDayOf(NOW, 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('addDays', () => {
  it('counts across month, year and leap-day edges', () => {
    expect(addDays('2026-10-22', 1)).toBe('2026-10-23');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-10-22', 0)).toBe('2026-10-22');
    expect(addDays('2026-10-22', -91)).toBe('2026-07-23');
  });

  it('is not moved by a daylight saving change', () => {
    // A 25-hour local day (25 October in Israel) is still one day.
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-03-26', 1)).toBe('2026-03-27');
  });

  it('refuses something that is not a calendar day', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('22/10/2026', 1)).toThrow(RangeError);
  });
});

describe('weekdayOf and weekStartOf: weeks start on Sunday', () => {
  it('numbers Sunday 0 to Saturday 6', () => {
    expect(weekdayOf('2026-10-18')).toBe(0);
    expect(weekdayOf('2026-10-22')).toBe(4);
    expect(weekdayOf('2026-10-24')).toBe(6);
  });

  it('gives the Sunday on or before the day', () => {
    expect(weekStartOf('2026-10-18')).toBe('2026-10-18');
    expect(weekStartOf('2026-10-19')).toBe('2026-10-18');
    expect(weekStartOf('2026-10-22')).toBe('2026-10-18');
    expect(weekStartOf('2026-10-24')).toBe('2026-10-18');
    expect(weekStartOf('2026-10-25')).toBe('2026-10-25');
  });

  it('crosses a month and a year', () => {
    expect(weekStartOf('2026-11-01')).toBe('2026-11-01');
    expect(weekStartOf('2027-01-01')).toBe('2026-12-27');
  });

  it('puts a moment in its local week', () => {
    // Saturday night in New York is already Sunday in Israel.
    const at = Date.parse('2026-10-24T22:30:00-04:00');
    expect(weekStartOfMs(at, 'America/New_York')).toBe('2026-10-18');
    expect(weekStartOfMs(at, ZONE)).toBe('2026-10-25');
  });
});

describe('weekStartsEnding', () => {
  it('lists the Sundays of the last weeks, oldest first, ending with this week', () => {
    expect(weekStartsEnding(NOW, ZONE, 4)).toEqual([
      '2026-09-27',
      '2026-10-04',
      '2026-10-11',
      '2026-10-18',
    ]);
  });

  it('has the length asked for and only Sundays', () => {
    const weeks = weekStartsEnding(NOW, ZONE, 12);
    expect(weeks).toHaveLength(12);
    for (const week of weeks) expect(weekdayOf(week)).toBe(0);
    expect(weeks[11]).toBe('2026-10-18');
    expect(weeks[0]).toBe('2026-08-02');
  });

  it('turns over at local midnight between Saturday and Sunday', () => {
    const saturday = Date.parse('2026-10-24T23:59:00+03:00');
    const sunday = Date.parse('2026-10-25T00:01:00+03:00');
    expect(weekStartsEnding(saturday, ZONE, 1)).toEqual(['2026-10-18']);
    expect(weekStartsEnding(sunday, ZONE, 1)).toEqual(['2026-10-25']);
  });
});

describe('calendarDays', () => {
  const days = calendarDays(NOW, ZONE, 13);

  it('is 13 weeks of 7 days, Sunday to Saturday', () => {
    expect(days).toHaveLength(91);
    expect(days[0]?.date).toBe('2026-07-26');
    expect(weekdayOf(days[0]?.date ?? '')).toBe(0);
    expect(days[90]?.date).toBe('2026-10-24');
    expect(weekdayOf(days[90]?.date ?? '')).toBe(6);
  });

  it('lists every day once, in order', () => {
    days.forEach((day, i) => {
      expect(day.date).toBe(addDays('2026-07-26', i));
    });
  });

  it('marks the days after today, and only them', () => {
    expect(days.filter((day) => day.future).map((day) => day.date)).toEqual([
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(days.find((day) => day.date === '2026-10-22')?.future).toBe(false);
  });

  it('lays out a column per week: slice(7 * i, 7 * i + 7)', () => {
    for (let i = 0; i < 13; i += 1) {
      const column = days.slice(7 * i, 7 * i + 7);
      expect(weekdayOf(column[0]?.date ?? '')).toBe(0);
      expect(weekdayOf(column[6]?.date ?? '')).toBe(6);
    }
  });

  it('has no future days on a Saturday', () => {
    const saturday = Date.parse('2026-10-24T20:00:00+03:00');
    expect(calendarDays(saturday, ZONE, 13).some((day) => day.future)).toBe(false);
  });
});

describe('weekIndexOf', () => {
  const weeks = weekStartsEnding(NOW, ZONE, 4);

  it('says which week a moment is in', () => {
    expect(weekIndexOf(Date.parse('2026-10-18T00:10:00+03:00'), ZONE, weeks)).toBe(3);
    expect(weekIndexOf(Date.parse('2026-10-17T23:50:00+03:00'), ZONE, weeks)).toBe(2);
    expect(weekIndexOf(Date.parse('2026-09-28T12:00:00+03:00'), ZONE, weeks)).toBe(0);
  });

  it('says -1 for a moment older or newer than the weeks', () => {
    expect(weekIndexOf(Date.parse('2026-09-26T12:00:00+03:00'), ZONE, weeks)).toBe(-1);
    expect(weekIndexOf(Date.parse('2026-10-25T12:00:00+02:00'), ZONE, weeks)).toBe(-1);
  });
});

describe('trailingWindows and inWindow', () => {
  const { current, before } = trailingWindows(NOW, 30);

  it('are the 30 days up to now and the 30 days before them', () => {
    expect(current).toEqual({ after: NOW - 30 * DAY_MS, upTo: NOW });
    expect(before).toEqual({ after: NOW - 60 * DAY_MS, upTo: NOW - 30 * DAY_MS });
  });

  it('leave nothing out and count nothing twice', () => {
    expect(before.upTo).toBe(current.after);
    const edge = current.after;
    expect(inWindow(edge, current)).toBe(false);
    expect(inWindow(edge, before)).toBe(true);
    expect(inWindow(edge + 1, current)).toBe(true);
    expect(inWindow(NOW, current)).toBe(true);
    expect(inWindow(NOW + 1, current)).toBe(false);
    expect(inWindow(before.after, before)).toBe(false);
  });
});

describe('msOf', () => {
  it('reads a timestamp, and gives null for none or one it cannot read', () => {
    expect(msOf('2026-10-22T06:00:00.000Z')).toBe(Date.parse('2026-10-22T06:00:00.000Z'));
    expect(msOf(null)).toBeNull();
    expect(msOf(undefined)).toBeNull();
    expect(msOf('yesterday')).toBeNull();
  });
});

describe('the period', () => {
  it('is the month unless an input asks for the week', () => {
    expect(inputPeriod({})).toBe('month');
    expect(inputPeriod({ period: 'month' })).toBe('month');
    expect(inputPeriod({ period: 'week' })).toBe('week');
  });

  it('has a window of 30 days in the month and 7 in the week', () => {
    expect(windowDaysOf('month')).toBe(30);
    expect(windowDaysOf('week')).toBe(7);
  });
});

describe('buckets: a week in the month period, a day in the week period', () => {
  it('start on the Sunday of the week (month) or on the day itself (week)', () => {
    expect(bucketStartOf('2026-10-22', 'month')).toBe('2026-10-18');
    expect(bucketStartOf('2026-10-18', 'month')).toBe('2026-10-18');
    expect(bucketStartOf('2026-10-22', 'week')).toBe('2026-10-22');
  });

  it('end on the Saturday of the week (month) or on the same day (week)', () => {
    expect(bucketLastDay('2026-10-18', 'month')).toBe('2026-10-24');
    expect(bucketLastDay('2026-10-22', 'week')).toBe('2026-10-22');
  });

  it('are the last weeks, Sundays, in the month period: the weeks the old functions give', () => {
    expect(bucketStartsEnding(NOW, ZONE, 'month', 8)).toEqual(weekStartsEnding(NOW, ZONE, 8));
    expect(bucketStartsEnding(NOW, ZONE, 'month', 3)).toEqual([
      '2026-10-04',
      '2026-10-11',
      '2026-10-18',
    ]);
  });

  it('are the last days, today last, in the week period', () => {
    expect(bucketStartsEnding(NOW, ZONE, 'week', 4)).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
    expect(bucketStartsEnding(NOW, ZONE, 'week', 14)).toHaveLength(14);
    expect(bucketStartsEnding(NOW, ZONE, 'week', 14)[0]).toBe('2026-10-09');
  });

  it('count days, not 24 hours, across the clocks changing (25 October 2026 in Israel)', () => {
    const afterChange = Date.parse('2026-10-27T09:00:00+02:00');
    expect(bucketStartsEnding(afterChange, ZONE, 'week', 5)).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
  });

  it('are on the calendar of the time zone', () => {
    // 22:30 UTC on the 21st is 01:30 on the 22nd in Israel, and 18:30 on the 21st in New York.
    const late = Date.parse('2026-10-21T22:30:00Z');
    expect(bucketStartsEnding(late, ZONE, 'week', 1)).toEqual(['2026-10-22']);
    expect(bucketStartsEnding(late, 'America/New_York', 'week', 1)).toEqual(['2026-10-21']);
  });

  it('find the bucket a moment falls in, or -1 for none', () => {
    const days = bucketStartsEnding(NOW, ZONE, 'week', 14);
    expect(bucketIndexOf(NOW, ZONE, 'week', days)).toBe(13);
    expect(bucketIndexOf(Date.parse('2026-10-09T00:00:00+03:00'), ZONE, 'week', days)).toBe(0);
    expect(bucketIndexOf(Date.parse('2026-10-08T23:59:59+03:00'), ZONE, 'week', days)).toBe(-1);
    // Local midnight is the start of a day, whatever UTC says.
    expect(bucketIndexOf(Date.parse('2026-10-21T21:00:00Z'), ZONE, 'week', days)).toBe(13);
    expect(bucketIndexOf(Date.parse('2026-10-21T20:59:59Z'), ZONE, 'week', days)).toBe(12);

    const weeks = bucketStartsEnding(NOW, ZONE, 'month', 8);
    expect(bucketIndexOf(NOW, ZONE, 'month', weeks)).toBe(7);
    expect(bucketIndexOf(Date.parse('2026-10-17T12:00:00+03:00'), ZONE, 'month', weeks)).toBe(6);
    expect(bucketIndexOf(Date.parse('2026-08-01T12:00:00+03:00'), ZONE, 'month', weeks)).toBe(-1);
  });
});
