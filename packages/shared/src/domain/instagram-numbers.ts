import { addDays, DAY_MS, localDayOf, startOfLocalDay } from './analytics-time.ts';
import type {
  ClientInstagramSummary,
  InstagramEngagementPoint,
  InstagramNumbers,
  InstagramPlaysPoint,
  InstagramRange,
  InstagramReel,
  InstagramTiles,
  InstagramUsual,
} from './instagram.ts';

// The numbers of Clients × Instagram (IG6, plan "The numbers"): pure functions that turn what the
// scans stored (the reels with their reads, the scans that ended `ok`, the account's "Working
// together since" day, the client's first delivery) into the {@link InstagramNumbers} block, the
// reels list's rows and the Clients list's summary. The repositories feed them; nothing here reads
// a table, a file or the clock: `now` and the time zone are inputs, so a day is the day on the
// client's wall clock and a test can say what time it is.
//
//   Ours = a reel linked to a job; theirs = every other reel.
//   Since us starts on "Working together since" (else the first delivery, else the first scan): the
//   reels count from that day, whenever the first scan was, because a reel's numbers are read
//   whenever it was posted. Followers count from the later of that day and the first scan that read
//   the profile, because followers before that scan are not known.
//   Usual = the median of the account's reels of the last 90 days (plays, likes, comments, shares
//   each); × usual = a reel's number ÷ its usual, `null` while the usual is 0 or not known.
//
// The weekly scan's time (Monday 06:00, local) is the schedule's: domain/instagram-schedule.ts.

// --- what the numbers are made from --------------------------------------------------------------

/**
 * A scan that ended `ok`: its id, when it started (milliseconds since the epoch) and the followers
 * it read. The repository's scan has these fields.
 */
export interface InstagramNumbersScan {
  id: number;
  startedAt: number;
  followers: number | null;
}

/**
 * A reel as the scans stored it, with the numbers of its latest read. The repository's reel has
 * these fields (and more, which are ignored). `jobId` is the job it is linked to: the reel is ours
 * with one, theirs without.
 */
export interface InstagramNumbersReel {
  shortcode: string;
  url: string;
  /** Milliseconds since the epoch. */
  postedAt: number;
  caption: string | null;
  durationSec: number | null;
  plays: number;
  likes: number;
  comments: number;
  shares: number | null;
  sound: string | null;
  coauthors: readonly string[];
  hashtags: readonly string[];
  pinned: boolean;
  paidPartnership: boolean;
  jobId: string | null;
}

/** What one scan read of one reel's shares (the repository's reel read has these fields). */
export interface InstagramNumbersRead {
  shortcode: string;
  scanId: number;
  shares: number | null;
}

/** The names of the jobs that reels link, by job id (the names of their deliveries). */
export type InstagramJobNames = ReadonlyMap<string, string>;

/** The days "usual" is worked out over, and the longest range. */
export const INSTAGRAM_USUAL_DAYS = 90;

/** The days of the two ranges that count back from today (`since` counts from since us). */
const RANGE_DAYS: Readonly<Record<Exclude<InstagramRange, 'since'>, number>> = {
  '90': 90,
  '30': 30,
};

const iso = (ms: number): string => new Date(ms).toISOString();

// --- median and × usual --------------------------------------------------------------------------

/** The median of the numbers (the mean of the middle two when there is an even count); `null` for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/** `value` as a multiple of `usual`; `null` when either is not known or the usual is 0. */
export function timesUsual(value: number | null, usual: number | null): number | null {
  if (value === null || usual === null || usual <= 0) return null;
  return value / usual;
}

/** The first moment of the day `days` before today on the wall clock of `timeZone`. */
function startOfDaysAgo(days: number, now: number, timeZone: string): number {
  return startOfLocalDay(addDays(localDayOf(now, timeZone), -days), timeZone);
}

/**
 * What is usual for the account: the median of its reels posted in the last 90 days, for plays,
 * likes, comments and shares each (a reel whose shares could not be read is left out of the shares'
 * median). A number is `null` when there is no reel to take it from.
 */
export function instagramUsual(
  reels: readonly InstagramNumbersReel[],
  now: number,
  timeZone: string,
): InstagramUsual {
  const from = startOfDaysAgo(INSTAGRAM_USUAL_DAYS, now, timeZone);
  const recent = reels.filter((reel) => reel.postedAt >= from);
  return {
    plays: median(recent.map((reel) => reel.plays)),
    likes: median(recent.map((reel) => reel.likes)),
    comments: median(recent.map((reel) => reel.comments)),
    shares: median(recent.flatMap((reel) => (reel.shares === null ? [] : [reel.shares]))),
  };
}

// --- since us and the range ----------------------------------------------------------------------

/** What the two "since us" days are worked out from. */
export interface SinceUsInput {
  /** The account's "Working together since" day; `null` means the client's first delivery. */
  since: string | null;
  /** When the client's first delivery was marked; `null` for a client with none. */
  firstDeliveryAt: number | null;
  /** When the first scan that read the profile started. */
  firstScanAt: number;
  timeZone: string;
}

/**
 * The day "since us" starts on, which the page names and the reels count from: the account's
 * "Working together since" day, else the day of the client's first delivery. Without either it is
 * the first scan's day. It may be before the first scan: a reel's plays, likes and comments are
 * read whenever it was posted ({@link followersSinceDay} is the day followers count from).
 */
export function sinceUsDay(input: SinceUsInput): string {
  const { since, firstDeliveryAt, firstScanAt, timeZone } = input;
  if (since !== null) return since;
  return localDayOf(firstDeliveryAt ?? firstScanAt, timeZone);
}

/**
 * The day the followers' "since us" counts from: the later of {@link sinceUsDay} and the day of the
 * first scan that read the profile, because the followers before that scan are not known.
 */
export function followersSinceDay(input: SinceUsInput): string {
  const firstScanDay = localDayOf(input.firstScanAt, input.timeZone);
  const together = sinceUsDay(input);
  return together > firstScanDay ? together : firstScanDay;
}

/**
 * The first day a range counts: `since` starts on the day since us starts on, `90` and `30` on the
 * day that many days before today.
 */
export function instagramRangeFrom(
  range: InstagramRange,
  now: number,
  timeZone: string,
  sinceUs: string,
): string {
  return range === 'since' ? sinceUs : addDays(localDayOf(now, timeZone), -RANGE_DAYS[range]);
}

// --- the tiles -----------------------------------------------------------------------------------

type OursTheirs = { ours: number | null; theirs: number | null };

const NOT_KNOWN: OursTheirs = { ours: null, theirs: null };

/** The scans in time order (the input's order is not trusted). */
function inTimeOrder(scans: readonly InstagramNumbersScan[]): InstagramNumbersScan[] {
  return [...scans].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
}

/**
 * The two pairs of scans the "Shares a week" tile reads: `[older, newer]` for this week (the last
 * two scans) and for the week before (the two before those), in that order; as many as there are
 * scans for. The caller fetches the reads of these scans for {@link computeInstagramNumbers}.
 */
export function sharesScanPairs(
  scans: readonly InstagramNumbersScan[],
): Array<[older: InstagramNumbersScan, newer: InstagramNumbersScan]> {
  const ordered = inTimeOrder(scans);
  const pairs: Array<[InstagramNumbersScan, InstagramNumbersScan]> = [];
  for (let newer = ordered.length - 1; newer >= 1 && pairs.length < 2; newer -= 1) {
    const older = ordered[newer - 1];
    const last = ordered[newer];
    if (older !== undefined && last !== undefined) pairs.push([older, last]);
  }
  return pairs;
}

/**
 * The pairs of consecutive scans the "Shares a week" line draws, oldest first: every pair whose
 * newer scan started on or after the day `from` (the range's first day) on the wall clock of
 * `timeZone`. The older scan of the first pair may be before `from`.
 */
function sharesLinePairs(
  scans: readonly InstagramNumbersScan[],
  from: string,
  timeZone: string,
): Array<[older: InstagramNumbersScan, newer: InstagramNumbersScan]> {
  const ordered = inTimeOrder(scans);
  const pairs: Array<[InstagramNumbersScan, InstagramNumbersScan]> = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const older = ordered[index - 1];
    const newer = ordered[index];
    if (
      older !== undefined &&
      newer !== undefined &&
      localDayOf(newer.startedAt, timeZone) >= from
    ) {
      pairs.push([older, newer]);
    }
  }
  return pairs;
}

/**
 * The pairs of scans whose reads {@link computeInstagramNumbers} needs for the "Shares a week"
 * tile: the pairs of this week and the week before ({@link sharesScanPairs}) and the pairs of the
 * tile's line for the range. The caller fetches the reads of these scans and passes them as
 * `reads`; each scan is in two pairs at most, so a caller that fetches by scan can fetch each once.
 */
export function sharesReadPairs(
  input: Pick<
    InstagramNumbersInput,
    'range' | 'now' | 'timeZone' | 'since' | 'firstDeliveryAt' | 'scans'
  >,
): Array<[older: InstagramNumbersScan, newer: InstagramNumbersScan]> {
  const scans = inTimeOrder(input.scans);
  const first = scans[0];
  if (first === undefined) return [];
  const { timeZone } = input;
  const sinceUs = sinceUsDay({
    since: input.since,
    firstDeliveryAt: input.firstDeliveryAt,
    firstScanAt: first.startedAt,
    timeZone,
  });
  const from = instagramRangeFrom(input.range, input.now, timeZone, sinceUs);
  const pairs = [...sharesLinePairs(scans, from, timeZone)];
  for (const pair of sharesScanPairs(scans)) {
    if (!pairs.some(([, newer]) => newer.id === pair[1].id)) pairs.push(pair);
  }
  return pairs.sort((a, b) => a[1].startedAt - b[1].startedAt || a[1].id - b[1].id);
}

/** Whether one of our reels (a reel with a job) was posted after `after` and up to `until`. */
function oursPostedBetween(
  reels: readonly InstagramNumbersReel[],
  after: number,
  until: number,
): boolean {
  return reels.some(
    (reel) => reel.jobId !== null && reel.postedAt > after && reel.postedAt <= until,
  );
}

function followersTile(
  scans: readonly InstagramNumbersScan[],
  reels: readonly InstagramNumbersReel[],
  countFrom: string,
  from: string,
  timeZone: string,
): InstagramTiles['followers'] {
  const read = inTimeOrder(scans).flatMap((scan) =>
    scan.followers === null ? [] : [{ ...scan, followers: scan.followers }],
  );
  const last = read[read.length - 1];
  if (last === undefined) return { now: null, thisWeek: null, sinceUs: null, line: [] };

  // The dots: a scan is `ours` when one of our reels was posted since the scan before it that
  // read the followers (the first scan has none before it, so no dot).
  const line = read.flatMap((scan, index) => {
    if (localDayOf(scan.startedAt, timeZone) < from) return [];
    const before = read[index - 1];
    return [
      {
        at: iso(scan.startedAt),
        followers: scan.followers,
        ours: before !== undefined && oursPostedBetween(reels, before.startedAt, scan.startedAt),
      },
    ];
  });
  const earlier = read.slice(0, -1);
  if (earlier.length === 0) return { now: last.followers, thisWeek: null, sinceUs: null, line };

  // This week: against the scan nearest to 7 days before the last one.
  const weekAgo = last.startedAt - 7 * DAY_MS;
  let nearest = earlier[0] ?? last;
  for (const scan of earlier) {
    if (Math.abs(scan.startedAt - weekAgo) < Math.abs(nearest.startedAt - weekAgo)) nearest = scan;
  }

  // Since us: against the last scan on or before the day the followers count from (the first scan,
  // when that day is the first scan's own day).
  let baseline = read[0] ?? last;
  for (const scan of read) {
    if (localDayOf(scan.startedAt, timeZone) <= countFrom) baseline = scan;
  }

  return {
    now: last.followers,
    thisWeek: last.followers - nearest.followers,
    sinceUs: last.followers - baseline.followers,
    line,
  };
}

/**
 * The shares the reels gained between two scans, ours and theirs. A reel counts when both scans
 * read its shares, or when it was posted after the older scan and the newer one read them (all its
 * shares are new). `{ null, null }` when no reel counts.
 */
function sharesGained(
  older: InstagramNumbersScan,
  newer: InstagramNumbersScan,
  reels: readonly InstagramNumbersReel[],
  reads: ReadonlyMap<string, InstagramNumbersRead>,
): OursTheirs {
  const key = (shortcode: string, scanId: number) => `${scanId}:${shortcode}`;
  let counted = 0;
  let ours = 0;
  let theirs = 0;
  for (const reel of reels) {
    const after = reads.get(key(reel.shortcode, newer.id))?.shares ?? null;
    if (after === null) continue;
    const beforeRead = reads.get(key(reel.shortcode, older.id));
    let gained: number;
    if (beforeRead !== undefined) {
      if (beforeRead.shares === null) continue;
      gained = Math.max(0, after - beforeRead.shares);
    } else if (reel.postedAt >= older.startedAt) {
      gained = after;
    } else {
      continue;
    }
    counted += 1;
    if (reel.jobId === null) theirs += gained;
    else ours += gained;
  }
  return counted === 0 ? NOT_KNOWN : { ours, theirs };
}

/** Ours and theirs added up; `null` when neither is known. */
function oursTheirsTotal(shares: OursTheirs): number | null {
  if (shares.ours === null && shares.theirs === null) return null;
  return (shares.ours ?? 0) + (shares.theirs ?? 0);
}

function perReel(
  reels: readonly InstagramNumbersReel[],
  pick: (reel: InstagramNumbersReel) => number,
): OursTheirs & { ratio: number | null } {
  const ours = median(reels.filter((reel) => reel.jobId !== null).map(pick));
  const theirs = median(reels.filter((reel) => reel.jobId === null).map(pick));
  const ratio = ours === null || theirs === null || theirs <= 0 ? null : ours / theirs;
  return { ours, theirs, ratio };
}

// --- the numbers block ---------------------------------------------------------------------------

export interface InstagramNumbersInput {
  range: InstagramRange;
  /** Milliseconds since the epoch. */
  now: number;
  /** An IANA name such as `Asia/Jerusalem`: whose wall clock the days are on. */
  timeZone: string;
  /** The account's "Working together since" day; `null` means the client's first delivery. */
  since: string | null;
  /** When the client's first delivery was marked; `null` for a client with none. */
  firstDeliveryAt: number | null;
  /** The scans that ended `ok`, in any order. */
  scans: readonly InstagramNumbersScan[];
  /** Every reel of the account. */
  reels: readonly InstagramNumbersReel[];
  /** The reads of the scans {@link sharesReadPairs} names; none is fine (shares a week is unknown). */
  reads?: readonly InstagramNumbersRead[];
  /** The names of the jobs the reels link; a job with no name is shown by its id. */
  jobNames?: InstagramJobNames;
}

/** The name a linked reel's job is shown by: its delivery's name, else its id. */
function jobNameOf(jobId: string, jobNames: InstagramJobNames | undefined): string {
  return jobNames?.get(jobId) ?? jobId;
}

/**
 * The numbers of the Instagram section for one range. `null` while no scan has read the profile.
 * The tiles' followers and Shares a week do not depend on the range (they say "this week" and
 * "since us"); the lines of both tiles, the medians per reel and the two series do: they count the
 * scans and the reels since the range's first day. Usual is always the last 90 days.
 */
export function computeInstagramNumbers(input: InstagramNumbersInput): InstagramNumbers | null {
  const { range, now, timeZone, reels } = input;
  const scans = inTimeOrder(input.scans);
  const first = scans[0];
  if (first === undefined) return null;

  const sinceBasis = {
    since: input.since,
    firstDeliveryAt: input.firstDeliveryAt,
    firstScanAt: first.startedAt,
    timeZone,
  };
  const sinceUs = sinceUsDay(sinceBasis);
  const from = instagramRangeFrom(range, now, timeZone, sinceUs);
  const fromMs = startOfLocalDay(from, timeZone);
  const usual = instagramUsual(reels, now, timeZone);

  const inRange = reels
    .filter((reel) => reel.postedAt >= fromMs)
    .sort((a, b) => a.postedAt - b.postedAt || (a.shortcode < b.shortcode ? -1 : 1));

  const reads = new Map<string, InstagramNumbersRead>();
  for (const read of input.reads ?? []) reads.set(`${read.scanId}:${read.shortcode}`, read);
  const [thisWeek, weekBefore] = sharesScanPairs(scans);

  const plays: InstagramPlaysPoint[] = inRange.map((reel) => ({
    shortcode: reel.shortcode,
    postedAt: iso(reel.postedAt),
    plays: reel.plays,
    ours: reel.jobId !== null,
    job: reel.jobId === null ? null : jobNameOf(reel.jobId, input.jobNames),
  }));

  const engagement: InstagramEngagementPoint[] = inRange.map((reel) => ({
    shortcode: reel.shortcode,
    postedAt: iso(reel.postedAt),
    ours: reel.jobId !== null,
    plays: timesUsual(reel.plays, usual.plays),
    likes: timesUsual(reel.likes, usual.likes),
    comments: timesUsual(reel.comments, usual.comments),
    shares: timesUsual(reel.shares, usual.shares),
  }));

  return {
    range,
    from,
    sinceUs,
    usual,
    tiles: {
      followers: followersTile(scans, reels, followersSinceDay(sinceBasis), from, timeZone),
      playsPerReel: perReel(inRange, (reel) => reel.plays),
      likesPerReel: perReel(inRange, (reel) => reel.likes),
      sharesAWeek: {
        thisWeek: thisWeek === undefined ? NOT_KNOWN : sharesGained(...thisWeek, reels, reads),
        weekBefore:
          weekBefore === undefined ? NOT_KNOWN : sharesGained(...weekBefore, reels, reads),
        line: sharesLinePairs(scans, from, timeZone).map(([older, newer]) => ({
          at: iso(newer.startedAt),
          shares: oursTheirsTotal(sharesGained(older, newer, reels, reads)),
        })),
      },
    },
    plays,
    engagement,
  };
}

// --- the reels list ------------------------------------------------------------------------------

/**
 * The rows of the Reels list: every reel, newest first, with the video it is linked to (its name,
 * else its id) and its plays × usual.
 */
export function instagramReelRows(
  reels: readonly InstagramNumbersReel[],
  usual: InstagramUsual,
  jobNames?: InstagramJobNames,
): InstagramReel[] {
  return [...reels]
    .sort((a, b) => b.postedAt - a.postedAt || (a.shortcode < b.shortcode ? -1 : 1))
    .map((reel) => ({
      shortcode: reel.shortcode,
      url: reel.url,
      postedAt: iso(reel.postedAt),
      caption: reel.caption ?? '',
      durationSec: reel.durationSec,
      plays: reel.plays,
      likes: reel.likes,
      comments: reel.comments,
      shares: reel.shares,
      sound: reel.sound,
      coauthors: [...reel.coauthors],
      hashtags: [...reel.hashtags],
      pinned: reel.pinned,
      paidPartnership: reel.paidPartnership,
      job: reel.jobId === null ? null : { id: reel.jobId, name: jobNameOf(reel.jobId, jobNames) },
      timesUsual: timesUsual(reel.plays, usual.plays),
    }));
}

// --- the Clients list ----------------------------------------------------------------------------

/**
 * The Clients list's short form of a client's Instagram (L1): the followers now, this week's
 * change and ours ÷ theirs plays per reel, from the numbers of the default range (since us). The
 * numbers are `null` until a scan has read the profile. A private account is marked `private`.
 */
export function clientInstagramSummary(
  account: { handle: string; photoSavedAt: number | null; private?: boolean },
  numbers: InstagramNumbers | null,
): ClientInstagramSummary {
  return {
    handle: account.handle,
    followers: numbers?.tiles.followers.now ?? null,
    weekChange: numbers?.tiles.followers.thisWeek ?? null,
    oursVsTheirs: numbers?.tiles.playsPerReel.ratio ?? null,
    photoAt: account.photoSavedAt === null ? null : iso(account.photoSavedAt),
    // Only a private account says so; a public one has no such field.
    ...(account.private === true ? { private: true } : {}),
  };
}
