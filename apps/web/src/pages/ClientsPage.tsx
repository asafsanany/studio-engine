import { useMemo } from 'react';
import { Toaster } from '@/components/ui/sonner';
import {
  assignedColumnHasContent,
  assigneeNames,
  jobsUnreachable,
  useClients,
  useInstagramEnabled,
  useIsAdmin,
  useTeam,
} from '@/data';
import { AssignClientDialogHost } from '@/features/clients/assign/AssignClientDialogHost';
import { ClientsSearch } from '@/features/clients/ClientsSearch';
import { ClientsTable } from '@/features/clients/ClientsTable';
import type { AssignedLookup } from '@/features/clients/clients';
import { DeleteClientDialogHost } from '@/features/clients/DeleteClientDialogHost';
import { InstagramDialogHost } from '@/features/clients/instagram/InstagramDialog';
import { NewClientDialog } from '@/features/clients/NewClientDialog';
import { RenameClientDialogHost } from '@/features/clients/RenameClientDialogHost';

/**
 * The Clients page: title, a toolbar (the search box, and New client at its right) and the table
 * of clients, which the server lists: every client folder of the inbox, with jobs or without.
 * For the admin the table has an "Assigned to" column (who each client is assigned to) once there
 * is someone to show there (an editor on the team, or a client that is assigned), and a row's
 * menu has Assign to…, Rename… and Delete…; an editor has none of them. While Clients × Instagram
 * is on a row's menu also has Instagram…, and the page shows its dialog. It mounts the toaster
 * their dialogs share ("Renamed to …", "Deleted …", "Saved @falcon.fpv. Reading it now.").
 */
export function ClientsPage() {
  const { data: clients, isError, failureCount, refetch } = useClients();
  const admin = useIsAdmin();
  // Clients × Instagram: the table shows each client's followers, this week and ours vs theirs.
  const instagramOn = useInstagramEnabled();
  const { data: team, isPending: teamPending } = useTeam();
  // The column is the admin's, and only when it has something to say: an editor to assign to, or a
  // client that is assigned (without either every row would read "Unassigned"; board L1 has none).
  const withAssigned =
    admin &&
    assignedColumnHasContent(
      team,
      (clients ?? []).map((row) => row.clientId),
      teamPending,
    );
  const assignedTo = useMemo<AssignedLookup | undefined>(
    () => (withAssigned ? (clientId) => assigneeNames(team, clientId) : undefined),
    [withAssigned, team],
  );
  return (
    <>
      <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">Clients</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ClientsSearch />
        <NewClientDialog />
      </div>
      <ClientsTable
        clients={clients}
        failed={jobsUnreachable({ data: clients, isError, failureCount })}
        onRetry={() => void refetch()}
        assignedTo={assignedTo}
        instagram={instagramOn}
      />
      {admin && <AssignClientDialogHost />}
      {admin && <RenameClientDialogHost />}
      {admin && <DeleteClientDialogHost />}
      {instagramOn && <InstagramDialogHost />}
      {(admin || instagramOn) && <Toaster />}
    </>
  );
}
