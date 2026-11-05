import { existsSync } from 'node:fs';
import {
  apiErrorSchema,
  clientInstagramSchema,
  INSTAGRAM_MESSAGES,
  type ServerEvent,
  settingsResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instagramPhotoFor } from './clients/paths.js';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { InstagramRepository } from './db/instagram-repository.js';
import { fakeClock, makeScan, memoryDb } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import { clientIdFor } from './inbox/scan.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { createFakeInstagramScanner, loadFakeInstagramFixtures } from './instagram/fake-scanner.js';
import type { ScanTimers } from './instagram/scan-queue.js';
import { SCAN_MESSAGES } from './instagram/scanner.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Clients × Instagram in the boot composition (IG4): the scan queue exists only while the switch is
// on, checks at start and every 15 minutes, runs the scans one at a time with the fake scanner,
// tells the page, makes a rename or a delete wait, and stops its scan when the engine stops.

const JERUSALEM = 'Asia/Jerusalem';
const at = (iso: string) => Date.parse(iso);

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  vi.unstubAllEnvs();
});

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

/** The interval timers of the check, fired by hand. */
function fakeTimers() {
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers: ScanTimers = {
    setInterval(callback, ms) {
      const id = next++;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
  };
  return {
    timers,
    intervals,
    fire: () => {
      for (const { callback } of [...intervals.values()]) callback();
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const FALCON = 'Falcon FPV';
const FALCON_ID = clientIdFor(FALCON);
const QUIET = 'Quiet Studio';
const QUIET_ID = clientIdFor(QUIET);

/**
 * An engine on a temp home with the Instagram switch as asked, the fake scanner, a clock at Friday
 * 30 Oct 2026 and a client folder for two clients, one with a job added today and one with none.
 */
function boot(
  options: {
    instagram?: boolean;
    env?: Record<string, string>;
    delayMs?: number;
    /** Give the engine no scanner of its own to use: it picks one for its runner (IG13). */
    ownScanner?: boolean;
  } = {},
) {
  const home = makeTempDir('studio-engine-instagram-');
  const config: Config = loadConfig({
    home,
    env: {
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      STUDIO_SETTLE_MS: '300',
      STUDIO_REVIEW: '0',
      STUDIO_INSTAGRAM: options.instagram === false ? '0' : '1',
      ...options.env,
    },
  });
  ensureDirs(config);
  const clock = fakeClock('2026-10-30T10:00:00.000Z');
  const db = memoryDb();
  const instagram = new InstagramRepository(db, { clock });
  const natgeo = loadFakeInstagramFixtures().natgeo;
  if (natgeo === undefined) throw new Error('the natgeo fixture is missing');
  const scanner = createFakeInstagramScanner({
    instagram,
    dataDir: config.dataDir,
    clock,
    delayMs: options.delayMs ?? 0,
    fixtures: {
      'falcon.fpv': { profile: natgeo.profile, reels: [] },
      'quiet.studio': { profile: natgeo.profile, reels: [] },
    },
  });
  const timing = fakeTimers();
  const engine = createEngine({
    config,
    db,
    logger: recordingLogger(),
    clock,
    createRunner: unavailable,
    startInbox: idleInbox,
    builtInLuts: noBuiltInLuts(),
    instagramScan: {
      ...(options.ownScanner === true ? {} : { scanner }),
      timers: timing.timers,
      timeZone: JERUSALEM,
    },
    settings: { configPath: `${config.dataDir}/config.json`, restart: null },
  });
  engines.push(engine);
  const events: ServerEvent[] = [];
  engine.bus.subscribe((event) => events.push(event));
  // Falcon has a job added today, Quiet none; both have a folder.
  engine.clientFolders.seed([FALCON, QUIET]);
  engine.jobs.upsertFromScan(makeScan(FALCON, 'Reel 1'));
  const accountOf = (clientId: string, client: string, handle: string, addedDaysAgo = 100) =>
    instagram.upsertAccount({
      clientId,
      client,
      handle,
      addedAt: clock().getTime() - addedDaysAgo * 86_400_000,
    });
  return { config, clock, db, instagram, engine, timing, events, scanner, accountOf };
}

const scansOf = (t: ReturnType<typeof boot>, clientId: string) => t.instagram.recentScans(clientId);

describe('the switch is off', () => {
  it('has no scan queue: nothing is checked, queued or scanned', async () => {
    const t = boot({ instagram: false });
    t.accountOf(FALCON_ID, FALCON, 'falcon.fpv');

    await t.engine.start();
    t.timing.fire();
    await flush();

    expect(t.engine.instagramScans).toBeNull();
    expect(t.timing.intervals.size).toBe(0);
    expect(scansOf(t, FALCON_ID)).toEqual([]);
    const res = await t.engine.app.request(`/api/clients/${FALCON_ID}/instagram`);
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: INSTAGRAM_MESSAGES.off });
  });
});

describe('the fake runner (IG13)', () => {
  it('scans with the fake scanner and its sample accounts when no scanner is given: no key, no network', async () => {
    // The fake scan's runs take 6 s at speed 1; the engine reads the speed from its own environment.
    vi.stubEnv('STUDIO_FAKE_SPEED', '1000');
    const t = boot({ env: { STUDIO_RUNNER: 'fake' }, ownScanner: true });
    t.accountOf(FALCON_ID, FALCON, 'falcon.fpv');

    await t.engine.start();
    await t.engine.instagramScans?.whenIdle();

    expect(scansOf(t, FALCON_ID)[0]).toMatchObject({
      outcome: 'ok',
      followers: 12_480,
      reelsRead: 22,
    });
    expect(scansOf(t, FALCON_ID)[0]?.apifyRunIds).toEqual(['fake-run-1', 'fake-run-2']);
    expect(existsSync(instagramPhotoFor(t.config.dataDir, FALCON_ID))).toBe(true);
    // The sample accounts that fail say why, in the words of the real failures.
    t.accountOf(QUIET_ID, QUIET, 'no.key', 2);
    t.engine.instagramScans?.enqueue(QUIET_ID, { urgent: true });
    await t.engine.instagramScans?.whenIdle();
    expect(scansOf(t, QUIET_ID)[0]).toMatchObject({ outcome: 'no-token' });
  });
});

describe('the switch is on', () => {
  it('checks at start and scans a client that has an account and was never scanned', async () => {
    const t = boot();
    t.accountOf(FALCON_ID, FALCON, 'falcon.fpv');

    await t.engine.start();
    await t.engine.instagramScans?.whenIdle();

    expect(scansOf(t, FALCON_ID)).toHaveLength(1);
    expect(scansOf(t, FALCON_ID)[0]).toMatchObject({ outcome: 'ok', handle: 'falcon.fpv' });
    expect(existsSync(instagramPhotoFor(t.config.dataDir, FALCON_ID))).toBe(true);
    // The page was told: queued, started, ended.
    const told = t.events.filter(
      (event) => event.type === 'client-instagram' && event.clientId === FALCON_ID,
    );
    expect(told.length).toBeGreaterThanOrEqual(3);
  });

  it('checks every 15 minutes, and scans a client again the Monday after', async () => {
    const t = boot();
    t.accountOf(FALCON_ID, FALCON, 'falcon.fpv');
    await t.engine.start();
    await t.engine.instagramScans?.whenIdle();
    expect([...t.timing.intervals.values()].map((entry) => entry.ms)).toEqual([15 * 60 * 1000]);

    // A check later the same week: nothing.
    t.clock.tick(15 * 60_000);
    t.timing.fire();
    await t.engine.instagramScans?.whenIdle();
    expect(scansOf(t, FALCON_ID)).toHaveLength(1);

    // The Mac slept through Monday 06:00 (04:00Z) and a check on Monday 09:00 scans.
    t.clock.tick(at('2026-11-02T07:00:00Z') - t.clock().getTime());
    t.timing.fire();
    await t.engine.instagramScans?.whenIdle();
    expect(scansOf(t, FALCON_ID)).toHaveLength(2);
  });

  it('skips a client with no job in the last 60 days under Active, and scans it under All', async () => {
    const active = boot();
    active.accountOf(FALCON_ID, FALCON, 'falcon.fpv');
    active.accountOf(QUIET_ID, QUIET, 'quiet.studio');
    await active.engine.start();
    await active.engine.instagramScans?.whenIdle();
    expect(scansOf(active, FALCON_ID)).toHaveLength(1);
    expect(scansOf(active, QUIET_ID)).toEqual([]);

    const all = boot({ env: { STUDIO_INSTAGRAM_CLIENTS: 'all' } });
    all.accountOf(FALCON_ID, FALCON, 'falcon.fpv');
    all.accountOf(QUIET_ID, QUIET, 'quiet.studio');
    await all.engine.start();
    await all.engine.instagramScans?.whenIdle();
    expect(scansOf(all, FALCON_ID)).toHaveLength(1);
    expect(scansOf(all, QUIET_ID)).toHaveLength(1);
  });

  it('still scans an account added in the last 60 days for a client that has no job', async () => {
    const t = boot();
    t.accountOf(QUIET_ID, QUIET, 'quiet.studio', 2);
    await t.engine.start();
    await t.engine.instagramScans?.whenIdle();
    expect(scansOf(t, QUIET_ID)).toHaveLength(1);
  });

  it('leaves alone the account of a client that is gone', async () => {
    const t = boot();
    const gone = clientIdFor('Gone Studio');
    t.accountOf(gone, 'Gone Studio', 'falcon.fpv', 2);
    await t.engine.start();
    await t.engine.instagramScans?.whenIdle();
    expect(scansOf(t, gone)).toEqual([]);
  });

  it('runs a delivery’s client as active too, after the job’s folder is gone', async () => {
    const t = boot();
    t.accountOf(QUIET_ID, QUIET, 'quiet.studio');
    t.engine.deliveries.record({
      jobId: 'gone-job',
      clientId: QUIET_ID,
      client: QUIET,
      name: 'Ad',
      relPath: `${QUIET}/Ad`,
      deliveredAt: t.clock().getTime() - 3 * 86_400_000,
      price: 40,
      currency: 'ILS',
    });
    await t.engine.start();
    await t.engine.instagramScans?.whenIdle();
    expect(scansOf(t, QUIET_ID)).toHaveLength(1);
  });

  it('saves an account through the API, scans it at once and shows it scanning', async () => {
    const t = boot();
    await t.engine.start();

    const res = await t.engine.app.request(`/api/clients/${FALCON_ID}/instagram`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: '@Falcon.FPV', since: '2026-09-14' }),
    });

    expect(res.status).toBe(200);
    const body = clientInstagramSchema.parse(await res.json());
    expect(body.account).toMatchObject({ handle: 'falcon.fpv', since: '2026-09-14' });
    expect(body.scanning).toBe(true);
    expect(body.nextScanAt).toBe('2026-11-02T04:00:00.000Z');
    await t.engine.instagramScans?.whenIdle();
    expect(scansOf(t, FALCON_ID)[0]).toMatchObject({ outcome: 'ok' });
    // The photo it saved is served.
    const photo = await t.engine.app.request(`/api/clients/${FALCON_ID}/photo`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
  });

  it('makes a rename and a delete wait while a scan of the client is queued or running', async () => {
    const t = boot({ delayMs: 60_000 });
    t.accountOf(QUIET_ID, QUIET, 'quiet.studio', 2);
    await t.engine.start();
    await flush();
    expect(t.engine.instagramScans?.isRunning(QUIET_ID)).toBe(true);

    const rename = await t.engine.app.request(`/api/clients/${QUIET_ID}/name`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Quiet Films' }),
    });
    expect(rename.status).toBe(409);
    expect(await rename.json()).toEqual({
      error: 'Wait until the Instagram scan is done to rename this client.',
    });

    const remove = await t.engine.app.request(`/api/clients/${QUIET_ID}`, { method: 'DELETE' });
    expect(remove.status).toBe(409);
    expect(await remove.json()).toEqual({
      error: 'Wait until the Instagram scan is done to delete this client.',
    });
  });

  it('stops the scan that runs when the engine stops, as a scan that does not count', async () => {
    const t = boot({ delayMs: 60_000 });
    t.accountOf(FALCON_ID, FALCON, 'falcon.fpv');
    await t.engine.start();
    await flush();
    expect(t.engine.instagramScans?.isRunning(FALCON_ID)).toBe(true);

    await t.engine.stop();

    expect(t.timing.intervals.size).toBe(0);
    expect(t.engine.instagramScans?.isBusy(FALCON_ID)).toBe(false);
    expect(scansOf(t, FALCON_ID)).toHaveLength(1);
    expect(scansOf(t, FALCON_ID)[0]).toMatchObject({
      outcome: 'failed',
      error: SCAN_MESSAGES.stopped,
    });
  });

  it('does not start a check after the engine stopped', async () => {
    const t = boot();
    t.accountOf(FALCON_ID, FALCON, 'falcon.fpv');
    const starting = t.engine.start();
    await t.engine.stop();
    await starting;
    expect(scansOf(t, FALCON_ID)).toEqual([]);
    expect(t.timing.intervals.size).toBe(0);
  });
});

describe('Which clients in the settings', () => {
  it('is told with the switches, and saved to config.json for the next boot', async () => {
    const t = boot();

    const before = await t.engine.app.request('/api/settings');
    expect(settingsResponseSchema.parse(await before.json()).instagramClients).toEqual({
      running: 'active',
      saved: 'active',
      lockedByEnv: false,
    });

    const saved = await t.engine.app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instagramClients: 'all' }),
    });
    expect(saved.status).toBe(200);
    expect(settingsResponseSchema.parse(await saved.json()).instagramClients).toEqual({
      running: 'active',
      saved: 'all',
      lockedByEnv: false,
    });
  });

  it('runs as the engine booted with it', async () => {
    const t = boot({ env: { STUDIO_INSTAGRAM_CLIENTS: 'all' } });
    const res = await t.engine.app.request('/api/settings');
    expect(settingsResponseSchema.parse(await res.json()).instagramClients).toMatchObject({
      running: 'all',
    });
  });
});
