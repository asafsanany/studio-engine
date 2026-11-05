// What the five tiles of the Analytics page say (board ANPage, section Jobs), as pure functions.
// JobsTiles only lays these out.
//
// A tile has its number for the last 30 days and, under the sparkline, one line that says how it
// compares with the 30 days before: green when it got better, red when worse, grey when it did not
// change (or there is nothing to compare with). Jobs finished and Clients are better when higher;
// Files in → ready and Editing time are better when lower; Approved first time when its share is.
// In the week period the window is the last 7 days and the line says "the 7 days before".

import {
  ANALYTICS_SIZES,
  type AnalyticsPeriod,
  type AnalyticsTile,
  DEFAULT_ANALYTICS_PERIOD,
  spanText,
  tileSeriesByDay,
} from '@studio/shared';
import type { SparkRow } from './charts/Sparkline';

/** The value of a tile that has no number: no job finished, nothing approved. */
export const NO_NUMBER = '—';

/** The minus sign (U+2212), as the Money page writes a drop. */
const MINUS = '−';

/** What the change line says when the 30 days before have nothing to compare with. */
export const NOTHING_TO_COMPARE = 'Nothing to compare yet';

/** How the change line reads: better (green), worse (red), or the same / nothing to compare (grey). */
export type ChangeTone = 'better' | 'worse' | 'same';

export interface TileView {
  /** The big number: "31", "2 h 40 m", "19 of 24" or "—". */
  value: string;
  /** The line under the sparkline; "" when there is nothing to say (the tile then keeps its height). */
  change: string;
  tone: ChangeTone;
}

/** A whole number with a thousands separator once it needs one: "31", "1,204". */
export function countText(count: number): string {
  return Math.round(count).toLocaleString('en-US');
}

/** The days before the window, as the change line says them: "the 30 days before", "the 7 days before". */
export function daysBefore(period: AnalyticsPeriod): string {
  return `the ${ANALYTICS_SIZES[period].windowDays} days before`;
}

function countChange(
  value: number,
  previous: number,
  period: AnalyticsPeriod,
): Pick<TileView, 'change' | 'tone'> {
  const diff = Math.round(value) - Math.round(previous);
  if (diff === 0) return { change: `Same as ${daysBefore(period)}`, tone: 'same' };
  return {
    change: `${diff > 0 ? '+' : MINUS}${countText(Math.abs(diff))} on ${daysBefore(period)}`,
    tone: diff > 0 ? 'better' : 'worse',
  };
}

/** Less time is better: "25 min faster" in green, "25 min slower" in red. */
function durationChange(
  value: number,
  previous: number,
  period: AnalyticsPeriod,
): Pick<TileView, 'change' | 'tone'> {
  const diff = Math.round(previous) - Math.round(value);
  if (diff === 0) return { change: `Same as ${daysBefore(period)}`, tone: 'same' };
  return {
    change: `${spanText(Math.abs(diff))} ${diff > 0 ? 'faster' : 'slower'}`,
    tone: diff > 0 ? 'better' : 'worse',
  };
}

/** "was 14 of 21", green when the share went up, red when it went down. */
function ratioChange(tile: AnalyticsTile): Pick<TileView, 'change' | 'tone'> {
  const { previousNumerator, previousDenominator, value, previous } = tile;
  if (previousDenominator === null || previousDenominator === 0 || previousNumerator === null) {
    return { change: value === null ? '' : NOTHING_TO_COMPARE, tone: 'same' };
  }
  const was = `was ${previousNumerator} of ${previousDenominator}`;
  if (value === null || previous === null || value === previous)
    return { change: was, tone: 'same' };
  return { change: was, tone: value > previous ? 'better' : 'worse' };
}

/** Everything a tile shows, from its numbers, for the period (default: the month) it is counted over. */
export function tileView(
  tile: AnalyticsTile,
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): TileView {
  if (tile.unit === 'ratio') {
    const hasNumber = tile.denominator !== null && tile.denominator > 0;
    return {
      value: hasNumber ? `${tile.numerator ?? 0} of ${tile.denominator}` : NO_NUMBER,
      ...ratioChange(tile),
    };
  }
  const format = tile.unit === 'duration-sec' ? spanText : countText;
  const value = tile.value === null ? NO_NUMBER : format(tile.value);
  if (tile.value === null) return { value, change: '', tone: 'same' };
  if (tile.previous === null) return { value, change: NOTHING_TO_COMPARE, tone: 'same' };
  const change =
    tile.unit === 'duration-sec'
      ? durationChange(tile.value, tile.previous, period)
      : countChange(tile.value, tile.previous, period);
  return { value, ...change };
}

/** A tile's value as the hover card of its sparkline says it: "5", "2 h 40 m", "79%". */
export function sparkValueText(tile: AnalyticsTile, value: number): string {
  if (tile.unit === 'ratio') return `${Math.round(value * 100)}%`;
  return tile.unit === 'duration-sec' ? spanText(value) : countText(value);
}

/** How long ago a point of the sparkline is: "This week", "Last week", "3 weeks ago"; by day "Today", "Yesterday". */
function agoText(ago: number, byDay: boolean): string {
  if (byDay) return ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : `${ago} days ago`;
  return ago === 0 ? 'This week' : ago === 1 ? 'Last week' : `${ago} weeks ago`;
}

/**
 * The points of a tile's sparkline for its hover card, oldest first, the newest last. They are days
 * in the week period, and for the Clients tile in both (each day's clients over the window up to it).
 */
export function sparkRows(
  tile: AnalyticsTile,
  period: AnalyticsPeriod = DEFAULT_ANALYTICS_PERIOD,
): SparkRow[] {
  const last = tile.series.length - 1;
  const byDay = tileSeriesByDay(tile.key, period);
  return tile.series.map((value, i) => ({
    id: String(i),
    title: agoText(last - i, byDay),
    value,
  }));
}

/** The colour of the change line, as the Money page colours its own (green, red, grey). */
export const TONE_GREEN = '#4ADE80';
export const TONE_RED = '#F87171';

export const CHANGE_TONE_CLASS: Record<ChangeTone, string> = {
  better: 'text-[#4ADE80]',
  worse: 'text-[#F87171]',
  same: 'text-muted-foreground',
};

/** The colour of the sparkline: green or red with the change line, the chart blue when it is neither. */
export function sparklineColor(tone: ChangeTone): string | undefined {
  if (tone === 'better') return TONE_GREEN;
  if (tone === 'worse') return TONE_RED;
  return undefined;
}
