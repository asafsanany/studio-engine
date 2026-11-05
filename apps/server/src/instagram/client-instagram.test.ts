import {
  clientInstagramSchema,
  clientInstagramSummarySchema,
  noClientInstagram,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository, type NewDelivery } from '../db/delivery-repository.js';
import { InstagramRepository } from '../db/instagram-repository.js';
import { idFor, memoryDb } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import {
  linkableJobs,
  readClientInstagram,
  readClientInstagramSummary,
  SCAN_STALE_AFTER_MS,
} from './client-instagram.js';

// What the client page and the Clients list read of a client's Instagram, over the real tables
// (in memory): the scans, the reels, their reads and the deliveries that jobs are linked from.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const CLIENT = 'Falcon FPV';
const FALCON = clientIdFor(CLIENT);
const NOW = Date.parse('2026-10-27T10:00:00.000Z');
const ADMIN = { now: NOW, timeZone: 'UTC', editor: false } as const;
const EDITOR = { ...ADMIN, editor: true } as const;

const jobId = (name: string) => idFor(`${CLIENT}/${name}`);

function setup() {
  const db = memoryDb();
  opened.push(db);
  const instagram = new InstagramRepository(db);
  const deliveries = new DeliveryRepository(db);

  const deliver = (name: string, deliveredAt: string, overrides: Partial<NewDelivery> = {}) =>
    deliveries.record({
      jobId: jobId(name),
      clientId: FALCON,
      client: CLIENT,
      name,
      relPath: `${CLIENT}/${name}`,
      deliveredAt: Date.parse(deliveredAt),
      price: 40,
      currency: 'ILS',
      ...overrides,
    });

  /** A scan that ended `ok` at `startedAt` and read these followers. */
  const okScan = (startedAt: string, followers: number, costUsd = 0.1) => {
    const started = instagram.startScan({
      clientId: FALCON,
      handle: 'falcon.fpv',
      startedAt: Date.parse(startedAt),
    });
    return instagram.finishScan(started.id, {
      outcome: 'ok',
      followers,
      following: 310,
      posts: 188,
      reelsRead: 3,
      costUsd,
      finishedAt: Date.parse(startedAt) + 60_000,
    });
  };

  const addReel = (
    shortcode: string,
    postedAt: string,
    plays: number,
    likes = 100,
    shares: number | null = null,
  ) => ({
    shortcode,
    clientId: FALCON,
    url: `https://www.instagram.com/reel/${shortcode}/`,
    postedAt: Date.parse(postedAt),
    caption: `Reel ${shortcode}`,
    plays,
    likes,
    comments: 10,
    shares,
  });

  return { db, instagram, deliveries, deliver, okScan, addReel };
}

/** Falcon FPV with three weekly scans, three reels (one ours), reads and four deliveries. */
function falcon() {
  const kit = setup();
  const { instagram, deliver, okScan, addReel } = kit;
  instagram.upsertAccount({
    clientId: FALCON,
    client: CLIENT,
    handle: 'falcon.fpv',
    since: null,
    fullName: 'Falcon FPV',
    biography: 'FPV pilot.',
    photoSavedAt: Date.parse('2026-10-12T06:02:00.000Z'),
    addedAt: Date.parse('2026-10-12T05:50:00.000Z'),
  });
  deliver('Rooftop Run', '2026-10-02T09:00:00.000Z');
  deliver('Granite', '2026-10-23T09:00:00.000Z');
  deliver('Orchard crunch', '2026-10-21T09:00:00.000Z');
  deliver('Coastline', '2026-10-19T09:00:00.000Z');
  kit.deliveries.markPaid([jobId('Coastline'), jobId('Rooftop Run')], '2026-10-24');

  const first = okScan('2026-10-12T06:00:00.000Z', 12_000);
  const second = okScan('2026-10-19T06:00:00.000Z', 12_168);
  const third = okScan('2026-10-26T06:03:00.000Z', 12_480);
  instagram.upsertReels(first.id, [
    addReel('AAA', '2026-10-04T12:00:00.000Z', 4_000),
    addReel('BBB', '2026-10-10T12:00:00.000Z', 18_000, 900),
  ]);
  instagram.addReelReads(first.id, [
    { shortcode: 'AAA', plays: 4_000, likes: 100, comments: 10, shares: 10 },
    { shortcode: 'BBB', plays: 18_000, likes: 900, comments: 10, shares: 100 },
  ]);
  instagram.upsertReels(second.id, [addReel('CCC', '2026-10-17T12:00:00.000Z', 6_000)]);
  instagram.addReelReads(second.id, [
    { shortcode: 'AAA', plays: 4_500, likes: 100, comments: 10, shares: 20 },
    { shortcode: 'BBB', plays: 20_000, likes: 900, comments: 10, shares: 300 },
    { shortcode: 'CCC', plays: 1_000, likes: 100, comments: 10, shares: 5 },
  ]);
  instagram.upsertReels(third.id, [
    addReel('AAA', '2026-10-04T12:00:00.000Z', 5_000, 100, 40),
    addReel('BBB', '2026-10-10T12:00:00.000Z', 21_000, 950, 700),
    addReel('CCC', '2026-10-17T12:00:00.000Z', 6_000, 100, 25),
  ]);
  instagram.addReelReads(third.id, [
    { shortcode: 'AAA', plays: 5_000, likes: 100, comments: 10, shares: 40 },
    { shortcode: 'BBB', plays: 21_000, likes: 950, comments: 10, shares: 700 },
    { shortcode: 'CCC', plays: 6_000, likes: 100, comments: 10, shares: 25 },
  ]);
  instagram.linkReel('BBB', jobId('Rooftop Run'), Date.parse('2026-10-26T07:00:00.000Z'));
  return { ...kit, first, second, third };
}

describe('readClientInstagram', () => {
  it('answers the empty shape for a client with no account', () => {
    const { instagram } = setup();
    expect(readClientInstagram(instagram, FALCON, 'since', ADMIN)).toEqual(noClientInstagram());
  });

  it('answers the empty shape again once the account is removed, though its scans and reels stay', () => {
    const { instagram } = falcon();
    expect(instagram.removeAccount(FALCON)).toBe(true);
    expect(readClientInstagram(instagram, FALCON, 'since', ADMIN)).toEqual(noClientInstagram());
  });

  it('answers an account no scan has run for: no scan, no numbers, no reels, the first scan next', () => {
    const { instagram } = setup();
    instagram.upsertAccount({
      clientId: FALCON,
      client: CLIENT,
      handle: 'falcon.fpv',
      addedAt: Date.parse('2026-10-27T09:00:00.000Z'),
    });

    const answer = readClientInstagram(instagram, FALCON, 'since', ADMIN);

    expect(clientInstagramSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({
      account: { handle: 'falcon.fpv', since: null, private: false, photoSavedAt: null },
      lastScan: null,
      scanning: false,
      numbers: null,
      reels: [],
      linkableJobs: [],
      nextScanAt: '2026-11-02T06:00:00.000Z',
    });
  });

  it('answers the whole client page: account, last scan, numbers, reels and jobs to link', () => {
    const { instagram } = falcon();

    const answer = readClientInstagram(instagram, FALCON, 'since', ADMIN);

    expect(clientInstagramSchema.parse(answer)).toEqual(answer);
    expect(answer.account).toEqual({
      handle: 'falcon.fpv',
      since: null,
      addedAt: '2026-10-12T05:50:00.000Z',
      fullName: 'Falcon FPV',
      bio: 'FPV pilot.',
      private: false,
      photoSavedAt: '2026-10-12T06:02:00.000Z',
    });
    expect(answer.lastScan).toEqual({
      startedAt: '2026-10-26T06:03:00.000Z',
      finishedAt: '2026-10-26T06:04:00.000Z',
      outcome: 'ok',
      error: null,
      followers: 12_480,
      following: 310,
      posts: 188,
      reelsRead: 3,
      costUsd: 0.1,
    });
    expect(answer.scanning).toBe(false);
    // The scan after the one of Monday 26 Oct 06:03 is due Monday 2 Nov 06:00.
    expect(answer.nextScanAt).toBe('2026-11-02T06:00:00.000Z');
  });

  it('works the numbers out: since us is the first delivery, the tiles and the series', () => {
    const { instagram } = falcon();

    const numbers = readClientInstagram(instagram, FALCON, 'since', ADMIN).numbers;

    // The first delivery (2 Oct) is before the first scan (12 Oct): the reels count from 2 Oct, the
    // followers from the first scan, because they are not known before it.
    expect(numbers).toMatchObject({ range: 'since', from: '2026-10-02', sinceUs: '2026-10-02' });
    expect(numbers?.tiles.followers).toMatchObject({ now: 12_480, thisWeek: 312, sinceUs: 480 });
    expect(numbers?.tiles.followers.line.map((point) => point.followers)).toEqual([
      12_000, 12_168, 12_480,
    ]);
    // The reels of 4, 10 and 17 Oct were all posted since us, though before the first scan.
    expect(numbers?.plays.map((point) => point.shortcode)).toEqual(['AAA', 'BBB', 'CCC']);
    // The usual is the median of all three reels of the last 90 days.
    expect(numbers?.usual).toMatchObject({ plays: 6_000, likes: 100, comments: 10, shares: 40 });
    // This week, shares gained between the last two scans: AAA +20, BBB +400 (ours), CCC +20.
    expect(numbers?.tiles.sharesAWeek).toEqual({
      thisWeek: { ours: 400, theirs: 40 },
      // The week before: AAA +10, BBB +200 (ours); CCC was posted after the first scan: +5.
      weekBefore: { ours: 200, theirs: 15 },
      // The line: the shares gained between the scans, at the later one (215 and 440 added up).
      line: [
        { at: '2026-10-19T06:00:00.000Z', shares: 215 },
        { at: '2026-10-26T06:03:00.000Z', shares: 440 },
      ],
    });
  });

  it('draws the shares line over every scan of the range, not only the two newest weeks', () => {
    const { instagram, okScan } = falcon();
    // An older scan, stored last: before the first one, it read only AAA (BBB was not posted yet).
    const oldest = okScan('2026-10-05T06:00:00.000Z', 11_900);
    instagram.addReelReads(oldest.id, [
      { shortcode: 'AAA', plays: 3_000, likes: 90, comments: 9, shares: 4 },
    ]);

    const { sharesAWeek } = readClientInstagram(instagram, FALCON, 'since', ADMIN).numbers
      ?.tiles ?? {
      sharesAWeek: null,
    };

    // The oldest pair: AAA +6, BBB posted since the older scan so all 100 are new. The tile's own
    // numbers are the same as without the older scan.
    expect(sharesAWeek?.line).toEqual([
      { at: '2026-10-12T06:00:00.000Z', shares: 106 },
      { at: '2026-10-19T06:00:00.000Z', shares: 215 },
      { at: '2026-10-26T06:03:00.000Z', shares: 440 },
    ]);
    expect(sharesAWeek?.thisWeek).toEqual({ ours: 400, theirs: 40 });
    expect(sharesAWeek?.weekBefore).toEqual({ ours: 200, theirs: 15 });
  });

  it('keeps the shares line to the range, and the tile numbers out of it', () => {
    const { instagram, okScan } = falcon();
    for (const day of ['2026-08-03', '2026-08-10']) {
      const old = okScan(`${day}T06:00:00.000Z`, 11_000);
      instagram.addReelReads(old.id, [
        { shortcode: 'AAA', plays: 1, likes: 1, comments: 1, shares: 1 },
      ]);
    }
    const line = (range: 'since' | '90' | '30') =>
      readClientInstagram(instagram, FALCON, range, ADMIN).numbers?.tiles.sharesAWeek.line.map(
        (point) => point.at.slice(0, 10),
      );

    // 30 days back from 27 Oct is 27 Sep; since us starts on the first delivery (2 Oct): the pair
    // of 3 and 10 Aug is out of both, and the one of 10 Aug and 12 Oct ends in range, so it stays.
    expect(line('30')).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    expect(line('since')).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    // 90 days back is 29 Jul: every pair counts.
    expect(line('90')).toEqual(['2026-08-10', '2026-10-12', '2026-10-19', '2026-10-26']);
    // The tile's numbers do not depend on the range.
    for (const range of ['since', '90', '30'] as const) {
      const tile = readClientInstagram(instagram, FALCON, range, ADMIN).numbers?.tiles.sharesAWeek;
      expect(tile?.thisWeek).toEqual({ ours: 400, theirs: 40 });
    }
  });

  it('marks the followers line where one of our reels was posted since the scan before', () => {
    const { instagram } = falcon();
    // BBB is linked to Rooftop Run and was posted on 10 Oct, before the first scan: no dot yet.
    const followers = () =>
      readClientInstagram(instagram, FALCON, 'since', ADMIN).numbers?.tiles.followers;
    expect(followers()?.line.map((point) => point.ours)).toEqual([false, false, false]);

    // CCC was posted on 17 Oct, between the first scan (12 Oct) and the second (19 Oct).
    instagram.linkReel('CCC', jobId('Granite'), Date.parse('2026-10-26T08:00:00.000Z'));
    expect(followers()?.line.map((point) => point.ours)).toEqual([false, true, false]);
  });

  it('counts the ranges 90 and 30 from today', () => {
    const { instagram } = falcon();

    const ninety = readClientInstagram(instagram, FALCON, '90', ADMIN).numbers;
    const thirty = readClientInstagram(instagram, FALCON, '30', ADMIN).numbers;

    expect(ninety).toMatchObject({ range: '90', from: '2026-07-29', sinceUs: '2026-10-02' });
    expect(ninety?.plays.map((point) => point.shortcode)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(ninety?.tiles.playsPerReel).toEqual({
      ours: 21_000,
      theirs: 5_500,
      ratio: 21_000 / 5_500,
    });
    expect(thirty?.from).toBe('2026-09-27');
    expect(thirty?.plays).toHaveLength(3);
    // The ours reel's job is named after its delivery.
    expect(ninety?.plays[1]).toMatchObject({ shortcode: 'BBB', ours: true, job: 'Rooftop Run' });
  });

  it('lists every reel newest first, the linked one with its job and every one × usual', () => {
    const { instagram } = falcon();

    const { reels } = readClientInstagram(instagram, FALCON, 'since', ADMIN);

    expect(reels.map((reel) => reel.shortcode)).toEqual(['CCC', 'BBB', 'AAA']);
    expect(reels.map((reel) => reel.job)).toEqual([
      null,
      { id: jobId('Rooftop Run'), name: 'Rooftop Run' },
      null,
    ]);
    expect(reels.map((reel) => reel.timesUsual)).toEqual([1, 3.5, 5_000 / 6_000]);
    expect(reels[1]).toMatchObject({ plays: 21_000, likes: 950, caption: 'Reel BBB', shares: 700 });
  });

  it('offers the delivered and paid jobs no reel links, the newest delivery first', () => {
    const { instagram } = falcon();

    const { linkableJobs: jobs } = readClientInstagram(instagram, FALCON, 'since', ADMIN);

    // Rooftop Run is linked to BBB, so it is not offered; Coastline is paid.
    expect(jobs).toEqual([
      {
        jobId: jobId('Granite'),
        name: 'Granite',
        deliveredAt: '2026-10-23T09:00:00.000Z',
        stage: 'delivered',
      },
      {
        jobId: jobId('Orchard crunch'),
        name: 'Orchard crunch',
        deliveredAt: '2026-10-21T09:00:00.000Z',
        stage: 'delivered',
      },
      {
        jobId: jobId('Coastline'),
        name: 'Coastline',
        deliveredAt: '2026-10-19T09:00:00.000Z',
        stage: 'paid',
      },
    ]);
    expect(linkableJobs(instagram, FALCON)).toEqual(jobs);
  });

  it('gives an editor no money: no scan cost and no jobs to link', () => {
    const { instagram } = falcon();

    const answer = readClientInstagram(instagram, FALCON, 'since', EDITOR);

    expect(clientInstagramSchema.parse(answer)).toEqual(answer);
    expect(answer.lastScan?.costUsd).toBeNull();
    expect(answer.linkableJobs).toEqual([]);
    // Everything else is the same.
    const admin = readClientInstagram(instagram, FALCON, 'since', ADMIN);
    expect({ ...answer, lastScan: null, linkableJobs: [] }).toEqual({
      ...admin,
      lastScan: null,
      linkableJobs: [],
    });
  });

  it('names the since day when the account has one and it is after the first scan', () => {
    const { instagram } = falcon();
    instagram.upsertAccount({
      clientId: FALCON,
      client: CLIENT,
      handle: 'falcon.fpv',
      since: '2026-10-19',
    });

    const numbers = readClientInstagram(instagram, FALCON, 'since', ADMIN).numbers;

    expect(numbers).toMatchObject({ from: '2026-10-19', sinceUs: '2026-10-19' });
    expect(numbers?.tiles.followers.sinceUs).toBe(312);
  });

  it('counts the reels of a new account from the since day, though its first scan is later', () => {
    const { instagram, okScan, addReel } = setup();
    // Falcon FPV on 30 Oct: ours since 23 Oct, scanned for the first time on 30 Oct.
    instagram.upsertAccount({
      clientId: FALCON,
      client: CLIENT,
      handle: 'falcon.fpv',
      since: '2026-10-23',
    });
    const first = okScan('2026-10-30T06:00:00.000Z', 5_000);
    instagram.upsertReels(first.id, [
      addReel('OLD', '2026-10-05T12:00:00.000Z', 1_000),
      addReel('MID', '2026-10-26T12:00:00.000Z', 2_000),
      addReel('LATE', '2026-10-28T12:00:00.000Z', 3_000),
    ]);
    const context = { ...ADMIN, now: Date.parse('2026-10-30T09:00:00.000Z') };

    const answer = readClientInstagram(instagram, FALCON, 'since', context);

    // The reels count from the since day, and that is the day the page names.
    expect(answer.numbers).toMatchObject({ from: '2026-10-23', sinceUs: '2026-10-23' });
    expect(answer.numbers?.plays.map((point) => point.shortcode)).toEqual(['MID', 'LATE']);
    expect(answer.numbers?.engagement.map((point) => point.shortcode)).toEqual(['MID', 'LATE']);
    // One scan is nothing to count the followers' change from.
    expect(answer.numbers?.tiles.followers).toMatchObject({
      now: 5_000,
      thisWeek: null,
      sinceUs: null,
    });
    // The reels list has every reel, whatever the range.
    expect(answer.reels.map((reel) => reel.shortcode)).toEqual(['LATE', 'MID', 'OLD']);

    // The next scan counts the followers from the first one.
    const second = okScan('2026-11-06T06:00:00.000Z', 5_200);
    instagram.upsertReels(second.id, [addReel('LATE', '2026-10-28T12:00:00.000Z', 3_500)]);
    const later = readClientInstagram(instagram, FALCON, 'since', {
      ...context,
      now: Date.parse('2026-11-06T09:00:00.000Z'),
    });
    expect(later.numbers?.tiles.followers).toMatchObject({ now: 5_200, sinceUs: 200 });
    expect(later.numbers?.sinceUs).toBe('2026-10-23');
  });

  it('starts since us on the first delivery when it is after the first scan', () => {
    const { instagram, deliver } = setup();
    instagram.upsertAccount({ clientId: FALCON, client: CLIENT, handle: 'falcon.fpv' });
    const scan = instagram.startScan({
      clientId: FALCON,
      handle: 'falcon.fpv',
      startedAt: Date.parse('2026-10-05T06:00:00.000Z'),
    });
    instagram.finishScan(scan.id, { outcome: 'ok', followers: 900 });
    deliver('First video', '2026-10-14T09:00:00.000Z');

    const numbers = readClientInstagram(instagram, FALCON, 'since', ADMIN).numbers;

    expect(numbers).toMatchObject({ sinceUs: '2026-10-14' });
  });

  it('shows a failed scan as the last scan, and keeps the numbers of the scans that read the profile', () => {
    const { instagram } = falcon();
    const failed = instagram.startScan({
      clientId: FALCON,
      handle: 'falcon.fpv',
      startedAt: Date.parse('2026-10-27T06:00:00.000Z'),
    });
    instagram.finishScan(failed.id, {
      outcome: 'no-credit',
      error: 'Apify is out of credit',
      costUsd: 0,
      finishedAt: Date.parse('2026-10-27T06:00:05.000Z'),
    });

    const answer = readClientInstagram(instagram, FALCON, 'since', ADMIN);

    expect(clientInstagramSchema.parse(answer)).toEqual(answer);
    expect(answer.lastScan).toMatchObject({
      outcome: 'no-credit',
      error: 'Apify is out of credit',
      followers: null,
      costUsd: 0,
    });
    expect(answer.numbers?.tiles.followers.now).toBe(12_480);
    // The next scan is the Monday after the failed one, so a failed scan is not retried at once.
    expect(answer.nextScanAt).toBe('2026-11-02T06:00:00.000Z');
  });

  describe('scanning', () => {
    it('is true while a scan has started and not ended, and the last scan is still the one before', () => {
      const { instagram } = falcon();
      instagram.startScan({
        clientId: FALCON,
        handle: 'falcon.fpv',
        startedAt: NOW - 5 * 60_000,
      });

      const answer = readClientInstagram(instagram, FALCON, 'since', ADMIN);

      expect(answer.scanning).toBe(true);
      expect(answer.lastScan?.startedAt).toBe('2026-10-26T06:03:00.000Z');
    });

    it('is false for a scan that has been running for longer than any scan can', () => {
      const { instagram } = falcon();
      instagram.startScan({
        clientId: FALCON,
        handle: 'falcon.fpv',
        startedAt: NOW - SCAN_STALE_AFTER_MS - 1,
      });

      expect(readClientInstagram(instagram, FALCON, 'since', ADMIN).scanning).toBe(false);
    });

    it('is true while a scan is queued', () => {
      const { instagram } = falcon();
      expect(readClientInstagram(instagram, FALCON, 'since', ADMIN).scanning).toBe(false);
      expect(
        readClientInstagram(instagram, FALCON, 'since', { ...ADMIN, scanQueued: true }).scanning,
      ).toBe(true);
    });
  });

  it('reads the days on the wall clock of the time zone', () => {
    const { instagram } = falcon();
    // 06:03 UTC on Monday 26 Oct is 08:03 in Jerusalem (UTC+2): the next Monday 06:00 there is
    // 04:00 UTC.
    const answer = readClientInstagram(instagram, FALCON, 'since', {
      ...ADMIN,
      timeZone: 'Asia/Jerusalem',
    });
    expect(answer.nextScanAt).toBe('2026-11-02T04:00:00.000Z');
  });
});

describe('readClientInstagramSummary', () => {
  it('is null for a client with no account', () => {
    const { instagram } = setup();
    expect(readClientInstagramSummary(instagram, FALCON, ADMIN)).toBeNull();
  });

  it('has the handle and no numbers for an account no scan has read', () => {
    const { instagram } = setup();
    instagram.upsertAccount({ clientId: FALCON, client: CLIENT, handle: 'falcon.fpv' });
    expect(readClientInstagramSummary(instagram, FALCON, ADMIN)).toEqual({
      handle: 'falcon.fpv',
      followers: null,
      weekChange: null,
      oursVsTheirs: null,
      photoAt: null,
    });
  });

  it('marks a private account', () => {
    const { instagram } = setup();
    instagram.upsertAccount({
      clientId: FALCON,
      client: CLIENT,
      handle: 'falcon.fpv',
      private: true,
    });

    const summary = readClientInstagramSummary(instagram, FALCON, ADMIN);

    expect(clientInstagramSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({ handle: 'falcon.fpv', private: true, followers: null });
  });

  it('has the followers, this week and ours ÷ theirs plays', () => {
    const { instagram } = falcon();

    const summary = readClientInstagramSummary(instagram, FALCON, ADMIN);

    expect(clientInstagramSummarySchema.parse(summary)).toEqual(summary);
    // Since us is 2 Oct: all three reels count. BBB is ours (21K plays), AAA and CCC theirs (5.5K).
    expect(summary).toEqual({
      handle: 'falcon.fpv',
      followers: 12_480,
      weekChange: 312,
      oursVsTheirs: 21_000 / 5_500,
      photoAt: '2026-10-12T06:02:00.000Z',
    });
  });

  it('has the ratio of the medians once more reels of ours are in the range', () => {
    const { instagram } = falcon();
    // A second reel of ours, posted after the first scan: ours is 10K and 21K, theirs 5K and 6K.
    instagram.upsertReels(instagram.latestScan(FALCON)?.id ?? 0, [
      {
        shortcode: 'DDD',
        clientId: FALCON,
        url: 'https://www.instagram.com/reel/DDD/',
        postedAt: Date.parse('2026-10-20T12:00:00.000Z'),
        plays: 10_000,
        likes: 1,
        comments: 0,
      },
    ]);
    instagram.linkReel('DDD', jobId('Granite'));

    const summary = readClientInstagramSummary(instagram, FALCON, ADMIN);

    expect(summary?.oursVsTheirs).toBeCloseTo(15_500 / 5_500, 5);
  });
});
