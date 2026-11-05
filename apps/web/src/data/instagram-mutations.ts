// The Instagram actions (Clients × Instagram, IG0): set a client's account, remove it, Scan now,
// link a reel to a job and unlink it.
//
// The server decides (400 with the handle's problem in words, 409 with the reason a link is
// refused), so the caches take what it answers. An answer that is the client's Instagram is written
// over the cached default range, and every range of that client loads again, so that the next
// answer is the server's own; the `client-instagram` events keep it right after. A link turns the
// job Uploaded, so the job list loads again too.
//
// The one change made optimistically is link and unlink: the reel's row turns ours or theirs at
// once (instagram-reel-patch.ts) and a refusal puts it back.

import {
  type ClientInstagram,
  DEFAULT_INSTAGRAM_RANGE,
  type InstagramReel,
  type SetClientInstagramRequest,
} from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { ApiError } from './api';
import type { InstagramApi } from './instagram-api';
import {
  type ClientInstagramSnapshot,
  clientInstagramKey,
  patchClientInstagram,
  reloadAllClientInstagram,
  reloadClientInstagram,
  restoreClientInstagram,
} from './instagram-cache';
import { withReelLinked, withReelUnlinked } from './instagram-reel-patch';
import { reloadJobs } from './jobs-query';

/** First element of each Instagram mutation's key. */
export const INSTAGRAM_MUTATION_KEYS = {
  set: 'set-client-instagram',
  remove: 'delete-client-instagram',
  scan: 'scan-client-instagram',
  link: 'link-instagram-reel',
  unlink: 'unlink-instagram-reel',
} as const;

export interface InstagramMutationParams {
  queryClient: QueryClient;
  api: InstagramApi;
}

/** What an action that answers the client's Instagram leaves in the cache. */
function applyClientInstagram(
  queryClient: QueryClient,
  clientId: string,
  answer: ClientInstagram,
): void {
  queryClient.setQueryData<ClientInstagram>(
    clientInstagramKey(clientId, DEFAULT_INSTAGRAM_RANGE),
    answer,
  );
  void reloadClientInstagram(queryClient, clientId);
}

/** The Instagram… dialog: the variables are the client and the account as typed. */
export function setClientInstagramMutationOptions({ queryClient, api }: InstagramMutationParams) {
  return mutationOptions<
    ClientInstagram,
    ApiError,
    { clientId: string; account: SetClientInstagramRequest }
  >({
    mutationKey: [INSTAGRAM_MUTATION_KEYS.set],
    mutationFn: ({ clientId, account }) => api.setClientInstagram(clientId, account),
    onSuccess: (answer, { clientId }) => applyClientInstagram(queryClient, clientId, answer),
  });
}

/** Remove the account: the variable is the client id. */
export function deleteClientInstagramMutationOptions({
  queryClient,
  api,
}: InstagramMutationParams) {
  return mutationOptions<void, ApiError, string>({
    mutationKey: [INSTAGRAM_MUTATION_KEYS.remove],
    mutationFn: (clientId) => api.deleteClientInstagram(clientId),
    onSuccess: (_answer, clientId) => void reloadClientInstagram(queryClient, clientId),
  });
}

/** Scan now: the variable is the client id; the result is its Instagram with the scan queued. */
export function scanClientInstagramMutationOptions({ queryClient, api }: InstagramMutationParams) {
  return mutationOptions<ClientInstagram, ApiError, string>({
    mutationKey: [INSTAGRAM_MUTATION_KEYS.scan],
    mutationFn: (clientId) => api.scanClientInstagram(clientId),
    onSuccess: (answer, clientId) => applyClientInstagram(queryClient, clientId, answer),
  });
}

/** What Link to job needs: the reel, the job and (when the caller has it) the job's name. */
export interface LinkReelVariables {
  shortcode: string;
  jobId: string;
  /** The video's name, for the row that turns ours at once; left out, the page's Link to job list has it. */
  jobName?: string;
}

/** What `onMutate` remembers for `onError`: the pages the optimistic change replaced. */
export interface LinkReelContext {
  snapshot: ClientInstagramSnapshot;
}

/** After a link or an unlink, refused or not: the server's pages and jobs replace the optimistic ones. */
function reloadAfterLink(queryClient: QueryClient): void {
  void reloadAllClientInstagram(queryClient);
  void reloadJobs(queryClient);
}

/**
 * Link to job (a reel's right-click menu): the variables are the reel and the job. The row turns
 * ours at once and the job leaves the list (`withReelLinked`); a refusal (409 with its reason in
 * words) puts the page back as it was. The answer is the reel, which says nothing of whose it is,
 * so, refused or not, every client's Instagram loads again (only the one on screen is asked), and
 * the jobs: the linked job turns Uploaded.
 */
export function linkReelMutationOptions({ queryClient, api }: InstagramMutationParams) {
  return mutationOptions<InstagramReel, ApiError, LinkReelVariables, LinkReelContext>({
    mutationKey: [INSTAGRAM_MUTATION_KEYS.link],
    mutationFn: ({ shortcode, jobId }) => api.linkReel(shortcode, jobId),
    onMutate: async ({ shortcode, jobId, jobName }) => ({
      snapshot: await patchClientInstagram(queryClient, (data) =>
        withReelLinked(data, shortcode, jobId, jobName),
      ),
    }),
    onError: (_error, _variables, context) => {
      if (context !== undefined) restoreClientInstagram(queryClient, context.snapshot);
    },
    onSettled: () => reloadAfterLink(queryClient),
  });
}

/**
 * Unlink (a linked reel's right-click menu): the variable is the reel's shortcode. The row turns
 * theirs at once; a refusal puts it back. Settles as {@link linkReelMutationOptions} does.
 */
export function unlinkReelMutationOptions({ queryClient, api }: InstagramMutationParams) {
  return mutationOptions<InstagramReel, ApiError, string, LinkReelContext>({
    mutationKey: [INSTAGRAM_MUTATION_KEYS.unlink],
    mutationFn: (shortcode) => api.unlinkReel(shortcode),
    onMutate: async (shortcode) => ({
      snapshot: await patchClientInstagram(queryClient, (data) =>
        withReelUnlinked(data, shortcode),
      ),
    }),
    onError: (_error, _shortcode, context) => {
      if (context !== undefined) restoreClientInstagram(queryClient, context.snapshot);
    },
    onSettled: () => reloadAfterLink(queryClient),
  });
}
