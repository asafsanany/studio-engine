// The job sheet's sent-notes query: the review notes one job's rounds were sent with
// (`GET /api/jobs/:id/sent-notes`), by round. Only an open sheet asks for them
// (`useSentNotes(id, { enabled })`). The server pushes no event of its own for them: sending the
// notes of a round changes the job (job-events.ts invalidates `sentNotesKey(id)` on every
// `job.upsert`), and a sent note never changes after that, so an open sheet reads them again and a
// closed one just goes stale. The list is not polled. It is not the unsent notes of the Review
// dialog (`['notes', jobId]`, notes-query.ts), which have their own events.

import type { SentNotesResponse } from '@studio/shared';
import { queryOptions } from '@tanstack/react-query';
import { type Api, ApiError } from './api';

/** Every sent-notes query starts with this. Its own root on purpose: invalidating ['notes'] matches by prefix. */
export const SENT_NOTES_KEY = ['sent-notes'] as const;

/** One job's sent notes: ['sent-notes', jobId]. */
export function sentNotesKey(jobId: string): readonly ['sent-notes', string] {
  return ['sent-notes', jobId] as const;
}

/**
 * Options of the `['sent-notes', jobId]` query: the job's sent notes, fresh until the job changes
 * (the events invalidate it). The app's queries retry for ever (query-client.ts); a 4xx (404 for a
 * job that is gone) will not change by asking again, so it is not retried.
 */
export function sentNotesQueryOptions(api: Api, jobId: string) {
  return queryOptions<SentNotesResponse, ApiError>({
    queryKey: sentNotesKey(jobId),
    queryFn: ({ signal }) => api.getSentNotes(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}
