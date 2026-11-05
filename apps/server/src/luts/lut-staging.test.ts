import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LUT_LIMITS } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLutStaging, lutStagingRoot, startLutStagingReaper } from './lut-staging.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-lut-staging-'));
  dirs.push(dir);
  return dir;
}

function age(dir: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(dir, when, when);
}

describe('createLutStaging', () => {
  it('makes an empty folder per stage under <data>/lut-staging', async () => {
    const data = dataDir();
    const staging = createLutStaging({ dataDir: data });
    const a = await staging.create();
    const b = await staging.create();
    expect(a.stageId).toMatch(/^[0-9a-f]{12}$/);
    expect(a.stageId).not.toBe(b.stageId);
    expect(a.dir).toBe(join(lutStagingRoot(data), a.stageId));
    expect(statSync(a.dir).isDirectory()).toBe(true);
  });

  it('finds a stage by id, and not an unknown id or one that tries to leave the folder', async () => {
    const data = dataDir();
    const staging = createLutStaging({ dataDir: data });
    const stage = await staging.create();
    expect(await staging.find(stage.stageId)).toEqual(stage);
    expect(await staging.find('000000000000')).toBeNull();
    expect(await staging.find('..')).toBeNull();
    expect(await staging.find('../x')).toBeNull();
    expect(await staging.find('')).toBeNull();
  });

  it('removes a stage with what it holds, once', async () => {
    const staging = createLutStaging({ dataDir: dataDir() });
    const stage = await staging.create();
    writeFileSync(join(stage.dir, 'f0.upload'), 'x');
    expect(await staging.remove(stage.stageId)).toBe(true);
    expect(existsSync(stage.dir)).toBe(false);
    expect(await staging.remove(stage.stageId)).toBe(false);
    expect(await staging.remove('../..')).toBe(false);
    expect(await staging.find(stage.stageId)).toBeNull();
  });

  it('reaps the stages older than an hour and keeps the younger ones', async () => {
    const staging = createLutStaging({ dataDir: dataDir() });
    const old = await staging.create();
    const fresh = await staging.create();
    age(old.dir, LUT_LIMITS.stageLifetimeMs + 1000);
    age(fresh.dir, LUT_LIMITS.stageLifetimeMs - 60_000);
    expect(await staging.reap()).toBe(1);
    expect(existsSync(old.dir)).toBe(false);
    expect(existsSync(fresh.dir)).toBe(true);
    expect(await staging.reap()).toBe(0);
  });

  it('reaps at the time it is given, and every stage with `all`', async () => {
    const staging = createLutStaging({ dataDir: dataDir() });
    const a = await staging.create();
    const b = await staging.create();
    expect(await staging.reap()).toBe(0);
    expect(await staging.reap({ now: new Date(Date.now() + 2 * LUT_LIMITS.stageLifetimeMs) })).toBe(
      2,
    );
    const c = await staging.create();
    expect(await staging.reap({ all: true })).toBe(1);
    expect([a, b, c].some((stage) => existsSync(stage.dir))).toBe(false);
  });

  it('reaps nothing, and does not fail, when there is no staging folder yet', async () => {
    expect(await createLutStaging({ dataDir: dataDir() }).reap({ all: true })).toBe(0);
  });

  it('leaves what is not a stage alone', async () => {
    const data = dataDir();
    const staging = createLutStaging({ dataDir: data });
    await staging.create();
    writeFileSync(join(lutStagingRoot(data), 'notes.txt'), 'keep');
    expect(await staging.reap({ all: true })).toBe(1);
    expect(existsSync(join(lutStagingRoot(data), 'notes.txt'))).toBe(true);
  });
});

describe('startLutStagingReaper', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it('reaps every stage at once, then the old ones every hour, until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reap = vi.fn(async () => 0);
    const stop = startLutStagingReaper({ reap } as never, logger, 1000);
    expect(reap).toHaveBeenCalledWith({ all: true });
    vi.advanceTimersByTime(2000);
    expect(reap).toHaveBeenCalledTimes(3);
    expect(reap).toHaveBeenLastCalledWith({ all: false });
    stop();
    vi.advanceTimersByTime(5000);
    expect(reap).toHaveBeenCalledTimes(3);
  });

  it('says so when it removed something and when it could not', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const reap = vi.fn().mockResolvedValueOnce(2).mockRejectedValueOnce(new Error('disk'));
    const stop = startLutStagingReaper({ reap } as never, logger, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(logger.info).toHaveBeenCalledWith({ removed: 2 }, expect.any(String));
    expect(logger.warn).toHaveBeenCalled();
  });
});
