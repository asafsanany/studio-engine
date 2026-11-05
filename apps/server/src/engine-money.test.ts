import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Job,
  moneyPriceResponseSchema,
  moneyResponseSchema,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import { SseReader } from './events/test-utils.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { moneyFilePath, type WatchDir } from './money/money-file.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { resolveFfmpeg } from './pipeline/fake-media.js';
import { FakeRunner } from './pipeline/fake-runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// Phase 4 M4 in the boot composition: money.json decides the price of a delivery (recorded with
// `engine.recordDelivery`, which the deliver route calls; a job reaching Ready records nothing),
// GET /api/money is mounted on the deliveries and the file, and `money.changed` goes out when a
// delivery is recorded, when money.json changes and when review time is added.

const OUTPUT = { fileName: 'x.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 };

const engines: Engine[] = [];
const readers: SseReader[] = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
  for (const engine of engines.splice(0)) await engine.stop();
});

/** A config on a temp home whose data folder exists, as `ensureDirs` leaves it at boot. */
function tempConfig(): Config {
  const home = makeTempDir('studio-engine-money-');
  // Without Review, so a job that finishes is ready at once (Review is on by default).
  const config = loadConfig({
    home,
    env: {
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      STUDIO_SETTLE_MS: '300',
      STUDIO_REVIEW: '0',
    },
  });
  ensureDirs(config);
  return config;
}

function writeMoney(config: Config, content: unknown): void {
  writeFileSync(
    moneyFilePath(config.dataDir),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

function recordingLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const idleInbox: EngineOptions['startInbox'] = async (): Promise<RunningInbox> => ({
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
});

const unavailable = (): never => {
  throw new RunnerUnavailableError('claude', 'E3');
};

/** A folder watcher the test fires by hand, so no test waits for the platform's file events. */
function fakeWatch() {
  const listeners: ((event: string, filename: string | null) => void)[] = [];
  const state = { dirs: [] as string[], closed: 0 };
  const watchDir: WatchDir = (dir, listener) => {
    state.dirs.push(dir);
    listeners.push(listener);
    return {
      close: () => {
        state.closed += 1;
      },
      on: () => undefined,
    };
  };
  return {
    state,
    watchDir,
    /** The file was saved. */
    touch: () => {
      for (const listener of listeners) listener('change', 'money.json');
    },
  };
}

function boot(config: Config, options: Partial<EngineOptions> = {}): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: recordingLogger(),
    createRunner: unavailable,
    startInbox: idleInbox,
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    ...options,
  });
  engines.push(engine);
  return engine;
}

/** What the bus carries from now on. */
function listen(engine: Engine): ServerEvent[] {
  const seen: ServerEvent[] = [];
  engine.bus.subscribe((event) => seen.push(event));
  return seen;
}

const moneyEvents = (seen: ServerEvent[]) => seen.filter((event) => event.type === 'money.changed');

/** What `GET /api/money` says about money.json right now. */
async function moneyFileOf(engine: Engine) {
  const res = await engine.app.request('/api/money');
  return moneyResponseSchema.parse(await res.json()).moneyFile;
}

/** A job in the database that finished, the way the worker leaves it. */
function finished(engine: Engine, client: string, name: string): Job {
  const { job } = engine.jobs.upsertFromScan(makeScan(client, name));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.jobs.applyTransition(job.id, { type: 'START' });
  return engine.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });
}

/** A job waiting for the owner's review. */
function inReview(engine: Engine, name = 'Spring menu'): Job {
  const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.jobs.applyTransition(job.id, { type: 'START' });
  return engine.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
}

const postReviewTime = (engine: Engine, job: Job, sec: number) =>
  engine.app.request(`/api/jobs/${job.id}/review-time`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sec }),
  });

describe('the price of a delivery comes from money.json', () => {
  it("is the client's own price, else the price per job", async () => {
    const config = tempConfig();
    writeMoney(config, { pricePerJob: 180, clientPrices: { 'Lumen Yoga': 250 } });
    const engine = boot(config);
    const lumen = finished(engine, 'Lumen Yoga', 'Retreat teaser');
    const northwind = finished(engine, 'Northwind Bakery', 'Spring menu');

    await engine.start();
    engine.recordDelivery(lumen);
    engine.recordDelivery(northwind);

    expect(engine.deliveries.get(lumen.id)).toMatchObject({ price: 250, currency: 'ILS' });
    expect(engine.deliveries.get(northwind.id)).toMatchObject({ price: 180, currency: 'ILS' });
  });

  it('is 200 shekels without a money.json', async () => {
    const config = tempConfig();
    const engine = boot(config);
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');

    await engine.start();
    engine.recordDelivery(job);

    expect(engine.deliveries.get(job.id)).toMatchObject({ price: 200, currency: 'ILS' });
  });

  it('is 200 shekels, and says why, when money.json is not valid and nothing good was saved', async () => {
    const config = tempConfig();
    writeMoney(config, '{ "pricePerJob": "a lot" ');
    const logger = recordingLogger();
    const engine = boot(config, { logger });
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');

    await engine.start();
    engine.recordDelivery(job);

    expect(engine.deliveries.get(job.id)).toMatchObject({ price: 200 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: moneyFilePath(config.dataDir) }),
      'money.json is invalid; using defaults (no good version saved)',
    );
  });

  it('prefers a resolver it is given, and the money file is then not asked', async () => {
    const config = tempConfig();
    writeMoney(config, { pricePerJob: 180 });
    const engine = boot(config, { priceFor: () => ({ price: 99, currency: 'ILS' }) });
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');

    await engine.start();
    engine.recordDelivery(job);

    expect(engine.deliveries.get(job.id)).toMatchObject({ price: 99 });
  });
});

const deliver = (engine: Engine, job: Job) =>
  engine.app.request(`/api/jobs/${job.id}/deliver`, { method: 'POST' });

describe('GET /api/money/price on the engine (the phone’s "Sent it to <client>?")', () => {
  const priceOf = async (engine: Engine, client: string) => {
    const res = await engine.app.request(`/api/money/price?client=${encodeURIComponent(client)}`);
    expect(res.status).toBe(200);
    return moneyPriceResponseSchema.parse(await res.json());
  };

  it('says the price Mark delivered then records, from money.json', async () => {
    const config = tempConfig();
    writeMoney(config, { pricePerJob: 180, clientPrices: { 'Lumen Yoga': 40 } });
    const engine = boot(config);
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');
    await engine.start();

    const said = await priceOf(engine, 'Lumen Yoga');
    expect(await deliver(engine, job)).toHaveProperty('status', 200);

    expect(said).toMatchObject({ price: 40, currency: 'ILS' });
    expect(engine.deliveries.get(job.id)).toMatchObject({ price: said.price });
    expect((await priceOf(engine, 'Northwind Bakery')).price).toBe(180);
  });

  it('asks the resolver the engine was given, as a delivery does', async () => {
    const config = tempConfig();
    writeMoney(config, { pricePerJob: 180 });
    const engine = boot(config, { priceFor: () => ({ price: 99, currency: 'ILS' }) });
    await engine.start();

    expect((await priceOf(engine, 'Lumen Yoga')).price).toBe(99);
  });
});

describe('an invalid money.json after a restart (CVP-203)', () => {
  it('prices a delivery from the last good copy, and the Money page shows its numbers', async () => {
    const config = tempConfig();
    const month = new Date().toISOString().slice(0, 7);
    const subscription = {
      id: 'claude',
      name: 'Claude Code',
      amount: 899.9,
      currency: 'ILS',
      every: 'month',
      day: 1,
      since: `${month}-01`,
    };
    writeMoney(config, { pricePerJob: 40, subscriptions: [subscription] });
    boot(config); // reading the good file saves the last good copy

    writeMoney(config, { pricePerJob: 40, subscriptions: [{ ...subscription, day: 99 }] });
    const logger = recordingLogger();
    const engine = boot(config, { logger });
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');
    await engine.start();

    const res = await deliver(engine, job);

    expect(res.status).toBe(200);
    expect(engine.deliveries.get(job.id)).toMatchObject({ price: 40, currency: 'ILS' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: moneyFilePath(config.dataDir) }),
      'money.json is invalid; keeping the last good values (from money.last-good.json)',
    );
    const money = moneyResponseSchema.parse(
      await (await engine.app.request(`/api/money?month=${month}`)).json(),
    );
    expect(money.subscriptions).toEqual([{ id: 'claude', name: 'Claude Code', ils: 899.9 }]);
  });

  it('refuses Mark delivered with a 409 when there is no good version at all, and writes nothing', async () => {
    const config = tempConfig();
    writeMoney(config, '{ "pricePerJob": "a lot" ');
    const engine = boot(config);
    const seen = listen(engine);
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');
    await engine.start();

    const res = await deliver(engine, job);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'money.json is invalid – run pnpm run doctor' });
    expect(engine.deliveries.get(job.id)).toBeNull();
    expect(engine.jobs.get(job.id)?.delivery).toBeNull();
    expect(seen.filter((event) => event.type === 'job.upsert')).toEqual([]);
    expect(moneyEvents(seen)).toEqual([]);
    // The Money page itself still answers, from the defaults.
    expect((await engine.app.request('/api/money')).status).toBe(200);
  });

  it('delivers again, at the fixed price, once money.json is fixed', async () => {
    const config = tempConfig();
    const watch = fakeWatch();
    writeMoney(config, '{ "pricePerJob": "a lot" ');
    const engine = boot(config, { moneyFile: { debounceMs: 5, watchDir: watch.watchDir } });
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');
    await engine.start();
    expect((await deliver(engine, job)).status).toBe(409);

    writeMoney(config, { pricePerJob: 40 });
    watch.touch();
    await vi.waitFor(() => expect(engine.moneyFile.hasGoodValues()).toBe(true));

    expect((await deliver(engine, job)).status).toBe(200);
    expect(engine.deliveries.get(job.id)).toMatchObject({ price: 40 });
  });

  it('does not refuse while the money file is not what prices a delivery', async () => {
    const config = tempConfig();
    writeMoney(config, '{ "pricePerJob": "a lot" ');
    const engine = boot(config, { priceFor: () => ({ price: 99, currency: 'ILS' }) });
    const job = finished(engine, 'Lumen Yoga', 'Retreat teaser');
    await engine.start();

    expect((await deliver(engine, job)).status).toBe(200);
    expect(engine.deliveries.get(job.id)).toMatchObject({ price: 99 });
  });
});

describe('money.json is watched while the engine runs', () => {
  it('tells the Money page when the file changes, and reads the new values', async () => {
    const config = tempConfig();
    const watch = fakeWatch();
    const engine = boot(config, { moneyFile: { debounceMs: 5, watchDir: watch.watchDir } });
    const seen = listen(engine);
    await engine.start();
    expect(watch.state.dirs).toEqual([config.dataDir]);
    expect(engine.moneyFile.get().pricePerJob).toBe(200);

    writeMoney(config, { pricePerJob: 300 });
    watch.touch();

    await vi.waitFor(() => expect(moneyEvents(seen)).toEqual([{ type: 'money.changed' }]));
    expect(engine.moneyFile.get().pricePerJob).toBe(300);
  });

  it('tells it once for a burst of saves, and not again for a save that changes nothing', async () => {
    const config = tempConfig();
    const watch = fakeWatch();
    const engine = boot(config, { moneyFile: { debounceMs: 5, watchDir: watch.watchDir } });
    const seen = listen(engine);
    await engine.start();

    writeMoney(config, { pricePerJob: 300 });
    watch.touch();
    watch.touch();
    watch.touch();
    await vi.waitFor(() => expect(moneyEvents(seen)).toHaveLength(1));

    watch.touch();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(moneyEvents(seen)).toHaveLength(1);
  });

  it('tells the Money page when the file turns invalid and when it is fixed, and keeps the last good values', async () => {
    const config = tempConfig();
    const watch = fakeWatch();
    const logger = recordingLogger();
    writeMoney(config, { pricePerJob: 250 });
    const engine = boot(config, { logger, moneyFile: { debounceMs: 5, watchDir: watch.watchDir } });
    const seen = listen(engine);
    await engine.start();

    // A mistake: the numbers stay, the page's warning line appears (so it is told).
    writeMoney(config, { pricePerJob: -5 });
    watch.touch();
    await vi.waitFor(() => expect(moneyEvents(seen)).toHaveLength(1));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.any(Array) }),
      'money.json is invalid; keeping the last good values',
    );
    expect(engine.moneyFile.get().pricePerJob).toBe(250);
    expect(await moneyFileOf(engine)).toMatchObject({ status: 'last-good' });

    // The same mistake saved again says nothing new.
    watch.touch();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(moneyEvents(seen)).toHaveLength(1);

    // Fixed back to the very numbers it had: the numbers did not change, the warning goes away.
    writeMoney(config, { pricePerJob: 250 });
    watch.touch();
    await vi.waitFor(() => expect(moneyEvents(seen)).toHaveLength(2));
    expect(await moneyFileOf(engine)).toEqual({ status: 'ok', issue: null });
  });

  it('streams the change to the browsers that are connected', async () => {
    const config = tempConfig();
    const watch = fakeWatch();
    const engine = boot(config, { moneyFile: { debounceMs: 5, watchDir: watch.watchDir } });
    await engine.start();
    const reader = new SseReader(await engine.app.request('/api/events'));
    readers.push(reader);
    expect(await reader.event()).toEqual({ type: 'hello' });

    writeMoney(config, { usdToIls: 3.5 });
    watch.touch();

    expect(await reader.event()).toEqual({ type: 'money.changed' });
  });

  it('starts watching with the engine and stops with it', async () => {
    const config = tempConfig();
    const watch = fakeWatch();
    const engine = boot(config, { moneyFile: { debounceMs: 5, watchDir: watch.watchDir } });
    expect(watch.state.dirs).toEqual([]);

    await engine.start();
    expect(watch.state.dirs).toEqual([config.dataDir]);
    expect(watch.state.closed).toBe(0);

    await engine.stop();
    engines.splice(engines.indexOf(engine), 1); // stopped already
    expect(watch.state.closed).toBe(1);
  });

  it('carries on when the data folder cannot be watched', async () => {
    const config = tempConfig();
    const logger = recordingLogger();
    const engine = boot(config, {
      logger,
      moneyFile: {
        watchDir: () => {
          throw new Error('too many open files');
        },
      },
    });

    await expect(engine.start()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'too many open files' }),
      'cannot watch money.json for changes',
    );
  });
});

describe('review time', () => {
  it('tells the Money page after each add', async () => {
    const engine = boot(tempConfig());
    const seen = listen(engine);
    const job = inReview(engine);

    expect((await postReviewTime(engine, job, 15)).status).toBe(200);
    expect((await postReviewTime(engine, job, 15)).status).toBe(200);

    expect(moneyEvents(seen)).toHaveLength(2);
    expect(engine.jobs.getMeta(job.id)?.reviewSec).toBe(30);
  });

  it('says nothing for a request that adds nothing', async () => {
    const engine = boot(tempConfig());
    const seen = listen(engine);
    const job = inReview(engine);
    const ready = finished(engine, 'Northwind Bakery', 'Ready one');

    await postReviewTime(engine, job, 0);
    await postReviewTime(engine, ready, 15);

    expect(moneyEvents(seen)).toEqual([]);
  });

  it('streams it to the browsers that are connected', async () => {
    const engine = boot(tempConfig());
    const job = inReview(engine);
    const reader = new SseReader(await engine.app.request('/api/events'));
    readers.push(reader);
    expect(await reader.event()).toEqual({ type: 'hello' });

    await postReviewTime(engine, job, 15);

    expect(await reader.event()).toEqual({ type: 'money.changed' });
  });
});

describe('GET /api/money on the engine', () => {
  it('says money.json is fine without the file and with a valid one', async () => {
    const config = tempConfig();
    const engine = boot(config);
    expect(await moneyFileOf(engine)).toEqual({ status: 'ok', issue: null });

    writeMoney(config, { pricePerJob: 180 });
    expect(await moneyFileOf(boot(config))).toEqual({ status: 'ok', issue: null });
  });

  it('says the last good numbers are shown, with the first problem, when a restart finds a mistake', async () => {
    const config = tempConfig();
    writeMoney(config, { pricePerJob: 180 });
    boot(config); // saves the last good copy
    writeMoney(config, { pricePerJob: 180, usdToIls: 'high' });

    const engine = boot(config);

    const res = await engine.app.request('/api/money');
    const body = moneyResponseSchema.parse(await res.json());
    expect(body.moneyFile).toEqual({
      status: 'last-good',
      issue: expect.stringMatching(/^usdToIls: /),
    });
    // The numbers are the good file's, not the defaults'.
    expect(engine.moneyFile.get().pricePerJob).toBe(180);
  });

  it('says only the defaults are shown when there is a mistake and no good version', async () => {
    const config = tempConfig();
    writeMoney(config, '{ "pricePerJob": ');

    const engine = boot(config);

    expect(await moneyFileOf(engine)).toEqual({
      status: 'defaults',
      issue: expect.stringMatching(/^cannot be read as JSON/),
    });
  });

  it('works from the deliveries and the money file it was booted with', async () => {
    const config = tempConfig();
    // Both jobs finish now, so the month is the machine's current one.
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    writeMoney(config, {
      clientPrices: { 'Lumen Yoga': 250 },
      subscriptions: [
        {
          id: 'music',
          name: 'Music library',
          amount: 49,
          currency: 'ILS',
          every: 'month',
          day: 8,
          since: `${month}-01`,
        },
      ],
      charges: [
        {
          date: `${month}-09`,
          item: 'Stock footage',
          what: 'Clip licence #1',
          amount: 7.5,
          currency: 'ILS',
          job: 'Lumen Yoga/Retreat teaser',
        },
      ],
    });
    const engine = boot(config);
    const lumen = finished(engine, 'Lumen Yoga', 'Retreat teaser');
    const northwind = finished(engine, 'Northwind Bakery', 'Spring menu');
    await engine.start();
    engine.recordDelivery(lumen);
    engine.recordDelivery(northwind);

    const res = await engine.app.request('/api/money');

    expect(res.status).toBe(200);
    const body = moneyResponseSchema.parse(await res.json());
    expect(body.month).toBe(month);
    expect(body.ledger.map((entry) => [entry.name, entry.income, entry.expenses]).sort()).toEqual([
      ['Retreat teaser', 250, 7.5],
      ['Spring menu', 200, 0],
    ]);
    expect(body.banners.income.value).toBe(450);
    expect(body.banners.expenses.value).toBe(56.5);
    expect(body.banners.profit.value).toBe(393.5);
    expect(body.subscriptions).toEqual([{ id: 'music', name: 'Music library', ils: 49 }]);
    expect((await engine.app.request('/api/money?month=2026-13')).status).toBe(400);
  });
});

// The whole path of a finished edit: the real inbox, the real worker, the fake runner (E7) making
// the edit with ffmpeg, and the real export (E6).
const haveVideoTools =
  (await resolveFfmpeg('ffmpeg')) !== null && (await resolveFfmpeg('ffprobe')) !== null;

describe('a job that reaches Ready while the engine runs', () => {
  it.skipIf(!haveVideoTools)(
    'is not income until it is marked delivered; then it is at the price of money.json, tells the Money page, and shows in this month',
    async () => {
      const config = tempConfig();
      writeMoney(config, { clientPrices: { 'לקוח א': 275 } });
      const jobDir = join(config.inboxPath, 'לקוח א', 'סרטון אביב');
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, 'clip-01.mp4'), 'x');
      writeFileSync(join(jobDir, 'voice.m4a'), 'x');
      const engine = boot(config, {
        startInbox: undefined,
        createRunner: () =>
          new FakeRunner({ inboxPath: config.inboxPath, speed: 100_000, clipSeconds: 1 }),
      });
      const seen = listen(engine);

      await engine.start();
      const deadline = Date.now() + 30_000;
      let job: Job | undefined;
      while (Date.now() < deadline) {
        job = engine.jobs.getAll()[0];
        if (job?.state === 'ready' || job?.state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // Ready is only Approved: no delivery, no income, nothing told to the Money page.
      expect(job?.state).toBe('ready');
      expect(engine.deliveries.get(job?.id ?? '')).toBeNull();
      expect(moneyEvents(seen)).toEqual([]);
      const before = moneyResponseSchema.parse(
        await (await engine.app.request('/api/money')).json(),
      );
      // The job already shows on the page (it costs money before it earns any) but earns nothing.
      expect(before.ledger).toMatchObject([
        { jobId: job?.id, deliveredAt: null, paidOn: null, income: 0 },
      ]);
      expect(before.banners.income.value).toBe(0);
      expect(before.banners.income.unpaid).toEqual({ value: 0, count: 0 });

      // The owner marks it delivered.
      expect(engine.recordDelivery(job as Job)).toBe(true);

      expect(engine.deliveries.get(job?.id ?? '')).toMatchObject({
        client: 'לקוח א',
        price: 275,
        currency: 'ILS',
      });
      expect(moneyEvents(seen)).toEqual([{ type: 'money.changed' }]);

      const body = moneyResponseSchema.parse(await (await engine.app.request('/api/money')).json());
      expect(body.ledger).toHaveLength(1);
      expect(body.ledger[0]).toMatchObject({
        name: 'סרטון אביב',
        client: 'לקוח א',
        income: 275,
        paidOn: null,
      });
      expect(body.banners.income.value).toBe(275);
    },
    60_000,
  );
});
