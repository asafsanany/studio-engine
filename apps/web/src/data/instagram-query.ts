// The Instagram queries and actions (Clients × Instagram, IG0): a client's Instagram for a range,
// and the hooks of the actions (instagram-mutations.ts). While the Instagram switch is off
// (`/api/health` says `instagram` is not true, and until its answer is in) nothing is asked: the
// routes would only answer 404 "Clients × Instagram is off.", and the page shows nothing of
// Instagram. The cache and its events are instagram-cache.ts.

import {
  type ClientInstagram,
  DEFAULT_INSTAGRAM_RANGE,
  type InstagramRange,
  type JobReelResponse,
} from '@studio/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from './api';
import { useInstagramEnabled } from './hooks';
import { type InstagramApi, instagramApi } from './instagram-api';
import { clientInstagramKey, jobReelKey } from './instagram-cache';
import {
  deleteClientInstagramMutationOptions,
  linkReelMutationOptions,
  scanClientInstagramMutationOptions,
  setClientInstagramMutationOptions,
  unlinkReelMutationOptions,
} from './instagram-mutations';

/** A 4xx (an unknown client, Instagram off) will not change by asking again, so it is not retried. */
function retryUnless4xx(_count: number, error: ApiError): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/**
 * Options of the `['client-instagram', clientId, range]` query: the client's Instagram, with the
 * numbers of `range`. Fresh forever (SSE says when it changes). `enabled` is whether Instagram is
 * on.
 */
export function clientInstagramQueryOptions(
  api: InstagramApi,
  clientId: string,
  range: InstagramRange = DEFAULT_INSTAGRAM_RANGE,
  enabled = true,
) {
  return queryOptions<ClientInstagram, ApiError>({
    queryKey: clientInstagramKey(clientId, range),
    queryFn: ({ signal }) => api.getClientInstagram(clientId, range, signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/**
 * Options of the `['job-reel', jobId]` query: the reel linked to the job, with its numbers, for
 * the job sheet's "On Instagram" line. Fresh forever: a link or unlink of the job, and every
 * `client-instagram` event (a scan read new numbers), load it again. `enabled` is whether the sheet
 * has anything to ask: Instagram is on and the job is delivered.
 */
export function jobReelQueryOptions(api: InstagramApi, jobId: string, enabled = true) {
  return queryOptions<JobReelResponse, ApiError>({
    queryKey: jobReelKey(jobId),
    queryFn: ({ signal }) => api.getJobReel(jobId, signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/**
 * The client's Instagram (`['client-instagram', clientId, range]`): the account, the last scan,
 * the numbers of the range, the reels and the jobs that can be linked. `data` is `undefined` until
 * the first answer, and stays so while Instagram is off (nothing is asked). Kept current by the
 * `client-instagram` events.
 */
export function useClientInstagram(
  clientId: string,
  range: InstagramRange = DEFAULT_INSTAGRAM_RANGE,
) {
  const enabled = useInstagramEnabled();
  return useQuery(clientInstagramQueryOptions(instagramApi, clientId, range, enabled));
}

/**
 * Set the client's account: `await set.mutateAsync({ clientId, account: { handle, since } })`
 * resolves with its Instagram, the first scan queued. A refusal is an `ApiError` with the server's
 * reason in words (400: what is wrong with the handle).
 */
export function useSetClientInstagram() {
  const queryClient = useQueryClient();
  return useMutation(setClientInstagramMutationOptions({ queryClient, api: instagramApi }));
}

/** Remove the client's account: `mutateAsync(clientId)`. */
export function useDeleteClientInstagram() {
  const queryClient = useQueryClient();
  return useMutation(deleteClientInstagramMutationOptions({ queryClient, api: instagramApi }));
}

/** Scan now: `mutateAsync(clientId)`, resolving with the client's Instagram, scanning. */
export function useScanClientInstagram() {
  const queryClient = useQueryClient();
  return useMutation(scanClientInstagramMutationOptions({ queryClient, api: instagramApi }));
}

/**
 * Link to job: `mutateAsync({ shortcode, jobId, jobName? })`, resolving with the reel. The reel's
 * row turns ours at once and a refusal puts it back: an `ApiError` (409) with the reason in words.
 */
export function useLinkReel() {
  const queryClient = useQueryClient();
  return useMutation(linkReelMutationOptions({ queryClient, api: instagramApi }));
}

/** Unlink: `mutateAsync(shortcode)`, resolving with the reel; the row turns theirs at once. */
export function useUnlinkReel() {
  const queryClient = useQueryClient();
  return useMutation(unlinkReelMutationOptions({ queryClient, api: instagramApi }));
}

/**
 * The reel linked to the job (`['job-reel', jobId]`): `data` is `{ jobId, reel }`, `undefined`
 * until the first answer and while Instagram is off or `enabled` is false (nothing is asked then).
 * Only an open job sheet asks.
 */
export function useJobReel(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const on = useInstagramEnabled();
  return useQuery(jobReelQueryOptions(instagramApi, jobId, on && enabled));
}
