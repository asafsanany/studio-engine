// The job sheet's versions query: one job's preview versions (`GET /api/jobs/:id/versions`), newest
// first, and the restore that puts one back (`POST …/versions/:n/restore`). Only an open sheet asks
// for the list (`useJobVersions(id, { enabled })`). The server pushes no event of its own for
// them: every run that ends in Review makes a version and a restore changes the preview, and both
// change the job (job-events.ts invalidates `jobVersionsKey(id)` on every `job.upsert`), so the
// sheet that is open reads them again and a closed one just goes stale. The list is not polled.

import type { Job, JobVersionsResponse } from '@studio/shared';
import { mutationOptions, type QueryClient, queryOptions } from '@tanstack/react-query';
import { type Api, ApiError } from './api';
import { JOBS_KEY, upsertJob } from './jobs-cache';

/** Every job-versions query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const JOB_VERSIONS_KEY = ['job-versions'] as const;

/** One job's versions: ['job-versions', jobId]. */
export function jobVersionsKey(jobId: string): readonly ['job-versions', string] {
  return ['job-versions', jobId] as const;
}

/**
 * Options of the `['job-versions', jobId]` query: the job's versions, fresh until the job changes
 * (the events invalidate it). The app's queries retry for ever (query-client.ts); a 4xx (404 for a
 * job that is gone) will not change by asking again, so it is not retried.
 */
export function jobVersionsQueryOptions(api: Api, jobId: string) {
  return queryOptions<JobVersionsResponse, ApiError>({
    queryKey: jobVersionsKey(jobId),
    queryFn: ({ signal }) => api.getJobVersions(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

/** First element of the restore mutation's key. */
export const RESTORE_JOB_VERSION_MUTATION_KEY = 'restore-job-version';

/** What is restored: version `n` of job `id`. */
export interface RestoreJobVersionVariables {
  id: string;
  n: number;
}

export interface RestoreJobVersionMutationParams {
  queryClient: QueryClient;
  api: Api;
}

/**
 * The mutation: variables are `{ id, n }`, the result is the job after the restore. No optimistic
 * update, the server decides (it refuses with a 409 unless the job is in Review with no unsent
 * notes), so the cache takes the job it answers with; then the list and the versions are read
 * again, which also repairs a cache that was behind when the answer was a refusal.
 */
export function restoreJobVersionMutationOptions({
  queryClient,
  api,
}: RestoreJobVersionMutationParams) {
  return mutationOptions<Job, ApiError, RestoreJobVersionVariables>({
    mutationKey: [RESTORE_JOB_VERSION_MUTATION_KEY],
    mutationFn: ({ id, n }) => api.restoreJobVersion(id, n),

    onSuccess(job) {
      queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => list && upsertJob(list, job));
    },

    onSettled(_job, _error, { id }) {
      void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
      void queryClient.invalidateQueries({ queryKey: jobVersionsKey(id) });
    },
  });
}
