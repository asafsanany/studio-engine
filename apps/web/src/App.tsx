import { Outlet } from '@tanstack/react-router';
import { AppShell } from '@/components/shell/AppShell';
import { useClients, useEngineReconnecting, useJobEvents, useJobs } from '@/data';
import { PhoneShell } from '@/features/phone/PhoneShell';
import { usePhoneLayoutState } from '@/features/phone/use-phone-layout';
import { ConnectingScreen } from '@/features/recovery/ConnectingScreen';

/**
 * The root of every page: the live job and client lists and the shell around the page the route
 * picked. The lists are loaded once here, kept current by the SSE stream mounted here, and read by
 * the pages. On the phone layout (the Phone switch on, a window under 768 px) the shell is the
 * phone's; everywhere else it is the sidebar shell, as ever. A narrow window that does not know
 * yet whether the switch is on shows the connecting screen (the dark page, then "Connecting…" with a
 * Reload button if the engine is slow) so the Mac layout never flashes on a phone.
 */
export function App() {
  // The live job list: loaded once, then kept current by the SSE stream mounted here.
  useJobEvents();
  const { data: jobs } = useJobs();
  // The client list: the breadcrumb names the client whose page is open from it.
  const { data: clients } = useClients();
  // The engine went away: the header says so once a list is on screen (and not for a blip).
  const reconnecting = useEngineReconnecting();
  const layout = usePhoneLayoutState();

  if (layout === 'pending') return <ConnectingScreen />;

  if (layout === 'phone') {
    return (
      <PhoneShell jobs={jobs}>
        <Outlet />
      </PhoneShell>
    );
  }

  return (
    <AppShell jobs={jobs} clients={clients} reconnecting={reconnecting}>
      <Outlet />
    </AppShell>
  );
}
