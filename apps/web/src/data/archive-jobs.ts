// Archiving and unarchiving jobs (`POST /api/jobs/archive` and `/unarchive`).
//
// No optimistic update, like the effort: the server decides (it refuses with a 409 for a job that
// is arriving, queued or editing, and with a 404 for one that is gone), and it answers with every
// job it was asked about, so the cache takes those. Archiving does not move `updatedAt`, so
// `upsertJob` swaps each job where it stands and the list keeps its order. Then the list is
// reloaded, which also repairs a cache that was behind when the answer was a refusal.

import type { Job } from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { Api, ApiError } from './api';
import { JOBS_KEY, upsertJob } from './jobs-cache';

/** First element of the archive mutation's key. */
export const ARCHIVE_JOBS_MUTATION_KEY = 'archive-jobs';
/** First element of the unarchive mutation's key. */
export const UNARCHIVE_JOBS_MUTATION_KEY = 'unarchive-jobs';

export interface ArchiveJobsMutationParams {
  queryClient: QueryClient;
  api: Api;
}

/** Puts the jobs the server answered with into the cached list, each where it stands. */
function putJobs(queryClient: QueryClient, jobs: readonly Job[]): void {
  queryClient.setQueryData<Job[]>(
    JOBS_KEY,
    (list) => list && jobs.reduce((next, job) => upsertJob(next, job), list),
  );
}

/** The mutation: the variables are the ids of the jobs, the result is those jobs, archived. */
export function archiveJobsMutationOptions({ queryClient, api }: ArchiveJobsMutationParams) {
  return mutationOptions<Job[], ApiError, readonly string[]>({
    mutationKey: [ARCHIVE_JOBS_MUTATION_KEY],
    mutationFn: (ids) => api.archiveJobs(ids),

    onSuccess(jobs) {
      putJobs(queryClient, jobs);
    },

    onSettled() {
      void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    },
  });
}

/** The mutation: the variables are the ids of the jobs, the result is those jobs, out of the archive. */
export function unarchiveJobsMutationOptions({ queryClient, api }: ArchiveJobsMutationParams) {
  return mutationOptions<Job[], ApiError, readonly string[]>({
    mutationKey: [UNARCHIVE_JOBS_MUTATION_KEY],
    mutationFn: (ids) => api.unarchiveJobs(ids),

    onSuccess(jobs) {
      putJobs(queryClient, jobs);
    },

    onSettled() {
      void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    },
  });
}
