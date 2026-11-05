// The accounts the fake scanner knows beyond the real answers of ./testdata/ (IG13): the sample
// Instagram of the design canvas's Falcon FPV (its numbers are in the design handoff,
// gen/data.py), and a few accounts that fail or are private, so the dev seed (`seed:canvas
// --instagram`), the e2e run and a QA engine on `STUDIO_RUNNER=fake` all see the same states. They
// are shaped like the actors' answers (README.md), so the real mapping and the real tables read
// them; nothing here is real and nothing reaches the network.
//
//   falcon.fpv          public, 12,480 followers, 22 reels of the last 90 days (the ten newest with the
//                     board's captions, sounds, collaborators and tags), bio and picture
//   venezia.studio    a private account
//   flaky.studio      three reels; the first scan works and every later one times out ("Instagram didn't answer")
//   credit.out        Apify refuses the run for usage (no-credit)
//   no.key            there is no Apify key (no-token)
//   studio_engine_no_such_user_8f3k2   an account that does not exist (the real answer of IG2)
//
// Times are the board's own, moved so that the board's Monday 26 Oct 06:00 (`BOARD_ANCHOR`) is
// `anchor`: the seed passes that very moment, a QA engine passes the day it starts on, and the dates
// then shift with it. A reel that is not posted yet at the scan's clock is not in its answer.

import { deflateSync } from 'node:zlib';
import {
  type FakeInstagramAccount,
  type FakeInstagramFixtures,
  loadFakeInstagramFixtures,
} from './fake-scanner.js';

/** The moment the design canvas's Instagram boards are drawn at: the scan of Mon 26 Oct 2026, 06:00 UTC. */
export const BOARD_ANCHOR = '2026-10-26T06:00:00.000Z';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Followers of Falcon FPV now, and what the 12 weeks before added (gen/data.py). */
export const FALCON_FOLLOWERS = 12_480;
export const FALCON_WEEKLY_GAINS = [40, 60, 210, 90, 120, 228, 110, 140, 300, 150, 170, 312];

/** The follower count at each of the 13 weekly scans, oldest first: 10,550 up to 12,480. */
export const FALCON_FOLLOWERS_BY_SCAN: readonly number[] = (() => {
  const counts = [FALCON_FOLLOWERS - FALCON_WEEKLY_GAINS.reduce((sum, gain) => sum + gain, 0)];
  for (const gain of FALCON_WEEKLY_GAINS) counts.push((counts.at(-1) ?? 0) + gain);
  return counts;
})();

/** The scans of the history the seed makes: the 13 Mondays of the board, 3 Aug to 26 Oct. */
export const FALCON_HISTORY_SCANS = FALCON_FOLLOWERS_BY_SCAN.length;

interface SampleReel {
  /** When it was posted, on the board's own clock (UTC). */
  posted: string;
  caption: string;
  seconds: number;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  /** `null`: the account's own audio. */
  song: [song: string, artist: string] | null;
  /** Other accounts on the reel (a collaboration). */
  with?: string[];
  paid?: boolean;
  pinned?: boolean;
}

const SONG: [string, string] = ['Midnight Run', 'Demo Artist'];

/** The ten newest reels of the board's Reels list (gen/page.py, `REELS_FULL`), newest first. */
const NEWEST: readonly SampleReel[] = [
  {
    posted: '2026-10-25T19:40:00Z',
    caption: 'Granite Fiber, one take through the warehouse',
    seconds: 28,
    plays: 9_800,
    likes: 610,
    comments: 22,
    shares: 140,
    song: null,
    with: ['granite.fiber'],
    paid: true,
  },
  {
    posted: '2026-10-22T08:15:00Z',
    caption: 'Morning practice, new freestyle line',
    seconds: 14,
    plays: 4_200,
    likes: 280,
    comments: 11,
    shares: 18,
    song: SONG,
  },
  {
    posted: '2026-10-20T20:05:00Z',
    caption: 'Chasing the train at 120 km/h',
    seconds: 32,
    plays: 27_500,
    likes: 1_640,
    comments: 71,
    shares: 820,
    song: SONG,
  },
  {
    posted: '2026-10-17T12:30:00Z',
    caption: 'Behind the goggles: my setup',
    seconds: 41,
    plays: 3_100,
    likes: 190,
    comments: 25,
    shares: 9,
    song: null,
  },
  {
    posted: '2026-10-14T18:50:00Z',
    caption: 'Positano from above',
    seconds: 38,
    plays: 41_200,
    likes: 2_310,
    comments: 96,
    shares: 1_240,
    song: ['Sarà perché ti amo', 'Ricchi e Poveri'],
    pinned: true,
  },
  {
    posted: '2026-10-11T21:10:00Z',
    caption: 'Dive off the tower',
    seconds: 9,
    plays: 22_800,
    likes: 1_480,
    comments: 64,
    shares: 610,
    song: SONG,
    with: ['a.friend'],
  },
  {
    posted: '2026-10-08T16:20:00Z',
    caption: 'Repair day, broke two props',
    seconds: 22,
    plays: 2_400,
    likes: 120,
    comments: 9,
    shares: 4,
    song: null,
  },
  {
    posted: '2026-10-04T19:00:00Z',
    caption: 'Tel Aviv beach at golden hour',
    seconds: 26,
    plays: 18_400,
    likes: 980,
    comments: 33,
    shares: 450,
    song: SONG,
  },
  {
    posted: '2026-09-30T13:45:00Z',
    caption: 'Crash compilation, part 3',
    seconds: 31,
    plays: 6_100,
    likes: 410,
    comments: 18,
    shares: 96,
    song: SONG,
  },
  {
    posted: '2026-09-26T17:30:00Z',
    caption: 'Wedding in the vineyard',
    seconds: 35,
    plays: 16_000,
    likes: 870,
    comments: 40,
    shares: 310,
    song: SONG,
    with: ['the.venue'],
    paid: true,
  },
];

/** The twelve older reels of the board's 22 (gen/data.py, `REELS90`: plays in K, oldest first), when each was posted. */
const OLDER: ReadonlyArray<readonly [posted: string, plays: number, caption: string]> = [
  ['2026-08-03T17:10:00Z', 3_200, 'Sunrise over the quarry'],
  ['2026-08-09T09:30:00Z', 11_200, 'First flight with the new frame'],
  ['2026-08-14T18:00:00Z', 5_100, 'Cliff run, take two'],
  ['2026-08-19T12:20:00Z', 5_300, 'Props and batteries, what I carry'],
  ['2026-08-24T20:45:00Z', 6_100, 'Harbour at night'],
  ['2026-08-29T15:05:00Z', 19_700, 'Through the old factory, low and fast'],
  ['2026-09-03T08:40:00Z', 4_000, 'Tuning day'],
  ['2026-09-08T19:25:00Z', 3_100, 'A quiet field in the evening'],
  ['2026-09-13T11:15:00Z', 7_400, 'Rooftops of the old city'],
  ['2026-09-17T16:50:00Z', 5_600, 'Practice: the split S'],
  ['2026-09-21T14:30:00Z', 6_300, 'Beach cleanup from above'],
  ['2026-09-24T10:05:00Z', 2_900, 'New goggles, first look'],
];

/** The 22 reels, newest first. */
const REELS: readonly SampleReel[] = [
  ...NEWEST,
  ...OLDER.map(([posted, plays, caption]) => ({
    posted,
    caption,
    seconds: 20,
    plays,
    likes: Math.round(plays * 0.06),
    comments: Math.round(plays * 0.0035),
    shares: Math.round(plays * 0.03),
    song: SONG,
  })).reverse(),
];

/** A shortcode that is stable per reel, so a second scan updates a reel and never adds one. */
const shortcodeOf = (handle: string, posted: string): string =>
  `Dx${handle.replace(/[^A-Za-z0-9]/g, '')}${Date.parse(posted) / 60_000}`;

// --- the profile picture ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** hsl(h, s, l) as 0..255 red, green and blue. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

/**
 * A stand-in for a client's Instagram photo, like the design canvas's: a 96 px square (the page
 * rounds it) of a gradient from `hue` to `hue + 40`, with a white head and shoulders. A PNG made
 * here, so the fake scanner needs no image tool and no file.
 */
export function samplePhoto(hue: number, size = 96): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1);
    const top = hsl(hue % 360, 0.7, 0.62);
    const bottom = hsl((hue + 40) % 360, 0.6, 0.3);
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      // The head is a circle, the shoulders an arch below it (the board's 40 x 40 drawing, scaled).
      const head = (u - 0.5) ** 2 + (v - 0.425) ** 2 <= 0.175 ** 2;
      const shoulders = v >= 0.675 && ((u - 0.5) / 0.35) ** 2 + ((v - 1.05) / 0.38) ** 2 <= 1;
      const white = head || shoulders ? 0.85 : 0;
      for (let c = 0; c < 3; c += 1) {
        const base = (top[c] ?? 0) * (1 - t) + (bottom[c] ?? 0) * t;
        row[1 + x * 3 + c] = Math.round(base * (1 - white) + 255 * white);
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the accounts ----------------------------------------------------------------------------------

export interface SampleInstagramOptions {
  /**
   * The moment that stands for the board's Mon 26 Oct 06:00: the reels were posted that long before
   * it as on the board. Default: now.
   */
  anchor?: Date;
  /**
   * The seed's history: Falcon FPV's followers follow the board's 13 weekly scans by the scan's number
   * (10,550 to 12,480, then 12 more for each scan after), and a reel counts less the younger it is at
   * a scan before the anchor. Left out, every scan reads the numbers of today and 12 followers more
   * than the one before (so Scan now changes something).
   */
  history?: boolean;
}

const profilePic = (handle: string): string =>
  `https://scontent.cdninstagram.com/v/fake/${handle}.jpg`;

function profileItem(
  handle: string,
  fields: Record<string, unknown>,
  hue: number,
): { item: Record<string, unknown>; photo: Buffer } {
  return {
    item: {
      id: String(63_000_000_000 + [...handle].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)),
      username: handle,
      url: `https://www.instagram.com/${handle}`,
      private: false,
      verified: false,
      isBusinessAccount: true,
      profilePicUrlHD: profilePic(handle),
      ...fields,
    },
    photo: samplePhoto(hue),
  };
}

function reelItem(handle: string, reel: SampleReel, at: (iso: string) => number, scale: number) {
  const shortcode = shortcodeOf(handle, reel.posted);
  const count = (n: number) => Math.round(n * scale);
  return {
    id: String(Date.parse(reel.posted)),
    type: 'Video',
    productType: 'clips',
    shortCode: shortcode,
    url: `https://www.instagram.com/reel/${shortcode}/`,
    timestamp: new Date(at(reel.posted)).toISOString(),
    caption: reel.caption,
    videoDuration: reel.seconds,
    videoPlayCount: count(reel.plays),
    videoViewCount: null,
    likesCount: count(reel.likes),
    commentsCount: count(reel.comments),
    sharesCount: count(reel.shares),
    musicInfo:
      reel.song === null
        ? {
            artist_name: handle,
            song_name: 'Original audio',
            uses_original_audio: true,
          }
        : { artist_name: reel.song[1], song_name: reel.song[0], uses_original_audio: false },
    ...(reel.with === undefined
      ? {}
      : { coauthorProducers: reel.with.map((username) => ({ id: username, username })) }),
    hashtags: [],
    isPinned: reel.pinned === true,
    paidPartnership: reel.paid === true,
    isCommentsDisabled: false,
    ownerUsername: handle,
  };
}

function falconFpv(options: Required<SampleInstagramOptions>): FakeInstagramAccount {
  const handle = 'falcon.fpv';
  const anchor = options.anchor.getTime();
  const at = (iso: string) => anchor - (Date.parse(BOARD_ANCHOR) - Date.parse(iso));
  return {
    photo: samplePhoto(215),
    profile: ({ scan }) => {
      const followers = options.history
        ? (FALCON_FOLLOWERS_BY_SCAN[Math.min(scan, FALCON_HISTORY_SCANS) - 1] ?? FALCON_FOLLOWERS) +
          Math.max(0, scan - FALCON_HISTORY_SCANS) * 12
        : FALCON_FOLLOWERS + (scan - 1) * 12;
      return [
        profileItem(
          handle,
          {
            fullName: 'Falcon FPV',
            biography: 'FPV drone pilot. Bookings in DM.',
            followersCount: followers,
            followsCount: 412,
            postsCount: 187,
          },
          215,
        ).item,
      ];
    },
    reels: ({ now }) => {
      // Before the anchor (the seed's history) a reel is smaller the younger it is: half of its
      // numbers at once, all of them after two weeks. At the anchor and after, the board's numbers.
      return REELS.filter((reel) => !options.history || at(reel.posted) <= now.getTime()).map(
        (reel) => {
          const age = now.getTime() - at(reel.posted);
          const scale =
            !options.history || now.getTime() >= anchor
              ? 1
              : 0.5 + 0.5 * Math.min(1, Math.max(0, age) / (2 * WEEK_MS));
          return reelItem(handle, reel, at, scale);
        },
      );
    },
  };
}

/** The three newest reels, smaller, for the account that fails; one not posted yet at `now` is left out. */
function reelsOfThree(handle: string, anchor: number, now: Date): unknown[] {
  const at = (iso: string) => anchor - (Date.parse(BOARD_ANCHOR) - Date.parse(iso));
  return NEWEST.slice(0, 3)
    .filter((reel) => at(reel.posted) <= now.getTime())
    .map((reel) => reelItem(handle, reel, at, 0.4));
}

/**
 * The fixtures of the fake scanner for QA and the e2e run: the real answers of IG2 (natgeo, a
 * private account, one that does not exist) and the sample accounts above.
 */
export function sampleInstagramFixtures(
  options: SampleInstagramOptions = {},
): FakeInstagramFixtures {
  const resolved: Required<SampleInstagramOptions> = {
    anchor: options.anchor ?? new Date(),
    history: options.history ?? false,
  };
  const anchor = resolved.anchor.getTime();
  const privateAccount = profileItem(
    'venezia.studio',
    {
      fullName: 'Venezia',
      followersCount: 6_720,
      followsCount: 310,
      postsCount: 96,
      private: true,
    },
    35,
  );
  const flaky = profileItem(
    'flaky.studio',
    {
      fullName: 'Flaky Studio',
      biography: 'The scan works once.',
      followersCount: 2_105,
      followsCount: 180,
      postsCount: 41,
    },
    160,
  );
  return {
    ...loadFakeInstagramFixtures(),
    'falcon.fpv': falconFpv(resolved),
    'venezia.studio': { profile: [privateAccount.item], reels: [], photo: privateAccount.photo },
    'flaky.studio': {
      profile: [flaky.item],
      reels: ({ now }) => reelsOfThree('flaky.studio', anchor, now),
      photo: flaky.photo,
      fails: 'timeout',
      failsFrom: 2,
    },
    'credit.out': { profile: [], reels: [], fails: 'no-credit' },
    'no.key': { profile: [], reels: [], fails: 'no-token' },
  };
}
