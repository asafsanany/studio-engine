// What the four tiles of the Instagram section say (board CLPage): Followers, Plays per reel, Likes
// per reel and Shares a week, as pure functions. InstagramTiles only lays these out.
//
// This is where the section reads `numbers.tiles` (and `numbers.range`, `numbers.sinceUs` for the
// words of the range). A number the block does not have yet (`null`) is "—" and its change line is
// left out, so a tile keeps its size when the numbers arrive.

import type { InstagramNumbers } from '@studio/shared';
import type { SparkRow } from '@/features/analytics/charts/Sparkline';
import type { ChangeTone } from '@/features/analytics/jobs-tiles-view';
import {
  compactText,
  countText,
  instantDayText,
  NO_NUMBER,
  rangeWords,
  SEPARATOR,
  signedText,
  type TextOptions,
  timesText,
} from './instagram-text';

export interface FollowersTileView {
  title: string;
  subtitle: string;
  /** "12,480", or "—" before a scan has read the profile. */
  value: string;
  /**
   * The followers of every scan that read the profile, oldest first, for the tile's line; a scan
   * in whose week one of our reels was posted is `marked` (a dot on the line).
   */
  rows: SparkRow[];
  /** "+312 this week · +1,930 since us"; "" when neither is known. */
  change: string;
  tone: ChangeTone;
}

export interface PairTileView {
  title: string;
  subtitle: string;
  /** Our typical reel: "18.4K", or "—" when no reel is linked to a job. */
  ours: string;
  /** Their other reels' typical reel. */
  theirs: string;
  /** "3.6× theirs"; "" when either number is missing. */
  ratio: string;
  tone: ChangeTone;
}

export interface SharesTileView {
  title: string;
  subtitle: string;
  /** All new shares of the week: "2,140", or "—". */
  value: string;
  /** The new shares of every week the scans can tell, oldest first, for the tile's line. */
  rows: SparkRow[];
  /** "Ours 1,610 · theirs 530"; "" when neither is known. */
  split: string;
  /** "+38% on the week before"; "" when the week before has nothing to compare with. */
  change: string;
  tone: ChangeTone;
}

export interface TilesView {
  followers: FollowersTileView;
  plays: PairTileView;
  likes: PairTileView;
  shares: SharesTileView;
}

function toneOf(change: number | null): ChangeTone {
  if (change === null || change === 0) return 'same';
  return change > 0 ? 'better' : 'worse';
}

function followersTile(numbers: InstagramNumbers, options: TextOptions): FollowersTileView {
  const { now, thisWeek, sinceUs, line } = numbers.tiles.followers;
  const parts: string[] = [];
  if (thisWeek !== null) parts.push(`${signedText(thisWeek)} this week`);
  if (sinceUs !== null) parts.push(`${signedText(sinceUs)} since us`);
  return {
    title: 'Followers',
    subtitle: 'Weekly scan',
    value: now === null ? NO_NUMBER : countText(now),
    rows: line.map((point) => ({
      id: point.at,
      title: instantDayText(point.at, options),
      value: point.followers,
      marked: point.ours,
    })),
    change: parts.join(SEPARATOR),
    tone: toneOf(thisWeek ?? sinceUs),
  };
}

function pairTile(
  title: string,
  tile: { ours: number | null; theirs: number | null; ratio: number | null },
  numbers: InstagramNumbers,
  options: TextOptions,
): PairTileView {
  const ratio = tile.ratio === null ? null : Number(tile.ratio.toFixed(1));
  return {
    title,
    subtitle: `Typical reel, ${rangeWords(numbers, options)}`,
    ours: tile.ours === null ? NO_NUMBER : compactText(tile.ours),
    theirs: tile.theirs === null ? NO_NUMBER : compactText(tile.theirs),
    ratio: tile.ratio === null ? '' : `${timesText(tile.ratio)} theirs`,
    tone: ratio === null || ratio === 1 ? 'same' : ratio > 1 ? 'better' : 'worse',
  };
}

/** Ours and theirs added up; `null` when neither is known. */
function sharesTotal(shares: { ours: number | null; theirs: number | null }): number | null {
  if (shares.ours === null && shares.theirs === null) return null;
  return (shares.ours ?? 0) + (shares.theirs ?? 0);
}

function sharesTile(numbers: InstagramNumbers, options: TextOptions): SharesTileView {
  const { sharesAWeek, followers } = numbers.tiles;
  const total = sharesTotal(sharesAWeek.thisWeek);
  const before = sharesTotal(sharesAWeek.weekBefore);
  // The scan before the last one starts the week the shares were gained in.
  const previous = followers.line.at(-2);
  const since = previous === undefined ? '' : instantDayText(previous.at, options);

  let change = '';
  let tone: ChangeTone = 'same';
  if (total !== null && before !== null && before > 0) {
    const percent = Math.round(((total - before) / before) * 100);
    tone = toneOf(percent);
    change =
      percent === 0
        ? 'Same as the week before'
        : `${percent > 0 ? '+' : '−'}${Math.abs(percent)}% on the week before`;
  }

  const split =
    total === null
      ? ''
      : `Ours ${sharesAWeek.thisWeek.ours === null ? NO_NUMBER : countText(sharesAWeek.thisWeek.ours)}${SEPARATOR}theirs ${
          sharesAWeek.thisWeek.theirs === null ? NO_NUMBER : countText(sharesAWeek.thisWeek.theirs)
        }`;
  return {
    title: 'Shares a week',
    subtitle: `New shares on all their reels ${since === '' ? 'this week' : `since ${since}`}`,
    value: total === null ? NO_NUMBER : countText(total),
    // A week the scans cannot tell is a break in the line, as it is a "—" in the number.
    rows: sharesAWeek.line.map((point) => ({
      id: point.at,
      title: `To ${instantDayText(point.at, options)}`,
      value: point.shares,
    })),
    split,
    change,
    tone,
  };
}

/** The four tiles for the range the numbers are for. */
export function tilesView(numbers: InstagramNumbers, options: TextOptions = {}): TilesView {
  const { tiles } = numbers;
  return {
    followers: followersTile(numbers, options),
    plays: pairTile('Plays per reel', tiles.playsPerReel, numbers, options),
    likes: pairTile('Likes per reel', tiles.likesPerReel, numbers, options),
    shares: sharesTile(numbers, options),
  };
}
