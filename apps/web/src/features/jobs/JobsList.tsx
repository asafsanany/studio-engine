import { isFolderDeleted, type Job, jobStage } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import {
  type FocusEvent,
  type KeyboardEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type StoreApi, useStore } from 'zustand';
import { ClientAvatar } from '@/components/ClientAvatar';
import { RelativeTime } from '@/components/jobs/RelativeTime';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  JobSheetOpenerContext,
  useJobSheetOpener,
  useOpenJobSheetId,
} from '@/features/job-sheet/job-sheet-open';
import { SeriesMark } from '@/features/series/SeriesMark';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { type JobsUiStore, jobsUiStore } from '@/stores/jobs-ui';
import { ArchivedLine } from './ArchivedLine';
import { type ClientGroup, type TreeFlags, treeFlags } from './by-client';
import { ActionCell } from './cells/ActionCell';
import { ArchivedMarker } from './cells/ArchivedMarker';
import { JobEffortMarker } from './cells/EffortMarker';
import { FullTextTip } from './cells/FullTextTip';
import { JobNoteMarker } from './cells/JobNoteMarker';
import { SKELETON_DELAY_MS, useDelayedFlag } from './delayed-flag';
import { JobDetail } from './JobDetail';
import { JobRow } from './JobRow';
import { JobStatusIcon } from './JobStatusIcon';
import { EmptyJobs, LoadingJobRows, NoMatchingJobs, UnreachableJobs } from './JobsListStates';
import { JobsPagination } from './JobsPagination';
import { PAGE_SIZE } from './pagination';
import { applyRovingTabStops, rowToFocus } from './row-focus';
import { ROW_PANEL } from './row-open';
import { showsPagination, tableBodyState } from './table-body';
import { inListScope, useJobsList } from './use-jobs-list';

export interface JobsListProps {
  /** The job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /**
   * The first load failed (the server cannot be reached). Read only while `jobs` is `undefined`:
   * once a list has arrived it stays on screen, even if a later refetch fails.
   */
  failed?: boolean;
  /** Runs the "Try again" link of the unreachable state (the query's `refetch`). */
  onRetry?: () => void;
  /** The store the list is controlled by. Tests pass their own; the app uses the shared one. */
  store?: StoreApi<JobsUiStore>;
  /**
   * How long the first load may take before skeleton rows appear (default {@link SKELETON_DELAY_MS}).
   * Until then the list is empty, so a fast reload does not flash placeholders. 0 draws them at
   * once, which is what tests of the skeleton use.
   */
  skeletonDelayMs?: number;
  /**
   * Lists only this client's jobs, as on the client's page: the client's name is left out of the
   * rows, and the store's status tab and search are not applied (that page has neither). Everything
   * else is the same list.
   */
  clientId?: string;
  /**
   * With `clientId`: only the episodes of this series (a series page's Episodes tab). The rows,
   * the empty state and the archive line follow it; everything else is the same list.
   */
  seriesId?: string;
}

/**
 * Job: the name (500, one line with an ellipsis; the full name in a tooltip while it is cut off;
 * muted once the job is paid, which is done with, and for a video whose folder was deleted), the note marker and then the effort gauge right
 * after it when the job has a note or an effort level, then, for an episode of a series, the series
 * mark (`SeriesMark`), then the client's name in muted 13 px text, 10 px away and on the same
 * baseline. The client never shrinks before the name does. A client's own page leaves the client
 * out. Names are Latin, Hebrew or mixed, each in its own direction. An archived job (shown only with
 * Show archived on) has the small box after the client, with "Archived" for its name and the day in
 * its tooltip.
 */
function JobTitle({ job, showClient }: { job: Job; showClient: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <FullTextTip text={job.name}>
          <Bidi
            className={cn(
              'font-medium',
              (jobStage(job) === 'paid' || isFolderDeleted(job)) && 'text-muted-foreground',
            )}
          >
            {job.name}
          </Bidi>
        </FullTextTip>
        {job.note !== null && <JobNoteMarker note={job.note} />}
        <JobEffortMarker job={job} />
        {job.seriesId !== null && <SeriesMark job={job} />}
      </div>
      {showClient && (
        <Link
          to="/clients/$clientId"
          params={{ clientId: job.clientId }}
          className="shrink-0 cursor-pointer text-[13px] text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
        >
          <Bidi>{job.client}</Bidi>
        </Link>
      )}
      {job.archivedAt !== null && (
        <span className="flex shrink-0 self-center">
          <ArchivedMarker archivedAt={job.archivedAt} />
        </span>
      )}
    </div>
  );
}

/** One job: its row, with the five cells of the grid. */
function JobListItem({
  job,
  showClient,
  tabStop,
  tree,
}: {
  job: Job;
  showClient: boolean;
  tabStop: boolean;
  tree?: TreeFlags;
}) {
  return (
    <JobRow job={job} tabStop={tabStop} tree={tree}>
      <JobStatusIcon job={job} />
      <JobTitle job={job} showClient={showClient} />
      <JobDetail job={job} />
      {/* "2 h ago", right aligned in its 80 px column; the exact time is in its tooltip. */}
      <div className="text-right text-[13px] whitespace-nowrap">
        <RelativeTime iso={job.updatedAt} />
      </div>
      <ActionCell job={job} />
    </JobRow>
  );
}

/** The list itself: no header, no border, no lines, 2 px between the rows. */
const LIST_CLASSES = 'flex flex-col gap-0.5';

/**
 * One client in the By client view: a 40 px header with the client's avatar (24 px), its name, a
 * link to the client's page, and how many jobs are shown under it; then its rows, one step in. The
 * tree runs from under the header's avatar down the left (a 1 px line at x = 23.5 px) and into each
 * row with an elbow (`JobRow`); the last row ends the line at its elbow. The same header as the
 * phone's list, on the Mac's rows. The client's name is left out of the rows: the header says it.
 */
function ClientGroupRows({
  group,
  tabStopId,
}: {
  group: ClientGroup;
  /** The row that is the list's one Tab stop, if it is under this client. */
  tabStopId: string | null;
}) {
  return (
    <section aria-label={group.client}>
      <div className="relative flex h-10 items-center gap-2.5 pr-1.5 pl-3">
        <span
          aria-hidden="true"
          className="absolute top-[34px] bottom-0 left-[23.5px] border-l border-[#3F3F46]"
        />
        <ClientAvatar client={group.client} size="sm" />
        <Link
          to="/clients/$clientId"
          params={{ clientId: group.clientId }}
          className="min-w-0 cursor-pointer font-semibold outline-none hover:underline focus-visible:underline"
        >
          <bdi>{group.client}</bdi>
        </Link>
        <span className="text-muted-foreground tabular-nums">{group.jobs.length}</span>
      </div>
      <ul aria-label={`Jobs of ${group.client}`} className={LIST_CLASSES}>
        {group.jobs.map((job, index) => (
          <JobListItem
            key={job.id}
            job={job}
            showClient={false}
            tabStop={job.id === tabStopId}
            tree={treeFlags(index, group.jobs.length)}
          />
        ))}
      </ul>
    </section>
  );
}

/** The keys that move between rows. */
const ROW_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);

/** The row (its `data-job-id` element) an event came from, if it came from inside the list. */
function rowOfEvent(list: HTMLElement, target: EventTarget): HTMLElement | null {
  if (!(target instanceof Element) || !list.contains(target)) return null;
  // The open job's panel sits inside its row, but its keys are its own.
  if (target.closest(ROW_PANEL) !== null) return null;
  const row = target.closest<HTMLElement>('[data-job-id]');
  return row !== null && list.contains(row) ? row : null;
}

/**
 * The Jobs list: one quiet row per job, last updated first, ten to a page. A row is a status icon,
 * the name with the client's, a line of detail, the time and the one button that moves the job on;
 * everything else is in the row's right-click menu. The page title and the toolbar (status tabs and
 * search) belong to the page around it; under the list, the range and page controls show only when
 * there is more than one page.
 *
 * The list is controlled by the Jobs UI store over the live job list. It is one of: ten skeleton
 * rows (waiting for the first answer, and only once that has taken a quarter of a second; before
 * that nothing is drawn), "Can't reach the engine." with a retry link (the first answer never
 * came), "No jobs yet." (the list is empty), "No matching jobs." (the tab and search leave
 * nothing) or the job rows.
 *
 * Archived jobs are in the list only with Show archived on (View menu, shared with the client's
 * page). With it off, a quiet line under the list offers them when they would add rows
 * (`archivedLine`). "No jobs yet." means there is no job at all, archived or not: a list of only
 * archived jobs, hidden, says "No matching jobs."
 */
export function JobsList({
  jobs,
  failed = false,
  onRetry,
  store = jobsUiStore,
  skeletonDelayMs = SKELETON_DELAY_MS,
  clientId,
  seriesId,
}: JobsListProps) {
  // The job open under its row stays in the list while it is open (the host sets it; none while
  // the Job sheet switch is off or under the phone layout).
  const openId = useOpenJobSheetId();
  const { pageJobs, groups, total, pageCount, pageIndex, setPageIndex, archivedLine } = useJobsList(
    {
      jobs,
      store,
      clientId,
      seriesId,
      openId,
    },
  );
  const setShowArchived = useStore(store, (state) => state.setShowArchived);
  // "No jobs yet." means this client (or this series) has none, on a client's or series page.
  const scoped = useMemo(
    () =>
      clientId === undefined
        ? jobs
        : jobs?.filter((job) => inListScope(job, { clientId, seriesId })),
    [jobs, clientId, seriesId],
  );
  const bodyState = tableBodyState({ jobs: scoped, failed, matching: total });
  const showSkeleton = useDelayedFlag(bodyState === 'loading', skeletonDelayMs);

  // With the job sheet on, the rows are one Tab stop: the row that last had focus (the first one
  // before any did), moved with the arrow keys. A click or Enter on a row opens the job under it.
  const opener = useJobSheetOpener();
  const roving = opener !== null;
  // The element that holds the rows: the list, or, By client, the wrapper of the client groups.
  const list = useRef<HTMLElement | null>(null);
  const setList = useCallback((element: HTMLElement | null) => {
    list.current = element;
  }, []);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const tabStopId = pageJobs.some((job) => job.id === focusedId)
    ? focusedId
    : (pageJobs[0]?.id ?? null);
  // Not a dependency list: rows and their buttons change with the jobs, so every render checks.
  useLayoutEffect(() => {
    if (roving && list.current !== null) applyRovingTabStops(list.current, tabStopId);
  });

  // Focus and arrow keys over the rows, wherever they sit under `list`.
  const rovingHandlers = {
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (!roving || list.current === null) return;
      const row = rowOfEvent(list.current, event.target);
      if (row !== null) setFocusedId(row.dataset.jobId ?? null);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!roving || list.current === null || event.defaultPrevented) return;
      if (!ROW_KEYS.has(event.key)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const from = rowOfEvent(list.current, event.target);
      if (from === null) return;
      const to = rowToFocus(
        pageJobs.map((job) => job.id),
        from.dataset.jobId ?? null,
        event.key,
      );
      if (to === null) return;
      event.preventDefault();
      list.current.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(to)}"]`)?.focus();
    },
  };

  return (
    <JobSheetOpenerContext.Provider value={opener}>
      <TooltipProvider>
        {bodyState === 'loading' && (
          <ul aria-label="Jobs" aria-busy="true" className={LIST_CLASSES}>
            {showSkeleton && <LoadingJobRows />}
          </ul>
        )}
        {bodyState === 'unreachable' && <UnreachableJobs onRetry={() => onRetry?.()} />}
        {bodyState === 'empty' && <EmptyJobs />}
        {bodyState === 'no-match' && <NoMatchingJobs />}
        {bodyState === 'rows' && groups === null && (
          <ul aria-label="Jobs" className={LIST_CLASSES} ref={setList} {...rovingHandlers}>
            {pageJobs.map((job) => (
              <JobListItem
                key={job.id}
                job={job}
                showClient={clientId === undefined}
                tabStop={roving && job.id === tabStopId}
              />
            ))}
          </ul>
        )}
        {bodyState === 'rows' && groups !== null && (
          <div className="flex flex-col gap-3" ref={setList} {...rovingHandlers}>
            {groups.map((group) => (
              <ClientGroupRows
                key={group.clientId}
                group={group}
                tabStopId={roving ? tabStopId : null}
              />
            ))}
          </div>
        )}
        {/* Under the list, before the pages: the archive, offered when it would add rows. */}
        {archivedLine !== null && (
          <ArchivedLine
            line={archivedLine}
            onShow={() => setShowArchived(true)}
            onHide={() => setShowArchived(false)}
          />
        )}
        {showsPagination(bodyState) && pageCount > 1 && (
          <JobsPagination
            pageIndex={pageIndex}
            pageCount={pageCount}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPageIndex}
          />
        )}
      </TooltipProvider>
    </JobSheetOpenerContext.Provider>
  );
}
