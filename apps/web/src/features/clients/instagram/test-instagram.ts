// Test data for the client page's Instagram section: Falcon FPV as board CLPage draws them (12,480
// followers, 22 reels of the last 90 days, 7 of them ours), in the shape of the Instagram API
// (`ClientInstagram`, packages/shared/src/domain/instagram.ts). Not imported by the app.
//
// The numbers of a range are worked out here the plain way (medians of the reels in the range),
// only so that the page and its tests have something real-looking to read; the engine's own are
// packages/shared/src/domain/instagram-numbers.ts.

import type {
  ClientInstagram,
  InstagramEngagementPoint,
  InstagramNumbers,
  InstagramPlaysPoint,
  InstagramRange,
  InstagramReel,
} from '@studio/shared';

/** The scan the board shows: Mon 26 Oct, 06:00 in Israel (UTC+2 since Sun 25 Oct). */
export const FALCON_SCAN_AT = '2026-10-26T04:00:00.000Z';

/** The next one, a week later. */
export const FALCON_NEXT_SCAN_AT = '2026-11-02T04:00:00.000Z';

/** The time zone the board's days are written in. */
export const FALCON_TIME_ZONE = 'Asia/Jerusalem';

/** "now" for the words of a day, a few days after the last scan. */
export const FALCON_NOW = Date.parse('2026-10-28T10:00:00.000Z');

interface Fixture {
  shortcode: string;
  postedAt: string;
  caption: string;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  /** The video it is linked to; `null` for a reel that is theirs. */
  job: string | null;
}

/** The 22 reels of the last 90 days, oldest first. */
const FIXTURES: readonly Fixture[] = [
  ['Gear check before the flight', '2026-08-03T12:00:00.000Z', 3200, 202, 7, 31, null],
  [
    'Maps Search, a quick one in the city',
    '2026-08-07T12:00:00.000Z',
    11200,
    596,
    29,
    370,
    'Maps Search',
  ],
  ['New props, first test', '2026-08-11T12:00:00.000Z', 5100, 341, 14, 61, null],
  ['Sunrise over the quarry', '2026-08-15T12:00:00.000Z', 5300, 296, 9, 38, null],
  ['Battery tips for the cold', '2026-08-20T12:00:00.000Z', 6100, 378, 17, 88, null],
  [
    'Window cleaning ad, one take',
    '2026-08-24T12:00:00.000Z',
    19700,
    1158,
    46,
    591,
    'Window cleaning ad',
  ],
  ['Practice gate, take 12', '2026-08-29T12:00:00.000Z', 4000, 241, 13, 43, null],
  ['Rooftop hover', '2026-09-02T12:00:00.000Z', 3100, 211, 8, 26, null],
  ['Q&A: which goggles?', '2026-09-06T12:00:00.000Z', 7400, 427, 17, 115, null],
  ['Harbour flyby', '2026-09-11T12:00:00.000Z', 5600, 347, 15, 67, null],
  ['Low and slow over the dunes', '2026-09-16T12:00:00.000Z', 6300, 406, 14, 76, null],
  ['Rain delay, so we build', '2026-09-21T12:00:00.000Z', 2900, 173, 7, 28, null],
  ['Wedding in the vineyard', '2026-09-26T14:30:00.000Z', 16000, 870, 40, 310, 'Vineyard wedding'],
  ['Crash compilation, part 3', '2026-09-30T10:45:00.000Z', 6100, 410, 18, 96, null],
  [
    'Tel Aviv beach at golden hour',
    '2026-10-04T16:00:00.000Z',
    18400,
    980,
    33,
    450,
    'Tel Aviv beach',
  ],
  ['Repair day, broke two props', '2026-10-08T13:20:00.000Z', 2400, 120, 9, 4, null],
  ['Dive off the tower', '2026-10-11T18:10:00.000Z', 22800, 1480, 64, 610, null],
  ['Positano from above', '2026-10-14T15:50:00.000Z', 41200, 2310, 96, 1240, 'סרטון אינסטגרם חוף'],
  ['Behind the goggles: my setup', '2026-10-17T09:30:00.000Z', 3100, 190, 25, 9, null],
  [
    'Chasing the train at 120 km/h',
    '2026-10-20T17:05:00.000Z',
    27500,
    1640,
    71,
    820,
    'Rooftop Run',
  ],
  ['Morning practice, new freestyle line', '2026-10-22T05:15:00.000Z', 4200, 280, 11, 18, null],
  [
    'Granite Fiber, one take through the warehouse',
    '2026-10-25T17:40:00.000Z',
    9800,
    610,
    22,
    140,
    'Granite',
  ],
].map(([caption, postedAt, plays, likes, comments, shares, job], index) => ({
  shortcode: `Falcon${String(index).padStart(2, '0')}`,
  caption: caption as string,
  postedAt: postedAt as string,
  plays: plays as number,
  likes: likes as number,
  comments: comments as number,
  shares: shares as number,
  job: job as string | null,
}));

/** What is usual for the account: the median of its 22 reels. */
export const FALCON_USUAL = { plays: 6100, likes: 406, comments: 17, shares: 88 } as const;

/** The day the first reel of the last 90 days is on or after, per range (the scan is Mon 26 Oct). */
const FROM: Record<InstagramRange, string> = {
  since: '2026-08-03',
  '90': '2026-07-28',
  '30': '2026-09-26',
};

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function ratio(ours: number | null, theirs: number | null): number | null {
  return ours === null || theirs === null || theirs === 0 ? null : ours / theirs;
}

/** The weeks (counting from Mon 3 Aug, as `FOLLOWERS_LINE`'s scans) with a dot on the board's line. */
const OURS_WEEKS: readonly number[] = [3, 6, 8, 9, 11, 12];

/** When the weekly scan `week` weeks after Mon 3 Aug started. */
const scanAt = (week: number): string =>
  new Date(Date.parse('2026-08-03T04:00:00.000Z') + week * 7 * 86_400_000).toISOString();

/** The followers of the 13 weekly scans from Mon 3 Aug to Mon 26 Oct, the board's dots on ours. */
const FOLLOWERS_LINE = [
  10550, 10590, 10650, 10860, 10950, 11070, 11298, 11408, 11548, 11848, 11998, 12168, 12480,
].map((followers, week) => ({
  at: scanAt(week),
  followers,
  ours: OURS_WEEKS.includes(week),
}));

/** The new shares of the last 8 weeks, the board's line, ending on this week's 2,140. */
const SHARES_LINE = [980, 1210, 860, 1400, 1150, 1550, 1551, 2140].map((shares, index) => ({
  at: scanAt(5 + index),
  shares,
}));

/** The reels of Falcon FPV the way the API lists them, newest first. */
export function falconReels(): InstagramReel[] {
  return FIXTURES.map(
    (one): InstagramReel => ({
      shortcode: one.shortcode,
      url: `https://www.instagram.com/reel/${one.shortcode}/`,
      postedAt: one.postedAt,
      caption: one.caption,
      durationSec: 28,
      plays: one.plays,
      likes: one.likes,
      comments: one.comments,
      shares: one.shares,
      sound: 'Original audio',
      coauthors: [],
      hashtags: [],
      pinned: false,
      paidPartnership: false,
      job: one.job === null ? null : { id: `job-${one.shortcode}`, name: one.job },
      timesUsual: one.plays / FALCON_USUAL.plays,
    }),
  ).reverse();
}

/** The numbers block of one range, as the engine would work it out for the reels in it. */
export function falconNumbers(range: InstagramRange = 'since'): InstagramNumbers {
  const from = FROM[range];
  const inRange = FIXTURES.filter((one) => one.postedAt.slice(0, 10) >= from);
  const ours = inRange.filter((one) => one.job !== null);
  const theirs = inRange.filter((one) => one.job === null);
  const typical = (reels: readonly Fixture[], key: 'plays' | 'likes') =>
    median(reels.map((one) => one[key]));

  const plays: InstagramPlaysPoint[] = inRange.map((one) => ({
    shortcode: one.shortcode,
    postedAt: one.postedAt,
    plays: one.plays,
    ours: one.job !== null,
  }));
  const engagement: InstagramEngagementPoint[] = inRange.map((one) => ({
    shortcode: one.shortcode,
    postedAt: one.postedAt,
    ours: one.job !== null,
    plays: one.plays / FALCON_USUAL.plays,
    likes: one.likes / FALCON_USUAL.likes,
    comments: one.comments / FALCON_USUAL.comments,
    shares: one.shares / FALCON_USUAL.shares,
  }));

  return {
    range,
    from,
    sinceUs: '2026-08-03',
    usual: { ...FALCON_USUAL },
    tiles: {
      followers: { now: 12480, thisWeek: 312, sinceUs: 1930, line: FOLLOWERS_LINE },
      playsPerReel: {
        ours: typical(ours, 'plays'),
        theirs: typical(theirs, 'plays'),
        ratio: ratio(typical(ours, 'plays'), typical(theirs, 'plays')),
      },
      likesPerReel: {
        ours: typical(ours, 'likes'),
        theirs: typical(theirs, 'likes'),
        ratio: ratio(typical(ours, 'likes'), typical(theirs, 'likes')),
      },
      sharesAWeek: {
        thisWeek: { ours: 1610, theirs: 530 },
        weekBefore: { ours: 1120, theirs: 431 },
        line: SHARES_LINE,
      },
    },
    plays,
    engagement,
  };
}

/** Falcon FPV's page: an account, the scan of Mon 26 Oct, the numbers of `range` and their reels. */
export function falconInstagram(range: InstagramRange = 'since'): ClientInstagram {
  return {
    account: {
      handle: 'falcon.fpv',
      since: '2026-08-01',
      addedAt: '2026-10-26T03:50:00.000Z',
      fullName: 'Falcon FPV',
      bio: 'FPV drone pilot. Bookings in DM.',
      private: false,
      photoSavedAt: null,
    },
    lastScan: {
      startedAt: '2026-10-26T04:00:00.000Z',
      finishedAt: FALCON_SCAN_AT,
      outcome: 'ok',
      error: null,
      followers: 12480,
      following: 412,
      posts: 311,
      reelsRead: 22,
      costUsd: 0.1,
    },
    scanning: false,
    nextScanAt: FALCON_NEXT_SCAN_AT,
    numbers: falconNumbers(range),
    reels: falconReels(),
    linkableJobs: [
      {
        jobId: 'orchard-crunch',
        name: 'Orchard crunch',
        deliveredAt: '2026-10-21T10:00:00.000Z',
        stage: 'delivered',
      },
    ],
  };
}
