import {
  type AnalyticsClaudeUse,
  type AnalyticsPeriod,
  addDays,
  DEFAULT_ANALYTICS_PERIOD,
} from '@studio/shared';
import { weekLabel } from './approved-first-time-view';
import { dayMonth, usdText } from './budgets-view';

// What "API credits and plan through the month" draws: the share of each budget used on one scale.
// Blue is the API credits: a solid line for what the app has spent, a dashed one for where the pace
// takes it and the day it runs out. Orange is the plan's weekly limit, one line per week since the
// limit starts again at 0 when the week resets. The month period draws the whole calendar month
// (day 1 at the left edge); the week period zooms in on the last 7 days (today and the 6 before).
// Both read from one set of rows, a row for every day boundary and one for now, so the hover can
// say what each budget stood at. Pure functions; the card only draws it.

/** The axis reaches this far above 100%, so the line for it is not at the very top. */
const HEADROOM = 1.25;

/** The week period's window: today and the 6 days before it. */
const WEEK_DAYS = 7;

/** Two end labels nearer than this share would touch, so the lower one goes below its dot. */
const LABELS_CLOSE = 0.1;

/** A label has no room below its dot when the dot is lower than this share. */
const ROOM_BELOW = 0.12;

const percentText = (share: number) => `${Math.round(share * 100)}%`;

/** One point of the hover: where the budgets stood at `x` days from the month's start. */
export interface BudgetsRow {
  x: number;
  /** The tooltip's heading: "Oct 22, end of day", "Oct 26, so far". */
  title: string;
  /** The share of the month's credits used; `null` before the count started. */
  credits: number | null;
  creditsUsd: number | null;
  /** The plan's weekly use at that point and the week (`run`) of it; `null` with no reading. */
  plan: number | null;
  run: number | null;
}

/** A dot at the end of a line and where its label goes: above it, below it, or well above it. */
export interface EndMark {
  x: number;
  y: number;
  label: string;
  placement: 'above' | 'below' | 'high';
}

export interface BudgetsChartView {
  rows: BudgetsRow[];
  /** How many lines the plan is drawn with: one per weekly window. */
  runs: number;
  /** The x axis: the whole month, or the last 7 days up to now. */
  xDomain: [number, number];
  /** The days named under the chart, and the label of each. */
  xTicks: { x: number; label: string }[];
  /** The y axis reaches this share; its ticks are 0%, 50% and 100%. */
  yMax: number;
  yTicks: number[];
  /** The vertical line at now; `null` where now is the chart's right edge. */
  nowX: number | null;
  credits: { end: EndMark };
  /** The end of the plan's last line; `null` with no reading in the chart. */
  plan: { end: EndMark | null };
  /** The dashed line from now at the pace, cut where it leaves the chart; `null` with no pace. */
  pace: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  /** The mark where the pace crosses the credits; `null` when they last the month. */
  runOut: { x: number; y: number; label: string } | null;
  /** The line under the chart. */
  footnote: string;
}

/** The chart for the credits and the plan's weekly use, for the month or the last 7 days. */
export function budgetsChartView(
  credits: AnalyticsClaudeUse['credits'],
  plan: AnalyticsClaudeUse['plan'],
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): BudgetsChartView {
  const budget = credits.budgetUsd;
  const byWeek = period === 'week';
  const { nowX } = credits;
  const today = Math.floor(nowX);
  const from = byWeek ? Math.max(0, today - (WEEK_DAYS - 1)) : 0;
  const dayAt = (x: number) => weekLabel(addDays(credits.monthStart, x));
  const sinceX = credits.series[0]?.x ?? 0;

  const titleOf = (x: number) => {
    if (x === nowX) return `${dayAt(today)}, so far`;
    if (x === sinceX) return `Start of ${dayAt(x)}`;
    return `${dayAt(x - 1)}, end of day`;
  };
  const rowMap = new Map<number, BudgetsRow>();
  const rowAt = (x: number) => {
    const known = rowMap.get(x);
    if (known !== undefined) return known;
    const row: BudgetsRow = {
      x,
      title: titleOf(x),
      credits: null,
      creditsUsd: null,
      plan: null,
      run: null,
    };
    rowMap.set(x, row);
    return row;
  };

  for (const point of credits.series) {
    const row = rowAt(point.x);
    row.credits = point.usd / budget;
    row.creditsUsd = point.usd;
  }

  // A reading belongs to the end of its day, like the credits do; today's is at now. Of two
  // readings on one row the later wins, so a week's line ends the day before the next one starts.
  const snap = (x: number) => (Math.floor(x) === today ? nowX : Math.ceil(x));
  let planEnd: { x: number; use: number } | null = null;
  for (const [index, run] of plan.series.entries()) {
    const snapped = run.map((point) => ({ x: snap(point.x), use: point.use }));
    const points = snapped.filter((point, i) => snapped[i + 1]?.x !== point.x);
    for (const point of points) {
      const row = rowAt(point.x);
      row.plan = point.use;
      row.run = index;
    }
    planEnd = points.at(-1) ?? planEnd;
  }

  const rows = [...rowMap.values()].filter((row) => row.x >= from).sort((a, b) => a.x - b.x);
  const used = rows.filter((row) => row.run !== null);
  const runs = Math.max(0, ...used.map((row) => (row.run ?? 0) + 1));

  const planMax = Math.max(0, ...plan.series.flat().map((point) => point.use));
  const yMax = Math.max(HEADROOM, credits.usedShare * 1.1, planMax * 1.1);

  const xTicks: BudgetsChartView['xTicks'] = [];
  if (byWeek) {
    for (let x = from; x <= today; x++) xTicks.push({ x, label: dayAt(x) });
  } else {
    for (let day = 0; day < credits.monthDays; day += 7) xTicks.push({ x: day, label: dayAt(day) });
  }

  // The two ends sit near each other when the budgets are used alike: the lower one's label goes
  // under its dot, if there is room under it, else above the other label.
  const planNow = planEnd !== null && planEnd.x >= from ? planEnd : null;
  const creditsNow = credits.usedShare;
  const close = planNow !== null && Math.abs(planNow.use - creditsNow) < LABELS_CLOSE;
  const placementOf = (own: number, other: number, ownWinsTie: boolean): EndMark['placement'] => {
    const upper = own > other || (own === other && ownWinsTie);
    if (!close || upper) return 'above';
    return own >= ROOM_BELOW ? 'below' : 'high';
  };

  let pace: BudgetsChartView['pace'] = null;
  let runOut: BudgetsChartView['runOut'] = null;
  if (credits.perDayUsd !== null && credits.perDayUsd > 0 && credits.status !== 'used-up') {
    const perDay = credits.perDayUsd / budget;
    if (!byWeek) {
      // Cut the line where it reaches the top of the chart, or the end of the month.
      const toTop = nowX + (yMax - creditsNow) / perDay;
      const endDays = Math.min(credits.monthDays, toTop);
      pace = {
        from: { x: nowX, y: creditsNow },
        to: { x: endDays, y: creditsNow + perDay * (endDays - nowX) },
      };
      if (credits.runOutDay !== null) {
        runOut = {
          x: nowX + (1 - creditsNow) / perDay,
          y: 1,
          label: `empty ≈ ${dayMonth(credits.runOutDay)}`,
        };
      }
    }
  }

  const planNote = 'Orange is the plan’s weekly limit; it starts again every week.';
  const runOutNote =
    byWeek && credits.runOutDay !== null
      ? ` At the pace the credits run out about ${dayMonth(credits.runOutDay)}.`
      : '';
  const footnote =
    credits.perDayUsd === null
      ? `Nothing spent from the credits yet this month. ${planNote}`
      : byWeek
        ? `Blue: the share of the month’s credits used, ${usdText(credits.perDayUsd)} a day since ${dayMonth(credits.since)}.${runOutNote} ${planNote}`
        : `Blue: solid = used, dashed = the pace since ${dayMonth(credits.since)}, ${usdText(credits.perDayUsd)} a day. ${planNote}`;

  return {
    rows,
    runs,
    xDomain: byWeek ? [from, nowX] : [0, credits.monthDays],
    xTicks,
    yMax,
    yTicks: [0, 0.5, 1],
    nowX: byWeek ? null : nowX,
    credits: {
      end: {
        x: nowX,
        y: creditsNow,
        label: `${usdText(credits.spentUsd)} · ${percentText(credits.usedShare)}`,
        placement: planNow === null ? 'above' : placementOf(creditsNow, planNow.use, true),
      },
    },
    plan: {
      end:
        planNow === null
          ? null
          : {
              x: planNow.x,
              y: planNow.use,
              label: `${percentText(planNow.use)} of limit`,
              placement: placementOf(planNow.use, creditsNow, false),
            },
    },
    pace,
    runOut,
    footnote,
  };
}
