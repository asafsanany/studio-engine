import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { healthResponseSchema, SETTLE_MS, type ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disabledSeriesService } from './clients/series-service.js';
import { fakeSeriesService, makeSeries } from './clients/test-utils.js';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { fakeClock, makeScan, memoryDb } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox, StartInboxOptions } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// Series in the boot composition (CVP-188, K0): the Series switch is on by default, so the engine
// runs the real series service and `/api/health` says series are on; with `STUDIO_SERIES=0` it runs
// the disabled one and `/api/health` says series are off. The service's changes go out on the bus
// as `series.changed` / `series.removed`, and the inbox is handed the name rule.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-series-');
  const config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', ...env },
  });
  ensureDirs(config);
  return config;
}

const unavailable = (): never => {
  throw new RunnerUnavailableError('claude', 'E3');
};

function boot(options: Partial<EngineOptions> = {}) {
  const inboxOptions: StartInboxOptions[] = [];
  const startInbox = async (given: StartInboxOptions): Promise<RunningInbox> => {
    inboxOptions.push(given);
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
  };
  const engine = createEngine({
    config: tempConfig(),
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: unavailable,
    startInbox,
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    ...options,
  });
  engines.push(engine);
  const events: ServerEvent[] = [];
  engine.bus.subscribe((event) => events.push(event));
  return { engine, events, inboxOptions };
}

describe('the Series switch in the engine', () => {
  it('is on by default: the real service, and /api/health says so', async () => {
    const { engine } = boot();

    expect(engine.series).not.toBe(disabledSeriesService);
    expect(engine.series.enabled).toBe(true);
    const health = healthResponseSchema.parse(
      await (await engine.app.request('/api/health')).json(),
    );
    expect(health.series).toBe(true);
  });

  it('is the disabled service with STUDIO_SERIES=0, and /api/health says series are off', async () => {
    const { engine } = boot({ config: tempConfig({ STUDIO_SERIES: '0' }) });

    expect(engine.series).toBe(disabledSeriesService);
    const health = healthResponseSchema.parse(
      await (await engine.app.request('/api/health')).json(),
    );
    expect(health.series).toBe(false);
  });

  it('reports a service that is on', async () => {
    const { engine } = boot({ series: fakeSeriesService().service });
    const health = healthResponseSchema.parse(
      await (await engine.app.request('/api/health')).json(),
    );
    expect(health.series).toBe(true);
  });
});

describe('the Series switch on (CVP-178, K2)', () => {
  it('builds the real service: on, and /api/health says so', async () => {
    const { engine } = boot({ config: tempConfig({ STUDIO_SERIES: '1' }) });

    expect(engine.series).not.toBe(disabledSeriesService);
    expect(engine.series.enabled).toBe(true);
    const health = healthResponseSchema.parse(
      await (await engine.app.request('/api/health')).json(),
    );
    expect(health.series).toBe(true);
  });

  it('runs Start a series on the style worker and publishes the series and its format job', async () => {
    // Review off, so the stand-in job can go straight to ready.
    const config = tempConfig({ STUDIO_SERIES: '1', STUDIO_REVIEW: '0' });
    const clock = fakeClock();
    const { engine, events } = boot({ config, clock });
    const jobDir = join(config.inboxPath, 'Acme', 'Weekly 5');
    mkdirSync(join(jobDir, 'edit', 'preview'), { recursive: true });
    writeFileSync(join(jobDir, 'edit', 'preview', 'index.html'), '<h1>Weekly</h1>');
    const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Weekly 5'));
    clock.tick(SETTLE_MS);
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    engine.jobs.applyTransition(job.id, { type: 'START' });
    engine.jobs.applyTransition(job.id, {
      type: 'SUCCEED',
      output: { fileName: 'x.mp4', durationSec: 1, width: 1, height: 1, sizeBytes: 1 },
    });

    const started = await engine.series.start(job.id, 'Weekly');
    expect(started.ok && started.status).toBe(202);
    const seriesId = started.ok ? started.body.series.id : '';
    await engine.start();
    for (let i = 0; i < 400 && engine.seriesRepo.get(seriesId)?.state !== 'ready'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(engine.seriesRepo.get(seriesId)).toMatchObject({ state: 'ready', version: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'job.upsert',
        job: expect.objectContaining({ id: job.id, seriesId, episode: 5 }),
      }),
    );
    expect(
      events
        .filter((event) => event.type === 'series.changed')
        .map((event) => (event.type === 'series.changed' ? event.series.state : null)),
    ).toEqual(['learning', 'ready']);
  });
});

describe('series changes on the bus', () => {
  it('publishes series.changed and series.removed as the service announces them', () => {
    const fake = fakeSeriesService();
    const { events } = boot({ series: fake.service });
    expect(fake.listenerCount()).toBe(1);
    const series = makeSeries();

    fake.emit({ type: 'changed', series, installed: false });
    fake.emit({ type: 'changed', series: { ...series, version: 2 }, installed: true });
    fake.emit({ type: 'removed', seriesId: series.id, clientId: series.clientId });

    expect(events).toEqual([
      { type: 'series.changed', series },
      { type: 'series.changed', series: { ...series, version: 2 } },
      { type: 'series.removed', seriesId: series.id, clientId: series.clientId },
    ]);
  });
});

describe('the name rule in the inbox', () => {
  it('hands the inbox the rule, which changes nothing while series are off', async () => {
    const { engine, inboxOptions } = boot();
    await engine.start();
    const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Weekly 6'));

    const assign = inboxOptions[0]?.assignSeries;
    expect(assign).toBeTypeOf('function');
    expect(assign?.(job)).toEqual(job);
    expect(engine.jobs.get(job.id)).toMatchObject({ seriesId: null, episode: null });
  });
});
