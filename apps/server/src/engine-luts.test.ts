import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiErrorSchema,
  clientListResponseSchema,
  healthResponseSchema,
  LUT_MESSAGES,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { createBuiltInLuts } from './luts/lut-builtin.js';
import { cubeText, invert, writeFakeSkill } from './luts/lut-test-utils.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import type { RunContext, Runner } from './pipeline/runner.js';
import { makeTempDir, noBuiltInLuts, withoutLutStills } from './test-temp.js';

// The LUTs switches in the boot composition (LU0): both on by default (LU6, LU14); with STUDIO_LUTS=0 the
// engine is as before LUTs; on, the routes answer, and the inbox has a `_LUTs` folder that is never a client. The real
// inbox side runs on a temp inbox.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-luts-');
  const config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', ...env },
  });
  ensureDirs(config);
  return config;
}

function boot(config: Config, options: Partial<EngineOptions> = {}): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    // Not what is installed on this Mac: no colour-grade skill, so Built in is empty.
    builtInLuts: noBuiltInLuts(),
    ...options,
  });
  engines.push(engine);
  return engine;
}

async function health(engine: Engine) {
  return healthResponseSchema.parse(await (await engine.app.request('/api/health')).json());
}

describe('the LUTs switch at its default (on)', () => {
  it('answers /api/luts, makes _LUTs and says so in /api/health, with lutsInEdits on too', async () => {
    const config = tempConfig();
    expect(config).toMatchObject({ luts: true, lutsInEdits: true });
    const engine = boot(config);

    await engine.start();

    expect(await health(engine)).toMatchObject({ luts: true, lutsInEdits: true });
    expect((await engine.app.request('/api/luts')).status).toBe(200);
    expect(statSync(join(config.inboxPath, '_LUTs')).isDirectory()).toBe(true);
  });
});

describe('the LUTs switch off (STUDIO_LUTS=0)', () => {
  it('leave the engine as it was: no route, no _LUTs folder, health says off', async () => {
    const config = tempConfig({ STUDIO_LUTS: '0' });
    expect(config).toMatchObject({ luts: false, lutsInEdits: true });
    const engine = boot(config);

    await engine.start();

    expect(await health(engine)).toMatchObject({ luts: false, lutsInEdits: true });
    expect(engine.luts.enabled).toBe(false);
    for (const path of ['/api/luts', '/api/luts/golden-hour-warm', '/api/luts/stage']) {
      const res = await engine.app.request(path);
      expect(res.status, path).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({ error: LUT_MESSAGES.off });
    }
    expect(existsSync(join(config.inboxPath, '_LUTs'))).toBe(false);
  });

  it('still never makes a client of a _LUTs folder that is there', async () => {
    const config = tempConfig({ STUDIO_LUTS: '0' });
    mkdirSync(join(config.inboxPath, '_LUTs'), { recursive: true });
    writeFileSync(join(config.inboxPath, '_LUTs', 'Golden Hour Warm.cube'), 'LUT_3D_SIZE 2\n');
    mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
    const engine = boot(config);

    await engine.start();

    expect(engine.clientFolders.list()).toEqual(['Acme']);
    expect(engine.jobs.getAll().map((job) => job.client)).toEqual(['Acme']);
  });

  it('keeps a lutsInEdits that is on from turning anything on by itself', async () => {
    const config = tempConfig({ STUDIO_LUTS: '0', STUDIO_LUTS_IN_EDITS: '1' });
    const engine = boot(config);

    await engine.start();

    expect(await health(engine)).toMatchObject({ luts: false, lutsInEdits: true });
    expect((await engine.app.request('/api/luts')).status).toBe(404);
    expect(existsSync(join(config.inboxPath, '_LUTs'))).toBe(false);
  });
});

describe('the LUTs switch on (STUDIO_LUTS=1)', () => {
  it('answers GET /api/luts with an empty library, and says so in /api/health', async () => {
    const engine = boot(tempConfig({ STUDIO_LUTS: '1' }));
    await engine.start();

    expect(await health(engine)).toMatchObject({ luts: true, lutsInEdits: true });
    expect(engine.luts.enabled).toBe(true);
    const res = await engine.app.request('/api/luts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ yours: [], builtIn: [], builtInAvailable: false });
  });

  it('makes _LUTs in the inbox, which is never a client or a job', async () => {
    const config = tempConfig({ STUDIO_LUTS: '1' });
    mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
    const engine = boot(config);

    await engine.start();

    expect(statSync(join(config.inboxPath, '_LUTs')).isDirectory()).toBe(true);
    expect(engine.clientFolders.list()).toEqual(['Acme']);
    const clients = clientListResponseSchema.parse(
      await (await engine.app.request('/api/clients')).json(),
    );
    expect(clients.map((row) => row.client)).toEqual(['Acme']);
    expect(engine.jobs.getAll().map((job) => job.relPath)).toEqual(['Acme/Spring']);
  });

  it('keeps what is in _LUTs, and a file dropped there later is no client either', async () => {
    const config = tempConfig({ STUDIO_LUTS: '1' });
    mkdirSync(join(config.inboxPath, '_LUTs'), { recursive: true });
    writeFileSync(join(config.inboxPath, '_LUTs', 'Golden Hour Warm.cube'), 'LUT_3D_SIZE 2\n');
    const engine = boot(config);

    await engine.start();

    expect(readdirSync(join(config.inboxPath, '_LUTs'))).toEqual(['Golden Hour Warm.cube']);
    expect(engine.clientFolders.list()).toEqual([]);
    expect(engine.jobs.getAll()).toEqual([]);
  });

  it('lists a LUT of Yours that the repository holds, and tells the browsers nothing yet', async () => {
    const engine = boot(tempConfig({ STUDIO_LUTS: '1' }));
    const events: ServerEvent[] = [];
    engine.bus.subscribe((event) => events.push(event));
    engine.lutsRepo.create({
      name: 'Golden Hour Warm',
      kind: 'look',
      size: 33,
      file: 'Golden Hour Warm.cube',
      bytes: 1_468_006,
      sha256: 'a'.repeat(64),
      sourceName: 'Golden Hour Warm.cube',
    });
    await engine.start();

    const res = await engine.app.request('/api/luts');

    const body = (await res.json()) as { yours: { slug: string; owner: string }[] };
    expect(body.yours.map((lut) => [lut.slug, lut.owner])).toEqual([['golden-hour-warm', 'yours']]);
    expect(events.filter((event) => event.type.startsWith('lut.'))).toEqual([]);
  });

  it('answers the previews with 404 while the colour grade is not installed, and a built-in LUT without it with 409', async () => {
    const engine = boot(tempConfig({ STUDIO_LUTS: '1' }));
    await engine.start();

    const preview = await engine.app.request('/api/luts/cinematic/preview/person/after.jpg');
    expect(preview.status).toBe(404);
    expect(apiErrorSchema.parse(await preview.json()).error).toBe(LUT_MESSAGES.notFound);
    const one = await engine.app.request('/api/luts/cinematic');
    expect(one.status).toBe(409);
    expect(apiErrorSchema.parse(await one.json()).error).toBe(LUT_MESSAGES.builtInMissing);
  });

  it('lets the second switch ride along, told in /api/health', async () => {
    const engine = boot(tempConfig({ STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '1' }));
    await engine.start();

    expect(await health(engine)).toMatchObject({ luts: true, lutsInEdits: true });
  });

  it('STUDIO_LUTS_IN_EDITS=0 turns notes naming a LUT off, told in /api/health', async () => {
    const engine = boot(tempConfig({ STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '0' }));
    await engine.start();

    expect(await health(engine)).toMatchObject({ luts: true, lutsInEdits: false });
  });
});

// LU11 (CVP-312): the frame of the paused-frame look is a job route, mounted while both switches are on.
describe('the look on the paused frame (/api/jobs/:id/review/frame)', () => {
  it('is mounted with both switches on: an unknown job is 404 with the job’s own words', async () => {
    const engine = boot(tempConfig({ STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '1' }));
    await engine.start();

    const res = await engine.app.request('/api/jobs/nope/review/frame?t=1');

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toBe('Job nope not found');
  });

  it('answers "LUTs are off." with lutsInEdits off, and with the LUTs switch off', async () => {
    for (const env of [
      { STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '0' },
      { STUDIO_LUTS: '0', STUDIO_LUTS_IN_EDITS: '1' },
    ]) {
      const engine = boot(tempConfig(env));
      await engine.start();

      const res = await engine.app.request('/api/jobs/nope/review/frame?t=1');

      expect(res.status).toBe(404);
      expect(apiErrorSchema.parse(await res.json()).error).toBe(LUT_MESSAGES.off);
    }
  });
});

// LU9 (CVP-310): a note that names a LUT reaches the run, only while both switches are on. The edit
// runner is a stand-in that writes down the context it was given; the library holds one LUT of
// Yours (its file in `_LUTs`) and the real built-in catalog over a stand-in skill.
describe('a LUT named in a note (STUDIO_LUTS_IN_EDITS)', () => {
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

  const CUBE = cubeText(5, invert);

  async function editOneJob(env: Record<string, string>, note: string, files: string[] = []) {
    const config = tempConfig(env);
    const skillDir = writeFakeSkill(join(config.inboxPath, '..', 'skill'));
    const given: (RunContext | undefined)[] = [];
    const runner: Runner = {
      async start(_job, _mode, context) {
        given.push(context);
        return { ok: true, preview: SAMPLE_PREVIEW };
      },
    };
    const engine = boot(config, {
      startInbox: idleInbox,
      createRunner: () => runner,
      // The fake skill has built-in LUTs: their stills are not what is under test.
      builtInLuts: withoutLutStills(createBuiltInLuts({ skillDir, dataDir: config.dataDir })),
      // ffprobe is not what is under test (and a 0-byte clip has no tags): the file names are.
      cameraTagProbe: async () => [],
    });
    mkdirSync(join(config.inboxPath, '_LUTs'), { recursive: true });
    writeFileSync(join(config.inboxPath, '_LUTs', 'Golden Hour Warm.cube'), CUBE);
    const lut = engine.lutsRepo.create({
      name: 'Golden Hour Warm',
      kind: 'look',
      size: 5,
      file: 'Golden Hour Warm.cube',
      bytes: CUBE.length,
      sha256: 'a'.repeat(64),
      sourceName: 'Golden Hour Warm.cube',
    });
    const seen: ServerEvent[] = [];
    engine.bus.subscribe((event) => seen.push(event));
    await engine.start();

    const jobDir = join(config.inboxPath, 'Acme', 'Spring');
    mkdirSync(jobDir, { recursive: true });
    for (const file of files) writeFileSync(join(jobDir, file), '');
    const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Spring'));
    engine.jobs.setNote(job.id, note);
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    engine.worker?.notify();
    await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'));
    return { engine, job, lut, given, jobDir, seen };
  }

  const NOTE = 'Warm it up with @luts/golden-hour-warm and @luts/zzz';

  it('both switches on: the LUT is copied into the job, counted, and the run is told', async () => {
    const { engine, job, lut, given, jobDir, seen } = await editOneJob(
      { STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '1' },
      NOTE,
    );

    expect(given[0]?.libraryRefs).toEqual({
      luts: [
        {
          slug: 'golden-hour-warm',
          name: 'Golden Hour Warm',
          kind: 'look',
          owner: 'yours',
          path: 'edit/luts/golden-hour-warm.cube',
          look: null,
        },
      ],
      graphics: [],
      missing: [{ library: 'luts', slug: 'zzz', reason: 'notInLibrary' }],
      // No file names a log curve (LU10): the edit run is told so, and nothing is matched.
      camera: { curves: [], byNote: false },
    });
    expect(readFileSync(join(jobDir, 'edit', 'luts', 'golden-hour-warm.cube'), 'utf8')).toBe(CUBE);
    expect(engine.lutsRepo.usedCount(lut.id)).toBe(1);
    expect(engine.jobs.get(job.id)?.state).toBe('review');
    // The list says so, and the browsers hear it.
    const list = (await (await engine.app.request('/api/luts')).json()) as {
      yours: { slug: string; used: number }[];
    };
    expect(list.yours.map((row) => [row.slug, row.used])).toEqual([['golden-hour-warm', 1]]);
    expect(seen.filter((event) => event.type === 'lut.changed')).toHaveLength(1);
  });

  it('the notes switch off (STUDIO_LUTS_IN_EDITS=0) leaves a note as plain text', async () => {
    const { engine, lut, given, jobDir } = await editOneJob(
      { STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '0' },
      NOTE,
    );

    expect(given[0]?.libraryRefs).toBeUndefined();
    expect(existsSync(join(jobDir, 'edit', 'luts'))).toBe(false);
    expect(engine.lutsRepo.usedCount(lut.id)).toBe(0);
  });

  it('a note that names nothing gives the run nothing but the (empty) camera log answer', async () => {
    const { given, jobDir } = await editOneJob(
      { STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '1' },
      'Keep it under 30 seconds',
    );

    expect(given[0]).toBeDefined();
    expect(given[0]?.libraryRefs).toEqual({
      luts: [],
      graphics: [],
      missing: [],
      camera: { curves: [], byNote: false },
    });
    expect(existsSync(join(jobDir, 'edit', 'luts'))).toBe(false);
  });

  // LU10: the camera log of the footage reaches an edit run, with the one Camera LUT that matches.
  it('a clip that names its curve: the one Camera LUT that names it is copied in and handed over', async () => {
    const config = { STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '1' };
    const { given, jobDir } = await editOneJob(config, 'Keep it short', ['FPV S-Log3 01.mp4']);

    // No camera LUT in the library yet: the run is told there is none.
    expect(given[0]?.libraryRefs?.camera).toEqual({
      byNote: false,
      curves: [
        {
          curve: 'slog3',
          label: 'Sony S-Log3',
          files: ['FPV S-Log3 01.mp4'],
          match: { kind: 'none' },
        },
      ],
    });
    expect(existsSync(join(jobDir, 'edit', 'luts'))).toBe(false);
  });

  it('with the notes switch off the footage is not looked at', async () => {
    const { given } = await editOneJob({ STUDIO_LUTS: '1', STUDIO_LUTS_IN_EDITS: '0' }, 'x', [
      'FPV S-Log3 01.mp4',
    ]);
    expect(given[0]?.libraryRefs).toBeUndefined();
  });
});
