import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import {
  apiErrorSchema,
  clientListResponseSchema,
  GRAPHIC_MESSAGES,
  graphicListResponseSchema,
  healthResponseSchema,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import { ClaudeGraphicRunner } from './graphics/claude-graphic.js';
import { createGraphicRunner } from './graphics/create-graphic-runner.js';
import { FakeGraphicRunner } from './graphics/fake-graphic-runner.js';
import { GRAPHICS_ASSETS_DIR, GSAP_ASSET_PATH } from './graphics/graphic-assets.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import type { Runner } from './pipeline/runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';
import { readUsageLog } from './usage/usage-log.js';

// The Graphics switches in the boot composition (GR0): off, the engine is as before Graphics; on,
// the library's routes answer, its worker starts and stops with the engine, and the inbox has a
// `_Graphics` folder that is never a client. The real inbox side runs on a temp inbox.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-graphics-');
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
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    ...options,
  });
  engines.push(engine);
  return engine;
}

async function health(engine: Engine) {
  return healthResponseSchema.parse(await (await engine.app.request('/api/health')).json());
}

describe('the Graphics switch on by default', () => {
  it('runs the library with no Graphics setting in the environment', async () => {
    const config = tempConfig();
    expect(config).toMatchObject({ graphics: true, graphicsInEdits: true });
    const engine = boot(config);

    await engine.start();

    expect(await health(engine)).toMatchObject({ graphics: true, graphicsInEdits: true });
    expect(engine.graphics.enabled).toBe(true);
  });
});

describe('the Graphics switches off (STUDIO_GRAPHICS=0)', () => {
  // graphicsInEdits keeps its own default here: it acts only while graphics is on, so it says nothing
  // about this engine and is not pinned.
  it('leave the engine as it was: no worker, no route, no _Graphics folder', async () => {
    const config = tempConfig({ STUDIO_GRAPHICS: '0' });
    expect(config.graphics).toBe(false);
    const engine = boot(config);

    await engine.start();

    expect(await health(engine)).toMatchObject({ graphics: false });
    expect(engine.graphics.enabled).toBe(false);
    expect(engine.graphicWorker).toBeNull();
    const res = await engine.app.request('/api/graphics');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: GRAPHIC_MESSAGES.off });
    expect(existsSync(join(config.inboxPath, '_Graphics'))).toBe(false);
  });
});

describe('the Graphics switch on', () => {
  it('answers GET /api/graphics with an empty library, and says so in /api/health', async () => {
    const engine = boot(tempConfig({ STUDIO_GRAPHICS: '1' }));
    await engine.start();

    expect(await health(engine)).toMatchObject({ graphics: true, graphicsInEdits: true });
    expect(engine.graphics.enabled).toBe(true);
    const res = await engine.app.request('/api/graphics');
    expect(res.status).toBe(200);
    expect(graphicListResponseSchema.parse(await res.json())).toEqual([]);
  });

  it('makes _Graphics in the inbox, which is never a client', async () => {
    const config = tempConfig({ STUDIO_GRAPHICS: '1' });
    mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
    const engine = boot(config);

    await engine.start();

    expect(statSync(join(config.inboxPath, '_Graphics')).isDirectory()).toBe(true);
    expect(engine.clientFolders.list()).toEqual(['Acme']);
    const clients = clientListResponseSchema.parse(
      await (await engine.app.request('/api/clients')).json(),
    );
    expect(clients.map((row) => row.client)).toEqual(['Acme']);
    expect(engine.jobs.getAll().map((job) => job.relPath)).toEqual(['Acme/Spring']);
  });

  it('starts and stops its worker with the engine, with the fake runner beside a stand-in edit runner', async () => {
    const engine = boot(tempConfig({ STUDIO_GRAPHICS: '1' }));
    const worker = engine.graphicWorker;
    expect(worker).not.toBeNull();
    expect(worker?.runnerKind).toBe('fake');
    const start = vi.spyOn(worker as NonNullable<typeof worker>, 'start');
    const stop = vi.spyOn(worker as NonNullable<typeof worker>, 'stop');

    await engine.start();
    expect(start).toHaveBeenCalledTimes(1);
    await engine.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('builds the graphic runner it is given', () => {
    const runner = new FakeGraphicRunner({ speed: 7 });
    const make = vi.fn(() => runner);
    const engine = boot(tempConfig({ STUDIO_GRAPHICS: '1' }), { createGraphicRunner: make });
    expect(make).toHaveBeenCalledTimes(1);
    expect(engine.graphicWorker?.runnerKind).toBe('fake');
  });

  it('stops the Claude processes an earlier engine left running when the worker starts', async () => {
    const config = tempConfig({ STUDIO_GRAPHICS: '1' });
    // A record whose process is long gone: reaping deletes it and stops nothing.
    const records = join(config.dataDir, 'graphic-runs', 'g123456789ab');
    mkdirSync(records, { recursive: true });
    const record = join(records, 'run.json');
    writeFileSync(record, JSON.stringify({ jobId: 'run', pid: 999999, identity: 'gone' }));
    const engine = boot(config);

    await engine.start();

    await vi.waitFor(() => expect(existsSync(record)).toBe(false));
  });

  it('logs a usage line tagged transcribe for a voice note the real transcriber typed out', async () => {
    const config = tempConfig({ STUDIO_GRAPHICS: '1' });
    const transcriber = {
      kind: 'real' as const,
      enqueue: vi.fn(async () => ({ text: 'A white pill with the name' })),
      stop: vi.fn(async () => {}),
    };
    const engine = boot(config, { createTranscriber: () => transcriber });
    await engine.start();
    const form = new FormData();
    form.set('audio', new File([new Uint8Array([1, 2, 3])], 'voice.webm', { type: 'audio/webm' }));

    const res = await engine.app.request('/api/graphics/voice', { method: 'POST', body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'A white pill with the name' });
    await vi.waitFor(async () => {
      const lines = (await readUsageLog(config.dataDir)).filter(
        (entry) => entry.tag === 'transcribe',
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        source: 'app',
        did: 'Transcribed a voice note for a graphic',
      });
    });
  });

  it('logs no usage line for the fake transcriber’s notes', async () => {
    const config = tempConfig({ STUDIO_GRAPHICS: '1' });
    const engine = boot(config, {
      createTranscriber: () => ({
        kind: 'fake',
        enqueue: async () => ({ text: 'hello' }),
        stop: async () => {},
      }),
    });
    await engine.start();
    const form = new FormData();
    form.set('audio', new File([new Uint8Array([1, 2, 3])], 'voice.webm', { type: 'audio/webm' }));

    const res = await engine.app.request('/api/graphics/voice', { method: 'POST', body: form });

    expect(res.status).toBe(200);
    expect(await readUsageLog(config.dataDir)).toEqual([]);
  });

  it('tells "Used in" only while edits use the library', async () => {
    const engine = boot(tempConfig({ STUDIO_GRAPHICS: '1', STUDIO_GRAPHICS_IN_EDITS: '1' }));
    const graphic = engine.graphicsRepo.create({ name: 'Pill' });
    engine.graphicsRepo.addUse(graphic.id, 'job000000001', 1);

    expect(await health(engine)).toMatchObject({ graphics: true, graphicsInEdits: true });
    const res = await engine.app.request(`/api/graphics/${graphic.id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { usedIn: number | null }).usedIn).toBe(1);
  });
});

// GR8: the library reaches the Brief step only while edits use it.
describe('the Graphics library in edits (STUDIO_GRAPHICS_IN_EDITS)', () => {
  /** The options the engine gave the Brief step it built. */
  function briefOptions(config: Config) {
    const made: unknown[] = [];
    const engine = boot(config, {
      createRunner: () => ({ start: async () => ({ ok: true }) }),
      createBriefStep: (_config, options) => {
        made.push(options);
        return { prepare: async () => ({ ok: false, error: 'not run in this test' }) };
      },
    });
    return { engine, made: made as { graphics?: unknown }[] };
  }

  it.each([
    ['by default', {}],
    ['while the switch is on', { STUDIO_GRAPHICS: '1', STUDIO_GRAPHICS_IN_EDITS: '1' }],
  ])('gives the Brief step the library %s', (_case, env) => {
    const { engine, made } = briefOptions(tempConfig(env));
    expect(made).toHaveLength(1);
    expect(made[0]?.graphics).toBe(engine.graphicsRepo);
  });

  it.each([
    ['with the switch off', { STUDIO_GRAPHICS_IN_EDITS: '0' }],
    ['with Graphics off too', { STUDIO_GRAPHICS: '0' }],
  ])('gives it no library %s', (_case, env) => {
    const { made } = briefOptions(tempConfig(env));
    expect(made).toHaveLength(1);
    expect(made[0]?.graphics).toBeUndefined();
  });
});

describe('createGraphicRunner', () => {
  const config = {
    inboxPath: '/inbox',
    logsDir: '/data/logs',
    dataDir: '/data',
    claudeBin: 'claude',
    model: undefined,
  };

  it('builds the Claude run for runner "claude" and the fake one for "fake"', () => {
    expect(createGraphicRunner({ ...config, runner: 'claude' })).toBeInstanceOf(
      ClaudeGraphicRunner,
    );
    const fake = createGraphicRunner({ ...config, runner: 'fake' }, { env: {} });
    expect(fake).toBeInstanceOf(FakeGraphicRunner);
    expect(fake.kind).toBe('fake');
  });

  it('runs the fake at STUDIO_FAKE_SPEED, and refuses a speed that is not a number above 0', () => {
    const fake = createGraphicRunner(
      { ...config, runner: 'fake' },
      { env: { STUDIO_FAKE_SPEED: '20' } },
    );
    expect((fake as FakeGraphicRunner).speed).toBe(20);
    expect(() =>
      createGraphicRunner({ ...config, runner: 'fake' }, { env: { STUDIO_FAKE_SPEED: '0' } }),
    ).toThrow(/STUDIO_FAKE_SPEED/);
  });
});

describe('the graphics assets', () => {
  it('ship GSAP where every graphic loads it from, the same file as the preview sample’s', async () => {
    const { readFile } = await import('node:fs/promises');
    expect(GSAP_ASSET_PATH).toBe(join(GRAPHICS_ASSETS_DIR, 'vendor', 'gsap.min.js'));
    const shipped = await readFile(GSAP_ASSET_PATH);
    const sample = await readFile(
      new URL('./pipeline/testdata/preview/vendor/gsap.min.js', import.meta.url),
    );
    expect(shipped.equals(sample)).toBe(true);
    expect(shipped.toString('utf8', 0, 200)).toContain('GSAP');
  });
});

// "Used in" (GR9): a successful edit run records the library graphics its edit mounted, only while
// edits use the library. The edit runner is a stand-in that does what the Brief step and the editor
// do: copy a version of the library into edit/graphics/<id>/ and mount it in the preview.
describe('Used in, after an edit run', () => {
  const ID = 'a1b2c3d4e5f6';

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

  const versionOne = (config: Config) =>
    join(config.inboxPath, '_Graphics', 'Pill', 'versions', 'v1');

  /** The library holds the Pill at v1 on disk, and in the repository. */
  function libraryWithPill(engine: Engine, config: Config): void {
    engine.graphicsRepo.create({ id: ID, name: 'Pill' });
    const version = versionOne(config);
    mkdirSync(join(version, 'compositions'), { recursive: true });
    mkdirSync(join(version, 'lib', ID), { recursive: true });
    writeFileSync(join(version, 'compositions', `lib-${ID}.html`), '<template>pill</template>');
    writeFileSync(join(version, 'lib', ID, 'pill.svg'), '<svg/>');
    engine.graphicsRepo.setVersion(ID, { version: 1 });
  }

  function mountingRunner(config: Config, version: string): Runner {
    return {
      async start(job) {
        const edit = join(config.inboxPath, job.relPath, 'edit');
        await cp(version, join(edit, 'graphics', ID), { recursive: true });
        mkdirSync(join(edit, 'preview'), { recursive: true });
        writeFileSync(
          join(edit, 'preview', 'index.html'),
          `<div data-composition-src="compositions/lib-${ID}.html"></div>`,
        );
        return { ok: true, preview: SAMPLE_PREVIEW };
      },
    };
  }

  /** Boots an engine whose edit of a job mounts the Pill; returns once the job is in Review. */
  async function editOneJob(env: Record<string, string>) {
    const config = tempConfig({ STUDIO_GRAPHICS: '1', ...env });
    const engine = boot(config, {
      startInbox: idleInbox,
      createRunner: () => mountingRunner(config, versionOne(config)),
    });
    libraryWithPill(engine, config);
    const seen: ServerEvent[] = [];
    engine.bus.subscribe((event) => seen.push(event));
    await engine.start();

    mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
    const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Spring'));
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    engine.worker?.notify();
    await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'));
    return { engine, job, seen };
  }

  it('counts the video once the edit is done, tells the browsers, and shows in the graphic’s page', async () => {
    const { engine, job, seen } = await editOneJob({ STUDIO_GRAPHICS_IN_EDITS: '1' });

    expect(engine.graphicsRepo.usesCount(ID)).toBe(1);
    const changed = seen.filter((event) => event.type === 'graphic.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ graphic: { id: ID }, usedIn: 1 });
    const res = await engine.app.request(`/api/graphics/${ID}`);
    expect(((await res.json()) as { usedIn: number | null }).usedIn).toBe(1);
    expect(engine.jobs.get(job.id)?.state).toBe('review');
  });

  it('records nothing while edits do not use the library', async () => {
    const { engine } = await editOneJob({ STUDIO_GRAPHICS_IN_EDITS: '0' });

    expect(engine.graphicsRepo.usesCount(ID)).toBe(0);
    const res = await engine.app.request(`/api/graphics/${ID}`);
    expect(((await res.json()) as { usedIn: number | null }).usedIn).toBeNull();
  });
});
