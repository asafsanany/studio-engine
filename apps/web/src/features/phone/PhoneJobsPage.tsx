import type { Job } from '@studio/shared';
import { Link, useRouter } from '@tanstack/react-router';
import { Search, Settings2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { type StoreApi, useStore } from 'zustand';
import { Settings } from '@/components/icons';
import { EngineReconnecting } from '@/components/shell/EngineReconnecting';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { jobsUnreachable, useEngineReconnecting, useListedJobs } from '@/data';
import { openJobSheet } from '@/features/job-sheet/job-sheet-search';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { archivedCount, tabCounts } from '@/features/jobs/filtering';
import { EmptyJobs, UnreachableJobs } from '@/features/jobs/JobsListStates';
import { TAB_LABELS } from '@/features/jobs/JobsToolbar';
import { RefusedActionsHost } from '@/features/jobs/RefusedActionsHost';
import { lastUpdatedOrder } from '@/features/jobs/sorting';
import { tableBodyState } from '@/features/jobs/table-body';
import { matchingJobs } from '@/features/jobs/use-jobs-list';
import { cn } from '@/lib/utils';
import { isStatusTab, type JobsUiStore, jobsUiStore, STATUS_TABS } from '@/stores/jobs-ui';
import { InstallCard } from './InstallCard';
import { PhoneJobsList, PhoneLoadingRows } from './PhoneJobsList';
import { PhoneViewSheet } from './PhoneViewSheet';
import { phoneArchivedLine, phoneArchivedLineLead } from './phone-jobs';
import { type PhoneUiStore, phoneUiStore } from './phone-ui';
import { NotifyCard } from './push/NotifyCard';

const NO_JOBS: readonly Job[] = [];

/**
 * The jobs list on the phone (boards MJobs, MJobsView, MJobsSearch): the page `/` and `/jobs` show
 * in place of the Mac's `JobsPage` on the phone layout. This is the data around `PhoneJobsView`:
 * the live list (`useListedJobs`, which also holds the unpaid videos whose folder was deleted),
 * whether the engine is out of reach, and the host that tells a refused action's note as a message
 * (the shell draws the messages). A tap on a row asks for the job's sheet (`?job=`); the phone
 * sheet's host (PH4) opens it, and holds the "Mark paid" sheet a delivered row's button asks for.
 */
export function PhoneJobsPage() {
  const router = useRouter();
  const { data: jobs, isError, failureCount, refetch } = useListedJobs();
  const reconnecting = useEngineReconnecting();
  return (
    <>
      <PhoneJobsView
        jobs={jobs}
        failed={jobsUnreachable({ data: jobs, isError, failureCount })}
        onRetry={() => void refetch()}
        reconnecting={reconnecting}
        onOpenJob={(jobId) => void openJobSheet(router, jobId)}
      />
      {/* Only watches: the shell draws the messages, and holds Mark paid's sheet. */}
      <RefusedActionsHost jobs={jobs} toaster={false} />
    </>
  );
}

export interface PhoneJobsViewProps {
  /** The job list: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** The first load failed (the engine cannot be reached). Read only while `jobs` is `undefined`. */
  failed?: boolean;
  /** Runs the "Try again" link of the unreachable state. */
  onRetry?: () => void;
  /** The engine has been out of reach for a while: the header says so. */
  reconnecting?: boolean;
  /** A tap on a row. */
  onOpenJob: (jobId: string) => void;
  /** The stores the page is controlled by. Tests pass their own; the app uses the shared ones. */
  store?: StoreApi<JobsUiStore>;
  phoneStore?: StoreApi<PhoneUiStore>;
  /** How long the first load may take before skeleton rows appear (default 250 ms). */
  skeletonDelayMs?: number;
}

/**
 * The page itself. Top to bottom, in a block that stays under the top of the screen while the rows
 * scroll: the header ("Jobs" and the ghost buttons View, Search and Settings, each 44 px), the
 * "Reconnecting to the engine…" line, the search field (40 px, 16 px text, open under the header)
 * and the seven status tabs with their counts, which scroll sideways. Then the Add to Home Screen
 * card (first visit in an iPhone's browser only) or, in the Home Screen app, the Turn on
 * notifications card, then the rows, flat or By client, and, with Show archived off, a line that
 * offers the archive.
 *
 * The list is the Mac's (`matchingJobs`: the tab, the search, Show archived, last updated first)
 * with every row shown, no pager. The status tab, the search and Show archived live in the Jobs UI
 * store the Mac's page uses, so Show archived is the same remembered switch; By client lives in
 * the phone's store (on by default, remembered). The page reaches the screen's edges: the shell
 * pads its page area, so the page takes that padding back.
 */
export function PhoneJobsView({
  jobs,
  failed = false,
  onRetry,
  reconnecting = false,
  onOpenJob,
  store = jobsUiStore,
  phoneStore = phoneUiStore,
  skeletonDelayMs = SKELETON_DELAY_MS,
}: PhoneJobsViewProps) {
  const statusTab = useStore(store, (state) => state.statusTab);
  const setStatusTab = useStore(store, (state) => state.setStatusTab);
  const search = useStore(store, (state) => state.search);
  const setSearch = useStore(store, (state) => state.setSearch);
  const showArchived = useStore(store, (state) => state.showArchived);
  const setShowArchived = useStore(store, (state) => state.setShowArchived);
  const byClient = useStore(phoneStore, (state) => state.byClient);
  const setByClient = useStore(phoneStore, (state) => state.setByClient);

  const [viewOpen, setViewOpen] = useState(false);
  // The field is open when a search is already typed (it is kept while the person is on another page).
  const [searchOpen, setSearchOpen] = useState(search !== '');
  const [focusSearch, setFocusSearch] = useState(false);
  const searchId = useId();

  const ordered = useMemo(() => lastUpdatedOrder(jobs ?? NO_JOBS), [jobs]);
  const matching = useMemo(
    () => matchingJobs(ordered, { tab: statusTab, search, showArchived }),
    [ordered, statusTab, search, showArchived],
  );
  const archivedLine = useMemo(
    () => phoneArchivedLine(ordered, { tab: statusTab, search, showArchived }, matching.length),
    [ordered, matching, statusTab, search, showArchived],
  );
  const counts = jobs ? tabCounts(jobs, showArchived) : undefined;

  const bodyState = tableBodyState({ jobs, failed, matching: matching.length });
  const showSkeleton = useDelayedFlag(bodyState === 'loading', skeletonDelayMs);

  return (
    <div
      data-slot="phone-jobs-page"
      className="-mx-4 -mt-4 flex flex-col [-webkit-tap-highlight-color:transparent]"
    >
      <div
        data-slot="phone-jobs-top"
        // Stays at the top of the scroller (below the notch, which the shell pads) while the rows scroll.
        className="sticky top-0 z-10 bg-background"
      >
        <header className="flex h-[52px] items-center pr-1.5 pl-4">
          <h1 className="flex-1 text-2xl leading-tight font-semibold tracking-[-0.02em]">Jobs</h1>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="View"
            aria-haspopup="dialog"
            aria-expanded={viewOpen}
            onClick={() => setViewOpen(true)}
            className={cn('size-11', viewOpen && 'bg-accent dark:bg-accent')}
          >
            <Settings2 className="size-5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Search jobs and clients"
            aria-expanded={searchOpen}
            onClick={() => {
              // Closing the field ends the search.
              if (searchOpen) setSearch('');
              setFocusSearch(!searchOpen);
              setSearchOpen(!searchOpen);
            }}
            className={cn('size-11', searchOpen && 'bg-accent dark:bg-accent')}
          >
            <Search className="size-5" aria-hidden="true" />
          </Button>
          <Button asChild variant="ghost" size="icon" className="size-11">
            <Link to="/settings" aria-label="Settings">
              <Settings className="size-5" aria-hidden="true" />
            </Link>
          </Button>
        </header>

        <EngineReconnecting reconnecting={reconnecting} className="px-4 has-[p]:pb-2" />

        {searchOpen && (
          <div className="px-4 pb-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
              />
              <label htmlFor={searchId} className="sr-only">
                Search jobs and clients
              </label>
              <Input
                id={searchId}
                type="search"
                dir="auto"
                // Opened by a tap on Search, the keyboard is wanted at once; a field that was
                // already open when the page came back (a search kept) does not raise it.
                autoFocus={focusSearch}
                autoComplete="off"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-10 border-input bg-white/[0.045] pl-9 text-base shadow-none focus-visible:ring-0 dark:bg-white/[0.045]"
              />
            </div>
          </div>
        )}

        <div className="overflow-x-auto px-3 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Tabs
            value={statusTab}
            onValueChange={(value) => {
              if (isStatusTab(value)) setStatusTab(value);
            }}
            className="w-max"
          >
            <TabsList
              variant="ghost"
              aria-label="Filter by status"
              className="group-data-[orientation=horizontal]/tabs:h-9"
            >
              {STATUS_TABS.map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  count={counts?.[tab]}
                  // There is no panel to point at: the list below is shared by every tab.
                  aria-controls={undefined}
                  className="group-data-[variant=ghost]/tabs-list:h-9"
                >
                  {TAB_LABELS[tab]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Under the title (board MFirstOpen): it scrolls away with the rows, and shows only in an
          iPhone's browser, never in the Home Screen app. */}
      <InstallCard />
      {/* The same place in the Home Screen app (board MTurnOn), until notifications are on. */}
      <NotifyCard />

      <div className="pb-3">
        {bodyState === 'loading' && showSkeleton && <PhoneLoadingRows />}
        {bodyState === 'unreachable' && <UnreachableJobs onRetry={() => onRetry?.()} />}
        {bodyState === 'empty' && <EmptyJobs />}
        {bodyState === 'no-match' && (
          <p className="px-4 pt-6 pb-2 text-muted-foreground">No jobs match.</p>
        )}
        {bodyState === 'rows' && (
          <PhoneJobsList jobs={matching} byClient={byClient} onOpen={onOpenJob} />
        )}
        {archivedLine !== null && (
          <p className="flex min-h-11 items-center px-4 text-[13px] text-muted-foreground">
            {phoneArchivedLineLead(archivedLine)}
            <Button
              type="button"
              variant="link"
              onClick={() => setShowArchived(true)}
              className="-ml-1 h-11 px-2 text-[13px] font-medium text-foreground underline underline-offset-3"
            >
              Show
            </Button>
          </p>
        )}
      </div>

      <PhoneViewSheet
        open={viewOpen}
        onOpenChange={setViewOpen}
        byClient={byClient}
        onByClientChange={setByClient}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        archivedCount={jobs ? archivedCount(jobs) : undefined}
      />
    </div>
  );
}
