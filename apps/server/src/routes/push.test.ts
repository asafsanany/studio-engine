import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  DEFAULT_PUSH_EVENTS,
  PUSH_ROUTES,
  type PushDevice,
  pushDeviceSchema,
  pushKeyResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { PushDeviceRepository } from '../db/push-device-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { makeJob } from '../events/test-utils.js';
import { PushSendError } from '../push/push-sender.js';
import { createPushService } from '../push/push-service.js';
import { FAKE_KEYS, FakeSender } from '../push/test-utils.js';
import { createVapidKeyStore, pushKeysPath } from '../push/vapid-keys.js';

// The real routes, repository and service on an in-memory database; the sender is a fake, so no
// real push is sent.

const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ENDPOINT = 'https://web.push.apple.com/phone-secret';
const SUBSCRIPTION = { endpoint: ENDPOINT, keys: FAKE_KEYS };

function setup(publicKey?: () => string) {
  const db = memoryDb();
  opened.push(db);
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-push-routes-'));
  dirs.push(dataDir);
  const devices = new PushDeviceRepository(db);
  const sender = new FakeSender();
  const bus = createEventBus();
  const push = createPushService({ devices, jobs: { getAll: () => [] }, sender });
  push.listen(bus);
  const keys = createVapidKeyStore({
    dataDir,
    generate: () => ({ publicKey: 'BPublicKey', privateKey: 'private' }),
  });
  const app = createApp({
    push: { devices, push, publicKey: publicKey ?? (() => keys.get().publicKey) },
  });

  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const register = async (body: unknown = SUBSCRIPTION): Promise<PushDevice> => {
    const res = await call('POST', PUSH_ROUTES.devices, body, { 'user-agent': IPHONE_UA });
    return pushDeviceSchema.parse(await res.json());
  };
  return { app, devices, sender, bus, push, dataDir, call, register };
}

describe('GET /api/push/key', () => {
  it('answers the VAPID public key, and makes the keys file on first use', async () => {
    const { call, dataDir } = setup();

    const res = await call('GET', PUSH_ROUTES.key);

    expect(res.status).toBe(200);
    expect(pushKeyResponseSchema.parse(await res.json())).toEqual({ publicKey: 'BPublicKey' });
    expect(statSync(pushKeysPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it('never sends the private key', async () => {
    const { call } = setup();
    const text = await (await call('GET', PUSH_ROUTES.key)).text();
    expect(text).not.toContain('private');
  });

  it('answers 503 with the reason when the keys cannot be had', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'studio-push-routes-'));
    dirs.push(dataDir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(pushKeysPath(dataDir), 'broken');
    const keys = createVapidKeyStore({
      dataDir,
      generate: () => ({ publicKey: 'a', privateKey: 'b' }),
    });
    const { call } = setup(() => keys.get().publicKey);

    const res = await call('GET', PUSH_ROUTES.key);

    expect(res.status).toBe(503);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/Notifications are not available/);
  });
});

describe('POST /api/push/devices', () => {
  it('registers a device with the default switches and a label from the user agent', async () => {
    const { call } = setup();

    const res = await call('POST', PUSH_ROUTES.devices, SUBSCRIPTION, { 'user-agent': IPHONE_UA });

    expect(res.status).toBe(201);
    const device = pushDeviceSchema.parse(await res.json());
    expect(device).toMatchObject({ label: 'iPhone', events: DEFAULT_PUSH_EVENTS, lastOkAt: null });
  });

  it('keeps the subscription to itself', async () => {
    const { call } = setup();
    const text = await (await call('POST', PUSH_ROUTES.devices, SUBSCRIPTION)).text();
    expect(text).not.toContain('phone-secret');
    expect(text).not.toContain(FAKE_KEYS.auth);
  });

  it('upserts by endpoint: the same id and switches, 200 instead of 201', async () => {
    const { call, register } = setup();
    const first = await register();
    await call('PUT', PUSH_ROUTES.device(first.id), { events: { queueEmpty: true } });

    const res = await call('POST', PUSH_ROUTES.devices, SUBSCRIPTION, {
      'user-agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)',
    });

    expect(res.status).toBe(200);
    const again = pushDeviceSchema.parse(await res.json());
    expect(again.id).toBe(first.id);
    expect(again.label).toBe('iPad');
    expect(again.events.queueEmpty).toBe(true);
  });

  it('answers 400 for a body that is not a subscription', async () => {
    const { call } = setup();
    for (const body of [
      {},
      { endpoint: ENDPOINT },
      { endpoint: 'http://insecure.example/x', keys: FAKE_KEYS },
      { endpoint: ENDPOINT, keys: { p256dh: 'short', auth: FAKE_KEYS.auth } },
      'text',
    ]) {
      const res = await call('POST', PUSH_ROUTES.devices, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      apiErrorSchema.parse(await res.json());
    }
    const notJson = await setup().app.request(PUSH_ROUTES.devices, { method: 'POST', body: '{' });
    expect(notJson.status).toBe(400);
  });
});

describe('GET /api/push/devices/:id', () => {
  it('answers the device, or 404', async () => {
    const { call, register } = setup();
    const device = await register();

    const found = await call('GET', PUSH_ROUTES.device(device.id));
    expect(found.status).toBe(200);
    expect(pushDeviceSchema.parse(await found.json())).toEqual(device);

    expect((await call('GET', PUSH_ROUTES.device('nope'))).status).toBe(404);
  });
});

describe('PUT /api/push/devices/:id', () => {
  it('changes the switches named and keeps the others', async () => {
    const { call, register } = setup();
    const { id } = await register();

    const res = await call('PUT', PUSH_ROUTES.device(id), {
      events: { queueEmpty: true, badge: false },
    });

    expect(res.status).toBe(200);
    expect(pushDeviceSchema.parse(await res.json()).events).toEqual({
      review: true,
      failed: true,
      approved: true,
      queueEmpty: true,
      badge: false,
    });
    const read = pushDeviceSchema.parse(await (await call('GET', PUSH_ROUTES.device(id))).json());
    expect(read.events.queueEmpty).toBe(true);
  });

  it('makes the new switch count for the next push', async () => {
    const { call, register, bus, sender, push } = setup();
    const { id } = await register();
    await call('PUT', PUSH_ROUTES.device(id), { events: { review: false } });

    bus.publish({ type: 'job.upsert', job: makeJob({ state: 'review' }) });
    await push.settled();

    expect(sender.sent).toEqual([]);
  });

  it('answers 404 for an unknown device and 400 for a body that changes nothing', async () => {
    const { call, register } = setup();
    const { id } = await register();

    expect(
      (await call('PUT', PUSH_ROUTES.device('nope'), { events: { review: false } })).status,
    ).toBe(404);
    for (const body of [
      {},
      { events: {} },
      { events: { review: 'yes' } },
      { events: { sound: true } },
      [],
    ]) {
      const res = await call('PUT', PUSH_ROUTES.device(id), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('DELETE /api/push/devices/:id', () => {
  it('forgets the device, and answers 204 again when it is already gone', async () => {
    const { call, register, devices } = setup();
    const { id } = await register();

    expect((await call('DELETE', PUSH_ROUTES.device(id))).status).toBe(204);
    expect(devices.get(id)).toBeNull();
    expect((await call('DELETE', PUSH_ROUTES.device(id))).status).toBe(204);
  });

  it('stops the pushes to it', async () => {
    const { call, register, bus, sender, push } = setup();
    const { id } = await register();
    await call('DELETE', PUSH_ROUTES.device(id));

    bus.publish({ type: 'job.upsert', job: makeJob({ state: 'review' }) });
    await push.settled();

    expect(sender.sent).toEqual([]);
  });
});

describe('POST /api/push/devices/:id/test', () => {
  it('sends "Test from Studio Engine" to that device and answers 204', async () => {
    const { call, register, sender } = setup();
    const { id } = await register();

    const res = await call('POST', PUSH_ROUTES.test(id));

    expect(res.status).toBe(204);
    expect(sender.to(ENDPOINT)).toEqual([
      {
        title: 'Test from Studio Engine',
        body: 'Notifications are working on this phone.',
        url: '/jobs',
        tag: 'test',
        badge: 0,
      },
    ]);
  });

  it('answers 404 for an unknown device', async () => {
    const { call, sender } = setup();
    expect((await call('POST', PUSH_ROUTES.test('nope'))).status).toBe(404);
    expect(sender.sent).toEqual([]);
  });

  it('answers 410 and forgets the device when the phone dropped its subscription', async () => {
    const { call, register, sender, devices } = setup();
    const { id } = await register();
    sender.failWith(ENDPOINT, new PushSendError('gone', 410));

    const res = await call('POST', PUSH_ROUTES.test(id));

    expect(res.status).toBe(410);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/no longer subscribed/);
    expect(devices.get(id)).toBeNull();
  });

  it('answers 502 and keeps the device when the push service did not take it', async () => {
    const { call, register, sender, devices } = setup();
    const { id } = await register();
    sender.failWith(ENDPOINT, new PushSendError('boom', 500));

    const res = await call('POST', PUSH_ROUTES.test(id));

    expect(res.status).toBe(502);
    expect(devices.get(id)).not.toBeNull();
  });
});

describe('without push wired in', () => {
  it('has no /api/push at all', async () => {
    const res = await createApp().request(PUSH_ROUTES.key);
    expect(res.status).toBe(404);
  });
});
