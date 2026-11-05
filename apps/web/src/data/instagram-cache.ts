// The client Instagram cache (Clients × Instagram, IG0): one client's Instagram for one range
// (`['client-instagram', clientId, range]`). The server pushes every change over SSE
// (`client-instagram`, see job-events.ts), which only says "this client's changed"; the query then
// asks again, because the numbers are the range's to work out. Not polled.
//
//   client-instagram   every range of that client that is loaded loads again
//   hello              every client's Instagram loads again (whatever happened while we were away)
//
// A change of a client's Instagram is also a change of what three other places show of it, so the
// same calls load those again: the client list (the Clients page's followers, this week and
// ours vs theirs, and the photo every avatar shows come from it), the reel numbers of the open
// job sheets (`['job-reel', jobId]`, the sheet's "On Instagram" line) and, while a video of the
// client has a reel linked, the job list (an Uploaded row says the reel's plays).
//
// Linking a reel to a job (or unlinking it) is the one change made optimistically
// (`patchClientInstagram`, put back by `restoreClientInstagram` when the server refuses it).

import type { ClientInstagram, InstagramRange, Job } from '@studio/shared';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { reloadClients } from './clients-query';
import { JOBS_KEY } from './jobs-cache';

/** Every client-Instagram query starts with this. */
export const CLIENT_INSTAGRAM_KEY = ['client-instagram'] as const;

/** Every job-reel query starts with this. Its own root: invalidating ['jobs'] matches by prefix. */
export const JOB_REEL_KEY = ['job-reel'] as const;

/** The reel linked to one job, with its numbers: ['job-reel', jobId]. */
export function jobReelKey(jobId: string): readonly ['job-reel', string] {
  return ['job-reel', jobId] as const;
}

/** One client's Instagram for one range: ['client-instagram', clientId, range]. */
export function clientInstagramKey(
  clientId: string,
  range: InstagramRange,
): readonly ['client-instagram', string, InstagramRange] {
  return ['client-instagram', clientId, range] as const;
}

/** Every range of one client's Instagram: ['client-instagram', clientId]. */
export function clientInstagramClientKey(clientId: string): readonly ['client-instagram', string] {
  return ['client-instagram', clientId] as const;
}

/**
 * Loads the job list again when a video of the client (any client when `clientId` is left out) has
 * a reel linked to it: its delivery carries the reel's plays (`reelPlays`), which an Uploaded row
 * says, and a scan changes them. Nothing when no such video is in the list, so a scan of a client
 * with no linked reels costs the jobs page nothing.
 */
function reloadLinkedJobs(queryClient: QueryClient, clientId?: string): Promise<void> {
  const jobs = queryClient.getQueryData<Job[]>(JOBS_KEY) ?? [];
  const linked = jobs.some(
    (job) =>
      (clientId === undefined || job.clientId === clientId) &&
      job.delivery?.uploadedAt !== undefined,
  );
  return linked ? queryClient.invalidateQueries({ queryKey: JOBS_KEY }) : Promise.resolve();
}

/**
 * The client's Instagram changed on the server: loads it again, in every range somebody has loaded
 * (nothing when nobody has), and the client list, the job sheets' reel numbers and the plays on the
 * client's Uploaded rows with it.
 */
export async function reloadClientInstagram(
  queryClient: QueryClient,
  clientId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: clientInstagramClientKey(clientId) }),
    queryClient.invalidateQueries({ queryKey: JOB_REEL_KEY }),
    reloadClients(queryClient),
    reloadLinkedJobs(queryClient, clientId),
  ]);
}

/** A hello (or a link or unlink): every client's Instagram loads again, and the list and reel numbers. */
export async function reloadAllClientInstagram(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: CLIENT_INSTAGRAM_KEY }),
    queryClient.invalidateQueries({ queryKey: JOB_REEL_KEY }),
    reloadClients(queryClient),
  ]);
}

/** What an optimistic change replaced: each cached client's Instagram as it was, to put back. */
export type ClientInstagramSnapshot = ReadonlyArray<readonly [QueryKey, ClientInstagram]>;

/**
 * An optimistic change to every client's Instagram that is cached (a reel's shortcode is the
 * engine's alone, so the pages that do not hold the reel come back unchanged and are not written).
 * Loads in flight are cancelled first, so an answer that left before the change cannot wipe it.
 * Returns what was replaced, for {@link restoreClientInstagram}.
 */
export async function patchClientInstagram(
  queryClient: QueryClient,
  patch: (data: ClientInstagram) => ClientInstagram,
): Promise<ClientInstagramSnapshot> {
  await queryClient.cancelQueries({ queryKey: CLIENT_INSTAGRAM_KEY });
  const replaced: Array<readonly [QueryKey, ClientInstagram]> = [];
  for (const [key, data] of queryClient.getQueriesData<ClientInstagram>({
    queryKey: CLIENT_INSTAGRAM_KEY,
  })) {
    if (data === undefined) continue;
    const next = patch(data);
    if (next === data) continue;
    queryClient.setQueryData<ClientInstagram>(key, next);
    replaced.push([key, data]);
  }
  return replaced;
}

/** Puts back what {@link patchClientInstagram} replaced (the change was refused). */
export function restoreClientInstagram(
  queryClient: QueryClient,
  snapshot: ClientInstagramSnapshot,
): void {
  for (const [key, data] of snapshot) queryClient.setQueryData<ClientInstagram>(key, data);
}
