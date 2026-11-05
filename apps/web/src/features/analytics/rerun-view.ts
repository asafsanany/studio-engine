import {
  type AnalyticsApprovalBucket,
  type AnalyticsPeriod,
  DEFAULT_ANALYTICS_PERIOD,
} from '@studio/shared';
import { bucketTitle } from './approved-first-time-view';
import type { LineRow } from './charts/ValueLineChart';

// "Re-runs per approved job": the median number of re-runs (rounds of notes sent) of the jobs
// approved in each week (day). Pure functions of the buckets the engine sends for the approvals line.

/** The line's values, oldest first; a week with no approvals is a gap, not a zero. */
export function rerunValues(weeks: readonly AnalyticsApprovalBucket[]): (number | null)[] {
  return weeks.map((week) => week.medianReruns);
}

/** The points of the line for the hover card: the median, and how many jobs it is of. */
export function rerunRows(
  weeks: readonly AnalyticsApprovalBucket[],
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): LineRow[] {
  return weeks.map((week, i) => ({
    id: week.start,
    title: bucketTitle(week.start, period, i === weeks.length - 1),
    value: week.medianReruns,
    note: `across ${week.approved} approved ${week.approved === 1 ? 'job' : 'jobs'}`,
  }));
}

/** Whether any week has an approved job to draw. */
export function hasReruns(weeks: readonly AnalyticsApprovalBucket[]): boolean {
  return weeks.some((week) => week.medianReruns !== null);
}

/** An axis value or median as written: 0, 1, 1.5. */
export function reruns(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** The line under the chart: the latest week's median and the one before it; `null` with no approvals. */
export function rerunSummary(weeks: readonly AnalyticsApprovalBucket[]): string | null {
  const counted = weeks.filter((week) => week.medianReruns !== null);
  const last = counted.at(-1)?.medianReruns;
  if (last === undefined || last === null) return null;
  const jobs = counted.reduce((sum, week) => sum + week.approved, 0);
  return `Latest: ${reruns(last)} ${last === 1 ? 're-run' : 're-runs'} (median), across ${jobs} approved ${jobs === 1 ? 'job' : 'jobs'} in this stretch.`;
}
