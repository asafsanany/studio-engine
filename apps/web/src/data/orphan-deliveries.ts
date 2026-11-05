// The delivered videos whose folder is gone and that are not paid yet (CVP-204): the second list
// the Jobs page reads next to the jobs. A delivery outlives its job, and the owner decided such a video
// is still payable, so the page lists it (as a row marked `folderDeleted`, see `useListedJobs`)
// until it is paid or taken back.
//
// The server says over SSE when the list may have changed: `money.changed` (every payment and
// every Not delivered yet sends it, and a delivery may have been made) and `job.remove` (a
// delivered job's folder was deleted, which is how a video gets here). Like the jobs list it is
// fresh until then and is not polled. Rules for the cached list are plain functions here.

import {
  type FolderDeletedJob,
  isFolderDeleted,
  type Job,
  type OrphanDelivery,
} from '@studio/shared';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import type { Api, ApiError } from './api';

/** The TanStack Query key of the list of unpaid videos whose folder is gone. */
export const ORPHANS_KEY = ['orphan-deliveries'] as const;

/** Options of the `['orphan-deliveries']` query: fresh until the server says otherwise. */
export function orphanDeliveriesQueryOptions(api: Api) {
  return queryOptions<OrphanDelivery[], ApiError>({
    queryKey: ORPHANS_KEY,
    queryFn: ({ signal }) => api.listOrphanDeliveries(signal),
    staleTime: Infinity,
  });
}

/**
 * The list may have changed on the server: loads it again. Does nothing while nobody shows it
 * (the next `useOrphanDeliveries()` loads it).
 */
export function reloadOrphanDeliveries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ORPHANS_KEY });
}

/** The delivery a folder-deleted row stands for. */
function orphanOf(job: FolderDeletedJob): OrphanDelivery | null {
  return job.delivery === null
    ? null
    : {
        id: job.id,
        clientId: job.clientId,
        client: job.client,
        name: job.name,
        relPath: job.relPath,
        delivery: job.delivery,
      };
}

/**
 * `list` after these videos changed: one that is still delivered and not paid replaces its entry
 * (or joins the list); one that was paid, or whose delivery was taken off (`delivery` is `null`),
 * leaves it. The order is kept, and a newcomer goes first (the server lists the newest delivery
 * first, and the page sorts anyway).
 */
export function applyOrphanChanges(
  list: readonly OrphanDelivery[],
  changed: readonly FolderDeletedJob[],
): OrphanDelivery[] {
  let next = [...list];
  for (const job of changed) {
    const orphan = orphanOf(job);
    const index = next.findIndex((existing) => existing.id === job.id);
    if (orphan === null || orphan.delivery.paidOn != null) {
      next = next.filter((existing) => existing.id !== job.id);
    } else if (index === -1) {
      next = [orphan, ...next];
    } else {
      next[index] = orphan;
    }
  }
  return next;
}

/**
 * Puts the folder-deleted videos among `jobs` (the answer of a payment or of Not delivered yet)
 * into the cached list, and loads it again. The other jobs are not this list's business.
 */
export function applyFolderDeletedJobs(queryClient: QueryClient, jobs: readonly Job[]): void {
  const changed = jobs.filter(isFolderDeleted);
  if (changed.length === 0) return;
  queryClient.setQueryData<OrphanDelivery[]>(ORPHANS_KEY, (list) =>
    list === undefined ? list : applyOrphanChanges(list, changed),
  );
  void reloadOrphanDeliveries(queryClient);
}
