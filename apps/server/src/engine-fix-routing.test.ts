import type { Job, NoteRoute, ReviewNote } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { NoteRepository } from './db/index.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import type { NoteRouter } from './review/fix-router.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// The router in the boot composition (quick fixes, QF1): with the switch on every new note of a job
// in Review on Auto is sorted in the background; with it off nothing is. A shutdown stops a run
// that goes, and a boot reads again the notes an earlier engine left pending. The Claude run is a
// stand-in, or the fake keyword router the engine picks when the runner is not the real one.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

function tempConfig(env: Record<string, string> = { STUDIO_QUICK_FIXES: '1' }): Config {
  const home = makeTempDir('studio-engine-fix-routing-');
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
    builtInLuts: noBuiltInLuts(),
    ...options,
  });
  engines.push(engine);
  return engine;
}

/** A router that records its notes and answers `route` at once. */
function routerAnswering(route: NoteRoute) {
  const calls: Array<{ job: Job; note: ReviewNote; signal: AbortSignal | undefined }> = [];
  const router: NoteRouter = {
    async route(job, note, signal) {
      calls.push({ job, note, signal });
      return route;
    },
  };
  return { router, calls };
}

function inReview(engine: Engine, name = 'Ep 1'): Job {
  const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.jobs.applyTransition(job.id, { type: 'START' });
  engine.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  return engine.jobs.get(job.id) as Job;
}

const REVISE: NoteRoute = { tier: 'revise', kind: 'Replacing a shot', why: 'it changes the cut' };

describe('the router in the engine', () => {
  it('sorts a new note in the background: pending, then routed', async () => {
    const stub = routerAnswering(REVISE);
    const engine = boot(tempConfig(), { noteRouter: stub.router });
    const job = inReview(engine);

    const added = engine.review.addTextNote(job.id, { atSec: 5, text: 'swap this shot' });
    expect(added).toMatchObject({ routeStatus: 'pending', route: null });

    await vi.waitFor(() =>
      expect(engine.review.listNotes(job.id)[0]).toMatchObject({
        routeStatus: 'routed',
        route: REVISE,
      }),
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.job.id).toBe(job.id);
  });

  it('tells the browsers with note.upsert, twice', async () => {
    const stub = routerAnswering(REVISE);
    const engine = boot(tempConfig(), { noteRouter: stub.router });
    const job = inReview(engine);
    const seen: Array<ReviewNote['routeStatus']> = [];
    engine.bus.subscribe((event) => {
      if (event.type === 'note.upsert') seen.push(event.note.routeStatus);
    });

    engine.review.addTextNote(job.id, { atSec: 5, text: 'swap this shot' });
    await vi.waitFor(() => expect(seen).toEqual(['pending', 'routed']));
  });

  it('leaves every note alone with the switch off', async () => {
    const stub = routerAnswering(REVISE);
    const engine = boot(tempConfig({ STUDIO_QUICK_FIXES: '0' }), { noteRouter: stub.router });
    const job = inReview(engine);

    const added = engine.review.addTextNote(job.id, { atSec: 5, text: 'swap this shot' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(added).toMatchObject({ routeStatus: null, route: null });
    expect(engine.review.listNotes(job.id)[0]).toMatchObject({ routeStatus: null, route: null });
    expect(stub.calls).toHaveLength(0);
  });

  it('leaves a note alone when the job is on a manual level', async () => {
    const stub = routerAnswering(REVISE);
    const engine = boot(tempConfig(), { noteRouter: stub.router });
    const job = inReview(engine);
    engine.jobs.setReviewEffort(job.id, 'high');

    const added = engine.review.addTextNote(job.id, { atSec: 5, text: 'swap this shot' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(added.routeStatus).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

  it('uses the fake keyword router, after 300 ms, when the runner is not the real one', async () => {
    const engine = boot(tempConfig());
    const job = inReview(engine);

    const added = engine.review.addTextNote(job.id, { atSec: 5, text: 'make the captions yellow' });
    expect(added.routeStatus).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(engine.review.listNotes(job.id)[0]?.routeStatus).toBe('pending');

    await vi.waitFor(
      () =>
        expect(engine.review.listNotes(job.id)[0]).toMatchObject({
          routeStatus: 'routed',
          route: { tier: 'quick', kind: 'Changing the caption colour', why: '' },
        }),
      { timeout: 3_000 },
    );
  });

  it('stops a run that goes when the engine stops, and saves nothing', async () => {
    let signal: AbortSignal | undefined;
    const hanging: NoteRouter = {
      route: (_job, _note, given) =>
        new Promise<NoteRoute>((_resolve, reject) => {
          signal = given;
          given?.addEventListener('abort', () => reject(given.reason), { once: true });
        }),
    };
    const engine = boot(tempConfig(), { noteRouter: hanging });
    const job = inReview(engine);
    const added = engine.review.addTextNote(job.id, { atSec: 5, text: 'swap this shot' });
    await vi.waitFor(() => expect(signal).toBeDefined());

    await engine.stop();

    expect(signal?.aborted).toBe(true);
    expect(engine.review.listNotes(job.id)[0]).toMatchObject({
      id: added.id,
      routeStatus: 'pending',
    });
  });

  it('reads again at start the notes an earlier engine left pending', async () => {
    const db = memoryDb();
    const stub = routerAnswering(REVISE);
    const engine = boot(tempConfig(), { db, noteRouter: stub.router });
    const job = inReview(engine);
    // A note the earlier engine was still reading when it stopped.
    const notes = new NoteRepository(db);
    const left = notes.create({ id: 'left', jobId: job.id, kind: 'text', atSec: 3, text: 'swap' });
    notes.setRoute(left.id, { status: 'pending' });
    expect(stub.calls).toHaveLength(0);

    await engine.start();

    await vi.waitFor(() =>
      expect(notes.get('left')).toMatchObject({ routeStatus: 'routed', route: REVISE }),
    );
    expect(stub.calls.map((call) => call.note.id)).toEqual(['left']);
  });
});
