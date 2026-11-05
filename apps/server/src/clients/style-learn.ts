// When a Learn pass runs (Phase 2 plan §5, C10): a client's style is written from a finished job.
//
//   a job reaches ready (with the Review switch on: after Approve and its render run; a preview in
//   Review never does)
//       ─▶ a Learn pass from that job: `create` while its client has no style.md, `merge` (the
//          job's look added to the current style) once it has one (`createLearnOnReady`, the queue
//          worker's `afterReady`)
//   the edit worker is about to start a job of a client whose Learn pass is queued or running
//       ─▶ it waits for that pass first, so the job's Brief step copies the style it writes; a job
//          of another client starts at once, beside the Learn (`createLearnWait`, the queue
//          worker's `beforeStart`)
//   Use this look (POST /api/jobs/:jobId/use-look)
//       ─▶ a Learn pass (replace) from that job (`learnPassFor`, routes/job-style.ts)
//   the first start after this update, while `client_styles` is empty
//       ─▶ a Learn pass (create) from the newest ready job of every client without a style.md
//          (`backfillStyles`)
//
// The passes go through the style worker like every other style run: the client is analysing
// meanwhile, and a failed Learn only sets the client's style to failed. The job is never touched:
// it stays ready whatever the run does.
//
// An episode of a series (a job with a `seriesId`) never queues a Learn pass, from either of the
// two: its look is the series', not something to merge into the client's style (Series plan §1).
// Use this look still works on it, since the owner asks for that one. Instead, an episode that reaches
// ready is handed to its series (`SeriesService.approved`): when review notes marked Series wait
// for it, it becomes the series' format (C26).

import { stat } from 'node:fs/promises';
import type { Job } from '@studio/shared';
import type { JobRepository } from '../db/index.js';
import { clientIdFor } from '../inbox/scan.js';
import type { RunnerLogger } from '../pipeline/claude-process.js';
import { styleFileFor } from './paths.js';
import type { SeriesService } from './series-service.js';
import type { LearnMode, LearnPass } from './style-pass.js';
import type { StyleWorker } from './style-worker.js';

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The Learn pass that writes the style of `job`. */
export function learnPassFor(job: Pick<Job, 'id' | 'name'>, mode: LearnMode): LearnPass {
  return { kind: 'learn', mode, jobId: job.id, job: job.name };
}

export interface LearnOnReadyOptions {
  /** `Config.inboxPath`: a client's style.md is `<inboxPath>/<Client>/_Style/style.md`. */
  inboxPath: string;
  worker: Pick<StyleWorker, 'enqueue'>;
  /** Where a ready episode goes instead (C26). Default: nowhere. */
  series?: Pick<SeriesService, 'approved'>;
  logger?: RunnerLogger;
}

/**
 * The queue worker's `afterReady`: queues a Learn pass from the job, `create` when its client has
 * no style.md and `merge` when it has one, and resolves once it is queued; the run goes on beside
 * the next edit (`createLearnWait` holds back a job of the same client). A job that is not ready
 * (one in Review, a preview) queues nothing. An episode of a series queues no Learn pass: it goes
 * to `series.approved`, which makes it the series' format when Series notes wait for it.
 */
export function createLearnOnReady({
  inboxPath,
  worker,
  series,
  logger,
}: LearnOnReadyOptions): (job: Job) => Promise<void> {
  return async (job) => {
    if (job.state !== 'ready') return;
    if (job.seriesId !== null) {
      logger?.info(
        { jobId: job.id, client: job.client, seriesId: job.seriesId },
        'an episode of a series: its look is not added to the client’s style',
      );
      await series?.approved(job);
      return;
    }
    const mode: LearnMode = (await isFile(styleFileFor(inboxPath, job.client)))
      ? 'merge'
      : 'create';
    logger?.info(
      { jobId: job.id, client: job.client, mode },
      mode === 'create'
        ? 'the client has no style yet: learning it from this job'
        : 'adding the look of this job to the client’s style',
    );
    await worker.enqueue(job.client, learnPassFor(job, mode));
  };
}

export interface LearnWaitOptions {
  worker: Pick<StyleWorker, 'isLearning' | 'learned'>;
}

/**
 * The queue worker's `beforeStart`: for an edit run of a client whose Learn pass is queued or
 * running, the wait for that pass; null for anything else, which starts at once. Only an edit run
 * has a Brief step, which copies the client's style into the job; a revise or render run works on
 * the edit that is there.
 */
export function createLearnWait({ worker }: LearnWaitOptions): (job: Job) => Promise<void> | null {
  return (job) => {
    if (job.runKind !== 'edit') return null;
    const clientId = clientIdFor(job.client);
    return worker.isLearning(clientId) ? worker.learned(clientId) : null;
  };
}

export interface BackfillStylesOptions {
  jobs: Pick<JobRepository, 'getAll' | 'getMeta'>;
  inboxPath: string;
  worker: Pick<StyleWorker, 'enqueue'>;
  logger?: RunnerLogger;
}

/** When a ready job finished: its latest attempt's end, else its last change. */
function finishedAt(job: Job, jobs: BackfillStylesOptions['jobs']): number {
  return Date.parse(jobs.getMeta(job.id)?.finishedAt ?? job.updatedAt);
}

/**
 * The backfill of the first start after this update (call it only while `client_styles` was empty
 * before the boot reconciled it): queues a Learn pass from the newest ready job of every client
 * that has one and no style.md. Episodes of a series are left out. Returns the number of passes
 * queued. One client that cannot be queued does not stop the others.
 */
export async function backfillStyles(options: BackfillStylesOptions): Promise<number> {
  const { jobs, inboxPath, worker, logger } = options;
  const newest = new Map<string, Job>();
  for (const job of jobs.getAll()) {
    if (job.state !== 'ready' || job.seriesId !== null) continue;
    const clientId = clientIdFor(job.client);
    const best = newest.get(clientId);
    if (best === undefined || finishedAt(job, jobs) > finishedAt(best, jobs)) {
      newest.set(clientId, job);
    }
  }

  let queued = 0;
  for (const job of newest.values()) {
    try {
      if (await isFile(styleFileFor(inboxPath, job.client))) continue;
      await worker.enqueue(job.client, learnPassFor(job, 'create'));
      queued += 1;
      logger?.info(
        { jobId: job.id, client: job.client },
        'first start with client styles: learning the style from the newest finished job',
      );
    } catch (err) {
      logger?.warn({ jobId: job.id, client: job.client, err }, 'could not queue a Learn pass');
    }
  }
  return queued;
}
