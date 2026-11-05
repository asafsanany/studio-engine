import type { ClientRow, Job } from '@studio/shared';
import { useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { SidebarProvider } from '@/components/ui/sidebar';
import { WhatsNew } from '@/components/whats-new/WhatsNew';
import {
  useAnalyticsEnabled,
  useDmsEnabled,
  useFontsEnabled,
  useGraphicName,
  useGraphicsEnabled,
  useLutsEnabled,
} from '@/data';
import { readSidebarOpen } from '@/lib/sidebar-state';
import { cn } from '@/lib/utils';
import { AppHeader } from './AppHeader';
import { AppSidebar } from './AppSidebar';
import { breadcrumbsFor, graphicIdOfPath } from './breadcrumbs';
import { fillsWindow } from './fill-pages';

/**
 * The frame every page lives in: sidebar on the left; header (breadcrumb + engine summary) and
 * the page content on the right. The breadcrumb follows the route. `jobs` feeds the header's
 * engine summary, and `clients` the name of the client whose page is open; each is `undefined`
 * until its list has loaded (the summary stays out; the name reads "Client"). `reconnecting` swaps the summary for the "Reconnecting
 * to the engine…" notice (see AppHeader). It also hosts the "What's new" dialog, which opens on
 * load when the app has a version the user has not seen. The content area spaces its children
 * 16 px apart, except on the pages that fill the window (see `fillsWindow`).
 */
export function AppShell({
  jobs,
  clients,
  reconnecting,
  children,
}: {
  jobs: readonly Job[] | undefined;
  clients: readonly ClientRow[] | undefined;
  reconnecting?: boolean;
  children: ReactNode;
}) {
  // shadcn writes the open/closed state to a cookie but never reads it: restore it here.
  const [defaultOpen] = useState(readSidebarOpen);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const analytics = useAnalyticsEnabled();
  // The Graphics page and the open graphic's name (from what is cached) for the trail.
  const graphics = useGraphicsEnabled();
  const graphicName = useGraphicName(graphicIdOfPath(pathname));
  const luts = useLutsEnabled();
  const fonts = useFontsEnabled();
  const dms = useDmsEnabled();
  const crumbs = useMemo(
    () =>
      breadcrumbsFor(
        pathname,
        clients,
        analytics,
        { enabled: graphics, name: graphicName },
        luts,
        fonts,
        dms,
      ),
    [pathname, clients, analytics, graphics, graphicName, luts, fonts, dms],
  );

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <AppHeader crumbs={crumbs} jobs={jobs} reconnecting={reconnecting} />
        <main
          className={cn(
            'flex flex-col px-6 pt-6 pb-10',
            // A page that fills the window has no neighbour to be spaced from: the toaster beside it
            // is empty, and its gap would put the document 16 px past the window.
            fillsWindow(pathname) ? 'gap-0' : 'gap-4',
          )}
        >
          {children}
        </main>
      </div>
      <WhatsNew />
    </SidebarProvider>
  );
}
