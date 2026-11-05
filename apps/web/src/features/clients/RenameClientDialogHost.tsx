import type { ClientRow } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
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
import { Input } from '@/components/ui/input';
import { api, CLIENTS_KEY, TEAM_KEY } from '@/data';
import { upsertClientRow } from '@/data/clients-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { bidiProps } from '@/lib/bidi';
import {
  confirmRenameClient,
  type RenameClientDialogState,
  renameClientDialogStore,
  renameClientReadiness,
  useRenameClientDialog,
} from './rename-client-dialog';

/** The words of the dialog. */
export const RENAME_CLIENT_TEXT = {
  title: 'Rename client',
  description: 'Its folder in Studio Inbox, its exports and its videos get the new name too.',
  label: 'Name',
  cancel: 'Cancel',
  confirm: 'Rename',
  confirming: 'Renaming…',
} as const;

const NAME_INPUT_ID = 'rename-client-name';
const PROBLEM_ID = 'rename-client-problem';

/**
 * "Rename client" for the Clients page (the admin's). The name is the folder's, so the dialog
 * says the folder, the exports and the videos follow; Rename waits for the server (which moves
 * them) and is off while the name is empty, unchanged or not one a client can have. A name the
 * server refuses, or a client it is busy with, is explained under the input. A renamed client has
 * a new id: the list gets the new row at once and the old one goes; the jobs and the team load
 * again (their ids follow the name too). Mount it once, on the page. `afterRename` is the page's own
 * follow-up with the client's new row (the client's page moves to the new id, which its old
 * address no longer finds).
 */
export function RenameClientDialogHost({
  store = renameClientDialogStore,
  afterRename,
}: {
  store?: StoreApi<RenameClientDialogState>;
  afterRename?: (renamed: ClientRow) => void;
}) {
  const { client, name, pending, error, setName } = useRenameClientDialog(store);
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().dismiss(), [store]);
  // A refused name sends the cursor back to the input (it was locked while the request ran).
  useEffect(() => {
    if (error === null || pending) return;
    input.current?.focus();
    input.current?.select();
  }, [error, pending]);

  const readiness = renameClientReadiness(client, name);
  const problem = error ?? readiness.problem;

  const confirm = () =>
    void confirmRenameClient(
      {
        rename: (clientId, newName) => api.renameClient(clientId, newName),
        onRenamed(before, renamed) {
          queryClient.setQueryData<ClientRow[]>(CLIENTS_KEY, (list) =>
            list === undefined
              ? list
              : upsertClientRow(
                  list.filter((row) => row.clientId !== before.clientId),
                  renamed,
                ),
          );
          for (const queryKey of [CLIENTS_KEY, JOBS_KEY, TEAM_KEY]) {
            void queryClient.invalidateQueries({ queryKey });
          }
          afterRename?.(renamed);
        },
        notify: (message) => toast.success(message),
      },
      store,
    );

  return (
    <AlertDialog
      open={client !== null}
      onOpenChange={(open) => {
        if (!open && !pending) store.getState().dismiss();
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          // The name is the one thing to change: the cursor goes there, with the name selected.
          event.preventDefault();
          input.current?.focus();
          input.current?.select();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.43]">{RENAME_CLIENT_TEXT.title}</AlertDialogTitle>
          <AlertDialogDescription>{RENAME_CLIENT_TEXT.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={NAME_INPUT_ID} className="font-medium">
            {RENAME_CLIENT_TEXT.label}
          </label>
          <Input
            ref={input}
            id={NAME_INPUT_ID}
            type="text"
            {...bidiProps}
            value={name}
            disabled={pending}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? undefined : PROBLEM_ID}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              // A form's Enter, without a form: the dialog's own button is the submit.
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              confirm();
            }}
          />
          {problem !== null && (
            <p id={PROBLEM_ID} role="alert" className="text-[13px] text-pretty text-destructive">
              {problem}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {RENAME_CLIENT_TEXT.cancel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!readiness.ready || pending}
            aria-busy={pending}
            onClick={(event) => {
              // Radix would close the dialog now; it closes when the answer is in.
              event.preventDefault();
              confirm();
            }}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? RENAME_CLIENT_TEXT.confirming : RENAME_CLIENT_TEXT.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
