import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import { App } from './App';
import { AdminOnly } from './components/shell/AdminOnly';
import { Toaster } from './components/ui/sonner';
import {
  analyticsEnabled,
  dmsEnabled,
  fontsEnabled,
  graphicsEnabled,
  lutsEnabled,
  useHealth,
} from './data';
import { periodToRestore, validateAnalyticsSearch } from './features/analytics/analytics-search';
import { validateFontsSearch } from './features/fonts/font-address';
import { validateJobSearch } from './features/job-sheet/job-sheet-search';
import { validateLutsSearch } from './features/luts/list/lut-address';
import { PhoneClientPage } from './features/phone/PhoneClientPage';
import { PhoneClientsPage } from './features/phone/PhoneClientsPage';
import { PhoneJobsPage } from './features/phone/PhoneJobsPage';
import { PhoneMoneyPage } from './features/phone/PhoneMoneyPage';
import { PhoneSettingsPage } from './features/phone/PhoneSettingsPage';
import { PhoneStylePage } from './features/phone/PhoneStylePage';
import { usePhoneLayout, usePhoneLayoutState } from './features/phone/use-phone-layout';
import { ErrorScreen } from './features/recovery/ErrorScreen';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ClientPage } from './pages/ClientPage';
import { ClientsPage } from './pages/ClientsPage';
import { DmsPage } from './pages/DmsPage';
import { FontsPage } from './pages/FontsPage';
import { GraphicPage } from './pages/GraphicPage';
import { GraphicsPage } from './pages/GraphicsPage';
import { JobsPage } from './pages/JobsPage';
import { LutsPage } from './pages/LutsPage';
import { MoneyPage } from './pages/MoneyPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SeriesPage } from './pages/SeriesPage';
import { SettingsPage } from './pages/SettingsPage';
import { StylePage } from './pages/StylePage';
import { TeamPage } from './pages/TeamPage';

// Code-based routes, no codegen. The root route is the app frame (App: the live job list and the
// shell); the pages below it fill the shell's content area. The server answers every path that is
// not a file or /api with index.html, so a reload on any of these addresses lands on the same page.
const rootRoute = createRootRoute({
  component: App,
  notFoundComponent: NotFoundPage,
  // A render error in the app frame or any page: the "Something went wrong" screen (CVP-317).
  errorComponent: RouteError,
});

// The four pages with a job list can show a job's sheet: `?job=<id>` (see job-sheet-search.ts).
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: JobsRoute,
  validateSearch: validateJobSearch,
});
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  component: JobsRoute,
  validateSearch: validateJobSearch,
});
const clientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clients',
  component: ClientsRoute,
});
const moneyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/money',
  component: MoneyRoute,
});
const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
  component: AnalyticsRoute,
  validateSearch: validateAnalyticsSearch,
  // The page opens on the period last chosen in this browser when the address names none.
  beforeLoad: ({ search }) => {
    const period = periodToRestore(search);
    if (period !== null) throw redirect({ to: '/analytics', search: { period }, replace: true });
  },
});
// The Graphics library (Graphics plan): switch-gated like Analytics, and Mac only. The three pages
// sit under one layout with no address of its own (GraphicsLayout): it gates them and mounts the
// one toaster of the library, which keeps what is said as a page is left (a delete opens the list).
const graphicsLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'graphics',
  component: GraphicsLayout,
});
const graphicsRoute = createRoute({
  getParentRoute: () => graphicsLayoutRoute,
  path: '/graphics',
  component: GraphicsPage,
});
const graphicNewRoute = createRoute({
  getParentRoute: () => graphicsLayoutRoute,
  path: '/graphics/new',
  component: GraphicNewRoute,
});
const graphicRoute = createRoute({
  getParentRoute: () => graphicsLayoutRoute,
  path: '/graphics/$id',
  component: GraphicRoute,
});
// The LUTs library (LUTs plan): switch-gated like Graphics, and Mac only.
const lutsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/luts',
  component: LutsRoute,
  // `?lut=<slug>` is the open LUT and `?tab=look|camera|fix` the tab (LU3).
  validateSearch: validateLutsSearch,
});
// The Fonts library (Fonts plan): switch-gated like Graphics and LUTs, and Mac only.
const fontsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/fonts',
  component: FontsRoute,
  // `?family=<slug>` is the open family (see features/fonts/font-address.ts).
  validateSearch: validateFontsSearch,
});
// The Instagram DMs page: what @owner_account sends the studio's Instagram. The admin's, Mac only.
const dmsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dms',
  component: DmsRoute,
});
const clientRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clients/$clientId',
  component: ClientRoute,
  validateSearch: validateJobSearch,
});

const styleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clients/$clientId/style',
  component: StyleRoute,
});

const seriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clients/$clientId/series/$seriesId',
  component: SeriesRoute,
  validateSearch: validateJobSearch,
});

// Settings: the phone's page on the phone, the feature switches (the admin's only) on the Mac.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsRoute,
});

// The Team page (Team plan, TM5): the admin's only, Mac only. The Team item of the sidebar goes
// straight here.
const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/team',
  component: TeamRoute,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  jobsRoute,
  settingsRoute,
  teamRoute,
  clientsRoute,
  moneyRoute,
  analyticsRoute,
  graphicsLayoutRoute.addChildren([graphicsRoute, graphicNewRoute, graphicRoute]),
  lutsRoute,
  fontsRoute,
  dmsRoute,
  clientRoute,
  styleRoute,
  seriesRoute,
]);

/** What a page that threw shows instead of an empty screen: the message and a Reload button. */
function RouteError({ error }: { error: unknown }) {
  return <ErrorScreen error={error} />;
}

/**
 * The Analytics page while its switch is on; Not found while it is off (as if the page did not
 * exist). Nothing until the engine has said which, so a reload on /analytics does not flash "No
 * such page".
 */
function AnalyticsRoute() {
  const { data, isPending } = useHealth();
  if (isPending) return null;
  return analyticsEnabled(data) ? (
    <AdminOnly>
      <AnalyticsPage />
    </AdminOnly>
  ) : (
    <NotFoundPage />
  );
}

/**
 * The Graphics pages while the Graphics switch is on and the layout is the Mac's; Not found while
 * the switch is off (as if the pages did not exist) and on the phone layout (Graphics is Mac only).
 * Nothing until the engine has said which, so a reload on /graphics does not flash "No such page".
 *
 * It mounts the one toaster the list and the studio share: what a button's refusal says, and where
 * a deleted graphic's folder went, are shown wherever the person is by then.
 */
function GraphicsLayout() {
  const { data, isPending } = useHealth();
  const phone = usePhoneLayout();
  if (isPending) return null;
  if (!graphicsEnabled(data) || phone) return <NotFoundPage />;
  return (
    <AdminOnly>
      <Outlet />
      <Toaster />
    </AdminOnly>
  );
}

/**
 * The LUTs page while the LUTs switch is on and the layout is the Mac's; Not found while the
 * switch is off (as if the page did not exist) and on the phone layout (LUTs is Mac only). Nothing
 * until the engine has said which, so a reload on /luts does not flash "No such page".
 *
 * It mounts the toaster the page's dialogs share: what an import says ("Imported 2 LUTs") and what
 * a button's refusal says are shown wherever the person is by then.
 */
function LutsRoute() {
  const { data, isPending } = useHealth();
  const phone = usePhoneLayout();
  if (isPending) return null;
  if (!lutsEnabled(data) || phone) return <NotFoundPage />;
  return (
    <AdminOnly>
      <LutsPage />
      <Toaster />
    </AdminOnly>
  );
}

/**
 * The Fonts page while the Fonts switch is on and the layout is the Mac's; Not found while the
 * switch is off (as if the page did not exist) and on the phone layout (Fonts is Mac only). Nothing
 * until the engine has said which, so a reload on /fonts does not flash "No such page".
 *
 * It mounts the toaster the page's dialogs share: what an import says ("Imported 2 fonts") and what
 * a button's refusal says are shown wherever the person is by then.
 */
function FontsRoute() {
  const { data, isPending } = useHealth();
  const phone = usePhoneLayout();
  if (isPending) return null;
  if (!fontsEnabled(data) || phone) return <NotFoundPage />;
  return (
    <AdminOnly>
      <FontsPage />
      <Toaster />
    </AdminOnly>
  );
}

/**
 * The DMs page for the admin on the Mac layout, once the engine has it; Not found on the phone
 * layout (Mac only) and from an engine without it. Nothing until the engine has said which.
 */
function DmsRoute() {
  const { data, isPending } = useHealth();
  const phone = usePhoneLayout();
  if (isPending) return null;
  if (!dmsEnabled(data) || phone) return <NotFoundPage />;
  return (
    <AdminOnly>
      <DmsPage />
    </AdminOnly>
  );
}

function GraphicNewRoute() {
  return <GraphicPage id={undefined} />;
}

function GraphicRoute() {
  const { id } = graphicRoute.useParams();
  // Keyed by the graphic: another graphic's page starts from nothing (its composer, its preview).
  return <GraphicPage key={id} id={id} />;
}

/** The jobs list: the phone's on the phone layout, the Mac's everywhere else. */
function JobsRoute() {
  return usePhoneLayout() ? <PhoneJobsPage /> : <JobsPage />;
}

/** The Clients list: the phone's on the phone layout (PH18), the Mac's table everywhere else. */
function ClientsRoute() {
  return usePhoneLayout() ? <PhoneClientsPage /> : <ClientsPage />;
}

/**
 * The Money page: the phone's on the phone layout (PH19), the Mac's everywhere else. The admin's
 * only: an editor's address leads to Jobs.
 */
function MoneyRoute() {
  const phone = usePhoneLayout();
  return <AdminOnly>{phone ? <PhoneMoneyPage /> : <MoneyPage />}</AdminOnly>;
}

/**
 * The Team page for the admin on the Mac layout; Not found on the phone layout (Team is Mac only),
 * and an editor is sent to Jobs (AdminOnly).
 */
function TeamRoute() {
  const layout = usePhoneLayoutState();
  if (layout === 'pending') return null;
  if (layout === 'phone') return <NotFoundPage />;
  return (
    <AdminOnly>
      <TeamPage />
    </AdminOnly>
  );
}

function SettingsRoute() {
  const layout = usePhoneLayoutState();
  if (layout === 'phone') return <PhoneSettingsPage />;
  // Not known yet (a narrow window the engine has not answered, with nothing remembered): a reload
  // on /settings in the phone app must not be sent away on a guess.
  if (layout === 'pending') return null;
  return (
    <AdminOnly>
      <SettingsPage />
    </AdminOnly>
  );
}

function ClientRoute() {
  const { clientId } = clientRoute.useParams();
  const phone = usePhoneLayout();
  return phone ? <PhoneClientPage clientId={clientId} /> : <ClientPage clientId={clientId} />;
}

function StyleRoute() {
  const { clientId } = styleRoute.useParams();
  const phone = usePhoneLayout();
  // Keyed by the client: another client's Style page starts from nothing (no files, no notice).
  return phone ? (
    <PhoneStylePage key={clientId} clientId={clientId} />
  ) : (
    <StylePage key={clientId} clientId={clientId} />
  );
}

function SeriesRoute() {
  const { clientId, seriesId } = seriesRoute.useParams();
  // Keyed by the series: another series starts on its Episodes tab.
  return <SeriesPage key={seriesId} clientId={clientId} seriesId={seriesId} />;
}

/** The app's router. `history` is only for tests (a memory history); the app uses the browser's. */
export function createAppRouter(history?: RouterHistory) {
  // Every page is a screen of its own: opening one starts at its top, and Back returns to where
  // the previous page was scrolled to.
  return createRouter({
    routeTree,
    history,
    scrollRestoration: true,
    defaultErrorComponent: RouteError,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
