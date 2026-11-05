import { useNavigate } from '@tanstack/react-router';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useJobsUiStore } from '@/stores/jobs-ui';
import { AppBreadcrumb } from './AppBreadcrumb';
import type { Crumb } from './breadcrumbs';
import { EngineReconnecting } from './EngineReconnecting';
import { EngineSummary } from './EngineSummary';
import type { SummaryJob } from './engine-summary';

/**
 * The 56 px bar above every page: breadcrumb on the left, engine summary on the right (left out
 * while `jobs` is `undefined`: the list has not loaded, or the engine cannot be reached). A click
 * on a count opens the Jobs page on that status tab, from whichever page it is clicked on.
 *
 * When `reconnecting` is true (the engine went away after the list had loaded) the summary gives
 * way to "Reconnecting to the engine…": its counts are as last known, and showing them as if they
 * were live is what the notice is there to avoid. Without a list there is nothing stale to
 * replace, and the page body already says "Can't reach the engine.", so the notice stays out.
 */
export function AppHeader({
  crumbs,
  jobs,
  reconnecting = false,
}: {
  crumbs: readonly Crumb[];
  jobs: ReadonlyArray<SummaryJob> | undefined;
  reconnecting?: boolean;
}) {
  const stale = reconnecting && jobs !== undefined;
  const setStatusTab = useJobsUiStore((state) => state.setStatusTab);
  const navigate = useNavigate();

  return (
    <header className="flex h-14 flex-none items-center justify-between gap-4 border-b px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Below 768 px the sidebar is an off-canvas sheet; this opens it. */}
        <SidebarTrigger className="-ml-2 md:hidden" />
        <AppBreadcrumb crumbs={crumbs} />
      </div>
      <div className="flex min-w-0 items-center justify-end">
        <EngineReconnecting reconnecting={stale} />
        {!stale && (
          <EngineSummary
            jobs={jobs}
            onSelectTab={(tab) => {
              setStatusTab(tab);
              void navigate({ to: '/jobs' });
            }}
          />
        )}
      </div>
    </header>
  );
}
