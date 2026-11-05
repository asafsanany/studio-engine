// The jobs query: the one list the whole page reads. The server pushes every change over SSE
// (job-events.ts), so the list is never stale on its own and is not polled.

import type { Job } from '@studio/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import type { Api, ApiError } from './api';
import { JOBS_KEY } from './jobs-cache';

/** Options of the `['jobs']` query: the full list, fresh forever (SSE keeps it current). */
export function jobsQueryOptions(api: Api) {
  return queryOptions<Job[], ApiError>({
    queryKey: JOBS_KEY,
    queryFn: ({ signal }) => api.listJobs(signal),
    staleTime: Infinity,
  });
}

/**
 * Whether the page should say "Can't reach the engine.": the list has not arrived, and asking for
 * it has failed at least once. A query that is retrying stays `pending` (`isError` is false) while
 * its `failureCount` counts the failures, so waiting for `isError` would mean waiting for the last
 * retry; the first failure is enough. A list that is already on screen is never replaced by this:
 * it stays as it was, and the next answer replaces it.
 */
export function jobsUnreachable(query: {
  data: unknown;
  isError: boolean;
  failureCount: number;
}): boolean {
  return query.data === undefined && (query.isError || query.failureCount > 0);
}

/**
 * Loads the list again from the server, starting from scratch. A fetch already in flight is
 * cancelled first: it may have read the server before the thing that made us reload, and the
 * newest answer is the only one that is safe to show. (`invalidateQueries` alone only restarts a
 * fetch that already has data; the very first load would be left running.) Does nothing for a
 * list nobody shows; the next `useJobs()` loads it.
 *
 * The cancel takes effect at once, so the new fetch starts in the same tick. There is no gap in
 * which an optimistic update could be written and then overwritten by a fetch that had not
 * started yet. The promise settles when the new fetch has.
 */
export function reloadJobs(queryClient: QueryClient): Promise<void> {
  void queryClient.cancelQueries({ queryKey: JOBS_KEY });
  return queryClient.invalidateQueries({ queryKey: JOBS_KEY });
}
