import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ClientRow,
  type GraphicSummary,
  type Job,
  PUSH_ROUTES,
  type PushDevice,
  type ReviewNote,
  type ServerEvent,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSeries } from '../clients/test-utils.js';
import { ensureDirs, loadConfig } from '../config.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { createEngine, type Engine } from '../engine.js';
import { SseReader } from '../events/test-utils.js';
import { RunnerUnavailableError } from '../pipeline/create-runner.js';
import { FAKE_KEYS, FakeSender } from '../push/test-utils.js';
import { makeTempDir, noBuiltInLuts } from '../test-temp.js';
import { TeamService } from './team-service.js';

// What an editor gets out of the engine (Team plan, TM2): the lists, the live stream and the pushes
// are scoped to their clients, on the whole engine with the real guard, routes and team file.

const MAC = 'studio-mac.tail1234.ts.net';
const YAEL = 'yael@example.com';
const AMIT = 'amit@example.com';
const OWNER = 'owner@example.com';
const OUTPUT = { fileName: 'x.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 };

const engines: Engine[] = [];
const readers: SseReader[] = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
  for (const engine of engines.splice(0)) await engine.stop();
});

type Who = 'admin' | typeof YAEL | typeof AMIT | typeof OWNER;

function boot() {
  const home = makeTempDir('studio-outputs-');
  const config = loadConfig({
    home,
    env: { STUDIO_MUSIC: '1', STUDIO_GRAPHICS: '1', STUDIO_MANUAL_START: '0', STUDIO_REVIEW: '0' },
  });
  ensureDirs(config);
  const team = new TeamService(join(home, 'team.json'));
  team.upsertUser({ email: YAEL, name: 'Yael', role: 'editor' });
  team.upsertUser({ email: AMIT, name: 'Amit', role: 'editor' });
  const sender = new FakeSender();
  const engine = createEngine({
    builtInLuts: noBuiltInLuts(),
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    remoteAccess: () => ({ hosts: [MAC], logins: [OWNER] }),
    team,
    pushSender: sender,
    openFolder: async () => {},
    revealFile: async () => {},
  });
  engines.push(engine);

  const seed = (client: string): Job => {
    mkdirSync(join(config.inboxPath, client), { recursive: true });
    engine.clientFolders.add(client);
    return engine.jobs.upsertFromScan(makeScan(client, 'Edit one')).job;
  };
  const own = seed('Yael Client');
  const other = seed('Amit Client');
  const unassigned = seed('Nobody Client');
  team.setEditors(own.clientId, own.client, [YAEL]);
  team.setEditors(other.clientId, other.client, [AMIT]);
  return { engine, team, app: engine.app, config, sender, own, other, unassigned };
}

const socket = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

function headersOf(who: Who): Record<string, string> {
  if (who === 'admin') return { host: '127.0.0.1:4310' };
  return {
    host: MAC,
    'x-forwarded-for': '100.101.102.103',
    'x-forwarded-host': MAC,
    'x-forwarded-proto': 'https',
    'tailscale-user-login': who,
  };
}

async function call(app: Hono, who: Who, method: string, path: string, body?: unknown) {
  const headers = headersOf(who);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await app.request(`http://${headers.host}${path}`, init, socket);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, json, text };
}

async function connect(app: Hono, who: Who): Promise<SseReader> {
  const headers = headersOf(who);
  const res = await app.request(`http://${headers.host}/api/events`, { headers }, socket);
  expect(res.status).toBe(200);
  const reader = new SseReader(res);
  readers.push(reader);
  expect(await reader.event()).toEqual({ type: 'hello' });
  return reader;
}

const ids = (list: unknown): string[] => (list as { id: string }[]).map((job) => job.id).sort();

describe('the lists', () => {
  it('GET /api/jobs holds an editor’s own jobs only, and the admin’s holds every job', async () => {
    const { app, own, other, unassigned } = boot();

    expect(ids((await call(app, YAEL, 'GET', '/api/jobs')).json)).toEqual([own.id]);
    expect(ids((await call(app, AMIT, 'GET', '/api/jobs')).json)).toEqual([other.id]);
    const all = [own.id, other.id, unassigned.id].sort();
    expect(ids((await call(app, 'admin', 'GET', '/api/jobs')).json)).toEqual(all);
    // The owner’s login (an admin through Serve) sees everything too.
    expect(ids((await call(app, OWNER, 'GET', '/api/jobs')).json)).toEqual(all);
  });

  it('GET /api/clients holds an editor’s own clients only, and says nothing of the others', async () => {
    const { app, own, other, unassigned } = boot();

    const mine = await call(app, YAEL, 'GET', '/api/clients');
    expect((mine.json as ClientRow[]).map((row) => row.clientId)).toEqual([own.clientId]);
    expect(mine.text).not.toContain(other.client);
    expect(mine.text).not.toContain(unassigned.client);

    const admin = await call(app, 'admin', 'GET', '/api/clients');
    expect((admin.json as ClientRow[]).map((row) => row.clientId).sort()).toEqual(
      [own.clientId, other.clientId, unassigned.clientId].sort(),
    );
  });

  it('follows team.json at once: a client assigned to an editor is in their list', async () => {
    const { app, team, unassigned } = boot();
    expect(ids((await call(app, YAEL, 'GET', '/api/jobs')).json)).not.toContain(unassigned.id);
    team.setEditors(unassigned.clientId, unassigned.client, [YAEL]);
    expect(ids((await call(app, YAEL, 'GET', '/api/jobs')).json)).toContain(unassigned.id);
  });

  it('GET /api/deliveries/unpaid-without-job holds the editor’s own videos only', async () => {
    const { app, engine, own, other } = boot();
    for (const job of [own, other]) {
      engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
      engine.jobs.applyTransition(job.id, { type: 'START' });
      engine.recordDelivery(
        engine.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT }),
      );
      engine.jobs.remove(job.id);
    }

    const mine = await call(app, YAEL, 'GET', '/api/deliveries/unpaid-without-job');
    expect((mine.json as { orphans: { id: string }[] }).orphans.map((row) => row.id)).toEqual([
      own.id,
    ]);
    expect(mine.text).not.toContain(other.client);
    const admin = await call(app, 'admin', 'GET', '/api/deliveries/unpaid-without-job');
    expect(
      (admin.json as { orphans: { id: string }[] }).orphans.map((row) => row.id).sort(),
    ).toEqual([own.id, other.id].sort());
  });
});

describe('POST /api/clients by an editor', () => {
  it('makes the client theirs, and it shows in their list', async () => {
    const { app, team } = boot();
    const res = await call(app, YAEL, 'POST', '/api/clients', { name: 'Fresh Client' });
    expect(res.status).toBe(201);
    const { clientId } = res.json as ClientRow;
    expect(team.editorsOf(clientId)).toEqual([YAEL]);
    const list = await call(app, YAEL, 'GET', '/api/clients');
    expect((list.json as ClientRow[]).map((row) => row.clientId)).toContain(clientId);
    // Amit does not see it.
    const theirs = await call(app, AMIT, 'GET', '/api/clients');
    expect((theirs.json as ClientRow[]).map((row) => row.clientId)).not.toContain(clientId);
  });

  it('answers a name that is someone else’s like a name the engine keeps, never as “already there”', async () => {
    const { app, other, unassigned } = boot();
    const reserved = await call(app, YAEL, 'POST', '/api/clients', { name: '_Exports' });
    for (const taken of [other.client, unassigned.client, other.client.toUpperCase()]) {
      const res = await call(app, YAEL, 'POST', '/api/clients', { name: taken });
      expect(res.status, taken).toBe(reserved.status);
      expect(res.json, taken).toEqual({ error: 'That name is kept for the engine. Try another.' });
      expect(res.text).not.toContain('already');
    }
  });

  it('still tells them when the name is one of their own clients', async () => {
    const { app, own } = boot();
    const res = await call(app, YAEL, 'POST', '/api/clients', { name: own.client });
    expect(res.status).toBe(409);
  });

  it('keeps the plain answer for the admin', async () => {
    const { app, other } = boot();
    const res = await call(app, 'admin', 'POST', '/api/clients', { name: other.client });
    expect(res.status).toBe(409);
    expect(res.text).toContain('already');
  });
});

/** Everything the bus could carry about one client's job. */
function aboutJob(job: Job): ServerEvent[] {
  const note: ReviewNote = {
    id: `${job.id}-note`,
    jobId: job.id,
    round: null,
    atSec: 4,
    kind: 'text',
    text: 'Cut the pause',
    audioFile: null,
    audioSec: null,
    transcriptStatus: null,
    addToStyle: false,
    addToSeries: false,
    createdAt: '2026-10-24T10:00:00.000Z',
    sentAt: null,
    routeStatus: null,
    route: null,
    fixId: null,
    fixedAt: null,
  };
  return [
    { type: 'job.upsert', job: { ...job, step: 3 } },
    { type: 'note.upsert', note },
    { type: 'note.remove', jobId: job.id, noteId: note.id },
    { type: 'job.music', jobId: job.id, music: null },
  ];
}

function aboutClient(job: Job): ServerEvent[] {
  return [
    { type: 'client.added', clientId: job.clientId, client: job.client },
    { type: 'client.removed', clientId: job.clientId, client: job.client },
    {
      type: 'client.upsert',
      style: {
        clientId: job.clientId,
        client: job.client,
        state: 'none',
        version: 0,
        updatedAt: null,
        error: null,
        sourceJobId: null,
      },
    },
    {
      type: 'series.changed',
      series: makeSeries({ clientId: job.clientId, client: job.client }),
    },
    { type: 'series.removed', seriesId: 'someseries00', clientId: job.clientId },
  ];
}

const ADMIN_ONLY: ServerEvent[] = [
  { type: 'money.changed' },
  {
    type: 'graphic.changed',
    graphic: {
      id: 'abcdef012345',
      name: 'Lower third',
      kind: 'lower-third',
      lengthSec: 3,
      version: 1,
      uses: true,
      status: 'ready',
      makingVersion: null,
      failedVersion: null,
      updatedAt: '2026-10-24T10:00:00.000Z',
    } satisfies GraphicSummary,
  },
  { type: 'graphic.removed', id: 'abcdef012345' },
];

describe('GET /api/events', () => {
  it('never carries an event about a client that is not the editor’s, with two clients changing at once', async () => {
    const { app, engine, own, other, unassigned } = boot();
    const yael = await connect(app, YAEL);
    const admin = await connect(app, 'admin');

    // Both clients’ jobs change together, in one run of events.
    const mine = [...aboutJob(own), ...aboutClient(own)];
    const theirs = [...aboutJob(other), ...aboutClient(other)];
    const nobodys = [...aboutJob(unassigned), ...aboutClient(unassigned)];
    for (let i = 0; i < mine.length; i += 1) {
      engine.bus.publish(theirs[i] as ServerEvent);
      engine.bus.publish(mine[i] as ServerEvent);
      engine.bus.publish(nobodys[i] as ServerEvent);
    }
    for (const event of ADMIN_ONLY) engine.bus.publish(event);
    engine.bus.publish({ type: 'job.remove', id: other.id });
    engine.bus.publish({ type: 'job.remove', id: own.id });

    expect(await yael.events()).toEqual([...mine, { type: 'job.remove', id: own.id }]);
    // The admin sees everything, in order.
    const seen = await admin.events();
    expect(seen).toHaveLength(mine.length * 3 + ADMIN_ONLY.length + 2);
    expect(seen).toEqual(expect.arrayContaining([...mine, ...theirs, ...nobodys, ...ADMIN_ONLY]));
  });

  it('drops the removal of a job the editor never had, and of a job that is out of their scope', async () => {
    const { app, engine, other } = boot();
    const yael = await connect(app, YAEL);
    engine.bus.publish({ type: 'job.remove', id: other.id });
    engine.bus.publish({ type: 'job.remove', id: 'neverheard00' });
    expect(await yael.events()).toEqual([]);
  });

  it('ends an editor’s stream when access changes, and the next one shows the new set', async () => {
    const { app, engine, team, own, unassigned } = boot();
    const yael = await connect(app, YAEL);
    const admin = await connect(app, 'admin');
    const amit = await connect(app, AMIT);
    expect(ids((await call(app, YAEL, 'GET', '/api/jobs')).json)).toEqual([own.id]);

    team.setEditors(unassigned.clientId, unassigned.client, [YAEL]);
    engine.bus.publish({ type: 'access.changed' });

    // Nothing is sent to the browser: the editors’ streams just end.
    expect(await yael.events()).toEqual([]);
    expect(yael.ended).toBe(true);
    expect(await amit.events()).toEqual([]);
    expect(amit.ended).toBe(true);
    // The admin’s stream stays open, and does not carry access.changed either.
    expect(admin.ended).toBe(false);
    expect(await admin.events()).toEqual([]);

    // The browser connects again: hello, then the lists as they are now.
    const again = await connect(app, YAEL);
    expect(ids((await call(app, YAEL, 'GET', '/api/jobs')).json)).toEqual(
      [own.id, unassigned.id].sort(),
    );
    engine.bus.publish({ type: 'job.upsert', job: { ...unassigned, step: 4 } });
    expect(await again.events()).toEqual([{ type: 'job.upsert', job: { ...unassigned, step: 4 } }]);
  });

  it('ends the stream of an editor whose client is made theirs by creating it', async () => {
    const { app } = boot();
    const yael = await connect(app, YAEL);
    const res = await call(app, YAEL, 'POST', '/api/clients', { name: 'Brand New' });
    expect(res.status).toBe(201);
    await yael.events();
    expect(yael.ended).toBe(true);
  });

  it('ends the stream of an admin who was made an editor, and keeps the owner’s open', async () => {
    const { app, engine, team } = boot();
    team.upsertUser({ email: 'dana@example.com', name: 'Dana', role: 'admin' });
    const headers = {
      ...headersOf(YAEL),
      'tailscale-user-login': 'dana@example.com',
    };
    const res = await app.request(`http://${MAC}/api/events`, { headers }, socket);
    const dana = new SseReader(res);
    readers.push(dana);
    expect(await dana.event()).toEqual({ type: 'hello' });
    const owner = await connect(app, OWNER);

    engine.bus.publish({ type: 'access.changed' });
    expect(await dana.events()).toEqual([]);
    expect(dana.ended).toBe(false);
    expect(await owner.events()).toEqual([]);
    expect(owner.ended).toBe(false);

    team.upsertUser({ email: 'dana@example.com', name: 'Dana', role: 'editor' });
    engine.bus.publish({ type: 'access.changed' });
    await dana.events();
    expect(dana.ended).toBe(true);
    expect(owner.ended).toBe(false);
  });
});

const SUBSCRIPTION = (name: string) => ({
  endpoint: `https://web.push.apple.com/${name}`,
  keys: FAKE_KEYS,
});

async function register(app: Hono, who: Who, name: string): Promise<PushDevice> {
  const res = await call(app, who, 'POST', PUSH_ROUTES.devices, SUBSCRIPTION(name));
  expect(res.status, `${who} registers ${name}`).toBe(201);
  return res.json as PushDevice;
}

describe('the push routes', () => {
  it('lets an editor register and manage their own phone, and gives them the key', async () => {
    const { app } = boot();
    expect((await call(app, YAEL, 'GET', PUSH_ROUTES.key)).status).toBe(200);
    const phone = await register(app, YAEL, 'yael-phone');

    const path = `/api/push/devices/${phone.id}`;
    expect((await call(app, YAEL, 'GET', path)).status).toBe(200);
    const put = await call(app, YAEL, 'PUT', path, { events: { queueEmpty: true } });
    expect(put.status).toBe(200);
    expect((put.json as PushDevice).events.queueEmpty).toBe(true);
    expect((await call(app, YAEL, 'POST', `${path}/test`)).status).toBe(204);
    expect((await call(app, YAEL, 'DELETE', path)).status).toBe(204);
    expect((await call(app, YAEL, 'GET', path)).status).toBe(404);
  });

  it('answers 404 for another editor’s phone and for the admin’s, and changes nothing', async () => {
    const { app } = boot();
    const yaels = await register(app, YAEL, 'yael-phone');
    const owners = await register(app, 'admin', 'owner-phone');

    const ownersPath = `/api/push/devices/${owners.id}`;
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['PUT', '', { events: { review: false } }],
      ['DELETE', '', undefined],
      ['POST', '/test', undefined],
    ] as const) {
      const res = await call(app, YAEL, method, ownersPath + suffix, body);
      expect(res.status, `${method} ${ownersPath}${suffix}`).toBe(404);
    }
    // Still there, unchanged.
    const still = await call(app, 'admin', 'GET', ownersPath);
    expect((still.json as PushDevice).events.review).toBe(true);
    // Amit cannot reach Yael’s phone either; the admin can.
    const path = `/api/push/devices/${yaels.id}`;
    expect((await call(app, AMIT, 'GET', path)).status).toBe(404);
    expect((await call(app, AMIT, 'DELETE', path)).status).toBe(404);
    expect((await call(app, 'admin', 'GET', path)).status).toBe(200);
  });

  it('does not let an editor take over a phone by registering its endpoint', async () => {
    const { app } = boot();
    const owners = await register(app, 'admin', 'owner-phone');
    const res = await call(app, YAEL, 'POST', PUSH_ROUTES.devices, SUBSCRIPTION('owner-phone'));
    expect(res.status).toBe(409);
    expect((await call(app, 'admin', 'GET', `/api/push/devices/${owners.id}`)).status).toBe(200);
    // Registering their own again is fine and keeps the id.
    const yaels = await register(app, YAEL, 'yael-phone');
    const again = await call(app, YAEL, 'POST', PUSH_ROUTES.devices, SUBSCRIPTION('yael-phone'));
    expect(again.status).toBe(200);
    expect((again.json as PushDevice).id).toBe(yaels.id);
  });

  it('keeps the admin’s power over every phone', async () => {
    const { app } = boot();
    const yaels = await register(app, YAEL, 'yael-phone');
    const path = `/api/push/devices/${yaels.id}`;
    expect((await call(app, 'admin', 'GET', path)).status).toBe(200);
    expect((await call(app, 'admin', 'PUT', path, { events: { badge: false } })).status).toBe(200);
    expect((await call(app, 'admin', 'DELETE', path)).status).toBe(204);
  });
});

describe('the pushes', () => {
  const review = (job: Job): ServerEvent => ({
    type: 'job.upsert',
    job: { ...job, state: 'review', runKind: 'edit' },
  });

  it('go to an editor’s phone for their own jobs only, to the admin’s for all', async () => {
    const { app, engine, sender, own, other, unassigned } = boot();
    const yaels = await register(app, YAEL, 'yael-phone');
    const owners = await register(app, 'admin', 'owner-phone');
    const amits = await register(app, AMIT, 'amit-phone');
    expect([yaels.id, owners.id, amits.id]).toHaveLength(3);

    engine.bus.publish(review(other));
    engine.bus.publish(review(unassigned));
    engine.bus.publish(review(own));
    await engine.push.settled();

    const to = (name: string) => sender.to(`https://web.push.apple.com/${name}`);
    const jobsOf = (name: string) => to(name).map((payload) => payload.tag);
    expect(jobsOf('yael-phone')).toEqual([own.id]);
    expect(jobsOf('amit-phone')).toEqual([other.id]);
    expect(jobsOf('owner-phone').sort()).toEqual([own.id, other.id, unassigned.id].sort());
    // Nothing of the other clients in what Yael’s phone was sent.
    expect(JSON.stringify(to('yael-phone'))).not.toContain(other.client);
    expect(JSON.stringify(to('yael-phone'))).not.toContain(unassigned.client);
  });

  it('follow an assignment change, and stop for someone removed from the team', async () => {
    const { app, engine, team, sender, own, unassigned } = boot();
    await register(app, YAEL, 'yael-phone');
    const to = () => sender.to('https://web.push.apple.com/yael-phone');

    engine.bus.publish(review(unassigned));
    await engine.push.settled();
    expect(to()).toHaveLength(0);

    team.setEditors(unassigned.clientId, unassigned.client, [YAEL]);
    engine.bus.publish({ type: 'job.upsert', job: { ...unassigned, state: 'editing' } });
    engine.bus.publish(review(unassigned));
    await engine.push.settled();
    expect(to()).toHaveLength(1);

    team.removeUser(YAEL);
    engine.bus.publish({ type: 'job.upsert', job: { ...own, state: 'editing' } });
    engine.bus.publish(review(own));
    await engine.push.settled();
    expect(to()).toHaveLength(1);
  });
});

// Money is the admin's alone (C41): the Job objects an editor gets carry the date of a delivery and
// nothing else of it. The admin's carry all five fields.
describe('money in the Job objects', () => {
  const MONEY_KEYS = ['price', 'currency', 'paidOn', 'paidAmount'];

  /** Yael's job, ready, delivered and paid, through the admin's own routes. */
  async function deliveredAndPaid() {
    const set = boot();
    const { app, engine, own } = set;
    engine.jobs.applyTransition(own.id, { type: 'SETTLED' });
    engine.jobs.applyTransition(own.id, { type: 'START' });
    engine.jobs.applyTransition(own.id, { type: 'SUCCEED', output: OUTPUT });
    expect((await call(app, 'admin', 'POST', `/api/jobs/${own.id}/deliver`, {})).status).toBe(200);
    const paid = await call(app, 'admin', 'POST', '/api/payments', {
      jobIds: [own.id],
      paidOn: '2026-10-25',
    });
    expect(paid.status).toBe(200);
    return set;
  }

  const deliveryOf = (json: unknown): Record<string, unknown> =>
    (json as { delivery: Record<string, unknown> }).delivery;

  it('GET /api/jobs leaves the price, currency and pay date out for an editor, and keeps them for the admin', async () => {
    const { app, own } = await deliveredAndPaid();

    const mine = (await call(app, YAEL, 'GET', '/api/jobs')).json as Job[];
    const delivery = deliveryOf(mine.find((job) => job.id === own.id));
    expect(Object.keys(delivery)).toEqual(['deliveredAt']);
    expect(typeof delivery.deliveredAt).toBe('string');

    const all = (await call(app, 'admin', 'GET', '/api/jobs')).json as Job[];
    const whole = deliveryOf(all.find((job) => job.id === own.id));
    expect(Object.keys(whole).sort()).toEqual([
      'currency',
      'deliveredAt',
      'paidAmount',
      'paidOn',
      'price',
    ]);
    expect(whole.paidOn).toBe('2026-10-25');
    expect(whole.deliveredAt).toBe(delivery.deliveredAt);
  });

  it('archive and unarchive answer an editor with the same jobs, without money', async () => {
    const { app, own } = await deliveredAndPaid();

    const archived = await call(app, YAEL, 'POST', '/api/jobs/archive', { ids: [own.id] });
    expect(archived.status).toBe(200);
    expect(Object.keys(deliveryOf((archived.json as { jobs: Job[] }).jobs[0]))).toEqual([
      'deliveredAt',
    ]);
    const back = await call(app, YAEL, 'POST', '/api/jobs/unarchive', { ids: [own.id] });
    expect(Object.keys(deliveryOf((back.json as { jobs: Job[] }).jobs[0]))).toEqual([
      'deliveredAt',
    ]);
    // The admin gets all five from the same routes.
    const adminSide = await call(app, 'admin', 'POST', '/api/jobs/archive', { ids: [own.id] });
    expect(Object.keys(deliveryOf((adminSide.json as { jobs: Job[] }).jobs[0])).sort()).toEqual([
      'currency',
      'deliveredAt',
      'paidAmount',
      'paidOn',
      'price',
    ]);
  });

  it('the live stream carries no money to an editor, whatever the bus holds, and all of it to the admin', async () => {
    const { app, engine, own } = await deliveredAndPaid();
    const yael = await connect(app, YAEL);
    const admin = await connect(app, 'admin');

    // The bus carries the whole job, as the routes publish it.
    const job = engine.jobs.get(own.id) as Job;
    expect(job.delivery?.price).toBeGreaterThan(0);
    engine.bus.publish({ type: 'job.upsert', job });

    const [yaelSaw] = await yael.events();
    const sent = yaelSaw as { type: string; job: Job };
    expect(sent.type).toBe('job.upsert');
    expect(sent.job.delivery).toEqual({ deliveredAt: job.delivery?.deliveredAt });
    const [adminSaw] = await admin.events();
    expect(adminSaw).toEqual({ type: 'job.upsert', job });
  });

  it('a held (coalesced) upsert is stripped too', async () => {
    const { app, engine, own } = await deliveredAndPaid();
    const yael = await connect(app, YAEL);
    const job = engine.jobs.get(own.id) as Job;
    // Two upserts inside one window: the second is held and goes out when the window ends.
    engine.bus.publish({ type: 'job.upsert', job });
    engine.bus.publish({ type: 'job.upsert', job: { ...job, step: 3 } });
    const seen = await yael.events(600);
    expect(seen).toHaveLength(2);
    for (const event of seen) {
      const text = JSON.stringify(event);
      for (const key of MONEY_KEYS) expect(text).not.toContain(`"${key}"`);
    }
  });

  it('GET /api/deliveries/unpaid-without-job leaves the price out for an editor', async () => {
    const { app, engine, own } = boot();
    engine.jobs.applyTransition(own.id, { type: 'SETTLED' });
    engine.jobs.applyTransition(own.id, { type: 'START' });
    engine.recordDelivery(engine.jobs.applyTransition(own.id, { type: 'SUCCEED', output: OUTPUT }));
    engine.jobs.remove(own.id);

    const mine = await call(app, YAEL, 'GET', '/api/deliveries/unpaid-without-job');
    const orphans = (mine.json as { orphans: { delivery: Record<string, unknown> }[] }).orphans;
    expect(orphans).toHaveLength(1);
    expect(Object.keys(orphans[0]?.delivery ?? {})).toEqual(['deliveredAt']);
    const whole = await call(app, 'admin', 'GET', '/api/deliveries/unpaid-without-job');
    const wholeOrphans = (whole.json as { orphans: { delivery: Record<string, unknown> }[] })
      .orphans;
    expect(Object.keys(wholeOrphans[0]?.delivery ?? {}).sort()).toEqual([
      'currency',
      'deliveredAt',
      'paidAmount',
      'paidOn',
      'price',
    ]);
  });
});
