import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { disabledSeriesService, seriesOk } from '../clients/series-service.js';
import { fakeSeriesService, makeSeries } from '../clients/test-utils.js';
import { type Config, loadConfig } from '../config.js';
import { memoryDb } from '../db/test-utils.js';
import { createEngine, type Engine } from '../engine.js';
import type { RunningInbox } from '../inbox/boot.js';
import type { InboxWatcher } from '../inbox/watcher.js';
import { SseReader } from './test-utils.js';

// A change the series service announces reaches a browser connected to /api/events, on the real
// boot composition (in-memory database, real routes, real bus, real SSE route) with K0's fake
// series service. K2's real service announces its changes the same way.

let home: string;
let config: Config;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'studio-engine-series-events-'));
  config = loadConfig({ home, env: {} });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const readers: SseReader[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
  for (const engine of engines.splice(0)) await engine.stop();
});

const idleInbox = async (): Promise<RunningInbox> => ({
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

function boot(series: Parameters<typeof createEngine>[0]['series']): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    startInbox: idleInbox,
    series,
    createRunner: () => {
      throw new (class extends Error {})('paused');
    },
  });
  engines.push(engine);
  return engine;
}

async function connect(engine: Engine): Promise<SseReader> {
  const reader = new SseReader(await engine.app.request('/api/events'));
  readers.push(reader);
  expect(await reader.event()).toEqual({ type: 'hello' });
  return reader;
}

describe('series events on the event stream of a booted engine', () => {
  it('delivers series.changed and series.removed as the service announces them', async () => {
    const fake = fakeSeriesService();
    const engine = boot(fake.service);
    const reader = await connect(engine);
    const series = makeSeries({ state: 'learning' });

    fake.emit({ type: 'changed', series, installed: false });
    fake.emit({
      type: 'changed',
      series: { ...series, state: 'ready', version: 2 },
      installed: true,
    });
    fake.emit({ type: 'removed', seriesId: series.id, clientId: series.clientId });

    expect(await reader.events()).toEqual([
      { type: 'series.changed', series },
      { type: 'series.changed', series: { ...series, state: 'ready', version: 2 } },
      { type: 'series.removed', seriesId: series.id, clientId: series.clientId },
    ]);
  });

  it('delivers them to every connected browser, in the same order', async () => {
    const fake = fakeSeriesService();
    const engine = boot(fake.service);
    const first = await connect(engine);
    const second = await connect(engine);
    const series = makeSeries();

    fake.emit({ type: 'changed', series, installed: false });
    fake.emit({ type: 'removed', seriesId: series.id, clientId: series.clientId });

    const expected = [
      { type: 'series.changed', series },
      { type: 'series.removed', seriesId: series.id, clientId: series.clientId },
    ];
    expect(await first.events()).toEqual(expected);
    expect(await second.events()).toEqual(expected);
  });

  it('delivers the change a route made, before the browser that asked has its answer', async () => {
    const learning = makeSeries({ state: 'learning' });
    const fake = fakeSeriesService({
      start: async () => {
        // The real service stores the series, announces it and then answers.
        fake.emit({ type: 'changed', series: learning, installed: false });
        return seriesOk({ series: learning }, 202);
      },
    });
    const engine = boot(fake.service);
    const reader = await connect(engine);

    const response = await engine.app.request('/api/jobs/947ef344672b/series', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: learning.name }),
    });

    expect(response.status).toBe(202);
    expect(await reader.events()).toEqual([{ type: 'series.changed', series: learning }]);
  });

  it('stops delivering to a browser that has disconnected', async () => {
    const fake = fakeSeriesService();
    const engine = boot(fake.service);
    const gone = await connect(engine);
    const stays = await connect(engine);
    await gone.cancel();
    const series = makeSeries();

    fake.emit({ type: 'changed', series, installed: false });

    expect(await stays.events()).toEqual([{ type: 'series.changed', series }]);
  });

  it('sends nothing of series while the switch is off', async () => {
    const engine = boot(disabledSeriesService);
    const reader = await connect(engine);

    const response = await engine.app.request('/api/series/622212180eef');

    expect(response.status).toBe(404);
    expect(await reader.events()).toEqual([]);
  });
});
