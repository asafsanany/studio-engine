import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { instagramPhotoFor } from '../clients/paths.js';
import type { StudioDb } from '../db/database.js';
import { InstagramRepository } from '../db/instagram-repository.js';
import { fakeClock, memoryDb } from '../db/test-utils.js';
import { makeTempDir } from '../test-temp.js';
import { createFakeInstagramScanner } from './fake-scanner.js';
import {
  BOARD_ANCHOR,
  FALCON_FOLLOWERS,
  FALCON_FOLLOWERS_BY_SCAN,
  FALCON_HISTORY_SCANS,
  sampleInstagramFixtures,
  samplePhoto,
} from './sample-accounts.js';

// The sample accounts of the dev seed, the e2e run and a QA engine: the board's Falcon FPV, a private
// account and ones that fail, read through the real scanner's mapping.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const MONDAY = (n: number) => new Date(Date.parse(BOARD_ANCHOR) - (12 - n) * 7 * 86_400_000);

function setup(options: { anchor?: Date; history?: boolean; startAt?: Date } = {}) {
  const clock = fakeClock(
    (options.startAt ?? options.anchor ?? new Date(BOARD_ANCHOR)).toISOString(),
  );
  const db = memoryDb();
  opened.push(db);
  const instagram = new InstagramRepository(db, { clock });
  const dataDir = makeTempDir('studio-instagram-sample-');
  const scanner = createFakeInstagramScanner({
    instagram,
    dataDir,
    clock,
    fixtures: sampleInstagramFixtures({
      anchor: options.anchor ?? new Date(BOARD_ANCHOR),
      history: options.history,
    }),
  });
  const add = (clientId: string, handle: string) =>
    instagram.upsertAccount({ clientId, client: `Client ${clientId}`, handle });
  return { clock, instagram, dataDir, scanner, add };
}

describe('the sample photo', () => {
  it('is a valid PNG of the size asked, in the colours of its hue', () => {
    const png = samplePhoto(215, 32);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
    // The one IDAT chunk inflates to 32 rows of a filter byte and 32 RGB pixels.
    const idat = png.indexOf('IDAT');
    const length = png.readUInt32BE(idat - 4);
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + length))).toHaveLength(32 * (1 + 32 * 3));
  });
});

describe('Falcon FPV', () => {
  it('has the numbers of the board: 12,480 followers, a bio, and 22 reels of the last 90 days', async () => {
    const { scanner, instagram, dataDir, add } = setup();
    add('falcon', 'falcon.fpv');

    const result = await scanner.scan('falcon', 'falcon.fpv');

    expect(result.outcome).toBe('ok');
    expect(result.scan).toMatchObject({ followers: FALCON_FOLLOWERS, reelsRead: 22 });
    expect(instagram.getAccount('falcon')).toMatchObject({
      fullName: 'Falcon FPV',
      biography: 'FPV drone pilot. Italy and Israel. Bookings in DM.',
      private: false,
      photoSavedAt: expect.any(Number),
    });
    const reels = instagram.listReels('falcon');
    expect(reels).toHaveLength(22);
    expect(reels[0]).toMatchObject({
      caption: 'Granite Fiber, one take through the warehouse',
      plays: 9_800,
      likes: 610,
      comments: 22,
      shares: 140,
      sound: 'Original audio',
      coauthors: ['granite.fiber'],
      paidPartnership: true,
    });
    expect(instagram.getReel(reels[0]?.shortcode ?? '')?.postedAt).toBe(
      Date.parse('2026-10-25T19:40:00Z'),
    );
    expect(reels.find((reel) => reel.caption === 'Positano from above')).toMatchObject({
      plays: 41_200,
      pinned: true,
      sound: 'Sarà perché ti amo · Ricchi e Poveri',
    });
    // The picture is a PNG, which the page's <img> reads whatever the file is called.
    expect([...readFileSync(instagramPhotoFor(dataDir, 'falcon')).subarray(1, 4)]).toEqual([
      0x50, 0x4e, 0x47,
    ]);
  });

  it('moves the board with the anchor: a QA engine that starts today has the same reels, as old as on the board', async () => {
    const anchor = new Date('2027-03-05T09:00:00Z');
    const { scanner, instagram, add } = setup({ anchor });
    add('falcon', 'falcon.fpv');

    await scanner.scan('falcon', 'falcon.fpv');

    // The newest reel was posted 10 h 20 min before the scan, as on the board.
    expect(instagram.listReels('falcon')[0]?.postedAt).toBe(
      anchor.getTime() - (10 * 60 + 20) * 60_000,
    );
  });

  it('grows by 12 followers with every scan after the first, so Scan now changes something', async () => {
    const { scanner, add, clock } = setup();
    add('falcon', 'falcon.fpv');

    const first = await scanner.scan('falcon', 'falcon.fpv');
    clock.tick(60_000);
    const second = await scanner.scan('falcon', 'falcon.fpv');

    expect(first.scan.followers).toBe(12_480);
    expect(second.scan.followers).toBe(12_492);
  });

  it('with history, 13 weekly scans follow the board: followers by scan, reels only once posted', async () => {
    const { scanner, instagram, clock, add } = setup({
      history: true,
      startAt: MONDAY(0),
    });
    add('falcon', 'falcon.fpv');
    const followers: Array<number | null> = [];
    const reelsRead: number[] = [];
    for (let week = 0; week < FALCON_HISTORY_SCANS; week += 1) {
      const target = MONDAY(week).getTime();
      clock.tick(target - clock().getTime());
      const result = await scanner.scan('falcon', 'falcon.fpv');
      followers.push(result.scan.followers);
      reelsRead.push(result.scan.reelsRead);
    }

    expect(followers).toEqual([...FALCON_FOLLOWERS_BY_SCAN]);
    expect(followers[0]).toBe(10_550);
    expect(followers.at(-1)).toBe(12_480);
    // The first Monday (3 Aug 06:00) is before every reel; the last one reads all 22.
    expect(reelsRead[0]).toBe(0);
    expect(reelsRead.at(-1)).toBe(22);
    // The last scan carries the board's numbers, the one before has the young reels smaller.
    expect(instagram.getReel(instagram.listReels('falcon')[0]?.shortcode ?? '')?.plays).toBe(9_800);
    const scans = instagram.listOkScans('falcon');
    expect(scans).toHaveLength(FALCON_HISTORY_SCANS);
  });
});

describe('the other sample accounts', () => {
  it('has a private account, one that works once, and the two that cannot run', async () => {
    const { scanner, instagram, add, clock } = setup();
    add('venezia', 'venezia.studio');
    add('flaky', 'flaky.studio');
    add('credit', 'credit.out');
    add('nokey', 'no.key');

    expect((await scanner.scan('venezia', 'venezia.studio')).outcome).toBe('private');
    expect(instagram.getAccount('venezia')).toMatchObject({ private: true });
    expect((await scanner.scan('flaky', 'flaky.studio')).outcome).toBe('ok');
    expect(instagram.listReels('flaky')).toHaveLength(3);
    clock.tick(60_000);
    expect((await scanner.scan('flaky', 'flaky.studio')).outcome).toBe('failed');
    expect((await scanner.scan('credit', 'credit.out')).outcome).toBe('no-credit');
    expect((await scanner.scan('nokey', 'no.key')).outcome).toBe('no-token');
  });

  it('keeps the real answers of IG2: natgeo and an account that is not there', async () => {
    const { scanner, add } = setup();
    add('c1', 'natgeo');
    add('c2', 'studio_engine_no_such_user_8f3k2');

    expect((await scanner.scan('c1', 'natgeo')).outcome).toBe('ok');
    expect((await scanner.scan('c2', 'studio_engine_no_such_user_8f3k2')).outcome).toBe(
      'not-found',
    );
  });
});
