import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EXPORT_MISSING_ERROR,
  type Job,
  PREVIEW_MISSING_ERROR,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRepository } from '../db/index.js';
import { type FakeClock, fakeClock, memoryDb, SAMPLE_PREVIEW, T0 } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { DurationCache } from './probe.js';
import { type ReconcileOptions, type ReconcileSummary, reconcile } from './reconcile.js';
import { scanJob } from './scan.js';
import { FOLDER_REMOVED_ERROR } from './watcher.js';

// Every rule of the startup reconciliation, against a real temp inbox and an in-memory database.
// The clock is a fake shared by the repository and the reconciliation, so ages are exact.

const SETTLE_MS = 60_000;
const OUTPUT = { durationSec: 45.2, width: 1080, height: 1920, sizeBytes: 1_000 };

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function setup(settleMs = SETTLE_MS) {
  // Straight from tmpdir(): on macOS that sits behind the /var -> /private/var link.
  const base = mkdtempSync(join(tmpdir(), 'studio-reconcile-'));
  const inbox = join(base, 'Studio Inbox');
  const exportsDir = join(inbox, '_Exports');
  mkdirSync(exportsDir, { recursive: true });
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));

  const clock: FakeClock = fakeClock(T0);
  const db = memoryDb();
  const repo = new JobRepository(db, { clock });
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const durations = new DurationCache(async () => null);
  const logger = silentLogger();

  /** Writes a file (`size` bytes, or the given text) at `rel` inside `Client/Job`. */
  const put = (client: string, name: string, rel: string, content: number | string = 10) => {
    const path = join(inbox, client, name, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'number' ? Buffer.alloc(content, 1) : content);
  };

  const scanOf = async (client: string, name: string) => {
    const scan = await scanJob(inbox, client, name, { exportsDir, durations });
    if (scan === null) throw new Error(`no folder for ${client}/${name}`);
    return scan;
  };

  /** Makes the job known to the repository exactly as the watcher would have: from a scan. */
  const track = async (client: string, name: string): Promise<Job> =>
    repo.upsertFromScan(await scanOf(client, name)).job;

  /** A job the repository knows but whose folder never existed (or is gone). */
  const trackGhost = (client: string, name: string): Job => {
    const relPath = `${client}/${name}`;
    const { job } = repo.upsertFromScan({
      id: relPath,
      client,
      name,
      relPath,
      inputs: { video: 1, audio: 0, image: 0, doc: 0 },
      sizeBytes: 10,
      footageSec: 0,
    });
    return job;
  };

  const apply = (id: string, ...types: Parameters<typeof repo.applyTransition>[1][]): Job => {
    let job = repo.get(id) as Job;
    for (const event of types) job = repo.applyTransition(id, event);
    return job;
  };
  const toQueued = (id: string) => apply(id, { type: 'SETTLED' });
  const toEditing = (id: string, step: 2 | 5 = 5) =>
    apply(id, { type: 'SETTLED' }, { type: 'START' }, { type: 'PROGRESS', step, sub: '2/5' });
  const toReady = (id: string, fileName: string) =>
    apply(
      id,
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'SUCCEED', output: { fileName, ...OUTPUT } },
    );

  const toReview = (id: string) =>
    apply(
      id,
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'PROGRESS', step: 7, sub: null },
      { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
    );

  const run = (overrides: Partial<ReconcileOptions> = {}): Promise<ReconcileSummary> =>
    reconcile({
      inboxPath: inbox,
      exportsDir,
      settleMs,
      repo,
      bus,
      clock,
      durations,
      logger,
      ...overrides,
    });

  return {
    inbox,
    exportsDir,
    clock,
    db,
    repo,
    bus,
    events,
    logger,
    put,
    scanOf,
    track,
    trackGhost,
    apply,
    toQueued,
    toEditing,
    toReady,
    toReview,
    run,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const jobOf = (repo: JobRepository, id: string): Job => repo.get(id) as Job;

describe('a new folder', () => {
  it('becomes an arriving job whose settle timer starts now', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    t.put('Acme', 'Spring', 'b.mov', 50);
    t.put('Acme', 'Spring', 'voice.wav', 20);
    t.put('Acme', 'Spring', 'brief.pdf', 5);
    t.clock.tick(5_000); // the engine was off; the folder has been there for a while

    const summary = await t.run();

    expect(summary).toEqual({
      created: 1,
      changed: 0,
      removed: 0,
      settled: 0,
      failedMissingExport: 0,
      failedMissingPreview: 0,
      failedFolderRemoved: 0,
      resuming: 0,
      unchanged: 0,
    });
    const [job] = t.repo.getAll();
    expect(job).toMatchObject({
      client: 'Acme',
      name: 'Spring',
      relPath: 'Acme/Spring',
      state: 'arriving',
      inputs: { video: 2, audio: 1, image: 0, doc: 1 },
      sizeBytes: 175,
      addedAt: iso(Date.parse(T0) + 5_000),
      lastChangeAt: iso(Date.parse(T0) + 5_000),
      settlesAt: iso(Date.parse(T0) + 5_000 + SETTLE_MS),
    });
    expect(t.events).toEqual([{ type: 'job.upsert', job }]);
  });

  it('does not queue it, however long the folder has existed', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    t.clock.tick(10 * SETTLE_MS);

    await t.run();

    expect(t.repo.getAll()[0]?.state).toBe('arriving');
  });

  it('keeps Hebrew client and job names as they are', async () => {
    const t = setup();
    t.put('מאפיית הצפון', 'סרטון גיוס – Hiring video', 'a.mp4');

    await t.run();

    expect(t.repo.getAll()[0]).toMatchObject({
      client: 'מאפיית הצפון',
      name: 'סרטון גיוס – Hiring video',
      state: 'arriving',
    });
  });

  it('does not take the exports folder, edit/ or loose files for jobs', async () => {
    const t = setup();
    writeFileSync(join(t.exportsDir, 'old.mp4'), 'x');
    mkdirSync(join(t.exportsDir, 'Acme'), { recursive: true });
    writeFileSync(join(t.inbox, 'notes.txt'), 'x');
    t.put('Acme', 'Spring', 'a.mp4');
    t.put('Acme', 'Spring', 'edit/final.mp4', 30);

    const summary = await t.run();

    expect(summary.created).toBe(1);
    expect(t.repo.getAll().map((job) => job.relPath)).toEqual(['Acme/Spring']);
    expect(t.repo.getAll()[0]?.inputs.video).toBe(1);
  });

  it('is an empty list for an empty inbox', async () => {
    const t = setup();

    const summary = await t.run();

    expect(summary).toEqual({
      created: 0,
      changed: 0,
      removed: 0,
      settled: 0,
      failedMissingExport: 0,
      failedMissingPreview: 0,
      failedFolderRemoved: 0,
      resuming: 0,
      unchanged: 0,
    });
    expect(t.events).toEqual([]);
  });
});

describe('a folder with instructions and no footage (the Generate switch)', () => {
  function dropPinewood(t: ReturnType<typeof setup>) {
    t.put('Pinewood', '97 Window Ad', 'PINEWOOD brief.txt', 'Make a 35 second ad.');
    t.put('Pinewood', '97 Window Ad', 'pinewood-references.zip', 300);
    t.put('Pinewood', '97 Window Ad', 'reference/reference-video-35s.mp4', 4_000);
  }

  it('becomes an arriving job with no footage in it when the switch is on', async () => {
    const t = setup();
    dropPinewood(t);

    const summary = await t.run({ generate: true });

    expect(summary.created).toBe(1);
    const [job] = t.repo.getAll();
    expect(job).toMatchObject({
      relPath: 'Pinewood/97 Window Ad',
      state: 'arriving',
      inputs: { video: 0, audio: 0, image: 0, doc: 1 },
    });
  });

  it('is the same job, counting the reference video, when the switch is off', async () => {
    const t = setup();
    dropPinewood(t);

    const summary = await t.run();

    expect(summary.created).toBe(1);
    expect(t.repo.getAll()[0]).toMatchObject({
      state: 'arriving',
      inputs: { video: 1, audio: 0, image: 0, doc: 1 },
    });
  });
});

describe('a folder that is gone', () => {
  it.each([
    ['arriving', (t: ReturnType<typeof setup>, id: string) => t.repo.get(id)],
    ['queued', (t: ReturnType<typeof setup>, id: string) => t.toQueued(id)],
    ['held', (t: ReturnType<typeof setup>, id: string) => t.apply(id, { type: 'HOLD' })],
    [
      'failed',
      (t: ReturnType<typeof setup>, id: string) =>
        t.apply(
          id,
          { type: 'SETTLED' },
          { type: 'START' },
          { type: 'FAIL', step: 4, error: 'boom' },
        ),
    ],
    [
      'cancelled',
      (t: ReturnType<typeof setup>, id: string) =>
        t.apply(id, { type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }),
    ],
    ['ready', (t: ReturnType<typeof setup>, id: string) => t.toReady(id, 'Acme/Gone.mp4')],
  ] as const)('removes a %s job', async (state, bring) => {
    const t = setup();
    const job = t.trackGhost('Acme', 'Gone');
    bring(t, job.id);
    expect(jobOf(t.repo, job.id).state).toBe(state);

    const summary = await t.run();

    expect(t.repo.get(job.id)).toBeNull();
    expect(summary.removed).toBe(1);
    expect(t.events).toEqual([{ type: 'job.remove', id: job.id }]);
  });

  it('removes only the missing ones', async () => {
    const t = setup();
    t.put('Acme', 'Kept', 'a.mp4');
    const kept = await t.track('Acme', 'Kept');
    const gone = t.trackGhost('Acme', 'Gone');

    const summary = await t.run();

    expect(t.repo.getAll().map((job) => job.id)).toEqual([kept.id]);
    expect(summary).toMatchObject({ removed: 1, unchanged: 1 });
    expect(t.events).toEqual([{ type: 'job.remove', id: gone.id }]);
  });

  it('removes a job whose whole client folder is gone', async () => {
    const t = setup();
    t.trackGhost('Acme', 'One');
    t.trackGhost('Acme', 'Two');

    const summary = await t.run();

    expect(t.repo.getAll()).toEqual([]);
    expect(summary.removed).toBe(2);
  });

  it('drops a failure that was only about the folder having been removed', async () => {
    const t = setup();
    const job = t.trackGhost('Acme', 'Gone');
    t.apply(
      job.id,
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'FAIL', step: 5, error: FOLDER_REMOVED_ERROR },
    );

    await t.run();

    expect(t.repo.get(job.id)).toBeNull();
  });

  it('fails an editing job instead (the watcher does the same) and tells the hook', async () => {
    const t = setup();
    const job = t.trackGhost('Acme', 'Gone');
    t.toEditing(job.id, 5);
    const told: Job[] = [];

    const summary = await t.run({ onFolderRemovedWhileEditing: (failed) => told.push(failed) });

    const after = jobOf(t.repo, job.id);
    expect(after).toMatchObject({
      state: 'failed',
      step: 5,
      failedAt: 5,
      error: FOLDER_REMOVED_ERROR,
    });
    expect(summary).toMatchObject({ failedFolderRemoved: 1, removed: 0, resuming: 0 });
    expect(t.events).toEqual([{ type: 'job.upsert', job: after }]);
    expect(told).toEqual([after]);
    // The worker's boot read of getEditing() no longer finds it.
    expect(t.repo.getEditing()).toEqual([]);
  });

  it('fails an editing job with no step on record at step 1, and survives a throwing hook', async () => {
    const t = setup();
    const job = t.trackGhost('Acme', 'Gone');
    t.apply(job.id, { type: 'SETTLED' }, { type: 'START' });
    t.db.sqlite.prepare('update jobs set step = null where id = ?').run(job.id);
    expect(jobOf(t.repo, job.id).step).toBeNull();

    await t.run({
      onFolderRemovedWhileEditing: () => {
        throw new Error('hook broke');
      },
    });

    expect(jobOf(t.repo, job.id)).toMatchObject({ state: 'failed', failedAt: 1 });
    expect(t.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }),
      'onFolderRemovedWhileEditing threw',
    );
  });
});

describe('files that changed while the engine was away', () => {
  it('sends a queued job back to arriving with a fresh settle timer', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    const job = await t.track('Acme', 'Spring');
    t.toQueued(job.id);
    t.clock.tick(30 * 60_000);
    t.put('Acme', 'Spring', 'b.mp4', 50);

    const summary = await t.run();

    const after = jobOf(t.repo, job.id);
    expect(after).toMatchObject({
      state: 'arriving',
      inputs: { video: 2, audio: 0, image: 0, doc: 0 },
      sizeBytes: 150,
      lastChangeAt: t.clock().toISOString(),
      settledAt: null,
      placeInLine: null,
    });
    expect(summary).toMatchObject({ changed: 1, settled: 0, unchanged: 0 });
    expect(t.events).toEqual([{ type: 'job.upsert', job: after }]);
  });

  it('notices a file that changed size without the counts changing', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    const job = await t.track('Acme', 'Spring');
    t.toQueued(job.id);
    t.clock.tick(60_000);
    t.put('Acme', 'Spring', 'a.mp4', 400);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toMatchObject({ state: 'arriving', sizeBytes: 400 });
    expect(summary.changed).toBe(1);
  });

  it('notices a removed file', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    t.put('Acme', 'Spring', 'b.mp4', 100);
    const job = await t.track('Acme', 'Spring');
    t.toQueued(job.id);
    rmSync(join(t.inbox, 'Acme', 'Spring', 'b.mp4'));

    await t.run();

    expect(jobOf(t.repo, job.id)).toMatchObject({
      state: 'arriving',
      inputs: { video: 1, audio: 0, image: 0, doc: 0 },
    });
  });

  it('restarts the timer of an arriving job instead of settling it, however old it was', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    const job = await t.track('Acme', 'Spring');
    t.clock.tick(10 * SETTLE_MS);
    t.put('Acme', 'Spring', 'b.mp4', 50);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toMatchObject({
      state: 'arriving',
      lastChangeAt: t.clock().toISOString(),
    });
    expect(summary).toMatchObject({ changed: 1, settled: 0 });
  });

  it('keeps a held job held but remembers the change for Release', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    const job = await t.track('Acme', 'Spring');
    t.apply(job.id, { type: 'HOLD' });
    t.clock.tick(10 * SETTLE_MS);
    t.put('Acme', 'Spring', 'b.mp4', 50);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toMatchObject({
      state: 'held',
      lastChangeAt: t.clock().toISOString(),
      inputs: { video: 2, audio: 0, image: 0, doc: 0 },
    });
    expect(summary).toMatchObject({ changed: 1, unchanged: 0 });
  });

  it('leaves a queued job whose files did not change exactly where it is in line', async () => {
    const t = setup();
    t.put('Acme', 'One', 'a.mp4');
    t.put('Acme', 'Two', 'a.mp4');
    const one = await t.track('Acme', 'One');
    t.clock.tick(1_000);
    const two = await t.track('Acme', 'Two');
    t.toQueued(one.id);
    t.clock.tick(1_000);
    t.toQueued(two.id);
    const before = t.repo.getAll();
    t.clock.tick(60_000);

    const summary = await t.run();

    expect(t.repo.getAll()).toEqual(before);
    expect(summary).toMatchObject({ unchanged: 2, changed: 0 });
    expect(t.events).toEqual([]);
  });

  it.each(['failed', 'cancelled'] as const)('ignores new files in a %s job', async (state) => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    const job = await t.track('Acme', 'Spring');
    t.apply(
      job.id,
      { type: 'SETTLED' },
      { type: 'START' },
      state === 'failed' ? { type: 'FAIL', step: 3, error: 'boom' } : { type: 'CANCEL' },
    );
    const before = jobOf(t.repo, job.id);
    t.clock.tick(1_000);
    t.put('Acme', 'Spring', 'b.mp4', 50);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(before);
    expect(summary).toMatchObject({ unchanged: 1, changed: 0 });
  });
});

describe('arriving jobs that were quiet long enough', () => {
  it('queues an arriving job whose last change is older than the settle time', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.clock.tick(SETTLE_MS + 1);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toMatchObject({
      state: 'queued',
      settledAt: t.clock().toISOString(),
      placeInLine: 1,
    });
    expect(summary).toMatchObject({ settled: 1, unchanged: 0 });
    expect(t.events).toEqual([{ type: 'job.upsert', job: jobOf(t.repo, job.id) }]);
  });

  it('queues at exactly the settle time and not a millisecond before', async () => {
    const t = setup();
    t.put('Acme', 'Early', 'a.mp4');
    t.put('Acme', 'Exact', 'a.mp4');
    const early = await t.track('Acme', 'Early');
    t.clock.tick(1);
    const exact = await t.track('Acme', 'Exact');
    t.clock.tick(SETTLE_MS - 1);
    // Early is SETTLE_MS old now, Exact is SETTLE_MS - 1.

    await t.run();

    expect(jobOf(t.repo, early.id).state).toBe('queued');
    expect(jobOf(t.repo, exact.id).state).toBe('arriving');
  });

  it.each([
    ['queues after a short configured time', 5_000, 10_000, 'queued'],
    ['waits for a long configured time', 120_000, 90_000, 'arriving'],
  ] as const)(
    'uses the configured settle time, not the built-in 60 s: %s',
    async (_label, settleMs, age, state) => {
      const t = setup(settleMs);
      t.put('Acme', 'Spring', 'a.mp4');
      const job = await t.track('Acme', 'Spring');
      t.clock.tick(age);

      await t.run();

      expect(jobOf(t.repo, job.id).state).toBe(state);
    },
  );

  it('queues them in the order they arrived', async () => {
    const t = setup();
    t.put('Acme', 'First', 'a.mp4');
    t.put('Acme', 'Second', 'a.mp4');
    const first = await t.track('Acme', 'First');
    t.clock.tick(1_000);
    const second = await t.track('Acme', 'Second');
    t.clock.tick(2 * SETTLE_MS);

    const summary = await t.run();

    expect(summary.settled).toBe(2);
    expect(t.repo.nextQueued()?.id).toBe(first.id);
    expect(jobOf(t.repo, second.id).state).toBe('queued');
  });

  it('does not touch a held job, however old', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.apply(job.id, { type: 'HOLD' });
    t.clock.tick(10 * SETTLE_MS);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id).state).toBe('held');
    expect(summary.unchanged).toBe(1);
  });

  it('leaves a new folder to the watcher even when the settle time is 0', async () => {
    const t = setup(0);
    t.put('Acme', 'Spring', 'a.mp4');

    const summary = await t.run();

    // Counted once, as new; the watcher settles it on the next tick.
    expect(summary).toMatchObject({ created: 1, settled: 0 });
    expect(t.repo.getAll()[0]?.state).toBe('arriving');
  });
});

describe('jobs left in editing', () => {
  it('stay editing: the worker resumes them, reconciliation does not move them', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    const editing = t.toEditing(job.id, 5);
    const metaBefore = t.repo.getMeta(job.id);
    t.clock.tick(10 * SETTLE_MS);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(editing);
    expect(t.repo.getMeta(job.id)).toEqual(metaBefore);
    expect(t.repo.getEditing().map((j) => j.id)).toEqual([job.id]);
    expect(summary).toMatchObject({ resuming: 1, unchanged: 0, changed: 0 });
    expect(t.events).toEqual([]);
  });

  it('keep their inputs when files changed meanwhile (an edit in progress ignores them)', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    const job = await t.track('Acme', 'Spring');
    const editing = t.toEditing(job.id, 5);
    t.put('Acme', 'Spring', 'b.mp4', 50);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(editing);
    expect(summary).toMatchObject({ resuming: 1, changed: 0 });
    expect(t.events).toEqual([]);
  });

  it('stay editing in front of the queue: nothing queued gets ahead of them', async () => {
    const t = setup();
    t.put('Acme', 'Crashed', 'a.mp4');
    t.put('Acme', 'Waiting', 'a.mp4');
    const crashed = await t.track('Acme', 'Crashed');
    t.toEditing(crashed.id);
    t.clock.tick(1_000);
    const waiting = await t.track('Acme', 'Waiting');
    t.toQueued(waiting.id);

    await t.run();

    expect(t.repo.getEditing().map((job) => job.id)).toEqual([crashed.id]);
    expect(t.repo.nextQueued()?.id).toBe(waiting.id);
  });
});

describe('ready jobs whose export is gone', () => {
  it('fails at Render with "Exported file is missing"', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.toReady(job.id, 'Acme/Spring.mp4');
    t.clock.tick(1_000);

    const summary = await t.run();

    const after = jobOf(t.repo, job.id);
    expect(after).toMatchObject({
      state: 'failed',
      step: 8,
      failedAt: 8,
      error: 'Exported file is missing',
      output: null,
      updatedAt: t.clock().toISOString(),
    });
    expect(after.error).toBe(EXPORT_MISSING_ERROR);
    expect(summary).toMatchObject({ failedMissingExport: 1, unchanged: 0 });
    expect(t.events).toEqual([{ type: 'job.upsert', job: after }]);
  });

  it('can then be retried, which queues it for Render', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.toReady(job.id, 'Acme/Spring.mp4');
    await t.run();

    const retried = t.repo.applyTransition(job.id, { type: 'RETRY' });

    expect(retried).toMatchObject({ state: 'queued', step: 8, error: null, failedAt: null });
  });

  it('keeps a job whose export is there', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    const ready = t.toReady(job.id, 'Acme/Spring.mp4');
    mkdirSync(join(t.exportsDir, 'Acme'), { recursive: true });
    writeFileSync(join(t.exportsDir, 'Acme', 'Spring.mp4'), 'mp4');

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(ready);
    expect(summary).toMatchObject({ unchanged: 1, failedMissingExport: 0 });
    expect(t.events).toEqual([]);
  });

  it('finds an export with a Hebrew name', async () => {
    const t = setup();
    t.put('מאפיית הצפון', 'סרטון', 'a.mp4');
    const job = await t.track('מאפיית הצפון', 'סרטון');
    t.toReady(job.id, 'מאפיית הצפון/סרטון.mp4');
    mkdirSync(join(t.exportsDir, 'מאפיית הצפון'), { recursive: true });
    writeFileSync(join(t.exportsDir, 'מאפיית הצפון', 'סרטון.mp4'), 'mp4');

    await t.run();

    expect(jobOf(t.repo, job.id).state).toBe('ready');
  });

  it('counts an export folder (not a file) as missing', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.toReady(job.id, 'Acme/Spring.mp4');
    mkdirSync(join(t.exportsDir, 'Acme', 'Spring.mp4'), { recursive: true });

    await t.run();

    expect(jobOf(t.repo, job.id).state).toBe('failed');
  });

  it('counts a path through something that is not a folder as missing', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.toReady(job.id, 'Acme/Spring.mp4');
    writeFileSync(join(t.exportsDir, 'Acme'), 'a file where the client folder should be');

    await t.run();

    expect(jobOf(t.repo, job.id).state).toBe('failed');
  });

  it('removes a ready job whose folder is gone; its missing export does not matter then', async () => {
    const t = setup();
    const job = t.trackGhost('Acme', 'Gone');
    t.toReady(job.id, 'Acme/Gone.mp4');

    const summary = await t.run();

    expect(t.repo.get(job.id)).toBeNull();
    expect(summary).toMatchObject({ removed: 1, failedMissingExport: 0 });
  });

  it('keeps the job when the export cannot be checked (not the same as missing)', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    const ready = t.toReady(job.id, 'Acme/Spring.mp4');
    mkdirSync(join(t.exportsDir, 'Acme'), { recursive: true });
    writeFileSync(join(t.exportsDir, 'Acme', 'Spring.mp4'), 'mp4');
    chmodSync(join(t.exportsDir, 'Acme'), 0o000);
    cleanups.push(() => chmodSync(join(t.exportsDir, 'Acme'), 0o755));

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(ready);
    expect(summary).toMatchObject({ unchanged: 1, failedMissingExport: 0 });
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }),
      'could not check the export; kept',
    );
  });
});

describe('review jobs whose preview is gone', () => {
  it('fails at Preview with "Preview is missing"', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.toReview(job.id);
    t.clock.tick(1_000);

    const summary = await t.run();

    const after = jobOf(t.repo, job.id);
    expect(after).toMatchObject({
      state: 'failed',
      step: 6,
      failedAt: 6,
      error: 'Preview is missing',
      preview: null,
      runKind: 'edit',
      updatedAt: t.clock().toISOString(),
    });
    expect(after.error).toBe(PREVIEW_MISSING_ERROR);
    expect(summary).toMatchObject({ failedMissingPreview: 1, unchanged: 0 });
    expect(t.events).toEqual([{ type: 'job.upsert', job: after }]);
  });

  it('can then be retried, which queues it for Preview', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.toReview(job.id);
    await t.run();

    const retried = t.repo.applyTransition(job.id, { type: 'RETRY' });

    expect(retried).toMatchObject({
      state: 'queued',
      step: 6,
      error: null,
      failedAt: null,
      runKind: 'edit',
    });
  });

  it('keeps a job whose edit/preview/index.html is there', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    t.put('Acme', 'Spring', 'edit/preview/index.html', '<html>');
    const job = await t.track('Acme', 'Spring');
    const review = t.toReview(job.id);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(review);
    expect(summary).toMatchObject({ unchanged: 1, failedMissingPreview: 0 });
    expect(t.events).toEqual([]);
  });

  it('counts an index.html that is a folder as missing', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    mkdirSync(join(t.inbox, 'Acme', 'Spring', 'edit', 'preview', 'index.html'), {
      recursive: true,
    });
    const job = await t.track('Acme', 'Spring');
    t.toReview(job.id);

    await t.run();

    expect(jobOf(t.repo, job.id).state).toBe('failed');
  });

  it('removes a review job whose whole folder is gone instead of failing it', async () => {
    const t = setup();
    const job = t.trackGhost('Acme', 'Gone');
    t.toReview(job.id);

    const summary = await t.run();

    expect(t.repo.get(job.id)).toBeNull();
    expect(summary).toMatchObject({ removed: 1, failedMissingPreview: 0 });
  });

  it('keeps the job when the preview cannot be checked (not the same as missing)', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    t.put('Acme', 'Spring', 'edit/preview/index.html', '<html>');
    const job = await t.track('Acme', 'Spring');
    const review = t.toReview(job.id);
    const locked = join(t.inbox, 'Acme', 'Spring', 'edit', 'preview');
    chmodSync(locked, 0o000);
    cleanups.push(() => chmodSync(locked, 0o755));

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(review);
    expect(summary).toMatchObject({ unchanged: 1, failedMissingPreview: 0 });
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }),
      'could not check the preview; kept',
    );
  });

  it('works with Hebrew client and job names', async () => {
    const t = setup();
    t.put('מאפיית הצפון', 'סרטון', 'a.mp4');
    t.put('מאפיית הצפון', 'סרטון', 'edit/preview/index.html', '<html>');
    t.put('מאפיית הצפון', 'ללא תצוגה', 'a.mp4');
    const kept = await t.track('מאפיית הצפון', 'סרטון');
    const lost = await t.track('מאפיית הצפון', 'ללא תצוגה');
    t.toReview(kept.id);
    t.toReview(lost.id);

    const summary = await t.run();

    expect(jobOf(t.repo, kept.id).state).toBe('review');
    expect(jobOf(t.repo, lost.id)).toMatchObject({ state: 'failed', error: 'Preview is missing' });
    expect(summary).toMatchObject({ failedMissingPreview: 1, unchanged: 1 });
  });

  it('leaves a review job alone when files were added to its folder', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    t.put('Acme', 'Spring', 'edit/preview/index.html', '<html>');
    const job = await t.track('Acme', 'Spring');
    const review = t.toReview(job.id);
    t.put('Acme', 'Spring', 'b.mp4', 20);
    t.clock.tick(10 * SETTLE_MS);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(review);
    expect(summary).toMatchObject({ changed: 0, unchanged: 1 });
  });
});

describe('reading the disk', () => {
  it('rejects, touching nothing, when the inbox folder does not exist', async () => {
    const t = setup();
    const job = t.trackGhost('Acme', 'Spring');
    rmSync(t.inbox, { recursive: true, force: true });

    await expect(t.run()).rejects.toThrow('The inbox folder does not exist');

    expect(t.repo.get(job.id)).toEqual(job);
    expect(t.events).toEqual([]);
  });

  it('rejects when the inbox path is a file', async () => {
    const t = setup();
    rmSync(t.inbox, { recursive: true, force: true });
    writeFileSync(t.inbox, 'not a folder');

    await expect(t.run()).rejects.toThrow('The inbox folder does not exist');
  });

  it('keeps jobs in a client folder it could not read, and still reconciles the rest', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const t = setup();
    t.put('Locked', 'Spring', 'a.mp4');
    const locked = await t.track('Locked', 'Spring');
    t.toQueued(locked.id);
    t.put('Acme', 'Fresh', 'a.mp4');
    t.trackGhost('Acme', 'Gone');
    chmodSync(join(t.inbox, 'Locked'), 0o000);
    cleanups.push(() => chmodSync(join(t.inbox, 'Locked'), 0o755));

    const summary = await t.run();

    expect(jobOf(t.repo, locked.id).state).toBe('queued');
    expect(summary).toMatchObject({ created: 1, removed: 1, unchanged: 1 });
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: join(t.inbox, 'Locked') }),
      'skipped a folder that could not be read',
    );
  });

  it('keeps a job whose own folder it could not read instead of reading it as emptied', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4', 100);
    const job = await t.track('Acme', 'Spring');
    const queued = t.toQueued(job.id);
    chmodSync(join(t.inbox, 'Acme', 'Spring'), 0o000);
    cleanups.push(() => chmodSync(join(t.inbox, 'Acme', 'Spring'), 0o755));
    t.clock.tick(10 * SETTLE_MS);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toEqual(queued);
    expect(summary).toMatchObject({ unchanged: 1, changed: 0, removed: 0 });
  });
});

describe('a whole restart', () => {
  async function aBusyInbox() {
    const t = setup();
    // new: no job yet
    t.put('Acme', 'New', 'a.mp4');
    // gone: a job without a folder
    t.trackGhost('Acme', 'Gone');
    // changed: queued, then a file added
    t.put('Acme', 'Changed', 'a.mp4');
    t.toQueued((await t.track('Acme', 'Changed')).id);
    // settled: arriving long ago
    t.put('Acme', 'Quiet', 'a.mp4');
    await t.track('Acme', 'Quiet');
    // editing: crashed mid-edit
    t.put('Acme', 'Crashed', 'a.mp4');
    t.toEditing((await t.track('Acme', 'Crashed')).id);
    // ready, export there / gone
    t.put('Acme', 'Done', 'a.mp4');
    t.toReady((await t.track('Acme', 'Done')).id, 'Acme/Done.mp4');
    mkdirSync(join(t.exportsDir, 'Acme'), { recursive: true });
    writeFileSync(join(t.exportsDir, 'Acme', 'Done.mp4'), 'mp4');
    t.put('Acme', 'Lost', 'a.mp4');
    t.toReady((await t.track('Acme', 'Lost')).id, 'Acme/Lost.mp4');
    // review, preview there / gone
    t.put('Acme', 'Reviewing', 'a.mp4');
    t.toReview((await t.track('Acme', 'Reviewing')).id);
    t.put('Acme', 'Reviewing', 'edit/preview/index.html', '<html>');
    t.put('Acme', 'NoPreview', 'a.mp4');
    t.toReview((await t.track('Acme', 'NoPreview')).id);
    // untouched: held
    t.put('Acme', 'Paused', 'a.mp4');
    t.apply((await t.track('Acme', 'Paused')).id, { type: 'HOLD' });

    t.clock.tick(2 * SETTLE_MS);
    t.put('Acme', 'Changed', 'b.mp4', 20);
    return t;
  }

  it('applies every rule at once and counts each job once', async () => {
    const t = await aBusyInbox();

    const summary = await t.run();

    expect(summary).toEqual({
      created: 1,
      changed: 1,
      removed: 1,
      settled: 1,
      failedMissingExport: 1,
      failedMissingPreview: 1,
      failedFolderRemoved: 0,
      resuming: 1,
      unchanged: 3,
    });
    const states = Object.fromEntries(
      t.repo.getAll().map((job) => [job.relPath.replace('Acme/', ''), job.state]),
    );
    expect(states).toEqual({
      New: 'arriving',
      Changed: 'arriving',
      Quiet: 'queued',
      Crashed: 'editing',
      Done: 'ready',
      Lost: 'failed',
      Reviewing: 'review',
      NoPreview: 'failed',
      Paused: 'held',
    });
    const counted =
      summary.created +
      summary.changed +
      summary.settled +
      summary.failedMissingExport +
      summary.failedMissingPreview +
      summary.failedFolderRemoved +
      summary.resuming +
      summary.unchanged;
    expect(counted).toBe(t.repo.getAll().length);
  });

  it('publishes one event per change and nothing for jobs it left alone', async () => {
    const t = await aBusyInbox();

    await t.run();

    const touched = t.events.map((event) =>
      event.type === 'job.remove'
        ? `remove:${event.id}`
        : `upsert:${event.type === 'job.upsert' ? event.job.relPath : event.type}`,
    );
    expect(touched.sort()).toEqual(
      [
        'upsert:Acme/New',
        'upsert:Acme/Changed',
        'upsert:Acme/Quiet',
        'upsert:Acme/Lost',
        'upsert:Acme/NoPreview',
        'remove:Acme/Gone',
      ].sort(),
    );
  });

  it('is idempotent: a second run changes nothing', async () => {
    const t = await aBusyInbox();
    await t.run();
    const after = t.repo.getAll();
    t.events.length = 0;

    const second = await t.run();

    expect(t.repo.getAll()).toEqual(after);
    expect(t.events).toEqual([]);
    expect(second).toMatchObject({
      created: 0,
      changed: 0,
      removed: 0,
      settled: 0,
      failedMissingExport: 0,
      failedMissingPreview: 0,
      failedFolderRemoved: 0,
      resuming: 1,
      unchanged: 8,
    });
  });

  it('logs the summary', async () => {
    const t = await aBusyInbox();

    const summary = await t.run();

    expect(t.logger.info).toHaveBeenCalledWith(summary, 'inbox reconciled');
  });

  it('carries on with the other jobs when one of them cannot be reconciled', async () => {
    const t = setup();
    t.put('Acme', 'Good', 'a.mp4');
    t.put('Acme', 'Bad', 'a.mp4');
    const bad = await t.scanOf('Acme', 'Bad');
    const failing = {
      get: (id: string) => t.repo.get(id),
      getAll: () => t.repo.getAll(),
      applyTransition: t.repo.applyTransition.bind(t.repo),
      remove: (id: string) => t.repo.remove(id),
      upsertFromScan: (scan: Parameters<JobRepository['upsertFromScan']>[0]) => {
        if (scan.id === bad.id) throw new Error('disk full');
        return t.repo.upsertFromScan(scan);
      },
    };

    const summary = await t.run({ repo: failing });

    expect(t.repo.getAll().map((job) => job.name)).toEqual(['Good']);
    expect(summary.created).toBe(1);
    expect(t.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: bad.id }),
      'could not reconcile the job',
    );
  });
});

describe('edge cases', () => {
  it('works with the system clock and without a logger', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const repo = new JobRepository(memoryDb());

    const summary = await reconcile({
      inboxPath: t.inbox,
      exportsDir: t.exportsDir,
      settleMs: SETTLE_MS,
      repo,
      bus: t.bus,
      durations: new DurationCache(async () => null),
    });

    expect(summary.created).toBe(1);
    expect(repo.getAll()[0]?.state).toBe('arriving');
  });

  it('treats a ready job with no output on record as having a missing export', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    t.toReady(job.id, 'Acme/Spring.mp4');
    t.db.sqlite.prepare('update jobs set output = null where id = ?').run(job.id);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id)).toMatchObject({ state: 'failed', failedAt: 8 });
    expect(summary.failedMissingExport).toBe(1);
  });

  it('does not count or announce a removal that another writer already made', async () => {
    const t = setup();
    t.trackGhost('Acme', 'Gone');
    const repo = {
      get: (id: string) => t.repo.get(id),
      getAll: () => t.repo.getAll(),
      applyTransition: t.repo.applyTransition.bind(t.repo),
      upsertFromScan: t.repo.upsertFromScan.bind(t.repo),
      remove: () => false,
    };

    const summary = await t.run({ repo });

    expect(summary.removed).toBe(0);
    expect(t.events).toEqual([]);
  });

  it('does not queue an old arriving job whose folder could not be read', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.track('Acme', 'Spring');
    chmodSync(join(t.inbox, 'Acme', 'Spring'), 0o000);
    cleanups.push(() => chmodSync(join(t.inbox, 'Acme', 'Spring'), 0o755));
    t.clock.tick(10 * SETTLE_MS);

    const summary = await t.run();

    expect(jobOf(t.repo, job.id).state).toBe('arriving');
    expect(summary).toMatchObject({ settled: 0, unchanged: 1 });
  });
});

describe('reconcile: the series name rule', () => {
  it('runs on the jobs it finds and the ones it settles, and publishes what it answers', async () => {
    const h = setup();
    // Weekly 5 was arriving when the engine stopped, and has been quiet long enough since.
    h.put('Acme', 'Weekly 5', 'a.mp4');
    const waited = await h.track('Acme', 'Weekly 5');
    h.clock.tick(SETTLE_MS);
    // Weekly 6 appeared while the engine was away.
    h.put('Acme', 'Weekly 6', 'a.mp4');
    const asked: string[] = [];

    await h.run({
      assignSeries: (job) => {
        asked.push(`${job.name}: ${job.state}`);
        return h.repo.setSeries(job.id, { seriesId: 's1', episode: 1, pinned: false });
      },
    });

    expect(asked.sort()).toEqual(['Weekly 5: queued', 'Weekly 6: arriving']);
    const upserts = h.events.flatMap((event) => (event.type === 'job.upsert' ? [event.job] : []));
    expect(upserts.find((job) => job.id === waited.id)).toMatchObject({
      state: 'queued',
      seriesId: 's1',
    });
    expect(upserts.find((job) => job.name === 'Weekly 6')).toMatchObject({
      state: 'arriving',
      seriesId: 's1',
    });
  });
});

// Formats (GN7): a job with two formats needs a composition and an export for each.
describe('jobs with more than one format', () => {
  const TWO = ['1080x1920', '1080x1080'];

  it('keeps a review job whose compositions are all there, and fails one whose second is gone', async () => {
    const whole = setup();
    whole.put('Acme', 'Spring', 'a.mp4');
    whole.put('Acme', 'Spring', 'edit/preview/index.html', '<html>');
    whole.put('Acme', 'Spring', 'edit/preview-1x1/index.html', '<html>');
    const job = await whole.track('Acme', 'Spring');
    whole.repo.setFormats(job.id, TWO);
    const review = whole.toReview(job.id);
    const summary = await whole.run();
    expect(jobOf(whole.repo, job.id)).toEqual(review);
    expect(review.formats).toHaveLength(2);
    expect(whole.events).toEqual([]);
    expect(summary).toMatchObject({ unchanged: 1, failedMissingPreview: 0 });

    const gone = setup();
    gone.put('Acme', 'Spring', 'a.mp4');
    gone.put('Acme', 'Spring', 'edit/preview/index.html', '<html>');
    const second = await gone.track('Acme', 'Spring');
    gone.repo.setFormats(second.id, TWO);
    gone.toReview(second.id);
    const missing = await gone.run();
    expect(jobOf(gone.repo, second.id)).toMatchObject({
      state: 'failed',
      error: PREVIEW_MISSING_ERROR,
    });
    expect(missing).toMatchObject({ failedMissingPreview: 1 });
  });

  it('does not ask a job with one format for another composition', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    t.put('Acme', 'Spring', 'edit/preview/index.html', '<html>');
    const job = await t.track('Acme', 'Spring');
    t.repo.setFormats(job.id, ['1080x1920']);
    t.toReview(job.id);
    expect(await t.run()).toMatchObject({ unchanged: 1, failedMissingPreview: 0 });
  });

  it('fails a ready job when the export of its second format is gone', async () => {
    const outputs = [
      { format: '9x16', fileName: 'Acme/Spring.mp4', bytes: 3 },
      { format: '1x1', fileName: 'Acme/Spring (1x1).mp4', bytes: 3 },
    ];
    const ready = async (second: boolean) => {
      const t = setup();
      t.put('Acme', 'Spring', 'a.mp4');
      const job = await t.track('Acme', 'Spring');
      t.repo.setFormats(job.id, TWO);
      t.apply(
        job.id,
        { type: 'SETTLED' },
        { type: 'START' },
        {
          type: 'SUCCEED',
          output: { fileName: 'Acme/Spring.mp4', ...OUTPUT, outputs },
        },
      );
      mkdirSync(join(t.exportsDir, 'Acme'), { recursive: true });
      writeFileSync(join(t.exportsDir, 'Acme', 'Spring.mp4'), 'mp4');
      if (second) writeFileSync(join(t.exportsDir, 'Acme', 'Spring (1x1).mp4'), 'mp4');
      const summary = await t.run();
      return { job: jobOf(t.repo, job.id), summary };
    };

    const whole = await ready(true);
    expect(whole.job.state).toBe('ready');
    expect(whole.summary).toMatchObject({ unchanged: 1, failedMissingExport: 0 });

    const lacking = await ready(false);
    expect(lacking.job).toMatchObject({ state: 'failed', error: EXPORT_MISSING_ERROR });
    expect(lacking.summary).toMatchObject({ failedMissingExport: 1 });
  });
});
