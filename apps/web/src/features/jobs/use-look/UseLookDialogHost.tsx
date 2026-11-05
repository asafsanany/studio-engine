import type { Job } from '@studio/shared';
import { useEffect } from 'react';
import type { StoreApi } from 'zustand';
import { useApplyLook, useClientStyle, useUndoClientStyle } from '@/data';
import { rowFocusTarget } from '../row-focus';
import { nowLookOf } from './now-look';
import { UseLookDialog } from './UseLookDialog';
import {
  confirmUseLook,
  lookDialogStore,
  type UseLookDeps,
  type UseLookDialogState,
  type UseLookTarget,
  useUseLookDialog,
} from './use-look-dialog';
import {
  announceLookRefused,
  announceLookUndone,
  announceLookUsed,
  announceUndoRefused,
} from './use-look-toasts';

interface UseLookDialogHostProps {
  /** The full job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** Where the dialog's state lives. Tests pass their own; the page uses the shared one. */
  store?: StoreApi<UseLookDialogState>;
}

/**
 * The "Use this look for <client>?" dialog for the whole Jobs page (and a client's page, which
 * shares the table). A ready row's menu item only asks (`askToUseLook`); the dialog and its
 * request live here, one level above the table, so they survive the row moving to another page.
 *
 * - While it is open it reads the client's style (the menu already did, so it is usually cached)
 *   to show the "Now" still: the job the look comes from, or "From your files".
 * - "Use this look" keeps the dialog (spinner, not closable) until the server answers. Then it
 *   closes and a message says "<client> now uses the look from <job>." with Undo, or, if the
 *   server refused (409: the style is being analysed), says why. Undo sends the client's undo and
 *   says how that went too; the server refuses it while the new look is still being learned.
 * - Closing gives focus to the row's action button, or to the row itself, when the row is on the
 *   page (there is no trigger element to give it back to).
 *
 * Mount it once, on the page, next to `RefusedActionsHost` (which draws the messages). Renders
 * nothing while no dialog is open.
 */
export function UseLookDialogHost({ jobs, store = lookDialogStore }: UseLookDialogHostProps) {
  const { phase, target } = useUseLookDialog(store);
  const open = phase !== 'closed';
  const style = useClientStyle(target?.clientId ?? '', { enabled: open && target !== null });
  const apply = useApplyLook();
  const undo = useUndoClientStyle();

  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().reset(), [store]);

  // Undo is asked for from a message that outlives the dialog (and the page): `mutateAsync` is the
  // same function for as long as the host lives, and keeps working after it is gone.
  const undoLook = (undone: UseLookTarget) => {
    undo.mutateAsync(undone.clientId).then(
      () => announceLookUndone(undone),
      (error: unknown) =>
        announceUndoRefused(undone, error instanceof Error ? error.message : String(error)),
    );
  };

  const deps: UseLookDeps = {
    applyLook: apply.mutateAsync,
    done: (done) => announceLookUsed(done, () => undoLook(done)),
    refused: announceLookRefused,
  };

  // After it closes, the store keeps the job: the exit animation (and the focus that goes back to
  // the row) still see the words and the job of the dialog that just closed.
  return (
    <UseLookDialog
      open={open}
      client={target?.client ?? ''}
      jobId={target?.jobId ?? ''}
      jobName={target?.jobName ?? ''}
      now={nowLookOf(style, jobs)}
      saving={phase === 'saving'}
      onConfirm={() => void confirmUseLook(deps, store)}
      onOpenChange={(next) => {
        if (!next) store.getState().dismiss();
      }}
      onCloseAutoFocus={(event) => {
        // There is no trigger element to give focus back to (the dialog is asked for from the row's
        // right-click menu); the row's own button gets it, or the row.
        event.preventDefault();
        const id = store.getState().target?.jobId;
        if (id !== undefined) rowFocusTarget(id)?.focus();
      }}
    />
  );
}
