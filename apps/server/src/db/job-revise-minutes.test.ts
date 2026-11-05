import type { StepId } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { StepRunRepository } from './step-run-repository.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from './test-utils.js';

// C61: the Review footer says how long a round of notes takes, from this job's own earlier revise
// runs, so a job in Review carries `reviseMinutes` ({ min, max } in whole minutes, `null` with
// fewer than two such runs), read from `step_runs` whenever the job is read, and only while the
// Quick fixes switch is on (the `quickFixes` option of the repository).

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const MIN = 60_000;

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  return {
    clock,
    db,
    jobs: new JobRepository(db, { clock, quickFixes: true }),
    jobsOff: new JobRepository(db, { clock }),
    runs: new StepRunRepository(db, { clock }),
  };
}

type Harness = ReturnType<typeof setup>;

/** A job in Review, through real events. */
function jobInReview(h: Harness, name = 'Review'): string {
  const { job } = h.jobs.upsertFromScan(makeScan('A', name));
  for (const event of [
    { type: 'SETTLED' },
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ] as const) {
    h.clock.tick();
    h.jobs.applyTransition(job.id, event);
  }
  return job.id;
}

/** One revise run that took `minutes` from Plan to Check, with the two steps of it that get timed. */
function reviseRun(h: Harness, jobId: string, minutes: number): void {
  const steps: StepId[] = [4, 7];
  const share = minutes / steps.length;
  for (const step of steps) {
    h.runs.start(jobId, step, 'revise');
    h.clock.tick(share * MIN);
    h.runs.end(jobId, step);
  }
  // The wait in Review before the next Send.
  h.clock.tick(30 * MIN);
}

describe('Job.reviseMinutes', () => {
  it('is null for a job in Review with no revise run, and with only one', () => {
    const h = setup();
    const id = jobInReview(h);
    expect(h.jobs.get(id)?.reviseMinutes).toBeNull();

    reviseRun(h, id, 8);
    expect(h.jobs.get(id)?.reviseMinutes).toBeNull();
  });

  it('is the shortest to the longest of two or more revise runs, in whole minutes', () => {
    const h = setup();
    const id = jobInReview(h);
    reviseRun(h, id, 12);
    reviseRun(h, id, 40);
    reviseRun(h, id, 20);

    expect(h.jobs.get(id)?.reviseMinutes).toEqual({ min: 12, max: 40 });
    expect(h.jobs.getAll().find((job) => job.id === id)?.reviseMinutes).toEqual({
      min: 12,
      max: 40,
    });
  });

  it('leaves out the first edit and a render: only revise runs count', () => {
    const h = setup();
    const id = jobInReview(h);
    h.runs.start(id, 5, 'edit');
    h.clock.tick(90 * MIN);
    h.runs.end(id, 5);
    reviseRun(h, id, 6);
    h.runs.start(id, 8, 'render');
    h.clock.tick(20 * MIN);
    h.runs.end(id, 8);
    reviseRun(h, id, 9);

    expect(h.jobs.get(id)?.reviseMinutes).toEqual({ min: 6, max: 9 });
  });

  it('keeps the jobs apart', () => {
    const h = setup();
    const a = jobInReview(h, 'A');
    const b = jobInReview(h, 'B');
    reviseRun(h, a, 3);
    reviseRun(h, a, 5);
    reviseRun(h, b, 30);

    expect(h.jobs.get(a)?.reviseMinutes).toEqual({ min: 3, max: 5 });
    expect(h.jobs.get(b)?.reviseMinutes).toBeNull();
  });

  it('is null for a job that is not in Review', () => {
    const h = setup();
    const id = jobInReview(h);
    reviseRun(h, id, 4);
    reviseRun(h, id, 7);
    h.jobs.applyTransition(id, { type: 'SEND_NOTES' });

    expect(h.jobs.get(id)).toMatchObject({ state: 'queued', reviseMinutes: null });
  });

  it('is always null while the Quick fixes switch is off', () => {
    const h = setup();
    const id = jobInReview(h);
    reviseRun(h, id, 4);
    reviseRun(h, id, 7);

    expect(h.jobsOff.get(id)?.reviseMinutes).toBeNull();
    expect(h.jobsOff.getAll()[0]?.reviseMinutes).toBeNull();
  });

  it('does not move updatedAt: a revise run’s timing is not an update of the job', () => {
    const h = setup();
    const id = jobInReview(h);
    const before = h.jobs.get(id)?.updatedAt;
    reviseRun(h, id, 4);
    reviseRun(h, id, 7);

    expect(h.jobs.get(id)?.updatedAt).toBe(before);
  });
});

describe('StepRunRepository.reviseMinutes', () => {
  it('answers for no jobs with an empty map, and leaves out a job with fewer than two runs', () => {
    const h = setup();
    const id = jobInReview(h);
    reviseRun(h, id, 5);

    expect(h.runs.reviseMinutes([]).size).toBe(0);
    expect(h.runs.reviseMinutes([id]).size).toBe(0);
    expect(h.runs.reviseMinutes(['nobody']).size).toBe(0);
  });

  it('reads many jobs at once', () => {
    const h = setup();
    const a = jobInReview(h, 'A');
    const b = jobInReview(h, 'B');
    reviseRun(h, a, 2);
    reviseRun(h, a, 9);
    reviseRun(h, b, 14);
    reviseRun(h, b, 14);

    const ranges = h.runs.reviseMinutes([a, b]);
    expect(ranges.get(a)).toEqual({ min: 2, max: 9 });
    expect(ranges.get(b)).toEqual({ min: 14, max: 14 });
  });

  it('counts a run that began at Cut after a finished Check as a run of its own', () => {
    const h = setup();
    const id = jobInReview(h);
    reviseRun(h, id, 10);
    // The next round began at Cut, so the job sheet counts it with the round before it.
    h.runs.start(id, 5, 'revise');
    h.clock.tick(3 * MIN);
    h.runs.end(id, 5);
    h.runs.start(id, 7, 'revise');
    h.clock.tick(1 * MIN);
    h.runs.end(id, 7);

    expect(h.runs.reviseMinutes([id]).get(id)).toEqual({ min: 4, max: 10 });
  });
});
