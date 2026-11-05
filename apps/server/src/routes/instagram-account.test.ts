import { rmSync, writeFileSync } from 'node:fs';
import {
  apiErrorSchema,
  type ClientInstagram,
  clientInstagramSchema,
  deleteClientInstagramResponseSchema,
  INSTAGRAM_MESSAGES,
  type ServerEvent,
} from '@studio/shared';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { instagramPhotoFor } from '../clients/paths.js';
import type { StudioDb } from '../db/database.js';
import { InstagramRepository } from '../db/instagram-repository.js';
import { fakeClock, memoryDb } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import {
  createFakeInstagramScanner,
  loadFakeInstagramFixtures,
} from '../instagram/fake-scanner.js';
import { createInstagramScanQueue, type ScanTimers } from '../instagram/scan-queue.js';
import { makeTempDir } from '../test-temp.js';
import { createInstagramRoutes } from './instagram.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// PUT, DELETE and Scan now and the photo, over a real (in-memory) database, the real queue with the
// fake scanner, a temp data folder and a clock that only moves when told to.

const CLIENT = 'Falcon FPV';
const CLIENT_ID = clientIdFor(CLIENT);
const OTHER = 'Northwind Bakery';
const OTHER_ID = clientIdFor(OTHER);

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const noTimers: ScanTimers = { setInterval: () => 1, clearInterval: () => undefined };

/** Waits for the timers of the fake scanner's abort handling and the worker's microtasks. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(options: { delayMs?: number } = {}) {
  // Friday 30 Oct 2026, 12:00 in Jerusalem: the next weekly scan is Mon 2 Nov, 06:00 (04:00Z).
  const clock = fakeClock('2026-10-30T10:00:00.000Z');
  const db = memoryDb();
  opened.push(db);
  const instagram = new InstagramRepository(db, { clock });
  const dataDir = makeTempDir('studio-instagram-routes-');
  const natgeo = loadFakeInstagramFixtures().natgeo;
  if (natgeo === undefined) throw new Error('the natgeo fixture is missing');
  const scanner = createFakeInstagramScanner({
    instagram,
    dataDir,
    clock,
    delayMs: options.delayMs ?? 0,
    fixtures: {
      ...loadFakeInstagramFixtures(),
      // A client's own handles: the real profile, no reels (a reel's shortcode is global).
      'falcon.fpv': { profile: natgeo.profile, reels: [] },
      falcon_fpv: { profile: natgeo.profile, reels: [] },
      'northwind.bakery': { profile: natgeo.profile, reels: [] },
    },
  });
  const events: ServerEvent[] = [];
  const scans = createInstagramScanQueue({
    scanner,
    instagram,
    activeClients: () => null,
    publish: (event) => events.push(event),
    clock,
    timeZone: 'Asia/Jerusalem',
    timers: noTimers,
  });
  const routes = {
    clients: {
      jobs: { clientNames: () => [CLIENT, OTHER] },
      clientStyles: { get: () => null },
    },
    instagram: { repo: instagram, clock, timeZone: () => 'Asia/Jerusalem' },
    scans,
    dataDir,
    publish: (event: ServerEvent) => events.push(event),
  };
  const app = createApp({ instagram: true, instagramRoutes: routes });
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const put = (clientId: string, body: unknown) =>
    send('PUT', `/api/clients/${clientId}/instagram`, body);
  const instagramEvents = (clientId: string) =>
    events.filter((event) => event.type === 'client-instagram' && event.clientId === clientId);
  return { clock, instagram, dataDir, scanner, scans, events, routes, send, put, instagramEvents };
}

async function answer(res: Response): Promise<ClientInstagram> {
  expect(res.ok).toBe(true);
  return clientInstagramSchema.parse(await res.json());
}

describe('PUT /api/clients/:clientId/instagram', () => {
  it('saves the account with its handle normalised and queues its first scan', async () => {
    const t = setup();

    const res = await t.put(CLIENT_ID, {
      handle: 'https://www.instagram.com/Falcon.FPV/?igsh=abc',
      since: '2026-09-14',
    });

    expect(res.status).toBe(200);
    const body = await answer(res);
    expect(body.account).toMatchObject({
      handle: 'falcon.fpv',
      since: '2026-09-14',
      fullName: null,
      photoSavedAt: null,
      private: false,
    });
    expect(body.lastScan).toBeNull();
    expect(body.scanning).toBe(true);
    expect(body.nextScanAt).toBe('2026-11-02T04:00:00.000Z');
    expect(t.instagram.getAccount(CLIENT_ID)).toMatchObject({
      client: CLIENT,
      handle: 'falcon.fpv',
      since: '2026-09-14',
    });

    // The scan runs and fills in the account.
    await t.scans.whenIdle();
    const [scan] = t.instagram.recentScans(CLIENT_ID);
    expect(scan).toMatchObject({ handle: 'falcon.fpv', outcome: 'ok' });
    expect(t.instagram.getAccount(CLIENT_ID)?.fullName).toBe('National Geographic');
  });

  it('takes the day as null or left out, which is the client’s first delivery', async () => {
    const t = setup();
    const body = await answer(await t.put(CLIENT_ID, { handle: 'falcon.fpv' }));
    expect(body.account?.since).toBeNull();
    await t.scans.whenIdle();
  });

  it('tells the page: queued, started and ended, and that the account changed', async () => {
    const t = setup();
    await t.put(CLIENT_ID, { handle: 'falcon.fpv', since: null });
    await t.scans.whenIdle();

    // PUT, then the queue's three.
    expect(t.instagramEvents(CLIENT_ID).length).toBeGreaterThanOrEqual(4);
    expect(t.instagramEvents(OTHER_ID)).toEqual([]);
  });

  it('puts the first scan at the front of the line', async () => {
    const t = setup({ delayMs: 60_000 });
    t.instagram.upsertAccount({ clientId: OTHER_ID, client: OTHER, handle: 'northwind.bakery' });
    t.scans.enqueue(OTHER_ID);
    await flush();
    expect(t.scans.isRunning(OTHER_ID)).toBe(true);
    // Two more clients wait; the new account goes before the one that was there.
    const third = clientIdFor('Third');
    t.instagram.upsertAccount({ clientId: third, client: 'Third', handle: 'falcon_fpv' });
    t.scans.enqueue(third);

    await t.put(CLIENT_ID, { handle: 'falcon.fpv', since: null });

    expect(t.scans.waiting()).toEqual([CLIENT_ID, third]);
    t.scans.drop(OTHER_ID);
    t.scans.drop(third);
    t.scans.drop(CLIENT_ID);
  });

  it('queues no scan when only the day changed, and one when the handle changed', async () => {
    const t = setup();
    await t.put(CLIENT_ID, { handle: 'falcon.fpv', since: null });
    await t.scans.whenIdle();
    expect(t.instagram.recentScans(CLIENT_ID)).toHaveLength(1);

    const sameHandle = await answer(
      await t.put(CLIENT_ID, { handle: '@Falcon.FPV', since: '2026-09-14' }),
    );
    expect(sameHandle.scanning).toBe(false);
    expect(sameHandle.account?.since).toBe('2026-09-14');
    // What the scan read is still there.
    expect(sameHandle.account?.fullName).toBe('National Geographic');
    await flush();
    expect(t.instagram.recentScans(CLIENT_ID)).toHaveLength(1);

    const another = await answer(
      await t.put(CLIENT_ID, { handle: 'falcon_fpv', since: '2026-09-14' }),
    );
    expect(another.scanning).toBe(true);
    // Another handle is another account until a scan says otherwise.
    expect(another.account).toMatchObject({
      handle: 'falcon_fpv',
      fullName: null,
      photoSavedAt: null,
    });
    await t.scans.whenIdle();
    expect(t.instagram.recentScans(CLIENT_ID)).toHaveLength(2);
    expect(t.instagram.getAccount(CLIENT_ID)).toMatchObject({
      handle: 'falcon_fpv',
      fullName: 'National Geographic',
    });
  });

  it('stops the scan of the old handle when the handle changes under it', async () => {
    const t = setup({ delayMs: 60_000 });
    await t.put(CLIENT_ID, { handle: 'falcon.fpv', since: null });
    await flush();
    expect(t.scans.isRunning(CLIENT_ID)).toBe(true);

    await t.put(CLIENT_ID, { handle: 'falcon_fpv', since: null });
    await flush();

    // The first scan was stopped (it wrote only its row, as a stopped one) and the next one started.
    const scans = t.instagram.recentScans(CLIENT_ID);
    expect(scans.map((scan) => scan.handle)).toEqual(['falcon_fpv', 'falcon.fpv']);
    expect(scans[1]).toMatchObject({ outcome: 'failed', error: 'The scan was stopped' });
    t.scans.drop(CLIENT_ID);
    await t.scans.whenIdle();
  });

  it('adds the same account again after it was removed: the scan is queued', async () => {
    const t = setup();
    await t.put(CLIENT_ID, { handle: 'falcon.fpv', since: null });
    await t.scans.whenIdle();
    await t.send('DELETE', `/api/clients/${CLIENT_ID}/instagram`);

    const body = await answer(await t.put(CLIENT_ID, { handle: 'falcon.fpv', since: null }));
    expect(body.scanning).toBe(true);
    await t.scans.whenIdle();
    expect(t.instagram.recentScans(CLIENT_ID)).toHaveLength(2);
  });

  it('says 404 for a client that does not exist, and 400 for a bad handle', async () => {
    const t = setup();
    expect((await t.put('nosuchclient', { handle: 'falcon.fpv' })).status).toBe(404);
    const bad = await t.put(CLIENT_ID, { handle: 'falcon fpv' });
    expect(bad.status).toBe(400);
    expect(apiErrorSchema.parse(await bad.json())).toEqual({
      error: 'An Instagram handle has no spaces.',
    });
    expect(t.instagram.getAccount(CLIENT_ID)).toBeNull();
    expect(t.scans.isBusy(CLIENT_ID)).toBe(false);
  });
});

describe('DELETE /api/clients/:clientId/instagram', () => {
  it('removes the account and nothing else: the scans and reels stay', async () => {
    const t = setup();
    // The real natgeo reels, so there is something to keep.
    t.instagram.upsertAccount({ clientId: CLIENT_ID, client: CLIENT, handle: 'natgeo' });
    await t.scanner.scan(CLIENT_ID, 'natgeo');
    expect(t.instagram.listReels(CLIENT_ID)).toHaveLength(5);

    const res = await t.send('DELETE', `/api/clients/${CLIENT_ID}/instagram`);

    expect(res.status).toBe(200);
    expect(deleteClientInstagramResponseSchema.parse(await res.json())).toEqual({ ok: true });
    expect(t.instagram.getAccount(CLIENT_ID)).toBeNull();
    expect(t.instagram.listReels(CLIENT_ID)).toHaveLength(5);
    expect(t.instagram.recentScans(CLIENT_ID)).toHaveLength(1);
    expect(t.instagramEvents(CLIENT_ID)).toHaveLength(1);
  });

  it('is fine for a client that has no account, and tells nobody', async () => {
    const t = setup();
    const res = await t.send('DELETE', `/api/clients/${CLIENT_ID}/instagram`);
    expect(res.status).toBe(200);
    expect(t.events).toEqual([]);
  });

  it('takes the client out of the line and stops its scan', async () => {
    const t = setup({ delayMs: 60_000 });
    await t.put(CLIENT_ID, { handle: 'falcon.fpv', since: null });
    await t.put(OTHER_ID, { handle: 'northwind.bakery', since: null });
    await flush();
    expect(t.scans.isRunning(CLIENT_ID)).toBe(true);
    expect(t.scans.waiting()).toEqual([OTHER_ID]);

    await t.send('DELETE', `/api/clients/${OTHER_ID}/instagram`);
    expect(t.scans.isBusy(OTHER_ID)).toBe(false);

    await t.send('DELETE', `/api/clients/${CLIENT_ID}/instagram`);
    await t.scans.whenIdle();
    expect(t.scans.isBusy(CLIENT_ID)).toBe(false);
    // Nothing else ran.
    expect(t.instagram.recentScans(OTHER_ID)).toEqual([]);
    expect(t.instagram.recentScans(CLIENT_ID)).toHaveLength(1);
  });

  it('says 404 for a client that does not exist', async () => {
    const t = setup();
    expect((await t.send('DELETE', '/api/clients/nosuchclient/instagram')).status).toBe(404);
  });
});

describe('POST /api/clients/:clientId/instagram/scan (Scan now)', () => {
  it('answers 202 with the client’s Instagram, scanning, and runs the scan', async () => {
    const t = setup();
    t.instagram.upsertAccount({ clientId: CLIENT_ID, client: CLIENT, handle: 'falcon.fpv' });

    const res = await t.send('POST', `/api/clients/${CLIENT_ID}/instagram/scan`);

    expect(res.status).toBe(202);
    const body = await answer(res);
    expect(body.scanning).toBe(true);
    expect(body.account?.handle).toBe('falcon.fpv');
    expect(body.nextScanAt).toBe('2026-11-02T04:00:00.000Z');
    await t.scans.whenIdle();
    expect(t.instagram.recentScans(CLIENT_ID)).toHaveLength(1);
    expect(t.instagram.getAccount(CLIENT_ID)?.fullName).toBe('National Geographic');
  });

  it('is 409 while a scan of the client runs, and queues nothing more', async () => {
    const t = setup({ delayMs: 60_000 });
    t.instagram.upsertAccount({ clientId: CLIENT_ID, client: CLIENT, handle: 'falcon.fpv' });
    expect((await t.send('POST', `/api/clients/${CLIENT_ID}/instagram/scan`)).status).toBe(202);
    await flush();
    expect(t.scans.isRunning(CLIENT_ID)).toBe(true);

    const res = await t.send('POST', `/api/clients/${CLIENT_ID}/instagram/scan`);

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json())).toEqual({
      error: INSTAGRAM_MESSAGES.scanRunning,
    });
    expect(t.scans.waiting()).toEqual([]);
    t.scans.drop(CLIENT_ID);
    await t.scans.whenIdle();
  });

  it('jumps the line: a client waiting in the weekly line goes to the front', async () => {
    const t = setup({ delayMs: 60_000 });
    const clients = ['A', 'B', 'C'].map((name) => ({ name, id: clientIdFor(name) }));
    for (const { name, id } of clients) {
      t.instagram.upsertAccount({ clientId: id, client: name, handle: 'falcon.fpv' });
    }
    // The routes know the client list of the test only: use the two it has, plus scheduled others.
    t.instagram.upsertAccount({ clientId: OTHER_ID, client: OTHER, handle: 'northwind.bakery' });
    t.instagram.upsertAccount({ clientId: CLIENT_ID, client: CLIENT, handle: 'falcon.fpv' });
    for (const { id } of clients) t.scans.enqueue(id);
    t.scans.enqueue(OTHER_ID);
    t.scans.enqueue(CLIENT_ID);
    await flush();
    expect(t.scans.waiting().slice(-2)).toEqual([OTHER_ID, CLIENT_ID]);

    const res = await t.send('POST', `/api/clients/${CLIENT_ID}/instagram/scan`);

    expect(res.status).toBe(202);
    expect(t.scans.waiting()[0]).toBe(CLIENT_ID);
    for (const { id } of clients) t.scans.drop(id);
    t.scans.drop(OTHER_ID);
    t.scans.drop(CLIENT_ID);
    await t.scans.whenIdle();
  });

  it('says 404 for a client with no account to read, and for one that does not exist', async () => {
    const t = setup();
    const none = await t.send('POST', `/api/clients/${CLIENT_ID}/instagram/scan`);
    expect(none.status).toBe(404);
    expect(apiErrorSchema.parse(await none.json())).toEqual({
      error: INSTAGRAM_MESSAGES.noAccount,
    });
    expect((await t.send('POST', '/api/clients/nosuchclient/instagram/scan')).status).toBe(404);
    expect(t.scans.isBusy(CLIENT_ID)).toBe(false);
  });

  it('shows what the last scan cost to the admin and hides it from an editor', async () => {
    const t = setup();
    t.instagram.upsertAccount({ clientId: CLIENT_ID, client: CLIENT, handle: 'falcon.fpv' });
    await t.scanner.scan(CLIENT_ID, 'falcon.fpv');

    const as = (role: 'admin' | 'editor') =>
      new Hono()
        .use('*', async (c, next) => {
          // biome-ignore lint/suspicious/noExplicitAny: a bare app has no typed viewer variable
          (c as any).set('viewer', { email: 'who@example.com', name: 'Who', role, via: 'local' });
          await next();
        })
        .route('/api', createInstagramRoutes(t.routes));
    const scan = async (role: 'admin' | 'editor') => {
      const res = await as(role).request(`/api/clients/${CLIENT_ID}/instagram/scan`, {
        method: 'POST',
      });
      const body = await answer(res);
      await t.scans.whenIdle();
      return body.lastScan;
    };

    expect((await scan('admin'))?.costUsd).toBeGreaterThan(0);
    expect((await scan('editor'))?.costUsd).toBeNull();
  });
});

describe('GET /api/clients/:clientId/photo', () => {
  /** An account whose scan saved a picture. */
  async function withPhoto(t: ReturnType<typeof setup>) {
    t.instagram.upsertAccount({ clientId: CLIENT_ID, client: CLIENT, handle: 'falcon.fpv' });
    await t.scanner.scan(CLIENT_ID, 'falcon.fpv');
    const account = t.instagram.getAccount(CLIENT_ID);
    if (account?.photoSavedAt == null) throw new Error('the scan saved no photo');
    return account.photoSavedAt;
  }

  it('serves the saved picture, with cache headers keyed by when it was saved', async () => {
    const t = setup();
    const savedAt = await withPhoto(t);

    const res = await t.send('GET', `/api/clients/${CLIENT_ID}/photo`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('etag')).toBe(`"${savedAt}"`);
    expect(res.headers.get('last-modified')).toBe(new Date(savedAt).toUTCString());
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(res.headers.get('content-length')).toBe(String(bytes.length));
  });

  it('answers 304 to a browser that has this picture, and 200 to one that has an older one', async () => {
    const t = setup();
    const savedAt = await withPhoto(t);

    const same = await t.send('GET', `/api/clients/${CLIENT_ID}/photo`, undefined, {
      'if-none-match': `"${savedAt}"`,
    });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe('');
    expect(same.headers.get('etag')).toBe(`"${savedAt}"`);

    const older = await t.send('GET', `/api/clients/${CLIENT_ID}/photo`, undefined, {
      'if-none-match': `"${savedAt - 1000}"`,
    });
    expect(older.status).toBe(200);
  });

  it('keeps the picture for good when it is asked for by the time it was saved', async () => {
    const t = setup();
    const savedAt = await withPhoto(t);

    const right = await t.send('GET', `/api/clients/${CLIENT_ID}/photo?v=${savedAt}`);
    expect(right.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');

    const wrong = await t.send('GET', `/api/clients/${CLIENT_ID}/photo?v=${savedAt - 1}`);
    expect(wrong.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('serves a new picture under a new tag after a scan saves one', async () => {
    const t = setup();
    const first = await withPhoto(t);
    t.clock.tick(60_000);
    await t.scanner.scan(CLIENT_ID, 'falcon.fpv');
    const res = await t.send('GET', `/api/clients/${CLIENT_ID}/photo`);
    expect(res.headers.get('etag')).toBe(`"${first + 60_000}"`);
  });

  it('knows a PNG and a WebP by their first bytes', async () => {
    const t = setup();
    await withPhoto(t);
    const file = instagramPhotoFor(t.dataDir, CLIENT_ID);
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(
      (await t.send('GET', `/api/clients/${CLIENT_ID}/photo`)).headers.get('content-type'),
    ).toBe('image/png');
    writeFileSync(file, Buffer.from('RIFF1234WEBPVP8 ', 'latin1'));
    expect(
      (await t.send('GET', `/api/clients/${CLIENT_ID}/photo`)).headers.get('content-type'),
    ).toBe('image/webp');
  });

  it('is 404 until a picture is saved, while the client has no account, and when the file is gone', async () => {
    const t = setup();
    const noPhoto = { error: INSTAGRAM_MESSAGES.noPhoto };

    // No account.
    const none = await t.send('GET', `/api/clients/${CLIENT_ID}/photo`);
    expect(none.status).toBe(404);
    expect(apiErrorSchema.parse(await none.json())).toEqual(noPhoto);

    // An account that was never scanned.
    t.instagram.upsertAccount({ clientId: CLIENT_ID, client: CLIENT, handle: 'falcon.fpv' });
    expect((await t.send('GET', `/api/clients/${CLIENT_ID}/photo`)).status).toBe(404);

    // A saved picture whose file went missing.
    await t.scanner.scan(CLIENT_ID, 'falcon.fpv');
    expect((await t.send('GET', `/api/clients/${CLIENT_ID}/photo`)).status).toBe(200);
    rmSync(instagramPhotoFor(t.dataDir, CLIENT_ID));
    expect((await t.send('GET', `/api/clients/${CLIENT_ID}/photo`)).status).toBe(404);
  });

  it('is 404 once the account is removed, though the file stays on disk', async () => {
    const t = setup();
    await withPhoto(t);
    await t.send('DELETE', `/api/clients/${CLIENT_ID}/instagram`);
    expect((await t.send('GET', `/api/clients/${CLIENT_ID}/photo`)).status).toBe(404);
  });

  it('says an unknown client is not found', async () => {
    const t = setup();
    expect((await t.send('GET', '/api/clients/nosuchclient/photo')).status).toBe(404);
  });
});

describe('the switch is off', () => {
  it('answers 404 "off" to all of them, even with the routes and a queue given', async () => {
    const t = setup();
    const off = createApp({ instagram: false, instagramRoutes: t.routes });
    for (const [method, path] of [
      ['PUT', `/api/clients/${CLIENT_ID}/instagram`],
      ['DELETE', `/api/clients/${CLIENT_ID}/instagram`],
      ['POST', `/api/clients/${CLIENT_ID}/instagram/scan`],
      ['GET', `/api/clients/${CLIENT_ID}/photo`],
    ] as const) {
      const res = await off.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.off });
    }
    expect(t.scans.waiting()).toEqual([]);
  });
});
