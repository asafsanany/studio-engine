import type { AnalyticsJob } from './analytics-compute.ts';
import { msOf } from './analytics-time.ts';

// The one rule for "a finished job" on the Analytics page. Every section that counts finished jobs
// asks it here, so the Jobs finished tile, the typical job's medians and API value per finished
// minute never disagree about which jobs they are looking at.

/**
 * When a job finished, in milliseconds since the epoch, or `null` when it has not (as far as the
 * page can tell). A finished job is a `ready` job that has its export (`output`); it finished at
 * its `finishedAt`, the end of its final run. The state matters: a job that was started again (a
 * Retry on a ready job) keeps its old export until the new run ends, and it is not finished while
 * it runs. A ready job with no `finishedAt` (one from before the engine wrote it) has no time to
 * count it at, so it is not counted either. Archived jobs are finished jobs like any other.
 */
export function finishedAtOf(
  job: Pick<AnalyticsJob, 'state' | 'output' | 'finishedAt'>,
): number | null {
  if (job.state !== 'ready' || job.output === null) return null;
  return msOf(job.finishedAt);
}
