// What the page says about its reels, as pure functions. Two readers:
//
// - the two charts: the hover card's heading (the caption), the line under the numbers, and the
//   month labels under the columns. A chart's column is one reel of the numbers block (shortcode,
//   when it was posted, ours or theirs); the caption, the video it is linked to and the counts come
//   from the reels the page has, found by shortcode.
// - the Reels list (board CLPage): a row of words for each reel, the All / Ours / Theirs filter,
//   the ten rows before Show all, and the lines above and under the list.

import type { ClientInstagram, InstagramReel, InstagramReelJob } from '@studio/shared';
import {
  compactText,
  countText,
  dayText,
  instantDayText,
  localDay,
  monthText,
  NO_NUMBER,
  reelsText,
  SEPARATOR,
  type TextOptions,
  timesText,
  timeText,
} from './instagram-text';

/** The longest caption a hover card shows before it says "…". */
const CAPTION_MAX_LENGTH = 90;

/** The reels the page has, by shortcode. */
export function reelsByShortcode(reels: readonly InstagramReel[]): Map<string, InstagramReel> {
  return new Map(reels.map((reel) => [reel.shortcode, reel]));
}

/**
 * The hover card's heading: the reel's caption on one line (cut at {@link CAPTION_MAX_LENGTH}
 * characters), or "Reel of Sun 25 Oct" for a reel with none (or one the page does not have).
 */
export function reelTitle(
  reel: InstagramReel | undefined,
  postedAt: string,
  options: TextOptions = {},
): string {
  const caption = (reel?.caption ?? '').replace(/\s+/g, ' ').trim();
  if (caption === '') return `Reel of ${dayText(localDay(postedAt, options))}`;
  return caption.length > CAPTION_MAX_LENGTH
    ? `${caption.slice(0, CAPTION_MAX_LENGTH - 1).trimEnd()}…`
    : caption;
}

/** "Ours · Granite · Sun 25 Oct" for a reel linked to a video, "Theirs · Thu 22 Oct" for any other. */
export function reelNote(
  point: { ours: boolean; postedAt: string },
  reel: InstagramReel | undefined,
  options: TextOptions = {},
): string {
  const who = point.ours ? (reel?.job ? ['Ours', reel.job.name] : ['Ours']) : ['Theirs'];
  return [...who, dayText(localDay(point.postedAt, options))].join(SEPARATOR);
}

/**
 * The text under each column: the month's name under the first reel of each month, nothing under
 * the others. Reels are one column each (not one per day), oldest first.
 */
export function monthLabels(postedAts: readonly string[], options: TextOptions = {}): string[] {
  let previous = '';
  return postedAts.map((postedAt) => {
    const month = monthText(localDay(postedAt, options));
    const label = month !== previous ? month : '';
    previous = month;
    return label;
  });
}

// --- the Reels list ------------------------------------------------------------------------------

/** How many rows the list shows before Show all. */
export const REELS_PAGE_SIZE = 10;

/** The segmented control over the list: every reel, the ones linked to a video, the others. */
export const REEL_FILTERS = ['all', 'ours', 'theirs'] as const;
export type ReelFilter = (typeof REEL_FILTERS)[number];

export const REEL_FILTER_LABELS: Record<ReelFilter, string> = {
  all: 'All',
  ours: 'Ours',
  theirs: 'Theirs',
};

/** The reels the filter lets through, in the order they came (newest first). A reel is ours when it has a job. */
export function filterReels(
  reels: readonly InstagramReel[],
  filter: ReelFilter,
): readonly InstagramReel[] {
  if (filter === 'all') return reels;
  return reels.filter((reel) => (reel.job !== null) === (filter === 'ours'));
}

/** The rows on screen: the first {@link REELS_PAGE_SIZE} of the list, or every one after Show all. */
export function shownReels(
  reels: readonly InstagramReel[],
  showAll: boolean,
): readonly InstagramReel[] {
  return showAll ? reels : reels.slice(0, REELS_PAGE_SIZE);
}

/** How a reel's plays compare with the usual: green from 2× up, red under 0.75×, grey between. */
export type TimesTone = 'high' | 'low' | 'usual' | 'unknown';

/** The tone of a reel's × usual; `null` (no usual to divide by yet) is `unknown`. */
export function timesTone(times: number | null): TimesTone {
  if (times === null) return 'unknown';
  if (times >= 2) return 'high';
  if (times < 0.75) return 'low';
  return 'usual';
}

/** A reel's length: "0:28", or "—" when the scan could not read it. */
export function lengthText(durationSec: number | null): string {
  if (durationSec === null) return NO_NUMBER;
  const total = Math.round(durationSec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** When a reel was posted: "Sun 25 Oct, 19:40", in the viewer's zone. */
export function postedText(postedAt: string, options: TextOptions = {}): string {
  const day = instantDayText(postedAt, options);
  const time = timeText(postedAt, options);
  return day === '' ? '' : `${day}, ${time}`;
}

/** The other accounts on a reel, "@granite, @friend"; "" for none. */
export function withText(coauthors: readonly string[]): string {
  return coauthors.map((name) => `@${name}`).join(', ');
}

/** What a reel is tagged: "Pinned", "Paid partnership", both with a comma; "" for neither. */
export function tagsText(reel: Pick<InstagramReel, 'pinned' | 'paidPartnership'>): string {
  return [reel.pinned ? 'Pinned' : '', reel.paidPartnership ? 'Paid partnership' : '']
    .filter((tag) => tag !== '')
    .join(', ');
}

/**
 * A sound as two parts for the Sound cell: the song and its artist. The scan stores them as one
 * text, "Song · Artist" (`soundOf`), so this reads that back; "Original audio", a song with no
 * artist and "—" have no artist. It splits at the last " · ", so a song's own " · " stays in its
 * name.
 */
export function soundWords(sound: string): { song: string; artist: string | null } {
  const at = sound.lastIndexOf(SEPARATOR);
  const artist = at < 0 ? '' : sound.slice(at + SEPARATOR.length);
  if (at <= 0 || artist === '') return { song: sound, artist: null };
  return { song: sound.slice(0, at), artist };
}

/** One row of the Reels list, as words. A cell with nothing to say is "—" (the caption is `null`: the row says "No caption"). */
export interface ReelRowView {
  shortcode: string;
  /** The reel's address on Instagram. */
  url: string;
  posted: string;
  caption: string | null;
  length: string;
  plays: string;
  times: { text: string; tone: TimesTone };
  likes: string;
  comments: string;
  shares: string;
  sound: string;
  with: string;
  tags: string;
  /** The video the reel is linked to; `null` for a reel that is theirs. */
  job: InstagramReelJob | null;
}

/** The words of a reel's row. */
export function reelRowView(reel: InstagramReel, options: TextOptions = {}): ReelRowView {
  const caption = reel.caption.replace(/\s+/g, ' ').trim();
  const orDash = (text: string) => (text === '' ? NO_NUMBER : text);
  return {
    shortcode: reel.shortcode,
    url: reel.url,
    posted: postedText(reel.postedAt, options),
    caption: caption === '' ? null : caption,
    length: lengthText(reel.durationSec),
    plays: compactText(reel.plays),
    times: {
      text: reel.timesUsual === null ? NO_NUMBER : timesText(reel.timesUsual),
      tone: timesTone(reel.timesUsual),
    },
    likes: countText(reel.likes),
    comments: countText(reel.comments),
    shares: reel.shares === null ? NO_NUMBER : countText(reel.shares),
    sound: orDash(reel.sound?.trim() ?? ''),
    with: orDash(withText(reel.coauthors)),
    tags: orDash(tagsText(reel)),
    job: reel.job,
  };
}

/**
 * The line under the list's title: "Newest first · numbers from the scan of Mon 26 Oct · × usual:
 * plays against their typical reel (6.1K)". The scan is named only when the last one read the page
 * (otherwise these are older numbers, which the section says in its notices), and the typical reel
 * only when there is one.
 */
export function reelsSubtitle(
  data: Pick<ClientInstagram, 'lastScan' | 'numbers'>,
  options: TextOptions = {},
): string {
  const parts = ['Newest first'];
  const { lastScan } = data;
  if (lastScan?.outcome === 'ok') {
    parts.push(`numbers from the scan of ${instantDayText(lastScan.finishedAt, options)}`);
  }
  const usual = data.numbers?.usual.plays ?? null;
  parts.push(
    `× usual: plays against their typical reel${usual === null ? '' : ` (${compactText(usual)})`}`,
  );
  return parts.join(SEPARATOR);
}

/** "10 of 22 reels" while some are left out, "22 reels" when every one is on screen. */
export function reelsCountText(shown: number, total: number): string {
  return shown < total ? `${countText(shown)} of ${reelsText(total)}` : reelsText(total);
}

/**
 * The line under the list: how many reels are on screen, the sideways scroll and, for the admin
 * (the one who links), that nothing is matched by itself.
 */
export function reelsHint(shown: number, total: number, admin: boolean): string {
  const parts = [reelsCountText(shown, total), 'scroll sideways for every column'];
  if (admin) {
    parts.push(
      'nothing is matched by itself: right-click a reel › Link to job (a linked one: Unlink)',
    );
  }
  return parts.join(SEPARATOR);
}

/** What the list says when the filter lets no reel through. */
export const NO_REELS_FOR_FILTER: Record<Exclude<ReelFilter, 'all'>, string> = {
  ours: 'None of our videos is linked to a reel yet.',
  theirs: 'Every reel is one of ours.',
};

/** What the list says when the client has no reel at all. */
export const NO_REELS_YET = 'No reels yet.';

/** The footnote under the list: what a scan cannot read. */
export const REELS_FOOTNOTE =
  'Saves, reach, watch time and profile visits are not public, so a scan can’t read them. They need the client’s own Instagram login (Meta’s API).';
