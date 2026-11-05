// A job's music (Soundtrack): the `['music', jobId]` query (`GET /api/jobs/:id/music`), Make
// another and Pick, and how the `job.music` event keeps it current. SD0 builds it; Review (SD4) and
// the job sheet (SD5) only read it.
//
// - Nothing is asked while the Soundtrack switch is off (`/api/health`'s `music`): `data` stays
//   `undefined`, and the page shows nothing of music, exactly as before Soundtrack.
// - The answer is the job's MusicView, or `null` for a job without music.json (no Music button, no
//   Music row).
// - `job.music` carries the whole answer, so it is written into the cache as it is (no request);
//   a `hello` invalidates every job's music (job-events.ts), since events may have been missed.
// - Make another and Pick answer the new MusicView, which goes into the cache the same way.
// - `rev` changes whenever edit/preview/music.mp3 does: Review puts it in the preview's URL
//   (`previewUrl(jobId, round, rev)`), so the player loads the new music.

import type { JobMusicEvent, MusicView, PickMusicRequest } from '@studio/shared';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type Api, ApiError, api } from './api';
import { healthQueryOptions, musicEnabled, songsEnabled } from './health-query';

/** Every music query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const MUSIC_KEY = ['music'] as const;

/** One job's music: ['music', jobId]. */
export function musicKey(jobId: string): readonly ['music', string] {
  return ['music', jobId] as const;
}

/**
 * Options of the `['music', jobId]` query: fresh until an event says otherwise (`job.music` writes
 * it, a `hello` invalidates it). A 4xx (404 for a job that is gone, or music that is off) will not
 * change by asking again, so it is not retried.
 */
export function musicQueryOptions(client: Api, jobId: string) {
  return queryOptions<MusicView | null, ApiError>({
    queryKey: musicKey(jobId),
    queryFn: ({ signal }) => client.getJobMusic(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

/** Writes a job's music into the cache: the `job.music` event, or the answer of Make another or Pick. */
export function applyJobMusic(
  queryClient: QueryClient,
  jobId: string,
  music: MusicView | null,
): void {
  queryClient.setQueryData<MusicView | null>(musicKey(jobId), music);
}

/** The `job.music` event: the answer it carries goes into the cache as it is. */
export function applyJobMusicEvent(queryClient: QueryClient, event: JobMusicEvent): void {
  applyJobMusic(queryClient, event.jobId, event.music);
}

/** Whether Soundtrack is on (`/api/health`'s `music`): false until the answer is in. */
export function useMusicEnabled(): boolean {
  return musicEnabled(useQuery(healthQueryOptions(api)).data);
}

/** Whether Songs are on (`/api/health`'s `songs`, with Soundtrack): false until the answer is in. */
export function useSongsEnabled(): boolean {
  return songsEnabled(useQuery(healthQueryOptions(api)).data);
}

/**
 * A job's music (`['music', jobId]`): `data` is the MusicView, `null` for a job without music.json,
 * and `undefined` until the first answer, while Soundtrack is off (nothing is asked) and while
 * `enabled` is false. Kept current by the `job.music` event.
 */
export function useJobMusic(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const on = useMusicEnabled();
  return useQuery({ ...musicQueryOptions(api, jobId), enabled: on && enabled });
}

/**
 * Make another: `make.mutate(ask)` (no words: `make.mutate(undefined)`). Resolves with the job's
 * music, now making (already in the cache); a refusal is an `ApiError` with the server's words.
 */
export function useMakeMusic(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation<MusicView, ApiError, string | undefined>({
    mutationKey: ['music-make', jobId],
    mutationFn: (ask) => api.makeMusic(jobId, ask),
    onSuccess: (music) => applyJobMusic(queryClient, jobId, music),
  });
}

/**
 * Pick: `pick.mutate('v1')` or `pick.mutate('off')`. Resolves with the job's music (already in the
 * cache, its `rev` new); a refusal is an `ApiError` with the server's words.
 */
export function usePickMusic(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation<MusicView, ApiError, PickMusicRequest['id']>({
    mutationKey: ['music-pick', jobId],
    mutationFn: (id) => api.pickMusic(jobId, id),
    onSuccess: (music) => applyJobMusic(queryClient, jobId, music),
  });
}
