// Helpers for tests of components that use the router (links, the open page's address). Not
// imported by the app. A router has to load its matches before it can be server-rendered, so these
// are async.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createTestQueryClient } from '@/data/test-utils';
import { createAppRouter } from '@/router';

/**
 * The real app (frame and pages) at `path`, over the data in `queryClient`. Put the job list in
 * with `queryClient.setQueryData(JOBS_KEY, jobs)` first.
 */
export async function renderApp(
  path: string,
  queryClient = createTestQueryClient(),
): Promise<string> {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/**
 * `node` on its own, but with the app's addresses behind it, so `Link`s, `useNavigate` and the
 * open path work as in the app. `path` is where the router stands. The node gets the tooltip
 * provider every tooltip needs and a query client.
 */
export async function renderAt(
  path: string,
  node: ReactNode,
  queryClient = createTestQueryClient(),
): Promise<string> {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const routes = [
    '/',
    '/jobs',
    '/clients',
    '/money',
    '/analytics',
    '/graphics',
    '/graphics/new',
    '/graphics/$id',
    '/luts',
    '/fonts',
    '/settings/team',
    '/clients/$clientId',
    '/clients/$clientId/style',
  ].map((routePath) => createRoute({ getParentRoute: () => rootRoute, path: routePath }));
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}
