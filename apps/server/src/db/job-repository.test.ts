import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eventForAction,
  type InputCounts,
  InvalidTransition,
  type Job,
  type JobEvent,
  type JobOutput,
  jobSchema,
  NOTE_MAX_LENGTH,
  SETTLE_MS,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type StudioDb } from './database.js';
import { DeliveryRepository } from './delivery-repository.js';
import {
  JobNotFoundError,
  JobRepository,
  type JobRepositoryOptions,
  NoteNotEditableError,
  NoteTooLongError,
  ReviewTimeRefusedError,
} from './job-repository.js';
import { NoteRepository } from './note-repository.js';
import {
  fakeClock,
  idFor,
  makeScan,
  memoryDb,
  rawRow,
  SAMPLE_PREVIEW,
  T0,
  totalChanges,
} from './test-utils.js';

const OUTPUT: JobOutput = {
  fileName: 'Northwind Bakery/Spring menu.mp4',
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 65_011_712,
};

const MORE_FILES: InputCounts = { video: 15, audio: 1, image: 0, doc: 1 };

const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: JobRepositoryOptions = {}) {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const repo = new JobRepository(db, { clock, ...options });
  return { clock, db, repo };
}

type Repo = JobRepository;

/** Scans a new job and lets it settle into the queue. Returns its id. */
function enqueue(repo: Repo, clock: ReturnType<typeof fakeClock>, client: string, name: string) {
  const { job } = repo.upsertFromScan(makeScan(client, name));
  clock.tick(SETTLE_MS);
  repo.applyTransition(job.id, { type: 'SETTLED' });
  return job.id;
}

function startEditing(repo: Repo, id: string) {
  repo.applyTransition(id, { type: 'START' });
}

describe('upsertFromScan: a new job', () => {
  it('is created held, with no settle timer, when jobs start by hand (startHeld)', () => {
    const { repo } = setup({ startHeld: true });

    const { job } = repo.upsertFromScan(makeScan());

    expect(job).toMatchObject({ state: 'held', settlesAt: null, placeInLine: null });
  });

  it('creates an arriving job whose settle timer runs from now', () => {
    const { repo } = setup();
    const scan = makeScan();

    const { job, outcome } = repo.upsertFromScan(scan);

    expect(outcome).toBe('created');
    expect(job).toEqual({
      id: scan.id,
      clientId: '1c9823704bf5',
      client: 'Northwind Bakery',
      name: 'Spring menu',
      relPath: 'Northwind Bakery/Spring menu',
      state: 'arriving',
      step: null,
      subProgress: null,
      etaSec: null,
      placeInLine: null,
      settlesAt: '2026-10-20T10:01:00.000Z',
      failedAt: null,
      error: null,
      stoppedAt: null,
      inputs: scan.inputs,
      sizeBytes: scan.sizeBytes,
      addedAt: T0,
      lastChangeAt: T0,
      settledAt: null,
      heldSettledAt: null,
      updatedAt: T0,
      output: null,
      note: null,
      runKind: 'edit',
      round: 0,
      preview: null,
      approvedAt: null,
      delivery: null,
      effort: null,
      reviewEffort: null,
      reviseTier: null,
      fixing: null,
      fixedCount: 0,
      reviseMinutes: null,
      seriesId: null,
      episode: null,
      archivedAt: null,
    });
    expect(jobSchema.parse(job)).toEqual(job);
  });

  it('stores the footage length for the ETA but keeps it off the Job', () => {
    const { repo } = setup();
    const { job } = repo.upsertFromScan(makeScan('A', 'B', { footageSec: 123.5 }));

    expect(job).not.toHaveProperty('footageSec');
    expect(job).not.toHaveProperty('footageSeconds');
    expect(repo.getMeta(job.id)).toEqual({
      footageSec: 123.5,
      startedAt: null,
      finishedAt: null,
      attempt: 1,
      reviewSec: 0,
      seriesPinned: false,
    });
  });

  it('accepts a whole scanner result, extra fields and all', () => {
    const { repo } = setup();
    const scanned = {
      ...makeScan(),
      absPath: '/Users/me/Studio Inbox/Northwind Bakery/Spring menu',
    };
    expect(repo.upsertFromScan(scanned).outcome).toBe('created');
  });

  it('rejects a malformed scan without writing', () => {
    const { repo, db } = setup();
    expect(() => repo.upsertFromScan(makeScan('A', 'B', { sizeBytes: -1 }))).toThrow();
    expect(() => repo.upsertFromScan(makeScan('A', 'B', { footageSec: Number.NaN }))).toThrow();
    expect(() => repo.upsertFromScan(makeScan('A', 'B', { client: '' }))).toThrow();
    expect(rawRow(db, 'jobs')).toEqual([]);
  });

  it('keeps Hebrew and mixed-direction names exactly', () => {
    const { repo } = setup();
    const scan = makeScan('מאפיית הצפון', 'סרטון גיוס – Hiring video');
    const { job } = repo.upsertFromScan(scan);
    expect(job.client).toBe('מאפיית הצפון');
    expect(repo.get(scan.id)).toEqual(job);
    expect(repo.getByRelPath('מאפיית הצפון/סרטון גיוס – Hiring video')).toEqual(job);
  });
});

describe('create, transition, reload', () => {
  it('gives an identical Job after reload at every step of a whole lifecycle', () => {
    const { repo, clock } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    const { id } = job;

    const events: JobEvent[] = [
      { type: 'HOLD' },
      { type: 'RELEASE' },
      { type: 'FILES_CHANGED' },
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'PROGRESS', step: 4, sub: null },
      { type: 'PROGRESS', step: 5, sub: 'graphics 2/5' },
      { type: 'FAIL', step: 5, error: 'ffmpeg exited with code 1' },
      { type: 'RETRY' },
      { type: 'START' },
      { type: 'CANCEL' },
      { type: 'RESUME' },
      { type: 'START' },
      { type: 'SUCCEED', output: OUTPUT },
    ];

    for (const event of events) {
      clock.tick();
      const returned = repo.applyTransition(id, event);
      expect(returned, event.type).toEqual(repo.get(id));
      expect(
        repo.getAll().find((j) => j.id === id),
        event.type,
      ).toEqual(returned);
      expect(repo.getByRelPath('Northwind Bakery/Spring menu'), event.type).toEqual(returned);
      expect(jobSchema.parse(returned), event.type).toEqual(returned);
    }

    expect(repo.get(id)).toMatchObject({ state: 'ready', step: 8, output: OUTPUT, error: null });
  });

  it('persists exactly what the state machine returned', () => {
    const { repo, clock } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    clock.tick(SETTLE_MS);

    const settled = repo.applyTransition(job.id, { type: 'SETTLED' });

    expect(settled).toMatchObject({
      state: 'queued',
      settledAt: '2026-10-20T10:01:00.000Z',
      updatedAt: '2026-10-20T10:01:00.000Z',
      settlesAt: null,
      placeInLine: 1,
    });
  });

  it('survives a restart: close the file, open it again, same jobs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-repo-'));
    dirs.push(dir);
    const path = join(dir, 'engine.db');
    const clock = fakeClock();

    const first = openDatabase(path);
    opened.push(first);
    const a = new JobRepository(first, { clock });
    const id = enqueue(a, clock, 'Northwind Bakery', 'Spring menu');
    enqueue(a, clock, 'Acme', 'Promo');
    startEditing(a, id);
    clock.tick();
    a.applyTransition(id, { type: 'PROGRESS', step: 5, sub: 'graphics 2/5' });
    const before = a.getAll();
    first.close();

    const second = openDatabase(path);
    opened.push(second);
    const b = new JobRepository(second, { clock });

    expect(b.getAll()).toEqual(before);
    expect(b.getEditing().map((j) => j.id)).toEqual([id]);
  });

  it('throws JobNotFoundError for an unknown id', () => {
    const { repo } = setup();
    expect(() => repo.applyTransition('nope', { type: 'HOLD' })).toThrow(JobNotFoundError);
    expect(repo.get('nope')).toBeNull();
    expect(repo.getMeta('nope')).toBeNull();
    expect(repo.getByRelPath('No/Such')).toBeNull();
  });
});

describe('an invalid transition', () => {
  it('throws InvalidTransition and leaves the row unchanged', () => {
    const { repo, db, clock } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    clock.tick(5_000);
    const rowBefore = rawRow(db, 'jobs');
    const changesBefore = totalChanges(db);

    for (const event of [
      { type: 'START' },
      { type: 'RETRY' },
      { type: 'RESUME' },
      { type: 'CANCEL' },
      { type: 'PROGRESS', step: 3, sub: null },
      { type: 'SUCCEED', output: OUTPUT },
      { type: 'FAIL', step: 3, error: 'x' },
      { type: 'RELEASE' },
    ] satisfies JobEvent[]) {
      expect(() => repo.applyTransition(job.id, event), event.type).toThrow(InvalidTransition);
    }

    expect(rawRow(db, 'jobs')).toEqual(rowBefore);
    expect(totalChanges(db)).toBe(changesBefore);
    expect(repo.get(job.id)).toEqual(job);
  });

  it('carries the details the API needs for its 409', () => {
    const { repo } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    try {
      repo.applyTransition(job.id, { type: 'RETRY' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransition);
      expect(err).toMatchObject({ jobId: job.id, state: 'arriving', event: 'RETRY' });
    }
  });

  it('writes nothing for an event the machine ignores', () => {
    const { repo, db, clock } = setup();
    const id = enqueue(repo, clock, 'A', 'B');
    startEditing(repo, id);
    repo.applyTransition(id, { type: 'PROGRESS', step: 3, sub: '1/3' });
    clock.tick();
    const rowBefore = rawRow(db, 'jobs');

    // FILES_CHANGED while editing is ignored; so is PROGRESS repeating the current step and count.
    repo.applyTransition(id, { type: 'FILES_CHANGED' });
    repo.applyTransition(id, { type: 'PROGRESS', step: 3, sub: '1/3' });

    expect(rawRow(db, 'jobs')).toEqual(rowBefore);
  });
});

describe('updatedAt', () => {
  it('moves on a PROGRESS change', () => {
    const { repo, clock } = setup();
    const id = enqueue(repo, clock, 'A', 'B');
    startEditing(repo, id);
    const first = repo.applyTransition(id, { type: 'PROGRESS', step: 2, sub: '1/14' });

    clock.tick(30_000);
    const second = repo.applyTransition(id, { type: 'PROGRESS', step: 2, sub: '2/14' });
    expect(second.updatedAt).toBe('2026-10-20T10:01:30.000Z');
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));

    clock.tick(30_000);
    const third = repo.applyTransition(id, { type: 'PROGRESS', step: 3, sub: null });
    expect(Date.parse(third.updatedAt)).toBeGreaterThan(Date.parse(second.updatedAt));
    expect(repo.get(id)?.updatedAt).toBe(third.updatedAt);
  });

  it('does not move when the same PROGRESS repeats', () => {
    const { repo, clock } = setup();
    const id = enqueue(repo, clock, 'A', 'B');
    startEditing(repo, id);
    const first = repo.applyTransition(id, { type: 'PROGRESS', step: 2, sub: '1/14' });

    clock.tick(30_000);
    const again = repo.applyTransition(id, { type: 'PROGRESS', step: 2, sub: '1/14' });

    expect(again.updatedAt).toBe(first.updatedAt);
  });

  it('does not move when only the ETA changes', () => {
    let eta: number | null = 600;
    const { repo, clock } = setup({ estimateEtaSec: () => eta });
    const id = enqueue(repo, clock, 'A', 'B');
    startEditing(repo, id);
    clock.tick(10_000);
    const first = repo.applyTransition(id, { type: 'PROGRESS', step: 2, sub: '1/14' });
    expect(first.etaSec).toBe(600);

    for (const next of [540, 120.5, 0, null]) {
      eta = next;
      clock.tick(60_000);
      const read = repo.get(id);
      expect(read?.etaSec).toBe(next);
      expect(read?.updatedAt).toBe(first.updatedAt);
      expect(repo.getAll()[0]?.updatedAt).toBe(first.updatedAt);
    }
  });

  it('does not move when only the place in line changes', () => {
    const { repo, clock } = setup();
    const first = enqueue(repo, clock, 'A', 'First');
    const second = enqueue(repo, clock, 'A', 'Second');
    const before = repo.get(second);
    expect(before?.placeInLine).toBe(2);

    clock.tick(60_000);
    repo.remove(first);

    const after = repo.get(second);
    expect(after?.placeInLine).toBe(1);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it('is never changed by reading', () => {
    const { repo, db, clock } = setup({ estimateEtaSec: () => 99 });
    const a = enqueue(repo, clock, 'A', 'One');
    enqueue(repo, clock, 'A', 'Two');
    startEditing(repo, a);
    clock.tick(120_000);
    const rowsBefore = rawRow(db, 'jobs');
    const changesBefore = totalChanges(db);

    repo.getAll();
    repo.get(a);
    repo.getByRelPath('A/One');
    repo.getEditing();
    repo.nextQueued();
    repo.getMeta(a);

    expect(rawRow(db, 'jobs')).toEqual(rowsBefore);
    expect(totalChanges(db)).toBe(changesBefore);
  });
});

describe('derived fields', () => {
  it('never stores placeInLine, settlesAt or etaSec', () => {
    const { repo, db, clock } = setup({ estimateEtaSec: () => 77 });
    const a = enqueue(repo, clock, 'A', 'One');
    repo.upsertFromScan(makeScan('A', 'Two'));
    expect(repo.get(a)).toMatchObject({ placeInLine: 1, etaSec: 77 });

    const columns = Object.keys(rawRow(db, 'jobs')[0] as object);
    expect(columns.filter((c) => /place|settles|eta/.test(c))).toEqual([]);
  });

  it('gives etaSec null until an estimator is plugged in', () => {
    const { repo, clock } = setup();
    const id = enqueue(repo, clock, 'A', 'B');
    startEditing(repo, id);
    expect(repo.get(id)?.etaSec).toBeNull();
  });

  it('asks the estimator only for queued and editing jobs, with the stored footage', () => {
    const asked: Array<[Job['id'], Job['state'], number]> = [];
    const { repo, clock } = setup({
      estimateEtaSec: (job, footageSec) => {
        asked.push([job.id, job.state, footageSec]);
        return 10;
      },
    });
    const queued = enqueue(repo, clock, 'A', 'Queued');
    const editing = enqueue(repo, clock, 'A', 'Editing');
    startEditing(repo, editing);
    const { job: arriving } = repo.upsertFromScan(makeScan('A', 'Arriving'));
    const { job: held } = repo.upsertFromScan(makeScan('A', 'Held'));
    repo.applyTransition(held.id, { type: 'HOLD' });
    asked.length = 0;

    const all = repo.getAll();

    expect(new Set(asked.map(([id]) => id))).toEqual(new Set([queued, editing]));
    expect(asked.every(([, , footage]) => footage === 540.5)).toBe(true);
    expect(all.find((j) => j.id === arriving.id)?.etaSec).toBeNull();
    expect(all.find((j) => j.id === held.id)?.etaSec).toBeNull();
    expect(all.find((j) => j.id === queued)?.etaSec).toBe(10);
  });

  it('computes settlesAt for arriving jobs from lastChangeAt', () => {
    const { repo, clock } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    expect(job.settlesAt).toBe('2026-10-20T10:01:00.000Z');

    clock.tick(20_000);
    const again = repo.applyTransition(job.id, { type: 'FILES_CHANGED' });
    expect(again.lastChangeAt).toBe('2026-10-20T10:00:20.000Z');
    expect(again.settlesAt).toBe('2026-10-20T10:01:20.000Z');
    expect(repo.get(job.id)?.settlesAt).toBe('2026-10-20T10:01:20.000Z');

    clock.tick(SETTLE_MS);
    expect(repo.applyTransition(job.id, { type: 'SETTLED' }).settlesAt).toBeNull();
  });
});

// CVP-140: a job held by the note dialog goes back where it stood; a manual Hold does not.
describe('keeping the place in line (RELEASE with restorePlace)', () => {
  const RESTORE: JobEvent = { type: 'RELEASE', restorePlace: true };

  /** Three queued jobs, `One` first, with the clock a few seconds on. */
  function threeQueued() {
    const ctx = setup();
    const one = enqueue(ctx.repo, ctx.clock, 'A', 'One');
    const two = enqueue(ctx.repo, ctx.clock, 'A', 'Two');
    const three = enqueue(ctx.repo, ctx.clock, 'A', 'Three');
    return { ...ctx, one, two, three };
  }

  const places = (repo: Repo) =>
    Object.fromEntries(
      repo
        .getAll()
        .filter((job) => job.state === 'queued')
        .map((job) => [job.name, job.placeInLine]),
    );

  it('remembers when a queued job joined the queue while it is held, and forgets it on release', () => {
    const { repo, clock, one } = threeQueued();
    const joined = repo.get(one)?.settledAt;
    clock.tick();

    const held = repo.applyTransition(one, { type: 'HOLD' });
    expect(held).toMatchObject({ state: 'held', settledAt: null, heldSettledAt: joined });
    // Stored, not just returned.
    expect(repo.get(one)).toMatchObject({ heldSettledAt: joined });
    expect(places(repo)).toEqual({ Two: 1, Three: 2 });

    const released = repo.applyTransition(one, RESTORE);
    expect(released).toMatchObject({ state: 'queued', settledAt: joined, heldSettledAt: null });
    expect(repo.get(one)).toMatchObject({ settledAt: joined, heldSettledAt: null });
  });

  it('puts the job back at its place even when others joined the queue while it was held', () => {
    const { repo, clock, one, two } = threeQueued();
    clock.tick(10_000);
    repo.applyTransition(one, { type: 'HOLD' });
    clock.tick(10_000);
    const four = enqueue(repo, clock, 'A', 'Four');
    expect(places(repo)).toEqual({ Two: 1, Three: 2, Four: 3 });

    const released = repo.applyTransition(one, RESTORE);

    expect(released.placeInLine).toBe(1);
    expect(places(repo)).toEqual({ One: 1, Two: 2, Three: 3, Four: 4 });
    expect(repo.nextQueued()?.id).toBe(one);
    expect(repo.get(two)?.placeInLine).toBe(2);
    expect(repo.get(four)?.placeInLine).toBe(4);
  });

  it('returns a job started with Start now to the queue, not to arriving, though its folder just changed', () => {
    const { repo, clock } = setup();
    const { job: first } = repo.upsertFromScan(makeScan('A', 'First'));
    clock.tick(SETTLE_MS);
    repo.applyTransition(first.id, { type: 'SETTLED' });
    const { job } = repo.upsertFromScan(makeScan('A', 'Started now'));
    clock.tick(2_000);
    repo.applyTransition(job.id, { type: 'SETTLED' }); // Start now, 2 s after the folder arrived
    clock.tick(5_000);
    repo.applyTransition(job.id, { type: 'HOLD' });
    clock.tick(5_000);
    const joined = repo.get(job.id)?.heldSettledAt;

    // A plain release would see files that changed 12 s ago and send the job back to arriving.
    const released = repo.applyTransition(job.id, RESTORE);

    expect(released).toMatchObject({ state: 'queued', settledAt: joined, placeInLine: 2 });
  });

  it('restores a place in the middle of the line, too', () => {
    const { repo, clock, two } = threeQueued();
    clock.tick();
    repo.applyTransition(two, { type: 'HOLD' });
    clock.tick(5_000);

    repo.applyTransition(two, RESTORE);

    expect(places(repo)).toEqual({ One: 1, Two: 2, Three: 3 });
  });

  it('sends a plainly released job to the back of the line, as before', () => {
    const { repo, clock, one } = threeQueued();
    clock.tick();
    repo.applyTransition(one, { type: 'HOLD' });
    clock.tick(5_000);

    const released = repo.applyTransition(one, { type: 'RELEASE' });

    expect(released).toMatchObject({ state: 'queued', heldSettledAt: null });
    expect(released.settledAt).toBe(clock().toISOString());
    expect(places(repo)).toEqual({ Two: 1, Three: 2, One: 3 });
  });

  it('keeps an arriving job arriving, with its settle timer, whichever release is used', () => {
    for (const release of [{ type: 'RELEASE' } as const, RESTORE]) {
      const { repo, clock } = setup();
      const { job } = repo.upsertFromScan(makeScan());
      clock.tick(10_000);
      const held = repo.applyTransition(job.id, { type: 'HOLD' });
      expect(held.heldSettledAt).toBeNull();
      clock.tick(10_000);

      const released = repo.applyTransition(job.id, release);

      expect(released).toMatchObject({
        state: 'arriving',
        lastChangeAt: T0,
        settlesAt: '2026-10-20T10:01:00.000Z',
        settledAt: null,
        heldSettledAt: null,
      });
    }
  });

  it('lets the existing rules win when the files changed while the job was held', () => {
    const { repo, clock, one } = threeQueued();
    clock.tick();
    repo.applyTransition(one, { type: 'HOLD' });
    clock.tick(5_000);
    repo.applyTransition(one, { type: 'FILES_CHANGED' });
    expect(repo.get(one)).toMatchObject({ state: 'held' });

    // Changed a moment ago: back to arriving, no place to keep.
    clock.tick(5_000);
    const soon = repo.applyTransition(one, RESTORE);
    expect(soon).toMatchObject({ state: 'arriving', settledAt: null, heldSettledAt: null });
  });

  it('queues a job whose files changed while held at the back once they are quiet', () => {
    const { repo, clock, one } = threeQueued();
    clock.tick();
    repo.applyTransition(one, { type: 'HOLD' });
    clock.tick(5_000);
    repo.applyTransition(one, { type: 'FILES_CHANGED' });
    clock.tick(SETTLE_MS);

    const released = repo.applyTransition(one, RESTORE);

    expect(released).toMatchObject({ state: 'queued', heldSettledAt: null });
    expect(places(repo)).toEqual({ Two: 1, Three: 2, One: 3 });
  });

  it('sends a job held before the place was remembered to the back, even with restorePlace', () => {
    const { repo, db, clock, one } = threeQueued();
    clock.tick();
    repo.applyTransition(one, { type: 'HOLD' });
    // A row as an older engine left it: held, with no remembered place.
    db.sqlite.prepare('update jobs set held_settled_at = null where id = ?').run(one);
    clock.tick(5_000);

    repo.applyTransition(one, RESTORE);

    expect(places(repo)).toEqual({ Two: 1, Three: 2, One: 3 });
  });

  it('refuses RELEASE in any state but held, restorePlace or not', () => {
    const { repo, one } = threeQueued();
    expect(() => repo.applyTransition(one, RESTORE)).toThrow(InvalidTransition);
    expect(repo.get(one)?.state).toBe('queued');
  });
});

// Config.settleMs, passed by the engine: the delay the inbox watcher settles with.
describe('a custom settle delay (settleMs)', () => {
  const FIVE_S = { settleMs: 5_000 };

  it('settles a new job after the custom delay', () => {
    const { repo } = setup(FIVE_S);
    const { job } = repo.upsertFromScan(makeScan());
    expect(job.settlesAt).toBe('2026-10-20T10:00:05.000Z');
    expect(repo.get(job.id)?.settlesAt).toBe('2026-10-20T10:00:05.000Z');
    expect(repo.getAll()[0]?.settlesAt).toBe('2026-10-20T10:00:05.000Z');
    expect(repo.getByRelPath(job.relPath)?.settlesAt).toBe('2026-10-20T10:00:05.000Z');
  });

  it('restarts the timer for the custom delay when a scan finds changed files', () => {
    const { repo, clock } = setup(FIVE_S);
    const { job } = repo.upsertFromScan(makeScan());
    clock.tick(2_000);

    const { job: again } = repo.upsertFromScan(
      makeScan('Northwind Bakery', 'Spring menu', {
        inputs: MORE_FILES,
      }),
    );

    expect(again.lastChangeAt).toBe('2026-10-20T10:00:02.000Z');
    expect(again.settlesAt).toBe('2026-10-20T10:00:07.000Z');
    expect(repo.get(job.id)?.settlesAt).toBe('2026-10-20T10:00:07.000Z');
  });

  it('restarts the timer for the custom delay on FILES_CHANGED', () => {
    const { repo, clock } = setup(FIVE_S);
    const { job } = repo.upsertFromScan(makeScan());
    clock.tick(3_000);
    const again = repo.applyTransition(job.id, { type: 'FILES_CHANGED' });
    expect(again.settlesAt).toBe('2026-10-20T10:00:08.000Z');
    expect(repo.get(job.id)?.settlesAt).toBe('2026-10-20T10:00:08.000Z');
  });

  it('RELEASE keeps a job arriving until the custom delay has passed', () => {
    const { repo, clock } = setup(FIVE_S);
    const { job } = repo.upsertFromScan(makeScan());
    repo.applyTransition(job.id, { type: 'HOLD' });
    clock.tick(4_999);

    const released = repo.applyTransition(job.id, { type: 'RELEASE' });

    expect(released.state).toBe('arriving');
    expect(released.lastChangeAt).toBe(T0);
    expect(released.settlesAt).toBe('2026-10-20T10:00:05.000Z');
    expect(repo.get(job.id)?.state).toBe('arriving');
  });

  it('RELEASE queues a job once the custom delay has passed, well before 60 s', () => {
    const { repo, clock } = setup(FIVE_S);
    const { job } = repo.upsertFromScan(makeScan());
    repo.applyTransition(job.id, { type: 'HOLD' });
    clock.tick(5_000);

    const released = repo.applyTransition(job.id, { type: 'RELEASE' });

    expect(released).toMatchObject({ state: 'queued', settlesAt: null, placeInLine: 1 });
    expect(released.settledAt).toBe('2026-10-20T10:00:05.000Z');
  });

  it('RELEASE with a delay longer than 60 s holds back a job the default would queue', () => {
    const { repo, clock } = setup({ settleMs: 120_000 });
    const { job } = repo.upsertFromScan(makeScan());
    repo.applyTransition(job.id, { type: 'HOLD' });
    clock.tick(90_000);

    const released = repo.applyTransition(job.id, { type: 'RELEASE' });

    expect(released.state).toBe('arriving');
    expect(released.settlesAt).toBe('2026-10-20T10:02:00.000Z');
  });

  it('still uses 60 s when no delay is given', () => {
    const { repo, clock } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    repo.applyTransition(job.id, { type: 'HOLD' });
    clock.tick(30_000);
    expect(repo.applyTransition(job.id, { type: 'RELEASE' }).settlesAt).toBe(
      '2026-10-20T10:01:00.000Z',
    );
  });

  it('derives settlesAt at read time: nothing about the delay is stored', () => {
    const { repo, db, clock } = setup(FIVE_S);
    const { job } = repo.upsertFromScan(makeScan());
    const rowBefore = rawRow(db, 'jobs');

    const other = new JobRepository(db, { clock, settleMs: 10_000 });

    expect(other.get(job.id)?.settlesAt).toBe('2026-10-20T10:00:10.000Z');
    expect(repo.get(job.id)?.settlesAt).toBe('2026-10-20T10:00:05.000Z');
    expect(rawRow(db, 'jobs')).toEqual(rowBefore);
  });
});

describe('the queue', () => {
  it('runs the job that settled first, and numbers the places in that order', () => {
    const { repo, clock } = setup();
    // Settle order: second, third, first (the scan order is different on purpose).
    const { job: first } = repo.upsertFromScan(makeScan('A', 'First'));
    const { job: second } = repo.upsertFromScan(makeScan('A', 'Second'));
    const { job: third } = repo.upsertFromScan(makeScan('A', 'Third'));
    clock.tick(SETTLE_MS);
    repo.applyTransition(second.id, { type: 'SETTLED' });
    clock.tick(1_000);
    repo.applyTransition(third.id, { type: 'SETTLED' });
    clock.tick(1_000);
    repo.applyTransition(first.id, { type: 'SETTLED' });

    expect(repo.nextQueued()?.id).toBe(second.id);
    expect(repo.nextQueued()?.placeInLine).toBe(1);
    const places = Object.fromEntries(repo.getAll().map((j) => [j.name, j.placeInLine]));
    expect(places).toEqual({ Second: 1, Third: 2, First: 3 });
  });

  it('breaks an exact tie by the order the jobs were added', () => {
    const { repo, clock } = setup();
    const { job: a } = repo.upsertFromScan(makeScan('A', 'One'));
    clock.tick(1_000);
    const { job: b } = repo.upsertFromScan(makeScan('A', 'Two'));
    clock.tick(SETTLE_MS);
    // Same settledAt for both: the clock does not move between the two transitions.
    repo.applyTransition(b.id, { type: 'SETTLED' });
    repo.applyTransition(a.id, { type: 'SETTLED' });

    expect(repo.nextQueued()?.id).toBe(a.id);
    expect(repo.get(a.id)?.placeInLine).toBe(1);
    expect(repo.get(b.id)?.placeInLine).toBe(2);
  });

  it('skips held, arriving and editing jobs, and returns null for an empty queue', () => {
    const { repo, clock } = setup();
    expect(repo.nextQueued()).toBeNull();

    const held = enqueue(repo, clock, 'A', 'Held');
    repo.applyTransition(held, { type: 'HOLD' });
    repo.upsertFromScan(makeScan('A', 'Arriving'));
    const editing = enqueue(repo, clock, 'A', 'Editing');
    startEditing(repo, editing);
    expect(repo.nextQueued()).toBeNull();

    const waiting = enqueue(repo, clock, 'A', 'Waiting');
    expect(repo.nextQueued()?.id).toBe(waiting);
  });

  it('puts a retried job at the back and a released job where it now settles', () => {
    const { repo, clock } = setup();
    const a = enqueue(repo, clock, 'A', 'One');
    const b = enqueue(repo, clock, 'A', 'Two');
    startEditing(repo, a);
    clock.tick();
    repo.applyTransition(a, { type: 'FAIL', step: 3, error: 'boom' });
    clock.tick();
    repo.applyTransition(a, { type: 'RETRY' });

    expect(repo.nextQueued()?.id).toBe(b);
    expect(repo.get(a)?.placeInLine).toBe(2);
  });

  it('drops a queued job out of the numbering when its files change', () => {
    const { repo, clock } = setup();
    const a = enqueue(repo, clock, 'A', 'One');
    const b = enqueue(repo, clock, 'A', 'Two');
    clock.tick();
    const moved = repo.applyTransition(a, { type: 'FILES_CHANGED' });

    expect(moved).toMatchObject({ state: 'arriving', placeInLine: null });
    expect(repo.get(b)?.placeInLine).toBe(1);
  });
});

describe('upsertFromScan: a job that exists', () => {
  it('writes nothing when nothing changed', () => {
    const { repo, db, clock } = setup();
    const scan = makeScan();
    repo.upsertFromScan(scan);
    clock.tick(5_000);
    const rowBefore = rawRow(db, 'jobs');
    const changesBefore = totalChanges(db);

    const again = repo.upsertFromScan({ ...scan, newestMtimeMs: Date.now() });

    expect(again.outcome).toBe('unchanged');
    expect(again.job.updatedAt).toBe(T0);
    expect(rawRow(db, 'jobs')).toEqual(rowBefore);
    expect(totalChanges(db)).toBe(changesBefore);
  });

  it('restarts the settle timer when the files of an arriving job change', () => {
    const { repo, clock } = setup();
    const scan = makeScan();
    repo.upsertFromScan(scan);
    clock.tick(30_000);

    const { job, outcome } = repo.upsertFromScan({
      ...scan,
      inputs: MORE_FILES,
      sizeBytes: scan.sizeBytes + 500,
      footageSec: 600,
    });

    expect(outcome).toBe('updated');
    expect(job).toMatchObject({
      state: 'arriving',
      inputs: MORE_FILES,
      sizeBytes: scan.sizeBytes + 500,
      lastChangeAt: '2026-10-20T10:00:30.000Z',
      settlesAt: '2026-10-20T10:01:30.000Z',
      updatedAt: '2026-10-20T10:00:30.000Z',
      addedAt: T0,
    });
    expect(repo.getMeta(scan.id)?.footageSec).toBe(600);
  });

  it('sends a queued job back to arriving when its files change', () => {
    const { repo, clock } = setup();
    const scan = makeScan();
    const id = enqueue(repo, clock, scan.client, scan.name);
    clock.tick(10_000);

    const { job, outcome } = repo.upsertFromScan({ ...scan, sizeBytes: scan.sizeBytes + 1 });

    expect(outcome).toBe('updated');
    expect(job).toMatchObject({ id, state: 'arriving', settledAt: null, placeInLine: null });
    expect(job.settlesAt).not.toBeNull();
    expect(job.updatedAt).toBe(job.lastChangeAt);
  });

  it('keeps a held job held but remembers the change', () => {
    const { repo, clock } = setup();
    const scan = makeScan();
    const id = enqueue(repo, clock, scan.client, scan.name);
    repo.applyTransition(id, { type: 'HOLD' });
    clock.tick(10_000);

    const { job } = repo.upsertFromScan({ ...scan, inputs: MORE_FILES });

    expect(job).toMatchObject({ state: 'held', inputs: MORE_FILES });
    expect(job.lastChangeAt).toBe(job.updatedAt);
    // Released within the settle delay of that change, it goes back to arriving.
    clock.tick(5_000);
    expect(repo.applyTransition(id, { type: 'RELEASE' }).state).toBe('arriving');
  });

  it.each(['editing', 'ready', 'failed', 'cancelled'] as const)(
    'leaves the stored inputs of a %s job alone (the machine ignores the change)',
    (state) => {
      const { repo, db, clock } = setup();
      const scan = makeScan();
      const id = enqueue(repo, clock, scan.client, scan.name);
      startEditing(repo, id);
      if (state === 'ready') repo.applyTransition(id, { type: 'SUCCEED', output: OUTPUT });
      if (state === 'failed') repo.applyTransition(id, { type: 'FAIL', step: 4, error: 'boom' });
      if (state === 'cancelled') repo.applyTransition(id, { type: 'CANCEL' });
      clock.tick(10_000);
      const rowBefore = rawRow(db, 'jobs');
      const changesBefore = totalChanges(db);

      const { job, outcome } = repo.upsertFromScan({
        ...scan,
        inputs: MORE_FILES,
        sizeBytes: scan.sizeBytes * 2,
        footageSec: 9_999,
      });

      expect(outcome).toBe('unchanged');
      expect(job.state).toBe(state);
      expect(job.inputs).toEqual(scan.inputs);
      expect(rawRow(db, 'jobs')).toEqual(rowBefore);
      expect(totalChanges(db)).toBe(changesBefore);
    },
  );

  describe('Unicode spellings of one folder', () => {
    const nfc = 'Café Müller/Frühling';
    const nfd = nfc.normalize('NFD');

    it('has two spellings that really differ', () => {
      expect(nfd).not.toBe(nfc);
      expect(nfd.normalize('NFC')).toBe(nfc);
    });

    it('matches by id, and stores the new spelling without touching updatedAt', () => {
      const { repo, clock } = setup();
      const first = repo.upsertFromScan(makeScan('Café Müller', 'Frühling'));
      clock.tick(5_000);

      const second = repo.upsertFromScan(
        makeScan('Café Müller'.normalize('NFD'), 'Frühling'.normalize('NFD')),
      );

      expect(second.job.id).toBe(first.job.id);
      expect(second.outcome).toBe('updated');
      expect(second.job.relPath).toBe(nfd);
      expect(second.job.client).toBe('Café Müller'.normalize('NFD'));
      expect(second.job.updatedAt).toBe(first.job.updatedAt);
      expect(second.job.lastChangeAt).toBe(first.job.lastChangeAt);
      expect(repo.getAll()).toHaveLength(1);
    });

    it('finds the job by relPath in either spelling, or a mix of them', () => {
      const { repo } = setup();
      const { job } = repo.upsertFromScan(makeScan('Café Müller'.normalize('NFD'), 'Frühling'));

      expect(repo.getByRelPath(nfc)?.id).toBe(job.id);
      expect(repo.getByRelPath(nfd)?.id).toBe(job.id);
      expect(repo.getByRelPath(`${'Café Müller'.normalize('NFD')}/Frühling`)?.id).toBe(job.id);
      expect(repo.getByRelPath('café müller/frühling')).toBeNull();
    });

    it('gives the job one client id in either spelling', () => {
      const { repo, clock } = setup();
      const first = repo.upsertFromScan(makeScan('Café Müller', 'Frühling'));
      clock.tick(5_000);
      const second = repo.upsertFromScan(
        makeScan('Café Müller'.normalize('NFD'), 'Frühling'.normalize('NFD')),
      );

      expect(first.job.clientId).toBe(idFor('Café Müller'));
      expect(second.job.clientId).toBe(first.job.clientId);
      expect(second.job.client).not.toBe(first.job.client);
      expect(repo.get(first.job.id)?.clientId).toBe(first.job.clientId);
    });
  });

  describe('clientId', () => {
    it('is on every job any read returns, and is the hash of the client folder name', () => {
      const { repo, clock } = setup();
      const acme = enqueue(repo, clock, 'Acme', 'Spring');
      repo.upsertFromScan(makeScan('Acme', 'Summer'));
      repo.upsertFromScan(makeScan('מאפיית הצפון', 'סרטון'));

      const all = repo.getAll();
      expect(all).toHaveLength(3);
      for (const job of all) {
        expect(job.clientId).toBe(idFor(job.client));
        expect(jobSchema.parse(job)).toEqual(job);
      }
      expect(repo.get(acme)?.clientId).toBe(idFor('Acme'));
      expect(repo.getByRelPath('Acme/Summer')?.clientId).toBe(idFor('Acme'));
      expect(repo.nextQueued()?.clientId).toBe(idFor('Acme'));
      expect(
        new Set(all.filter((job) => job.client === 'Acme').map((job) => job.clientId)).size,
      ).toBe(1);
    });

    it('comes back with every state change and the note, since they return the whole job', () => {
      const { repo, clock } = setup();
      const id = enqueue(repo, clock, 'Acme', 'Spring');

      expect(repo.applyTransition(id, { type: 'START' }).clientId).toBe(idFor('Acme'));
      repo.applyTransition(id, { type: 'FAIL', step: 2, error: 'boom' });
      expect(repo.setNote(id, 'Keep it short').clientId).toBe(idFor('Acme'));
    });
  });

  describe('clientNames', () => {
    it('lists each client once, sorted, whatever number of jobs it has', () => {
      const { repo } = setup();
      repo.upsertFromScan(makeScan('Beta', 'One'));
      repo.upsertFromScan(makeScan('Acme', 'Spring'));
      repo.upsertFromScan(makeScan('Acme', 'Summer'));

      expect(repo.clientNames()).toEqual(['Acme', 'Beta']);
    });

    it('is empty without jobs, and forgets a client whose last job is removed', () => {
      const { repo } = setup();
      expect(repo.clientNames()).toEqual([]);

      const { job } = repo.upsertFromScan(makeScan('Acme', 'Spring'));
      expect(repo.clientNames()).toEqual(['Acme']);
      repo.remove(job.id);
      expect(repo.clientNames()).toEqual([]);
    });
  });

  describe('clientJobStats', () => {
    it('counts the jobs of each client and tells when the newest was added', () => {
      const { repo, clock } = setup();
      repo.upsertFromScan(makeScan('Beta', 'One'));
      clock.tick(60_000);
      repo.upsertFromScan(makeScan('Acme', 'Spring'));
      clock.tick(60_000);
      const newest = repo.upsertFromScan(makeScan('Acme', 'Summer')).job;

      expect(repo.clientJobStats()).toEqual([
        { client: 'Acme', jobs: 2, lastAddedAt: newest.addedAt },
        { client: 'Beta', jobs: 1, lastAddedAt: new Date(Date.parse(T0)).toISOString() },
      ]);
      expect(Date.parse(newest.addedAt)).toBe(Date.parse(T0) + 120_000);
    });

    it('is empty without jobs, and forgets a client whose last job is removed', () => {
      const { repo } = setup();
      expect(repo.clientJobStats()).toEqual([]);

      const { job } = repo.upsertFromScan(makeScan('Acme', 'Spring'));
      expect(repo.clientJobStats()).toHaveLength(1);
      repo.remove(job.id);
      expect(repo.clientJobStats()).toEqual([]);
    });
  });

  describe('footage length', () => {
    it('fills in a first reading when the job had none', () => {
      const { repo } = setup();
      const scan = makeScan('A', 'B', { footageSec: 0 });
      repo.upsertFromScan(scan);

      const { outcome } = repo.upsertFromScan({ ...scan, footageSec: 321 });

      expect(outcome).toBe('unchanged');
      expect(repo.getMeta(scan.id)?.footageSec).toBe(321);
    });

    it('does not let a failed probe (0) replace a known length when the files are the same', () => {
      const { repo } = setup();
      const scan = makeScan('A', 'B', { footageSec: 321 });
      repo.upsertFromScan(scan);

      repo.upsertFromScan({ ...scan, footageSec: 0 });

      expect(repo.getMeta(scan.id)?.footageSec).toBe(321);
    });

    it('follows the files when they change', () => {
      const { repo } = setup();
      const scan = makeScan('A', 'B', { footageSec: 321 });
      repo.upsertFromScan(scan);

      repo.upsertFromScan({ ...scan, inputs: MORE_FILES, footageSec: 400 });

      expect(repo.getMeta(scan.id)?.footageSec).toBe(400);
    });
  });
});

describe('attempt, startedAt and finishedAt', () => {
  it('follow the lifecycle of the attempts', () => {
    const { repo, clock } = setup();
    const id = enqueue(repo, clock, 'A', 'B');
    expect(repo.getMeta(id)).toMatchObject({ attempt: 1, startedAt: null, finishedAt: null });

    clock.tick(1_000);
    repo.applyTransition(id, { type: 'START' });
    const started = '2026-10-20T10:01:01.000Z';
    expect(repo.getMeta(id)).toMatchObject({ attempt: 1, startedAt: started, finishedAt: null });

    clock.tick(1_000);
    repo.applyTransition(id, { type: 'FAIL', step: 3, error: 'boom' });
    const failed = '2026-10-20T10:01:02.000Z';
    expect(repo.getMeta(id)).toMatchObject({ attempt: 1, startedAt: started, finishedAt: failed });

    clock.tick(1_000);
    repo.applyTransition(id, { type: 'RETRY' });
    expect(repo.getMeta(id)).toMatchObject({ attempt: 2, finishedAt: failed });

    clock.tick(1_000);
    repo.applyTransition(id, { type: 'START' });
    const restarted = '2026-10-20T10:01:04.000Z';
    expect(repo.getMeta(id)).toMatchObject({
      attempt: 2,
      startedAt: restarted,
      finishedAt: null,
    });

    clock.tick(1_000);
    repo.applyTransition(id, { type: 'CANCEL' });
    expect(repo.getMeta(id)).toMatchObject({ finishedAt: '2026-10-20T10:01:05.000Z' });

    // Resuming a cancelled job continues the attempt: only RETRY counts a new one.
    repo.applyTransition(id, { type: 'RESUME' });
    expect(repo.getMeta(id)?.attempt).toBe(2);

    clock.tick(1_000);
    repo.applyTransition(id, { type: 'START' });
    clock.tick(1_000);
    repo.applyTransition(id, { type: 'SUCCEED', output: OUTPUT });
    expect(repo.getMeta(id)).toMatchObject({
      attempt: 2,
      finishedAt: '2026-10-20T10:01:07.000Z',
    });
  });

  it('are not part of the Job', () => {
    const { repo, clock } = setup();
    const id = enqueue(repo, clock, 'A', 'B');
    startEditing(repo, id);
    const job = repo.get(id);
    expect(job).not.toHaveProperty('attempt');
    expect(job).not.toHaveProperty('startedAt');
    expect(job).not.toHaveProperty('finishedAt');
  });
});

describe('getAll, getEditing, remove', () => {
  it('lists the most recently updated job first', () => {
    const { repo, clock } = setup();
    const a = enqueue(repo, clock, 'A', 'One');
    const b = enqueue(repo, clock, 'A', 'Two');
    const c = enqueue(repo, clock, 'A', 'Three');
    expect(repo.getAll().map((j) => j.id)).toEqual([c, b, a]);

    clock.tick();
    repo.applyTransition(a, { type: 'HOLD' });
    expect(repo.getAll().map((j) => j.id)).toEqual([a, c, b]);
  });

  it('returns an empty list for an empty database', () => {
    expect(setup().repo.getAll()).toEqual([]);
  });

  it('getEditing finds the jobs a crash left running, and only those', () => {
    const { repo, clock } = setup();
    const a = enqueue(repo, clock, 'A', 'One');
    enqueue(repo, clock, 'A', 'Two');
    startEditing(repo, a);
    repo.applyTransition(a, { type: 'PROGRESS', step: 4, sub: null });

    expect(repo.getEditing()).toEqual([repo.get(a)]);
    repo.applyTransition(a, { type: 'CANCEL' });
    expect(repo.getEditing()).toEqual([]);
  });

  it('removes a job and reports whether there was one', () => {
    const { repo, clock } = setup();
    const a = enqueue(repo, clock, 'A', 'One');
    const b = enqueue(repo, clock, 'A', 'Two');

    expect(repo.remove(a)).toBe(true);
    expect(repo.remove(a)).toBe(false);
    expect(repo.get(a)).toBeNull();
    expect(repo.getByRelPath('A/One')).toBeNull();
    expect(repo.getAll().map((j) => j.id)).toEqual([b]);
  });

  it("deletes the review notes of the removed job, sent and unsent, and keeps another job's", () => {
    const { repo, clock, db } = setup();
    const a = enqueue(repo, clock, 'A', 'One');
    const b = enqueue(repo, clock, 'A', 'Two');
    const notes = new NoteRepository(db, { clock });
    notes.create({ id: 'a-sent', jobId: a, kind: 'text', atSec: 1, text: 'Sent' });
    notes.markSent(a, ['a-sent'], 1, '2026-10-20T10:05:00.000Z');
    notes.create({ id: 'a-unsent', jobId: a, kind: 'text', atSec: 2, text: 'Unsent' });
    notes.create({ id: 'b-unsent', jobId: b, kind: 'text', atSec: 3, text: 'Other job' });

    expect(repo.remove(a)).toBe(true);

    expect(notes.get('a-sent')).toBeNull();
    expect(notes.get('a-unsent')).toBeNull();
    expect(notes.get('b-unsent')).toMatchObject({ jobId: b, text: 'Other job' });
    expect(rawRow(db, 'review_notes')).toHaveLength(1);
  });

  it('lets the same folder come back as a new job after it was removed', () => {
    const { repo, clock } = setup();
    const scan = makeScan();
    const id = enqueue(repo, clock, scan.client, scan.name);
    repo.remove(id);
    clock.tick(1_000);

    const { job, outcome } = repo.upsertFromScan(scan);

    expect(outcome).toBe('created');
    expect(job).toMatchObject({ id, state: 'arriving', addedAt: '2026-10-20T10:01:01.000Z' });
  });
});

describe('setNote', () => {
  /** Walks a new job to `state` through real events and returns its id. */
  function jobIn(repo: Repo, clock: ReturnType<typeof fakeClock>, state: Job['state']): string {
    const { job } = repo.upsertFromScan(makeScan('A', `In ${state}`));
    const path: Record<Job['state'], JobEvent[]> = {
      arriving: [],
      queued: [{ type: 'SETTLED' }],
      held: [{ type: 'HOLD' }],
      editing: [{ type: 'SETTLED' }, { type: 'START' }],
      review: [
        { type: 'SETTLED' },
        { type: 'START' },
        { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
      ],
      ready: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'SUCCEED', output: OUTPUT }],
      failed: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'FAIL', step: 4, error: 'boom' }],
      cancelled: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }],
    };
    for (const event of path[state]) {
      clock.tick();
      repo.applyTransition(job.id, event);
    }
    return job.id;
  }

  it('starts out with no note', () => {
    const { repo } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    expect(job.note).toBeNull();
    expect(repo.getAll()[0]?.note).toBeNull();
  });

  it('stores the trimmed note, returns the job and bumps updatedAt', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'queued');
    const before = repo.get(id) as Job;
    clock.tick(5_000);

    const saved = repo.setNote(id, '  Keep it under 30 seconds.\n');

    expect(saved.note).toBe('Keep it under 30 seconds.');
    expect(saved.updatedAt).toBe(clock().toISOString());
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    expect(repo.get(id)).toEqual(saved);
    expect(repo.getAll().find((job) => job.id === id)?.note).toBe('Keep it under 30 seconds.');
    expect(jobSchema.parse(saved)).toEqual(saved);
  });

  it('changes nothing but the note and updatedAt', () => {
    const { repo, clock } = setup();
    const first = jobIn(repo, clock, 'queued');
    const arriving = jobIn(repo, clock, 'arriving');
    clock.tick(5_000);

    for (const id of [first, arriving]) {
      const before = repo.get(id) as Job;
      const saved = repo.setNote(id, 'A note');
      expect(saved).toEqual({ ...before, note: 'A note', updatedAt: clock().toISOString() });
    }
    // The queue and the settle timer are as they were.
    expect(repo.get(first)).toMatchObject({ state: 'queued', placeInLine: 1 });
    expect(repo.get(arriving)).toMatchObject({ state: 'arriving', settledAt: null });
  });

  it('replaces the old note with the new one', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'held');
    repo.setNote(id, 'First');
    clock.tick();
    expect(repo.setNote(id, 'Second').note).toBe('Second');
  });

  it.each(['', ' ', '\n', ' \t\r\n '])('stores %j as no note, clearing an old one', (empty) => {
    const { repo, clock, db } = setup();
    const id = jobIn(repo, clock, 'held');
    repo.setNote(id, 'Something');
    clock.tick();

    const cleared = repo.setNote(id, empty);

    expect(cleared.note).toBeNull();
    expect(repo.get(id)?.note).toBeNull();
    const [row] = rawRow(db, 'jobs', `id = '${id}'`) as Array<{ note: unknown }>;
    expect(row?.note).toBeNull();
  });

  it('keeps Hebrew, mixed direction and line breaks exactly, inside the note', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'arriving');
    const note = 'תשתמש בטייק השני.\n\nKeep the logo at the end – תודה';

    expect(repo.setNote(id, `\n${note}  `).note).toBe(note);
  });

  it('accepts exactly 4000 characters and refuses one more with a 400 error', () => {
    const { repo, clock, db } = setup();
    const id = jobIn(repo, clock, 'queued');
    expect(NOTE_MAX_LENGTH).toBe(4000);

    expect(repo.setNote(id, 'x'.repeat(4000)).note).toHaveLength(4000);
    clock.tick();
    const rows = rawRow(db, 'jobs');
    expect(() => repo.setNote(id, 'x'.repeat(4001))).toThrow(NoteTooLongError);
    expect(() => repo.setNote(id, 'x'.repeat(4001))).toThrow(
      'The note can be at most 4000 characters.',
    );
    expect(rawRow(db, 'jobs')).toEqual(rows);
  });

  it('counts the length after trimming', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'queued');
    const padded = `   ${'x'.repeat(4000)}\n\n  `;
    expect(repo.setNote(id, padded).note).toHaveLength(4000);
  });

  it.each([
    ['arriving', true],
    ['queued', true],
    ['held', true],
    ['editing', false],
    ['review', false],
    ['ready', false],
    ['failed', true],
    ['cancelled', true],
  ] as const)('in a %s job: allowed %s', (state, allowed) => {
    const { repo, clock, db } = setup();
    const id = jobIn(repo, clock, state);
    clock.tick();
    const rows = rawRow(db, 'jobs');

    if (allowed) {
      expect(repo.setNote(id, 'A note').note).toBe('A note');
      return;
    }
    expect(() => repo.setNote(id, 'A note')).toThrow(NoteNotEditableError);
    expect(() => repo.setNote(id, 'A note')).toThrow(
      `Cannot edit the note of a job that is ${state}.`,
    );
    expect(rawRow(db, 'jobs')).toEqual(rows);
  });

  it('carries the details of a refusal', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'editing');
    let caught: unknown;
    try {
      repo.setNote(id, 'x');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NoteNotEditableError);
    expect(caught).toMatchObject({ name: 'NoteNotEditableError', jobId: id, state: 'editing' });
  });

  it('refuses an unknown job with JobNotFoundError', () => {
    const { repo } = setup();
    expect(() => repo.setNote('nosuchjob00', 'x')).toThrow(JobNotFoundError);
  });

  it('refuses a note that is too long before it looks at the job', () => {
    const { repo } = setup();
    expect(() => repo.setNote('nosuchjob00', 'x'.repeat(4001))).toThrow(NoteTooLongError);
  });

  it('stays through every later state change, scan and restart, and is read back as saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-note-'));
    dirs.push(dir);
    const path = join(dir, 'engine.db');
    const clock = fakeClock();
    const first = openDatabase(path);
    opened.push(first);
    const repo = new JobRepository(first, { clock });
    const { job } = repo.upsertFromScan(makeScan());
    repo.setNote(job.id, 'Keep it short');

    for (const event of [
      { type: 'HOLD' },
      { type: 'RELEASE' }, // a minute after the last change: straight to the queue
      { type: 'START' },
      { type: 'PROGRESS', step: 3, sub: null },
      { type: 'FAIL', step: 3, error: 'boom' },
      { type: 'RETRY' },
    ] satisfies JobEvent[]) {
      clock.tick(SETTLE_MS);
      expect(repo.applyTransition(job.id, event).note, event.type).toBe('Keep it short');
    }
    clock.tick();
    const changed = repo.upsertFromScan(
      makeScan('Northwind Bakery', 'Spring menu', { inputs: MORE_FILES }),
    );
    expect(changed.job.note).toBe('Keep it short');

    first.close();
    const second = openDatabase(path);
    opened.push(second);
    expect(new JobRepository(second, { clock }).get(job.id)?.note).toBe('Keep it short');
  });
});

describe('Start now (the start action) in the repository', () => {
  it('queues an arriving job at once, with settledAt now, and keeps the files-changed time', () => {
    const { repo, clock } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    clock.tick(5_000);

    const started = repo.applyTransition(job.id, eventForAction('start'));

    expect(started).toMatchObject({
      state: 'queued',
      settledAt: clock().toISOString(),
      settlesAt: null,
      placeInLine: 1,
      lastChangeAt: job.lastChangeAt,
    });
    expect(repo.nextQueued()?.id).toBe(job.id);
  });

  it('refuses every other state without writing', () => {
    const { repo, clock, db } = setup();
    const id = enqueue(repo, clock, 'A', 'B');
    const rows = rawRow(db, 'jobs');

    expect(() => repo.applyTransition(id, eventForAction('start'))).toThrow(InvalidTransition);
    expect(rawRow(db, 'jobs')).toEqual(rows);
  });

  it('a later file change sends the started job back to arriving', () => {
    const { repo, clock } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    repo.applyTransition(job.id, eventForAction('start'));
    clock.tick(5_000);

    const { job: changed } = repo.upsertFromScan(
      makeScan('Northwind Bakery', 'Spring menu', { inputs: MORE_FILES }),
    );

    expect(changed).toMatchObject({
      state: 'arriving',
      settledAt: null,
      lastChangeAt: clock().toISOString(),
      settlesAt: new Date(clock().getTime() + SETTLE_MS).toISOString(),
    });
  });
});

describe('review and run kinds', () => {
  /** A queued job that has been through SETTLED. Returns its id. */
  function queued(repo: Repo, clock: ReturnType<typeof fakeClock>): string {
    return enqueue(repo, clock, 'A', 'B');
  }

  /** Applies the events one second apart. */
  function apply(
    repo: Repo,
    clock: ReturnType<typeof fakeClock>,
    id: string,
    ...events: JobEvent[]
  ): Job {
    let job = repo.get(id) as Job;
    for (const event of events) {
      clock.tick();
      job = repo.applyTransition(id, event);
    }
    return job;
  }

  const READY_FOR_REVIEW: JobEvent[] = [
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ];

  it('stores the run kind, round, preview and approval in the row and reads them back', () => {
    const { repo, clock, db } = setup();
    const id = queued(repo, clock);
    const row = () =>
      rawRow(db, 'jobs', `id = '${id}'`)[0] as {
        run_kind: string;
        round: number;
        preview: string | null;
        approved_at: number | null;
      };

    expect(row()).toMatchObject({ run_kind: 'edit', round: 0, preview: null, approved_at: null });

    const inReview = apply(repo, clock, id, ...READY_FOR_REVIEW);
    expect(inReview).toMatchObject({
      state: 'review',
      step: 7,
      runKind: 'edit',
      round: 0,
      preview: SAMPLE_PREVIEW,
      approvedAt: null,
    });
    expect(row()).toMatchObject({ run_kind: 'edit', round: 0, approved_at: null });
    expect(JSON.parse(row().preview as string)).toEqual(SAMPLE_PREVIEW);

    const revising = apply(repo, clock, id, { type: 'SEND_NOTES' });
    expect(revising).toMatchObject({
      state: 'queued',
      step: null,
      runKind: 'revise',
      round: 1,
      preview: SAMPLE_PREVIEW,
      approvedAt: null,
    });
    expect(row()).toMatchObject({ run_kind: 'revise', round: 1, approved_at: null });

    apply(repo, clock, id, ...READY_FOR_REVIEW);
    const approvedAt = new Date(clock.tick().getTime());
    const rendering = repo.applyTransition(id, { type: 'APPROVE' });
    expect(rendering).toMatchObject({
      state: 'queued',
      step: null,
      runKind: 'render',
      round: 1,
      preview: SAMPLE_PREVIEW,
      approvedAt: approvedAt.toISOString(),
    });
    expect(row()).toMatchObject({
      run_kind: 'render',
      round: 1,
      approved_at: approvedAt.getTime(),
    });
    expect(repo.get(id)).toEqual(rendering);
    expect(jobSchema.parse(repo.get(id))).toEqual(rendering);
  });

  it('PREVIEW_READY sets finishedAt and START clears it', () => {
    const { repo, clock } = setup();
    const id = queued(repo, clock);

    clock.tick();
    repo.applyTransition(id, { type: 'START' });
    expect(repo.getMeta(id)).toMatchObject({ startedAt: clock().toISOString(), finishedAt: null });

    clock.tick();
    repo.applyTransition(id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
    const ready = clock().toISOString();
    expect(repo.getMeta(id)).toMatchObject({ finishedAt: ready });

    apply(repo, clock, id, { type: 'SEND_NOTES' });
    expect(repo.getMeta(id)?.finishedAt).toBe(ready);

    clock.tick();
    repo.applyTransition(id, { type: 'START' });
    expect(repo.getMeta(id)).toMatchObject({ startedAt: clock().toISOString(), finishedAt: null });
  });

  it('SEND_NOTES puts the attempt back to 1 after a retry made it 2', () => {
    const { repo, clock } = setup();
    const id = queued(repo, clock);
    apply(
      repo,
      clock,
      id,
      { type: 'START' },
      { type: 'FAIL', step: 3, error: 'boom' },
      { type: 'RETRY' },
      ...READY_FOR_REVIEW,
    );
    expect(repo.getMeta(id)?.attempt).toBe(2);

    apply(repo, clock, id, { type: 'SEND_NOTES' });

    expect(repo.getMeta(id)?.attempt).toBe(1);
  });

  it('APPROVE puts the attempt back to 1 after a retry made it 2', () => {
    const { repo, clock } = setup();
    const id = queued(repo, clock);
    apply(
      repo,
      clock,
      id,
      { type: 'START' },
      { type: 'FAIL', step: 3, error: 'boom' },
      { type: 'RETRY' },
      ...READY_FOR_REVIEW,
    );
    expect(repo.getMeta(id)?.attempt).toBe(2);

    apply(repo, clock, id, { type: 'APPROVE' });

    expect(repo.getMeta(id)?.attempt).toBe(1);
  });

  it('a retry of the revise run counts attempts again from 1', () => {
    const { repo, clock } = setup();
    const id = queued(repo, clock);
    apply(repo, clock, id, ...READY_FOR_REVIEW, { type: 'SEND_NOTES' }, { type: 'START' });
    apply(repo, clock, id, { type: 'FAIL', step: 5, error: 'boom' }, { type: 'RETRY' });

    expect(repo.get(id)).toMatchObject({ state: 'queued', runKind: 'revise', round: 1, step: 5 });
    expect(repo.getMeta(id)?.attempt).toBe(2);
  });

  describe('the Review switch', () => {
    it('is off by default: an edit run SUCCEEDs to ready', () => {
      const { repo, clock } = setup();
      const id = queued(repo, clock);

      const done = apply(repo, clock, id, { type: 'START' }, { type: 'SUCCEED', output: OUTPUT });

      expect(done).toMatchObject({ state: 'ready', runKind: 'edit', output: OUTPUT });
    });

    it('is off when asked to be: an edit run SUCCEEDs to ready', () => {
      const { repo, clock } = setup({ review: false });
      const id = queued(repo, clock);

      const done = apply(repo, clock, id, { type: 'START' }, { type: 'SUCCEED', output: OUTPUT });

      expect(done.state).toBe('ready');
    });

    it('when on, refuses SUCCEED for an edit run and writes nothing', () => {
      const { repo, clock, db } = setup({ review: true });
      const id = queued(repo, clock);
      apply(repo, clock, id, { type: 'START' });
      const rows = rawRow(db, 'jobs');
      const changes = totalChanges(db);
      clock.tick();

      expect(() => repo.applyTransition(id, { type: 'SUCCEED', output: OUTPUT })).toThrow(
        InvalidTransition,
      );

      expect(rawRow(db, 'jobs')).toEqual(rows);
      expect(totalChanges(db)).toBe(changes);
      expect(repo.get(id)?.state).toBe('editing');
    });

    it('when on, lets an edit run end in review and a render run SUCCEED', () => {
      const { repo, clock } = setup({ review: true });
      const id = queued(repo, clock);
      apply(repo, clock, id, ...READY_FOR_REVIEW, { type: 'APPROVE' }, { type: 'START' });
      expect(repo.get(id)).toMatchObject({ state: 'editing', runKind: 'render', step: 8 });

      const done = apply(repo, clock, id, { type: 'SUCCEED', output: OUTPUT });

      expect(done).toMatchObject({ state: 'ready', runKind: 'render', output: OUTPUT });
    });

    it('when on, never lets a revise run SUCCEED; off does not either', () => {
      for (const review of [true, false]) {
        const { repo, clock } = setup({ review });
        const id = queued(repo, clock);
        apply(repo, clock, id, ...READY_FOR_REVIEW, { type: 'SEND_NOTES' }, { type: 'START' });

        expect(() => repo.applyTransition(id, { type: 'SUCCEED', output: OUTPUT })).toThrow(
          InvalidTransition,
        );
        expect(repo.get(id)?.state).toBe('editing');
      }
    });
  });

  it('keeps a review job as it is when a scan finds more files', () => {
    const { repo, clock, db } = setup();
    const id = queued(repo, clock);
    apply(repo, clock, id, ...READY_FOR_REVIEW);
    const before = repo.get(id) as Job;
    const rows = rawRow(db, 'jobs');
    clock.tick(5_000);

    const { job, outcome } = repo.upsertFromScan(makeScan('A', 'B', { inputs: MORE_FILES }));

    expect(outcome).toBe('unchanged');
    expect(job).toEqual(before);
    expect(job.inputs).toEqual(makeScan('A', 'B').inputs);
    expect(rawRow(db, 'jobs')).toEqual(rows);
  });

  it('refuses SEND_NOTES and APPROVE outside review without writing', () => {
    const { repo, clock, db } = setup();
    const id = queued(repo, clock);
    const rows = rawRow(db, 'jobs');

    expect(() => repo.applyTransition(id, { type: 'SEND_NOTES' })).toThrow(InvalidTransition);
    expect(() => repo.applyTransition(id, { type: 'APPROVE' })).toThrow(InvalidTransition);
    expect(rawRow(db, 'jobs')).toEqual(rows);
  });
});

describe('review time (CVP-149)', () => {
  /** A job that is in review: queued, started and previewed. Returns its id. */
  function inReview(repo: Repo, clock: ReturnType<typeof fakeClock>): string {
    const id = enqueue(repo, clock, 'A', 'B');
    clock.tick();
    repo.applyTransition(id, { type: 'START' });
    clock.tick();
    repo.applyTransition(id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
    return id;
  }

  const reviewSecOf = (db: StudioDb, id: string): unknown =>
    (
      db.sqlite.prepare('select review_sec from jobs where id = ?').get(id) as {
        review_sec: number;
      }
    ).review_sec;

  it('starts at 0 for a new job, and the stored meta shows it', () => {
    const { repo, db } = setup();
    const { job } = repo.upsertFromScan(makeScan('A', 'B'));

    expect(reviewSecOf(db, job.id)).toBe(0);
    expect(repo.getMeta(job.id)?.reviewSec).toBe(0);
  });

  it('adds up the seconds of a job in review and answers with the total', () => {
    const { repo, clock, db } = setup();
    const id = inReview(repo, clock);

    expect(repo.addReviewSec(id, 15)).toBe(15);
    expect(repo.addReviewSec(id, 1)).toBe(16);
    expect(repo.addReviewSec(id, 60)).toBe(76);

    expect(repo.getMeta(id)?.reviewSec).toBe(76);
    expect(reviewSecOf(db, id)).toBe(76);
  });

  it('changes nothing the web app shows: not updatedAt, not the job', () => {
    const { repo, clock } = setup();
    const id = inReview(repo, clock);
    const before = repo.get(id);
    clock.tick(30_000);

    repo.addReviewSec(id, 15);

    expect(repo.get(id)).toEqual(before);
  });

  it('keeps the time through the next transitions: a round of notes, the approval, the delivery', () => {
    const { repo, clock } = setup();
    const id = inReview(repo, clock);
    repo.addReviewSec(id, 40);

    clock.tick();
    repo.applyTransition(id, { type: 'SEND_NOTES' });
    expect(repo.getMeta(id)?.reviewSec).toBe(40);
    clock.tick();
    repo.applyTransition(id, { type: 'START' });
    clock.tick();
    repo.applyTransition(id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
    expect(repo.addReviewSec(id, 20)).toBe(60);
    clock.tick();
    repo.applyTransition(id, { type: 'APPROVE' });
    clock.tick();
    repo.applyTransition(id, { type: 'START' });
    clock.tick();
    repo.applyTransition(id, { type: 'SUCCEED', output: OUTPUT });

    expect(repo.get(id)?.state).toBe('ready');
    expect(repo.getMeta(id)?.reviewSec).toBe(60);
  });

  it.each(['arriving', 'queued', 'held', 'editing', 'ready', 'failed', 'cancelled'] as const)(
    'refuses a job that is %s, and writes nothing',
    (state) => {
      const { repo, clock, db } = setup();
      const { job } = repo.upsertFromScan(makeScan('A', 'B'));
      const path: Record<typeof state, JobEvent[]> = {
        arriving: [],
        queued: [{ type: 'SETTLED' }],
        held: [{ type: 'HOLD' }],
        editing: [{ type: 'SETTLED' }, { type: 'START' }],
        ready: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'SUCCEED', output: OUTPUT }],
        failed: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'FAIL', step: 4, error: 'x' }],
        cancelled: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }],
      };
      for (const event of path[state]) {
        clock.tick();
        repo.applyTransition(job.id, event);
      }
      const rows = rawRow(db, 'jobs');

      expect(() => repo.addReviewSec(job.id, 15)).toThrow(ReviewTimeRefusedError);
      expect(rawRow(db, 'jobs')).toEqual(rows);
    },
  );

  it('throws JobNotFoundError for an unknown job', () => {
    const { repo } = setup();

    expect(() => repo.addReviewSec('nope', 15)).toThrow(JobNotFoundError);
  });

  it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s seconds without writing',
    (sec) => {
      const { repo, clock, db } = setup();
      const id = inReview(repo, clock);
      const rows = rawRow(db, 'jobs');

      expect(() => repo.addReviewSec(id, sec)).toThrow(RangeError);
      expect(rawRow(db, 'jobs')).toEqual(rows);
    },
  );
});

describe('Job.delivery: read from the deliveries table', () => {
  /** A job that finished its edit and is ready. */
  function readyJob(repo: Repo, clock: ReturnType<typeof fakeClock>, name = 'Spring menu') {
    const id = enqueue(repo, clock, 'Northwind Bakery', name);
    startEditing(repo, id);
    return repo.applyTransition(id, { type: 'SUCCEED', output: OUTPUT });
  }

  /** What the deliver route stores (M12) for a job. */
  function deliver(
    deliveries: DeliveryRepository,
    job: Job,
    overrides: { deliveredAt?: number; price?: number; currency?: string } = {},
  ): void {
    deliveries.record({
      jobId: job.id,
      clientId: job.clientId,
      client: job.client,
      name: job.name,
      relPath: job.relPath,
      deliveredAt: Date.parse('2026-10-21T15:00:00.000Z'),
      price: 40,
      currency: 'ILS',
      ...overrides,
    });
  }

  it('is null for a job that was not marked delivered, ready or not', () => {
    const { repo, clock } = setup();
    const ready = readyJob(repo, clock);
    const { job: arriving } = repo.upsertFromScan(makeScan('Northwind Bakery', 'Fresh'));

    expect(ready.delivery).toBeNull();
    expect(repo.get(ready.id)?.delivery).toBeNull();
    expect(arriving.delivery).toBeNull();
  });

  it('does not make a delivery when a job reaches ready', () => {
    const { repo, clock, db } = setup();

    readyJob(repo, clock);

    expect(rawRow(db, 'deliveries')).toEqual([]);
  });

  it('carries the delivery of a job: when it was marked, the frozen price and no paid day', () => {
    const { repo, clock, db } = setup();
    const job = readyJob(repo, clock);
    deliver(new DeliveryRepository(db), job, { price: 45, currency: 'USD' });

    const read = repo.get(job.id);

    expect(read?.delivery).toEqual({
      deliveredAt: '2026-10-21T15:00:00.000Z',
      price: 45,
      currency: 'USD',
      paidOn: null,
      paidAmount: null,
    });
    expect(jobSchema.parse(read)).toEqual(read);
  });

  it('carries the day it was paid, and loses it again when it is not paid yet', () => {
    const { repo, clock, db } = setup();
    const deliveries = new DeliveryRepository(db);
    const job = readyJob(repo, clock);
    deliver(deliveries, job);

    deliveries.markPaid([job.id], '2026-10-23');
    expect(repo.get(job.id)?.delivery?.paidOn).toBe('2026-10-23');
    deliveries.unmarkPaid([job.id]);
    expect(repo.get(job.id)?.delivery?.paidOn).toBeNull();
    deliveries.remove(job.id);
    expect(repo.get(job.id)?.delivery).toBeNull();
  });

  it('gives each job its own delivery on every read path', () => {
    const { repo, clock, db } = setup();
    const deliveries = new DeliveryRepository(db);
    const first = readyJob(repo, clock, 'First');
    clock.tick();
    const second = readyJob(repo, clock, 'Second');
    clock.tick();
    const third = readyJob(repo, clock, 'Third');
    deliver(deliveries, first, { price: 40 });
    deliver(deliveries, third, { price: 60 });

    const byId = new Map(repo.getAll().map((job) => [job.id, job.delivery?.price ?? null]));

    expect(byId).toEqual(
      new Map([
        [first.id, 40],
        [second.id, null],
        [third.id, 60],
      ]),
    );
    expect(repo.getByRelPath(third.relPath)?.delivery?.price).toBe(60);
    expect(repo.getByRelPath(second.relPath)?.delivery).toBeNull();
  });

  it('reads the delivery of every job when there are more than one query holds', () => {
    const { repo, clock, db } = setup();
    const deliveries = new DeliveryRepository(db);
    const count = 1_100;
    for (let index = 0; index < count; index += 1) {
      const { job } = repo.upsertFromScan(makeScan('Northwind Bakery', `Job ${index}`));
      if (index % 2 === 0) deliver(deliveries, job, { price: index });
    }
    clock.tick();

    const all = repo.getAll();

    expect(all).toHaveLength(count);
    expect(all.filter((job) => job.delivery !== null)).toHaveLength(count / 2);
    expect(all.every((job) => job.delivery === null || (job.delivery.price ?? 0) % 2 === 0)).toBe(
      true,
    );
  });

  it('stays on the job when it leaves ready (a retry, a new run), and comes back with it', () => {
    const { repo, clock, db } = setup();
    const job = readyJob(repo, clock);
    deliver(new DeliveryRepository(db), job);

    // The export goes missing; the owner retries.
    const failed = repo.applyTransition(job.id, { type: 'EXPORT_MISSING' });
    const queued = repo.applyTransition(job.id, { type: 'RETRY' });

    expect(failed.state).toBe('failed');
    expect(failed.delivery).toMatchObject({ price: 40 });
    expect(queued.delivery).toMatchObject({ price: 40 });
  });

  it('does not move updatedAt: a delivery is not a change to the job row', () => {
    const { repo, clock, db } = setup();
    const job = readyJob(repo, clock);
    const before = rawRow(db, 'jobs');

    deliver(new DeliveryRepository(db), job);

    expect(rawRow(db, 'jobs')).toEqual(before);
    expect(repo.get(job.id)?.updatedAt).toBe(job.updatedAt);
  });

  it('is gone with a removed job, but the delivery row stays for the Money page', () => {
    const { repo, clock, db } = setup();
    const job = readyJob(repo, clock);
    deliver(new DeliveryRepository(db), job);

    repo.remove(job.id);

    expect(repo.get(job.id)).toBeNull();
    expect(new DeliveryRepository(db).get(job.id)).not.toBeNull();
  });
});
