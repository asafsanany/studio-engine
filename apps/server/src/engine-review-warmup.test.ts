import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { writeFakePreview } from './pipeline/fake-preview.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The videos of a job in Review are made by the engine as soon as the job is published there
// (the owner, 26 Oct): the small one for the phone and the full one for Export MP4, so both are there
// when they open them. Under the fake runner they are test-pattern clips.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

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

function boot(): { engine: Engine; config: Config } {
  const config = loadConfig({
    home: makeTempDir('studio-engine-warmup-'),
    env: { STUDIO_RUNNER: 'fake', STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' },
  });
  ensureDirs(config);
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    startInbox: idleInbox,
    builtInLuts: noBuiltInLuts(),
  });
  engines.push(engine);
  return { engine, config };
}

/** A job in Review with the stand-in's composition on disk. It is not published yet. */
async function inReview(engine: Engine, config: Config, name = 'Ep 1'): Promise<Job> {
  const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.jobs.applyTransition(job.id, { type: 'START' });
  engine.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  const editDir = join(config.inboxPath, job.relPath, 'edit');
  mkdirSync(editDir, { recursive: true });
  await writeFakePreview(editDir, name);
  writeFileSync(join(editDir, 'project.md'), `# ${name}\n`);
  return engine.jobs.get(job.id) as Job;
}

const status = async (engine: Engine, path: string) =>
  (await (await engine.app.request(path)).json()) as { state: string };

describe('a job that reaches Review', () => {
  it('gets its small video and its full video made without anyone asking', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config);
    const editDir = join(config.inboxPath, job.relPath, 'edit');
    expect(existsSync(join(editDir, 'review-export.mp4'))).toBe(false);

    engine.bus.publish({ type: 'job.upsert', job });

    await vi.waitFor(
      async () => {
        expect(await status(engine, `/api/jobs/${job.id}/preview-video`)).toEqual({
          state: 'ready',
        });
        expect(await status(engine, `/api/jobs/${job.id}/review-export`)).toEqual({
          state: 'ready',
        });
      },
      { timeout: 30_000, interval: 200 },
    );
    expect(existsSync(join(editDir, 'preview-lite.mp4'))).toBe(true);
    expect(existsSync(join(editDir, 'review-export.mp4'))).toBe(true);
  });

  it('makes nothing for a job that is removed while its videos start (C89)', async () => {
    const { engine, config } = boot();
    await engine.start();
    const removed = await inReview(engine, config, 'Ep 1');
    const kept = await inReview(engine, config, 'Ep 2');
    const removedDir = join(config.inboxPath, removed.relPath, 'edit');

    // Published in Review: the small video starts (it takes the job's stop before its first await).
    // Delete's first steps follow in the same turn: the job leaves the database and the engine says
    // so (`job.remove`, published before the folder is emptied). The video must stop with it, and
    // not write into the folder of a job that is going: while Delete empties it, it is still there.
    engine.bus.publish({ type: 'job.upsert', job: removed });
    engine.jobs.purge(removed.id);
    engine.bus.publish({ type: 'job.remove', id: removed.id });
    engine.bus.publish({ type: 'job.upsert', job: kept });

    // The other job's video is made at the same time, by the same ffmpeg: once it is there, the removed
    // job's would be too, if it had been made.
    await vi.waitFor(
      async () => {
        expect(await status(engine, `/api/jobs/${kept.id}/preview-video`)).toEqual({
          state: 'ready',
        });
      },
      { timeout: 30_000, interval: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(removedDir, 'preview-lite.mp4'))).toBe(false);
    expect(existsSync(join(removedDir, '.preview-full.partial.mp4'))).toBe(false);
  });

  it('is picked up at boot when it was already there, with nothing published for it', async () => {
    const { engine, config } = boot();
    const job = await inReview(engine, config);
    await engine.start();

    await vi.waitFor(
      async () => {
        expect(await status(engine, `/api/jobs/${job.id}/preview-video`)).toEqual({
          state: 'ready',
        });
        expect(await status(engine, `/api/jobs/${job.id}/review-export`)).toEqual({
          state: 'ready',
        });
      },
      { timeout: 30_000, interval: 200 },
    );
  });

  it('leaves a job that is not in Review alone', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config);
    const { job: other } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Ep 2'));
    engine.bus.publish({ type: 'job.upsert', job: other });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(join(config.inboxPath, job.relPath, 'edit', 'review-export.mp4'))).toBe(
      false,
    );
    expect(await status(engine, `/api/jobs/${job.id}/review-export`)).toEqual({ state: 'idle' });
  });
});
