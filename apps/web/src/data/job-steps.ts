// The job sheet's steps query: one job's timed step runs (`GET /api/jobs/:id/steps`), oldest first.
// Only an open sheet asks for them (`useJobSteps(id, { enabled })`). The server pushes no event of
// its own for them: a change of the job (job-events.ts invalidates `jobStepsKey(id)` on every
// `job.upsert`) is what says they may have changed, so the sheet that is open reads them again and
// a closed one just goes stale. The list is not polled.

import type { JobStepsResponse } from '@studio/shared';
import { queryOptions } from '@tanstack/react-query';
import { type Api, ApiError } from './api';

/** Every job-steps query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const JOB_STEPS_KEY = ['job-steps'] as const;

/** One job's step runs: ['job-steps', jobId]. */
export function jobStepsKey(jobId: string): readonly ['job-steps', string] {
  return ['job-steps', jobId] as const;
}

/**
 * Options of the `['job-steps', jobId]` query: the job's step runs, fresh until the job changes
 * (the events invalidate it). The app's queries retry for ever (query-client.ts); a 4xx (404 for a
 * job that is gone) will not change by asking again, so it is not retried.
 */
export function jobStepsQueryOptions(api: Api, jobId: string) {
  return queryOptions<JobStepsResponse, ApiError>({
    queryKey: jobStepsKey(jobId),
    queryFn: ({ signal }) => api.getJobSteps(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}
