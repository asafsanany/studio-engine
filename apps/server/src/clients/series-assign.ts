// Joining a series by folder name (Series plan §2): a job folder named after one of its client's
// series plus a number ("מיתוס או אמת 6") is an episode of it, with that number (`matchSeries`).
//
// When the rule runs: when a job is first scanned (the inbox watcher and the boot's reconcile), when
// it settles (the same two), and when a series of its client is installed (engine.ts, on the series
// service's `installed` change). It only ever moves jobs that are arriving, queued or held
// (`canChangeSeries`) and not pinned (the owner picked their series by hand). A job that has started
// never changes series by itself.
//
// Both functions are already called from those points. While series are off (`enabled` false)
// they change nothing.

import { canChangeSeries, type Job, matchSeries, type SeriesState } from '@studio/shared';
import type { JobRepository, SeriesRepository, StoredSeries } from '../db/index.js';
import type { RunnerLogger } from '../pipeline/claude-process.js';

export interface SeriesAssignDeps {
  /** Whether series are on (`SeriesService.enabled`). Off, no job joins or leaves a series. */
  enabled: boolean;
  /** `getMeta` says whether a job is pinned; `setSeries` writes the series and the episode. */
  jobs: Pick<JobRepository, 'get' | 'getAll' | 'getMeta' | 'setSeries'>;
  /** The client's series names, for `matchSeries`. */
  series: Pick<SeriesRepository, 'listByClient'>;
  logger?: RunnerLogger;
}

/** The series that take new episodes. A failed series has no format to repeat yet. */
const JOINABLE: readonly SeriesState[] = ['ready', 'learning'];

/**
 * The name rule for one job that may change series, given its client's series: the job joins the
 * ready or learning series its name points to (with the episode from the name), or leaves its
 * series when the name no longer points to one. The job itself when nothing changes.
 */
function applyNameRule(deps: SeriesAssignDeps, job: Job, series: readonly StoredSeries[]): Job {
  const joinable = series.filter((candidate) => JOINABLE.includes(candidate.state));
  const match = matchSeries(
    job.name,
    joinable.map((candidate) => candidate.name),
  );
  const target = match === null ? null : (joinable.find((s) => s.name === match.name) ?? null);
  const seriesId = target?.id ?? null;
  const episode = match?.episode ?? null;
  if (job.seriesId === seriesId && job.episode === episode) return job;

  // The name points to no series that takes jobs. A job whose own series is failed and still named
  // for it stays in it: the install after Retry would put it back anyway.
  if (target === null && job.seriesId !== null) {
    const current = series.find((candidate) => candidate.id === job.seriesId);
    if (current !== undefined && matchSeries(job.name, [current.name]) !== null) return job;
  }

  // Pinned (picked by hand), or gone since the caller read it: left alone.
  if (deps.jobs.getMeta(job.id)?.seriesPinned !== false) return job;
  return deps.jobs.setSeries(job.id, { seriesId, episode, pinned: false });
}

/**
 * The name rule for one job that was just scanned for the first time or just settled: it joins
 * the series its name points to, or leaves one it no longer matches. Returns the job as it is
 * afterwards, the same one when nothing changed, so the caller publishes what it returns. Never
 * throws: a series problem must not stop the inbox (it logs and answers the job as it was).
 */
export function assignSeries(deps: SeriesAssignDeps, job: Job): Job {
  if (!deps.enabled || !canChangeSeries(job)) return job;
  try {
    return applyNameRule(deps, job, deps.series.listByClient(job.clientId));
  } catch (err) {
    deps.logger?.error({ jobId: job.id, err }, 'could not join the job to a series by its name');
    return job;
  }
}

/**
 * The name rule for every waiting job of the client `clientId`, after one of its series was
 * installed. Returns the jobs that changed, for the caller to publish. Never throws, like
 * {@link assignSeries}: one job that cannot be written does not stop the others.
 */
export function assignWaitingJobs(deps: SeriesAssignDeps, clientId: string): Job[] {
  if (!deps.enabled) return [];
  try {
    const waiting = deps.jobs
      .getAll()
      .filter((job) => job.clientId === clientId && canChangeSeries(job));
    if (waiting.length === 0) return [];
    const series = deps.series.listByClient(clientId);
    const changed: Job[] = [];
    for (const job of waiting) {
      try {
        const after = applyNameRule(deps, job, series);
        if (after !== job) changed.push(after);
      } catch (err) {
        deps.logger?.error(
          { jobId: job.id, err },
          'could not join the job to a series by its name',
        );
      }
    }
    return changed;
  } catch (err) {
    deps.logger?.error({ clientId, err }, 'could not let the waiting jobs join a series');
    return [];
  }
}
