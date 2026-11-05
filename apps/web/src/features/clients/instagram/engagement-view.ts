// "Views, likes, comments and shares" (E1 on board CLEngage, in the page under Plays of every reel):
// every reel of the range, oldest first, with its views (its plays), likes, comments and shares each
// as a multiple of what is usual for the account, on one axis (0, 1, 5, 10, 15 times; anything above
// is drawn at 15). A dashed line is at 1× (their usual reel) and a pale blue band is behind each of
// our reels. Pure functions; EngagementCard and EngagementChart only lay them out.
//
// This is where the section reads `numbers.engagement` (the multiples) and `numbers.usual` (what
// the multiples are of, for the subtitle). The counts and the caption of a reel come from the
// page's `reels`.

import type { InstagramNumbers, InstagramReel } from '@studio/shared';
import { COMMENTS, LIKES, OURS, SHARES, VIEWS } from './instagram-colors';
import { countText, rangeWords, SEPARATOR, type TextOptions, timesText } from './instagram-text';
import { monthLabels, reelNote, reelsByShortcode, reelTitle } from './reel-rows';

/** Anything above this many times their usual is drawn at the top of the axis. */
export const ENGAGEMENT_CAP = 15;

/** The axis: 0, 1, 5, 10 and 15 times their usual. */
export const ENGAGEMENT_TICKS: readonly number[] = [0, 1, 5, 10, 15];

/**
 * The four lines, in the order the legend and the hover card list them. `word` is how the subtitle
 * and the hover card count them ("2,310 likes"); views are the reel's plays.
 */
export const ENGAGEMENT_SERIES = [
  { key: 'plays', label: 'Views', word: 'views', color: VIEWS },
  { key: 'likes', label: 'Likes', word: 'likes', color: LIKES },
  { key: 'comments', label: 'Comments', word: 'comments', color: COMMENTS },
  { key: 'shares', label: 'Shares', word: 'shares', color: SHARES },
] as const;

export type EngagementKey = (typeof ENGAGEMENT_SERIES)[number]['key'];

type PerKey<T> = Record<EngagementKey, T>;

/** One column: a reel of the range. */
export interface EngagementRow extends PerKey<number | null> {
  /** The reel's shortcode. */
  id: string;
  ours: boolean;
  /** {@link ENGAGEMENT_CAP} for our reels (the height of its pale band), `null` for theirs. */
  band: number | null;
  /** The multiples as they are, not capped (what the hover card says). */
  times: PerKey<number | null>;
  /** What the reel has, as the page's reels list it; `null` where the reel or the number is unknown. */
  counts: PerKey<number | null>;
  /** The hover card's heading: the reel's caption. */
  title: string;
  /** "Ours · Granite · Sun 25 Oct". */
  note: string;
}

export interface EngagementChartView {
  /** False when no reel was posted in the range. */
  hasData: boolean;
  /** `plays`, `likes`, `comments` and `shares` of a row are what is drawn: the multiple, capped. */
  rows: EngagementRow[];
  labels: string[];
  /** "Every reel of the last 90 days, each against their usual reel (views 9,000, likes 700, comments 20, shares 40) · blue bands are our reels". */
  subtitle: string;
  ariaLabel: string;
  /** Whether a multiple went above the axis, which the card says in a line under the chart. */
  capped: boolean;
}

function capped(times: number | null): number | null {
  return times === null ? null : Math.min(times, ENGAGEMENT_CAP);
}

/** "since us (3 Aug)" and "of the last 90 days" after "Every reel". */
function reelsRange(numbers: InstagramNumbers, options: TextOptions): string {
  const words = rangeWords(numbers, options);
  return numbers.range === 'since' ? words : `of the ${words}`;
}

/** "(views 9,000, likes 700, comments 20, shares 40)", leaving out what the account has no usual for. */
function usualText(usual: InstagramNumbers['usual']): string {
  const parts = ENGAGEMENT_SERIES.flatMap(({ key, word }) => {
    const value = usual[key];
    return value === null ? [] : [`${word} ${countText(value)}`];
  });
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

export function engagementChartView(
  numbers: InstagramNumbers,
  reels: readonly InstagramReel[],
  options: TextOptions = {},
): EngagementChartView {
  const byCode = reelsByShortcode(reels);
  const rows = numbers.engagement.map((point): EngagementRow => {
    const reel = byCode.get(point.shortcode);
    const times: PerKey<number | null> = {
      plays: point.plays ?? null,
      likes: point.likes,
      comments: point.comments,
      shares: point.shares,
    };
    return {
      id: point.shortcode,
      ours: point.ours,
      band: point.ours ? ENGAGEMENT_CAP : null,
      plays: capped(times.plays),
      likes: capped(times.likes),
      comments: capped(times.comments),
      shares: capped(times.shares),
      times,
      counts: {
        plays: reel?.plays ?? null,
        likes: reel?.likes ?? null,
        comments: reel?.comments ?? null,
        shares: reel?.shares ?? null,
      },
      title: reelTitle(reel, point.postedAt, options),
      note: reelNote(point, reel, options),
    };
  });
  const range = reelsRange(numbers, options);
  return {
    hasData: rows.length > 0,
    rows,
    labels: monthLabels(
      numbers.engagement.map((point) => point.postedAt),
      options,
    ),
    subtitle: `Every reel ${range}, each against their usual reel${usualText(numbers.usual)}${SEPARATOR}blue bands are our reels`,
    ariaLabel:
      'Views, likes, comments and shares of every reel, each as a multiple of their usual reel, our reels on a pale blue band',
    capped: rows.some((row) =>
      ENGAGEMENT_SERIES.some(({ key }) => (row.times[key] ?? 0) > ENGAGEMENT_CAP),
    ),
  };
}

/** What the hover card says for one series of a row: "3.3×" and "2,310 likes"; `null` when it has no multiple. */
export function engagementFigure(
  row: EngagementRow,
  key: EngagementKey,
): { value: string; note: string | undefined } | null {
  const times = row.times[key];
  if (times === null) return null;
  const count = row.counts[key];
  const word = ENGAGEMENT_SERIES.find((series) => series.key === key)?.word ?? key;
  return {
    value: timesText(times),
    note: count === null ? undefined : `${countText(count)} ${word}`,
  };
}

/**
 * Where the names at the right ends of the lines go: `ends` are the lines' end heights (pixels from
 * the top), the answer is the names' heights in the same order. A name sits on its line's end
 * unless another is closer than `gap`; names that would touch are stacked `gap` apart, in the
 * order of their lines, around the middle of those lines' ends.
 */
export function spreadNames(ends: readonly number[], gap: number): number[] {
  const order = ends.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  const groups: { names: typeof order; top: number }[] = [];
  for (const name of order) {
    groups.push({ names: [name], top: name.y });
    // Merge the newest group into the one above it while they touch.
    for (;;) {
      const below = groups.at(-1);
      const above = groups.at(-2);
      if (below === undefined || above === undefined) break;
      if (below.top >= above.top + above.names.length * gap) break;
      const names = [...above.names, ...below.names];
      const middle = names.reduce((sum, one) => sum + one.y, 0) / names.length;
      groups.splice(-2, 2, { names, top: middle - ((names.length - 1) * gap) / 2 });
    }
  }
  const placed = [...ends];
  for (const group of groups) {
    group.names.forEach((name, row) => {
      placed[name.index] = group.top + row * gap;
    });
  }
  return placed;
}

/** The legend above the chart: the four lines and the band. */
export const ENGAGEMENT_LEGEND = [
  ...ENGAGEMENT_SERIES.map(({ label, color }) => ({ label, color })),
  { label: 'Our reel', color: `${OURS}59` },
] as const;
