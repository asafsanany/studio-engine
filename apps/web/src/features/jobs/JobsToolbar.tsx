import type { Job } from '@studio/shared';
import { Search } from 'lucide-react';
import { useId } from 'react';
import { type StoreApi, useStore } from 'zustand';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  isStatusTab,
  type JobsUiStore,
  jobsUiStore,
  STATUS_TABS,
  type StatusTab,
} from '@/stores/jobs-ui';
import { archivedCount, tabCounts } from './filtering';
import { JobsViewMenu } from './JobsViewMenu';

export interface JobsToolbarProps {
  /** The full job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** The store the toolbar edits. Tests pass their own; the app uses the shared one. */
  store?: StoreApi<JobsUiStore>;
}

/** The tab names, as on the Jobs board. */
export const TAB_LABELS: Readonly<Record<StatusTab, string>> = {
  all: 'All',
  progress: 'In progress',
  review: 'Review',
  approved: 'Approved',
  delivered: 'Delivered',
  uploaded: 'Uploaded',
  paid: 'Paid',
  attention: 'Needs attention',
};

/**
 * The row between the page title and the list: the status tabs on the left (each with how many
 * jobs it holds) and, on the right, the View menu (By client, Show archived) and the search box. It wraps onto
 * a second line when the window is too narrow for both. Everything it changes lives in the Jobs UI
 * store, which the list reads, so the toolbar and the list never talk to each other directly.
 */
export function JobsToolbar({ jobs, store = jobsUiStore }: JobsToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <StatusTabs jobs={jobs} store={store} />
      <div className="flex items-center gap-2">
        <ViewMenu jobs={jobs} store={store} />
        <JobsSearch store={store} />
      </div>
    </div>
  );
}

/** View › By client and Show archived, over the store's switches, with how many jobs are archived. */
function ViewMenu({
  jobs,
  store,
}: {
  jobs: readonly Job[] | undefined;
  store: StoreApi<JobsUiStore>;
}) {
  const byClient = useStore(store, (state) => state.byClient);
  const setByClient = useStore(store, (state) => state.setByClient);
  const showArchived = useStore(store, (state) => state.showArchived);
  const setShowArchived = useStore(store, (state) => state.setShowArchived);
  return (
    <JobsViewMenu
      byClient={byClient}
      onByClientChange={setByClient}
      showArchived={showArchived}
      onShowArchivedChange={setShowArchived}
      archivedCount={jobs ? archivedCount(jobs) : undefined}
    />
  );
}

/**
 * All · In progress · Review · Approved · Delivered · Uploaded · Paid · Needs attention, as quiet text tabs (the ghost list) with
 * the count after each name. The numbers count the whole list, whatever the search says (archived
 * jobs only while Show archived is on), and are left out until the list has loaded (a 0 there would
 * be a lie). Arrow keys move between the tabs;
 * Tab moves on to the search box.
 */
function StatusTabs({
  jobs,
  store,
}: {
  jobs: readonly Job[] | undefined;
  store: StoreApi<JobsUiStore>;
}) {
  const statusTab = useStore(store, (state) => state.statusTab);
  const setStatusTab = useStore(store, (state) => state.setStatusTab);
  const showArchived = useStore(store, (state) => state.showArchived);
  const counts = jobs ? tabCounts(jobs, showArchived) : undefined;

  return (
    <Tabs
      value={statusTab}
      onValueChange={(value) => {
        if (isStatusTab(value)) setStatusTab(value);
      }}
    >
      <TabsList variant="ghost" aria-label="Filter by status">
        {STATUS_TABS.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            count={counts?.[tab]}
            // There is no panel to point at: the list below is shared by every tab.
            aria-controls={undefined}
          >
            {TAB_LABELS[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * The search box: 200 px wide and 32 px high, a transparent field with a 1 px border and a
 * magnifier inside, `type="search"` (so the browser adds its clear button). It writes every
 * keystroke straight to the store: filtering twelve jobs is instant, and a controlled input fed
 * synchronously keeps Hebrew and other IME composition intact.
 */
function JobsSearch({ store }: { store: StoreApi<JobsUiStore> }) {
  const id = useId();
  const search = useStore(store, (state) => state.search);
  const setSearch = useStore(store, (state) => state.setSearch);

  return (
    <div className="relative w-50">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
      />
      <label htmlFor={id} className="sr-only">
        Search
      </label>
      <Input
        id={id}
        type="search"
        placeholder="Search"
        autoComplete="off"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="h-8 border-border bg-transparent pl-8.5 shadow-none dark:bg-transparent"
      />
    </div>
  );
}
