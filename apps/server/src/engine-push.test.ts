import { existsSync } from 'node:fs';
import { PUSH_ROUTES, pushDeviceSchema, pushKeyResponseSchema } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureDirs, loadConfig } from './config.js';
import { JobRepository } from './db/index.js';
import { memoryDb } from './db/test-utils.js';
import { createEngine, type Engine } from './engine.js';
import { makeJob } from './events/test-utils.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { FAKE_KEYS, FakeSender } from './push/test-utils.js';
import { pushKeysPath } from './push/vapid-keys.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// Web push in the boot composition (PH11): the routes, the device list and the push service share
// one engine. The sender is a fake, so no real push is sent; the keys go to a temp data folder.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function boot(db = memoryDb(), pushSender: FakeSender = new FakeSender()) {
  const home = makeTempDir('studio-engine-push-');
  const config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' },
  });
  ensureDirs(config);
  const engine = createEngine({
    config,
    db,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    startInbox: async () =>
      ({
        watcher: {} as InboxWatcher,
        summary: {},
        stop: async () => {},
      }) as unknown as RunningInbox,
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    pushSender,
  });
  engines.push(engine);
  return { config, engine, pushSender };
}

const SUBSCRIPTION = { endpoint: 'https://web.push.apple.com/phone', keys: FAKE_KEYS };

async function registerPhone(engine: Engine) {
  const res = await engine.app.request(PUSH_ROUTES.devices, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(SUBSCRIPTION),
  });
  expect(res.status).toBe(201);
  return pushDeviceSchema.parse(await res.json());
}

describe('web push in the engine', () => {
  it('writes no keys until a key or a push is asked for', async () => {
    const { config, engine } = boot();
    await engine.start();

    expect(existsSync(pushKeysPath(config.dataDir))).toBe(false);

    const res = await engine.app.request(PUSH_ROUTES.key);
    expect(res.status).toBe(200);
    expect(pushKeyResponseSchema.parse(await res.json()).publicKey).toMatch(/^[\w-]{87}$/);
    expect(existsSync(pushKeysPath(config.dataDir))).toBe(true);
  });

  it('sends a push to a registered phone when a job on the bus enters Review', async () => {
    const { engine, pushSender } = boot();
    await engine.start();
    await registerPhone(engine);

    engine.bus.publish({ type: 'job.upsert', job: makeJob({ state: 'editing' }) });
    engine.bus.publish({ type: 'job.upsert', job: makeJob({ state: 'review' }) });
    await engine.push.settled();

    expect(pushSender.to(SUBSCRIPTION.endpoint)).toEqual([
      {
        title: 'Ready to review',
        body: 'Spring menu · Northwind Bakery',
        url: '/jobs?job=a1b2c3d4e5f6&review=1',
        tag: 'a1b2c3d4e5f6',
        badge: 1,
      },
    ]);
  });

  it('knows the jobs in the database: one already in Review is not news at start', async () => {
    const db = memoryDb();
    new JobRepository(db).upsertFromScan({
      id: 'abcdef012345',
      client: 'Northwind Bakery',
      name: 'Spring menu',
      relPath: 'Northwind Bakery/Spring menu',
      inputs: { video: 1, audio: 0, image: 0, doc: 0 },
      sizeBytes: 1,
      footageSec: 1,
      newestMtimeMs: 1,
    });
    db.sqlite.prepare("update jobs set state = 'review' where id = 'abcdef012345'").run();
    const { engine, pushSender } = boot(db);
    await engine.start();
    await registerPhone(engine);
    const waiting = engine.jobs.get('abcdef012345');
    expect(waiting?.state).toBe('review');

    // What the boot's reconcile publishes for a job it finds again.
    engine.bus.publish({ type: 'job.upsert', job: waiting ?? makeJob() });
    await engine.push.settled();

    expect(pushSender.sent).toEqual([]);
  });

  it('stops listening when the engine stops', async () => {
    const { engine, pushSender } = boot();
    await engine.start();
    await registerPhone(engine);

    await engine.stop();
    engine.bus.publish({ type: 'job.upsert', job: makeJob({ state: 'review' }) });
    await engine.push.settled();

    expect(pushSender.sent).toEqual([]);
  });

  it('sends the test push through the route', async () => {
    const { engine, pushSender } = boot();
    await engine.start();
    const device = await registerPhone(engine);

    const res = await engine.app.request(PUSH_ROUTES.test(device.id), { method: 'POST' });

    expect(res.status).toBe(204);
    expect(pushSender.to(SUBSCRIPTION.endpoint)[0]?.title).toBe('Test from Studio Engine');
  });
});
