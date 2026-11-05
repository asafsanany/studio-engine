// "Plays of every reel" (board CLPage): one bar per reel of the range, oldest first, ours in blue
// and theirs in grey, with a dashed line at the typical reel of each side. Pure functions;
// PlaysCard and PlaysBarChart only lay them out.
//
// This is where the section reads `numbers.plays` (the bars), `numbers.tiles.playsPerReel` (the two
// typical lines: the same medians as the Plays per reel tile) and `numbers.usual.plays` (for "× their
// usual" in the hover card). The caption and the video of a reel come from the page's `reels`.

import type { InstagramNumbers, InstagramReel } from '@studio/shared';
import { type AxisScale, niceScale } from '@/features/analytics/charts/axis';
import { OURS, THEIRS, TYPICAL_THEIRS } from './instagram-colors';
import {
  compactText,
  rangeWords,
  reelsText,
  SEPARATOR,
  sentenceCase,
  type TextOptions,
  timesText,
} from './instagram-text';
import { monthLabels, reelNote, reelsByShortcode, reelTitle } from './reel-rows';

/** One bar: a reel of the range. */
export interface PlaysRow {
  /** The reel's shortcode. */
  id: string;
  plays: number;
  ours: boolean;
  /** The hover card's heading: the reel's caption. */
  title: string;
  /** What the hover card says under the figure: "Ours · Granite · Sun 25 Oct · 1.8× their usual". */
  note: string;
}

/** A dashed line across the chart at the typical reel of one side. */
export interface TypicalLine {
  value: number;
  color: string;
  /** "Ours, typical 18.4K". */
  text: string;
}

export interface PlaysChartView {
  /** False when no reel was posted in the range. */
  hasData: boolean;
  rows: PlaysRow[];
  /** The text under each bar (the month under the first reel of it); same length as `rows`. */
  labels: string[];
  scale: AxisScale;
  lines: TypicalLine[];
  /** "Last 90 days · 22 reels, 7 of them ours". */
  subtitle: string;
  ariaLabel: string;
}

/** "7 of them ours", "none of them ours", "all ours". */
function oursText(ours: number, total: number): string {
  if (ours === 0) return 'none of them ours';
  return ours === total ? 'all ours' : `${ours} of them ours`;
}

export function playsChartView(
  numbers: InstagramNumbers,
  reels: readonly InstagramReel[],
  options: TextOptions = {},
): PlaysChartView {
  const byCode = reelsByShortcode(reels);
  const usual = numbers.usual.plays;

  const rows = numbers.plays.map((point): PlaysRow => {
    const reel = byCode.get(point.shortcode);
    const against =
      usual !== null && usual > 0 ? [`${timesText(point.plays / usual)} their usual`] : [];
    return {
      id: point.shortcode,
      plays: point.plays,
      ours: point.ours,
      title: reelTitle(reel, point.postedAt, options),
      note: [reelNote(point, reel, options), ...against].join(SEPARATOR),
    };
  });

  const { ours, theirs } = numbers.tiles.playsPerReel;
  const lines: TypicalLine[] = [];
  if (ours !== null) {
    lines.push({ value: ours, color: OURS, text: `Ours, typical ${compactText(ours)}` });
  }
  if (theirs !== null) {
    lines.push({
      value: theirs,
      color: TYPICAL_THEIRS,
      text: `Theirs, typical ${compactText(theirs)}`,
    });
  }

  const top = Math.max(0, ...rows.map((row) => row.plays), ...lines.map((line) => line.value));
  const oursCount = rows.filter((row) => row.ours).length;
  const range = rangeWords(numbers, options);
  return {
    hasData: rows.length > 0,
    rows,
    labels: monthLabels(
      numbers.plays.map((point) => point.postedAt),
      options,
    ),
    scale: niceScale(top, 5),
    lines,
    subtitle: `${sentenceCase(range)}${SEPARATOR}${reelsText(rows.length)}, ${oursText(oursCount, rows.length)}`,
    ariaLabel: `Plays of the ${reelsText(rows.length)}, ${range}, ours in blue`,
  };
}

/** The grey and the blue of the legend above the chart. */
export const PLAYS_LEGEND = [
  { color: OURS, label: 'Ours' },
  { color: THEIRS, label: 'Theirs' },
] as const;
