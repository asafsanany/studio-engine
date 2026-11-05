import {
  type AnalyticsLimitBucket,
  type AnalyticsPeriod,
  addDays,
  DEFAULT_ANALYTICS_PERIOD,
} from '@studio/shared';
import { NOW_LABEL } from './analytics-copy';
import { weekLabel } from './approved-first-time-view';
import { CHART_ORANGE, CHART_RED } from './charts/chart-colors';

// What "Busiest week" shows, worked out from the 8 weekly windows of the answer (the 14 days of
// "Busiest day" in the week period): two bars for each, the app's spend (blue) and the plan's peak
// (orange), their heights and colours, the dates under them and the line under the chart. Pure
// functions; the card only draws it.

/** How solid the bar of the window that is not over yet is, against 1 for the others. */
export const OPEN_WINDOW_OPACITY = 0.55;

/** One window (day) as the chart and its hover card read it. */
export interface BusiestRow {
  /** The day the window starts on; the row's name. */
  id: string;
  /** The hover card's heading: "Oct 17 – Oct 23 · so far", by day "Oct 22 · today". */
  title: string;
  /** What the app spent, as a share of the month's credits, and in dollars (when the credits are known). */
  api: number | null;
  apiUsd: number | null;
  /** The plan's peak, 0 to 1 (`null` for a gap). */
  plan: number | null;
  /** The plan's bar: red when the limit was hit in the window, orange otherwise. */
  planColor: string;
  hitLimit: boolean;
  /** How solid both bars are: the open window is lighter. */
  opacity: number;
}

export interface BusiestWeekView {
  /** The plan has a reading or the app spent something; without either the card says "No data yet". */
  hasData: boolean;
  /** What the app spent in each window (day) as a share of the month's credits (`null` for a gap), oldest first. */
  apiValues: (number | null)[];
  /** The plan's peak in each window (day), 0 to 1 (`null` for a gap), oldest first. */
  values: (number | null)[];
  /** Under the bars: the day the window started on, under every second one (by day: every third), and "now" ("today") under the open one. */
  labels: string[];
  /** The plan's bar: red for the week the limit was hit, orange for the rest. */
  colors: string[];
  /** The open window is lighter. */
  opacities: number[];
  /** One row per window, for the chart and its hover card. */
  rows: BusiestRow[];
  /** The line under the chart. */
  footer: string;
}

/** "Sep 12", "Sep 12 and Oct 3", "Sep 12, Oct 3 and Oct 10". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * The line under the chart: what the bars are, and which weeks hit the limit ("Week of Sep 12 hit
 * the limit (red)."). By day, which days: "Oct 15 and Oct 20 hit the limit (red).".
 */
export function busiestWeekFooter(
  hits: readonly string[],
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): string {
  if (period === 'week') {
    const base =
      'Plan: the highest five-hour use each day. API: what the app spent that day, of the month’s credits.';
    return hits.length === 0 ? base : `${base} ${listOf(hits)} hit the limit (red).`;
  }
  const base =
    'Plan: the highest use each week. API: what the app spent that week, of the month’s credits.';
  if (hits.length === 0) return base;
  const noun = hits.length === 1 ? 'Week' : 'Weeks';
  return `${base} ${noun} of ${listOf(hits)} hit the limit (red).`;
}

/** The hover card's heading for a window: its dates, and that it is not over. */
function rowTitle(bucket: AnalyticsLimitBucket, byDay: boolean): string {
  if (byDay) return `${weekLabel(bucket.start)}${bucket.current ? ' · today' : ''}`;
  const dates = `${weekLabel(bucket.start)} – ${weekLabel(addDays(bucket.start, 6))}`;
  return bucket.current ? `${dates} · so far` : dates;
}

export function busiestWeekView(
  buckets: readonly AnalyticsLimitBucket[],
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
  /** The month's credits in dollars: with it the hover card says what the app spent in dollars too. */
  budgetUsd: number | null = null,
): BusiestWeekView {
  const last = buckets.length - 1;
  const byDay = period === 'week';
  return {
    rows: buckets.map((bucket) => ({
      id: bucket.start,
      title: rowTitle(bucket, byDay),
      api: bucket.apiShare,
      apiUsd: bucket.apiShare === null || budgetUsd === null ? null : bucket.apiShare * budgetUsd,
      plan: bucket.peak,
      planColor: bucket.hitLimit ? CHART_RED : CHART_ORANGE,
      hitLimit: bucket.hitLimit,
      opacity: bucket.current ? OPEN_WINDOW_OPACITY : 1,
    })),
    hasData: buckets.some((bucket) => bucket.peak !== null || (bucket.apiShare ?? 0) > 0),
    apiValues: buckets.map((bucket) => bucket.apiShare),
    values: buckets.map((bucket) => bucket.peak),
    // As on the board: a date under every second bar from the oldest, "now" under the open one.
    // A day is narrower than a week: a date under every third bar, "today" under the open one.
    labels: buckets.map((bucket, i) => {
      if (i === last && bucket.current) return NOW_LABEL[period];
      if (byDay) return i % 3 === 0 && last - i >= 2 ? weekLabel(bucket.start) : '';
      return i % 2 === 0 ? weekLabel(bucket.start) : '';
    }),
    colors: buckets.map((bucket) => (bucket.hitLimit ? CHART_RED : CHART_ORANGE)),
    opacities: buckets.map((bucket) => (bucket.current ? OPEN_WINDOW_OPACITY : 1)),
    footer: busiestWeekFooter(
      buckets.filter((bucket) => bucket.hitLimit).map((bucket) => weekLabel(bucket.start)),
      period,
    ),
  };
}
