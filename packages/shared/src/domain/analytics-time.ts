import { ANALYTICS_SIZES, type AnalyticsPeriod, DEFAULT_ANALYTICS_PERIOD } from './analytics.ts';
import { isCalendarDay } from './money.ts';

// Days, weeks and windows for the Analytics page (Analytics plan, "Data and definitions"): local
// time in the engine's time zone, calendar weeks that start on Sunday. A day is a calendar day
// written YYYY-MM-DD and a week is named by its Sunday. Days are counted as plain dates (through
// UTC arithmetic on the year, month and day), never through a Date at local midnight, so a daylight
// saving change cannot make a day 23 or 25 hours long here. Pure functions; the time zone is an
// input.
//
// The page's charts are drawn in buckets: calendar weeks in the month period and calendar days in
// the week period. A bucket is named by its first day (a Sunday, or the day itself), and the
// `bucket...` functions below are the week functions for either, so a section does not care which
// period it is working out.

/** Milliseconds in a day (a plain 24 hours: it is used for the "last 30 days" and "last 7 days" windows). */
export const DAY_MS = 86_400_000;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day a moment (milliseconds since the epoch) falls on, on a wall clock set to
 * `timeZone` (an IANA name such as "Asia/Jerusalem"), as YYYY-MM-DD. Throws a RangeError for a time
 * zone the runtime does not know.
 */
export function localDayOf(ms: number, timeZone: string): string {
  let formatter = dayFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, formatter);
  }
  let year = '';
  let month = '';
  let day = '';
  for (const part of formatter.formatToParts(ms)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** How far the wall clock of `timeZone` is ahead of UTC at a moment, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  let formatter = wallFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    wallFormatters.set(timeZone, formatter);
  }
  const wall: Record<string, number> = {};
  for (const part of formatter.formatToParts(ms)) {
    if (part.type !== 'literal') wall[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    wall.year ?? 1970,
    (wall.month ?? 1) - 1,
    wall.day ?? 1,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The moment a calendar day starts (its midnight) on the wall clock of `timeZone`, in milliseconds
 * since the epoch. For counting from the start of a day or a month; a day is still not a fixed
 * number of hours (daylight saving), which is why this asks the time zone.
 */
export function startOfLocalDay(day: string, timeZone: string): number {
  const utc = utcOf(day);
  const first = utc - offsetAt(utc, timeZone);
  // The offset at the first guess is the one in force at midnight, even across a change.
  return utc - offsetAt(first, timeZone);
}

/** The day as UTC milliseconds at midnight: only for counting days, never for a clock time. */
function utcOf(day: string): number {
  if (!isCalendarDay(day)) {
    throw new RangeError(`Not a calendar day written YYYY-MM-DD: ${JSON.stringify(day)}`);
  }
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
}

/** The calendar day `delta` days after `day` (before it when negative). */
export function addDays(day: string, delta: number): string {
  return new Date(utcOf(day) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** The number of days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS);
}

/** The day of the week of `day`: 0 for Sunday, up to 6 for Saturday. */
export function weekdayOf(day: string): number {
  return new Date(utcOf(day)).getUTCDay();
}

/** The Sunday that starts the week `day` is in (`day` itself when it is a Sunday). */
export function weekStartOf(day: string): string {
  return addDays(day, -weekdayOf(day));
}

/** The Sunday that starts the week a moment falls in, on the calendar of `timeZone`. */
export function weekStartOfMs(ms: number, timeZone: string): string {
  return weekStartOf(localDayOf(ms, timeZone));
}

/**
 * The Sundays of the last `count` weeks, oldest first: the last is the week `now` is in, which is
 * not over yet.
 */
export function weekStartsEnding(now: number, timeZone: string, count: number): string[] {
  const current = weekStartOfMs(now, timeZone);
  return Array.from({ length: count }, (_, i) => addDays(current, -7 * (count - 1 - i)));
}

/** The period an input asks for; `month` (the page as it was) when it asks for none. */
export function inputPeriod(input: { period?: AnalyticsPeriod }): AnalyticsPeriod {
  return input.period ?? DEFAULT_ANALYTICS_PERIOD;
}

/** Days in a tile's window: "the last 30 days" in the month period, "the last 7 days" in the week period. */
export function windowDaysOf(period: AnalyticsPeriod): number {
  return ANALYTICS_SIZES[period].windowDays;
}

/** The first day of the bucket `day` is in: its Sunday in the month period, the day itself in the week period. */
export function bucketStartOf(day: string, period: AnalyticsPeriod): string {
  return period === 'week' ? day : weekStartOf(day);
}

/** The last day of the bucket that starts on `start`: six days later for a week, the same day for a day. */
export function bucketLastDay(start: string, period: AnalyticsPeriod): string {
  return period === 'week' ? start : addDays(start, 6);
}

/**
 * The first days of the last `count` buckets, oldest first: the last is the one `now` is in, which
 * is not over yet. Sundays in the month period, consecutive days ending today in the week period.
 */
export function bucketStartsEnding(
  now: number,
  timeZone: string,
  period: AnalyticsPeriod,
  count: number,
): string[] {
  if (period === 'month') return weekStartsEnding(now, timeZone, count);
  const today = localDayOf(now, timeZone);
  return Array.from({ length: count }, (_, i) => addDays(today, -(count - 1 - i)));
}

/**
 * Which of `starts` (from `bucketStartsEnding`, for the same `period`) a moment falls in, on the
 * calendar of `timeZone`: its index, or -1 when it is in none of them (older, or newer).
 */
export function bucketIndexOf(
  ms: number,
  timeZone: string,
  period: AnalyticsPeriod,
  starts: readonly string[],
): number {
  return starts.indexOf(bucketStartOf(localDayOf(ms, timeZone), period));
}

/** A day of a calendar grid, and whether it has not come yet. */
export interface CalendarDay {
  date: string;
  future: boolean;
}

/**
 * The days of the last `weeks` calendar weeks, oldest first: from the Sunday `weeks - 1` weeks
 * before this week's Sunday to this week's Saturday, `weeks * 7` days. A day after today is marked
 * `future`. Column `i` of a grid with a row per weekday is `days.slice(7 * i, 7 * i + 7)`.
 */
export function calendarDays(now: number, timeZone: string, weeks: number): CalendarDay[] {
  const today = localDayOf(now, timeZone);
  const first = addDays(weekStartOf(today), -7 * (weeks - 1));
  return Array.from({ length: weeks * 7 }, (_, i) => {
    const date = addDays(first, i);
    return { date, future: date > today };
  });
}

/**
 * Which of `weekStarts` (Sundays) a moment falls in, on the calendar of `timeZone`: its index, or
 * -1 when it is in none of them (older, newer, or the list is not made of Sundays).
 */
export function weekIndexOf(ms: number, timeZone: string, weekStarts: readonly string[]): number {
  return weekStarts.indexOf(weekStartOfMs(ms, timeZone));
}

/** A stretch of time: after `after` up to and including `upTo`, in milliseconds since the epoch. */
export interface TimeWindow {
  after: number;
  upTo: number;
}

/** Whether a moment is in the window. */
export function inWindow(ms: number, window: TimeWindow): boolean {
  return ms > window.after && ms <= window.upTo;
}

/**
 * "The last `days` days" (the days up to now) and "before" (the `days` days before those). They
 * follow each other with nothing missing and nothing counted twice.
 */
export function trailingWindows(
  now: number,
  days: number,
): { current: TimeWindow; before: TimeWindow } {
  const span = days * DAY_MS;
  return {
    current: { after: now - span, upTo: now },
    before: { after: now - 2 * span, upTo: now - span },
  };
}

/** An ISO timestamp as milliseconds, or `null` for none (or one that cannot be read). */
export function msOf(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
