import {
  firstStepOf,
  type JobStepRun,
  type ReviseMinutes,
  type RunKind,
  reviseMinutesOf,
  revisePassSeconds,
  type StepId,
} from '@studio/shared';
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { StudioDb } from './database.js';
import { toIso } from './mapping.js';
import { jobs, type StepRunRow, stepRuns } from './schema.js';

/** How long one finished run of a step took, and how much footage the job had. */
export interface StepDuration {
  jobId: string;
  durationSec: number;
  /** The job's footage when the step started; 0 if unknown. */
  footageSec: number;
}

/** One finished run of a kind, as the ETA fallback needs it (see pipeline/eta.ts). */
export interface FinishedRun {
  jobId: string;
  /**
   * Seconds the run's own timed steps took, added up. For revise, the job's revise steps over
   * its rounds, divided by the rounds. Waits between runs (Review, the queue, a failure waiting
   * for Retry) are not in it.
   */
  runSec: number;
  /** The job's footage when its first timed step of this kind started; 0 if unknown. */
  footageSec: number;
  /** The steps with a run of this kind, finished or left open. Every other step was skipped. */
  steps: StepId[];
}

/**
 * The review round each run belongs to, numbered like `Job.round` (the row's "round N", which
 * counts the rounds of notes sent): the first edit is round 0, the revise run that applies round
 * N's notes is round N, and the render that follows the approval of round N is round N too. The
 * table has no round column, so this reads it off the order the runs were written in (`rows`
 * oldest first, as `id` gives):
 *
 * - an `edit` run is round 0. Nothing is sent before the first edit ends in Review.
 * - SEND_NOTES makes the job's `round` one more and queues a revise run, which always begins at
 *   Plan, the first step of its kind (`firstStepOf('revise')`). So a revise run at Plan begins the
 *   next round, and so does the first revise run after an edit run, should its Plan row be missing.
 *   The rest of the round's steps (Cut, Preview, Check, and any step of a retry or a resume) stay
 *   in it: a retry or a resume carries on from the failed step and never starts again at Plan.
 * - APPROVE queues a render run, which begins at Render and does not change `round`, so a render
 *   run is the round that was last begun.
 *
 * The last round begun is therefore the job's `round` (a job in `queued` whose revise run has not
 * started yet is one ahead of its runs).
 */
export function roundsOfRuns(rows: readonly Pick<StepRunRow, 'step' | 'runKind'>[]): number[] {
  const revisePlan = firstStepOf('revise');
  let round = 0;
  let previous: RunKind | null = null;
  const rounds: number[] = [];
  for (const { step, runKind } of rows) {
    if (runKind === 'revise' && (step === revisePlan || previous !== 'revise')) round += 1;
    rounds.push(round);
    previous = runKind;
  }
  return rounds;
}

export interface StepRunRepositoryOptions {
  /** The clock for `startedAt` and `endedAt`. Tests pass a fake. */
  clock?: () => Date;
}

/**
 * Timings of the edit steps, written by the runner (E3/E4) and read by the ETA estimator (E5).
 * A run is one pass through one step of one job; a retried job has several runs of a step. Each
 * is stored under the kind of run that timed it (edit, revise or render), because the same step
 * is different work in each.
 */
export class StepRunRepository {
  private readonly db: StudioDb;
  private readonly clock: () => Date;

  constructor(db: StudioDb, { clock = () => new Date() }: StepRunRepositoryOptions = {}) {
    this.db = db;
    this.clock = clock;
  }

  /**
   * Starts timing `step` of the job, remembering the job's footage length and the kind of run
   * that times it. A run of the same step that was left open (the engine crashed mid-step) is
   * dropped: its length would be meaningless as a sample.
   */
  start(jobId: string, step: StepId, runKind: RunKind = 'edit'): void {
    const startedAt = this.clock().getTime();
    this.db.sqlite
      .transaction(() => {
        this.db.orm
          .delete(stepRuns)
          .where(and(eq(stepRuns.jobId, jobId), eq(stepRuns.step, step), isNull(stepRuns.endedAt)))
          .run();
        const job = this.db.orm
          .select({ footageSeconds: jobs.footageSeconds })
          .from(jobs)
          .where(eq(jobs.id, jobId))
          .get();
        this.db.orm
          .insert(stepRuns)
          .values({ jobId, step, startedAt, footageSeconds: job?.footageSeconds ?? 0, runKind })
          .run();
      })
      .immediate();
  }

  /** Stops timing the open run of `step`. Returns false when no run of it is open. */
  end(jobId: string, step: StepId): boolean {
    const endedAt = this.clock().getTime();
    const { changes } = this.db.orm
      .update(stepRuns)
      .set({ endedAt })
      .where(and(eq(stepRuns.jobId, jobId), eq(stepRuns.step, step), isNull(stepRuns.endedAt)))
      .run();
    return changes > 0;
  }

  /**
   * Every run of the job, oldest first (the order they were written in), with the review round
   * each belongs to (see {@link roundsOfRuns}). A run still open, or left open by a crash, a
   * failure or a cancel, has `endedAt: null`. A job that has not started, or that is unknown,
   * has none.
   */
  listForJob(jobId: string): JobStepRun[] {
    const rows = this.db.orm
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.jobId, jobId))
      .orderBy(asc(stepRuns.id))
      .all();
    const rounds = roundsOfRuns(rows);
    return rows.map((run, index) => ({
      step: run.step,
      runKind: run.runKind,
      round: rounds[index] ?? 0,
      startedAt: toIso(run.startedAt),
      endedAt: run.endedAt === null ? null : toIso(run.endedAt),
    }));
  }

  /**
   * Every run of every job, oldest first (the order they were written in), each with its job's id
   * and the review round it belongs to, numbered like {@link listForJob}. The Analytics page reads
   * it once for all its numbers; the runs of one job are in the same order, with the same rounds,
   * as `listForJob` gives.
   */
  listAll(): (JobStepRun & { jobId: string })[] {
    const rows = this.db.orm.select().from(stepRuns).orderBy(asc(stepRuns.id)).all();
    // The rounds are counted within one job's runs, so each job's rows are numbered on their own.
    const byJob = new Map<string, StepRunRow[]>();
    for (const row of rows) {
      const own = byJob.get(row.jobId);
      if (own === undefined) byJob.set(row.jobId, [row]);
      else own.push(row);
    }
    const rounds = new Map<number, number>();
    for (const own of byJob.values()) {
      const numbers = roundsOfRuns(own);
      own.forEach((row, index) => {
        rounds.set(row.id, numbers[index] ?? 0);
      });
    }
    return rows.map((run) => ({
      jobId: run.jobId,
      step: run.step,
      runKind: run.runKind,
      round: rounds.get(run.id) ?? 0,
      startedAt: toIso(run.startedAt),
      endedAt: run.endedAt === null ? null : toIso(run.endedAt),
    }));
  }

  /**
   * The range of the revise runs of each named job, for `Job.reviseMinutes` (C61): how long each
   * of its revise runs took from start to back in Review ({@link revisePassSeconds}), shortest to
   * longest in whole minutes. One read for all the jobs (the Jobs list asks for every job in Review
   * at once). A job with fewer than two such runs is left out of the map.
   */
  reviseMinutes(jobIds: readonly string[]): Map<string, ReviseMinutes> {
    const result = new Map<string, ReviseMinutes>();
    if (jobIds.length === 0) return result;
    const rows = this.db.orm
      .select()
      .from(stepRuns)
      .where(inArray(stepRuns.jobId, [...jobIds]))
      .orderBy(asc(stepRuns.id))
      .all();
    const byJob = new Map<string, StepRunRow[]>();
    for (const row of rows) {
      const own = byJob.get(row.jobId);
      if (own === undefined) byJob.set(row.jobId, [row]);
      else own.push(row);
    }
    for (const [jobId, own] of byJob) {
      const range = reviseMinutesOf(
        revisePassSeconds(
          own.map((run) => ({
            step: run.step,
            runKind: run.runKind,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
          })),
        ),
      );
      if (range !== null) result.set(jobId, range);
    }
    return result;
  }

  /**
   * When the open run of `step` started, or `null` when none is open (a job resumed or retried
   * mid-step is not timed from that step, see the worker). The ETA estimator (E5) reads it to
   * know how long the current step has been going.
   */
  openRunStartedAt(jobId: string, step: StepId): Date | null {
    const run = this.db.orm
      .select({ startedAt: stepRuns.startedAt })
      .from(stepRuns)
      .where(and(eq(stepRuns.jobId, jobId), eq(stepRuns.step, step), isNull(stepRuns.endedAt)))
      .orderBy(desc(stepRuns.id))
      .limit(1)
      .get();
    return run === undefined ? null : new Date(run.startedAt);
  }

  /**
   * The `limit` most recently finished runs of `step` by runs of `runKind`, newest first. Open
   * runs are skipped. The kind is required, so every caller says which: old rows are edit runs.
   */
  recentDurations(step: StepId, limit: number, runKind: RunKind): StepDuration[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`limit must be a positive whole number, got ${limit}`);
    }
    return this.db.orm
      .select()
      .from(stepRuns)
      .where(
        and(eq(stepRuns.step, step), eq(stepRuns.runKind, runKind), isNotNull(stepRuns.endedAt)),
      )
      .orderBy(desc(stepRuns.endedAt), desc(stepRuns.id))
      .limit(limit)
      .all()
      .map((run) => ({
        jobId: run.jobId,
        durationSec: Math.max(0, ((run.endedAt ?? run.startedAt) - run.startedAt) / 1000),
        footageSec: run.footageSeconds,
      }));
  }

  /**
   * The `limit` jobs that most recently became `ready` and have a finished run of `runKind`,
   * newest first, each with that run's own time and the steps it ran.
   *
   * A ready job is a finished edit, a finished set of revise rounds and a finished render at
   * once. That is why the whole-run time is the sum of the run's timed steps and not `finishedAt`
   * minus the first start, which would hold every hour spent in Review (Phase 3 §1). For revise
   * the sum is divided by the job's rounds (one revise run per round sent), so it is the average
   * round. Jobs with no finished run of the kind (made before timings existed, or seeded) are
   * left out, and so is a removed job: it has no row to say when it finished.
   */
  recentFinishedRuns(runKind: RunKind, limit: number): FinishedRun[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`limit must be a positive whole number, got ${limit}`);
    }
    const finished = this.db.orm
      .select({ id: jobs.id, finishedAt: jobs.finishedAt, round: jobs.round })
      .from(jobs)
      .where(
        and(
          eq(jobs.state, 'ready'),
          isNotNull(jobs.finishedAt),
          exists(
            this.db.orm
              .select({ id: stepRuns.id })
              .from(stepRuns)
              .where(
                and(
                  eq(stepRuns.jobId, jobs.id),
                  eq(stepRuns.runKind, runKind),
                  isNotNull(stepRuns.endedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(jobs.finishedAt), desc(jobs.id))
      .limit(limit)
      .all();
    if (finished.length === 0) return [];

    const runs = this.db.orm
      .select()
      .from(stepRuns)
      .where(
        and(
          eq(stepRuns.runKind, runKind),
          inArray(
            stepRuns.jobId,
            finished.map((job) => job.id),
          ),
        ),
      )
      .orderBy(asc(stepRuns.id))
      .all();

    return finished.flatMap(({ id, round }) => {
      const own = runs.filter((run) => run.jobId === id);
      const first = own[0];
      if (first === undefined) return [];
      const timedSec = own.reduce(
        (total, run) =>
          run.endedAt === null ? total : total + Math.max(0, (run.endedAt - run.startedAt) / 1000),
        0,
      );
      const rounds = runKind === 'revise' ? Math.max(1, round) : 1;
      return [
        {
          jobId: id,
          runSec: timedSec / rounds,
          footageSec: first.footageSeconds,
          steps: [...new Set(own.map((run) => run.step))].sort((a, b) => a - b),
        },
      ];
    });
  }
}
