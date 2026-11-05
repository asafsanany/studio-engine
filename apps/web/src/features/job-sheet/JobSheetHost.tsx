import type { Job } from '@studio/shared';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { type StoreApi, useStore } from 'zustand';
import { useJobSheetEnabled, useOrphanDeliveries } from '@/data';
import { PAGE_SIZE } from '@/features/jobs/pagination';
import { lastUpdatedOrder } from '@/features/jobs/sorting';
import { matchingJobs } from '@/features/jobs/use-jobs-list';
import { type JobsUiStore, jobsUiStore } from '@/stores/jobs-ui';
import { setOpenJobSheetId } from './job-sheet-open';
import { pageOfJob } from './job-sheet-order';
import { dropJobParam, jobIdOf, moveJobSheet, openJobSheet } from './job-sheet-search';
import { pendingSectionRequest, useSectionRequest } from './job-sheet-section';

const NO_JOBS: readonly Job[] = [];

export interface JobSheetHostProps {
  /** The job list the page's list is made from; `undefined` until it has arrived. */
  jobs: readonly Job[] | undefined;
  /** A client's page: the list there holds that client's jobs. */
  clientId?: string;
  /** A series' page: the list there holds that series' episodes. */
  seriesId?: string;
  /** The store the list is controlled by. Tests pass their own; the app uses the shared one. */
  store?: StoreApi<JobsUiStore>;
}

/**
 * What keeps the open job in order: mounted in `JobsListSection` next to the dialog hosts, so the
 * Jobs page, a client's page and a series page all have it. With the Job sheet switch off it is
 * nothing: rows open nothing and `?job=` is ignored. It draws nothing itself; the job opens under
 * its row (`JobRowPanel`).
 */
export function JobSheetHost(props: JobSheetHostProps) {
  return useJobSheetEnabled() ? <OpenJobHost {...props} /> : null;
}

/**
 * The open job is the address' `?job=<id>` (see job-sheet-search.ts for how it is opened, moved and
 * closed). The host tells the rows which one it is, and:
 *
 * - turns the list to the open job's page, once per job (the list keeps the open job even when its
 *   tab or search would leave it out, so a link opens it on any tab);
 * - takes `?job=` out of the address once the list has arrived and has no such job: an unknown id,
 *   another client's job on a client's page, or a job whose folder was removed while it was open;
 * - opens the job a row menu's "Versions…" asks for (`askForVersions`; the part opens itself).
 */
function OpenJobHost({ jobs, clientId, seriesId, store = jobsUiStore }: JobSheetHostProps) {
  const router = useRouter();
  const openId = useRouterState({ select: (state) => jobIdOf(state.location.search) });
  const orphans = useOrphanDeliveries();
  // Rows show their job when it is the open one.
  useEffect(() => {
    setOpenJobSheetId(openId);
  }, [openId]);
  useEffect(() => () => setOpenJobSheetId(null), []);

  // The row menu's "Versions…" asks for a job: open it there (the part opens itself).
  const sectionRequest = useSectionRequest();
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    const request = pendingSectionRequest();
    if (request === null || request !== sectionRequest || handledRequest.current === request.at) {
      return;
    }
    handledRequest.current = request.at;
    if (request.jobId === openId) return;
    void (openId === null
      ? openJobSheet(router, request.jobId)
      : moveJobSheet(router, request.jobId));
  }, [sectionRequest, openId, router]);

  // The jobs the list shows, all pages, in its order (the open job among them).
  const statusTab = useStore(store, (state) => state.statusTab);
  const search = useStore(store, (state) => state.search);
  const showArchived = useStore(store, (state) => state.showArchived);
  // By client is the Jobs page's alone: the list there is client by client, on one page.
  const byClient = useStore(store, (state) => state.byClient) && clientId === undefined;
  const shown = useMemo(
    () =>
      matchingJobs(lastUpdatedOrder(jobs ?? NO_JOBS), {
        tab: statusTab,
        search,
        showArchived,
        clientId,
        seriesId,
        byClient,
        openId,
      }).map((job) => job.id),
    [jobs, statusTab, search, showArchived, clientId, seriesId, byClient, openId],
  );

  // An address that names no job the list has opens nothing and is cleaned up, once the list is
  // whole (the videos without a folder have been asked for too).
  const listComplete = jobs !== undefined && !orphans.isPending;
  const missing = listComplete && openId !== null && !shown.includes(openId);
  useEffect(() => {
    if (missing) void dropJobParam(router);
  }, [missing, router]);

  // The list turns to the page of the open job, once per job: not when the list reorders under
  // it, which would take the person's place away. By client has no pages to turn.
  const turnedFor = useRef<string | null>(null);
  const shownId = openId !== null && shown.includes(openId) ? openId : null;
  useEffect(() => {
    if (shownId === null) {
      turnedFor.current = null;
      return;
    }
    if (turnedFor.current === shownId) return;
    turnedFor.current = shownId;
    if (byClient) return;
    const page = pageOfJob(shown, shownId, PAGE_SIZE);
    if (page !== null) store.getState().setPageIndex(page);
  }, [shownId, shown, store, byClient]);

  return null;
}
