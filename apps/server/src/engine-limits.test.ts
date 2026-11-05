import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyticsResponseSchema, localDayOf } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendLimits, limitsLogPath, readLimits } from './analytics/limits-log.js';
import { ensureDirs, loadConfig } from './config.js';
import { memoryDb } from './db/test-utils.js';
import { createEngine, type Engine } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { machineTimeZone } from './routes/money.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The limits log in the boot composition (AN5): the first start fills <data>/limits.jsonl from the
// run logs, and /api/analytics reads it for "Busiest week".

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

const SEVEN_DAY_RESET = 1792864800; // 2026-10-24T18:00:00Z
const NOW = new Date('2026-10-22T09:00:00Z');

const event = (fiveHour: number, sevenDay: number) =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: SEVEN_DAY_RESET - 4 * 86_400 },
        seven_day: { utilization: sevenDay, resetsAt: SEVEN_DAY_RESET },
      },
    },
  });

function boot(extra: Partial<Parameters<typeof createEngine>[0]> = {}) {
  const home = makeTempDir('studio-engine-limits-');
  const config = loadConfig({
    home,
    env: {
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      STUDIO_REVIEW: '0',
      STUDIO_ANALYTICS: '1',
    },
  });
  ensureDirs(config);
  const engine = createEngine({
    config,
    db: memoryDb(),
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
    clock: () => NOW,
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    ...extra,
  });
  engines.push(engine);
  return { config, engine };
}

function writeRunLog(logsDir: string, folder: string, name: string, lines: string[]): void {
  mkdirSync(join(logsDir, folder), { recursive: true });
  const path = join(logsDir, folder, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  utimesSync(path, NOW, NOW);
}

async function busiest(engine: Engine) {
  const res = await engine.app.request('/api/analytics');
  expect(res.status).toBe(200);
  return analyticsResponseSchema.parse(await res.json()).claudeUse.busiest;
}

describe('the limits log at boot', () => {
  it('is made on the first start from the past runs, and /api/analytics shows the week', async () => {
    const { config, engine } = boot();
    writeRunLog(config.logsDir, 'jobs', 'a1b2c3d4e5f6.log', [
      '{"type":"studio_engine","event":"start"}',
      event(0.2, 0.31),
      event(0.25, 0.4),
      '{"type":"studio_engine","event":"end"}',
    ]);
    writeRunLog(config.logsDir, 'clients', 'c9.log', [event(0.1, 0.38)]);

    await engine.start();

    expect(await readLimits(config.dataDir)).toHaveLength(3);
    const weeks = await busiest(engine);
    expect(weeks[7]).toMatchObject({
      // The window ends Sat 24 Oct 18:00 UTC and starts 7 days before, on the machine's calendar.
      start: localDayOf(Date.parse('2026-10-17T18:00:00.000Z'), machineTimeZone()),
      peak: 0.4,
      hitLimit: false,
      current: true,
    });
    expect(weeks.slice(0, 7).every((week) => week.peak === null)).toBe(true);
  });

  it('is not made again: a start with a limits log leaves it as it is', async () => {
    const { config, engine } = boot();
    await appendLimits(config.dataDir, JSON.parse(event(0.5, 0.6)).rate_limit_info, NOW);
    writeRunLog(config.logsDir, 'jobs', 'a1b2c3d4e5f6.log', [event(0.2, 0.31)]);

    await engine.start();

    expect(await readLimits(config.dataDir)).toHaveLength(1);
    expect((await busiest(engine))[7]?.peak).toBe(0.6);
  });

  it('writes an empty log when there are no run logs yet, so they are not read again', async () => {
    const { config, engine } = boot();

    await engine.start();

    expect(await readLimits(config.dataDir)).toEqual([]);
    expect(existsSync(limitsLogPath(config.dataDir))).toBe(true);
    expect((await busiest(engine)).every((week) => week.peak === null)).toBe(true);
  });
});

describe('the plan probe in the engine', () => {
  it('is poked when the Analytics data is asked for, and stopped with the engine', async () => {
    const probe = { poke: vi.fn(), stop: vi.fn(async () => {}) };
    const { engine } = boot({ planProbe: probe as never });
    await engine.start();

    await engine.app.request('/api/analytics');
    expect(probe.poke).toHaveBeenCalledTimes(1);

    await engine.stop();
    expect(probe.stop).toHaveBeenCalledTimes(1);
  });

  it('is not made for an engine with a stand-in runner: no real Claude run is ever started', async () => {
    const { engine } = boot();
    await engine.start();
    const res = await engine.app.request('/api/analytics');
    expect(res.status).toBe(200);
    expect(analyticsResponseSchema.parse(await res.json()).claudeUse.plan.lastReadingAt).toBeNull();
  });
});
