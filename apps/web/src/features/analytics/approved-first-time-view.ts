import {
  type AnalyticsApprovalBucket,
  type AnalyticsPeriod,
  DEFAULT_ANALYTICS_PERIOD,
} from '@studio/shared';
import { NOW_LABEL } from './analytics-copy';
import { fixedScale } from './charts/axis';
import type { LineRow } from './charts/ValueLineChart';

// What "Approved first time, by week" says: the numbers of the line, the words under its columns
// and the one line under the chart. Pure functions of the 12 weeks the engine sends (the 14 days
// of the week period, "by day"); the card only draws what they return.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A week by its Sunday (a day by itself), the way the board writes it under the chart: "Aug 2". */
export function weekLabel(start: string): string {
  const month = MONTHS[Number(start.slice(5, 7)) - 1];
  return month === undefined ? start : `${month} ${Number(start.slice(8, 10))}`;
}

/**
 * What the hover card calls a week (a day, in the week period): "Week of Aug 2", "Aug 2"; the one
 * that is not over yet says so: "Week of Aug 2 · so far", "Aug 2 · today".
 */
export function bucketTitle(start: string, period: AnalyticsPeriod, current: boolean): string {
  if (period === 'week') return `${weekLabel(start)}${current ? ' · today' : ''}`;
  return `Week of ${weekLabel(start)}${current ? ' · so far' : ''}`;
}

/** A share as the axis and the summary write it: 0.79 is "79%". */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** The line's values, oldest first; a week with no approvals is a gap in the line, not a zero. */
export function approvalValues(weeks: readonly AnalyticsApprovalBucket[]): (number | null)[] {
  return weeks.map((week) => week.share);
}

/** The grid of the share's line: 0 to 100% in quarters. */
export const APPROVAL_SCALE = fixedScale(1, 4);

/** The points of the line for the hover card: the share, and how many jobs it is of. */
export function approvalRows(
  weeks: readonly AnalyticsApprovalBucket[],
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): LineRow[] {
  return weeks.map((week, i) => ({
    id: week.start,
    title: bucketTitle(week.start, period, i === weeks.length - 1),
    value: week.share,
    note: `${week.firstTime} of ${week.approved} ${week.approved === 1 ? 'job' : 'jobs'} approved with no notes`,
  }));
}

/**
 * The words under the columns, oldest first: every third week by its Sunday ("Aug 2", "Aug 23", …)
 * (every third day in the week period) and "now" ("today") under the last, which is not over yet.
 * A third column that is too close to "now" to leave room for its words is left out.
 */
export function approvalLabels(
  weeks: readonly AnalyticsApprovalBucket[],
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): string[] {
  const last = weeks.length - 1;
  return weeks.map((week, i) => {
    if (i === last) return NOW_LABEL[period];
    return i % 3 === 0 && last - i >= 2 ? weekLabel(week.start) : '';
  });
}

/** Whether there is anything to draw: at least one week in which a job was approved. */
export function hasApprovals(weeks: readonly AnalyticsApprovalBucket[]): boolean {
  return weeks.some((week) => week.share !== null);
}

/**
 * The line under the chart, from the numbers. Month: how the share moved from the first week with
 * approvals to the last one ("Up from 55% to 79% since Aug 9."), or, with one such week only, how
 * many of its jobs were approved first time ("… this week.", "… the week of Aug 9."). Week: the
 * last 7 days against the 7 before (lastSevenDaysSummary). `null` when no job was approved.
 */
export function approvalSummary(
  weeks: readonly AnalyticsApprovalBucket[],
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): string | null {
  const counted = weeks.filter((week) => week.share !== null);
  const first = counted[0];
  const last = counted.at(-1);
  if (first === undefined || last === undefined) return null;

  // By day a share is 0% or 100% on most days (one or two approvals), so first-vs-last day says
  // little. Totals over the last 7 days and the 7 before them read the same as the tile.
  if (period === 'week') return lastSevenDaysSummary(weeks);

  if (first === last) {
    const when = last === weeks.at(-1) ? 'this week' : `the week of ${weekLabel(last.start)}`;
    const jobs = last.approved === 1 ? 'job' : 'jobs';
    return `${last.firstTime} of ${last.approved} ${jobs} approved first time ${when}.`;
  }

  const from = percent(first.share ?? 0);
  const to = percent(last.share ?? 0);
  const since = weekLabel(first.start);
  if (from === to) return `Steady at ${to} since ${since}.`;
  return `${(last.share ?? 0) > (first.share ?? 0) ? 'Up' : 'Down'} from ${from} to ${to} since ${since}.`;
}

/**
 * The Week period's line: the jobs approved first time over the last 7 days, and over the 7 before
 * when any was approved then ("4 of 5 approved first time in the last 7 days, was 3 of 4.").
 * `null` when no job was approved in the last 7 days.
 */
function lastSevenDaysSummary(days: readonly AnalyticsApprovalBucket[]): string | null {
  const total = (bucket: readonly AnalyticsApprovalBucket[]) =>
    bucket.reduce(
      (sum, day) => ({
        firstTime: sum.firstTime + day.firstTime,
        approved: sum.approved + day.approved,
      }),
      { firstTime: 0, approved: 0 },
    );
  const now = total(days.slice(-7));
  const before = total(days.slice(-14, -7));
  if (now.approved === 0) return null;
  const line = `${now.firstTime} of ${now.approved} approved first time in the last 7 days`;
  return before.approved === 0
    ? `${line}.`
    : `${line}, was ${before.firstTime} of ${before.approved}.`;
}
