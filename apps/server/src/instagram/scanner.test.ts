import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instagramPhotoFor, instagramPhotosDirFor } from '../clients/paths.js';
import type { StudioDb } from '../db/database.js';
import { InstagramRepository } from '../db/instagram-repository.js';
import { fakeClock, memoryDb } from '../db/test-utils.js';
import { makeTempDir } from '../test-temp.js';
import {
  ApifyError,
  type FetchLike,
  PROFILE_ACTOR,
  REEL_ACTOR,
  type RunActorOptions,
} from './apify.js';
import {
  type ActorRunner,
  createInstagramScanner,
  FIRST_SCAN_DAYS,
  type InstagramScanner,
  mapReel,
  ORIGINAL_AUDIO,
  PHOTO_MAX_BYTES,
  PHOTO_TRIES,
  PROFILE_MAX_CHARGE_USD,
  REELS_LIMIT,
  REELS_MAX_CHARGE_USD,
  readProfile,
  readReels,
  SCAN_DAYS,
  SCAN_MESSAGES,
  sharesOf,
  soundOf,
} from './scanner.js';

// The scanner over a real (in-memory) database and a temp data folder, with Apify answered from
// the real fixtures of IG2 (testdata/) and the picture from a fake fetch: no network. A few tests
// go through the real client (`runActor`) with a scripted fetch to check the glue.

const TESTDATA = fileURLToPath(new URL('./testdata/', import.meta.url));
const fixture = (name: string): unknown[] =>
  JSON.parse(readFileSync(join(TESTDATA, `${name}.json`), 'utf8')) as unknown[];

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const CLIENT = 'c-natgeo';
const HANDLE = 'natgeo';
const PICTURE_URL =
  'https://scontent-nrt1-1.cdninstagram.com/v/t51.82787-19/683576066_18653628823019133_9051036240972105113_n.jpg';

type Reply = { items: unknown[]; costUsd?: number | null; runId?: string } | { throws: unknown };

/** The two actors, answered in turn from a script, with every call recorded. */
class FakeActors {
  readonly calls: { actorId: string; input: Record<string, unknown>; options: RunActorOptions }[] =
    [];
  profile: Reply = { items: fixture('profile'), costUsd: 0.0026, runId: 'run-profile' };
  reels: Reply = { items: fixture('reels'), costUsd: 0.0141, runId: 'run-reels' };
  /** Called at the start of each run; a test makes it wait, or change the world. */
  onRun: (actorId: string) => Promise<void> | void = () => undefined;

  readonly run: ActorRunner = async <T>(
    actorId: string,
    input: unknown,
    options: RunActorOptions = {},
  ) => {
    this.calls.push({ actorId, input: input as Record<string, unknown>, options });
    await this.onRun(actorId);
    const reply = actorId === PROFILE_ACTOR ? this.profile : this.reels;
    if ('throws' in reply) throw reply.throws;
    return {
      items: reply.items as T[],
      runId: reply.runId ?? `run-${this.calls.length}`,
      costUsd: reply.costUsd ?? null,
    };
  };

  actors(): string[] {
    return this.calls.map((call) => call.actorId);
  }

  reelCall() {
    const call = this.calls.find((entry) => entry.actorId === REEL_ACTOR);
    if (call === undefined) throw new Error('the reel scraper was not run');
    return call;
  }
}

interface PictureReply {
  status?: number;
  type?: string;
  bytes?: string;
  length?: number;
  breaks?: boolean;
}

/** What the picture's link answers (`once` first, in turn, then `reply`); every request is recorded. */
class FakePictures {
  readonly requests: { url: string; headers: Headers }[] = [];
  reply: PictureReply = {};
  once: PictureReply[] = [];

  readonly fetch: FetchLike = async (input, init) => {
    this.requests.push({ url: input, headers: new Headers(init?.headers) });
    const reply = this.once.shift() ?? this.reply;
    if (reply.breaks === true) throw new TypeError('fetch failed');
    const headers: Record<string, string> = {
      'content-type': reply.type ?? 'image/jpeg',
    };
    if (reply.length !== undefined) headers['content-length'] = String(reply.length);
    return new Response(reply.bytes ?? 'JPEG-BYTES-1', {
      status: reply.status ?? 200,
      headers,
    });
  };
}

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const instagram = new InstagramRepository(db, { clock });
  instagram.upsertAccount({ clientId: CLIENT, client: 'Nat Geo', handle: HANDLE });
  const dataDir = makeTempDir('studio-instagram-scan-');
  const actors = new FakeActors();
  const pictures = new FakePictures();
  const scanner: InstagramScanner = createInstagramScanner({
    instagram,
    dataDir,
    clock,
    runActor: actors.run,
    fetch: pictures.fetch,
    photoRetryGapMs: 0,
  });
  return { clock, db, instagram, dataDir, actors, pictures, scanner };
}

const at = (iso: string) => Date.parse(iso);

describe('what a scan writes', () => {
  it('writes the account, the reels and the scan from the real answers', async () => {
    const { scanner, instagram, dataDir, clock } = setup();

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({
      outcome: 'ok',
      error: null,
      cancelled: false,
      photoSaved: true,
    });
    expect(result.scan).toMatchObject({
      clientId: CLIENT,
      handle: HANDLE,
      outcome: 'ok',
      error: null,
      followers: 268240491,
      following: 195,
      posts: 32131,
      reelsRead: 5,
      costUsd: 0.0167,
      apifyRunIds: ['run-profile', 'run-reels'],
    });
    expect(result.scan.finishedAt).not.toBeNull();
    expect(instagram.getScan(result.scan.id)).toEqual(result.scan);

    expect(instagram.getAccount(CLIENT)).toEqual({
      clientId: CLIENT,
      client: 'Nat Geo',
      handle: HANDLE,
      instagramId: '787132',
      since: null,
      addedAt: expect.any(Number),
      fullName: 'National Geographic',
      biography: 'Step into wonder and find your inner explorer with National Geographic 🌎',
      private: false,
      photoSavedAt: clock().getTime(),
    });
    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(true);

    const reels = instagram.listReels(CLIENT);
    expect(reels.map((reel) => reel.shortcode)).toEqual([
      'DfHwGxbBD_K',
      'DfFug8Azc0P',
      'DfBUU0nDswI',
      'DfAWxdIFmVB',
      'DfAPW81goOP',
    ]);
    expect(instagram.getReel('DfAPW81goOP')).toEqual({
      shortcode: 'DfAPW81goOP',
      clientId: CLIENT,
      url: 'https://www.instagram.com/p/DfAPW81goOP/',
      postedAt: at('2026-10-27T16:04:16.000Z'),
      caption: (fixture('reels')[0] as { caption: string }).caption,
      durationSec: 82.47467,
      plays: 1163853,
      likes: 47924,
      comments: 192,
      shares: null,
      sound: ORIGINAL_AUDIO,
      coauthors: [],
      hashtags: ['NatGeoQueens'],
      pinned: false,
      paidPartnership: false,
      firstScanId: result.scan.id,
      lastScanId: result.scan.id,
      jobId: null,
      linkedAt: null,
    });
  });

  it('keeps the collab reel another account owns, with who it was made with', async () => {
    const { scanner, instagram } = setup();

    await scanner.scan(CLIENT, HANDLE);

    // Owned by natgeoscience, the client is a co-author: the others, not the client.
    expect(instagram.getReel('DfBUU0nDswI')).toMatchObject({
      clientId: CLIENT,
      plays: 947042,
      coauthors: ['natgeoscience', 'startalk', 'natgeobooks'],
    });
    expect(instagram.getReel('DfFug8Azc0P')?.coauthors).toEqual(['disneystudios', 'natgeodocs']);
    expect(instagram.getReel('DfAWxdIFmVB')?.coauthors).toEqual([
      'chaivasarhelyi',
      'jimwmorrison',
      'jimmychin',
      'disneystudios',
    ]);
    // coauthorProducers is missing on these two.
    expect(instagram.getReel('DfAPW81goOP')?.coauthors).toEqual([]);
    expect(instagram.getReel('DfHwGxbBD_K')?.coauthors).toEqual([]);
  });

  it('writes one read per reel and a second scan adds its own', async () => {
    const { scanner, instagram, actors, clock } = setup();
    const first = await scanner.scan(CLIENT, HANDLE);
    const firstReads = instagram.readsOfScans(first.scan.id, first.scan.id);
    expect(firstReads).toHaveLength(5);
    expect(firstReads).toContainEqual({
      shortcode: 'DfAPW81goOP',
      scanId: first.scan.id,
      plays: 1163853,
      likes: 47924,
      comments: 192,
      shares: null,
    });

    clock.tick(7 * 24 * 60 * 60 * 1000);
    const reels = structuredClone(fixture('reels')) as Record<string, unknown>[];
    for (const item of reels) {
      item.videoPlayCount = (item.videoPlayCount as number) + 1000;
      item.sharesCount = 25;
    }
    actors.reels = { items: reels, costUsd: 0.05, runId: 'run-reels-2' };
    const second = await scanner.scan(CLIENT, HANDLE);

    const reads = instagram.readsOfScans(first.scan.id, second.scan.id);
    expect(reads).toHaveLength(10);
    expect(reads.filter((read) => read.shortcode === 'DfAPW81goOP')).toEqual([
      expect.objectContaining({ scanId: first.scan.id, plays: 1163853, shares: null }),
      expect.objectContaining({ scanId: second.scan.id, plays: 1164853, shares: 25 }),
    ]);
    // The reel takes the new numbers; where it was first seen stays.
    expect(instagram.getReel('DfAPW81goOP')).toMatchObject({
      plays: 1164853,
      shares: 25,
      firstScanId: first.scan.id,
      lastScanId: second.scan.id,
    });
  });

  it('keeps the shares a reel had when a scan cannot read them', async () => {
    const { scanner, instagram, actors } = setup();
    const withShares = structuredClone(fixture('reels')) as Record<string, unknown>[];
    for (const item of withShares) item.sharesCount = 40;
    actors.reels = { items: withShares, costUsd: 0.1 };
    await scanner.scan(CLIENT, HANDLE);

    actors.reels = { items: fixture('reels'), costUsd: 0.01 };
    const second = await scanner.scan(CLIENT, HANDLE);

    expect(second.outcome).toBe('ok');
    expect(instagram.getReel('DfAPW81goOP')?.shares).toBe(40);
    // The read says what that scan could read.
    expect(instagram.readsOfScans(second.scan.id, second.scan.id)[0]?.shares).toBeNull();
  });

  it('is ok with no reel in the window, and ends the row with 0 reels read', async () => {
    const { scanner, instagram, actors } = setup();
    actors.reels = { items: [], costUsd: 0.001 };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.outcome).toBe('ok');
    expect(result.scan).toMatchObject({ reelsRead: 0, followers: 268240491 });
    expect(instagram.listReels(CLIENT)).toEqual([]);
    expect(instagram.getAccount(CLIENT)?.fullName).toBe('National Geographic');
  });

  it('turns a private account back to public when the profile says so', async () => {
    const { scanner, instagram } = setup();
    instagram.upsertAccount({ clientId: CLIENT, client: 'Nat Geo', handle: HANDLE, private: true });

    await scanner.scan(CLIENT, HANDLE);

    expect(instagram.getAccount(CLIENT)?.private).toBe(false);
  });

  it('leaves what is not a reel out and takes the later of a repeated shortcode', async () => {
    const { scanner, instagram, actors } = setup();
    const [one] = fixture('reels') as Record<string, unknown>[];
    actors.reels = {
      items: [
        { ...one, videoPlayCount: 1 },
        { ...one, videoPlayCount: 2 },
        { id: 'x', type: 'Video' },
        { ...one, shortCode: 'has space', url: 'https://www.instagram.com/p/has/' },
        { ...one, shortCode: 'DfBad', timestamp: 'yesterday' },
        'a string',
        null,
      ],
      costUsd: 0.01,
    };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.scan.reelsRead).toBe(1);
    expect(instagram.listReels(CLIENT).map((reel) => [reel.shortcode, reel.plays])).toEqual([
      ['DfAPW81goOP', 2],
    ]);
  });
});

describe('mapping a reel', () => {
  const item = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    shortCode: 'AbC_-1',
    url: 'https://www.instagram.com/reel/AbC_-1/',
    timestamp: '2026-10-20T10:00:00.000Z',
    videoPlayCount: 1000,
    likesCount: 100,
    commentsCount: 10,
    ownerUsername: HANDLE,
    ...extra,
  });
  const map = (extra: Record<string, unknown> = {}) => mapReel(item(extra), CLIENT, HANDLE);

  it('reads the plays from videoPlayCount, else videoViewCount, else 0', () => {
    expect(map()?.plays).toBe(1000);
    expect(map({ videoPlayCount: null, videoViewCount: 777 })?.plays).toBe(777);
    expect(map({ videoPlayCount: 5, videoViewCount: 777 })?.plays).toBe(5);
    expect(map({ videoPlayCount: null, videoViewCount: null })?.plays).toBe(0);
    expect(map({ videoPlayCount: undefined })?.plays).toBe(0);
  });

  it('turns a hidden like count (-1) and a missing number into 0', () => {
    expect(map({ likesCount: -1, commentsCount: undefined })).toMatchObject({
      likes: 0,
      comments: 0,
    });
  });

  it('reads the shares from sharesCount, else any numeric key with "share" in it, else null', () => {
    expect(sharesOf({ sharesCount: 12 })).toBe(12);
    expect(sharesOf({ sharesCount: 0 })).toBe(0);
    expect(sharesOf({ videoShareCount: 7 })).toBe(7);
    expect(sharesOf({ reshareCount: 3, likesCount: 9 })).toBe(3);
    // sharesCount wins over another share key.
    expect(sharesOf({ reshareCount: 3, sharesCount: 8 })).toBe(8);
    // Nothing, a null, a hidden number, or a share key that is no number: unknown.
    expect(sharesOf({ likesCount: 9 })).toBeNull();
    expect(sharesOf({ sharesCount: null })).toBeNull();
    expect(sharesOf({ sharesCount: -1 })).toBeNull();
    expect(sharesOf({ isSharedToFeed: true, shareLabel: 'x' })).toBeNull();
    expect(map({ sharesCount: 12 })?.shares).toBe(12);
    expect(map()?.shares).toBeNull();
  });

  it('names the sound: Original audio, or the song and its artist', () => {
    expect(soundOf({ uses_original_audio: true, song_name: 'Original audio' })).toBe(
      ORIGINAL_AUDIO,
    );
    expect(soundOf({ uses_original_audio: true, song_name: 'Anything', artist_name: 'x' })).toBe(
      ORIGINAL_AUDIO,
    );
    expect(soundOf({ uses_original_audio: false, song_name: 'original AUDIO' })).toBe(
      ORIGINAL_AUDIO,
    );
    expect(
      soundOf({
        uses_original_audio: false,
        song_name: 'Sarà perché ti amo',
        artist_name: 'Ricchi e Poveri',
      }),
    ).toBe('Sarà perché ti amo · Ricchi e Poveri');
    expect(soundOf({ uses_original_audio: false, song_name: 'Just a name', artist_name: '' })).toBe(
      'Just a name',
    );
    expect(soundOf({ uses_original_audio: false, artist_name: 'No song' })).toBeNull();
    expect(soundOf({})).toBeNull();
    expect(soundOf(null)).toBeNull();
    expect(map({ musicInfo: { song_name: 'Song', artist_name: 'Band' } })?.sound).toBe(
      'Song · Band',
    );
  });

  it('treats a missing coauthorProducers as none, and drops the client and repeats', () => {
    expect(map()?.coauthors).toEqual([]);
    expect(map({ coauthorProducers: [] })?.coauthors).toEqual([]);
    expect(
      map({
        ownerUsername: 'Other',
        coauthorProducers: [
          { username: 'NatGeo' },
          { username: 'friend' },
          { username: 'other' },
          { username: 'friend' },
          { id: 'no username' },
          'junk',
        ],
      })?.coauthors,
    ).toEqual(['Other', 'friend']);
  });

  it('keeps the caption, length, hashtags, pinned and paid partnership', () => {
    expect(
      map({
        caption: 'Hi #a',
        videoDuration: 12.5,
        hashtags: ['a', '', 7, 'b'],
        isPinned: true,
        paidPartnership: true,
      }),
    ).toMatchObject({
      caption: 'Hi #a',
      durationSec: 12.5,
      hashtags: ['a', 'b'],
      pinned: true,
      paidPartnership: true,
    });
    expect(map({ caption: undefined, videoDuration: null })).toMatchObject({
      caption: null,
      durationSec: null,
      hashtags: [],
      pinned: false,
      paidPartnership: false,
    });
    expect(map({ url: undefined })?.url).toBe('https://www.instagram.com/reel/AbC_-1/');
  });

  it('skips an item with no usable shortcode or time', () => {
    expect(map({ shortCode: undefined })).toBeNull();
    expect(map({ shortCode: 'a/b' })).toBeNull();
    expect(map({ timestamp: 'soon' })).toBeNull();
    expect(map({ timestamp: undefined })).toBeNull();
  });

  it('reads the profile and refuses an answer that is no profile', () => {
    expect(readProfile(fixture('profile'), HANDLE)).toEqual({
      instagramId: '787132',
      fullName: 'National Geographic',
      biography: 'Step into wonder and find your inner explorer with National Geographic 🌎',
      followers: 268240491,
      following: 195,
      posts: 32131,
      private: false,
      pictureUrl: PICTURE_URL,
    });
    expect(() => readProfile([], HANDLE)).toThrow(/answered nothing/);
    expect(() => readProfile([{ username: HANDLE, id: '1' }], HANDLE)).toThrow(/no follower count/);
    expect(readReels([], CLIENT, HANDLE)).toEqual([]);
    expect(readReels([{ error: 'no_items', errorDescription: 'Empty' }], CLIENT, HANDLE)).toEqual(
      [],
    );
  });
});

describe('how a scan ends', () => {
  it('ends private for a private account: no reels are read, the account says so', async () => {
    const { scanner, instagram, actors, dataDir } = setup();
    instagram.upsertAccount({
      clientId: 'c-private',
      client: 'Private Creator',
      handle: 'example_private_creator',
    });
    actors.profile = { items: fixture('profile-private'), costUsd: 0.0026, runId: 'run-p' };

    const result = await scanner.scan('c-private', 'example_private_creator');

    expect(result).toMatchObject({
      outcome: 'private',
      error: "@example_private_creator is a private account, so its reels can't be read",
    });
    expect(actors.actors()).toEqual([PROFILE_ACTOR]);
    expect(result.scan).toMatchObject({
      outcome: 'private',
      followers: null,
      following: null,
      posts: null,
      reelsRead: 0,
      costUsd: 0.0026,
      apifyRunIds: ['run-p'],
    });
    expect(instagram.getAccount('c-private')).toMatchObject({
      private: true,
      fullName: 'Example Private Creator',
      instagramId: '1000000001',
      photoSavedAt: expect.any(Number),
    });
    expect(existsSync(instagramPhotoFor(dataDir, 'c-private'))).toBe(true);
    expect(instagram.listReels('c-private')).toEqual([]);
  });

  it('ends not-found when the profile run answers the not-found item, and reads no reels', async () => {
    const { scanner, instagram, actors, dataDir } = setup();
    actors.profile = { items: fixture('profile-not-found'), costUsd: 0.0026, runId: 'run-p' };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({
      outcome: 'not-found',
      error: '@natgeo was not found on Instagram',
      cancelled: false,
      photoSaved: false,
    });
    expect(actors.actors()).toEqual([PROFILE_ACTOR]);
    expect(result.scan).toMatchObject({ followers: null, reelsRead: 0, costUsd: 0.0026 });
    expect(instagram.getAccount(CLIENT)).toMatchObject({ fullName: null, photoSavedAt: null });
    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(false);
  });

  it('ends not-found when the reel run answers the not-found item', async () => {
    const { scanner, instagram, actors, dataDir } = setup();
    actors.reels = { items: fixture('reels-not-found'), costUsd: 0.0036, runId: 'run-r' };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.outcome).toBe('not-found');
    expect(result.scan).toMatchObject({
      followers: null,
      reelsRead: 0,
      costUsd: 0.0062,
      apifyRunIds: ['run-profile', 'run-r'],
    });
    // Nothing of the profile is written either: the scan did not finish.
    expect(instagram.getAccount(CLIENT)).toMatchObject({ fullName: null, photoSavedAt: null });
    expect(instagram.listReels(CLIENT)).toEqual([]);
    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(false);
  });

  it('ends ok with no reels when the account has none (the reel run answers no_items)', async () => {
    const { scanner, instagram, actors } = setup();
    actors.reels = {
      items: [
        {
          url: `https://www.instagram.com/${HANDLE}`,
          error: 'no_items',
          errorDescription: 'Empty or private data for provided input',
        },
      ],
      costUsd: 0.0036,
      runId: 'run-r',
    };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'ok', error: null });
    expect(result.scan).toMatchObject({ followers: 268240491, reelsRead: 0 });
    // The profile is kept: name, followers and photo, with no reels to list.
    expect(instagram.getAccount(CLIENT)?.fullName).not.toBeNull();
    expect(instagram.listReels(CLIENT)).toEqual([]);
  });

  it('keeps real reels when an error item comes with them', async () => {
    const { scanner, instagram, actors } = setup();
    actors.reels = {
      items: [...fixture('reels'), { username: HANDLE, error: 'not_found' }],
      costUsd: 0.01,
    };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.outcome).toBe('ok');
    expect(instagram.listReels(CLIENT)).toHaveLength(5);
  });

  it('ends no-token when there is no key, with the client’s own words', async () => {
    const { scanner, actors } = setup();
    const message = 'There is no Apify key: add APIFY_TOKEN to .env';
    actors.profile = { throws: new ApifyError('no-token', message) };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'no-token', error: message, cancelled: false });
    expect(result.scan).toMatchObject({ costUsd: 0, apifyRunIds: [], followers: null });
    expect(actors.actors()).toEqual([PROFILE_ACTOR]);
  });

  it('ends no-credit, and counts what the refused run cost', async () => {
    const { scanner, actors } = setup();
    actors.reels = {
      throws: new ApifyError('no-credit', 'Apify refuses the run for usage (HTTP 402)', {
        runId: 'run-r',
        costUsd: 0.002,
      }),
    };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.outcome).toBe('no-credit');
    expect(result.error).toContain('HTTP 402');
    expect(result.scan).toMatchObject({
      costUsd: 0.0046,
      apifyRunIds: ['run-profile', 'run-r'],
    });
  });

  it('counts a timeout as failed, with "Instagram didn\'t answer"', async () => {
    const { scanner, actors } = setup();
    actors.reels = {
      throws: new ApifyError('timeout', 'The Apify run took longer than 600 s and was stopped', {
        runId: 'run-r',
        costUsd: 0.2,
      }),
    };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'failed', error: "Instagram didn't answer" });
    expect(result.error).toBe(SCAN_MESSAGES.noAnswer);
    expect(result.scan).toMatchObject({ costUsd: 0.2026, apifyRunIds: ['run-profile', 'run-r'] });
  });

  it('ends failed with the reason of any other Apify error', async () => {
    const { scanner, actors } = setup();
    actors.profile = { throws: new ApifyError('failed', 'Apify answered 500: boom') };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'failed', error: 'Apify answered 500: boom' });
  });

  it("ends failed with Instagram's own reason when an item says one", async () => {
    const { scanner, actors } = setup();
    actors.profile = {
      items: [{ username: HANDLE, error: 'rate_limited', errorDescription: 'Too many requests' }],
      costUsd: 0.0026,
    };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({
      outcome: 'failed',
      error: 'Instagram said: Too many requests',
    });
  });

  it('ends failed for a profile with no items or no follower count', async () => {
    const { scanner, actors } = setup();
    actors.profile = { items: [], costUsd: 0 };
    expect(await scanner.scan(CLIENT, HANDLE)).toMatchObject({
      outcome: 'failed',
      error: 'Instagram answered nothing for @natgeo',
    });

    actors.profile = { items: [{ username: HANDLE, id: '1' }], costUsd: 0.0026 };
    expect(await scanner.scan(CLIENT, HANDLE)).toMatchObject({
      outcome: 'failed',
      error: "Instagram's answer for @natgeo had no follower count",
    });
  });

  it('ends failed with the message of an error that is not Apify’s', async () => {
    const { scanner, actors } = setup();
    actors.profile = { throws: new TypeError('something broke\n  inside') };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'failed', error: 'something broke inside' });
  });

  it('adds the cost of both runs and lists their ids', async () => {
    const { scanner, actors } = setup();
    actors.profile = { items: fixture('profile'), costUsd: 0.0026, runId: 'p1' };
    actors.reels = { items: fixture('reels'), costUsd: 0.0141, runId: 'r1' };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.scan.costUsd).toBe(0.0167);
    expect(result.scan.apifyRunIds).toEqual(['p1', 'r1']);
  });

  it('counts a run whose cost Apify did not say as 0', async () => {
    const { scanner, actors } = setup();
    actors.profile = { items: fixture('profile'), costUsd: null, runId: 'p1' };
    actors.reels = { items: fixture('reels'), costUsd: 0.5, runId: 'r1' };

    expect((await scanner.scan(CLIENT, HANDLE)).scan.costUsd).toBe(0.5);
  });
});

describe('how far back a scan reads', () => {
  const days = (actors: FakeActors) => actors.reelCall().input.onlyPostsNewerThan;

  it('asks for 28 days with the shares add-on on, 60 reels and a cap on the cost', async () => {
    const { scanner, actors } = setup();

    await scanner.scan(CLIENT, HANDLE, { first: false });

    expect(actors.calls[0]).toMatchObject({
      actorId: PROFILE_ACTOR,
      input: { usernames: [HANDLE] },
      options: { maxChargeUsd: PROFILE_MAX_CHARGE_USD },
    });
    expect(actors.reelCall()).toMatchObject({
      input: {
        username: [HANDLE],
        resultsLimit: REELS_LIMIT,
        onlyPostsNewerThan: `${SCAN_DAYS} days`,
        includeSharesCount: true,
        includeTranscript: false,
        includeDownloadedVideo: false,
      },
      options: { maxChargeUsd: REELS_MAX_CHARGE_USD },
    });
    expect(REELS_LIMIT).toBe(60);
    expect(SCAN_DAYS).toBe(28);
  });

  it('reads 90 days on the first scan, then 28', async () => {
    const { scanner, actors } = setup();

    await scanner.scan(CLIENT, HANDLE);
    expect(days(actors)).toBe(`${FIRST_SCAN_DAYS} days`);
    expect(FIRST_SCAN_DAYS).toBe(90);

    actors.calls.length = 0;
    await scanner.scan(CLIENT, HANDLE);
    expect(days(actors)).toBe('28 days');
  });

  it('reads 90 days again for a new handle, and when the caller says it is the first', async () => {
    const { scanner, actors, instagram } = setup();
    await scanner.scan(CLIENT, HANDLE);

    actors.calls.length = 0;
    instagram.upsertAccount({ clientId: CLIENT, client: 'Nat Geo', handle: 'natgeo.new' });
    await scanner.scan(CLIENT, 'NatGeo.New');
    expect(days(actors)).toBe('90 days');
    expect(actors.calls[0]?.input).toEqual({ usernames: ['natgeo.new'] });

    actors.calls.length = 0;
    await scanner.scan(CLIENT, 'natgeo.new', { first: true });
    expect(days(actors)).toBe('90 days');

    actors.calls.length = 0;
    await scanner.scan(CLIENT, 'natgeo.new', { first: false });
    expect(days(actors)).toBe('28 days');
  });

  it('does not count a scan that failed as the first one done', async () => {
    const { scanner, actors } = setup();
    actors.profile = { items: fixture('profile-not-found'), costUsd: 0.0026 };
    await scanner.scan(CLIENT, HANDLE);

    actors.profile = { items: fixture('profile'), costUsd: 0.0026 };
    actors.calls.length = 0;
    await scanner.scan(CLIENT, HANDLE);

    expect(days(actors)).toBe('90 days');
  });
});

describe('a scan that fails', () => {
  it('changes no reel and keeps the last numbers', async () => {
    const { scanner, instagram, actors, clock } = setup();
    const good = await scanner.scan(CLIENT, HANDLE);
    const reelsBefore = instagram.listReels(CLIENT);
    const accountBefore = instagram.getAccount(CLIENT);
    const readsBefore = instagram.readsOfScans(good.scan.id, good.scan.id);

    clock.tick(7 * 24 * 60 * 60 * 1000);
    const changed = structuredClone(fixture('profile')) as Record<string, unknown>[];
    for (const item of changed) item.followersCount = 1;
    actors.profile = { items: changed, costUsd: 0.0026, runId: 'p2' };
    actors.reels = {
      throws: new ApifyError('failed', 'Apify answered 500: boom', { runId: 'r2', costUsd: 0.01 }),
    };
    const bad = await scanner.scan(CLIENT, HANDLE);

    expect(bad.outcome).toBe('failed');
    expect(bad.scan).toMatchObject({
      followers: null,
      reelsRead: 0,
      costUsd: 0.0126,
      apifyRunIds: ['p2', 'r2'],
    });
    expect(instagram.listReels(CLIENT)).toEqual(reelsBefore);
    expect(instagram.getAccount(CLIENT)).toEqual(accountBefore);
    expect(instagram.readsOfScans(good.scan.id, bad.scan.id)).toEqual(readsBefore);
    expect(instagram.latestOkScan(CLIENT)).toEqual(good.scan);
    expect(instagram.latestScan(CLIENT)).toEqual(bad.scan);
  });

  it('changes nothing when the write itself breaks half way, and still ends the scan row', async () => {
    const { scanner, instagram } = setup();
    vi.spyOn(instagram, 'addReelReads').mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'failed', error: 'disk full', photoSaved: false });
    // The reels and the account were written before the reads broke: all of it is rolled back.
    expect(instagram.listReels(CLIENT)).toEqual([]);
    expect(instagram.getAccount(CLIENT)).toMatchObject({ fullName: null, photoSavedAt: null });
    expect(result.scan).toMatchObject({
      outcome: 'failed',
      followers: null,
      reelsRead: 0,
      costUsd: 0.0167,
      apifyRunIds: ['run-profile', 'run-reels'],
    });
    expect(result.scan.finishedAt).not.toBeNull();
  });

  it('ends cancelled, with no write, when the caller’s signal stops it during a run', async () => {
    const { scanner, instagram, actors } = setup();
    actors.reels = {
      throws: new ApifyError('failed', 'The Apify run was cancelled', {
        cancelled: true,
        runId: 'r1',
        costUsd: 0.003,
      }),
    };

    const result = await scanner.scan(CLIENT, HANDLE, { signal: new AbortController().signal });

    expect(result).toMatchObject({
      outcome: 'failed',
      error: SCAN_MESSAGES.stopped,
      cancelled: true,
    });
    expect(result.scan.costUsd).toBe(0.0056);
    expect(instagram.listReels(CLIENT)).toEqual([]);
    expect(instagram.getAccount(CLIENT)?.fullName).toBeNull();
  });

  it('drops what the runs read when the signal aborts after them', async () => {
    const { scanner, instagram, actors, dataDir } = setup();
    const controller = new AbortController();
    actors.onRun = (actorId) => {
      if (actorId === REEL_ACTOR) queueMicrotask(() => controller.abort());
    };

    const result = await scanner.scan(CLIENT, HANDLE, { signal: controller.signal });

    expect(result).toMatchObject({ outcome: 'failed', cancelled: true });
    expect(result.scan.costUsd).toBe(0.0167);
    expect(instagram.listReels(CLIENT)).toEqual([]);
    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(false);
  });

  it('hands the signal to every run', async () => {
    const { scanner, actors } = setup();
    const controller = new AbortController();

    await scanner.scan(CLIENT, HANDLE, { signal: controller.signal });

    expect(actors.calls.map((call) => call.options.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
  });
});

describe('the account a scan is of', () => {
  it('ends failed before it sends anything when the client has no account', async () => {
    const { scanner, instagram, actors } = setup();
    instagram.removeAccount(CLIENT);

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'failed', error: SCAN_MESSAGES.accountChanged });
    expect(actors.calls).toEqual([]);
    expect(result.scan).toMatchObject({ costUsd: 0, apifyRunIds: [] });
    expect(result.scan.finishedAt).not.toBeNull();
  });

  it('writes no reel when the handle was changed while the scan ran, but counts the cost', async () => {
    const { scanner, instagram, actors, dataDir } = setup();
    actors.onRun = (actorId) => {
      if (actorId === REEL_ACTOR) {
        instagram.upsertAccount({ clientId: CLIENT, client: 'Nat Geo', handle: 'another' });
      }
    };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({
      outcome: 'failed',
      error: SCAN_MESSAGES.accountChanged,
      photoSaved: false,
    });
    expect(result.scan.costUsd).toBe(0.0167);
    expect(instagram.listReels(CLIENT)).toEqual([]);
    expect(instagram.getAccount(CLIENT)).toMatchObject({ handle: 'another', fullName: null });
    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(false);
  });

  it('writes no reel when the account was removed while the scan ran', async () => {
    const { scanner, instagram, actors } = setup();
    actors.onRun = (actorId) => {
      if (actorId === REEL_ACTOR) instagram.removeAccount(CLIENT);
    };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'failed', error: SCAN_MESSAGES.accountChanged });
    expect(instagram.listReels(CLIENT)).toEqual([]);
    expect(instagram.getAccount(CLIENT)).toBeNull();
  });

  it('keeps the account’s own folder name and its “working together since”', async () => {
    const { scanner, instagram } = setup();
    instagram.upsertAccount({
      clientId: CLIENT,
      client: 'Nat Geo (renamed)',
      handle: HANDLE,
      since: '2026-09-01',
    });

    await scanner.scan(CLIENT, HANDLE);

    expect(instagram.getAccount(CLIENT)).toMatchObject({
      client: 'Nat Geo (renamed)',
      since: '2026-09-01',
      fullName: 'National Geographic',
    });
  });
});

describe('the profile picture', () => {
  const photoDir = (dataDir: string) => instagramPhotosDirFor(dataDir);

  it('saves it as <data>/instagram/photos/<clientId>.jpg, with no temp file left, and says when', async () => {
    const { scanner, instagram, dataDir, pictures, clock } = setup();

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.photoSaved).toBe(true);
    expect(readFileSync(instagramPhotoFor(dataDir, CLIENT), 'utf8')).toBe('JPEG-BYTES-1');
    expect(readdirSync(photoDir(dataDir))).toEqual([`${CLIENT}.jpg`]);
    expect(instagram.getAccount(CLIENT)?.photoSavedAt).toBe(clock().getTime());
    expect(pictures.requests.map((request) => request.url)).toEqual([PICTURE_URL]);
  });

  it('replaces the old picture with the new one', async () => {
    const { scanner, dataDir, pictures, clock } = setup();
    await scanner.scan(CLIENT, HANDLE);

    clock.tick(60_000);
    pictures.reply = { bytes: 'JPEG-BYTES-2' };
    await scanner.scan(CLIENT, HANDLE);

    expect(readFileSync(instagramPhotoFor(dataDir, CLIENT), 'utf8')).toBe('JPEG-BYTES-2');
    expect(readdirSync(photoDir(dataDir))).toEqual([`${CLIENT}.jpg`]);
  });

  it.each([
    ['an error status', { status: 403 }],
    ['an answer that is no image', { type: 'text/html' }],
    ['an empty answer', { bytes: '' }],
    ['a picture that is too big', { length: PHOTO_MAX_BYTES + 1 }],
    ['a network that breaks', { breaks: true }],
  ] satisfies [string, PictureReply][])(
    'keeps the old picture, and the scan stays ok, after %s',
    async (_name, reply) => {
      const { scanner, instagram, dataDir, pictures, clock } = setup();
      await scanner.scan(CLIENT, HANDLE);
      const savedAt = instagram.getAccount(CLIENT)?.photoSavedAt;

      clock.tick(7 * 24 * 60 * 60 * 1000);
      pictures.reply = reply;
      const result = await scanner.scan(CLIENT, HANDLE);

      expect(result).toMatchObject({ outcome: 'ok', photoSaved: false });
      expect(readFileSync(instagramPhotoFor(dataDir, CLIENT), 'utf8')).toBe('JPEG-BYTES-1');
      expect(readdirSync(photoDir(dataDir))).toEqual([`${CLIENT}.jpg`]);
      expect(instagram.getAccount(CLIENT)?.photoSavedAt).toBe(savedAt);
      // The reels were still written.
      expect(result.scan.reelsRead).toBe(5);
    },
  );

  it('leaves the account without a photo when the first download fails', async () => {
    const { scanner, instagram, dataDir, pictures } = setup();
    pictures.reply = { status: 500 };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.outcome).toBe('ok');
    expect(instagram.getAccount(CLIENT)?.photoSavedAt).toBeNull();
    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(false);
    expect(pictures.requests).toHaveLength(PHOTO_TRIES);
  });

  it.each([
    ['a connection that breaks', { breaks: true }],
    ['a 5xx answer', { status: 503 }],
    ['a 429 answer', { status: 429 }],
  ] satisfies [string, PictureReply][])('tries again after %s', async (_name, reply) => {
    const { scanner, instagram, dataDir, pictures } = setup();
    pictures.once = [reply, reply];

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.photoSaved).toBe(true);
    expect(readFileSync(instagramPhotoFor(dataDir, CLIENT), 'utf8')).toBe('JPEG-BYTES-1');
    expect(instagram.getAccount(CLIENT)?.photoSavedAt).not.toBeNull();
    expect(pictures.requests.map((request) => request.url)).toEqual([
      PICTURE_URL,
      PICTURE_URL,
      PICTURE_URL,
    ]);
  });

  it('asks once for a link that is refused (4xx): its signature will not change', async () => {
    const { scanner, pictures } = setup();
    pictures.reply = { status: 403 };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.photoSaved).toBe(false);
    expect(pictures.requests).toHaveLength(1);
  });

  it('downloads a link on Meta’s fbcdn.net, the other host the profile scraper gives', async () => {
    const { scanner, actors, pictures, dataDir } = setup();
    const url = 'https://instagram.fmex1-4.fna.fbcdn.net/v/t51.82787-19/868957530_n.jpg';
    const [profile] = structuredClone(fixture('profile')) as Record<string, unknown>[];
    actors.profile = { items: [{ ...profile, profilePicUrlHD: url }], costUsd: 0.0026 };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.photoSaved).toBe(true);
    expect(pictures.requests.map((request) => request.url)).toEqual([url]);
    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(true);
  });

  it.each([
    ['a link that is not https', 'http://scontent.cdninstagram.com/a.jpg'],
    ['a host that is not Instagram’s', 'https://evil.example.org/a.jpg'],
    ['a host that only ends like Instagram’s', 'https://notcdninstagram.com/a.jpg'],
    ['a link that is no link', 'not a link'],
  ])('does not request %s', async (_name, url) => {
    const { scanner, actors, pictures, dataDir } = setup();
    const [profile] = structuredClone(fixture('profile')) as Record<string, unknown>[];
    actors.profile = { items: [{ ...profile, profilePicUrlHD: url }], costUsd: 0.0026 };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'ok', photoSaved: false });
    expect(pictures.requests).toEqual([]);
    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(false);
  });

  it('scans fine for a profile with no picture link', async () => {
    const { scanner, actors, pictures } = setup();
    const [profile] = structuredClone(fixture('profile')) as Record<string, unknown>[];
    actors.profile = { items: [{ ...profile, profilePicUrlHD: null }], costUsd: 0.0026 };

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'ok', photoSaved: false });
    expect(pictures.requests).toEqual([]);
  });

  it('does not save one for a scan that failed', async () => {
    const { scanner, actors, dataDir } = setup();
    actors.reels = { throws: new ApifyError('failed', 'boom') };

    await scanner.scan(CLIENT, HANDLE);

    expect(existsSync(instagramPhotoFor(dataDir, CLIENT))).toBe(false);
  });
});

describe('isScanning', () => {
  it('is true from the call until the result is in, for that client only', async () => {
    const { scanner } = setup();
    expect(scanner.isScanning(CLIENT)).toBe(false);

    const running = scanner.scan(CLIENT, HANDLE);
    expect(scanner.isScanning(CLIENT)).toBe(true);
    expect(scanner.isScanning('c-other')).toBe(false);

    await running;
    expect(scanner.isScanning(CLIENT)).toBe(false);
  });

  it('is false again after a scan that failed, and one that stopped', async () => {
    const { scanner, actors } = setup();
    actors.profile = { throws: new ApifyError('no-token', 'no key') };
    await scanner.scan(CLIENT, HANDLE);
    expect(scanner.isScanning(CLIENT)).toBe(false);

    actors.profile = {
      throws: new ApifyError('failed', 'cancelled', { cancelled: true }),
    };
    await scanner.scan(CLIENT, HANDLE);
    expect(scanner.isScanning(CLIENT)).toBe(false);
  });

  it('runs the scans of one client one after another', async () => {
    const { scanner, actors, instagram } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    actors.onRun = async (actorId) => {
      if (actorId === PROFILE_ACTOR && first) {
        first = false;
        await gate;
      }
    };

    const one = scanner.scan(CLIENT, HANDLE);
    const two = scanner.scan(CLIENT, HANDLE);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The second has not started: one run so far, one scan row.
    expect(actors.actors()).toEqual([PROFILE_ACTOR]);
    expect(instagram.latestScan(CLIENT)?.outcome).toBeNull();
    expect(scanner.isScanning(CLIENT)).toBe(true);

    release();
    const [a, b] = await Promise.all([one, two]);

    expect(actors.actors()).toEqual([PROFILE_ACTOR, REEL_ACTOR, PROFILE_ACTOR, REEL_ACTOR]);
    expect(b.scan.id).toBeGreaterThan(a.scan.id);
    expect([a.outcome, b.outcome]).toEqual(['ok', 'ok']);
    // The second one was not the first scan any more: 28 days.
    expect(actors.calls[3]?.input.onlyPostsNewerThan).toBe('28 days');
    expect(scanner.isScanning(CLIENT)).toBe(false);
  });

  it('does not hold one client’s scan behind another client’s', async () => {
    const { scanner, actors, instagram } = setup();
    instagram.upsertAccount({ clientId: 'c-two', client: 'Two', handle: 'two' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = true;
    actors.onRun = async () => {
      if (blocked) {
        blocked = false;
        await gate;
      }
    };

    const one = scanner.scan(CLIENT, HANDLE);
    const two = scanner.scan('c-two', 'two');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Both are running: the second client's first run was not held behind the first's.
    expect(actors.actors().length).toBeGreaterThanOrEqual(2);
    release();
    await Promise.all([one, two]);
  });
});

// --- the glue with the real client ------------------------------------------------------------------

describe('with the real Apify client', () => {
  const TOKEN = 'apify_api_TESTKEY0123456789';

  /** A tiny Apify: both actors, answered from the fixtures; the picture from the CDN. */
  function fakeApifyFetch() {
    const calls: { method: string; url: URL; headers: Headers; body: unknown }[] = [];
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      const call = {
        method: init?.method ?? 'GET',
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const route = `${call.method} ${url.host}${url.pathname}`;
      switch (route) {
        case 'POST api.apify.com/v2/acts/apify~instagram-profile-scraper/runs':
          return json({ data: { id: 'p1', status: 'READY', defaultDatasetId: 'dp' } }, 201);
        case 'POST api.apify.com/v2/acts/apify~instagram-reel-scraper/runs':
          return json({ data: { id: 'r1', status: 'READY', defaultDatasetId: 'dr' } }, 201);
        case 'GET api.apify.com/v2/actor-runs/p1':
          return json({
            data: { id: 'p1', status: 'SUCCEEDED', defaultDatasetId: 'dp', usageTotalUsd: 0.0026 },
          });
        case 'GET api.apify.com/v2/actor-runs/r1':
          return json({
            data: { id: 'r1', status: 'SUCCEEDED', defaultDatasetId: 'dr', usageTotalUsd: 0.0141 },
          });
        case 'GET api.apify.com/v2/datasets/dp/items':
          return json(fixture('profile'));
        case 'GET api.apify.com/v2/datasets/dr/items':
          return json(fixture('reels'));
        default:
          if (url.host.endsWith('cdninstagram.com')) {
            return new Response('REAL-PICTURE', {
              status: 200,
              headers: { 'content-type': 'image/jpeg' },
            });
          }
          throw new Error(`no answer for ${route}`);
      }
    };
    return { fetch, calls };
  }

  it('runs both actors, writes everything, and never sends the key to the picture host', async () => {
    const clock = fakeClock();
    const db = memoryDb();
    opened.push(db);
    const instagram = new InstagramRepository(db, { clock });
    instagram.upsertAccount({ clientId: CLIENT, client: 'Nat Geo', handle: HANDLE });
    const dataDir = makeTempDir('studio-instagram-real-');
    const apify = fakeApifyFetch();
    const scanner = createInstagramScanner({
      instagram,
      dataDir,
      clock,
      fetch: apify.fetch,
      token: TOKEN,
      pollGapMs: 0,
    });

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result.outcome).toBe('ok');
    expect(result.scan).toMatchObject({
      reelsRead: 5,
      costUsd: 0.0167,
      apifyRunIds: ['p1', 'r1'],
    });
    expect(instagram.listReels(CLIENT)).toHaveLength(5);
    expect(readFileSync(instagramPhotoFor(dataDir, CLIENT), 'utf8')).toBe('REAL-PICTURE');

    const starts = apify.calls.filter((call) => call.method === 'POST');
    expect(starts.map((call) => call.url.pathname)).toEqual([
      '/v2/acts/apify~instagram-profile-scraper/runs',
      '/v2/acts/apify~instagram-reel-scraper/runs',
    ]);
    expect(starts[0]?.body).toEqual({ usernames: [HANDLE] });
    expect(starts[1]?.body).toEqual({
      username: [HANDLE],
      resultsLimit: 60,
      onlyPostsNewerThan: '90 days',
      includeSharesCount: true,
      includeTranscript: false,
      includeDownloadedVideo: false,
    });
    expect(starts[0]?.url.searchParams.get('maxTotalChargeUsd')).toBe(
      String(PROFILE_MAX_CHARGE_USD),
    );
    expect(starts[1]?.url.searchParams.get('maxTotalChargeUsd')).toBe(String(REELS_MAX_CHARGE_USD));
    for (const call of starts) expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);

    const picture = apify.calls.filter((call) => call.url.host.endsWith('cdninstagram.com'));
    expect(picture).toHaveLength(1);
    expect(picture[0]?.headers.get('authorization')).toBeNull();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('ends no-token without sending anything when there is no key', async () => {
    const db = memoryDb();
    opened.push(db);
    const instagram = new InstagramRepository(db, { clock: fakeClock() });
    instagram.upsertAccount({ clientId: CLIENT, client: 'Nat Geo', handle: HANDLE });
    const apify = fakeApifyFetch();
    const scanner = createInstagramScanner({
      instagram,
      dataDir: makeTempDir('studio-instagram-nokey-'),
      fetch: apify.fetch,
      env: {},
      envFile: join(makeTempDir('studio-instagram-noenv-'), '.env'),
    });

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'no-token', cancelled: false });
    expect(result.error).toContain('APIFY_TOKEN');
    expect(apify.calls).toEqual([]);
  });

  it('ends failed with "Instagram didn’t answer" when a run goes over its time', async () => {
    const db = memoryDb();
    opened.push(db);
    const instagram = new InstagramRepository(db, { clock: fakeClock() });
    instagram.upsertAccount({ clientId: CLIENT, client: 'Nat Geo', handle: HANDLE });
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      if (init?.method === 'POST' && url.pathname.endsWith('/runs')) {
        return new Response(
          JSON.stringify({ data: { id: 'p1', status: 'RUNNING', defaultDatasetId: 'dp' } }),
          { status: 201 },
        );
      }
      if (url.pathname.endsWith('/abort')) return new Response('{}', { status: 200 });
      // The wait never finishes: the run is RUNNING for ever.
      return new Response(
        JSON.stringify({
          data: { id: 'p1', status: 'RUNNING', defaultDatasetId: 'dp', usageTotalUsd: 0.001 },
        }),
        { status: 200 },
      );
    };
    const scanner = createInstagramScanner({
      instagram,
      dataDir: makeTempDir('studio-instagram-slow-'),
      fetch,
      token: TOKEN,
      timeoutMs: 50,
      pollGapMs: 5,
    });

    const result = await scanner.scan(CLIENT, HANDLE);

    expect(result).toMatchObject({ outcome: 'failed', error: SCAN_MESSAGES.noAnswer });
    expect(result.scan).toMatchObject({ apifyRunIds: ['p1'], costUsd: 0.001 });
  });
});
