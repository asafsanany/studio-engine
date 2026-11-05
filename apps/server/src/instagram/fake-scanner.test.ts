import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { instagramPhotoFor } from '../clients/paths.js';
import type { StudioDb } from '../db/database.js';
import { InstagramRepository } from '../db/instagram-repository.js';
import { fakeClock, memoryDb } from '../db/test-utils.js';
import { makeTempDir } from '../test-temp.js';
import {
  createFakeInstagramScanner,
  FAKE_PROFILE_COST_USD,
  FAKE_REEL_COST_USD,
  FAKE_REEL_START_COST_USD,
  type FakeInstagramFixtures,
  type FakeInstagramScannerOptions,
  loadFakeInstagramFixtures,
} from './fake-scanner.js';

// The fake scanner: the real mapping and writing over fixture answers. It has to behave like the
// real one for everything a test, the e2e run or the seed looks at.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup(options: Partial<FakeInstagramScannerOptions> = {}) {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const instagram = new InstagramRepository(db, { clock });
  const dataDir = makeTempDir('studio-instagram-fake-');
  const scanner = createFakeInstagramScanner({ instagram, dataDir, clock, ...options });
  const add = (clientId: string, handle: string) =>
    instagram.upsertAccount({ clientId, client: `Client ${clientId}`, handle });
  return { clock, instagram, dataDir, scanner, add };
}

describe('the fixtures', () => {
  it('has the real answers of IG2: natgeo, a private account and one that is not there', () => {
    const fixtures = loadFakeInstagramFixtures();

    expect(Object.keys(fixtures).sort()).toEqual([
      'example_private_creator',
      'natgeo',
      'studio_engine_no_such_user_8f3k2',
    ]);
    expect(fixtures.natgeo?.reels).toHaveLength(5);
    expect(fixtures.example_private_creator?.reels).toEqual([]);
  });
});

describe('the fake scanner', () => {
  it('scans natgeo like the real one: account, five reels, reads, picture and cost', async () => {
    const { scanner, instagram, dataDir, add } = setup();
    add('c1', 'natgeo');

    const result = await scanner.scan('c1', 'natgeo');

    expect(result).toMatchObject({ outcome: 'ok', error: null, photoSaved: true });
    expect(result.scan).toMatchObject({
      followers: 268240491,
      following: 195,
      posts: 32131,
      reelsRead: 5,
      apifyRunIds: ['fake-run-1', 'fake-run-2'],
    });
    // The profile, the start of the reel run and five reels at the price list.
    expect(result.scan.costUsd).toBeCloseTo(
      FAKE_PROFILE_COST_USD + FAKE_REEL_START_COST_USD + 5 * FAKE_REEL_COST_USD,
      6,
    );
    expect(instagram.getAccount('c1')).toMatchObject({
      fullName: 'National Geographic',
      instagramId: '787132',
      photoSavedAt: expect.any(Number),
    });
    expect(instagram.listReels('c1')).toHaveLength(5);
    expect(instagram.getReel('DfBUU0nDswI')?.coauthors).toEqual([
      'natgeoscience',
      'startalk',
      'natgeobooks',
    ]);
    expect(instagram.readsOfScans(result.scan.id, result.scan.id)).toHaveLength(5);
    // The picture is a real JPEG (it starts with the JPEG marker).
    const bytes = readFileSync(instagramPhotoFor(dataDir, 'c1'));
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('answers a handle with no fixture the way Apify answers a missing account', async () => {
    const { scanner, instagram, dataDir, add } = setup();
    add('c1', 'nobody.here');

    const result = await scanner.scan('c1', 'nobody.here');

    expect(result).toMatchObject({
      outcome: 'not-found',
      error: '@nobody.here was not found on Instagram',
    });
    expect(result.scan.costUsd).toBeCloseTo(FAKE_PROFILE_COST_USD, 6);
    expect(instagram.listReels('c1')).toEqual([]);
    expect(existsSync(instagramPhotoFor(dataDir, 'c1'))).toBe(false);
  });

  it('answers the private fixture as a private account', async () => {
    const { scanner, instagram, add } = setup();
    add('c1', 'example_private_creator');

    const result = await scanner.scan('c1', 'example_private_creator');

    expect(result.outcome).toBe('private');
    expect(instagram.getAccount('c1')).toMatchObject({ private: true });
    expect(result.scan.reelsRead).toBe(0);
  });

  it.each([
    ['no-token', 'no-token'],
    ['no-credit', 'no-credit'],
    ['timeout', 'failed'],
    ['failed', 'failed'],
  ] as const)('fails like Apify does when a fixture says %s', async (fails, outcome) => {
    const fixtures: FakeInstagramFixtures = { broken: { profile: [], reels: [], fails } };
    const { scanner, instagram, add } = setup({ fixtures });
    add('c1', 'broken');

    const result = await scanner.scan('c1', 'broken');

    expect(result.outcome).toBe(outcome);
    expect(result.error).not.toBeNull();
    expect(result.scan.costUsd).toBe(0);
    expect(instagram.listReels('c1')).toEqual([]);
  });

  it('answers from the fixtures it is given, up to the 60-reel limit, with the picture it is given', async () => {
    const reels = Array.from({ length: 75 }, (_value, index) => ({
      shortCode: `R${index}`,
      url: `https://www.instagram.com/reel/R${index}/`,
      timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, index)).toISOString(),
      videoPlayCount: 1000 + index,
      likesCount: 10,
      commentsCount: 1,
      sharesCount: 2,
      ownerUsername: 'falcon.fpv',
    }));
    const fixtures: FakeInstagramFixtures = {
      'falcon.fpv': {
        profile: [
          {
            id: '55',
            username: 'falcon.fpv',
            fullName: 'Falcon FPV',
            biography: 'FPV pilot',
            followersCount: 4210,
            followsCount: 300,
            postsCount: 90,
            private: false,
            profilePicUrlHD: 'https://scontent.cdninstagram.com/falcon.jpg',
          },
        ],
        reels,
      },
    };
    const { scanner, instagram, dataDir, add } = setup({
      fixtures,
      photo: new TextEncoder().encode('MY-PICTURE'),
    });
    add('c1', 'falcon.fpv');

    const result = await scanner.scan('c1', 'falcon.fpv');

    expect(result.scan).toMatchObject({ followers: 4210, reelsRead: 60 });
    expect(instagram.listReels('c1')).toHaveLength(60);
    expect(instagram.getReel('R0')).toMatchObject({ plays: 1000, shares: 2, coauthors: [] });
    expect(readFileSync(instagramPhotoFor(dataDir, 'c1'), 'utf8')).toBe('MY-PICTURE');
  });

  it('tells a fixture which scan of the handle it is and when, so an account can grow', async () => {
    const fixtures: FakeInstagramFixtures = {
      growing: {
        profile: ({ scan }) => [
          {
            id: '9',
            username: 'growing',
            followersCount: 100 * scan,
            followsCount: 1,
            postsCount: 2,
            private: false,
          },
        ],
        // A reel that is not posted yet at the scan's clock is not in the answer.
        reels: ({ now }) =>
          [
            { shortCode: 'EARLY', at: '2026-10-01T10:00:00Z' },
            { shortCode: 'LATER', at: '2026-10-25T10:00:00Z' },
          ]
            .filter((reel) => Date.parse(reel.at) <= now.getTime())
            .map((reel) => ({
              shortCode: reel.shortCode,
              timestamp: reel.at,
              videoPlayCount: 5,
              ownerUsername: 'growing',
            })),
      },
    };
    const { scanner, instagram, clock, add } = setup({ fixtures });
    add('c1', 'growing');

    const first = await scanner.scan('c1', 'growing');
    clock.tick(30 * 86_400_000);
    const second = await scanner.scan('c1', 'growing');

    expect(first.scan).toMatchObject({ followers: 100, reelsRead: 1 });
    expect(second.scan).toMatchObject({ followers: 200, reelsRead: 2 });
    expect(instagram.listReels('c1').map((reel) => reel.shortcode)).toEqual(['LATER', 'EARLY']);
  });

  it('fails from the scan a fixture names on, and works before it', async () => {
    const fixtures: FakeInstagramFixtures = {
      flaky: {
        profile: [
          { id: '9', username: 'flaky', followersCount: 7, followsCount: 1, postsCount: 2 },
        ],
        reels: [],
        fails: 'failed',
        failsFrom: 2,
      },
    };
    const { scanner, add } = setup({ fixtures });
    add('c1', 'flaky');

    const first = await scanner.scan('c1', 'flaky');
    const second = await scanner.scan('c1', 'flaky');
    const third = await scanner.scan('c1', 'flaky');

    expect(first.outcome).toBe('ok');
    expect(second.outcome).toBe('failed');
    expect(third.outcome).toBe('failed');
  });

  it('serves the picture of the account whose link the profile names', async () => {
    const link = 'https://scontent.cdninstagram.com/mine.jpg';
    const fixtures: FakeInstagramFixtures = {
      mine: {
        profile: [
          {
            id: '9',
            username: 'mine',
            followersCount: 7,
            followsCount: 1,
            postsCount: 2,
            profilePicUrlHD: link,
          },
        ],
        reels: [],
        photo: new TextEncoder().encode('ITS-OWN'),
      },
    };
    const { scanner, dataDir, add } = setup({ fixtures, photo: new TextEncoder().encode('OTHER') });
    add('c1', 'mine');

    await scanner.scan('c1', 'mine');

    expect(readFileSync(instagramPhotoFor(dataDir, 'c1'), 'utf8')).toBe('ITS-OWN');
  });

  it('numbers its runs across scans', async () => {
    const { scanner, add } = setup();
    add('c1', 'natgeo');

    const one = await scanner.scan('c1', 'natgeo');
    const two = await scanner.scan('c1', 'natgeo');

    expect(one.scan.apifyRunIds).toEqual(['fake-run-1', 'fake-run-2']);
    expect(two.scan.apifyRunIds).toEqual(['fake-run-3', 'fake-run-4']);
    expect(two.outcome).toBe('ok');
  });

  it('says whether a client is being scanned, and can be stopped while it waits', async () => {
    const { scanner, instagram, add } = setup({ delayMs: 10_000 });
    add('c1', 'natgeo');
    const controller = new AbortController();

    const running = scanner.scan('c1', 'natgeo', { signal: controller.signal });
    expect(scanner.isScanning('c1')).toBe(true);
    expect(scanner.isScanning('c2')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await running;

    expect(result).toMatchObject({ outcome: 'failed', cancelled: true });
    expect(scanner.isScanning('c1')).toBe(false);
    expect(instagram.listReels('c1')).toEqual([]);
  });
});
