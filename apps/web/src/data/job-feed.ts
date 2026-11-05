// The job chat's query (Draft & chat, DR3): `GET /api/jobs/:id/feed`, the chat the engine builds
// from the job's log. Only an open chat asks (`useJobFeed(id, { enabled })`). While the job's run
// goes on (`live`), the chat is asked again every 2 s: the log grows line by line and the engine
// pushes no event for it. An answer with the same `rev` as the one in the cache changes nothing, so
// a quiet poll does not render the chat again. Once the run is over the chat stays as it is until
// the job changes (job-events.ts invalidates the job's queries on every `job.upsert`).

import type { JobFeedResponse } from '@studio/shared';
import { queryOptions } from '@tanstack/react-query';
import { type Api, ApiError } from './api';

/** Every job-feed query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const JOB_FEED_KEY = ['job-feed'] as const;

/** How often a running job's chat is asked again. */
export const JOB_FEED_POLL_MS = 2_000;

/** One job's chat: ['job-feed', jobId]. */
export function jobFeedKey(jobId: string): readonly ['job-feed', string] {
  return ['job-feed', jobId] as const;
}

/**
 * Options of the `['job-feed', jobId]` query. `live`: the job is running, so it is polled. A 4xx
 * (404 for a job that is gone, or Draft & chat turned off) will not change by asking again, so it
 * is not retried.
 */
export function jobFeedQueryOptions(api: Api, jobId: string, { live }: { live: boolean }) {
  return queryOptions<JobFeedResponse, ApiError>({
    queryKey: jobFeedKey(jobId),
    queryFn: ({ signal }) => api.getJobFeed(jobId, signal),
    staleTime: live ? 0 : Infinity,
    refetchInterval: live ? JOB_FEED_POLL_MS : false,
    // The same rev is the same chat: keep the cached answer, so nothing renders again.
    structuralSharing: (previous, next) =>
      previous !== undefined &&
      (previous as JobFeedResponse).rev === (next as JobFeedResponse).rev &&
      (previous as JobFeedResponse).jobId === (next as JobFeedResponse).jobId
        ? previous
        : next,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}
