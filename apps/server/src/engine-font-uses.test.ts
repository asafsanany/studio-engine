import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fontsListResponseSchema, type ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import { FIXTURE_FONTS } from './fonts/font-test-utils.js';
import { FONT_USES_BACKFILL_MARKER } from './fonts/font-uses.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import type { Runner } from './pipeline/runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// "Used in" for fonts (FN17), in the engine: a successful edit run records the library fonts its
// compositions use, only while Fonts is on and whatever fontsInNotes says (that one only decides
// whether the page shows the count); the first boot reads the jobs that finished before, once.
// The library is real fixture fonts in a temp inbox; the edit runner is a stand-in that writes a
// composition the way the editor does.

/** A busy machine (the whole suite runs at once) is slow to boot an engine: wait longer than the 1 s default. */
const WAIT = { timeout: 20_000 };
vi.setConfig({ testTimeout: 30_000 });

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = {}): Config {
  return configAt(makeTempDir('studio-engine-font-uses-'), env);
}

function configAt(home: string, env: Record<string, string> = {}): Config {
  const config = loadConfig({
    home,
    env: { STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0', ...env },
  });
  ensureDirs(config);
  return config;
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

function boot(config: Config, options: Partial<EngineOptions> = {}): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    startInbox: idleInbox,
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    ...options,
  });
  engines.push(engine);
  return engine;
}

/** The library: Outfit (two weights) and Secular One, filed the way the owner files their fonts. */
function fillLibrary(config: Config): void {
  for (const [rel, fixture] of [
    ['English only/Outfit/Outfit-Regular.ttf', 'Outfit-Regular.ttf'],
    ['English only/Outfit/Outfit-Bold.ttf', 'Outfit-Bold.ttf'],
    ['Hebrew + English/Secular One/SecularOne-Regular.ttf', 'SecularOne-Regular.ttf'],
  ] as const) {
    const target = join(config.inboxPath, '_Fonts', ...rel.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(join(FIXTURE_FONTS, fixture), target);
  }
}

/** The composition of a job: what the editor leaves in edit/preview. */
function writeComposition(config: Config, relPath: string, css: string): void {
  const preview = join(config.inboxPath, relPath, 'edit', 'preview');
  mkdirSync(preview, { recursive: true });
  writeFileSync(join(preview, 'index.html'), `<style>${css}</style><div id="root"></div>`);
}

const CAPTIONS = `.caption { font-family: "Outfit", sans-serif; } .title { font: 800 72px "Gotham"; }`;

describe('Used in, after an edit run', () => {
  /** An engine whose edit of the job Spring writes `css`; returns once the job is in Review. */
  async function editOneJob(env: Record<string, string>, css = CAPTIONS) {
    const config = tempConfig(env);
    fillLibrary(config);
    const runner: Runner = {
      async start(job) {
        writeComposition(config, job.relPath, css);
        return { ok: true, preview: SAMPLE_PREVIEW };
      },
    };
    const engine = boot(config, { createRunner: () => runner });
    const seen: ServerEvent[] = [];
    engine.bus.subscribe((event) => seen.push(event));
    await engine.start();

    mkdirSync(join(config.inboxPath, 'Acme', 'Spring'), { recursive: true });
    const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Spring'));
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    engine.worker?.notify();
    await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'), WAIT);
    return { config, engine, job, seen };
  }

  it('counts the video once the edit is done: a family of the library, not one it does not have', async () => {
    const { engine, job } = await editOneJob({ STUDIO_FONTS: '1', STUDIO_FONTS_IN_NOTES: '1' });

    expect(engine.fontsRepo.usedCount('Outfit')).toBe(1);
    expect(engine.fontsRepo.usedCount('Gotham')).toBe(0);
    expect(engine.fontsRepo.usedCount('Secular One')).toBe(0);
    expect([...engine.fontsRepo.usedCounts()]).toEqual([['outfit', 1]]);
    expect(engine.jobs.get(job.id)?.state).toBe('review');
  });

  it('tells the browsers and shows in the list and the font’s page while the count shows', async () => {
    const { engine, seen } = await editOneJob({ STUDIO_FONTS: '1', STUDIO_FONTS_IN_NOTES: '1' });

    const changed = seen.filter((event) => event.type === 'font.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      family: { slug: 'outfit', name: 'Outfit', used: 1, usedLabel: '1 job' },
    });
    const list = fontsListResponseSchema.parse(
      await (await engine.app.request('/api/fonts')).json(),
    );
    expect(list.families.map((family) => [family.name, family.used])).toEqual([
      ['Outfit', 1],
      ['Secular One', 0],
    ]);
    const pane = await engine.app.request('/api/fonts/outfit');
    expect(((await pane.json()) as { usedIn: number | null }).usedIn).toBe(1);
  });

  it('fills the table with the notes switch off, and shows nothing yet', async () => {
    const { engine, seen } = await editOneJob({ STUDIO_FONTS: '1', STUDIO_FONTS_IN_NOTES: '0' });

    expect(engine.fontsRepo.usedCount('Outfit')).toBe(1);
    expect(seen.filter((event) => event.type === 'font.changed')).toEqual([]);
    const list = fontsListResponseSchema.parse(
      await (await engine.app.request('/api/fonts')).json(),
    );
    expect(list.families.map((family) => family.used)).toEqual([0, 0]);
  });

  it('records nothing while Fonts is off', async () => {
    const { engine } = await editOneJob({ STUDIO_FONTS: '0' });

    expect(engine.fontsRepo.usedCounts().size).toBe(0);
  });

  it('records a second video as a second job', async () => {
    const { config, engine } = await editOneJob({ STUDIO_FONTS: '1' });
    mkdirSync(join(config.inboxPath, 'Acme', 'Summer'), { recursive: true });
    const { job } = engine.jobs.upsertFromScan(makeScan('Acme', 'Summer'));
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    engine.worker?.notify();
    await vi.waitFor(() => expect(engine.jobs.get(job.id)?.state).toBe('review'), WAIT);

    expect(engine.fontsRepo.usedCount('Outfit')).toBe(2);
  });
});

describe('the backfill at boot', () => {
  const marker = (config: Config) => join(config.dataDir, FONT_USES_BACKFILL_MARKER);

  /** A job that finished before: in Review, with its edit on disk and its row in the database. */
  function finishedJob(engine: Engine, config: Config, name: string, css: string) {
    writeComposition(config, `Acme/${name}`, css);
    const { job } = engine.jobs.upsertFromScan(makeScan('Acme', name));
    engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
    engine.jobs.applyTransition(job.id, { type: 'START' });
    return engine.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  }

  it('records the fonts of the jobs that finished before, once, and writes the marker', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    fillLibrary(config);
    const engine = boot(config);
    const old = finishedJob(engine, config, 'Old', CAPTIONS);
    // A job whose folder is gone is skipped, not a failure.
    const { job: gone } = engine.jobs.upsertFromScan(makeScan('Acme', 'Gone'));
    engine.jobs.applyTransition(gone.id, { type: 'SETTLED' });
    engine.jobs.applyTransition(gone.id, { type: 'START' });
    engine.jobs.applyTransition(gone.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });

    await engine.start();
    await vi.waitFor(() => expect(existsSync(marker(config))).toBe(true), WAIT);

    expect(engine.fontsRepo.usedCount('Outfit')).toBe(1);
    expect(engine.fontsRepo.usedCount('Secular One')).toBe(0);
    expect(JSON.parse(readFileSync(marker(config), 'utf8'))).toMatchObject({
      jobs: 2,
      skipped: 1,
      uses: 1,
    });
    expect(engine.jobs.get(old.id)?.state).toBe('review');
  });

  it('does not run again on the next boot', async () => {
    const home = makeTempDir('studio-engine-font-uses-');
    const config = configAt(home, { STUDIO_FONTS: '1' });
    fillLibrary(config);
    const first = boot(config);
    finishedJob(first, config, 'Old', CAPTIONS);
    await first.start();
    await vi.waitFor(() => expect(existsSync(marker(config))).toBe(true), WAIT);
    await first.stop();
    expect(first.fontsRepo.usedCount('Outfit')).toBe(1);

    // A fresh database (and so no rows) over the same data dir, with a finished job to read.
    const second = boot(configAt(home, { STUDIO_FONTS: '1' }));
    expect(second.fontsRepo.usedCounts().size).toBe(0);
    finishedJob(second, config, 'Newer', CAPTIONS);
    await second.start();
    await second.stop();

    expect(second.fontsRepo.usedCounts().size).toBe(0);
  });

  it('reads nothing while Fonts is off', async () => {
    const config = tempConfig({ STUDIO_FONTS: '0' });
    fillLibrary(config);
    const engine = boot(config);
    finishedJob(engine, config, 'Old', CAPTIONS);

    await engine.start();
    await engine.stop();

    expect(existsSync(marker(config))).toBe(false);
    expect(engine.fontsRepo.usedCounts().size).toBe(0);
  });

  it('waits for fonts: an empty library leaves no marker for the next boot to trip over', async () => {
    const config = tempConfig({ STUDIO_FONTS: '1' });
    const engine = boot(config);
    finishedJob(engine, config, 'Old', CAPTIONS);

    await engine.start();
    await engine.stop();

    expect(existsSync(marker(config))).toBe(false);
  });
});
