// A job's second file, the one without the song (Songs, SG9): the `['no-song', jobId]` query
// (`GET /api/jobs/:id/no-song`) and Try again (`POST` on the same path).
//
// - Nothing is asked while Songs is off (`/api/health`'s `songs`, with Soundtrack): `data` stays
//   `undefined` and the sheet shows nothing of a second file, exactly as before Songs.
// - The server pushes no event of its own for it. Each start and each end of the render republishes
//   the job as `job.upsert` (the job itself unchanged), and job-events.ts invalidates
//   `noSongKey(id)` on every `job.upsert`, so an open sheet reads the status again and a closed one
//   just goes stale. A `hello` invalidates every job's, and a removed job drops its own. It is not
//   polled.
// - Try again answers the new status (`making`), which goes into the cache as it is.

import type { NoSongStatus } from '@studio/shared';
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { type Api, ApiError, api } from './api';
import { useSongsEnabled } from './music-query';

/** Every no-song query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const NO_SONG_KEY = ['no-song'] as const;

/** One job's second file: ['no-song', jobId]. */
export function noSongKey(jobId: string): readonly ['no-song', string] {
  return ['no-song', jobId] as const;
}

/**
 * Options of the `['no-song', jobId]` query: the status of the second file, fresh until the job
 * changes (the events invalidate it). A 4xx (404 for a job that is gone, or Songs that is off) will
 * not change by asking again, so it is not retried.
 */
export function noSongQueryOptions(client: Api, jobId: string) {
  return queryOptions<NoSongStatus, ApiError>({
    queryKey: noSongKey(jobId),
    queryFn: ({ signal }) => client.getNoSong(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

/**
 * A job's second file (`['no-song', jobId]`): `data` is its status, `undefined` until the first
 * answer, while Songs is off (nothing is asked) and while `enabled` is false.
 */
export function useNoSong(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const on = useSongsEnabled();
  return useQuery({ ...noSongQueryOptions(api, jobId), enabled: on && enabled });
}

/** The toast of a Try again that was refused: one id, so a second try replaces the note instead of stacking. */
export const RETRY_NO_SONG_TOAST_ID = 'no-song-retry';

type NotifyError = (message: string, options: { id: string; description?: string }) => unknown;

export interface RetryNoSongParams {
  api: Api;
  queryClient: QueryClient;
  jobId: string;
  /** `toast.error` of sonner, or a stand-in in tests. */
  notify: { error: NotifyError };
}

/**
 * Try again: the mutation has no variable. It resolves with the status, now `making`, which goes
 * into the cache as it is. A refusal (409: the job has no such file to make; 404: Songs is off) is
 * a toast carrying the server's words and also rejects `mutateAsync`.
 */
export function retryNoSongMutationOptions({
  api: client,
  queryClient,
  jobId,
  notify,
}: RetryNoSongParams) {
  return mutationOptions<NoSongStatus, ApiError, void>({
    mutationKey: ['no-song-retry', jobId],
    mutationFn: () => client.retryNoSong(jobId),
    onSuccess: (status) => queryClient.setQueryData<NoSongStatus>(noSongKey(jobId), status),
    onError: (error) =>
      notify.error('Couldn’t make the file again', {
        id: RETRY_NO_SONG_TOAST_ID,
        description: error.message,
      }),
  });
}

/** Try again: `retry.mutate()`. */
export function useRetryNoSong(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation(retryNoSongMutationOptions({ api, queryClient, jobId, notify: toast }));
}
