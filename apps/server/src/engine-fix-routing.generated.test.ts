import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, ReviewNote } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { writeFakePreview } from './pipeline/fake-preview.js';
import { FakeQuickFixRunner } from './review/fake-quick-fix.js';
import { BOTH_FORMATS_WHY } from './review/generated-route.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The quick-fix router in the boot composition, with a generated video (GN6) and a job with two
// formats (GN7) in Review. The keyword router stands in for Haiku (it calls "the logo on their shirt"
// and "stress the word" quick, as it would any caption note), and the guard in front of it keeps a
// clip note and a voice note out of a quick fix, and every note of a two-format job. An ordinary
// caption note of the same generated job is still fixed at once, and a footage job is untouched.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(): Config {
  const home = makeTempDir('studio-engine-fix-generated-');
  const config = loadConfig({
    home,
    env: { STUDIO_QUICK_FIXES: '1', STUDIO_MANUAL_START: '0', STUDIO_KNOWN_CLIENTS_ONLY: '0' },
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

function boot() {
  const config = tempConfig();
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    startInbox: idleInbox,
    builtInLuts: noBuiltInLuts(),
    quickFixRunner: new FakeQuickFixRunner({ config, speed: 200 }),
  });
  engines.push(engine);
  return { engine, config };
}

interface Options {
  /** The brief says `production: generate`, and the hand-off is on disk. */
  generated?: boolean;
  formats?: string[];
}

/** A job in Review with the stand-in's composition on disk. */
async function inReview(engine: Engine, config: Config, name: string, options: Options = {}) {
  const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.jobs.applyTransition(job.id, { type: 'START' });
  engine.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  const editDir = join(config.inboxPath, job.relPath, 'edit');
  mkdirSync(join(editDir, 'generate'), { recursive: true });
  await writeFakePreview(editDir, name);
  writeFileSync(join(editDir, 'project.md'), `# ${name}\n`);
  if (options.generated === true) {
    writeFileSync(
      join(editDir, 'brief.json'),
      JSON.stringify({ schema: 1, summary: 'x', production: 'generate', budgetUsd: null }),
    );
    // Clip B covers 1 to 3 s of the cut; the voice has two lines.
    writeFileSync(
      join(editDir, 'generate', 'shots.json'),
      JSON.stringify({
        shots: [
          {
            id: 'B',
            file: 'clips/B/take-1.mp4',
            take: 1,
            windows: [{ startSec: 1, endSec: 3 }],
            seconds: 2,
            shows: 'The technician fits the squeegee',
            model: 'alibaba/wan-3.0/image-to-video',
            usd: 0.51,
            belowBar: false,
          },
        ],
      }),
    );
    writeFileSync(
      join(editDir, 'generate', 'voice-words.json'),
      JSON.stringify({
        words: [
          { line: 'L1', text: 'But', startSec: 0, endSec: 0.4 },
          { line: 'L1', text: 'wait', startSec: 0.4, endSec: 1 },
          { line: 'L2', text: 'Call', startSec: 1.4, endSec: 1.8 },
          { line: 'L2', text: 'now', startSec: 1.8, endSec: 4 },
        ],
      }),
    );
  }
  if (options.formats !== undefined) engine.jobs.setFormats(job.id, options.formats);
  return engine.jobs.get(job.id) as Job;
}

/** Adds a note at `atSec` and waits until the router has sorted it. */
async function addRouted(engine: Engine, job: Job, text: string, atSec = 2): Promise<ReviewNote> {
  const added = engine.review.addTextNote(job.id, { atSec, text });
  await vi.waitFor(() => expect(engine.notes.get(added.id)?.routeStatus).toBe('routed'), {
    timeout: 3_000,
  });
  return engine.notes.get(added.id) as ReviewNote;
}

const fixesOf = (engine: Engine, job: Job) =>
  engine.fixes?.list(engine.jobs.get(job.id) as Job) ?? [];

describe('a generated video in Review on Auto', () => {
  it('a note about what is in a clip is sorted full, with the clip, and no fix is made', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'Window Ad', { generated: true });

    // The keyword router alone would call this quick ("logo"); the guard reads it as the hint does.
    const note = await addRouted(engine, job, 'the logo on their shirt looks wrong', 2);

    expect(note.route).toEqual({
      tier: 'full',
      kind: 'New take of clip B',
      why: 'it needs a new take of a clip',
    });
    expect(fixesOf(engine, job)).toEqual([]);
    expect(note.fixId).toBeNull();
  });

  it('a note about the voice is sorted full and never fixed in the composition', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'Window Ad', { generated: true });

    const note = await addRouted(engine, job, 'stress the word but more', 0.5);

    expect(note.route).toEqual({
      tier: 'full',
      kind: 'Remaking a voice line',
      why: 'it needs the voice line made again',
    });
    expect(fixesOf(engine, job)).toEqual([]);
  });

  it('a caption note of the same job is still a quick fix', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'Window Ad', { generated: true });

    const note = await addRouted(engine, job, 'make the title yellow', 2);

    expect(note.route).toMatchObject({ tier: 'quick' });
    await vi.waitFor(() => expect(engine.notes.get(note.id)?.fixId).not.toBeNull(), {
      timeout: 5_000,
    });
    expect(fixesOf(engine, job)).toHaveLength(1);
  });

  it('a layout word on a moment with no clip on screen stays a quick fix: it is the end card, not a clip', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'Window Ad', { generated: true });

    // 3.5 s is after clip B's window: the logo there is a graphic of the edit.
    const note = await addRouted(engine, job, 'make the logo bigger', 3.5);

    expect(note.route).toMatchObject({ tier: 'quick', kind: 'Changing the logo' });
  });
});

describe('any other job', () => {
  it('a footage job’s logo note is a quick fix, as before', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'Footage job');

    const note = await addRouted(engine, job, 'the logo on their shirt looks wrong', 2);

    expect(note.route).toMatchObject({ tier: 'quick', kind: 'Changing the logo' });
  });

  it('a job whose brief says footage is not held back either', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'Footage job 2');
    writeFileSync(
      join(config.inboxPath, job.relPath, 'edit', 'brief.json'),
      JSON.stringify({ schema: 1, summary: 'x', production: 'footage' }),
    );

    const note = await addRouted(engine, job, 'stress the word but more', 2);

    expect(note.route).toMatchObject({ tier: 'quick' });
  });
});

describe('a job with two formats', () => {
  it('a note the router calls quick waits for Send instead: a quick fix would leave the 1:1 as it was', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'Two sizes', {
      formats: ['1080x1920', '1080x1080'],
    });
    expect(engine.jobs.get(job.id)?.formats).toHaveLength(2);

    const note = await addRouted(engine, job, 'make the title yellow', 2);

    expect(note.route).toEqual({
      tier: 'revise',
      kind: 'Changing the title',
      why: BOTH_FORMATS_WHY,
    });
    expect(fixesOf(engine, job)).toEqual([]);
  });

  it('a note that was not quick keeps its tier', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'Two sizes 2', {
      formats: ['1080x1920', '1080x1080'],
    });

    const note = await addRouted(engine, job, 'swap this shot', 2);

    expect(note.route).toMatchObject({ tier: 'revise', why: 'it changes the cut' });
  });

  it('a job with one format is not held back', async () => {
    const { engine, config } = boot();
    await engine.start();
    const job = await inReview(engine, config, 'One size');

    const note = await addRouted(engine, job, 'make the title yellow', 2);

    expect(note.route).toMatchObject({ tier: 'quick' });
  });
});
