import { describe, expect, it } from 'vitest';
import {
  clientInstagramSummarySchema,
  type InstagramRange,
  instagramNumbersSchema,
  instagramReelSchema,
} from './instagram.ts';
import {
  clientInstagramSummary,
  computeInstagramNumbers,
  followersSinceDay,
  type InstagramNumbersInput,
  type InstagramNumbersRead,
  type InstagramNumbersReel,
  type InstagramNumbersScan,
  instagramRangeFrom,
  instagramReelRows,
  instagramUsual,
  median,
  sharesReadPairs,
  sharesScanPairs,
  sinceUsDay,
  timesUsual,
} from './instagram-numbers.ts';

const DAY = 86_400_000;
const ms = (iso: string): number => Date.parse(iso);
const UTC = 'UTC';
const JERUSALEM = 'Asia/Jerusalem';

function reel(
  shortcode: string,
  overrides: Partial<InstagramNumbersReel> = {},
): InstagramNumbersReel {
  return {
    shortcode,
    url: `https://www.instagram.com/reel/${shortcode}/`,
    postedAt: ms('2026-10-20T12:00:00.000Z'),
    caption: null,
    durationSec: 20,
    plays: 1_000,
    likes: 100,
    comments: 10,
    shares: 5,
    sound: 'Original audio',
    coauthors: [],
    hashtags: [],
    pinned: false,
    paidPartnership: false,
    jobId: null,
    ...overrides,
  };
}

const scan = (id: number, startedAt: string, followers: number | null): InstagramNumbersScan => ({
  id,
  startedAt: ms(startedAt),
  followers,
});

/** The numbers of a client with these scans and reels; override what a test is about. */
function numbersOf(overrides: Partial<InstagramNumbersInput> = {}) {
  return computeInstagramNumbers({
    range: 'since',
    now: ms('2026-10-27T10:00:00.000Z'),
    timeZone: UTC,
    since: null,
    firstDeliveryAt: null,
    scans: [scan(1, '2026-10-05T06:00:00.000Z', 900), scan(2, '2026-10-26T06:00:00.000Z', 1_000)],
    reels: [],
    ...overrides,
  });
}

/** The first and only scan of a client who has just been added. */
const ONLY_SCAN = scan(1, '2026-10-26T06:00:00.000Z', 1_000);

describe('median', () => {
  it('is the middle one of an odd count, the mean of the middle two of an even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([2, 2])).toBe(2);
  });

  it('is null for nothing, and does not change the numbers it is given', () => {
    expect(median([])).toBeNull();
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('timesUsual', () => {
  it('divides by the usual', () => {
    expect(timesUsual(300, 100)).toBe(3);
    expect(timesUsual(50, 100)).toBe(0.5);
    expect(timesUsual(0, 100)).toBe(0);
  });

  it('is null when the usual is 0 or not known, or the value is not', () => {
    expect(timesUsual(300, 0)).toBeNull();
    expect(timesUsual(300, null)).toBeNull();
    expect(timesUsual(null, 100)).toBeNull();
  });
});

describe('instagramUsual', () => {
  const now = ms('2026-10-27T10:00:00.000Z');

  it('is the median of the reels of the last 90 days, for each number', () => {
    const reels = [
      reel('a', { plays: 100, likes: 10, comments: 1, shares: 2 }),
      reel('b', { plays: 300, likes: 30, comments: 3, shares: 6 }),
      reel('c', { plays: 200, likes: 20, comments: 2, shares: 4 }),
    ];
    expect(instagramUsual(reels, now, UTC)).toEqual({
      plays: 200,
      likes: 20,
      comments: 2,
      shares: 4,
    });
  });

  it('leaves out reels older than 90 days, and counts the first day of the 90', () => {
    const reels = [
      reel('old', { postedAt: ms('2026-07-28T23:59:00.000Z'), plays: 1_000_000 }),
      reel('edge', { postedAt: ms('2026-07-29T00:00:00.000Z'), plays: 100 }),
      reel('new', { postedAt: ms('2026-10-20T00:00:00.000Z'), plays: 300 }),
    ];
    expect(instagramUsual(reels, now, UTC).plays).toBe(200);
  });

  it('takes the shares of the reels that have them', () => {
    const reels = [
      reel('a', { shares: null }),
      reel('b', { shares: 10 }),
      reel('c', { shares: 30 }),
    ];
    expect(instagramUsual(reels, now, UTC).shares).toBe(20);
    expect(instagramUsual([reel('a', { shares: null })], now, UTC).shares).toBeNull();
  });

  it('is null all through for an account with no recent reel', () => {
    expect(instagramUsual([], now, UTC)).toEqual({
      plays: null,
      likes: null,
      comments: null,
      shares: null,
    });
  });
});

describe('sinceUsDay', () => {
  const firstScanAt = ms('2026-08-03T06:00:00.000Z');

  it('is the since day when it is after the first scan', () => {
    expect(
      sinceUsDay({ since: '2026-09-14', firstDeliveryAt: null, firstScanAt, timeZone: UTC }),
    ).toBe('2026-09-14');
  });

  it('is the since day when it is before the first scan: the reels are read whenever they were posted', () => {
    expect(
      sinceUsDay({ since: '2026-05-01', firstDeliveryAt: null, firstScanAt, timeZone: UTC }),
    ).toBe('2026-05-01');
  });

  it('is the day of the first delivery when there is no since day, before the first scan or after it', () => {
    const later = ms('2026-09-02T18:00:00.000Z');
    expect(sinceUsDay({ since: null, firstDeliveryAt: later, firstScanAt, timeZone: UTC })).toBe(
      '2026-09-02',
    );
    const earlier = ms('2026-06-02T18:00:00.000Z');
    expect(sinceUsDay({ since: null, firstDeliveryAt: earlier, firstScanAt, timeZone: UTC })).toBe(
      '2026-06-02',
    );
  });

  it('prefers the since day to the first delivery', () => {
    expect(
      sinceUsDay({
        since: '2026-05-01',
        firstDeliveryAt: ms('2026-09-02T18:00:00.000Z'),
        firstScanAt,
        timeZone: UTC,
      }),
    ).toBe('2026-05-01');
  });

  it('is the first scan day with neither a since day nor a delivery', () => {
    expect(sinceUsDay({ since: null, firstDeliveryAt: null, firstScanAt, timeZone: UTC })).toBe(
      '2026-08-03',
    );
  });

  it('reads the days on the wall clock of the time zone', () => {
    // 22:30 UTC on 2 Aug is already 3 Aug in Jerusalem (UTC+3 in summer).
    expect(
      sinceUsDay({
        since: null,
        firstDeliveryAt: null,
        firstScanAt: ms('2026-08-02T22:30:00.000Z'),
        timeZone: JERUSALEM,
      }),
    ).toBe('2026-08-03');
    expect(
      sinceUsDay({
        since: null,
        firstDeliveryAt: ms('2026-08-02T22:30:00.000Z'),
        firstScanAt,
        timeZone: JERUSALEM,
      }),
    ).toBe('2026-08-03');
  });
});

describe('followersSinceDay', () => {
  const firstScanAt = ms('2026-08-03T06:00:00.000Z');

  it('is the since day when it is after the first scan', () => {
    expect(
      followersSinceDay({ since: '2026-09-14', firstDeliveryAt: null, firstScanAt, timeZone: UTC }),
    ).toBe('2026-09-14');
  });

  it('is the first scan day when the since day is before it (followers before it are not known)', () => {
    expect(
      followersSinceDay({ since: '2026-05-01', firstDeliveryAt: null, firstScanAt, timeZone: UTC }),
    ).toBe('2026-08-03');
  });

  it('is the day of the first delivery when there is no since day and it is after the first scan', () => {
    const later = ms('2026-09-02T18:00:00.000Z');
    expect(
      followersSinceDay({ since: null, firstDeliveryAt: later, firstScanAt, timeZone: UTC }),
    ).toBe('2026-09-02');
    const earlier = ms('2026-06-02T18:00:00.000Z');
    expect(
      followersSinceDay({ since: null, firstDeliveryAt: earlier, firstScanAt, timeZone: UTC }),
    ).toBe('2026-08-03');
  });

  it('is the first scan day with neither a since day nor a delivery', () => {
    expect(
      followersSinceDay({ since: null, firstDeliveryAt: null, firstScanAt, timeZone: UTC }),
    ).toBe('2026-08-03');
  });
});

describe('instagramRangeFrom', () => {
  const now = ms('2026-10-27T10:00:00.000Z');

  it.each([
    ['since', '2026-08-03'],
    ['90', '2026-07-29'],
    ['30', '2026-09-27'],
  ] satisfies [InstagramRange, string][])('range %s starts on %s', (range, from) => {
    expect(instagramRangeFrom(range, now, UTC, '2026-08-03')).toBe(from);
  });
});

// --- the canvas sample -----------------------------------------------------------------------------
// The numbers behind the design boards (handoff gen/data.py, page.py, engage.py): Falcon FPV, 22 reels
// of the last 90 days (plays in K, 7 of them ours), 13 weekly scans from 3 Aug to 26 Oct.

const FOLLOWERS_NOW = 12_480;
const GAINS = [40, 60, 210, 90, 120, 228, 110, 140, 300, 150, 170, 312];
const FOLLOW = [FOLLOWERS_NOW - GAINS.reduce((sum, gain) => sum + gain, 0)];
for (const gain of GAINS) FOLLOW.push((FOLLOW[FOLLOW.length - 1] ?? 0) + gain);

/** Plays in K, oldest first, and whether the reel is ours. */
const REELS90: [number, boolean][] = [
  [3.2, false],
  [11.2, true],
  [5.1, false],
  [5.3, false],
  [6.1, false],
  [19.7, true],
  [4.0, false],
  [3.1, false],
  [7.4, false],
  [5.6, false],
  [6.3, false],
  [2.9, false],
  [16.0, true],
  [6.1, false],
  [18.4, true],
  [2.4, false],
  [22.8, false],
  [41.2, true],
  [3.1, false],
  [27.5, true],
  [4.2, false],
  [9.8, true],
];

const sampleScans: InstagramNumbersScan[] = FOLLOW.map((followers, i) => ({
  id: i + 1,
  startedAt: Date.UTC(2026, 7, 3 + 7 * i, 6),
  followers,
}));

const sampleReels: InstagramNumbersReel[] = REELS90.map(([thousands, ours], i) =>
  reel(`R${String(i).padStart(2, '0')}`, {
    postedAt: Date.UTC(2026, 7, 5) + Math.round(i * 3.8 * DAY),
    plays: Math.round(thousands * 1000),
    jobId: ours ? `job${i}` : null,
  }),
);

const SAMPLE_NOW = ms('2026-10-26T07:00:00.000Z');

function sample(overrides: Partial<InstagramNumbersInput> = {}) {
  const numbers = numbersOf({
    now: SAMPLE_NOW,
    firstDeliveryAt: ms('2026-07-20T09:00:00.000Z'),
    scans: sampleScans,
    reels: sampleReels,
    ...overrides,
  });
  if (numbers === null) throw new Error('the sample has scans');
  return numbers;
}

describe('the canvas sample (Falcon FPV)', () => {
  it('has 13 weekly scans that end on 12,480 followers', () => {
    expect(sampleScans).toHaveLength(13);
    expect(FOLLOW[0]).toBe(10_550);
    expect(FOLLOW[12]).toBe(12_480);
  });

  it('gives the Plays per reel tile: 18.4K ours, 5.1K theirs, 3.6×', () => {
    const { playsPerReel } = sample().tiles;
    expect(playsPerReel.ours).toBe(18_400);
    expect(playsPerReel.theirs).toBe(5_100);
    expect(playsPerReel.ratio).not.toBeNull();
    expect((playsPerReel.ratio ?? 0).toFixed(1)).toBe('3.6');
  });

  it('gives the Followers tile: 12,480, +312 this week, +1,930 since us, a line of the 13 scans', () => {
    const { followers } = sample().tiles;
    expect(followers.now).toBe(12_480);
    expect(followers.thisWeek).toBe(312);
    expect(followers.sinceUs).toBe(1_930);
    expect(followers.line).toHaveLength(13);
    expect(followers.line[0]).toEqual({
      at: '2026-08-03T06:00:00.000Z',
      followers: 10_550,
      ours: false,
    });
    expect(followers.line[12]).toEqual({
      at: '2026-10-26T06:00:00.000Z',
      followers: 12_480,
      ours: true,
    });
  });

  it('puts a dot on the scans after which one of our 7 reels was posted', () => {
    // The weeks (scan indexes) our reels fall in; the board draws its dots by hand, on 3, 6, 8,
    // 9, 11 and 12, and the reels of this sample are spread evenly instead.
    const marked = sample().tiles.followers.line.flatMap((point, index) =>
      point.ours ? [index] : [],
    );
    expect(marked).toEqual([1, 3, 7, 8, 10, 11, 12]);
  });

  it('has no line of shares without reads: 12 weeks the scans cannot tell', () => {
    const { line } = sample().tiles.sharesAWeek;
    expect(line).toHaveLength(12);
    expect(line.every((point) => point.shares === null)).toBe(true);
    expect(line[0]?.at).toBe('2026-08-10T06:00:00.000Z');
    expect(line[11]?.at).toBe('2026-10-26T06:00:00.000Z');
  });

  it('names the day since us starts on: the first delivery, 20 Jul, before the first scan', () => {
    const numbers = sample();
    expect(numbers.sinceUs).toBe('2026-07-20');
    expect(numbers.from).toBe('2026-07-20');
    expect(numbers.range).toBe('since');
    // The followers still count from the first scan, 3 Aug: the +1,930 of the tile.
    expect(numbers.tiles.followers.sinceUs).toBe(1_930);
  });

  it('has the typical reel of the account at 6.1K plays', () => {
    expect(sample().usual.plays).toBe(6_100);
  });

  it('lists every reel for Plays of every reel, oldest first, ours with their job', () => {
    const jobNames = new Map([['job17', 'Positano from above']]);
    const { plays } = sample({ jobNames });
    expect(plays).toHaveLength(22);
    expect(plays.filter((point) => point.ours)).toHaveLength(7);
    const times = plays.map((point) => Date.parse(point.postedAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(plays[17]).toMatchObject({ plays: 41_200, ours: true, job: 'Positano from above' });
    expect(plays[0]).toMatchObject({ plays: 3_200, ours: false, job: null });
    // A job whose name is not known is shown by its id.
    expect(plays[1]?.job).toBe('job1');
  });

  it('puts the engagement of every reel as × usual, in the same order', () => {
    const { engagement, plays } = sample();
    expect(engagement.map((point) => point.shortcode)).toEqual(plays.map((p) => p.shortcode));
    // Every reel here has the same likes, comments and shares: each is exactly 1× usual.
    for (const point of engagement) {
      expect(point).toMatchObject({ likes: 1, comments: 1, shares: 1 });
    }
    // Views are the plays ÷ the usual plays: Positano's 41,200 is 6.8×, as in the Reels list.
    expect((engagement[17]?.plays ?? 0).toFixed(1)).toBe('6.8');
  });

  it('gives Positano 6.8× its typical plays in the Reels list', () => {
    const numbers = sample();
    const rows = instagramReelRows(sampleReels, numbers.usual);
    const positano = rows.find((row) => row.plays === 41_200);
    expect((positano?.timesUsual ?? 0).toFixed(1)).toBe('6.8');
  });

  it('fits the shared contract', () => {
    const numbers = sample({ jobNames: new Map([['job17', 'Positano']]) });
    expect(instagramNumbersSchema.parse(numbers)).toEqual(numbers);
    for (const row of instagramReelRows(sampleReels, numbers.usual)) {
      expect(instagramReelSchema.safeParse(row).success, row.shortcode).toBe(true);
    }
  });

  it('gives the Clients list 12,480, +312 and 3.6×', () => {
    const summary = clientInstagramSummary(
      { handle: 'falcon.fpv', photoSavedAt: ms('2026-10-26T06:01:00.000Z') },
      sample(),
    );
    expect(clientInstagramSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({
      handle: 'falcon.fpv',
      followers: 12_480,
      weekChange: 312,
      photoAt: '2026-10-26T06:01:00.000Z',
    });
    expect((summary.oursVsTheirs ?? 0).toFixed(1)).toBe('3.6');
  });
});

describe('the Likes per reel tile of the canvas sample (the newest 10 reels)', () => {
  // Newest first on the Reels list board: likes, ours or theirs.
  const LIST: [number, number, boolean][] = [
    [9_800, 610, true],
    [4_200, 280, false],
    [27_500, 1_640, true],
    [3_100, 190, false],
    [41_200, 2_310, true],
    [22_800, 1_480, false],
    [2_400, 120, false],
    [18_400, 980, true],
    [6_100, 410, false],
    [16_000, 870, true],
  ];

  it('is 980 ours, 280 theirs, 3.5×', () => {
    const reels = LIST.map(([plays, likes, ours], i) =>
      reel(`L${i}`, {
        plays,
        likes,
        postedAt: ms('2026-10-25T12:00:00.000Z') - i * 3 * DAY,
        jobId: ours ? `job${i}` : null,
      }),
    );
    const { likesPerReel } = numbersOf({
      range: '90',
      now: ms('2026-10-26T07:00:00.000Z'),
      reels,
    })?.tiles ?? { likesPerReel: null };
    expect(likesPerReel).toMatchObject({ ours: 980, theirs: 280, ratio: 3.5 });
  });
});

describe('Shares a week', () => {
  // The Shares a week tile of the board: 2,140 new shares, ours 1,610 and theirs 530, 38% more than
  // the 1,550 of the week before.
  const scans = [
    scan(1, '2026-10-12T06:00:00.000Z', 1_000),
    scan(2, '2026-10-19T06:00:00.000Z', 1_100),
    scan(3, '2026-10-26T06:00:00.000Z', 1_200),
  ];
  const posted = ms('2026-10-05T12:00:00.000Z');
  const reels = [
    reel('A', { postedAt: posted, jobId: 'jobA' }),
    reel('B', { postedAt: posted, jobId: 'jobB' }),
    reel('C', { postedAt: posted }),
    // Posted between the second and the third scan: all its shares are new this week.
    reel('D', { postedAt: ms('2026-10-22T12:00:00.000Z'), shares: 330 }),
  ];
  const read = (
    shortcode: string,
    scanId: number,
    shares: number | null,
  ): InstagramNumbersRead => ({
    shortcode,
    scanId,
    shares,
  });
  const reads = [
    read('A', 1, 100),
    read('B', 1, 200),
    read('C', 1, 50),
    read('A', 2, 600),
    read('B', 2, 800),
    read('C', 2, 500),
    read('A', 3, 1_500),
    read('B', 3, 1_510),
    read('C', 3, 700),
    read('D', 3, 330),
  ];

  it('is what the last two scans gained, ours and theirs, and what the two before them gained', () => {
    const { sharesAWeek } = numbersOf({ scans, reels, reads })?.tiles ?? { sharesAWeek: null };
    expect(sharesAWeek).toEqual({
      thisWeek: { ours: 1_610, theirs: 530 },
      weekBefore: { ours: 1_100, theirs: 450 },
      line: [
        { at: '2026-10-19T06:00:00.000Z', shares: 1_550 },
        { at: '2026-10-26T06:00:00.000Z', shares: 2_140 },
      ],
    });
    expect(Math.round((2_140 / 1_550 - 1) * 100)).toBe(38);
  });

  it('names the pairs of scans whose reads it needs: this week, then the week before', () => {
    const pairs = sharesScanPairs(scans).map(([older, newer]) => [older.id, newer.id]);
    expect(pairs).toEqual([
      [2, 3],
      [1, 2],
    ]);
    expect(sharesScanPairs([scan(1, '2026-10-26T06:00:00.000Z', 1)])).toEqual([]);
    expect(sharesScanPairs(scans.slice(1)).map(([o, n]) => [o.id, n.id])).toEqual([[2, 3]]);
    // Whatever order the scans come in.
    expect(sharesScanPairs([...scans].reverse()).map(([o, n]) => [o.id, n.id])).toEqual(pairs);
  });

  it('is not known with one scan, and the week before is not known with two', () => {
    expect(numbersOf({ scans: scans.slice(2), reels, reads })?.tiles.sharesAWeek).toEqual({
      thisWeek: { ours: null, theirs: null },
      weekBefore: { ours: null, theirs: null },
      line: [],
    });
    expect(numbersOf({ scans: scans.slice(1), reels, reads })?.tiles.sharesAWeek).toEqual({
      thisWeek: { ours: 1_610, theirs: 530 },
      weekBefore: { ours: null, theirs: null },
      line: [{ at: '2026-10-26T06:00:00.000Z', shares: 2_140 }],
    });
  });

  it('is not known without reads', () => {
    // Each pair of scans is still a point of the line, one it cannot tell: null, not 0.
    expect(numbersOf({ scans, reels })?.tiles.sharesAWeek).toEqual({
      thisWeek: { ours: null, theirs: null },
      weekBefore: { ours: null, theirs: null },
      line: [
        { at: '2026-10-19T06:00:00.000Z', shares: null },
        { at: '2026-10-26T06:00:00.000Z', shares: null },
      ],
    });
  });

  it('leaves out a reel whose shares a scan could not read, and one with no baseline', () => {
    const odd = [
      read('A', 2, null),
      read('A', 3, 1_500),
      // B: read by the newer scan only, and posted before the older scan: no baseline.
      read('B', 3, 1_510),
      // C: shares read both times.
      read('C', 2, 500),
      read('C', 3, 700),
    ];
    const { sharesAWeek } = numbersOf({ scans, reels, reads: odd })?.tiles ?? {
      sharesAWeek: null,
    };
    expect(sharesAWeek?.thisWeek).toEqual({ ours: 0, theirs: 200 });
  });

  it('never counts shares lost as a gain', () => {
    const lost = [read('A', 2, 600), read('A', 3, 550), read('C', 2, 10), read('C', 3, 40)];
    expect(numbersOf({ scans, reels, reads: lost })?.tiles.sharesAWeek.thisWeek).toEqual({
      ours: 0,
      theirs: 30,
    });
  });

  describe('the line', () => {
    const lineOf = (overrides: Partial<InstagramNumbersInput> = {}) =>
      numbersOf({ scans, reels, reads, ...overrides })?.tiles.sharesAWeek.line;

    it('has the shares gained between each pair of consecutive scans, ours and theirs added up', () => {
      // 1 to 2: A +500, B +600, C +450. 2 to 3: A +900, B +710, C +200, D 330 (posted since).
      expect(lineOf()).toEqual([
        { at: '2026-10-19T06:00:00.000Z', shares: 1_550 },
        { at: '2026-10-26T06:00:00.000Z', shares: 2_140 },
      ]);
    });

    it('ends on the total of this week, whatever the order of the scans', () => {
      const line = lineOf({ scans: [...scans].reverse() });
      const week = numbersOf({ scans, reels, reads })?.tiles.sharesAWeek.thisWeek;
      expect(line?.at(-1)?.shares).toBe((week?.ours ?? 0) + (week?.theirs ?? 0));
      expect(line?.map((point) => point.at)).toEqual([
        '2026-10-19T06:00:00.000Z',
        '2026-10-26T06:00:00.000Z',
      ]);
    });

    it('is empty with one scan, and has the one pair with two', () => {
      expect(lineOf({ scans: scans.slice(2) })).toEqual([]);
      expect(lineOf({ scans: scans.slice(1) })).toEqual([
        { at: '2026-10-26T06:00:00.000Z', shares: 2_140 },
      ]);
    });

    it('has a null point for a pair that no reel can tell, and the others stay', () => {
      // Only the newer pair has reads: the older pair has nothing to compare.
      const newerOnly = reads.filter((one) => one.scanId !== 1);
      expect(lineOf({ reads: newerOnly })).toEqual([
        { at: '2026-10-19T06:00:00.000Z', shares: null },
        { at: '2026-10-26T06:00:00.000Z', shares: 2_140 },
      ]);
    });

    it('has no reads at all: every point null, none 0', () => {
      expect(lineOf({ reads: [] })?.map((point) => point.shares)).toEqual([null, null]);
    });

    it('counts a week with theirs only: no reel of ours adds 0 for it, not a gap', () => {
      const allTheirs = reels.map((one) => ({ ...one, jobId: null }));
      expect(lineOf({ reels: allTheirs })).toEqual([
        { at: '2026-10-19T06:00:00.000Z', shares: 1_550 },
        { at: '2026-10-26T06:00:00.000Z', shares: 2_140 },
      ]);
    });

    it('never counts shares lost as a gain', () => {
      const lost = [read('A', 2, 600), read('A', 3, 550), read('C', 2, 10), read('C', 3, 40)];
      expect(lineOf({ reads: lost })?.at(-1)?.shares).toBe(30);
    });

    it('has the pairs whose newer scan is in the range, the older one may be before it', () => {
      // Since us starts on 19 Oct: the pair 1 to 2 ends on that day, so both pairs stay; on 20 Oct
      // only the pair 2 to 3 is left.
      expect(lineOf({ since: '2026-10-19' })).toHaveLength(2);
      const later = numbersOf({ scans, reels, reads, since: '2026-10-20' });
      expect(later?.tiles.sharesAWeek.line).toEqual([
        { at: '2026-10-26T06:00:00.000Z', shares: 2_140 },
      ]);
      // The tile's numbers do not depend on the range.
      expect(later?.tiles.sharesAWeek.weekBefore).toEqual({ ours: 1_100, theirs: 450 });
    });
  });

  describe('the reads it needs', () => {
    const basis = {
      range: 'since' as const,
      now: ms('2026-10-27T10:00:00.000Z'),
      timeZone: UTC,
      since: null,
      firstDeliveryAt: null,
    };
    const idsOf = (pairs: ReturnType<typeof sharesReadPairs>) =>
      pairs.map(([older, newer]) => [older.id, newer.id]);

    it('names every pair of the line and the two of this week and the week before, oldest first', () => {
      expect(idsOf(sharesReadPairs({ ...basis, scans }))).toEqual([
        [1, 2],
        [2, 3],
      ]);
      expect(idsOf(sharesReadPairs({ ...basis, scans: [...scans].reverse() }))).toEqual([
        [1, 2],
        [2, 3],
      ]);
    });

    it('still names this week and the week before when the range has left them out', () => {
      // A range of 30 days long after the last scan has no line, and the tile still needs the two
      // newest pairs.
      const far = { ...basis, range: '30' as const, now: ms('2027-03-01T10:00:00.000Z') };
      expect(idsOf(sharesReadPairs({ ...far, scans }))).toEqual([
        [1, 2],
        [2, 3],
      ]);
      const wide = [
        scan(10, '2026-06-01T06:00:00.000Z', 1),
        scan(11, '2026-06-08T06:00:00.000Z', 1),
        ...scans,
      ];
      expect(idsOf(sharesReadPairs({ ...far, scans: wide }))).toEqual([
        [1, 2],
        [2, 3],
      ]);
    });

    it('names none for no scan or one', () => {
      expect(sharesReadPairs({ ...basis, scans: [] })).toEqual([]);
      expect(sharesReadPairs({ ...basis, scans: scans.slice(0, 1) })).toEqual([]);
    });
  });
});

describe('followers', () => {
  const scans = [
    scan(1, '2026-10-05T06:00:00.000Z', 1_000),
    scan(2, '2026-10-12T06:00:00.000Z', 1_040),
    scan(3, '2026-10-19T06:00:00.000Z', 1_100),
    scan(4, '2026-10-26T06:00:00.000Z', 1_150),
  ];

  it('is the last scan against the scan about 7 days earlier, and the first scan for since us', () => {
    expect(numbersOf({ scans })?.tiles.followers).toMatchObject({
      now: 1_150,
      thisWeek: 50,
      sinceUs: 150,
    });
  });

  it('takes the scan nearest to 7 days earlier when scans are not weekly', () => {
    // "Scan now" on Thursday 29 Oct at 10:00: 7 days before is Thursday 22 Oct at 10:00. Monday 19
    // (3 days 4 hours away) is nearer than Monday 26 (3 days 20 hours away), so it is the one.
    const withExtra = [...scans, scan(5, '2026-10-29T10:00:00.000Z', 1_170)];
    expect(numbersOf({ scans: withExtra })?.tiles.followers.thisWeek).toBe(70);
    // On Tuesday 27 Oct the scan 7 days before is Tuesday 20 Oct: Monday 19 is a day away.
    const closer = [...scans, scan(5, '2026-10-27T06:00:00.000Z', 1_160)];
    expect(numbersOf({ scans: closer })?.tiles.followers.thisWeek).toBe(60);
  });

  it('is against the last scan on or before the since day when it is later than the first scan', () => {
    // Since Wednesday 14 Oct: the last scan on or before it is Monday 12 Oct.
    expect(numbersOf({ scans, since: '2026-10-14' })?.tiles.followers).toMatchObject({
      sinceUs: 110,
    });
    // Since the day of a scan: that scan.
    expect(numbersOf({ scans, since: '2026-10-19' })?.tiles.followers.sinceUs).toBe(50);
  });

  it('has null this week and since us with one scan, and says the followers now', () => {
    const only = numbersOf({ scans: [scan(1, '2026-10-26T06:00:00.000Z', 1_150)] });
    expect(only?.tiles.followers).toEqual({
      now: 1_150,
      thisWeek: null,
      sinceUs: null,
      line: [{ at: '2026-10-26T06:00:00.000Z', followers: 1_150, ours: false }],
    });
  });

  it('is not known from scans that did not read the followers', () => {
    const blank = numbersOf({ scans: [scan(1, '2026-10-26T06:00:00.000Z', null)] });
    expect(blank?.tiles.followers).toEqual({ now: null, thisWeek: null, sinceUs: null, line: [] });
    // A scan with none in between is skipped, not counted as 0.
    const gap = numbersOf({
      scans: [
        scans[0] as InstagramNumbersScan,
        scan(2, '2026-10-12T06:00:00.000Z', null),
        ...scans.slice(2),
      ],
    });
    expect(gap?.tiles.followers.line).toHaveLength(3);
  });

  it('puts into the line the scans of the range only', () => {
    const now = ms('2026-10-27T10:00:00.000Z');
    // 30 days back from 27 Oct is 27 Sep: only the scans from 5 Oct on, here all four.
    expect(numbersOf({ scans, range: '30', now })?.tiles.followers.line).toHaveLength(4);
    // A range starting on 19 Oct leaves the first two out: since us with a since day of 19 Oct.
    const later = numbersOf({ scans, since: '2026-10-19', now });
    expect(later?.sinceUs).toBe('2026-10-19');
    expect(later?.tiles.followers.line.map((point) => point.followers)).toEqual([1_100, 1_150]);
    // The change this week does not depend on the range.
    expect(later?.tiles.followers.thisWeek).toBe(50);
  });

  it('does not trust the order of the scans', () => {
    expect(numbersOf({ scans: [...scans].reverse() })?.tiles.followers).toMatchObject({
      now: 1_150,
      thisWeek: 50,
      sinceUs: 150,
    });
  });

  describe('the dots on the line', () => {
    const oursOn = (
      reels: InstagramNumbersReel[],
      overrides: Partial<InstagramNumbersInput> = {},
    ) => numbersOf({ scans, reels, ...overrides })?.tiles.followers.line.map((point) => point.ours);

    it('is true for a scan when one of our reels was posted since the scan before', () => {
      // Posted between scan 2 (12 Oct) and scan 3 (19 Oct), and between scan 3 and scan 4.
      const reels = [
        reel('a', { postedAt: ms('2026-10-14T12:00:00.000Z'), jobId: 'ja' }),
        reel('b', { postedAt: ms('2026-10-25T12:00:00.000Z'), jobId: 'jb' }),
      ];
      expect(oursOn(reels)).toEqual([false, false, true, true]);
    });

    it('is false everywhere with no reel of ours: theirs do not count', () => {
      const reels = [
        reel('a', { postedAt: ms('2026-10-14T12:00:00.000Z') }),
        reel('b', { postedAt: ms('2026-10-25T12:00:00.000Z') }),
      ];
      expect(oursOn(reels)).toEqual([false, false, false, false]);
      expect(oursOn([])).toEqual([false, false, false, false]);
    });

    it('is false for the first scan, which has none before it, whatever was posted', () => {
      const reels = [reel('a', { postedAt: ms('2026-10-01T12:00:00.000Z'), jobId: 'ja' })];
      expect(oursOn(reels)).toEqual([false, false, false, false]);
    });

    it('is false with one scan', () => {
      const reels = [reel('a', { postedAt: ms('2026-10-20T12:00:00.000Z'), jobId: 'ja' })];
      const only = numbersOf({ scans: [scans[0] as InstagramNumbersScan], reels });
      expect(only?.tiles.followers.line.map((point) => point.ours)).toEqual([false]);
    });

    it('leaves out a reel posted after the last scan, and puts one posted at a scan on that scan', () => {
      const reels = [
        // After the last scan (26 Oct): nothing to mark yet.
        reel('late', { postedAt: ms('2026-10-26T09:00:00.000Z'), jobId: 'jl' }),
        // At the moment of scan 3 exactly: in the week that ends with it, not the one that starts.
        reel('edge', { postedAt: ms('2026-10-19T06:00:00.000Z'), jobId: 'je' }),
      ];
      expect(oursOn(reels)).toEqual([false, false, true, false]);
    });

    it('uses the scan before the range for the first scan in it', () => {
      const reels = [reel('a', { postedAt: ms('2026-10-15T12:00:00.000Z'), jobId: 'ja' })];
      // Since 19 Oct the line has scans 3 and 4: scan 3 is marked by a reel of the week before it.
      expect(oursOn(reels, { since: '2026-10-19' })).toEqual([true, false]);
    });

    it('goes by the scan before that read the followers: a blank scan in between is skipped', () => {
      const blank = [
        scans[0] as InstagramNumbersScan,
        scan(2, '2026-10-12T06:00:00.000Z', null),
        ...scans.slice(2),
      ];
      // Posted between scan 1 and the blank scan 2: the line has no point for scan 2, so scan 3's
      // gain of followers includes it.
      const reels = [reel('a', { postedAt: ms('2026-10-10T12:00:00.000Z'), jobId: 'ja' })];
      expect(oursOn(reels, { scans: blank })).toEqual([false, true, false]);
    });

    it('does not trust the order of the scans', () => {
      const reels = [reel('a', { postedAt: ms('2026-10-14T12:00:00.000Z'), jobId: 'ja' })];
      expect(oursOn(reels, { scans: [...scans].reverse() })).toEqual([false, false, true, false]);
    });
  });
});

describe('the ranges', () => {
  const now = ms('2026-10-27T10:00:00.000Z');
  const scans = [
    scan(1, '2026-08-03T06:00:00.000Z', 1_000),
    scan(2, '2026-10-26T06:00:00.000Z', 1_300),
  ];
  const day = (iso: string) => ms(`${iso}T12:00:00.000Z`);
  const reels = [
    reel('a', { postedAt: day('2026-08-01'), plays: 100 }),
    reel('b', { postedAt: day('2026-08-20'), plays: 200, jobId: 'jb' }),
    reel('c', { postedAt: day('2026-09-26'), plays: 300 }),
    reel('d', { postedAt: day('2026-09-27'), plays: 400, jobId: 'jd' }),
    reel('e', { postedAt: day('2026-10-20'), plays: 500 }),
    reel('f', { postedAt: day('2026-07-20'), plays: 900 }),
  ];
  const shortcodes = (range: InstagramRange, overrides: Partial<InstagramNumbersInput> = {}) =>
    numbersOf({ range, now, scans, reels, ...overrides })?.plays.map((point) => point.shortcode);

  it('since us counts the reels from the day since us starts on', () => {
    // The first scan, 3 Aug, is the day: the reels of 20 Jul and 1 Aug are before it.
    expect(shortcodes('since')).toEqual(['b', 'c', 'd', 'e']);
    expect(numbersOf({ range: 'since', now, scans, reels })?.from).toBe('2026-08-03');
  });

  it('since us starts on the since day when it is later than the first scan', () => {
    expect(shortcodes('since', { since: '2026-09-27' })).toEqual(['d', 'e']);
    expect(numbersOf({ range: 'since', now, scans, reels, since: '2026-09-27' })?.from).toBe(
      '2026-09-27',
    );
  });

  it('since us starts on the since day when it is before the first scan: the reels read since then count', () => {
    // The first scan is 3 Aug, but the account has been ours since 1 Aug: the reel of 1 Aug counts,
    // the one of 20 Jul does not.
    expect(shortcodes('since', { since: '2026-08-01' })).toEqual(['a', 'b', 'c', 'd', 'e']);
    const numbers = numbersOf({ range: 'since', now, scans, reels, since: '2026-08-01' });
    expect(numbers?.from).toBe('2026-08-01');
    expect(numbers?.sinceUs).toBe('2026-08-01');
  });

  describe('an account whose first scan is after the since day (the first scan is the only one)', () => {
    // Falcon FPV on 30 Oct: ours since 23 Oct, scanned for the first time on 30 Oct, which read the
    // reels of the last 90 days: two of them were posted on 26 and 28 Oct.
    const first = scan(1, '2026-10-30T06:00:00.000Z', 1_000);
    const reels = [
      reel('old', { postedAt: ms('2026-09-10T12:00:00.000Z'), plays: 100 }),
      reel('before', { postedAt: ms('2026-10-22T12:00:00.000Z'), plays: 200 }),
      reel('mid', { postedAt: ms('2026-10-26T12:00:00.000Z'), plays: 300, jobId: 'jm' }),
      reel('late', { postedAt: ms('2026-10-28T12:00:00.000Z'), plays: 500 }),
    ];
    const since = (overrides: Partial<InstagramNumbersInput> = {}) =>
      numbersOf({
        now: ms('2026-10-30T09:00:00.000Z'),
        scans: [first],
        reels,
        since: '2026-10-23',
        ...overrides,
      });

    it('counts the reels posted since the since day, not since the first scan', () => {
      const numbers = since();
      expect(numbers?.plays.map((point) => point.shortcode)).toEqual(['mid', 'late']);
      expect(numbers?.engagement.map((point) => point.shortcode)).toEqual(['mid', 'late']);
      expect(numbers?.tiles.playsPerReel).toEqual({ ours: 300, theirs: 500, ratio: 0.6 });
      expect(numbers?.tiles.likesPerReel).toMatchObject({ ours: 100, theirs: 100 });
    });

    it('names the since day, 23 Oct, for the range and for the days of the tiles and charts', () => {
      expect(since()).toMatchObject({ range: 'since', from: '2026-10-23', sinceUs: '2026-10-23' });
    });

    it('leaves the followers since us unknown: one scan has nothing to count from', () => {
      expect(since()?.tiles.followers).toMatchObject({
        now: 1_000,
        thisWeek: null,
        sinceUs: null,
      });
    });

    it('counts the followers from the first scan once a second scan has read them', () => {
      const second = scan(2, '2026-11-06T06:00:00.000Z', 1_150);
      const numbers = since({ scans: [first, second], now: ms('2026-11-06T09:00:00.000Z') });
      // The followers before 30 Oct are not known: +150 is since the first scan, though the
      // reels count from 23 Oct.
      expect(numbers?.tiles.followers).toMatchObject({ now: 1_150, thisWeek: 150, sinceUs: 150 });
      expect(numbers?.sinceUs).toBe('2026-10-23');
      expect(numbers?.plays.map((point) => point.shortcode)).toEqual(['mid', 'late']);
    });

    it('starts on the first delivery with no since day, before the first scan too', () => {
      const numbers = since({ since: null, firstDeliveryAt: ms('2026-10-27T09:00:00.000Z') });
      expect(numbers?.sinceUs).toBe('2026-10-27');
      expect(numbers?.plays.map((point) => point.shortcode)).toEqual(['late']);
    });

    it('lists every reel in the reels rows, whatever the range', () => {
      const usual = instagramUsual(reels, ms('2026-10-30T09:00:00.000Z'), UTC);
      expect(instagramReelRows(reels, usual).map((row) => row.shortcode)).toEqual([
        'late',
        'mid',
        'before',
        'old',
      ]);
    });
  });

  it('90 days counts the reels of the last 90 days', () => {
    // 90 days before 27 Oct is 29 Jul: the reel of 20 Jul is out, the one of 1 Aug is in.
    expect(shortcodes('90')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(numbersOf({ range: '90', now, scans, reels })?.from).toBe('2026-07-29');
  });

  it('30 days counts the reels of the last 30 days', () => {
    // 30 days before 27 Oct is 27 Sep: the reel of 26 Sep is out, the one of 27 Sep is in.
    expect(shortcodes('30')).toEqual(['d', 'e']);
    expect(numbersOf({ range: '30', now, scans, reels })?.from).toBe('2026-09-27');
  });

  it('works the medians out over the range only, and the usual over the last 90 days always', () => {
    const thirty = numbersOf({ range: '30', now, scans, reels });
    expect(thirty?.tiles.playsPerReel).toEqual({ ours: 400, theirs: 500, ratio: 0.8 });
    const since = numbersOf({ range: 'since', now, scans, reels });
    expect(since?.tiles.playsPerReel).toEqual({ ours: 300, theirs: 400, ratio: 0.75 });
    // a, b, c, d, e: 100 200 300 400 500; the 20 Jul reel is out of the 90 days.
    expect(thirty?.usual.plays).toBe(300);
    expect(since?.usual.plays).toBe(300);
  });

  it('keeps the followers tile the same in every range, except for its line', () => {
    const ranges = (['since', '90', '30'] as const).map(
      (range) => numbersOf({ range, now, scans, reels })?.tiles.followers,
    );
    for (const followers of ranges) {
      expect(followers).toMatchObject({ now: 1_300, thisWeek: 300, sinceUs: 300 });
    }
    expect(ranges.map((followers) => followers?.line.length)).toEqual([2, 2, 1]);
  });

  it('counts the days on the wall clock of the time zone', () => {
    // 22:30 UTC on 26 Sep is 01:30 on 27 Sep in Jerusalem: the first day of the 30 days there.
    const edge = [reel('x', { postedAt: ms('2026-09-26T22:30:00.000Z') })];
    expect(
      numbersOf({ range: '30', now, scans, reels: edge, timeZone: JERUSALEM })?.plays,
    ).toHaveLength(1);
    expect(numbersOf({ range: '30', now, scans, reels: edge, timeZone: UTC })?.plays).toHaveLength(
      0,
    );
  });
});

describe('the engagement series (E1)', () => {
  it('puts views, likes, comments and shares of each reel as a multiple of the usual', () => {
    const reels = [
      reel('a', {
        plays: 500,
        likes: 10,
        comments: 1,
        shares: 2,
        postedAt: ms('2026-10-20T10:00:00.000Z'),
      }),
      reel('b', {
        plays: 1_000,
        likes: 20,
        comments: 2,
        shares: 4,
        postedAt: ms('2026-10-21T10:00:00.000Z'),
      }),
      reel('c', {
        plays: 4_000,
        likes: 60,
        comments: 3,
        shares: 8,
        postedAt: ms('2026-10-22T10:00:00.000Z'),
        jobId: 'jc',
      }),
    ];
    const numbers = numbersOf({ reels });
    expect(numbers?.usual).toMatchObject({ plays: 1_000, likes: 20, comments: 2, shares: 4 });
    expect(numbers?.engagement).toEqual([
      expect.objectContaining({
        shortcode: 'a',
        ours: false,
        plays: 0.5,
        likes: 0.5,
        comments: 0.5,
        shares: 0.5,
      }),
      expect.objectContaining({
        shortcode: 'b',
        ours: false,
        plays: 1,
        likes: 1,
        comments: 1,
        shares: 1,
      }),
      expect.objectContaining({
        shortcode: 'c',
        ours: true,
        plays: 4,
        likes: 3,
        comments: 1.5,
        shares: 2,
      }),
    ]);
  });

  it('is null where there is no usual to divide by, and for shares a scan could not read', () => {
    const reels = [
      reel('a', {
        plays: 0,
        likes: 0,
        comments: 0,
        shares: null,
        postedAt: ms('2026-10-20T10:00:00.000Z'),
      }),
      reel('b', {
        plays: 0,
        likes: 0,
        comments: 4,
        shares: null,
        postedAt: ms('2026-10-21T10:00:00.000Z'),
      }),
    ];
    const numbers = numbersOf({ reels });
    expect(numbers?.usual).toMatchObject({ plays: 0, likes: 0, comments: 2, shares: null });
    for (const point of numbers?.engagement ?? []) {
      expect(point.plays).toBeNull();
      expect(point.likes).toBeNull();
      expect(point.shares).toBeNull();
    }
    expect(numbers?.engagement.map((point) => point.comments)).toEqual([0, 2]);
  });
});

describe('empty cases', () => {
  it('has no numbers until a scan has read the profile', () => {
    expect(numbersOf({ scans: [] })).toBeNull();
  });

  it('with one scan and no reel: followers now, no medians, no series, nothing usual', () => {
    const numbers = numbersOf({ scans: [ONLY_SCAN] });
    expect(numbers).toMatchObject({
      range: 'since',
      from: '2026-10-26',
      sinceUs: '2026-10-26',
      usual: { plays: null, likes: null, comments: null, shares: null },
      plays: [],
      engagement: [],
    });
    expect(numbers?.tiles).toEqual({
      followers: {
        now: 1_000,
        thisWeek: null,
        sinceUs: null,
        line: [{ at: '2026-10-26T06:00:00.000Z', followers: 1_000, ours: false }],
      },
      playsPerReel: { ours: null, theirs: null, ratio: null },
      likesPerReel: { ours: null, theirs: null, ratio: null },
      sharesAWeek: {
        thisWeek: { ours: null, theirs: null },
        weekBefore: { ours: null, theirs: null },
        line: [],
      },
    });
  });

  it('with no ours reel: theirs is there, ours and the ratio are null', () => {
    const reels = [reel('a', { plays: 300 }), reel('b', { plays: 500 })];
    expect(numbersOf({ reels })?.tiles.playsPerReel).toEqual({
      ours: null,
      theirs: 400,
      ratio: null,
    });
  });

  it('with no theirs reel: ours is there, theirs and the ratio are null', () => {
    const reels = [reel('a', { plays: 300, jobId: 'ja' })];
    expect(numbersOf({ reels })?.tiles.playsPerReel).toEqual({
      ours: 300,
      theirs: null,
      ratio: null,
    });
  });

  it('has no ratio when the median of theirs is 0', () => {
    const reels = [reel('a', { plays: 0 }), reel('b', { plays: 300, jobId: 'jb' })];
    expect(numbersOf({ reels })?.tiles.playsPerReel).toEqual({
      ours: 300,
      theirs: 0,
      ratio: null,
    });
  });

  it('has no × usual while the usual plays are 0', () => {
    const reels = [reel('a', { plays: 0 }), reel('b', { plays: 0 })];
    const usual = instagramUsual(reels, ms('2026-10-27T10:00:00.000Z'), UTC);
    expect(usual.plays).toBe(0);
    expect(instagramReelRows(reels, usual).map((row) => row.timesUsual)).toEqual([null, null]);
  });
});

describe('instagramReelRows', () => {
  const usual = { plays: 1_000, likes: 100, comments: 10, shares: 5 };

  it('lists every reel, newest first, with the video it is linked to', () => {
    const rows = instagramReelRows(
      [
        reel('old', { postedAt: ms('2026-10-01T10:00:00.000Z'), plays: 500 }),
        reel('mid', {
          postedAt: ms('2026-10-10T10:00:00.000Z'),
          plays: 4_000,
          jobId: 'job-mid',
          caption: 'Positano from above',
          durationSec: 38.2,
          shares: null,
          sound: 'Sarà perché ti amo',
          coauthors: ['yael.edits'],
          hashtags: ['fpv'],
          pinned: true,
          paidPartnership: true,
        }),
        reel('new', { postedAt: ms('2026-10-20T10:00:00.000Z'), plays: 1_500, jobId: 'job-new' }),
      ],
      usual,
      new Map([['job-mid', 'Italy']]),
    );
    expect(rows.map((row) => row.shortcode)).toEqual(['new', 'mid', 'old']);
    expect(rows[1]).toEqual({
      shortcode: 'mid',
      url: 'https://www.instagram.com/reel/mid/',
      postedAt: '2026-10-10T10:00:00.000Z',
      caption: 'Positano from above',
      durationSec: 38.2,
      plays: 4_000,
      likes: 100,
      comments: 10,
      shares: null,
      sound: 'Sarà perché ti amo',
      coauthors: ['yael.edits'],
      hashtags: ['fpv'],
      pinned: true,
      paidPartnership: true,
      job: { id: 'job-mid', name: 'Italy' },
      timesUsual: 4,
    });
    // A linked job whose name is not known is shown by its id; theirs has no job.
    expect(rows[0]?.job).toEqual({ id: 'job-new', name: 'job-new' });
    expect(rows[2]?.job).toBeNull();
    expect(rows.map((row) => row.timesUsual)).toEqual([1.5, 4, 0.5]);
  });

  it('shows no caption as an empty one, and has nothing for no reel', () => {
    expect(instagramReelRows([reel('a')], usual)[0]?.caption).toBe('');
    expect(instagramReelRows([], usual)).toEqual([]);
  });

  it('has no × usual while the usual is not known', () => {
    const none = { plays: null, likes: null, comments: null, shares: null };
    expect(instagramReelRows([reel('a')], none)[0]?.timesUsual).toBeNull();
  });
});

describe('clientInstagramSummary', () => {
  it('is empty of numbers until a scan has read the profile', () => {
    expect(clientInstagramSummary({ handle: 'falcon.fpv', photoSavedAt: null }, null)).toEqual({
      handle: 'falcon.fpv',
      followers: null,
      weekChange: null,
      oursVsTheirs: null,
      photoAt: null,
    });
  });

  it('marks a private account, and says nothing for a public one', () => {
    const marked = clientInstagramSummary(
      { handle: 'spadino', photoSavedAt: null, private: true },
      null,
    );
    expect(marked.private).toBe(true);
    expect(clientInstagramSummarySchema.parse(marked)).toEqual(marked);
    for (const account of [
      { handle: 'falcon.fpv', photoSavedAt: null, private: false },
      { handle: 'falcon.fpv', photoSavedAt: null },
    ]) {
      expect(clientInstagramSummary(account, null)).not.toHaveProperty('private');
    }
  });

  it('has no ratio and no week change with one scan and no reels', () => {
    expect(
      clientInstagramSummary(
        { handle: 'falcon.fpv', photoSavedAt: null },
        numbersOf({ scans: [ONLY_SCAN] }),
      ),
    ).toEqual({
      handle: 'falcon.fpv',
      followers: 1_000,
      weekChange: null,
      oursVsTheirs: null,
      photoAt: null,
    });
  });
});
