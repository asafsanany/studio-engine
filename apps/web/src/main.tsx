import '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ClientPhotosProvider } from './components/ClientPhotosProvider';
import { queryClient } from './data/query-client';
import './index.css';
import { RootErrorBoundary } from './features/recovery/RootErrorBoundary';
import {
  browserSessionStorage,
  fetchServerVersion,
  startResumeRecovery,
} from './features/recovery/recovery';
import { APP_VERSION } from './lib/version';
import { createAppRouter } from './router';

// Dev-only /components route: the gallery of shadcn primitives (CVP-68). It sits outside the
// router, so it is a plain pathname check. `import.meta.env.DEV` is false in production builds,
// which removes this branch and the lazily imported page from the bundle.
const ComponentsPage = import.meta.env.DEV
  ? lazy(() => import('./dev/ComponentsPage').then((m) => ({ default: m.ComponentsPage })))
  : null;
const showComponents = ComponentsPage !== null && window.location.pathname === '/components';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {showComponents && ComponentsPage ? (
          <Suspense fallback={null}>
            <ComponentsPage />
          </Suspense>
        ) : (
          <ClientPhotosProvider>
            <RouterProvider router={createAppRouter()} />
          </ClientPhotosProvider>
        )}
      </QueryClientProvider>
    </RootErrorBoundary>
  </StrictMode>,
);

// Back from the background (iOS ends the web process of an app it has not seen for a while): an
// empty page, or one built before the last release, reloads itself (CVP-317).
startResumeRecovery({
  document,
  window,
  root,
  appVersion: APP_VERSION,
  fetchServerVersion,
  // In `vite dev` the page and the engine restart apart, so their versions can differ for a while.
  checkVersion: !import.meta.env.DEV,
  storage: browserSessionStorage(),
  now: Date.now,
  reload: () => window.location.reload(),
});
