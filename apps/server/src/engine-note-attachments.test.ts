import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { healthResponseSchema, noteViewSchema } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb } from './db/test-utils.js';
import { createEngine, type Engine } from './engine.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The Songs switch in the boot composition (SG5): the note's pictures need it and Soundtrack both.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function boot(env: Record<string, string>): { engine: Engine; inbox: string } {
  const home = makeTempDir('studio-engine-note-attachments-');
  const config = loadConfig({ home, env, log: vi.fn() });
  ensureDirs(config);
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    builtInLuts: noBuiltInLuts(),
  });
  engines.push(engine);
  return { engine, inbox: config.inboxPath };
}

function picture(): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'reel.png', { type: 'image/png' }));
  return form;
}

describe('the note’s pictures in the engine', () => {
  it('has no such route with the switch off, nor with songs on but music off', async () => {
    for (const env of [
      { STUDIO_SONGS: '0' },
      { STUDIO_MUSIC: '0' },
      { STUDIO_SONGS: '1', STUDIO_MUSIC: '0' },
      { STUDIO_MUSIC: '0', STUDIO_SONGS: '0' },
    ] as Record<string, string>[]) {
      const { engine } = boot(env);
      const { job } = engine.jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo'));
      const res = await engine.app.request(`/api/jobs/${job.id}/note`);
      expect(res.status, JSON.stringify(env)).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('has the route with nothing set, because songs and music are on by default (U22)', async () => {
    const { engine } = boot({});
    const { job } = engine.jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo'));
    const res = await engine.app.request(`/api/jobs/${job.id}/note`);
    expect(res.status).toBe(200);
  });

  it('keeps a picture in the job folder and lists it when songs and music are on', async () => {
    const { engine, inbox } = boot({ STUDIO_MUSIC: '1', STUDIO_SONGS: '1' });
    expect(
      healthResponseSchema.parse(await (await engine.app.request('/api/health')).json()),
    ).toMatchObject({
      songs: true,
    });
    const { job } = engine.jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo'));
    const jobDir = join(inbox, job.relPath);
    mkdirSync(jobDir, { recursive: true });

    const res = await engine.app.request(`/api/jobs/${job.id}/note/attachments`, {
      method: 'POST',
      body: picture(),
    });

    expect(res.status).toBe(201);
    expect(existsSync(join(jobDir, 'edit', 'brief', 'from-you', 'reel.png'))).toBe(true);
    const view = noteViewSchema.parse(
      await (await engine.app.request(`/api/jobs/${job.id}/note`)).json(),
    );
    expect(view.attachments.map((a) => a.name)).toEqual(['reel.png']);
  });

  it('is wired to the Mac’s HEIC converter: a HEIC it cannot read is refused, not kept', async () => {
    const { engine, inbox } = boot({ STUDIO_MUSIC: '1', STUDIO_SONGS: '1' });
    const { job } = engine.jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo'));
    const jobDir = join(inbox, job.relPath);
    mkdirSync(jobDir, { recursive: true });

    // Words in a .heic: with no converter wired in the engine would keep them; sips cannot read them.
    const form = new FormData();
    form.append('file', new File(['not a picture'], 'IMG_1.heic', { type: 'image/heic' }));
    const res = await engine.app.request(`/api/jobs/${job.id}/note/attachments`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining('couldn’t be read') });
    const folder = join(jobDir, 'edit', 'brief', 'from-you');
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  });
});
