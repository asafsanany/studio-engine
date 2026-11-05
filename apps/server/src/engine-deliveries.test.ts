import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Job, jobStage, type ServerEvent } from '@studio/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from './config.js';
import { fakeClock, makeScan, memoryDb } from './db/test-utils.js';
import type { PriceFor } from './deliveries/deliveries.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { resolveFfmpeg } from './pipeline/fake-media.js';
import { FakeRunner } from './pipeline/fake-runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// CVP-171 in the boot composition: a job that reaches Ready is only Approved. The engine writes no
// delivery then and backfills none on start; a delivery exists only once `recordDelivery` (what the
// deliver route calls) stored it, with the price `priceFor` gives, and a job reads it as
// `Job.delivery`.

const OUTPUT = { fileName: 'x.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 };

let home: string;
let config: Config;

beforeAll(() => {
  home = makeTempDir('studio-engine-deliveries-');
  // Review is on by default (W15); a delivery is made when a job reaches Ready, so it is off here.
  config = loadConfig({
    home,
    env: {
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      STUDIO_SETTLE_MS: '300',
      STUDIO_REVIEW: '0',
    },
  });
});

function recordingLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeRunningInbox(): RunningInbox {
  return {
    watcher: {} as InboxWatcher,
    summary: {
      created: 0,
      changed: 0,
      removed: 0,
      settled: 0,
      failedMissingExport: 0,
      failedMissingPreview: 0,
      failedFolderRemoved: 0,
      resuming: 0,
      unchanged: 0,
    },
    stop: async () => {},
  };
}

/** An inbox that does nothing: these tests must not start a real file watcher. */
const idleInbox: EngineOptions['startInbox'] = async () => fakeRunningInbox();

const unavailable = (): never => {
  throw new RunnerUnavailableError('claude', 'E3');
};

/** A job in the database that finished, the way the worker leaves it. */
function finished(engine: Engine, client: string, name: string): Job {
  const { job } = engine.jobs.upsertFromScan(makeScan(client, name));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.jobs.applyTransition(job.id, { type: 'START' });
  return engine.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });
}

describe('no delivery without Mark delivered', () => {
  it('writes none for the ready jobs of a database on start: no backfill', async () => {
    const logger = recordingLogger();
    const priceFor = vi.fn<PriceFor>(() => ({ price: 200, currency: 'ILS' }));
    const engine = createEngine({
      builtInLuts: noBuiltInLuts(),
      config,
      db: memoryDb(),
      logger,
      createRunner: unavailable,
      startInbox: idleInbox,
      priceFor,
    });
    const first = finished(engine, 'Northwind Bakery', 'Spring menu');
    const second = finished(engine, 'Lumen Yoga', 'Retreat teaser');

    await engine.start();
    await engine.stop();

    expect(engine.deliveries.list()).toEqual([]);
    expect(engine.jobs.get(first.id)?.delivery).toBeNull();
    expect(engine.jobs.get(second.id)?.delivery).toBeNull();
    expect(priceFor).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('backfilled'),
    );
  });

  it('keeps the deliveries it finds as they are, and still adds none for the other ready jobs', async () => {
    const db = memoryDb();
    const bootOn = () =>
      createEngine({
        builtInLuts: noBuiltInLuts(),
        config,
        db,
        logger: recordingLogger(),
        createRunner: unavailable,
        startInbox: idleInbox,
      });
    const first = bootOn();
    const delivered = finished(first, 'Northwind Bakery', 'Delivered');
    const approved = finished(first, 'Northwind Bakery', 'Approved only');
    first.recordDelivery(delivered);
    const row = first.deliveries.get(delivered.id);

    const second = bootOn();
    await second.start();
    await second.stop();

    expect(second.deliveries.list()).toEqual([row]);
    expect(second.jobs.get(approved.id)?.delivery).toBeNull();
    expect(second.jobs.get(delivered.id)?.delivery).toMatchObject({ price: 200, paidOn: null });
  });
});

describe('recordDelivery', () => {
  it('stores the delivery with the price priceFor gives for the client, and tells the Money page', async () => {
    const clock = fakeClock();
    const priceFor = vi.fn<PriceFor>((client) => ({
      price: client === 'Lumen Yoga' ? 250 : 200,
      currency: 'ILS',
    }));
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable,
      startInbox: idleInbox,
      priceFor,
      clock,
    });
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');
    const seen: ServerEvent[] = [];
    engine.bus.subscribe((event) => seen.push(event));
    clock.tick(3_600_000);

    expect(engine.recordDelivery(job)).toBe(true);

    expect(priceFor).toHaveBeenCalledWith('Lumen Yoga');
    expect(engine.deliveries.get(job.id)).toEqual({
      jobId: job.id,
      clientId: job.clientId,
      client: 'Lumen Yoga',
      name: 'Retreat teaser',
      relPath: 'Lumen Yoga/Retreat teaser',
      deliveredAt: clock().getTime(),
      price: 250,
      currency: 'ILS',
      reviewSec: 0,
      paidOn: null,
      paidAmount: null,
    });
    expect(engine.jobs.get(job.id)?.delivery).toEqual({
      deliveredAt: clock().toISOString(),
      price: 250,
      currency: 'ILS',
      paidOn: null,
      paidAmount: null,
    });
    expect(seen.filter((event) => event.type === 'money.changed')).toHaveLength(1);
  });

  it('uses 200 ILS when no resolver is injected', () => {
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable,
      startInbox: idleInbox,
    });
    const job = finished(engine, 'Northwind Bakery', 'Spring menu');

    engine.recordDelivery(job);

    expect(engine.deliveries.get(job.id)).toMatchObject({ price: 200, currency: 'ILS' });
  });

  it('keeps the first time and price when the job is recorded again, and says nothing', () => {
    let price = 200;
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable,
      startInbox: idleInbox,
      priceFor: () => ({ price, currency: 'ILS' }),
    });
    const job = finished(engine, 'Northwind Bakery', 'Spring menu');
    engine.recordDelivery(job);
    const row = engine.deliveries.get(job.id);
    const seen: ServerEvent[] = [];
    engine.bus.subscribe((event) => seen.push(event));

    price = 350;

    expect(engine.recordDelivery(job)).toBe(false);
    expect(engine.deliveries.get(job.id)).toEqual(row);
    expect(seen).toEqual([]);
  });

  it('keeps the delivery when the job is removed', () => {
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable,
      startInbox: idleInbox,
    });
    const job = finished(engine, 'Northwind Bakery', 'Spring menu');
    engine.recordDelivery(job);
    const row = engine.deliveries.get(job.id);

    engine.jobs.remove(job.id);

    expect(engine.jobs.get(job.id)).toBeNull();
    expect(engine.deliveries.get(job.id)).toEqual(row);
  });
});

describe('the delivery routes in the boot composition', () => {
  function bootWithRoutes() {
    const engine = createEngine({
      config,
      db: memoryDb(),
      logger: recordingLogger(),
      createRunner: unavailable,
      startInbox: idleInbox,
      priceFor: () => ({ price: 40, currency: 'ILS' }),
    });
    const seen: ServerEvent[] = [];
    engine.bus.subscribe((event) => seen.push(event));
    const post = (path: string, body?: unknown) =>
      engine.app.request(path, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    return { engine, seen, post };
  }

  it('Mark delivered writes the delivery and publishes the job, then money.changed, once', async () => {
    const { engine, seen, post } = bootWithRoutes();
    const job = finished(engine, 'Northwind Bakery', 'Spring menu');
    seen.length = 0;

    const res = await post(`/api/jobs/${job.id}/deliver`);

    expect(res.status).toBe(200);
    expect(engine.deliveries.get(job.id)).toMatchObject({
      price: 40,
      currency: 'ILS',
      paidOn: null,
    });
    expect(seen.map((event) => event.type)).toEqual(['job.upsert', 'money.changed']);
    const [upserted] = seen;
    expect(upserted?.type === 'job.upsert' && jobStage(upserted.job)).toBe('delivered');
  });

  it('Mark paid, Not paid yet and Not delivered yet each publish the jobs, then money.changed', async () => {
    const { engine, seen, post } = bootWithRoutes();
    const first = finished(engine, 'Northwind Bakery', 'One');
    const second = finished(engine, 'Northwind Bakery', 'Two');
    await post(`/api/jobs/${first.id}/deliver`);
    await post(`/api/jobs/${second.id}/deliver`);
    seen.length = 0;

    const paid = await post('/api/payments', {
      jobIds: [first.id, second.id],
      paidOn: '2026-10-23',
    });
    expect(paid.status).toBe(200);
    expect(seen.map((event) => event.type)).toEqual(['job.upsert', 'job.upsert', 'money.changed']);
    expect(jobStage(engine.jobs.get(first.id) as Job)).toBe('paid');

    seen.length = 0;
    const unpaid = await post('/api/payments/undo', { jobIds: [first.id, second.id] });
    expect(unpaid.status).toBe(200);
    expect(seen.map((event) => event.type)).toEqual(['job.upsert', 'job.upsert', 'money.changed']);

    seen.length = 0;
    const undelivered = await post(`/api/jobs/${first.id}/undeliver`);
    expect(undelivered.status).toBe(200);
    expect(seen.map((event) => event.type)).toEqual(['job.upsert', 'money.changed']);
    expect(jobStage(engine.jobs.get(first.id) as Job)).toBe('approved');
    expect(jobStage(engine.jobs.get(second.id) as Job)).toBe('delivered');
  });

  it('a refused request publishes nothing', async () => {
    const { engine, seen, post } = bootWithRoutes();
    const job = finished(engine, 'Northwind Bakery', 'Spring menu');
    seen.length = 0;

    const res = await post('/api/payments', { jobIds: [job.id], paidOn: '2026-10-23' });

    expect(res.status).toBe(409);
    expect(seen).toEqual([]);
  });
});

// The whole path of a finished edit: the real inbox, the real worker, the fake runner (E7) making
// the edit with ffmpeg, and the real export (E6).
const haveVideoTools =
  (await resolveFfmpeg('ffmpeg')) !== null && (await resolveFfmpeg('ffprobe')) !== null;

describe('a job that reaches Ready while the engine runs', () => {
  it.skipIf(!haveVideoTools)(
    'is only Approved: no delivery until one is recorded, and then it reads as the job’s delivery',
    async () => {
      const realHome = makeTempDir('studio-engine-delivery-');
      // The job reaches Ready from the edit itself, so Review is off (it is on by default).
      const realConfig = loadConfig({
        home: realHome,
        env: {
          STUDIO_MANUAL_START: '0',
          STUDIO_KNOWN_CLIENTS_ONLY: '0',
          STUDIO_SETTLE_MS: '300',
          STUDIO_REVIEW: '0',
        },
      });
      const jobDir = join(realConfig.inboxPath, 'לקוח א', 'סרטון אביב');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, 'clip-01.mp4'), 'x');
      writeFileSync(join(jobDir, 'voice.m4a'), 'x');
      const priceFor = vi.fn<PriceFor>(() => ({ price: 250, currency: 'ILS' }));
      const engine = createEngine({
        builtInLuts: noBuiltInLuts(),
        config: realConfig,
        db: memoryDb(),
        logger: recordingLogger(),
        createRunner: () =>
          new FakeRunner({ inboxPath: realConfig.inboxPath, speed: 100_000, clipSeconds: 1 }),
        priceFor,
      });

      await engine.start();
      try {
        const deadline = Date.now() + 30_000;
        let job: Job | undefined;
        while (Date.now() < deadline) {
          job = engine.jobs.getAll()[0];
          if (job?.state === 'ready' || job?.state === 'failed') break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(job?.state).toBe('ready');
        const ready = job as Job;

        // Ready is Approved: nothing was recorded, and nobody asked for a price.
        expect(engine.deliveries.list()).toEqual([]);
        expect(ready.delivery).toBeNull();
        expect(jobStage(ready)).toBe('approved');
        expect(priceFor).not.toHaveBeenCalled();
        expect(engine.jobs.get(ready.id)?.delivery).toBeNull();

        // The owner marks it delivered.
        expect(engine.recordDelivery(ready)).toBe(true);
        expect(priceFor).toHaveBeenCalledWith('לקוח א');
        const delivery = engine.deliveries.get(ready.id);
        expect(delivery).toMatchObject({
          clientId: ready.clientId,
          client: 'לקוח א',
          name: 'סרטון אביב',
          relPath: 'לקוח א/סרטון אביב',
          price: 250,
          currency: 'ILS',
          reviewSec: 0,
          paidOn: null,
        });
        expect(Math.abs((delivery?.deliveredAt ?? 0) - Date.now())).toBeLessThan(60_000);
        const delivered = engine.jobs.get(ready.id) as Job;
        expect(jobStage(delivered)).toBe('delivered');
        expect(delivered.delivery).toMatchObject({ price: 250, currency: 'ILS', paidOn: null });

        // The job goes (its folder was removed); the delivery stays.
        engine.jobs.remove(ready.id);
        expect(engine.deliveries.get(ready.id)).toEqual(delivery);
      } finally {
        await engine.stop();
      }
    },
    60_000,
  );
});
