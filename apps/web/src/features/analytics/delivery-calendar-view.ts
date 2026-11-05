// "Jobs delivered per day" (board ANPage, section Jobs): the last 13 weeks as a calendar, a column
// per week (Sunday to Saturday) and a row per weekday. The answer lists 91 days, oldest first, so
// column `i` is days `7 * i` to `7 * i + 6`. These are pure functions; DeliveredPerDayCard only
// lays them out.

import { type AnalyticsDay, weekdayOf } from '@studio/shared';
import { NOW_LABEL } from './analytics-copy';
import { bucketTitle, weekLabel } from './approved-first-time-view';
import { countScale } from './charts/axis';
import type { LineRow } from './charts/ValueLineChart';

export const CALENDAR_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** How deep a day is drawn: 0 jobs, 1, 2, or 3 and more. */
export type DeliveryLevel = 0 | 1 | 2 | 3;

/** The blues of the board, one per level: a day with no job is a faint tint, 3 or more the lightest blue. */
export const DELIVERY_LEVEL_COLORS: Record<DeliveryLevel, string> = {
  0: 'rgba(255,255,255,0.05)',
  1: '#256abf',
  2: '#5598e7',
  3: '#86b6ef',
};

/** The legend's ramp, from "0" to "3+" (the eight blues of the board). */
export const DELIVERY_LEGEND_COLORS = [
  DELIVERY_LEVEL_COLORS[0],
  '#184f95',
  '#1c5cab',
  '#256abf',
  '#2a78d6',
  '#3987e5',
  '#5598e7',
  '#6da7ec',
  '#86b6ef',
] as const;

export interface CalendarCell {
  date: string;
  count: number | null;
  /** `null` for a day with no data: one that has not come yet, or one before the first record. */
  level: DeliveryLevel | null;
  /** The tooltip: "Tue 20 Oct: 2 jobs delivered"; "" for a day with no data. */
  title: string;
}

export interface DeliveryCalendar {
  /** The columns, oldest week first; each has 7 days, Sunday first. */
  weeks: CalendarCell[][];
  /** The month under which a column starts, per column; "" for none. */
  monthLabels: string[];
  /** Jobs delivered in the 13 weeks; `null` when no day has data. */
  total: number | null;
  /** Whether any day has data. Without it the card says "No data yet". */
  hasData: boolean;
  /** What a screen reader hears for the whole calendar. */
  summary: string;
}

export function deliveryLevel(count: number): DeliveryLevel {
  if (count <= 0) return 0;
  return count >= 3 ? 3 : (count as 1 | 2);
}

const jobs = (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'}`;

/** "Tue 20 Oct": a calendar day (YYYY-MM-DD) with its weekday. */
export function dayText(date: string): string {
  const weekday = CALENDAR_WEEKDAYS[weekdayOf(date)] ?? '';
  const month = MONTHS[Number(date.slice(5, 7)) - 1] ?? '';
  return `${weekday} ${Number(date.slice(8, 10))} ${month}`;
}

/** The month of a week's Sunday, "Aug". */
function monthOf(sunday: string | undefined): string {
  return sunday === undefined ? '' : (MONTHS[Number(sunday.slice(5, 7)) - 1] ?? '');
}

/**
 * Which columns carry a month name: the first one that starts a month (its Sunday is in a month
 * the column before was not in). The very first column carries its month too, unless the next
 * column starts another one, so two names never sit side by side.
 */
export function monthLabels(sundays: readonly (string | undefined)[]): string[] {
  return sundays.map((sunday, i) => {
    const month = monthOf(sunday);
    if (i === 0) return month === monthOf(sundays[1]) ? month : '';
    return month !== monthOf(sundays[i - 1]) ? month : '';
  });
}

export function deliveryCalendar(days: readonly AnalyticsDay[]): DeliveryCalendar {
  const cells: CalendarCell[] = days.map(({ date, count }) => ({
    date,
    count,
    level: count === null ? null : deliveryLevel(count),
    title:
      count === null
        ? ''
        : `${dayText(date)}: ${count === 0 ? 'no jobs delivered' : `${jobs(count)} delivered`}`,
  }));
  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const counts = days.flatMap((day) => day.count ?? []);
  const hasData = days.some((day) => day.count !== null);
  const total = hasData ? counts.reduce((sum, count) => sum + count, 0) : null;
  const weeksShown = weeks.length;
  return {
    weeks,
    monthLabels: monthLabels(weeks.map((week) => week[0]?.date)),
    total,
    hasData,
    summary:
      total === null
        ? 'No jobs delivered'
        : `${total === 0 ? 'No jobs' : jobs(total)} delivered in the last ${weeksShown} weeks`,
  };
}

/** The days the week period's bars show: the last 14 days that have come. */
const BAR_DAYS = 14;

export interface DeliveryBars {
  hasData: boolean;
  /** A bar per day, oldest first, today last: jobs delivered, for the hover card. */
  rows: LineRow[];
  /** The text under the bars: a date every third day and "today" under the last. */
  labels: string[];
  /** Whole jobs on the axis, up to a round number over the busiest day. */
  scale: ReturnType<typeof countScale>;
}

/**
 * "Jobs delivered per day" in the week period: the last 14 days that have come, a bar each. The
 * answer lists a whole calendar week at the end, so the days after today (no data) are left off.
 */
export function deliveryBars(days: readonly AnalyticsDay[]): DeliveryBars {
  const came = days.filter((day) => day.count !== null).slice(-BAR_DAYS);
  const last = came.length - 1;
  return {
    hasData: came.length > 0,
    rows: came.map((day, i) => ({
      id: day.date,
      title: bucketTitle(day.date, 'week', i === last),
      value: day.count,
    })),
    labels: came.map((day, i) => {
      if (i === last) return NOW_LABEL.week;
      return i % 3 === 0 && last - i >= 2 ? weekLabel(day.date) : '';
    }),
    scale: countScale(Math.max(0, ...came.map((day) => day.count ?? 0))),
  };
}
