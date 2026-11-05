import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, ServerEvent } from '@studio/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Config, loadConfig } from '../config.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { createEngine, type Engine } from '../engine.js';
import type { RunningInbox } from '../inbox/boot.js';
import type { InboxWatcher } from '../inbox/watcher.js';
import type { Runner } from '../pipeline/runner.js';
import type { MemoryEventBus } from './bus.js';
import { SseReader } from './test-utils.js';

// A2's acceptance, end to end on the real boot composition (in-memory database, real routes, real
// worker, real bus, real SSE route): connect, make a change the way a user or the worker would,
// and read what the connected browsers get.

let home: string;
let config: Config;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'studio-engine-events-'));
  config = loadConfig({ home, env: { STUDIO_MANUAL_START: '0' } });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const readers: SseReader[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
  for (const engine of engines.splice(0)) await engine.stop();
});

// An inbox that does nothing: these jobs have no folders on disk, so a real reconcile at start
// would remove them, and these tests must not start a real file watcher.
const idleInbox = async (): Promise<RunningInbox> => ({
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

function boot(createRunner?: () => Runner): Engine {
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    startInbox: idleInbox,
    createRunner:
      createRunner ??
      (() => {
        // No runner: edits are paused, so only the API moves jobs.
        throw new (class extends Error {})('paused');
      }),
  });
  engines.push(engine);
  return engine;
}

function bus(engine: Engine): MemoryEventBus {
  return engine.bus as MemoryEventBus;
}

async function connect(engine: Engine): Promise<SseReader> {
  const reader = new SseReader(await engine.app.request('/api/events'));
  readers.push(reader);
  expect(await reader.event()).toEqual({ type: 'hello' });
  return reader;
}

/** A job in the queue, as the watcher leaves it: written, then published. */
function addQueued(engine: Engine, name: string): Job {
  const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  const queued = engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.bus.publish({ type: 'job.upsert', job: queued });
  return queued;
}

const post = (engine: Engine, job: Job, action: string) =>
  engine.app.request(`/api/jobs/${job.id}/${action}`, { method: 'POST' });

/** `Name:state:place` for an upsert, `remove:id` for a removal. */
function summary(event: ServerEvent): string {
  if (event.type === 'job.upsert') {
    return `${event.job.name}:${event.job.state}:${event.job.placeInLine ?? '-'}`;
  }
  return event.type === 'job.remove' ? `remove:${event.id}` : 'hello';
}

describe('the event stream of a booted engine', () => {
  it('delivers the upsert of a transition to a subscriber', async () => {
    const engine = boot();
    const job = addQueued(engine, 'A');
    const reader = await connect(engine);

    expect((await post(engine, job, 'hold')).status).toBe(200);

    const event = await reader.event();
    expect(event).toEqual({
      type: 'job.upsert',
      job: { ...(engine.jobs.get(job.id) as Job), state: 'held' },
    });
  });

  it('delivers it to two clients, in the same order', async () => {
    const engine = boot();
    const a = addQueued(engine, 'A');
    addQueued(engine, 'B');
    const first = await connect(engine);
    const second = await connect(engine);

    await post(engine, a, 'hold');

    // A leaves the queue, so B moves up.
    const expected = ['A:held:-', 'B:queued:1'];
    expect((await first.events()).map(summary)).toEqual(expected);
    expect((await second.events()).map(summary)).toEqual(expected);
  });

  it('shows every place in line that moved when a job leaves the queue', async () => {
    const engine = boot();
    addQueued(engine, 'A');
    const b = addQueued(engine, 'B');
    addQueued(engine, 'C');
    addQueued(engine, 'D');
    const reader = await connect(engine);

    await post(engine, b, 'hold');

    // A keeps its place and says nothing; C and D move up.
    expect((await reader.events()).map(summary)).toEqual(['B:held:-', 'C:queued:2', 'D:queued:3']);
  });

  it('frees the listeners of clients that disconnect', async () => {
    const engine = boot();
    const baseline = bus(engine).listenerCount();
    const first = await connect(engine);
    const second = await connect(engine);
    expect(bus(engine).listenerCount()).toBe(baseline + 2);

    await first.cancel();
    await vi.waitFor(() => expect(bus(engine).listenerCount()).toBe(baseline + 1));
    await second.cancel();
    await vi.waitFor(() => expect(bus(engine).listenerCount()).toBe(baseline));
  });

  it('ends the streams when the engine stops, so shutdown does not wait for a browser', async () => {
    const engine = boot();
    const baseline = bus(engine).listenerCount();
    const reader = await connect(engine);

    await engine.stop();

    expect(await reader.frame()).toBeNull();
    expect(reader.ended).toBe(true);
    // The stream's listener is gone, and so are the review service's (stop() ends it, W5), the
    // push service's (PH11) and the review videos' (the warm-up that makes them, v0.50.2), and,
    // with Quick fixes on (the default since QF9), the note routing's and the fix service's, with
    // Music on (the default since U22) the music service's and, with Songs on too, the second
    // export's.
    const quickFixListeners = config.quickFixes ? 2 : 0;
    const musicListeners = config.music ? 1 : 0;
    const songListeners = config.music && config.songs ? 1 : 0;
    expect(bus(engine).listenerCount()).toBe(
      baseline - 3 - quickFixListeners - musicListeners - songListeners,
    );
  });

  it('publishes each queued job once when the first one starts (CVP-89)', async () => {
    // A run that stays open until the engine stops it.
    const engine = boot(() => ({
      start: (_job, _mode, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped' }));
        }),
    }));
    addQueued(engine, 'A');
    addQueued(engine, 'B');
    addQueued(engine, 'C');
    // What every listener of the bus sees: the SSE streams thin their copy, so count it here.
    const published: string[] = [];
    bus(engine).subscribe((event) => published.push(summary(event)));

    await engine.start();
    await vi.waitFor(() => expect(engine.worker?.activeJobId).not.toBeNull());
    // Give anything that was going to be published a few turns to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A starts; B and C move up one place each. Two jobs edit at once (the default), so B starts
    // beside it and C moves up again. Nobody is told the same thing twice.
    expect(published).toEqual([
      'A:editing:-',
      'B:queued:1',
      'C:queued:2',
      'B:editing:-',
      'C:queued:1',
    ]);
  });

  it('carries what the queue worker publishes, thinned to the latest state', async () => {
    const engine = boot(() => ({
      start: async (_job, _mode, context) => {
        context.progress(1, '1/2');
        context.progress(1, '2/2');
        context.progress(3, null);
        return { ok: true };
      },
    }));
    const job = addQueued(engine, 'A');
    const reader = await connect(engine);

    // The worker starts once the inbox is up (W3), so wait for the start before waiting for it.
    await engine.start();
    await engine.worker?.idle();

    // Starting goes out at once; the rest of the run is one burst, so it arrives as one frame
    // after the window: the last word, which is the failure (export is E6).
    const events = await reader.events(600);
    const upserts = events.flatMap((event) => (event.type === 'job.upsert' ? [event.job] : []));
    expect(upserts.map((j) => j.state)).toEqual(['editing', 'failed']);
    expect(upserts.every((j) => j.id === job.id)).toBe(true);
    expect(upserts[1]?.updatedAt).toBe(engine.jobs.get(job.id)?.updatedAt);
  });
});
