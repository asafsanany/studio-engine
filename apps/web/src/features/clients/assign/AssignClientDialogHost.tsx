import { useEffect } from 'react';
import type { StoreApi } from 'zustand';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AssignToForm } from './AssignToForm';
import { type AssignDialogState, assignDialogStore, useAssignDialog } from './assign-dialog';
import { ASSIGN_TEXT } from './assign-text';

/**
 * "Assign to…" for the whole Clients page: a checkbox per editor for the client the row menu asked
 * about. Mount it once, on the page.
 */
export function AssignClientDialogHost({
  store = assignDialogStore,
}: {
  store?: StoreApi<AssignDialogState>;
}) {
  const { client, dismiss } = useAssignDialog(store);
  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().dismiss(), [store]);

  return (
    <Dialog
      open={client !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {ASSIGN_TEXT.title} <bdi>{client?.name ?? ''}</bdi>
          </DialogTitle>
          <DialogDescription>{ASSIGN_TEXT.question}</DialogDescription>
        </DialogHeader>
        {/* Keyed by the client: another client's dialog starts from what is saved. */}
        {client !== null && <AssignToForm key={client.clientId} client={client} onDone={dismiss} />}
      </DialogContent>
    </Dialog>
  );
}
