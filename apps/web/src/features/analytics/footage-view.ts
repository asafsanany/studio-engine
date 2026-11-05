// "Footage edited per week" (board ANPage, section Jobs): a line with a tint under it over the last
// 12 weeks, in hours, and one plain line under it when there is something true to say. In the week
// period it is "Footage edited per day" over the last 14 days. These are pure functions;
// FootagePerWeekCard only lays them out.

import {
  ANALYTICS_SIZES,
  type AnalyticsFootageBucket,
  type AnalyticsPeriod,
  DEFAULT_ANALYTICS_PERIOD,
} from '@studio/shared';
import { NOW_LABEL } from './analytics-copy';
import { bucketTitle } from './approved-first-time-view';
import { type AxisScale, scaleFor } from './charts/axis';
import type { LineRow } from './charts/ValueLineChart';

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

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Every how many weeks (days) the x axis carries a date; the current one is always "now" ("today"). */
const LABEL_EVERY = 3;

/**
 * The least footage a week must have to be what a later week is compared with: a quarter of an
 * hour. Less is too little to say "doubled" about.
 */
export const MIN_BASELINE_HOURS = 0.25;

/** The weeks between the one compared with and the latest, at the least, for "since August" to mean something. */
const MIN_WEEKS_APART = 4;

/** The month number (0 to 11) of a calendar day, YYYY-MM-DD. */
const monthIndex = (day: string) => Number(day.slice(5, 7)) - 1;

/** "Aug 22": the date of a week's Sunday (or of a day, in the week period). */
export function weekLabel(start: string): string {
  return `${MONTHS[monthIndex(start)] ?? ''} ${Number(start.slice(8, 10))}`;
}

/** A multiple the way it reads: 2.5, 4. */
function timesText(times: number): string {
  return Number.isInteger(times) ? String(times) : times.toFixed(1);
}

/**
 * What a ratio of footage says, or `null` when it is not worth a line: twice as much or more says
 * "Doubled since August.", "Tripled …", "Up 2.5× …", "Up 4× …" (the multiple is rounded down to
 * the half, so the line is never more than the numbers say); half or less says "Halved …" (down to
 * 0.4) or "Down by more than half …". `since` is how the line ends: "since August.".
 */
function ratioSentence(ratio: number, since: string): string | null {
  if (ratio >= 2) {
    const times = Math.floor(ratio * 2) / 2;
    if (times === 2) return `Doubled ${since}`;
    if (times === 3) return `Tripled ${since}`;
    return `Up ${timesText(times)}× ${since}`;
  }
  if (ratio <= 0.4) return `Down by more than half ${since}`;
  if (ratio <= 0.5) return `Halved ${since}`;
  return null;
}

/**
 * One line that is true of the weeks, or `null` when nothing is worth saying. It compares the first
 * week that has a fair amount of footage with the best of the latest week that is over and this
 * week (this week alone could still be half done, so it never makes the line smaller):
 *
 * - twice as much or more says "Doubled since August.", "Tripled …", "Up 2.5× …", "Up 4× …" (the
 *   multiple is rounded down to the half, so the line is never more than the numbers say);
 * - half or less says "Halved since August." (down to 0.4) or "Down by more than half since August.".
 *
 * Nothing is said when the two are fewer than four weeks apart or fall in the same month.
 */
export function footageSummary(weeks: readonly AnalyticsFootageBucket[]): string | null {
  const first = weeks.findIndex((week) => week.hours !== null && week.hours >= MIN_BASELINE_HOURS);
  const base = weeks[first];
  if (base === undefined || base.hours === null) return null;

  const last = weeks.length - 1;
  let lastOver = -1;
  weeks.forEach((week, i) => {
    if (i < last && week.hours !== null) lastOver = i;
  });
  const candidates = [lastOver, last].filter(
    (i) => i > first && (weeks[i]?.hours ?? null) !== null,
  );
  const best = candidates.reduce<number | null>((chosen, i) => {
    const hours = weeks[i]?.hours ?? 0;
    return chosen === null || hours >= (weeks[chosen]?.hours ?? 0) ? i : chosen;
  }, null);
  const recent = best === null ? undefined : weeks[best];
  if (best === null || recent === undefined || recent.hours === null) return null;
  if (best - first < MIN_WEEKS_APART || monthIndex(base.start) === monthIndex(recent.start)) {
    return null;
  }

  return ratioSentence(
    recent.hours / base.hours,
    `since ${MONTH_NAMES[monthIndex(base.start)] ?? ''}.`,
  );
}

/** The days in each of the two stretches the daily summary compares: the last 7 days and the 7 before. */
const HALF = ANALYTICS_SIZES.week.windowDays;

/**
 * The week period's line: day by day is too uneven to compare two days, so it compares the last 7
 * days with the 7 before ("Doubled on the 7 days before."), said with the same words as the weekly
 * line. Today is not over, so it counts as at least an average day of the other six and never
 * makes the line smaller. Nothing is said without 14 days that all have data, or when the 7 days
 * before have less than a fair amount of footage.
 */
export function footageDaySummary(days: readonly AnalyticsFootageBucket[]): string | null {
  if (days.length < 2 * HALF) return null;
  const earlier = days.slice(-2 * HALF, -HALF);
  const latest = days.slice(-HALF);
  const hoursOf = (stretch: readonly AnalyticsFootageBucket[]) =>
    stretch.every((day) => day.hours !== null)
      ? stretch.reduce((total, day) => total + (day.hours ?? 0), 0)
      : null;
  const before = hoursOf(earlier);
  const lately = hoursOf(latest);
  const overDays = hoursOf(latest.slice(0, -1));
  if (before === null || lately === null || overDays === null) return null;
  if (before < MIN_BASELINE_HOURS) return null;
  const withToday = Math.max(lately, (overDays / (HALF - 1)) * HALF);
  return ratioSentence(withToday / before, `on the ${HALF} days before.`);
}

export interface FootageView {
  /** Whether any week (or day) has footage data. Without it the card says "No data yet". */
  hasData: boolean;
  /** The unit of the axis: hours, or minutes while every week (or day) is under an hour. */
  unit: 'h' | 'min';
  /** One value per week (day) in `unit`, oldest first; `null` for one with no data. */
  values: (number | null)[];
  /** The points of the line for the hover card, same length as `values`. */
  rows: LineRow[];
  /** The grid: 0 to a round number above the biggest value, in about five steps. */
  scale: AxisScale;
  /** The text under each column: a date every third one and "now" ("today") for the last; "" for the rest. */
  labels: string[];
  /** Whether to draw a dot on each column: only when some column stands alone between two gaps. */
  dots: boolean;
  /** The line under the chart, or `null`. */
  summary: string | null;
  ariaLabel: string;
}

/** A tick's text: "3 h", "1.5 h", "20 min". */
export function tickText(value: number, unit: FootageView['unit']): string {
  return `${Number(value.toFixed(2))} ${unit}`;
}

export function footageView(
  weeks: readonly AnalyticsFootageBucket[],
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): FootageView {
  const hours = weeks.map((week) => week.hours);
  const hasData = hours.some((value) => value !== null);
  const biggest = Math.max(0, ...hours.map((value) => value ?? 0));
  // Under an hour in every week the axis counts minutes, so it reads "0 min … 6 min", not "0.1 h".
  const unit = biggest < 1 ? 'min' : 'h';
  const values = hours.map((value) =>
    value === null ? null : unit === 'min' ? value * 60 : value,
  );
  const last = weeks.length - 1;
  const labels = weeks.map((week, i) => {
    if (i === last) return NOW_LABEL[period];
    return i % LABEL_EVERY === 0 && last - i >= 2 ? weekLabel(week.start) : '';
  });
  // A week with data on both sides is joined to them by the line; one alone needs its own dot.
  const missing = (i: number) => (values[i] ?? null) === null;
  const dots = values.some((value, i) => value !== null && missing(i - 1) && missing(i + 1));
  return {
    hasData,
    unit,
    values,
    rows: weeks.map((week, i) => ({
      id: week.start,
      title: bucketTitle(week.start, period, i === last),
      value: values[i] ?? null,
    })),
    scale: scaleFor(values, { intervals: 5 }),
    labels,
    dots,
    summary: period === 'week' ? footageDaySummary(weeks) : footageSummary(weeks),
    ariaLabel: `Footage ${unit === 'h' ? 'hours' : 'minutes'} per ${period === 'week' ? 'day' : 'week'}`,
  };
}
