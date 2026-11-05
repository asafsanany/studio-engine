import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  healthResponseSchema,
  type Job,
  noSongStatusSchema,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { fixtureRecord, songRecord, writeRecord, writeToneMp3 } from './music/test-utils.js';
import { KILL_GRACE_MS } from './pipeline/claude-process.js';
import { makeClip, resolveFfmpeg } from './pipeline/fake-media.js';
import type { Runner } from './pipeline/runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The file without the song in the boot composition (Songs, SG8): with Songs on and a song picked,
// Approve's export is followed by a second one, "<Job> · no song.mp4", made by the engine. With
// Songs off, or any other pick, Approve is exactly what it was.

const ffmpeg = await resolveFfmpeg('ffmpeg');
const haveTools = ffmpeg !== null && (await resolveFfmpeg('ffprobe')) !== null;

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

function configOf(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-no-song-');
  const config = loadConfig({
    home,
    env: {
      STUDIO_RUNNER: 'fake',
      STUDIO_MUSIC: '1',
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      STUDIO_QUICK_FIXES: '0',
      ...env,
    },
  });
  ensureDirs(config);
  return config;
}

/**
 * Boots an engine whose edit run leaves a preview with music and `record` in Review, and whose
 * render run (Approve) leaves a one-second final.mp4. Returns the engine with the job in Review.
 */
async function bootInReview(
  env: Record<string, string>,
  record: () => ReturnType<typeof songRecord>,
) {
  const config = configOf(env);
  const runner: Runner = {
    async start(job, _mode, context) {
      const jobDir = join(config.inboxPath, job.relPath);
      const editDir = join(jobDir, 'edit');
      if (job.runKind === 'render') {
        const made = await makeClip(
          { bin: ffmpeg as string, signal: context.signal, killGraceMs: KILL_GRACE_MS },
          join(editDir, 'final.mp4'),
          { seconds: 1, pattern: 'testsrc2', toneHz: 330 },
        );
        return made.status === 'ok' ? { ok: true } : { ok: false, error: 'no final.mp4' };
      }
      const preview = join(editDir, 'preview');
      mkdirSync(preview, { recursive: true });
      writeFileSync(
        join(preview, 'index.html'),
        '<html><body><div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="2"></div></body></html>',
      );
      writeToneMp3(ffmpeg as string, join(preview, 'music.mp3'), 2);
      writeRecord(editDir, record());
      return { ok: true, preview: SAMPLE_PREVIEW };
    },
  };
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => runner,
    startInbox: idleInbox,
    builtInLuts: noBuiltInLuts(),
  });
  engines.push(engine);
  const seen: ServerEvent[] = [];
  engine.bus.subscribe((event) => seen.push(event));
  await engine.start();

  mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
  const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Spring'));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.worker?.notify();
  await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'));
  return { engine, config, job, seen };
}

const exportsOf = (config: Config) => {
  const folder = join(config.exportsDir, 'Acme');
  return existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => !name.startsWith('.'))
        .sort()
    : [];
};

async function approve(engine: Engine, job: Job) {
  const res = await engine.app.request(`/api/jobs/${job.id}/approve`, { method: 'POST' });
  expect(res.status).toBe(200);
  await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('ready'), { timeout: 20_000 });
}

describe.skipIf(!haveTools)('Approve with the song on', () => {
  it('exports the normal file first, then makes “· no song.mp4” beside it; the job is Approved either way', async () => {
    const { engine, config, job, seen } = await bootInReview({ STUDIO_SONGS: '1' }, () =>
      songRecord(),
    );
    expect(
      healthResponseSchema.parse(await (await engine.app.request('/api/health')).json()),
    ).toMatchObject({ songs: true });

    // The job is ready, with its export, before the second file exists.
    let secondAtReady: boolean | null = null;
    engine.bus.subscribe((event) => {
      if (event.type === 'job.upsert' && event.job.state === 'ready' && secondAtReady === null) {
        secondAtReady = exportsOf(config).includes('Spring · no song.mp4');
      }
    });
    await approve(engine, job);
    expect(secondAtReady).toBe(false);
    expect(engine.jobs.get(job.id)?.output?.fileName).toBe('Acme/Spring.mp4');

    await vi.waitFor(() =>
      expect(exportsOf(config)).toEqual(['Spring · no song.mp4', 'Spring.mp4']),
    );
    const status = noSongStatusSchema.parse(
      await (await engine.app.request(`/api/jobs/${job.id}/no-song`)).json(),
    );
    expect(status).toMatchObject({ state: 'ready', file: 'Spring · no song.mp4' });

    const second = await engine.app.request(`/api/jobs/${job.id}/download?file=no-song`);
    expect(second.status).toBe(200);
    expect((await second.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const first = await engine.app.request(`/api/jobs/${job.id}/download`);
    expect(first.status).toBe(200);

    // The page was told the second file started and ended: the job went out again.
    const upserts = seen.filter(
      (event) =>
        event.type === 'job.upsert' && event.job.id === job.id && event.job.state === 'ready',
    );
    expect(upserts.length).toBeGreaterThanOrEqual(3);
  });

  it('makes nothing for a job whose music is not the song', async () => {
    const { engine, config, job } = await bootInReview({ STUDIO_SONGS: '1' }, () =>
      fixtureRecord(),
    );
    await approve(engine, job);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exportsOf(config)).toEqual(['Spring.mp4']);
    expect(
      noSongStatusSchema.parse(
        await (await engine.app.request(`/api/jobs/${job.id}/no-song`)).json(),
      ),
    ).toEqual({ state: 'none' });
    expect((await engine.app.request(`/api/jobs/${job.id}/download?file=no-song`)).status).toBe(
      404,
    );
  });

  it('Try again makes it when the engine was stopped before it was made', async () => {
    const { engine, config, job } = await bootInReview({ STUDIO_SONGS: '1' }, () => songRecord());
    await approve(engine, job);
    await vi.waitFor(() => expect(exportsOf(config)).toContain('Spring · no song.mp4'));

    // The copy in _Exports is lost (a restart half way would leave the same: nothing there).
    const { rm } = await import('node:fs/promises');
    await rm(join(config.exportsDir, 'Acme', 'Spring · no song.mp4'));
    expect(
      noSongStatusSchema.parse(
        await (await engine.app.request(`/api/jobs/${job.id}/no-song`)).json(),
      ),
    ).toEqual({ state: 'idle' });

    const again = await engine.app.request(`/api/jobs/${job.id}/no-song`, { method: 'POST' });
    expect(again.status).toBe(200);
    await vi.waitFor(() => expect(exportsOf(config)).toContain('Spring · no song.mp4'));
  });
});

describe.skipIf(!haveTools)('Approve with Songs off (STUDIO_SONGS=0)', () => {
  it('is what it was: one file, no second route, a plain download', async () => {
    const { engine, config, job } = await bootInReview({ STUDIO_SONGS: '0' }, () => songRecord());
    expect(
      healthResponseSchema.parse(await (await engine.app.request('/api/health')).json()).songs,
    ).toBeFalsy();
    await approve(engine, job);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(exportsOf(config)).toEqual(['Spring.mp4']);
    expect((await engine.app.request(`/api/jobs/${job.id}/no-song`)).status).toBe(404);
    expect(
      (await engine.app.request(`/api/jobs/${job.id}/no-song`, { method: 'POST' })).status,
    ).toBe(404);
    const download = await engine.app.request(`/api/jobs/${job.id}/download?file=no-song`);
    expect(download.status).toBe(200);
  });
});
