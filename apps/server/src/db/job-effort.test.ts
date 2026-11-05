import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EFFORT_LEVELS,
  type Job,
  type JobEvent,
  type JobOutput,
  jobSchema,
  SETTLE_MS,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type StudioDb } from './database.js';
import { EffortNotEditableError, JobNotFoundError, JobRepository } from './job-repository.js';
import { fakeClock, makeScan, memoryDb, rawRow, SAMPLE_PREVIEW } from './test-utils.js';

// CVP-192: `setEffort` saves the effort level of a job's edit and revise runs while the job waits.

const OUTPUT: JobOutput = {
  fileName: 'Northwind Bakery/Spring menu.mp4',
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 65_011_712,
};

const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  return { clock, db, repo: new JobRepository(db, { clock }) };
}

type Clock = ReturnType<typeof fakeClock>;

/** Walks a new job to `state` through real events and returns its id. */
function jobIn(repo: JobRepository, clock: Clock, state: Job['state']): string {
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

describe('setEffort', () => {
  it('starts out on Default (null)', () => {
    const { repo } = setup();
    const { job } = repo.upsertFromScan(makeScan());
    expect(job.effort).toBeNull();
    expect(repo.getAll()[0]?.effort).toBeNull();
  });

  it.each(EFFORT_LEVELS)('stores %s, returns the job and bumps updatedAt', (level) => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'queued');
    const before = repo.get(id) as Job;
    clock.tick(5_000);

    const saved = repo.setEffort(id, level);

    expect(saved.effort).toBe(level);
    expect(saved.updatedAt).toBe(clock().toISOString());
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    expect(repo.get(id)).toEqual(saved);
    expect(repo.getAll().find((job) => job.id === id)?.effort).toBe(level);
    expect(jobSchema.parse(saved)).toEqual(saved);
  });

  it('null puts a job back on Default', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'held');
    repo.setEffort(id, 'xhigh');
    clock.tick();
    expect(repo.setEffort(id, null).effort).toBeNull();
    expect(repo.get(id)?.effort).toBeNull();
  });

  it('changes nothing but the effort and updatedAt', () => {
    const { repo, clock } = setup();
    const first = jobIn(repo, clock, 'queued');
    const arriving = jobIn(repo, clock, 'arriving');
    clock.tick(5_000);

    for (const id of [first, arriving]) {
      const before = repo.get(id) as Job;
      const saved = repo.setEffort(id, 'high');
      expect(saved).toEqual({ ...before, effort: 'high', updatedAt: clock().toISOString() });
    }
    // The queue and the settle timer are as they were.
    expect(repo.get(first)).toMatchObject({ state: 'queued', placeInLine: 1 });
    expect(repo.get(arriving)).toMatchObject({ state: 'arriving', settledAt: null });
  });

  it('leaves the note alone, and the note leaves the effort alone', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'queued');
    repo.setNote(id, 'Keep it short');
    expect(repo.setEffort(id, 'xhigh')).toMatchObject({ note: 'Keep it short', effort: 'xhigh' });
    clock.tick();
    expect(repo.setNote(id, 'Other')).toMatchObject({ note: 'Other', effort: 'xhigh' });
  });

  it.each([
    ['arriving', true],
    ['queued', true],
    ['held', true],
    ['editing', false],
    ['review', true],
    ['ready', false],
    ['failed', true],
    ['cancelled', true],
  ] as const)('in a %s job: allowed %s', (state, allowed) => {
    const { repo, clock, db } = setup();
    const id = jobIn(repo, clock, state);
    clock.tick();
    const rows = rawRow(db, 'jobs');

    if (allowed) {
      expect(repo.setEffort(id, 'xhigh').effort).toBe('xhigh');
      return;
    }
    expect(() => repo.setEffort(id, 'xhigh')).toThrow(EffortNotEditableError);
    expect(() => repo.setEffort(id, 'xhigh')).toThrow(
      `Cannot change the effort of a job that is ${state}.`,
    );
    expect(rawRow(db, 'jobs')).toEqual(rows);
  });

  it('carries the details of a refusal', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'editing');
    let caught: unknown;
    try {
      repo.setEffort(id, 'medium');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EffortNotEditableError);
    expect(caught).toMatchObject({ name: 'EffortNotEditableError', jobId: id, state: 'editing' });
  });

  it('refuses an unknown job with JobNotFoundError', () => {
    const { repo } = setup();
    expect(() => repo.setEffort('nosuchjob00', 'medium')).toThrow(JobNotFoundError);
  });

  it('stays through every later state change and restart, and is read back as saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-effort-'));
    dirs.push(dir);
    const path = join(dir, 'engine.db');
    const clock = fakeClock();
    const first = openDatabase(path);
    opened.push(first);
    const repo = new JobRepository(first, { clock });
    const { job } = repo.upsertFromScan(makeScan());
    repo.setEffort(job.id, 'high');

    for (const event of [
      { type: 'HOLD' },
      { type: 'RELEASE' },
      { type: 'START' },
      { type: 'PROGRESS', step: 3, sub: null },
      { type: 'FAIL', step: 3, error: 'boom' },
      { type: 'RETRY' },
    ] satisfies JobEvent[]) {
      clock.tick(SETTLE_MS);
      expect(repo.applyTransition(job.id, event).effort, event.type).toBe('high');
    }

    first.close();
    const second = openDatabase(path);
    opened.push(second);
    expect(new JobRepository(second, { clock }).get(job.id)?.effort).toBe('high');
  });
});

describe('setEffort in review (CVP-200)', () => {
  it('sets the level of a job in review, and Send notes keeps it for the fixes round', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'review');
    repo.setEffort(id, 'medium');
    clock.tick();

    const sent = repo.applyTransition(id, { type: 'SEND_NOTES' });

    expect(sent).toMatchObject({ state: 'queued', runKind: 'revise', round: 1, effort: 'medium' });
    // Still open while the fixes wait in the queue.
    clock.tick();
    expect(repo.setEffort(id, 'xhigh').effort).toBe('xhigh');
  });

  it('keeps the level through Approve, whose render run ignores it', () => {
    const { repo, clock } = setup();
    const id = jobIn(repo, clock, 'review');
    repo.setEffort(id, 'high');
    clock.tick();
    expect(repo.applyTransition(id, { type: 'APPROVE' })).toMatchObject({
      runKind: 'render',
      effort: 'high',
    });
  });
});
