// The notes query: one job's unsent notes. The server pushes every change over SSE (job-events.ts),
// so the list is never stale on its own and is not polled.

import type { ReviewNote } from '@studio/shared';
import { queryOptions } from '@tanstack/react-query';
import { type Api, ApiError } from './api';
import { notesKey } from './notes-cache';

/**
 * Options of the `['notes', jobId]` query: the job's unsent notes, fresh forever. The app's
 * queries retry for ever (query-client.ts); a 4xx (409 outside Review, 404 for an unknown job) will
 * not change by asking again, so it is not retried.
 */
export function notesQueryOptions(api: Api, jobId: string) {
  return queryOptions<ReviewNote[], ApiError>({
    queryKey: notesKey(jobId),
    queryFn: ({ signal }) => api.listNotes(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}
