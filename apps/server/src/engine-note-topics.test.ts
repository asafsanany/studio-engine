import type { Job } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteTopicStore } from './analytics/note-topics.js';
import type { NoteTopicRunner, NoteTopicRunRequest } from './analytics/note-topics-run.js';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The topic pass in the boot composition (Analytics, AN4): a Send and the engine start ask for a
// pass, a burst of Sends makes one run, the topics land in <dataDir>/note-topics.json, and a
// shutdown cancels a pass that is waiting. The Claude run is a stand-in.

const DEBOUNCE_MS = 40;

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = { STUDIO_ANALYTICS: '1' }): Config {
  const home = makeTempDir('studio-engine-note-topics-');
  const config = loadConfig({
    home,
    env: {
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      STUDIO_SETTLE_MS: '300',
      // Quick fixes are on by default (QF9); the notes here go straight to Send.
      STUDIO_QUICK_FIXES: '0',
      ...env,
    },
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

const unavailable = (): never => {
  throw new RunnerUnavailableError('claude', 'E3');
};

function boot(config: Config, options: Partial<EngineOptions> = {}): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: unavailable,
    startInbox: idleInbox,
    noteTopicDebounceMs: DEBOUNCE_MS,
    // No colour-grade skill: no LUT stills written into the temp home after the test removed it.
    builtInLuts: noBuiltInLuts(),
    ...options,
  });
  engines.push(engine);
  return engine;
}

/** A Claude run that records its requests and gives every note of the prompt `topic`. */
function runnerWith(topic: string) {
  const calls: NoteTopicRunRequest[] = [];
  const runner: NoteTopicRunner = {
    async run(request) {
      calls.push(request);
      const lines = request.prompt.split('\n');
      const notes = lines
        .slice(lines.indexOf('Notes, one JSON object per line:') + 1)
        .map((line) => JSON.parse(line) as { id: string });
      return { ok: true, text: JSON.stringify(notes.map((note) => ({ id: note.id, topic }))) };
    },
  };
  return { runner, calls };
}

/** A job in Review with one unsent note per text. */
function inReview(engine: Engine, name: string, texts: string[]): Job {
  const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.jobs.applyTransition(job.id, { type: 'START' });
  engine.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  texts.forEach((text, index) => {
    engine.review.addTextNote(job.id, { atSec: index + 1, text });
  });
  return job;
}

const topicsOf = (config: Config) => new NoteTopicStore(config.dataDir).get();

describe('the topic pass in the engine', () => {
  it('runs once after a burst of Sends, and the topics are in note-topics.json', async () => {
    const config = tempConfig();
    const stub = runnerWith('intro too long');
    const engine = boot(config, { noteTopicRunner: stub.runner });
    const first = inReview(engine, 'Ep 1', ['Intro is long', 'Cut the pause']);
    const second = inReview(engine, 'Ep 2', ['Intro again']);

    await engine.review.sendNotes(first.id);
    await engine.review.sendNotes(second.id);
    expect(stub.calls).toHaveLength(0); // waiting for things to go quiet

    await vi.waitFor(() => expect(Object.keys(topicsOf(config))).toHaveLength(3), {
      timeout: 5_000,
    });
    expect(stub.calls).toHaveLength(1);
    expect(Object.values(topicsOf(config))).toEqual([
      'intro too long',
      'intro too long',
      'intro too long',
    ]);
    expect(stub.calls[0]?.usage).toMatchObject({
      tag: 'note-topics',
      did: 'Grouped 3 review notes into topics',
    });
  });

  it('gives the notes that have no topic yet a topic at start', async () => {
    const config = tempConfig();
    const db = memoryDb();
    // Notes sent while no pass could run (the switch was off, say).
    const before = boot(config, { db, noteTopicRunner: null });
    const job = inReview(before, 'Ep 1', ['Music is loud']);
    await before.review.sendNotes(job.id);
    expect(topicsOf(config)).toEqual({});

    const stub = runnerWith('music too loud');
    const after = boot(config, { db, noteTopicRunner: stub.runner });
    await after.start();

    await vi.waitFor(() => expect(Object.values(topicsOf(config))).toEqual(['music too loud']), {
      timeout: 5_000,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('asks again at start for notes a pass could not group', async () => {
    const config = tempConfig();
    const calls: NoteTopicRunRequest[] = [];
    const failing: NoteTopicRunner = {
      async run(request) {
        calls.push(request);
        return { ok: false, error: 'Note topics stopped: no network.' };
      },
    };
    const engine = boot(config, { noteTopicRunner: failing });
    const job = inReview(engine, 'Ep 1', ['Music is loud']);
    await engine.review.sendNotes(job.id);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5_000 });
    expect(topicsOf(config)).toEqual({});

    await engine.start();
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5_000 });
  });

  it('stops a pass that is waiting when the engine stops', async () => {
    const config = tempConfig();
    const stub = runnerWith('intro too long');
    const engine = boot(config, { noteTopicRunner: stub.runner, noteTopicDebounceMs: 150 });
    const job = inReview(engine, 'Ep 1', ['Intro is long']);
    await engine.review.sendNotes(job.id);

    await engine.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(stub.calls).toHaveLength(0);
    expect(topicsOf(config)).toEqual({});
  });

  it('never fails a Send when the pass cannot run', async () => {
    const config = tempConfig();
    const broken: NoteTopicRunner = {
      async run() {
        throw new Error('the runner broke');
      },
    };
    const engine = boot(config, { noteTopicRunner: broken });
    const job = inReview(engine, 'Ep 1', ['Intro is long']);

    expect((await engine.review.sendNotes(job.id)).state).toBe('queued');
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 3));
    expect(topicsOf(config)).toEqual({});
  });
});

describe('without a topic runner', () => {
  it('starts no pass while the Analytics switch is off, and none for a stand-in runner', async () => {
    // createRunner is replaced in every test engine, so the real Claude run is never made.
    const off = tempConfig({ STUDIO_ANALYTICS: '0' });
    const engine = boot(off);
    const job = inReview(engine, 'Ep 1', ['Intro is long']);
    expect((await engine.review.sendNotes(job.id)).state).toBe('queued');
    await engine.start();
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 3));
    expect(topicsOf(off)).toEqual({});

    const on = tempConfig();
    const standIn = boot(on);
    const standInJob = inReview(standIn, 'Ep 1', ['Intro is long']);
    await standIn.review.sendNotes(standInJob.id);
    await standIn.start();
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 3));
    expect(topicsOf(on)).toEqual({});
  });

  it('is turned off by a null runner even where one is asked for', async () => {
    const config = tempConfig();
    const engine = boot(config, { noteTopicRunner: null });
    const job = inReview(engine, 'Ep 1', ['Intro is long']);
    expect((await engine.review.sendNotes(job.id)).state).toBe('queued');
    expect(topicsOf(config)).toEqual({});
  });
});
