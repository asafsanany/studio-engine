import { isArchived, type Job } from '@studio/shared';
import { useEffect, useMemo } from 'react';
import { type StoreApi, useStore } from 'zustand';
import type { JobsUiStore, StatusTab } from '@/stores/jobs-ui';
import { byClientOrder, groupByClient } from './by-client';
import { archivedMatchCount, filterJobs, visibleJobs } from './filtering';
import { lastPageIndex, PAGE_SIZE } from './pagination';
import { lastUpdatedOrder } from './sorting';

const NO_JOBS: readonly Job[] = [];

/**
 * Whether a job belongs to the list a page scopes to: a client's page (`clientId`) holds that
 * client's jobs, and a series page (`seriesId`, always with its `clientId`) only the episodes of
 * that series. With neither, every job is in scope.
 */
export function inListScope(
  job: Pick<Job, 'clientId' | 'seriesId'>,
  { clientId, seriesId }: { clientId?: string; seriesId?: string },
): boolean {
  return (
    (clientId === undefined || job.clientId === clientId) &&
    (seriesId === undefined || job.seriesId === seriesId)
  );
}

/** What narrows the list: the status tab and search, Show archived, and a client's (or series') page. */
export interface JobsListFilter {
  tab: StatusTab;
  search: string;
  showArchived: boolean;
  /** A client's page: only that client's jobs. The tab and the search do not apply there. */
  clientId?: string;
  /** With `clientId`: only the episodes of this series. */
  seriesId?: string;
  /**
   * View › By client: the jobs come client by client (`byClientOrder`). Only the Jobs page has it;
   * a client's or a series' page is one client's and stays in the order of `lastUpdatedOrder`.
   */
  byClient?: boolean;
  /**
   * The job that is open under its row (`?job=`). It stays in the list while it is open, at its
   * place, even when the tab, the search or Show archived would leave it out: a job approved from
   * the Review tab does not vanish from under the person, and a link opens its job on any tab.
   */
  openId?: string | null;
}

/**
 * `found` (some of `all`, in its order) with the open job put back at its place in `all` when the
 * filter left it out. A job that is not in `all` (another client's, or no job at all) is not added.
 */
function withOpenJob(
  all: readonly Job[],
  found: readonly Job[],
  openId: string | null,
): readonly Job[] {
  if (openId === null || found.some((job) => job.id === openId)) return found;
  if (!all.some((job) => job.id === openId)) return found;
  const kept = new Set(found.map((job) => job.id)).add(openId);
  return all.filter((job) => kept.has(job.id));
}

/**
 * The jobs the list shows, in the list's order, before they are cut into pages. `ordered` is the
 * whole job list in `lastUpdatedOrder`. The list and the host of the open job (which turns the
 * list to the open job's page) both read it from here, so they never disagree about where it is.
 */
export function matchingJobs(
  ordered: readonly Job[],
  {
    tab,
    search,
    showArchived,
    clientId,
    seriesId,
    byClient = false,
    openId = null,
  }: JobsListFilter,
): readonly Job[] {
  if (clientId !== undefined) {
    const scoped = ordered.filter((job) => inListScope(job, { clientId, seriesId }));
    return withOpenJob(scoped, visibleJobs(scoped, showArchived), openId);
  }
  const found = withOpenJob(ordered, filterJobs(ordered, { tab, search, showArchived }), openId);
  return byClient ? byClientOrder(found) : found;
}

export interface UseJobsListOptions {
  /** The jobs from the data layer; `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** The Jobs UI store the list is controlled by (the status tab, the search, the page and Show archived). */
  store: StoreApi<JobsUiStore>;
  /**
   * Show only this client's jobs (the client's page). The status tab and the search do not apply
   * there, because that page has neither.
   */
  clientId?: string;
  /** With `clientId`: show only the episodes of this series (the series page). */
  seriesId?: string;
  /** The job open under its row, which the list keeps while it is open (see `matchingJobs`). */
  openId?: string | null;
}

/**
 * The line under the list that offers the archive. `show` is "N archived · Show" (it turns Show
 * archived on) and `hide` is "Hide archived" (it turns it off).
 */
export type ArchivedLine =
  | {
      kind: 'show';
      /** How many archived jobs it would bring in. */
      count: number;
      /** The list already has rows, so the line says "N more archived". */
      more: boolean;
    }
  | { kind: 'hide' };

/**
 * The jobs of one page of the list, in the order the list shows them: last updated first (see
 * `lastUpdatedOrder`), narrowed by the store's status tab and search (`filterJobs`), or, with a
 * `clientId`, by the client, then cut into pages of `PAGE_SIZE`. With Show archived off, archived
 * jobs are in none of it: not in a tab, not in the total, not in a page.
 *
 * The page index is kept inside the last page, so removing jobs while on page 2 shows page 1. The
 * store resets the page when the tab or the search changes; live updates never send the person
 * back to page 1.
 *
 * With View › By client on (the Jobs page only), the page is every matching job, client by client
 * (`groups`: one per client, the clients in order of their latest activity), and there is one page:
 * a client is never split between pages, as the phone's list has none. The stored page is left as
 * it was, for the flat list to come back to.
 *
 * `archivedLine` is what the archive offers under the list:
 * - Jobs page, Show archived off, a search typed that archived jobs of the tab match: "N more
 *   archived · Show" (just "N archived · Show" when nothing else matched).
 * - A client's page, Show archived off, the client has archived jobs: "N archived · Show"; on:
 *   "Hide archived". A series page counts only the series' archived episodes.
 * - Otherwise none: on the Jobs page the View menu is the way back.
 */
export function useJobsList({
  jobs,
  store,
  clientId,
  seriesId,
  openId = null,
}: UseJobsListOptions) {
  const statusTab = useStore(store, (s) => s.statusTab);
  const search = useStore(store, (s) => s.search);
  const showArchived = useStore(store, (s) => s.showArchived);
  const byClientOn = useStore(store, (s) => s.byClient);
  const storedPageIndex = useStore(store, (s) => s.pageIndex);
  const setPageIndex = useStore(store, (s) => s.setPageIndex);
  const byClient = byClientOn && clientId === undefined;

  const ordered = useMemo(() => lastUpdatedOrder(jobs ?? NO_JOBS), [jobs]);
  const matching = useMemo(
    () =>
      matchingJobs(ordered, {
        tab: statusTab,
        search,
        showArchived,
        clientId,
        seriesId,
        byClient,
        openId,
      }),
    [ordered, statusTab, search, showArchived, clientId, seriesId, byClient, openId],
  );
  // `matching` is already client by client, so the groups cut it where the client changes.
  const groups = useMemo(() => (byClient ? groupByClient(matching) : null), [byClient, matching]);

  const archivedLine = useMemo((): ArchivedLine | null => {
    if (clientId === undefined) {
      if (showArchived) return null;
      const count = archivedMatchCount(ordered, { tab: statusTab, search });
      return count === 0 ? null : { kind: 'show', count, more: matching.length > 0 };
    }
    const count = ordered.filter(
      (job) => inListScope(job, { clientId, seriesId }) && isArchived(job),
    ).length;
    if (count === 0) return null;
    return showArchived ? { kind: 'hide' } : { kind: 'show', count, more: false };
  }, [ordered, matching, statusTab, search, showArchived, clientId, seriesId]);

  const lastPage = byClient ? 0 : lastPageIndex(PAGE_SIZE, matching.length);
  const pageIndex = Math.min(storedPageIndex, lastPage);
  useEffect(() => {
    if (!byClient && pageIndex !== storedPageIndex) setPageIndex(pageIndex);
  }, [byClient, pageIndex, storedPageIndex, setPageIndex]);
  const pageJobs = useMemo(
    () =>
      byClient ? matching : matching.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE),
    [byClient, matching, pageIndex],
  );

  return {
    /** The jobs on this page, in order. */
    pageJobs,
    /** The page cut into one group per client, with By client on; otherwise `null`. */
    groups,
    /** Jobs after the tab and search, before paging. */
    total: matching.length,
    pageCount: lastPage + 1,
    pageIndex,
    setPageIndex,
    archivedLine,
  };
}
