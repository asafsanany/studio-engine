import type { Job } from '@studio/shared';
import { useEffect, useRef } from 'react';
import type { StoreApi } from 'zustand';
import { useJobAction } from '@/data';
import {
  type CancelDialogNote,
  type CancelDialogState,
  cancelDialogStore,
  confirmCancel,
  useCancelDialog,
} from '../cancel-dialog';
import { rowFocusTarget } from '../row-focus';
import { CancelDialog } from './CancelDialog';

interface CancelDialogHostProps {
  /** The full job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** Where the dialog's state lives. Tests pass their own; the page uses the shared one. */
  store?: StoreApi<CancelDialogState>;
}

/**
 * The "Stop this edit?" dialog for the whole Jobs page. A row's Cancel… menu item only asks
 * (`askToCancel`); the dialog, its "Stopping…" state and the request itself live here, one level
 * above the table, so they survive the row moving to another page or off the list.
 *
 * - While the question is open it follows the job: if the edit ends by itself, or the job leaves
 *   the list, the question turns into a short note with an OK button.
 * - "Stop edit" sends the cancel and keeps the dialog (spinner, "Stopping…", not closable) until
 *   the server answers: then it closes, or, if the server refused, shows the reason as a note.
 * - Closing gives focus to the row's action button, or to the row itself when it has no button,
 *   when the row is on the page (there is no trigger element to give it back to).
 *
 * Mount it once, on the page. Renders nothing while no dialog is open.
 */
export function CancelDialogHost({ jobs, store = cancelDialogStore }: CancelDialogHostProps) {
  const { jobId, phase, note, dismiss } = useCancelDialog(store);
  const cancel = useJobAction('cancel');

  // Keep the question honest about its job.
  const job = jobs?.find((candidate) => candidate.id === jobId);
  useEffect(() => {
    if (jobId !== null && jobs !== undefined) store.getState().checkJob(jobId, job);
  }, [store, jobId, jobs, job]);

  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().reset(), [store]);

  // What the dialog showed last. After it closes, its exit animation (and the focus that goes back
  // to the row) must still see that job and those words, not the question's defaults.
  const last = useRef<{ jobId: string | null; pending: boolean; note: CancelDialogNote | null }>({
    jobId: null,
    pending: false,
    note: null,
  });
  useEffect(() => {
    if (jobId !== null) {
      last.current = { jobId, pending: phase === 'stopping', note: phase === 'note' ? note : null };
    }
  }, [jobId, phase, note]);
  const shown =
    jobId === null
      ? last.current
      : { jobId, pending: phase === 'stopping', note: phase === 'note' ? note : null };

  return (
    <CancelDialog
      open={jobId !== null}
      pending={shown.pending}
      note={shown.note}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      onConfirm={() => {
        if (jobId !== null) void confirmCancel(jobId, cancel.mutateAsync, store);
      }}
      onCloseAutoFocus={(event) => {
        // There is no trigger element to give focus back to (the dialog is asked for from the row's
        // right-click menu); the row's own button gets it (Resume after "Stop edit"), or the row.
        event.preventDefault();
        if (last.current.jobId !== null) rowFocusTarget(last.current.jobId)?.focus();
      }}
    />
  );
}
