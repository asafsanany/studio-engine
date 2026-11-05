import type { ClientRow } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { StoreApi } from 'zustand';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { api, CLIENTS_KEY, TEAM_KEY } from '@/data';
import { JOBS_KEY } from '@/data/jobs-cache';
import {
  type DeleteClientDialogState,
  deleteClientDialogStore,
  deleteClientWarning,
  useDeleteClientDialog,
} from './delete-client-dialog';

/**
 * "Delete this client?" for the Clients page (the admin's). Its folder and its exports go to the
 * Trash and its videos and their payments are removed, so the dialog names what goes. Delete waits
 * for the server; a client it is busy with is explained in the dialog. A deleted client leaves the
 * list at once, and the jobs and the team load again. Mount it once, on the page. `afterDelete` is
 * the page's own follow-up, done first and waited for (the client's page goes back to the Clients
 * list, whose toaster then draws the message: the page's own would be gone with the client).
 */
export function DeleteClientDialogHost({
  store = deleteClientDialogStore,
  afterDelete,
}: {
  store?: StoreApi<DeleteClientDialogState>;
  afterDelete?: () => void | Promise<void>;
}) {
  const { client, pending, error, setPending, fail, dismiss } = useDeleteClientDialog(store);
  const queryClient = useQueryClient();
  // The words stay on the last client while the dialog fades out (the store forgets it at once).
  const [shown, setShown] = useState(client);
  if (client !== null && client !== shown) setShown(client);
  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().dismiss(), [store]);

  async function confirm() {
    if (client === null) return;
    setPending(true);
    let trashed: boolean;
    try {
      ({ trashed } = await api.deleteClient(client.clientId));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    dismiss();
    await afterDelete?.();
    queryClient.setQueryData<ClientRow[]>(CLIENTS_KEY, (list) =>
      list?.filter((row) => row.clientId !== client.clientId),
    );
    for (const queryKey of [CLIENTS_KEY, JOBS_KEY, TEAM_KEY]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    toast.success(`Deleted “${client.name}”`, {
      description: trashed
        ? 'Its folders are in the Trash.'
        : 'The Trash would not take its folders: they are in deleted-clients in the engine’s data folder.',
    });
  }

  return (
    <AlertDialog
      open={client !== null}
      onOpenChange={(open) => {
        if (!open && !pending) dismiss();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.43]">
            {error === null ? `Delete “${shown?.name ?? ''}”?` : "Couldn't delete this client"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {error ?? deleteClientWarning(shown?.jobCount ?? 0)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {error === null ? 'Keep it' : 'OK'}
          </AlertDialogCancel>
          {error === null && (
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              aria-busy={pending}
              onClick={(event) => {
                // Radix would close the dialog now; it closes when the answer is in.
                event.preventDefault();
                void confirm();
              }}
            >
              {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
              {pending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
