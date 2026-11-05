import type { Job, JobEvent, JobOutput, JobStepRun, RunKind, StepId } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { StepRunRepository } from './step-run-repository.js';
import { fakeClock, makeScan, memoryDb, rawRow, SAMPLE_PREVIEW } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/** `review` is the Review switch: on, only a render run may end ready. */
function setup({ review = false } = {}) {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  return {
    clock,
    db,
    jobs: new JobRepository(db, { clock, review }),
    runs: new StepRunRepository(db, { clock }),
  };
}

describe('StepRunRepository', () => {
  it('times a step from start to end', () => {
    const { runs, clock } = setup();

    runs.start('job-a', 1);
    clock.tick(42_500);
    expect(runs.end('job-a', 1)).toBe(true);

    expect(runs.recentDurations(1, 10, 'edit')).toEqual([
      { jobId: 'job-a', durationSec: 42.5, footageSec: 0 },
    ]);
  });

  it("remembers the job's footage length at the start of the step", () => {
    const { runs, jobs, clock } = setup();
    const { job } = jobs.upsertFromScan(makeScan('A', 'B', { footageSec: 540.5 }));

    runs.start(job.id, 2);
    clock.tick(10_000);
    // The footage changing later does not rewrite the sample.
    jobs.upsertFromScan(
      makeScan('A', 'B', { footageSec: 900, inputs: { video: 20, audio: 0, image: 0, doc: 0 } }),
    );
    runs.end(job.id, 2);

    expect(runs.recentDurations(2, 10, 'edit')).toEqual([
      { jobId: job.id, durationSec: 10, footageSec: 540.5 },
    ]);
  });

  it('lists the most recently finished runs first and stops at the limit', () => {
    const { runs, clock } = setup();
    for (const [job, seconds] of [
      ['a', 10],
      ['b', 20],
      ['c', 30],
    ] as const) {
      runs.start(job, 3);
      clock.tick(seconds * 1000);
      runs.end(job, 3);
    }

    expect(runs.recentDurations(3, 10, 'edit').map((r) => r.jobId)).toEqual(['c', 'b', 'a']);
    expect(runs.recentDurations(3, 2, 'edit').map((r) => [r.jobId, r.durationSec])).toEqual([
      ['c', 30],
      ['b', 20],
    ]);
    expect(runs.recentDurations(3, 1, 'edit')).toHaveLength(1);
  });

  it('orders by when a run finished, not when it started', () => {
    const { runs, clock } = setup();
    runs.start('slow', 4);
    clock.tick(1_000);
    runs.start('fast', 4);
    clock.tick(1_000);
    runs.end('fast', 4);
    clock.tick(1_000);
    runs.end('slow', 4);

    expect(runs.recentDurations(4, 10, 'edit').map((r) => r.jobId)).toEqual(['slow', 'fast']);
  });

  it('keeps the steps apart', () => {
    const { runs, clock } = setup();
    runs.start('a', 1);
    clock.tick(1_000);
    runs.end('a', 1);
    runs.start('a', 2);
    clock.tick(5_000);
    runs.end('a', 2);

    expect(runs.recentDurations(1, 10, 'edit').map((r) => r.durationSec)).toEqual([1]);
    expect(runs.recentDurations(2, 10, 'edit').map((r) => r.durationSec)).toEqual([5]);
    expect(runs.recentDurations(3, 10, 'edit')).toEqual([]);
  });

  it('skips runs that are still going', () => {
    const { runs, clock } = setup();
    runs.start('done', 5);
    clock.tick(2_000);
    runs.end('done', 5);
    runs.start('running', 5);

    expect(runs.recentDurations(5, 10, 'edit').map((r) => r.jobId)).toEqual(['done']);
  });

  it('keeps every run of a retried job', () => {
    const { runs, clock } = setup();
    for (const seconds of [8, 12]) {
      runs.start('a', 6);
      clock.tick(seconds * 1000);
      runs.end('a', 6);
    }

    expect(runs.recentDurations(6, 10, 'edit').map((r) => r.durationSec)).toEqual([12, 8]);
  });

  it('ends nothing when no run of that step is open', () => {
    const { runs, db } = setup();
    expect(runs.end('a', 1)).toBe(false);

    runs.start('a', 1);
    expect(runs.end('a', 2)).toBe(false);
    expect(runs.end('b', 1)).toBe(false);
    expect(runs.end('a', 1)).toBe(true);
    expect(runs.end('a', 1)).toBe(false);
    expect(rawRow(db, 'step_runs')).toHaveLength(1);
  });

  it('drops a run left open by a crash when the step starts again', () => {
    const { runs, clock, db } = setup();
    runs.start('a', 3);
    clock.tick(500_000);

    // The engine restarted and the step begins again: the old, never-ended run is not a sample.
    runs.start('a', 3);
    clock.tick(7_000);
    runs.end('a', 3);

    expect(rawRow(db, 'step_runs')).toHaveLength(1);
    expect(runs.recentDurations(3, 10, 'edit')).toEqual([
      { jobId: 'a', durationSec: 7, footageSec: 0 },
    ]);
  });

  it('says when the open run of a step started, and null when none is open', () => {
    const { runs, clock } = setup();
    expect(runs.openRunStartedAt('a', 2)).toBeNull();

    const startedAt = clock();
    runs.start('a', 2);
    clock.tick(4_000);
    expect(runs.openRunStartedAt('a', 2)).toEqual(startedAt);
    // Another step or another job has no open run.
    expect(runs.openRunStartedAt('a', 3)).toBeNull();
    expect(runs.openRunStartedAt('b', 2)).toBeNull();

    runs.end('a', 2);
    expect(runs.openRunStartedAt('a', 2)).toBeNull();
  });

  it("keeps a removed job's timings for the ETA", () => {
    const { runs, jobs, clock } = setup();
    const { job } = jobs.upsertFromScan(makeScan());
    runs.start(job.id, 1);
    clock.tick(3_000);
    runs.end(job.id, 1);

    jobs.remove(job.id);

    expect(runs.recentDurations(1, 10, 'edit')).toHaveLength(1);
  });

  it('writes the kind of run, edit unless told otherwise', () => {
    const { runs, clock, db } = setup();
    runs.start('a', 1);
    runs.start('a', 4, 'revise');
    runs.start('a', 8, 'render');
    clock.tick(1_000);

    const rows = db.sqlite.prepare('select step, run_kind from step_runs order by step').all() as {
      step: number;
      run_kind: string;
    }[];
    expect(rows.map((row) => [row.step, row.run_kind])).toEqual([
      [1, 'edit'],
      [4, 'revise'],
      [8, 'render'],
    ]);
  });

  it('keeps the kinds of run apart when it lists the durations of a step', () => {
    const { runs, clock } = setup();
    for (const [job, kind, seconds] of [
      ['e1', 'edit', 10],
      ['r1', 'revise', 20],
      ['e2', 'edit', 30],
      ['r2', 'revise', 40],
    ] as const) {
      runs.start(job, 5, kind);
      clock.tick(seconds * 1000);
      runs.end(job, 5);
    }

    expect(runs.recentDurations(5, 10, 'edit').map((r) => r.jobId)).toEqual(['e2', 'e1']);
    expect(runs.recentDurations(5, 10, 'revise').map((r) => r.jobId)).toEqual(['r2', 'r1']);
    expect(runs.recentDurations(5, 10, 'render')).toEqual([]);
  });

  it('reads a row written before run kinds existed as an edit run', () => {
    const { runs, db, clock } = setup();
    db.sqlite
      .prepare(
        'insert into step_runs (job_id, step, started_at, ended_at, footage_seconds) values (?, ?, ?, ?, ?)',
      )
      .run('old', 3, clock().getTime(), clock().getTime() + 9_000, 60);

    expect(runs.recentDurations(3, 10, 'edit')).toEqual([
      { jobId: 'old', durationSec: 9, footageSec: 60 },
    ]);
    expect(runs.recentDurations(3, 10, 'revise')).toEqual([]);
  });

  it('rejects a limit that is not a positive whole number', () => {
    const { runs } = setup();
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => runs.recentDurations(1, limit, 'edit'), String(limit)).toThrow(RangeError);
    }
  });
});

describe('StepRunRepository.recentFinishedRuns', () => {
  const OUTPUT: JobOutput = {
    fileName: 'Past/Job.mp4',
    durationSec: 30,
    width: 1920,
    height: 1080,
    sizeBytes: 1_000_000,
  };

  /** A job that edits through `steps` (each 10 s, a step in `left` is left open) and ends ready. */
  function readyJob(
    ctx: ReturnType<typeof setup>,
    name: string,
    steps: readonly StepId[],
    { footageSec = 300, left = [] as readonly StepId[], pauseSec = 0 } = {},
  ) {
    const { job } = ctx.jobs.upsertFromScan(makeScan('Past', name, { footageSec }));
    ctx.jobs.applyTransition(job.id, { type: 'SETTLED' });
    ctx.jobs.applyTransition(job.id, { type: 'START' });
    for (const step of steps) {
      ctx.runs.start(job.id, step);
      ctx.clock.tick(10_000);
      if (!left.includes(step)) ctx.runs.end(job.id, step);
    }
    ctx.clock.tick(pauseSec * 1000);
    ctx.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });
    ctx.clock.tick(1_000);
    return job.id;
  }

  it('gives the run time, the footage and the steps that ran, newest job first', () => {
    const ctx = setup();
    const a = readyJob(ctx, 'A', [1, 2, 3], { footageSec: 120 });
    const b = readyJob(ctx, 'B', [1, 2, 3, 4], { footageSec: 600 });

    expect(ctx.runs.recentFinishedRuns('edit', 10)).toEqual([
      { jobId: b, runSec: 40, footageSec: 600, steps: [1, 2, 3, 4] },
      { jobId: a, runSec: 30, footageSec: 120, steps: [1, 2, 3] },
    ]);
    expect(ctx.runs.recentFinishedRuns('edit', 1).map((run) => run.jobId)).toEqual([b]);
  });

  it('counts a step that was left open as run but not its time, and a step with no row as skipped', () => {
    const ctx = setup();
    // Cut was interrupted by a restart and never closed; Check was skipped by the editor.
    const id = readyJob(ctx, 'A', [1, 2, 3, 4, 5, 7], { left: [4] });

    expect(ctx.runs.recentFinishedRuns('edit', 10)).toEqual([
      { jobId: id, runSec: 50, footageSec: 300, steps: [1, 2, 3, 4, 5, 7] },
    ]);
  });

  it('leaves the pauses out: a failed edit that waited an hour for its retry counts 20 s', () => {
    const ctx = setup();
    const id = readyJob(ctx, 'A', [1, 2], { pauseSec: 3_600 });

    expect(ctx.runs.recentFinishedRuns('edit', 10)).toEqual([
      { jobId: id, runSec: 20, footageSec: 300, steps: [1, 2] },
    ]);
  });

  it('lists a retried job once, with the time of every finished run of its steps', () => {
    const ctx = setup();
    const id = readyJob(ctx, 'A', [1, 2, 3]);
    ctx.runs.start(id, 3);
    ctx.clock.tick(5_000);
    ctx.runs.end(id, 3);

    expect(
      ctx.runs.recentFinishedRuns('edit', 10).map((run) => [run.jobId, run.runSec, run.steps]),
    ).toEqual([[id, 35, [1, 2, 3]]]);
  });

  it('leaves out jobs that did not end ready, have no timed step, or were removed', () => {
    const ctx = setup();
    const kept = readyJob(ctx, 'Kept', [1, 2]);

    // Still editing.
    const editing = ctx.jobs.upsertFromScan(makeScan('Past', 'Editing')).job;
    ctx.jobs.applyTransition(editing.id, { type: 'SETTLED' });
    ctx.jobs.applyTransition(editing.id, { type: 'START' });
    ctx.runs.start(editing.id, 1);

    // Ready, but nothing was timed (an edit from before timings existed).
    const untimed = ctx.jobs.upsertFromScan(makeScan('Past', 'Untimed')).job;
    ctx.jobs.applyTransition(untimed.id, { type: 'SETTLED' });
    ctx.jobs.applyTransition(untimed.id, { type: 'START' });
    ctx.jobs.applyTransition(untimed.id, { type: 'SUCCEED', output: OUTPUT });

    // Ready, then removed: its timings stay for the per-step rates, but it is no longer an edit.
    const removed = readyJob(ctx, 'Removed', [1, 2]);
    ctx.jobs.remove(removed);

    expect(ctx.runs.recentFinishedRuns('edit', 10).map((run) => run.jobId)).toEqual([kept]);
  });

  it('leaves out a job whose only runs of the kind are still open', () => {
    const ctx = setup();
    // Every step of the edit was left open (interrupted): nothing finished to count.
    readyJob(ctx, 'Open', [1, 2], { left: [1, 2] });

    expect(ctx.runs.recentFinishedRuns('edit', 10)).toEqual([]);
  });

  it('is empty without finished jobs, and for a kind that never ran', () => {
    expect(setup().runs.recentFinishedRuns('edit', 10)).toEqual([]);

    const ctx = setup();
    readyJob(ctx, 'A', [1, 2, 3]);
    expect(ctx.runs.recentFinishedRuns('revise', 10)).toEqual([]);
    expect(ctx.runs.recentFinishedRuns('render', 10)).toEqual([]);
  });

  it('rejects a limit that is not a positive whole number', () => {
    const { runs } = setup();
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => runs.recentFinishedRuns('edit', limit), String(limit)).toThrow(RangeError);
    }
  });

  // Phase 3 §1: a ready job is a finished edit, a finished set of revise rounds and a finished
  // render at once. Each is timed by its own steps, so the hours spent in Review are in none.
  describe('a job that went through Review', () => {
    function timeSteps(
      ctx: ReturnType<typeof setup>,
      id: string,
      kind: RunKind,
      steps: readonly StepId[],
      seconds: number,
    ) {
      for (const step of steps) {
        ctx.runs.start(id, step, kind);
        ctx.clock.tick(seconds * 1000);
        ctx.runs.end(id, step);
      }
    }

    /** Edit (steps 1-7, 10 s each), 5 h in Review, two revise rounds, then Approve and render. */
    function reviewedJob(ctx: ReturnType<typeof setup>, name: string) {
      const { job } = ctx.jobs.upsertFromScan(makeScan('Past', name, { footageSec: 300 }));
      const id = job.id;
      const apply = (...events: JobEvent[]) => {
        for (const event of events) {
          ctx.clock.tick(1_000);
          ctx.jobs.applyTransition(id, event);
        }
      };
      const preview: JobEvent = { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW };
      apply({ type: 'SETTLED' }, { type: 'START' });
      timeSteps(ctx, id, 'edit', [1, 2, 3, 4, 5, 6, 7], 10);
      apply(preview);
      ctx.clock.tick(5 * 3_600_000);
      apply({ type: 'SEND_NOTES' }, { type: 'START' });
      timeSteps(ctx, id, 'revise', [4, 5, 6, 7], 10);
      apply(preview);
      ctx.clock.tick(2 * 3_600_000);
      apply({ type: 'SEND_NOTES' }, { type: 'START' });
      timeSteps(ctx, id, 'revise', [4, 5, 6, 7], 20);
      apply(preview);
      ctx.clock.tick(3_600_000);
      apply({ type: 'APPROVE' }, { type: 'START' });
      timeSteps(ctx, id, 'render', [8], 25);
      apply({ type: 'SUCCEED', output: OUTPUT });
      return id;
    }

    it('times each kind by its own steps: no hours in Review, and a revise run is the average round', () => {
      const ctx = setup({ review: true });
      const id = reviewedJob(ctx, 'Looped');

      expect(ctx.jobs.get(id)).toMatchObject({ state: 'ready', round: 2, runKind: 'render' });
      expect(ctx.runs.recentFinishedRuns('edit', 10)).toEqual([
        { jobId: id, runSec: 70, footageSec: 300, steps: [1, 2, 3, 4, 5, 6, 7] },
      ]);
      // Rounds of 40 s and 80 s: 120 s over 2 rounds.
      expect(ctx.runs.recentFinishedRuns('revise', 10)).toEqual([
        { jobId: id, runSec: 60, footageSec: 300, steps: [4, 5, 6, 7] },
      ]);
      expect(ctx.runs.recentFinishedRuns('render', 10)).toEqual([
        { jobId: id, runSec: 25, footageSec: 300, steps: [8] },
      ]);
    });

    it('lists a job for the kinds it ran and leaves it out of the others (no notes, no revise run)', () => {
      const ctx = setup({ review: true });
      const looped = reviewedJob(ctx, 'Looped');
      const plain = readyJobWithoutReview(ctx);

      expect(ctx.runs.recentFinishedRuns('edit', 10).map((run) => run.jobId)).toEqual([
        plain,
        looped,
      ]);
      expect(ctx.runs.recentFinishedRuns('revise', 10).map((run) => run.jobId)).toEqual([looped]);
      expect(ctx.runs.recentFinishedRuns('render', 10).map((run) => run.jobId)).toEqual([
        plain,
        looped,
      ]);
    });

    it('leaves out a job whose render run is still open', () => {
      const ctx = setup({ review: true });
      const { job } = ctx.jobs.upsertFromScan(makeScan('Past', 'Open render'));
      const events: JobEvent[] = [
        { type: 'SETTLED' },
        { type: 'START' },
        { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
        { type: 'APPROVE' },
        { type: 'START' },
      ];
      for (const event of events) ctx.jobs.applyTransition(job.id, event);
      ctx.runs.start(job.id, 8, 'render'); // never ended
      ctx.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });

      expect(ctx.runs.recentFinishedRuns('render', 10)).toEqual([]);
    });

    /** A job that was edited and approved without notes: no revise run. */
    function readyJobWithoutReview(ctx: ReturnType<typeof setup>) {
      const { job } = ctx.jobs.upsertFromScan(makeScan('Past', 'Plain', { footageSec: 300 }));
      const preview: JobEvent = { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW };
      for (const event of [{ type: 'SETTLED' }, { type: 'START' }] as JobEvent[]) {
        ctx.clock.tick(1_000);
        ctx.jobs.applyTransition(job.id, event);
      }
      timeSteps(ctx, job.id, 'edit', [1, 2, 3], 10);
      for (const event of [preview, { type: 'APPROVE' }, { type: 'START' }] as JobEvent[]) {
        ctx.clock.tick(1_000);
        ctx.jobs.applyTransition(job.id, event);
      }
      timeSteps(ctx, job.id, 'render', [8], 5);
      ctx.clock.tick(1_000);
      ctx.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });
      return job.id;
    }
  });
});

describe('StepRunRepository.listForJob', () => {
  const PREVIEW: JobEvent = { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW };
  const OUTPUT: JobOutput = {
    fileName: 'Past/Job.mp4',
    durationSec: 30,
    width: 1920,
    height: 1080,
    sizeBytes: 1_000_000,
  };

  /** Plays what the worker does: the job's transitions and the timing of its steps. */
  function player(ctx: ReturnType<typeof setup>, name = 'Spring menu') {
    const { job } = ctx.jobs.upsertFromScan(makeScan('Past', name, { footageSec: 300 }));
    const id = job.id;
    return {
      id,
      apply(...events: JobEvent[]) {
        for (const event of events) {
          ctx.clock.tick(1_000);
          ctx.jobs.applyTransition(id, event);
        }
      },
      /** Times each step for 10 s, in `kind`. A step in `open` is never ended (a failure or a crash). */
      time(kind: RunKind, steps: readonly StepId[], open: readonly StepId[] = []) {
        for (const step of steps) {
          ctx.runs.start(id, step, kind);
          ctx.clock.tick(10_000);
          if (!open.includes(step)) ctx.runs.end(id, step);
        }
      },
      round: () => (ctx.jobs.get(id) as Job).round,
    };
  }

  const summary = (runs: JobStepRun[]) =>
    runs.map((run) => `${run.runKind}:${run.step}:r${run.round}`);

  it('is empty for a job that has not started and for one nobody knows', () => {
    const ctx = setup();
    const { id } = player(ctx);

    expect(ctx.runs.listForJob(id)).toEqual([]);
    expect(ctx.runs.listForJob('nobody')).toEqual([]);
  });

  it('lists the runs oldest first with ISO times, and an open run has no end', () => {
    const ctx = setup();
    const job = player(ctx);
    job.apply({ type: 'SETTLED' }, { type: 'START' });
    ctx.clock.tick(1_000);
    ctx.runs.start(job.id, 1);
    ctx.clock.tick(30_000);
    ctx.runs.end(job.id, 1);
    ctx.runs.start(job.id, 2);
    ctx.clock.tick(5_000);

    expect(ctx.runs.listForJob(job.id)).toEqual([
      {
        step: 1,
        runKind: 'edit',
        round: 0,
        startedAt: '2026-10-20T10:00:03.000Z',
        endedAt: '2026-10-20T10:00:33.000Z',
      },
      {
        step: 2,
        runKind: 'edit',
        round: 0,
        startedAt: '2026-10-20T10:00:33.000Z',
        endedAt: null,
      },
    ]);
  });

  it('keeps every run of a retried step, in the order they were written', () => {
    const ctx = setup();
    const job = player(ctx);
    job.time('edit', [3]);
    job.time('edit', [3]);
    job.time('edit', [4]);

    const runs = ctx.runs.listForJob(job.id);

    expect(runs.map((run) => run.step)).toEqual([3, 3, 4]);
    expect(runs.map((run) => run.startedAt)).toEqual([...runs.map((run) => run.startedAt)].sort());
  });

  it("leaves other jobs' runs out", () => {
    const ctx = setup();
    const a = player(ctx, 'A');
    const b = player(ctx, 'B');
    a.time('edit', [1, 2]);
    b.time('edit', [1]);

    expect(ctx.runs.listForJob(a.id)).toHaveLength(2);
    expect(ctx.runs.listForJob(b.id)).toHaveLength(1);
  });

  it('numbers the rounds like Job.round: an edit, two revise rounds and a render', () => {
    const ctx = setup({ review: true });
    const job = player(ctx);
    job.apply({ type: 'SETTLED' }, { type: 'START' });
    job.time('edit', [1, 2, 3, 4, 5, 6, 7]);
    job.apply(PREVIEW);
    expect(job.round()).toBe(0);

    ctx.clock.tick(3_600_000);
    job.apply({ type: 'SEND_NOTES' }, { type: 'START' });
    expect(job.round()).toBe(1);
    job.time('revise', [4, 5, 6, 7]);
    job.apply(PREVIEW);

    ctx.clock.tick(3_600_000);
    job.apply({ type: 'SEND_NOTES' }, { type: 'START' });
    expect(job.round()).toBe(2);
    job.time('revise', [4, 5, 6, 7]);
    job.apply(PREVIEW);

    ctx.clock.tick(3_600_000);
    job.apply({ type: 'APPROVE' }, { type: 'START' });
    job.time('render', [8]);
    job.apply({ type: 'SUCCEED', output: OUTPUT });

    const runs = ctx.runs.listForJob(job.id);
    expect(summary(runs)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7].map((step) => `edit:${step}:r0`),
      ...[4, 5, 6, 7].map((step) => `revise:${step}:r1`),
      ...[4, 5, 6, 7].map((step) => `revise:${step}:r2`),
      'render:8:r2',
    ]);
    // The last round of the runs is the job's.
    expect(Math.max(...runs.map((run) => run.round))).toBe(job.round());
    expect(ctx.jobs.get(job.id)).toMatchObject({ state: 'ready', round: 2, runKind: 'render' });
  });

  it('keeps a round together through a failure and a retry (the step left open stays in it)', () => {
    const ctx = setup({ review: true });
    const job = player(ctx);
    job.apply({ type: 'SETTLED' }, { type: 'START' });
    job.time('edit', [1, 2, 3, 4, 5, 6, 7]);
    job.apply(PREVIEW, { type: 'SEND_NOTES' }, { type: 'START' });
    // Round 1 fails at Preview: its step is left open, and the retry carries on from there
    // without timing it, then times the steps after it.
    job.time('revise', [4, 5, 6], [6]);
    job.apply({ type: 'FAIL', step: 6, error: 'The preview did not build.' });
    job.apply({ type: 'RETRY' }, { type: 'START' });
    job.time('revise', [7]);
    job.apply(PREVIEW, { type: 'SEND_NOTES' }, { type: 'START' });
    job.time('revise', [4, 5]);

    const runs = ctx.runs.listForJob(job.id);

    expect(summary(runs).slice(7)).toEqual([
      'revise:4:r1',
      'revise:5:r1',
      'revise:6:r1',
      'revise:7:r1',
      'revise:4:r2',
      'revise:5:r2',
    ]);
    expect(runs[9]?.endedAt).toBeNull();
    expect(Math.max(...runs.map((run) => run.round))).toBe(job.round());
  });

  it('puts a render of a job that was approved without notes in round 0', () => {
    const ctx = setup({ review: true });
    const job = player(ctx);
    job.apply({ type: 'SETTLED' }, { type: 'START' });
    job.time('edit', [1, 2, 3]);
    job.apply(PREVIEW, { type: 'APPROVE' }, { type: 'START' });
    job.time('render', [8]);

    expect(summary(ctx.runs.listForJob(job.id))).toEqual([
      'edit:1:r0',
      'edit:2:r0',
      'edit:3:r0',
      'render:8:r0',
    ]);
    expect(job.round()).toBe(0);
  });

  it('counts a round whose revise run is still going, and one whose Plan row is missing', () => {
    const ctx = setup({ review: true });
    const job = player(ctx);
    job.apply({ type: 'SETTLED' }, { type: 'START' });
    job.time('edit', [1, 2, 3]);
    job.apply(PREVIEW, { type: 'SEND_NOTES' }, { type: 'START' });
    // A revise run that began after Plan (no row for it): the first revise run is round 1.
    job.time('revise', [5], [5]);

    expect(summary(ctx.runs.listForJob(job.id)).slice(3)).toEqual(['revise:5:r1']);
    expect(ctx.runs.listForJob(job.id)[3]?.endedAt).toBeNull();
  });

  it('reads a row written before run kinds existed as an edit run of round 0', () => {
    const ctx = setup();
    ctx.db.sqlite
      .prepare(
        'insert into step_runs (job_id, step, started_at, ended_at, footage_seconds) values (?, ?, ?, ?, ?)',
      )
      .run('old', 3, ctx.clock().getTime(), ctx.clock().getTime() + 9_000, 60);

    expect(ctx.runs.listForJob('old')).toEqual([
      {
        step: 3,
        runKind: 'edit',
        round: 0,
        startedAt: '2026-10-20T10:00:00.000Z',
        endedAt: '2026-10-20T10:00:09.000Z',
      },
    ]);
  });
});

describe('StepRunRepository.listAll', () => {
  const PREVIEW: JobEvent = { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW };

  function newJob(ctx: ReturnType<typeof setup>, name: string) {
    return ctx.jobs.upsertFromScan(makeScan('Past', name, { footageSec: 300 })).job.id;
  }

  function time(ctx: ReturnType<typeof setup>, id: string, kind: RunKind, steps: StepId[]) {
    for (const step of steps) {
      ctx.runs.start(id, step, kind);
      ctx.clock.tick(10_000);
      ctx.runs.end(id, step);
    }
  }

  it('is empty when nothing has been timed', () => {
    const ctx = setup();
    newJob(ctx, 'A');

    expect(ctx.runs.listAll()).toEqual([]);
  });

  it('lists the runs of every job in the order they were written, each with its job id', () => {
    const ctx = setup();
    const a = newJob(ctx, 'A');
    const b = newJob(ctx, 'B');
    ctx.clock.tick(1_000);
    time(ctx, a, 'edit', [1]);
    time(ctx, b, 'edit', [1]);
    time(ctx, a, 'edit', [2]);

    const runs = ctx.runs.listAll();

    expect(runs.map((run) => [run.jobId, run.step])).toEqual([
      [a, 1],
      [b, 1],
      [a, 2],
    ]);
    expect(runs[0]).toEqual({
      jobId: a,
      step: 1,
      runKind: 'edit',
      round: 0,
      startedAt: '2026-10-20T10:00:01.000Z',
      endedAt: '2026-10-20T10:00:11.000Z',
    });
  });

  it('gives each run what listForJob gives it, with the job id added', () => {
    const ctx = setup({ review: true });
    const a = newJob(ctx, 'A');
    const b = newJob(ctx, 'B');
    for (const id of [a, b]) {
      ctx.jobs.applyTransition(id, { type: 'SETTLED' });
      ctx.jobs.applyTransition(id, { type: 'START' });
    }
    // Interleaved, so a job's rounds are not in one block of the table.
    time(ctx, a, 'edit', [1, 2, 3, 4, 5, 6, 7]);
    time(ctx, b, 'edit', [1, 2, 3, 4, 5, 6, 7]);
    ctx.jobs.applyTransition(a, PREVIEW);
    ctx.jobs.applyTransition(a, { type: 'SEND_NOTES' });
    ctx.jobs.applyTransition(a, { type: 'START' });
    time(ctx, a, 'revise', [4, 5, 6, 7]);
    ctx.jobs.applyTransition(b, PREVIEW);
    ctx.jobs.applyTransition(b, { type: 'APPROVE' });
    ctx.jobs.applyTransition(b, { type: 'START' });
    time(ctx, b, 'render', [8]);

    const all = ctx.runs.listAll();

    for (const id of [a, b]) {
      const own = all.filter((run) => run.jobId === id).map(({ jobId: _jobId, ...run }) => run);
      expect(own).toEqual(ctx.runs.listForJob(id));
    }
    expect(all.filter((run) => run.jobId === a).map((run) => run.round)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
    ]);
    expect(all.filter((run) => run.jobId === b).map((run) => run.round)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("keeps a removed job's runs and a run that is still open", () => {
    const ctx = setup();
    const a = newJob(ctx, 'A');
    time(ctx, a, 'edit', [1]);
    ctx.runs.start(a, 2);
    ctx.db.sqlite
      .prepare(
        'insert into step_runs (job_id, step, started_at, ended_at, footage_seconds) values (?, ?, ?, ?, ?)',
      )
      .run('gone', 3, ctx.clock().getTime(), ctx.clock().getTime() + 9_000, 60);

    const runs = ctx.runs.listAll();

    expect(runs.map((run) => [run.jobId, run.step, run.endedAt === null])).toEqual([
      [a, 1, false],
      [a, 2, true],
      ['gone', 3, false],
    ]);
  });
});
