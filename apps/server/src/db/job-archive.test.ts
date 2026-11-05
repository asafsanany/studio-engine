import {
  ARCHIVE_BLOCKED_STATES,
  canArchive,
  JOB_STATES,
  type Job,
  type JobEvent,
  type JobOutput,
  jobSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { ArchiveRefusedError, JobNotFoundError, JobRepository } from './job-repository.js';
import { rowToStored, storedToColumns } from './mapping.js';
import { jobs } from './schema.js';
import {
  fakeClock,
  makeScan,
  memoryDb,
  rawRow,
  SAMPLE_PREVIEW,
  totalChanges,
} from './test-utils.js';

// CVP-196: `archive` and `unarchive` hide a job from the lists and change nothing else about it
// (`updatedAt` included); a job leaves the archive on its own when it is saved into arriving,
// queued or editing.

const OUTPUT: JobOutput = {
  fileName: 'Northwind Bakery/Spring menu.mp4',
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 65_011_712,
};

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  return { clock, db, repo: new JobRepository(db, { clock }) };
}

type Clock = ReturnType<typeof fakeClock>;

const PATH: Record<Job['state'], JobEvent[]> = {
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

/** Walks a new job to `state` through real events and returns its id. */
function jobIn(
  repo: JobRepository,
  clock: Clock,
  state: Job['state'],
  name = `In ${state}`,
): string {
  const { job } = repo.upsertFromScan(makeScan('A', name));
  for (const event of PATH[state]) {
    clock.tick();
    repo.applyTransition(job.id, event);
  }
  return job.id;
}

const get = (repo: JobRepository, id: string): Job => repo.get(id) as Job;

const ARCHIVABLE = JOB_STATES.filter((state) => canArchive({ state }));

describe('archivedIds', () => {
  it('names the jobs that are archived now, and no others', () => {
    const { repo, clock } = setup();
    const a = jobIn(repo, clock, 'ready', 'A');
    const b = jobIn(repo, clock, 'failed', 'B');
    jobIn(repo, clock, 'ready', 'C');
    expect(repo.archivedIds()).toEqual(new Set());

    repo.archive([a, b]);
    expect(repo.archivedIds()).toEqual(new Set([a, b]));
    repo.unarchive([b]);
    expect(repo.archivedIds()).toEqual(new Set([a]));
  });
});

describe('archive', () => {
  it('starts out not archived', () => {
    const { repo } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    expect(job.archivedAt).toBeNull();
    expect(repo.getAll()[0]?.archivedAt).toBeNull();
  });

  it.each(ARCHIVABLE)('archives a %s job: the date is now, and nothing else changes', (state) => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, state);
    const before = get(repo, id);
    clock.tick(5_000);

    const { jobs: archived, changed } = repo.archive([id]);

    const expected = { ...before, archivedAt: clock().toISOString() };
    expect(archived).toEqual([expected]);
    expect(changed).toEqual([expected]);
    expect(repo.get(id)).toEqual(expected);
    expect(jobSchema.parse(archived[0])).toEqual(expected);
  });

  it('does not move updatedAt, so the job keeps its place in the list', () => {
    const { repo, clock } = setup();
    const older = jobIn(repo, clock, 'ready', 'Older');
    const middle = jobIn(repo, clock, 'ready', 'Middle');
    const newest = jobIn(repo, clock, 'ready', 'Newest');
    const order = repo.getAll().map((job) => job.id);
    expect(order).toEqual([newest, middle, older]);
    const updatedAt = get(repo, middle).updatedAt;
    clock.tick(60_000);

    repo.archive([middle]);

    expect(get(repo, middle).updatedAt).toBe(updatedAt);
    expect(repo.getAll().map((job) => job.id)).toEqual(order);
  });

  it('keeps the first date when a job is archived again', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'ready');
    clock.tick(1_000);
    const archivedOn = clock().toISOString();
    const first = repo.archive([id]).jobs[0]?.archivedAt;
    clock.tick(86_400_000);

    const again = repo.archive([id]);

    expect(first).toBe(archivedOn);
    expect(again.jobs[0]?.archivedAt).toBe(first);
    expect(again.changed).toEqual([]);
    expect(get(repo, id).archivedAt).toBe(first);
  });

  it('writes only the jobs that were not archived yet', () => {
    const { repo, clock, db } = setup();
    const done = jobIn(repo, clock, 'ready', 'Done');
    const fresh = jobIn(repo, clock, 'failed', 'Fresh');
    repo.archive([done]);
    clock.tick(5_000);
    const writes = totalChanges(db);

    const { jobs: all, changed } = repo.archive([done, fresh]);

    expect(all.map((job) => job.id)).toEqual([done, fresh]);
    expect(changed.map((job) => job.id)).toEqual([fresh]);
    expect(totalChanges(db) - writes).toBe(1);
  });

  it('answers the jobs in the order asked, each once', () => {
    const { repo, clock } = setup();
    const a = jobIn(repo, clock, 'ready', 'A');
    const b = jobIn(repo, clock, 'failed', 'B');
    const c = jobIn(repo, clock, 'cancelled', 'C');

    const { jobs: all } = repo.archive([c, a, b, a]);

    expect(all.map((job) => job.id)).toEqual([c, a, b]);
    expect(all.every((job) => job.archivedAt !== null)).toBe(true);
  });

  it('with no ids does nothing', () => {
    const { repo, clock, db } = setup();
    jobIn(repo, clock, 'ready');
    const writes = totalChanges(db);
    expect(repo.archive([])).toEqual({ jobs: [], changed: [] });
    expect(repo.unarchive([])).toEqual({ jobs: [], changed: [] });
    expect(totalChanges(db)).toBe(writes);
  });

  it('leaves the other jobs, the queue and the deliveries alone', () => {
    const { repo, clock, db } = setup();
    const queuedFirst = jobIn(repo, clock, 'queued', 'Queued first');
    const queuedSecond = jobIn(repo, clock, 'queued', 'Queued second');
    const ready = jobIn(repo, clock, 'ready', 'Ready');
    const others = [queuedFirst, queuedSecond].map((id) => get(repo, id));
    const deliveries = rawRow(db, 'deliveries');

    repo.archive([ready]);

    expect([queuedFirst, queuedSecond].map((id) => get(repo, id))).toEqual(others);
    expect(get(repo, queuedSecond).placeInLine).toBe(2);
    expect(rawRow(db, 'deliveries')).toEqual(deliveries);
  });

  it.each(ARCHIVE_BLOCKED_STATES)(
    'refuses a %s job with a plain message, and writes nothing',
    (state) => {
      const { repo, clock, db } = setup();
      const id = jobIn(repo, clock, state, 'Spring menu');
      clock.tick();
      const rows = rawRow(db, 'jobs');

      expect(() => repo.archive([id])).toThrow(ArchiveRefusedError);
      expect(() => repo.archive([id])).toThrow(`Can't archive "Spring menu" while it is ${state}.`);
      expect(rawRow(db, 'jobs')).toEqual(rows);
    },
  );

  it('carries the details of a refusal', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'editing', 'Spring menu');
    let caught: unknown;
    try {
      repo.archive([id]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArchiveRefusedError);
    expect(caught).toMatchObject({
      name: 'ArchiveRefusedError',
      jobId: id,
      jobName: 'Spring menu',
      state: 'editing',
    });
  });

  it('is all or nothing: one job that is working stops the others', () => {
    const { repo, clock, db } = setup();
    const ready = jobIn(repo, clock, 'ready', 'Ready');
    const editing = jobIn(repo, clock, 'editing', 'Editing');
    const failed = jobIn(repo, clock, 'failed', 'Failed');
    clock.tick();
    const rows = rawRow(db, 'jobs');

    expect(() => repo.archive([ready, editing, failed])).toThrow(ArchiveRefusedError);

    expect(rawRow(db, 'jobs')).toEqual(rows);
    expect([ready, editing, failed].map((id) => get(repo, id).archivedAt)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('is all or nothing: one unknown id stops the others', () => {
    const { repo, clock, db } = setup();
    const ready = jobIn(repo, clock, 'ready');
    clock.tick();
    const rows = rawRow(db, 'jobs');

    expect(() => repo.archive([ready, 'nosuchjob00'])).toThrow(JobNotFoundError);
    expect(() => repo.archive(['nosuchjob00', ready])).toThrow('nosuchjob00');

    expect(rawRow(db, 'jobs')).toEqual(rows);
    expect(get(repo, ready).archivedAt).toBeNull();
  });

  it('checks every id before it writes any (the unknown id comes last)', () => {
    const { repo, clock } = setup();
    const a = jobIn(repo, clock, 'ready', 'A');
    const b = jobIn(repo, clock, 'failed', 'B');
    expect(() => repo.archive([a, b, 'nosuchjob00'])).toThrow(JobNotFoundError);
    expect(repo.getAll().map((job) => job.archivedAt)).toEqual([null, null]);
  });
});

describe('unarchive', () => {
  it('takes a job out of the archive and changes nothing else, updatedAt included', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'ready');
    const original = get(repo, id);
    clock.tick(5_000);
    repo.archive([id]);
    clock.tick(5_000);

    const { jobs: back, changed } = repo.unarchive([id]);

    expect(back).toEqual([original]);
    expect(changed).toEqual([original]);
    expect(get(repo, id)).toEqual(original);
    expect(back[0]?.archivedAt).toBeNull();
  });

  it('leaves a job that is not archived as it is', () => {
    const { repo, clock, db } = setup();
    const id = jobIn(repo, clock, 'ready');
    clock.tick();
    const rows = rawRow(db, 'jobs');
    const writes = totalChanges(db);

    const result = repo.unarchive([id]);

    expect(result.jobs).toEqual([get(repo, id)]);
    expect(result.changed).toEqual([]);
    expect(rawRow(db, 'jobs')).toEqual(rows);
    expect(totalChanges(db)).toBe(writes);
  });

  it('answers the jobs in the order asked, and reports the ones it changed', () => {
    const { repo, clock } = setup();
    const a = jobIn(repo, clock, 'ready', 'A');
    const b = jobIn(repo, clock, 'failed', 'B');
    const c = jobIn(repo, clock, 'cancelled', 'C');
    repo.archive([a, c]);

    const { jobs: all, changed } = repo.unarchive([c, b, a]);

    expect(all.map((job) => job.id)).toEqual([c, b, a]);
    expect(changed.map((job) => job.id)).toEqual([c, a]);
    expect(repo.getAll().map((job) => job.archivedAt)).toEqual([null, null, null]);
  });

  it('is all or nothing: an unknown id stops the others', () => {
    const { repo, clock, db } = setup();
    const a = jobIn(repo, clock, 'ready', 'A');
    const b = jobIn(repo, clock, 'failed', 'B');
    repo.archive([a, b]);
    clock.tick();
    const rows = rawRow(db, 'jobs');

    expect(() => repo.unarchive([a, 'nosuchjob00', b])).toThrow(JobNotFoundError);

    expect(rawRow(db, 'jobs')).toEqual(rows);
    expect([a, b].map((id) => get(repo, id).archivedAt)).not.toContain(null);
  });

  it('gives a new date when the job is archived again', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'ready');
    clock.tick(1_000);
    const first = repo.archive([id]).jobs[0]?.archivedAt;
    repo.unarchive([id]);
    clock.tick(60_000);

    const second = repo.archive([id]).jobs[0]?.archivedAt;

    expect(second).not.toBe(first);
    expect(Date.parse(second ?? '')).toBeGreaterThan(Date.parse(first ?? ''));
  });

  it('does not refuse a job in a state that cannot be archived (it cannot be archived anyway)', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'queued');
    expect(repo.unarchive([id]).changed).toEqual([]);
  });
});

describe('leaving the archive on its own', () => {
  /** A job archived in `state` (walked there through real events) and then given `event`. */
  function archivedThen(state: Job['state'], event: JobEvent) {
    const { repo, clock, db } = setup();
    const id = jobIn(repo, clock, state);
    repo.archive([id]);
    expect(get(repo, id).archivedAt).not.toBeNull();
    clock.tick(5_000);
    const job = repo.applyTransition(id, event);
    return { repo, clock, db, id, job };
  }

  it.each([
    ['Retry', 'failed', { type: 'RETRY' }],
    ['Resume', 'cancelled', { type: 'RESUME' }],
    ['Release', 'held', { type: 'RELEASE' }],
    ['Release back to its place', 'held', { type: 'RELEASE', restorePlace: true }],
    ['Send notes', 'review', { type: 'SEND_NOTES' }],
    ['Approve', 'review', { type: 'APPROVE' }],
  ] as const)('%s on an archived %s job puts it back in the lists', (_action, state, event) => {
    const { repo, id, job } = archivedThen(state, event);

    expect(ARCHIVE_BLOCKED_STATES).toContain(job.state);
    expect(job.archivedAt).toBeNull();
    expect(get(repo, id).archivedAt).toBeNull();
    expect(repo.getAll().find((j) => j.id === id)?.archivedAt).toBeNull();
  });

  it('Release into arriving (the files changed a moment ago) leaves the archive too', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'held');
    repo.archive([id]);
    // The files change while the job is held and archived: it stays held, and archived.
    repo.upsertFromScan(makeScan('A', 'In held', { sizeBytes: 5 }));
    expect(get(repo, id)).toMatchObject({ state: 'held', archivedAt: expect.any(String) });

    const released = repo.applyTransition(id, { type: 'RELEASE' });

    expect(released.state).toBe('arriving');
    expect(released.archivedAt).toBeNull();
  });

  it('every other step of the run that follows leaves it out of the archive', () => {
    const { repo, clock, id } = archivedThen('failed', { type: 'RETRY' });
    for (const event of [
      { type: 'START' },
      { type: 'PROGRESS', step: 3, sub: null },
      { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
    ] satisfies JobEvent[]) {
      clock.tick();
      expect(repo.applyTransition(id, event).archivedAt, event.type).toBeNull();
    }
    expect(get(repo, id).state).toBe('review');
  });

  it('keeps the archive while the job stays ready, held or in review, whatever a rescan finds', () => {
    const { repo, clock } = setup();
    const names = ['Ready job', 'Held job', 'Review job'];
    const ids = [
      jobIn(repo, clock, 'ready', names[0]),
      jobIn(repo, clock, 'held', names[1]),
      jobIn(repo, clock, 'review', names[2]),
    ];
    repo.archive(ids);
    const dates = ids.map((id) => get(repo, id).archivedAt);
    clock.tick();

    // New files: a ready or review job ignores them, a held job only notes the change.
    for (const name of names) repo.upsertFromScan(makeScan('A', name, { sizeBytes: 7 }));

    expect(ids.map((id) => get(repo, id).state)).toEqual(['ready', 'held', 'review']);
    expect(ids.map((id) => get(repo, id).archivedAt)).toEqual(dates);
  });

  it('keeps the archive when a ready job turns out to have lost its export, or a review job its preview', () => {
    const { repo, clock } = setup();
    const ready = jobIn(repo, clock, 'ready', 'Ready job');
    const review = jobIn(repo, clock, 'review', 'Review job');
    repo.archive([ready, review]);
    clock.tick();

    repo.applyTransition(ready, { type: 'EXPORT_MISSING' });
    repo.applyTransition(review, { type: 'PREVIEW_MISSING' });

    expect(get(repo, ready)).toMatchObject({ state: 'failed' });
    expect(get(repo, review)).toMatchObject({ state: 'failed' });
    expect(get(repo, ready).archivedAt).not.toBeNull();
    expect(get(repo, review).archivedAt).not.toBeNull();
  });

  describe('a rescan', () => {
    /** A job that is archived in a state that cannot be archived, as an older engine could have left it. */
    function archivedWhileArriving() {
      const { repo, clock, db } = setup();
      const { job } = repo.upsertFromScan(makeScan());
      db.sqlite
        .prepare('update jobs set archived_at = ? where id = ?')
        .run(1_792_000_000_000, job.id);
      return { repo, clock, db, id: job.id };
    }

    it('with new files saves the job as arriving and out of the archive', () => {
      const { repo, clock, id } = archivedWhileArriving();
      clock.tick(5_000);

      const { job, outcome } = repo.upsertFromScan(
        makeScan(undefined, undefined, { sizeBytes: 5 }),
      );

      expect(outcome).toBe('updated');
      expect(job).toMatchObject({ id, state: 'arriving', archivedAt: null });
      expect(repo.get(id)?.archivedAt).toBeNull();
    });

    it('with another spelling of the folder saves it, and keeps the archive of a job that may have one', () => {
      const { repo, clock } = setup();
      const id = jobIn(repo, clock, 'ready', 'Caf\u00e9');
      repo.archive([id]);
      const archivedAt = get(repo, id).archivedAt;
      clock.tick(5_000);

      const { outcome } = repo.upsertFromScan(makeScan('A', 'Cafe\u0301', { id }));

      expect(outcome).toBe('updated');
      expect(get(repo, id).archivedAt).toBe(archivedAt);
    });

    it('a repeated scan of unchanged files writes nothing and keeps the archive', () => {
      const { repo, clock, db } = setup();
      const id = jobIn(repo, clock, 'ready');
      repo.archive([id]);
      const writes = totalChanges(db);

      const { outcome } = repo.upsertFromScan(makeScan('A', 'In ready'));

      expect(outcome).toBe('unchanged');
      expect(totalChanges(db)).toBe(writes);
      expect(get(repo, id).archivedAt).not.toBeNull();
    });
  });
});

describe('the one place a job leaves the archive', () => {
  it.each(JOB_STATES)('stores a %s job with an archive date only when it can have one', (state) => {
    const { repo, clock, db } = setup();
    jobIn(repo, clock, state);
    const row = db.orm.select().from(jobs).all()[0];
    if (row === undefined) throw new Error('no row');
    const stored = rowToStored(row);

    const dated = storedToColumns({ ...stored, archivedAt: '2026-10-21T08:00:00.000Z' });

    expect(dated.archivedAt === null).toBe(!canArchive({ state }));
    expect(storedToColumns(stored).archivedAt).toBeNull();
  });
});
