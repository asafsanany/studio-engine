import { afterEach, describe, expect, it } from 'vitest';
import { clientIdFor } from '../inbox/scan.js';
import type { StudioDb } from './database.js';
import { DeliveryRepository, type NewDelivery } from './delivery-repository.js';
import {
  handleOf,
  InstagramLinkError,
  type InstagramReelInput,
  InstagramRepository,
  InstagramScanNotFoundError,
} from './instagram-repository.js';
import { ClientRenameConflictError, JobRepository } from './job-repository.js';
import { fakeClock, idFor, makeScan, memoryDb } from './test-utils.js';

// The Instagram tables over a real (in-memory) database: the accounts, the scans, the reels and
// what each scan read of them.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const FALCON = 'c-falcon';

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  return { db, clock, instagram: new InstagramRepository(db, { clock }) };
}

function reel(shortcode: string, overrides: Partial<InstagramReelInput> = {}): InstagramReelInput {
  return {
    shortcode,
    clientId: FALCON,
    url: `https://www.instagram.com/reel/${shortcode}/`,
    postedAt: T0,
    plays: 1000,
    likes: 100,
    comments: 10,
    ...overrides,
  };
}

function rawCount(db: StudioDb, table: string): number {
  return (db.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
}

describe('accounts', () => {
  it('stores an account with its handle in lower case and no @, added now', () => {
    const { instagram, clock } = setup();

    const { account, outcome } = instagram.upsertAccount({
      clientId: FALCON,
      client: 'Falcon FPV',
      handle: ' @Falcon.FPV ',
    });

    expect(outcome).toBe('created');
    expect(account).toEqual({
      clientId: FALCON,
      client: 'Falcon FPV',
      handle: 'falcon.fpv',
      instagramId: null,
      since: null,
      addedAt: clock().getTime(),
      fullName: null,
      biography: null,
      private: false,
      photoSavedAt: null,
    });
    expect(instagram.getAccount(FALCON)).toEqual(account);
    expect(instagram.getAccount('nobody')).toBeNull();
  });

  it('changes what is given, keeps what is left out and clears with null', () => {
    const { instagram, clock } = setup();
    const first = instagram.upsertAccount({
      clientId: FALCON,
      client: 'Falcon FPV',
      handle: 'falcon.fpv',
      since: '2026-03-01',
      fullName: 'Falcon',
    }).account;
    clock.tick(60_000);

    const read = instagram.upsertAccount({
      clientId: FALCON,
      client: 'Falcon FPV',
      handle: 'falcon.fpv',
      instagramId: '1789',
      biography: 'FPV pilot',
      private: true,
      photoSavedAt: T0,
    });
    expect(read.outcome).toBe('updated');
    expect(read.account).toEqual({
      ...first,
      instagramId: '1789',
      biography: 'FPV pilot',
      private: true,
      photoSavedAt: T0,
    });

    const cleared = instagram.upsertAccount({
      clientId: FALCON,
      client: 'Falcon FPV',
      handle: 'falcon_fpv',
      since: null,
      fullName: null,
    });
    expect(cleared.outcome).toBe('updated');
    expect(cleared.account).toMatchObject({
      handle: 'falcon_fpv',
      since: null,
      fullName: null,
      instagramId: '1789',
      addedAt: first.addedAt,
    });
  });

  it('writes nothing when the account already says this', () => {
    const { instagram } = setup();
    instagram.upsertAccount({ clientId: FALCON, client: 'Falcon FPV', handle: 'falcon.fpv' });

    const again = instagram.upsertAccount({
      clientId: FALCON,
      client: 'Falcon FPV',
      handle: '@FALCON.fpv',
      addedAt: 5,
    });

    expect(again.outcome).toBe('unchanged');
    expect(again.account.addedAt).not.toBe(5);
  });

  it('lists the accounts, the one added first first', () => {
    const { instagram } = setup();
    instagram.upsertAccount({ clientId: 'b', client: 'B', handle: 'b', addedAt: 20 });
    instagram.upsertAccount({ clientId: 'a', client: 'A', handle: 'a', addedAt: 30 });
    instagram.upsertAccount({ clientId: 'c', client: 'C', handle: 'c', addedAt: 10 });

    expect(instagram.listAccounts().map((account) => account.clientId)).toEqual(['c', 'b', 'a']);
  });

  it('refuses a handle that is empty, a day that is not one, and a client without a name', () => {
    const { instagram } = setup();
    const base = { clientId: FALCON, client: 'Falcon FPV', handle: 'falcon.fpv' };

    expect(() => instagram.upsertAccount({ ...base, handle: ' @ ' })).toThrow();
    expect(() => instagram.upsertAccount({ ...base, handle: 'two words' })).toThrow();
    expect(() => instagram.upsertAccount({ ...base, since: '2026-02-30' })).toThrow();
    expect(() => instagram.upsertAccount({ ...base, since: '1 March' })).toThrow();
    expect(() => instagram.upsertAccount({ ...base, client: '' })).toThrow();
    expect(instagram.listAccounts()).toEqual([]);
  });

  it('spells a handle one way', () => {
    expect(handleOf('  @@Falcon.FPV ')).toBe('falcon.fpv');
    expect(handleOf('falcon')).toBe('falcon');
  });

  it('removes only the account: the scans, the reels and the links stay, and come back with it', () => {
    const { instagram } = setup();
    instagram.upsertAccount({ clientId: FALCON, client: 'Falcon FPV', handle: 'falcon.fpv' });
    const scan = instagram.startScan({ clientId: FALCON, handle: 'falcon.fpv' });
    instagram.finishScan(scan.id, { outcome: 'ok', followers: 900, reelsRead: 1 });
    instagram.upsertReels(scan.id, [reel('AAA')]);
    instagram.addReelReads(scan.id, [{ shortcode: 'AAA', plays: 1000, likes: 100, comments: 10 }]);
    instagram.linkReel('AAA', 'job-1');

    expect(instagram.removeAccount(FALCON)).toBe(true);

    expect(instagram.getAccount(FALCON)).toBeNull();
    expect(instagram.removeAccount(FALCON)).toBe(false);
    expect(instagram.latestOkScan(FALCON)).toMatchObject({ id: scan.id, followers: 900 });
    expect(instagram.getReel('AAA')).toMatchObject({ jobId: 'job-1' });
    expect(instagram.reelOfJob('job-1')?.shortcode).toBe('AAA');
    expect(instagram.readsOfScans(scan.id, scan.id)).toHaveLength(1);

    // The same account again: everything is where it was.
    instagram.upsertAccount({ clientId: FALCON, client: 'Falcon FPV', handle: 'falcon.fpv' });
    expect(instagram.listReels(FALCON).map((one) => one.shortcode)).toEqual(['AAA']);
    expect(instagram.reelOfJob('job-1')?.shortcode).toBe('AAA');
  });
});

describe('scans', () => {
  it('starts a scan with no outcome and finishes it with the outcome, the numbers and the cost', () => {
    const { instagram, clock } = setup();

    const started = instagram.startScan({ clientId: FALCON, handle: '@Falcon.FPV' });
    expect(started).toEqual({
      id: 1,
      clientId: FALCON,
      handle: 'falcon.fpv',
      startedAt: clock().getTime(),
      finishedAt: null,
      outcome: null,
      error: null,
      followers: null,
      following: null,
      posts: null,
      reelsRead: 0,
      costUsd: 0,
      apifyRunIds: [],
    });

    clock.tick(90_000);
    const finished = instagram.finishScan(started.id, {
      outcome: 'ok',
      followers: 12_300,
      following: 410,
      posts: 87,
      reelsRead: 14,
      costUsd: 0.1234,
      apifyRunIds: ['run-a', 'run-b'],
    });

    expect(finished).toEqual({
      ...started,
      finishedAt: clock().getTime(),
      outcome: 'ok',
      followers: 12_300,
      following: 410,
      posts: 87,
      reelsRead: 14,
      costUsd: 0.1234,
      apifyRunIds: ['run-a', 'run-b'],
    });
    expect(instagram.getScan(started.id)).toEqual(finished);
    expect(instagram.getScan(99)).toBeNull();
  });

  it('records why a scan did not read anything', () => {
    const { instagram } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'falcon.fpv' });

    const failed = instagram.finishScan(scan.id, {
      outcome: 'no-credit',
      error: 'Apify says the month’s credit is used up.',
    });

    expect(failed).toMatchObject({
      outcome: 'no-credit',
      error: 'Apify says the month’s credit is used up.',
      followers: null,
      reelsRead: 0,
      costUsd: 0,
    });
  });

  it('refuses to finish a scan that does not exist, or with an outcome it does not know', () => {
    const { instagram } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'falcon.fpv' });

    expect(() => instagram.finishScan(42, { outcome: 'ok' })).toThrow(InstagramScanNotFoundError);
    // @ts-expect-error not an outcome
    expect(() => instagram.finishScan(scan.id, { outcome: 'blocked' })).toThrow();
    expect(instagram.getScan(scan.id)?.outcome).toBeNull();
  });

  it('finds the latest scan of the client, and the latest that was ok', () => {
    const { instagram } = setup();
    const at = (n: number) => T0 + n * 7 * DAY;
    const one = instagram.startScan({ clientId: FALCON, handle: 'm', startedAt: at(0) });
    instagram.finishScan(one.id, { outcome: 'ok', followers: 100 });
    const two = instagram.startScan({ clientId: FALCON, handle: 'm', startedAt: at(1) });
    instagram.finishScan(two.id, { outcome: 'ok', followers: 120 });
    const three = instagram.startScan({ clientId: FALCON, handle: 'm', startedAt: at(2) });
    instagram.finishScan(three.id, { outcome: 'failed', error: 'Timed out' });
    const other = instagram.startScan({ clientId: 'other', handle: 'o', startedAt: at(3) });
    instagram.finishScan(other.id, { outcome: 'ok', followers: 5 });

    expect(instagram.latestScan(FALCON)?.id).toBe(three.id);
    expect(instagram.latestOkScan(FALCON)?.id).toBe(two.id);
    expect(instagram.latestScan('other')?.id).toBe(other.id);
    expect(instagram.latestScan('nobody')).toBeNull();
    expect(instagram.latestOkScan('nobody')).toBeNull();
  });

  it('counts a scan that is still running as the latest, not as an ok one', () => {
    const { instagram } = setup();
    const done = instagram.startScan({ clientId: FALCON, handle: 'm', startedAt: T0 });
    instagram.finishScan(done.id, { outcome: 'ok' });
    const running = instagram.startScan({ clientId: FALCON, handle: 'm', startedAt: T0 + DAY });

    expect(instagram.latestScan(FALCON)).toMatchObject({ id: running.id, outcome: null });
    expect(instagram.latestOkScan(FALCON)?.id).toBe(done.id);
    expect(instagram.listOkScans(FALCON).map((scan) => scan.id)).toEqual([done.id]);
  });

  it('lists the latest scans of a client, the newest first, finished or not, up to a limit', () => {
    const { instagram } = setup();
    const ids = [0, 7, 14, 21].map((days, index) => {
      const scan = instagram.startScan({
        clientId: FALCON,
        handle: 'm',
        startedAt: T0 + days * DAY,
      });
      // The last one is still running.
      if (index < 3) instagram.finishScan(scan.id, { outcome: index === 1 ? 'failed' : 'ok' });
      return scan.id;
    });
    const other = instagram.startScan({ clientId: 'other', handle: 'o', startedAt: T0 + 30 * DAY });

    expect(instagram.recentScans(FALCON).map((scan) => scan.id)).toEqual([...ids].reverse());
    expect(instagram.recentScans(FALCON)[0]).toMatchObject({ outcome: null, finishedAt: null });
    expect(instagram.recentScans(FALCON, 2).map((scan) => scan.id)).toEqual([ids[3], ids[2]]);
    expect(instagram.recentScans(FALCON, 0)).toHaveLength(1);
    expect(instagram.recentScans('other').map((scan) => scan.id)).toEqual([other.id]);
    expect(instagram.recentScans('nobody')).toEqual([]);
  });

  it('lists the ok scans of a client in a span, the oldest first', () => {
    const { instagram } = setup();
    const ids = [0, 7, 14, 21].map((days, index) => {
      const scan = instagram.startScan({
        clientId: FALCON,
        handle: 'm',
        startedAt: T0 + days * DAY,
      });
      instagram.finishScan(scan.id, { outcome: index === 2 ? 'private' : 'ok' });
      return scan.id;
    });
    const other = instagram.startScan({ clientId: 'other', handle: 'o', startedAt: T0 + 7 * DAY });
    instagram.finishScan(other.id, { outcome: 'ok' });

    const idsOf = (span?: { from?: number; to?: number }) =>
      instagram.listOkScans(FALCON, span).map((scan) => scan.id);

    expect(idsOf()).toEqual([ids[0], ids[1], ids[3]]);
    expect(idsOf({ from: T0 + 7 * DAY })).toEqual([ids[1], ids[3]]);
    // `to` is not in the span.
    expect(idsOf({ from: T0 + 7 * DAY, to: T0 + 21 * DAY })).toEqual([ids[1]]);
    expect(idsOf({ to: T0 + 7 * DAY })).toEqual([ids[0]]);
    expect(idsOf({ from: T0 + 30 * DAY })).toEqual([]);
  });
});

describe('reels', () => {
  it('stores the reels of a scan as the client’s own to begin with, first and last seen by it', () => {
    const { instagram } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'm' });

    const result = instagram.upsertReels(scan.id, [
      reel('AAA', {
        caption: 'First',
        durationSec: 12.5,
        shares: 7,
        sound: 'Original audio',
        coauthors: ['yael'],
        hashtags: ['fpv', 'drone'],
        pinned: true,
        paidPartnership: true,
      }),
      reel('BBB', { postedAt: T0 + DAY }),
    ]);

    expect(result).toEqual({ created: 2, updated: 0 });
    expect(instagram.getReel('AAA')).toEqual({
      shortcode: 'AAA',
      clientId: FALCON,
      url: 'https://www.instagram.com/reel/AAA/',
      postedAt: T0,
      caption: 'First',
      durationSec: 12.5,
      plays: 1000,
      likes: 100,
      comments: 10,
      shares: 7,
      sound: 'Original audio',
      coauthors: ['yael'],
      hashtags: ['fpv', 'drone'],
      pinned: true,
      paidPartnership: true,
      firstScanId: scan.id,
      lastScanId: scan.id,
      jobId: null,
      linkedAt: null,
    });
    expect(instagram.getReel('BBB')).toMatchObject({
      caption: null,
      durationSec: null,
      shares: null,
      sound: null,
      coauthors: [],
      hashtags: [],
      pinned: false,
      paidPartnership: false,
    });
    expect(instagram.getReel('missing')).toBeNull();
  });

  it('gives a reel it knows the new numbers and the new scan, and keeps its first scan and its job', () => {
    const { instagram } = setup();
    const first = instagram.startScan({ clientId: FALCON, handle: 'm' });
    instagram.upsertReels(first.id, [reel('AAA', { shares: 5, pinned: true })]);
    instagram.linkReel('AAA', 'job-1');
    const second = instagram.startScan({ clientId: FALCON, handle: 'm' });

    const result = instagram.upsertReels(second.id, [
      reel('AAA', { plays: 5000, likes: 400, comments: 30, shares: 20, pinned: false }),
      reel('CCC'),
    ]);

    expect(result).toEqual({ created: 1, updated: 1 });
    expect(instagram.getReel('AAA')).toMatchObject({
      plays: 5000,
      likes: 400,
      comments: 30,
      shares: 20,
      pinned: false,
      firstScanId: first.id,
      lastScanId: second.id,
      jobId: 'job-1',
    });
    expect(instagram.getReel('CCC')).toMatchObject({ firstScanId: second.id });
  });

  it('keeps the shares a reel had when a later scan could not read them', () => {
    const { instagram } = setup();
    const first = instagram.startScan({ clientId: FALCON, handle: 'm' });
    instagram.upsertReels(first.id, [reel('AAA', { shares: 5 })]);
    const second = instagram.startScan({ clientId: FALCON, handle: 'm' });

    instagram.upsertReels(second.id, [reel('AAA', { plays: 2000 })]);

    expect(instagram.getReel('AAA')).toMatchObject({ plays: 2000, shares: 5 });
  });

  it('does not take a reel from the client that has it', () => {
    const { instagram } = setup();
    const first = instagram.startScan({ clientId: FALCON, handle: 'm' });
    instagram.upsertReels(first.id, [reel('AAA')]);
    const other = instagram.startScan({ clientId: 'other', handle: 'o' });

    instagram.upsertReels(other.id, [reel('AAA', { clientId: 'other', plays: 9 })]);

    expect(instagram.getReel('AAA')).toMatchObject({ clientId: FALCON, plays: 9 });
  });

  it('stores nothing when one reel of the scan is not valid', () => {
    const { instagram, db } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'm' });

    expect(() =>
      instagram.upsertReels(scan.id, [reel('AAA'), reel('BBB', { plays: -1 })]),
    ).toThrow();
    expect(() => instagram.upsertReels(scan.id, [reel('has space')])).toThrow();

    expect(rawCount(db, 'instagram_reels')).toBe(0);
  });

  it('lists the client’s reels since a time, the newest first', () => {
    const { instagram } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'm' });
    instagram.upsertReels(scan.id, [
      reel('OLD', { postedAt: T0 - 100 * DAY }),
      reel('MID', { postedAt: T0 - 10 * DAY }),
      reel('NEW', { postedAt: T0 }),
      reel('THEIRS', { clientId: 'other', postedAt: T0 }),
    ]);

    const shortcodes = (since?: number) =>
      instagram.listReels(FALCON, since).map((one) => one.shortcode);

    expect(shortcodes()).toEqual(['NEW', 'MID', 'OLD']);
    expect(shortcodes(T0 - 90 * DAY)).toEqual(['NEW', 'MID']);
    // A reel posted at the time is in.
    expect(shortcodes(T0)).toEqual(['NEW']);
    expect(shortcodes(T0 + 1)).toEqual([]);
    expect(instagram.listReels('other').map((one) => one.shortcode)).toEqual(['THEIRS']);
  });

  it('lists a collab reel on both pages: its owner’s, and that of the client whose scan read it too', () => {
    const { instagram } = setup();
    const falconScan = instagram.startScan({ clientId: FALCON, handle: 'm' });
    instagram.upsertReels(falconScan.id, [reel('COLLAB'), reel('FALCONS', { postedAt: T0 - DAY })]);
    instagram.addReelReads(falconScan.id, [
      { shortcode: 'COLLAB', plays: 1000, likes: 100, comments: 10 },
      { shortcode: 'FALCONS', plays: 1000, likes: 100, comments: 10 },
    ]);
    // The studio's own account: its scan reads the collab reel, which stays Falcon's, and its own.
    const studioScan = instagram.startScan({ clientId: 'c-studio', handle: 'studio_account' });
    const read = [
      reel('COLLAB', { clientId: 'c-studio', plays: 1200 }),
      reel('OWNED', { clientId: 'c-studio', postedAt: T0 - 2 * DAY }),
    ];
    instagram.upsertReels(studioScan.id, read);
    instagram.addReelReads(studioScan.id, read);

    const shortcodes = (clientId: string, since?: number) =>
      instagram.listReels(clientId, since).map((one) => one.shortcode);
    expect(shortcodes('c-studio')).toEqual(['COLLAB', 'OWNED']);
    expect(shortcodes('c-studio', T0 - DAY)).toEqual(['COLLAB']);
    expect(shortcodes(FALCON)).toEqual(['COLLAB', 'FALCONS']);
    expect(instagram.getReel('COLLAB')).toMatchObject({ clientId: FALCON, plays: 1200 });
    expect(shortcodes('nobody')).toEqual([]);

    expect(instagram.reelIsOnPageOf('COLLAB', 'c-studio')).toBe(true);
    expect(instagram.reelIsOnPageOf('COLLAB', FALCON)).toBe(true);
    expect(instagram.reelIsOnPageOf('OWNED', FALCON)).toBe(false);
    expect(instagram.reelIsOnPageOf('FALCONS', 'c-studio')).toBe(false);
    expect(instagram.reelIsOnPageOf('NONE', FALCON)).toBe(false);
  });
});

describe('links', () => {
  function withReels() {
    const t = setup();
    const scan = t.instagram.startScan({ clientId: FALCON, handle: 'm' });
    t.instagram.upsertReels(scan.id, [reel('AAA'), reel('BBB')]);
    return t;
  }

  it('links a reel to a job, and finds the reel of the job', () => {
    const { instagram, clock } = withReels();
    clock.tick(5_000);

    const linked = instagram.linkReel('AAA', 'job-1');

    expect(linked).toMatchObject({ shortcode: 'AAA', jobId: 'job-1', linkedAt: clock().getTime() });
    expect(instagram.getReel('AAA')).toEqual(linked);
    expect(instagram.reelOfJob('job-1')).toEqual(linked);
    expect(instagram.reelOfJob('job-2')).toBeNull();
    expect(instagram.getReel('BBB')?.jobId).toBeNull();
  });

  it('links the same pair twice without changing it', () => {
    const { instagram, clock } = withReels();
    const first = instagram.linkReel('AAA', 'job-1');
    clock.tick(5_000);

    expect(instagram.linkReel('AAA', 'job-1')).toEqual(first);
  });

  it('is one reel for one job: a second job on a reel, or a second reel on a job, is refused', () => {
    const { instagram } = withReels();
    instagram.linkReel('AAA', 'job-1');

    const reason = (shortcode: string, jobId: string) => {
      try {
        instagram.linkReel(shortcode, jobId);
        return null;
      } catch (err) {
        expect(err).toBeInstanceOf(InstagramLinkError);
        return (err as InstagramLinkError).reason;
      }
    };

    expect(reason('AAA', 'job-2')).toBe('reel-linked');
    expect(reason('BBB', 'job-1')).toBe('job-linked');
    expect(reason('MISSING', 'job-3')).toBe('reel-not-found');
    expect(instagram.getReel('AAA')?.jobId).toBe('job-1');
    expect(instagram.getReel('BBB')?.jobId).toBeNull();
  });

  it('unlinks a reel, which frees the job for another', () => {
    const { instagram } = withReels();
    instagram.linkReel('AAA', 'job-1');

    const unlinked = instagram.unlinkReel('AAA');

    expect(unlinked).toMatchObject({ shortcode: 'AAA', jobId: null, linkedAt: null });
    expect(instagram.reelOfJob('job-1')).toBeNull();
    expect(instagram.linkReel('BBB', 'job-1').shortcode).toBe('BBB');
  });

  it('unlinks a reel that links nothing as it is, and an unknown reel as null', () => {
    const { instagram } = withReels();

    expect(instagram.unlinkReel('AAA')).toMatchObject({ shortcode: 'AAA', jobId: null });
    expect(instagram.unlinkReel('MISSING')).toBeNull();
  });

  it('keeps the link when a later scan reads the reel again', () => {
    const { instagram } = withReels();
    instagram.linkReel('AAA', 'job-1');
    const again = instagram.startScan({ clientId: FALCON, handle: 'm' });

    instagram.upsertReels(again.id, [reel('AAA', { plays: 1 })]);

    expect(instagram.getReel('AAA')).toMatchObject({ jobId: 'job-1', plays: 1 });
  });
});

describe('reel reads', () => {
  it('stores what each scan read of each reel, and gives back the reads of two scans', () => {
    const { instagram } = setup();
    const one = instagram.startScan({ clientId: FALCON, handle: 'm' });
    const two = instagram.startScan({ clientId: FALCON, handle: 'm' });
    const three = instagram.startScan({ clientId: FALCON, handle: 'm' });
    instagram.addReelReads(one.id, [
      { shortcode: 'AAA', plays: 100, likes: 10, comments: 1, shares: 2 },
      { shortcode: 'BBB', plays: 200, likes: 20, comments: 2 },
    ]);
    instagram.addReelReads(two.id, [
      { shortcode: 'AAA', plays: 150, likes: 12, comments: 1, shares: 5 },
    ]);
    instagram.addReelReads(three.id, [
      { shortcode: 'AAA', plays: 999, likes: 99, comments: 9, shares: 9 },
    ]);

    expect(instagram.readsOfScans(one.id, two.id)).toEqual([
      { shortcode: 'AAA', scanId: one.id, plays: 100, likes: 10, comments: 1, shares: 2 },
      { shortcode: 'AAA', scanId: two.id, plays: 150, likes: 12, comments: 1, shares: 5 },
      { shortcode: 'BBB', scanId: one.id, plays: 200, likes: 20, comments: 2, shares: null },
    ]);
    // Any number of scans: the Shares a week line reads every scan of the range at once.
    expect(instagram.readsOfScans(one.id, two.id, three.id).map((read) => read.scanId)).toEqual([
      one.id,
      two.id,
      three.id,
      one.id,
    ]);
    expect(instagram.readsOfScans()).toEqual([]);
  });

  it('replaces the read of a reel by the same scan', () => {
    const { instagram, db } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'm' });
    instagram.addReelReads(scan.id, [{ shortcode: 'AAA', plays: 1, likes: 1, comments: 1 }]);

    instagram.addReelReads(scan.id, [
      { shortcode: 'AAA', plays: 2, likes: 3, comments: 4, shares: 5 },
    ]);

    expect(rawCount(db, 'instagram_reel_reads')).toBe(1);
    expect(instagram.readsOfScans(scan.id, scan.id)).toEqual([
      { shortcode: 'AAA', scanId: scan.id, plays: 2, likes: 3, comments: 4, shares: 5 },
    ]);
  });

  it('stores nothing when one read is not valid', () => {
    const { instagram, db } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'm' });

    expect(() =>
      instagram.addReelReads(scan.id, [
        { shortcode: 'AAA', plays: 1, likes: 1, comments: 1 },
        { shortcode: 'BBB', plays: 1.5, likes: 1, comments: 1 },
      ]),
    ).toThrow();

    expect(rawCount(db, 'instagram_reel_reads')).toBe(0);
  });
});

describe('atomically', () => {
  it('keeps everything the work wrote, and gives back what it returns', () => {
    const { instagram } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'm' });

    const reels = instagram.atomically(() => {
      instagram.upsertReels(scan.id, [reel('AAA'), reel('BBB')]);
      instagram.addReelReads(scan.id, [{ shortcode: 'AAA', plays: 1, likes: 1, comments: 1 }]);
      return instagram.listReels(FALCON).length;
    });

    expect(reels).toBe(2);
    expect(instagram.listReels(FALCON)).toHaveLength(2);
    expect(instagram.readsOfScans(scan.id, scan.id)).toHaveLength(1);
  });

  it('keeps none of it when the work throws, even what earlier calls of it wrote', () => {
    const { instagram, db } = setup();
    const scan = instagram.startScan({ clientId: FALCON, handle: 'm' });

    expect(() =>
      instagram.atomically(() => {
        instagram.upsertAccount({ clientId: FALCON, client: 'Falcon FPV', handle: 'falcon.fpv' });
        instagram.upsertReels(scan.id, [reel('AAA')]);
        instagram.finishScan(scan.id, { outcome: 'ok', reelsRead: 1 });
        throw new Error('stop');
      }),
    ).toThrow('stop');

    expect(instagram.getAccount(FALCON)).toBeNull();
    expect(rawCount(db, 'instagram_reels')).toBe(0);
    expect(instagram.getScan(scan.id)).toMatchObject({ outcome: null, finishedAt: null });
  });
});

describe('with the client and its jobs', () => {
  const FALCON_ID = clientIdFor('Falcon FPV');
  const FILMS_ID = clientIdFor('Falcon Films');
  const LAKESHORE_ID = clientIdFor('LAKESHORE');

  /** Falcon FPV: an account, a scan with two reels (one linked), what it read. LAKESHORE: the same, smaller. */
  function withClients() {
    const { db, clock, instagram } = setup();
    const jobs = new JobRepository(db, { clock });
    const ad = jobs.upsertFromScan(makeScan('Falcon FPV', 'Ad 6')).job;
    const promo = jobs.upsertFromScan(makeScan('LAKESHORE', 'Promo')).job;
    for (const [clientId, client, handle] of [
      [FALCON_ID, 'Falcon FPV', 'falcon.fpv'],
      [LAKESHORE_ID, 'LAKESHORE', 'lakeshore'],
    ] as const) {
      instagram.upsertAccount({ clientId, client, handle });
    }
    const scan = instagram.startScan({ clientId: FALCON_ID, handle: 'falcon.fpv' });
    instagram.finishScan(scan.id, { outcome: 'ok', followers: 10, reelsRead: 2 });
    instagram.upsertReels(scan.id, [
      reel('AAA', { clientId: FALCON_ID }),
      reel('BBB', { clientId: FALCON_ID }),
    ]);
    instagram.addReelReads(scan.id, [
      { shortcode: 'AAA', plays: 1, likes: 1, comments: 1 },
      { shortcode: 'BBB', plays: 2, likes: 2, comments: 2 },
    ]);
    const otherScan = instagram.startScan({ clientId: LAKESHORE_ID, handle: 'lakeshore' });
    instagram.finishScan(otherScan.id, { outcome: 'ok', followers: 5, reelsRead: 1 });
    instagram.upsertReels(otherScan.id, [reel('ZZZ', { clientId: LAKESHORE_ID })]);
    instagram.addReelReads(otherScan.id, [{ shortcode: 'ZZZ', plays: 3, likes: 3, comments: 3 }]);
    instagram.linkReel('AAA', ad.id);
    instagram.linkReel('ZZZ', promo.id);
    return { db, jobs, instagram, ad, promo, scan, otherScan };
  }

  it('follows a client rename: the account, the scans and the reels, and the links to the jobs’ new ids', () => {
    const { jobs, instagram, ad, promo, scan } = withClients();

    const moved = jobs.renameClient('Falcon FPV', 'Falcon Films');

    const newJobId = moved.movedIds[0]?.to ?? '';
    expect(newJobId).not.toBe(ad.id);
    expect(instagram.getAccount(FALCON_ID)).toBeNull();
    expect(instagram.getAccount(FILMS_ID)).toMatchObject({
      client: 'Falcon Films',
      handle: 'falcon.fpv',
    });
    expect(instagram.latestScan(FALCON_ID)).toBeNull();
    expect(instagram.latestOkScan(FILMS_ID)).toMatchObject({ id: scan.id, followers: 10 });
    expect(instagram.listReels(FALCON_ID)).toEqual([]);
    expect(instagram.listReels(FILMS_ID).map((one) => one.shortcode)).toEqual(['AAA', 'BBB']);
    expect(instagram.getReel('AAA')?.jobId).toBe(newJobId);
    expect(instagram.reelOfJob(ad.id)).toBeNull();
    expect(instagram.reelOfJob(newJobId)?.shortcode).toBe('AAA');
    expect(instagram.getReel('BBB')?.jobId).toBeNull();
    // What the scan read stays with its scan.
    expect(instagram.readsOfScans(scan.id, scan.id)).toHaveLength(2);
    // The other client is as it was.
    expect(instagram.getAccount(LAKESHORE_ID)).toMatchObject({ client: 'LAKESHORE' });
    expect(instagram.getReel('ZZZ')).toMatchObject({ clientId: LAKESHORE_ID, jobId: promo.id });
  });

  it('refuses a rename to a name the Instagram rows know a client by, and changes nothing', () => {
    for (const table of ['instagram_accounts', 'instagram_scans', 'instagram_reels']) {
      const { db, jobs, instagram, ad } = withClients();
      // Rows left by an earlier client of that name.
      db.sqlite
        .prepare(`update ${table} set client_id = ? where client_id = ?`)
        .run(FILMS_ID, LAKESHORE_ID);

      expect(() => jobs.renameClient('Falcon FPV', 'Falcon Films'), table).toThrow(
        ClientRenameConflictError,
      );

      expect(jobs.get(ad.id), table).not.toBeNull();
      expect(instagram.getAccount(FALCON_ID), table).not.toBeNull();
      expect(instagram.reelOfJob(ad.id)?.shortcode, table).toBe('AAA');
    }
  });

  it('follows a job rename: the reel links the new id', () => {
    const { jobs, instagram, ad } = withClients();
    const newId = idFor('Falcon FPV/Ad 7');

    jobs.rename(ad.id, { name: 'Ad 7', relPath: 'Falcon FPV/Ad 7', newId, output: null });

    expect(instagram.reelOfJob(ad.id)).toBeNull();
    expect(instagram.reelOfJob(newId)?.shortcode).toBe('AAA');
  });

  it('deletes every Instagram row of a deleted client and none of another’s', () => {
    const { db, jobs, instagram, ad, promo, otherScan } = withClients();

    const gone = jobs.purgeClient('Falcon FPV');

    expect(gone.jobIds).toEqual([ad.id]);
    expect(instagram.getAccount(FALCON_ID)).toBeNull();
    expect(instagram.latestScan(FALCON_ID)).toBeNull();
    expect(instagram.listReels(FALCON_ID)).toEqual([]);
    expect(instagram.getReel('AAA')).toBeNull();
    expect(instagram.reelOfJob(ad.id)).toBeNull();
    // The reads of its scans and its reels went with them; the other client's read stays.
    expect(rawCount(db, 'instagram_reel_reads')).toBe(1);
    expect(instagram.getAccount(LAKESHORE_ID)).not.toBeNull();
    expect(instagram.latestOkScan(LAKESHORE_ID)?.id).toBe(otherScan.id);
    expect(instagram.getReel('ZZZ')).toMatchObject({ jobId: promo.id });
    expect(instagram.readsOfScans(otherScan.id, otherScan.id)).toHaveLength(1);
  });

  it('gives the reel back to the client when its job is purged, and keeps the link when the job is only removed', () => {
    const { jobs, instagram, ad, promo } = withClients();

    expect(jobs.remove(promo.id)).toBe(true);
    expect(instagram.getReel('ZZZ')?.jobId).toBe(promo.id);

    expect(jobs.purge(ad.id)).toBe(true);
    expect(instagram.getReel('AAA')).toMatchObject({ jobId: null, linkedAt: null });
    expect(instagram.reelOfJob(ad.id)).toBeNull();
    // The reel can link another job now.
    expect(instagram.linkReel('AAA', 'job-2').jobId).toBe('job-2');
  });
});

describe('the latest scan that ended', () => {
  it('skips a scan that is still running, whatever its outcome will be', () => {
    const { instagram, clock } = setup();
    expect(instagram.latestEndedScan(FALCON)).toBeNull();

    const failed = instagram.startScan({ clientId: FALCON, handle: 'falcon.fpv', startedAt: T0 });
    instagram.finishScan(failed.id, { outcome: 'no-credit', error: 'Out of credit' });
    clock.tick(60_000);
    const running = instagram.startScan({
      clientId: FALCON,
      handle: 'falcon.fpv',
      startedAt: T0 + DAY,
    });

    expect(instagram.latestScan(FALCON)?.id).toBe(running.id);
    expect(instagram.latestEndedScan(FALCON)).toMatchObject({
      id: failed.id,
      outcome: 'no-credit',
    });
    expect(instagram.latestEndedScan('other')).toBeNull();

    instagram.finishScan(running.id, { outcome: 'ok', followers: 5 });
    expect(instagram.latestEndedScan(FALCON)?.id).toBe(running.id);
  });
});

describe('the deliveries it reads', () => {
  function withDeliveries() {
    const { db, instagram } = setup();
    const deliveries = new DeliveryRepository(db);
    const delivery = (name: string, overrides: Partial<NewDelivery> = {}): NewDelivery => ({
      jobId: idFor(`Falcon FPV/${name}`),
      clientId: FALCON,
      client: 'Falcon FPV',
      name,
      relPath: `Falcon FPV/${name}`,
      deliveredAt: T0,
      price: 40,
      currency: 'ILS',
      ...overrides,
    });
    return { instagram, deliveries, delivery };
  }

  it('says when the first delivery of a client was marked, and null for a client with none', () => {
    const { instagram, deliveries, delivery } = withDeliveries();
    expect(instagram.firstDeliveryAt(FALCON)).toBeNull();

    deliveries.record(delivery('Late', { deliveredAt: T0 + 5 * DAY }));
    deliveries.record(delivery('Early', { deliveredAt: T0 - 9 * DAY }));
    deliveries.record(
      delivery('Other client', { clientId: 'c-other', deliveredAt: T0 - 90 * DAY }),
    );

    expect(instagram.firstDeliveryAt(FALCON)).toBe(T0 - 9 * DAY);
    expect(instagram.firstDeliveryAt('c-other')).toBe(T0 - 90 * DAY);
    expect(instagram.firstDeliveryAt('c-nobody')).toBeNull();
  });

  it('gives the names of the deliveries of the jobs asked for', () => {
    const { instagram, deliveries, delivery } = withDeliveries();
    deliveries.record(delivery('Granite'));
    deliveries.record(delivery('Rooftop Run'));

    const names = instagram.deliveryNames([
      idFor('Falcon FPV/Granite'),
      idFor('Falcon FPV/Rooftop Run'),
      'no-such-job',
    ]);

    expect(names).toEqual(
      new Map([
        [idFor('Falcon FPV/Granite'), 'Granite'],
        [idFor('Falcon FPV/Rooftop Run'), 'Rooftop Run'],
      ]),
    );
    expect(instagram.deliveryNames([]).size).toBe(0);
  });

  it('lists the client deliveries no reel links, newest delivery first, delivered and paid alike', () => {
    const { instagram, deliveries, delivery } = withDeliveries();
    deliveries.record(delivery('Oldest', { deliveredAt: T0 - 20 * DAY }));
    deliveries.record(delivery('Middle', { deliveredAt: T0 - 10 * DAY }));
    deliveries.record(delivery('Newest', { deliveredAt: T0 }));
    deliveries.record(delivery('Linked', { deliveredAt: T0 - 5 * DAY }));
    deliveries.record(delivery('Elsewhere', { clientId: 'c-other', deliveredAt: T0 }));
    deliveries.markPaid([idFor('Falcon FPV/Oldest')], '2026-10-05');

    instagram.upsertReels(instagram.startScan({ clientId: FALCON, handle: 'falcon.fpv' }).id, [
      reel('AAA'),
      reel('BBB'),
    ]);
    instagram.linkReel('AAA', idFor('Falcon FPV/Linked'));

    expect(instagram.linkableDeliveries(FALCON)).toEqual([
      { jobId: idFor('Falcon FPV/Newest'), name: 'Newest', deliveredAt: T0, paid: false },
      {
        jobId: idFor('Falcon FPV/Middle'),
        name: 'Middle',
        deliveredAt: T0 - 10 * DAY,
        paid: false,
      },
      {
        jobId: idFor('Falcon FPV/Oldest'),
        name: 'Oldest',
        deliveredAt: T0 - 20 * DAY,
        paid: true,
      },
    ]);
    expect(instagram.linkableDeliveries('c-other').map((one) => one.name)).toEqual(['Elsewhere']);
    expect(instagram.linkableDeliveries('c-nobody')).toEqual([]);

    // Unlinking gives the job back; a job whose delivery was taken back is not offered at all.
    instagram.unlinkReel('AAA');
    expect(instagram.linkableDeliveries(FALCON).map((one) => one.name)).toEqual([
      'Newest',
      'Linked',
      'Middle',
      'Oldest',
    ]);
    deliveries.remove(idFor('Falcon FPV/Newest'));
    expect(instagram.linkableDeliveries(FALCON).map((one) => one.name)).not.toContain('Newest');
  });
});
