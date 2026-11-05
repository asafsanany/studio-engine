import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  clientInstagramSchema,
  INSTAGRAM_MESSAGES,
  noClientInstagram,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { InstagramRepository } from '../db/instagram-repository.js';
import { idFor, memoryDb } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import { TeamService } from '../team/team-service.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const CLIENT = 'Northwind Bakery';
const CLIENT_ID = clientIdFor(CLIENT);

/** An app that knows one client; `instagram` is the switch. */
function app(instagram: boolean) {
  return createApp({
    instagram,
    instagramRoutes: {
      clients: {
        jobs: { clientNames: () => [CLIENT] },
        clientStyles: { get: () => null },
      },
    },
  });
}

function send(api: ReturnType<typeof app>, method: string, path: string, body?: unknown) {
  return api.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

describe('GET /api/clients/:clientId/instagram', () => {
  it('answers the empty shape of a client with no Instagram yet', async () => {
    const res = await send(app(true), 'GET', `/api/clients/${CLIENT_ID}/instagram`);
    expect(res.status).toBe(200);
    expect(clientInstagramSchema.parse(await res.json())).toEqual(noClientInstagram());
  });

  it('takes the three ranges and says 400 for another', async () => {
    const api = app(true);
    for (const range of ['since', '90', '30']) {
      const res = await send(api, 'GET', `/api/clients/${CLIENT_ID}/instagram?range=${range}`);
      expect(res.status, range).toBe(200);
    }
    for (const range of ['7', 'all', '']) {
      const res = await send(api, 'GET', `/api/clients/${CLIENT_ID}/instagram?range=${range}`);
      expect(res.status, range).toBe(400);
      expect(apiErrorSchema.parse(await res.json())).toEqual({
        error: INSTAGRAM_MESSAGES.badRange,
      });
    }
  });

  it('says an unknown client is not found', async () => {
    const res = await send(app(true), 'GET', '/api/clients/nosuchclient/instagram');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({
      error: 'Client nosuchclient not found',
    });
  });
});

// --- the client page's numbers over the real tables (IG6) ----------------------------------------

const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-27T10:00:00.000Z');
const MAC = 'studio-mac.tail1234.ts.net';
const jobIdOf = (name: string) => idFor(`${CLIENT}/${name}`);

/** Northwind Bakery with an account, two weekly scans, a linked reel and a theirs one. */
function withData() {
  const db = memoryDb();
  opened.push(db);
  const repo = new InstagramRepository(db);
  const deliveries = new DeliveryRepository(db);
  repo.upsertAccount({
    clientId: CLIENT_ID,
    client: CLIENT,
    handle: 'northwind.bakery',
    addedAt: Date.parse('2026-10-12T05:50:00.000Z'),
  });
  for (const [name, at] of [
    ['Spring menu', '2026-10-23T09:00:00.000Z'],
    ['Loaf day', '2026-10-14T09:00:00.000Z'],
  ] as const) {
    deliveries.record({
      jobId: jobIdOf(name),
      clientId: CLIENT_ID,
      client: CLIENT,
      name,
      relPath: `${CLIENT}/${name}`,
      deliveredAt: Date.parse(at),
      price: 40,
      currency: 'ILS',
    });
  }
  const scans = [
    ['2026-10-19T06:00:00.000Z', 1_000],
    ['2026-10-26T06:03:00.000Z', 1_060],
  ] as const;
  for (const [at, followers] of scans) {
    const scan = repo.startScan({
      clientId: CLIENT_ID,
      handle: 'northwind.bakery',
      startedAt: Date.parse(at),
    });
    repo.finishScan(scan.id, {
      outcome: 'ok',
      followers,
      reelsRead: 2,
      costUsd: 0.12,
      finishedAt: Date.parse(at) + 60_000,
    });
    repo.upsertReels(scan.id, [
      {
        shortcode: 'OURS1',
        clientId: CLIENT_ID,
        url: 'https://www.instagram.com/reel/OURS1/',
        postedAt: Date.parse('2026-10-20T12:00:00.000Z'),
        plays: 9_000,
        likes: 500,
        comments: 20,
        shares: 80,
      },
      {
        shortcode: 'THEIRS1',
        clientId: CLIENT_ID,
        url: 'https://www.instagram.com/reel/THEIRS1/',
        postedAt: Date.parse('2026-10-22T12:00:00.000Z'),
        plays: 3_000,
        likes: 100,
        comments: 5,
        shares: 10,
      },
    ]);
  }
  repo.linkReel('OURS1', jobIdOf('Spring menu'));
  return { repo };
}

function dataApp(repo: InstagramRepository, extra: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    instagram: true,
    instagramRoutes: {
      clients: {
        jobs: { clientNames: () => [CLIENT] },
        clientStyles: { get: () => null },
      },
      instagram: { repo, clock: () => NOW, timeZone: () => 'UTC' },
    },
    ...extra,
  });
}

describe('GET /api/clients/:clientId/instagram with an account', () => {
  it('answers the numbers, the reels, the last scan and the jobs to link', async () => {
    const { repo } = withData();

    const res = await send(dataApp(repo), 'GET', `/api/clients/${CLIENT_ID}/instagram`);

    expect(res.status).toBe(200);
    const body = clientInstagramSchema.parse(await res.json());
    expect(body.account?.handle).toBe('northwind.bakery');
    expect(body.lastScan).toMatchObject({ outcome: 'ok', followers: 1_060, costUsd: 0.12 });
    expect(body.scanning).toBe(false);
    expect(body.nextScanAt).toBe('2026-11-02T06:00:00.000Z');
    expect(body.numbers).toMatchObject({
      range: 'since',
      sinceUs: '2026-10-14',
      tiles: {
        followers: { now: 1_060, thisWeek: 60, sinceUs: 60 },
        playsPerReel: { ours: 9_000, theirs: 3_000, ratio: 3 },
        likesPerReel: { ours: 500, theirs: 100, ratio: 5 },
      },
    });
    expect(body.reels.map((reel) => reel.shortcode)).toEqual(['THEIRS1', 'OURS1']);
    expect(body.reels[1]?.job).toEqual({ id: jobIdOf('Spring menu'), name: 'Spring menu' });
    // Spring menu is linked; Loaf day is the one left to offer.
    expect(body.linkableJobs).toEqual([
      {
        jobId: jobIdOf('Loaf day'),
        name: 'Loaf day',
        deliveredAt: '2026-10-14T09:00:00.000Z',
        stage: 'delivered',
      },
    ]);
  });

  it('takes the range from the query', async () => {
    const { repo } = withData();
    const api = dataApp(repo);

    for (const [range, from] of [
      ['since', '2026-10-14'],
      ['90', '2026-07-29'],
      ['30', '2026-09-27'],
    ] as const) {
      const res = await send(api, 'GET', `/api/clients/${CLIENT_ID}/instagram?range=${range}`);
      expect(res.status, range).toBe(200);
      const body = clientInstagramSchema.parse(await res.json());
      expect(body.numbers?.range).toBe(range);
      expect(body.numbers?.from).toBe(from);
    }
  });

  it('answers the empty shape for another client, and 400 for a bad range as before', async () => {
    const { repo } = withData();
    const api = dataApp(repo);
    const other = clientIdFor('Other Client');

    // The other client is not known to the app: 404; a known one with no account: the empty shape.
    expect((await send(api, 'GET', `/api/clients/${other}/instagram`)).status).toBe(404);
    expect((await send(api, 'GET', `/api/clients/${CLIENT_ID}/instagram?range=7`)).status).toBe(
      400,
    );

    const none = new InstagramRepository(memoryDbOpened());
    const bare = await send(dataApp(none), 'GET', `/api/clients/${CLIENT_ID}/instagram`);
    expect(clientInstagramSchema.parse(await bare.json())).toEqual(noClientInstagram());
  });

  it('shows scanning while a scan is queued', async () => {
    const { repo } = withData();
    const api = dataApp(repo);
    expect(
      clientInstagramSchema.parse(
        await (await send(api, 'GET', `/api/clients/${CLIENT_ID}/instagram`)).json(),
      ).scanning,
    ).toBe(false);

    const queued = createApp({
      instagram: true,
      instagramRoutes: {
        clients: { jobs: { clientNames: () => [CLIENT] }, clientStyles: { get: () => null } },
        instagram: { repo, clock: () => NOW, timeZone: () => 'UTC' },
        // A scan of the client waits in the queue.
        scans: {
          enqueue: () => 'queued',
          restart: () => undefined,
          drop: () => undefined,
          isBusy: () => true,
          isRunning: () => false,
        },
      },
    });
    const res = await send(queued, 'GET', `/api/clients/${CLIENT_ID}/instagram`);
    expect(clientInstagramSchema.parse(await res.json()).scanning).toBe(true);
  });

  it('leaves the scan cost and the jobs to link out of an editor’s answer', async () => {
    const { repo } = withData();
    const dir = mkdtempSync(join(tmpdir(), 'studio-instagram-route-'));
    dirs.push(dir);
    const team = new TeamService(join(dir, 'team.json'));
    team.upsertUser({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
    const api = dataApp(repo, {
      remoteAccess: () => ({ hosts: [MAC], logins: ['owner@example.com'] }),
      team,
      scope: { canSee: () => true, clientOfJob: () => null, clientOfSeries: () => null },
    });
    const get = (login: string) =>
      api.request(
        `http://${MAC}/api/clients/${CLIENT_ID}/instagram`,
        {
          headers: {
            host: MAC,
            'x-forwarded-for': '100.64.0.1',
            'tailscale-user-login': login,
          },
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );

    const editor = await get('yael@example.com');
    const admin = await get('owner@example.com');

    expect(editor.status).toBe(200);
    const editorBody = clientInstagramSchema.parse(await editor.json());
    expect(editorBody.lastScan).toMatchObject({ outcome: 'ok', costUsd: null });
    expect(editorBody.linkableJobs).toEqual([]);
    expect(editorBody.numbers?.tiles.followers.now).toBe(1_060);
    expect(editorBody.reels).toHaveLength(2);

    expect(admin.status).toBe(200);
    const adminBody = clientInstagramSchema.parse(await admin.json());
    expect(adminBody.lastScan?.costUsd).toBe(0.12);
    expect(adminBody.linkableJobs).toHaveLength(1);
  });
});

function memoryDbOpened(): StudioDb {
  const db = memoryDb();
  opened.push(db);
  return db;
}

describe('PUT /api/clients/:clientId/instagram', () => {
  it('says why a handle is no handle, in words', async () => {
    const res = await send(app(true), 'PUT', `/api/clients/${CLIENT_ID}/instagram`, {
      handle: 'falcon fpv',
      since: null,
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json())).toEqual({
      error: 'An Instagram handle has no spaces.',
    });
  });

  it('says 400 for a body that is not the right shape', async () => {
    const api = app(true);
    for (const body of [
      {},
      { since: '2026-09-14' },
      { handle: 7 },
      { handle: 'falcon.fpv', since: 'x' },
    ]) {
      const res = await send(api, 'PUT', `/api/clients/${CLIENT_ID}/instagram`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const noJson = await api.request(`/api/clients/${CLIENT_ID}/instagram`, {
      method: 'PUT',
      body: 'handle=falcon.fpv',
    });
    expect(noJson.status).toBe(400);
    expect(apiErrorSchema.parse(await noJson.json())).toEqual({
      error: INSTAGRAM_MESSAGES.accountBody,
    });
  });

  it('answers 501 for a good body when the routes were given no repository and queue (the real ones are in instagram-account.test.ts)', async () => {
    const res = await send(app(true), 'PUT', `/api/clients/${CLIENT_ID}/instagram`, {
      handle: '@Falcon.FPV',
      since: '2026-09-14',
    });
    expect(res.status).toBe(501);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.notBuilt });
  });
});

describe('the routes that are not built yet', () => {
  it.each([
    ['DELETE', `/api/clients/${CLIENT_ID}/instagram`, undefined],
    ['POST', `/api/clients/${CLIENT_ID}/instagram/scan`, undefined],
    ['POST', '/api/instagram/reels/C9xYz12AbCd/link', { jobId: 'a1b2c3d4e5f6' }],
    ['DELETE', '/api/instagram/reels/C9xYz12AbCd/link', undefined],
  ])('answer 501: %s %s', async (method, path, body) => {
    const res = await send(app(true), method, path, body);
    expect(res.status).toBe(501);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.notBuilt });
  });

  it('say an unknown client is not found', async () => {
    const api = app(true);
    expect((await send(api, 'DELETE', '/api/clients/nosuchclient/instagram')).status).toBe(404);
    expect((await send(api, 'POST', '/api/clients/nosuchclient/instagram/scan')).status).toBe(404);
    expect((await send(api, 'PUT', '/api/clients/nosuchclient/instagram', {})).status).toBe(404);
  });

  it('say 400 for a link with no job', async () => {
    const res = await send(app(true), 'POST', '/api/instagram/reels/C9xYz12AbCd/link', {});
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.linkBody });
  });
});

describe('GET /api/clients/:clientId/photo', () => {
  it('is 404 until a picture is saved', async () => {
    const res = await send(app(true), 'GET', `/api/clients/${CLIENT_ID}/photo`);
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.noPhoto });
  });

  it('says an unknown client is not found', async () => {
    const res = await send(app(true), 'GET', '/api/clients/nosuchclient/photo');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({
      error: 'Client nosuchclient not found',
    });
  });
});

describe('every route while the switch is off', () => {
  it.each([
    ['GET', `/api/clients/${CLIENT_ID}/instagram`],
    ['GET', `/api/clients/${CLIENT_ID}/instagram?range=90`],
    ['PUT', `/api/clients/${CLIENT_ID}/instagram`],
    ['DELETE', `/api/clients/${CLIENT_ID}/instagram`],
    ['POST', `/api/clients/${CLIENT_ID}/instagram/scan`],
    ['GET', `/api/clients/${CLIENT_ID}/photo`],
    ['POST', '/api/instagram/reels/C9xYz12AbCd/link'],
    ['DELETE', '/api/instagram/reels/C9xYz12AbCd/link'],
    ['GET', '/api/clients/nosuchclient/instagram'],
  ])('answers 404 "off": %s %s', async (method, path) => {
    const res = await send(app(false), method, path);
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.off });
  });

  it('answers 404 "off" for an app that was given nothing of Instagram', async () => {
    const res = await createApp().request(`/api/clients/${CLIENT_ID}/instagram`);
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.off });
  });

  it('answers 404 "off" even when the routes were given but the switch is not', async () => {
    const api = createApp({
      instagramRoutes: {
        clients: { jobs: { clientNames: () => [CLIENT] }, clientStyles: { get: () => null } },
      },
    });
    const res = await api.request(`/api/clients/${CLIENT_ID}/instagram`);
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.off });
  });
});
