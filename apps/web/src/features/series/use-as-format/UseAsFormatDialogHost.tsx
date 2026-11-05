import { useEffect } from 'react';
import type { StoreApi } from 'zustand';
import { useSetSeriesFormat } from '@/data';
import { rowFocusTarget } from '@/features/jobs/row-focus';
import { UseAsFormatDialog } from './UseAsFormatDialog';
import {
  asFormatDialogStore,
  confirmUseAsFormat,
  type UseAsFormatDeps,
  type UseAsFormatDialogState,
  useUseAsFormatDialog,
} from './use-as-format-dialog';
import { announceFormatChanging, announceFormatRefused } from './use-as-format-toasts';

/** The dialog's dependencies over the server: an answer and a refusal are each told in a message. */
export function useAsFormatDeps(setFormat: UseAsFormatDeps['setFormat']): UseAsFormatDeps {
  return { setFormat, done: announceFormatChanging, refused: announceFormatRefused };
}

interface UseAsFormatDialogHostProps {
  /** Where the dialog's state lives. Tests pass their own; the page uses the shared one. */
  store?: StoreApi<UseAsFormatDialogState>;
}

/**
 * The "Use <job> as the format?" dialog for the whole page (the Jobs page, a client's page and a
 * series' page share the list). A ready episode's menu item only asks (`askToUseAsFormat`); the
 * dialog and its request live here, one level above the list, so they survive the row moving to
 * another page.
 *
 * - "Use as format" keeps the dialog (spinner, not closable) until the server answers. Then it
 *   closes and a message says "The format of the series X is being learned from J.", or, if the
 *   server refused (409: the series or the client's style is being learned), says why.
 * - Closing gives focus to the row's action button, or to the row itself, when the row is on the
 *   page (there is no trigger element to give it back to).
 *
 * Mount it once, on the page, next to `StartSeriesDialogHost`. Renders nothing while no dialog is open.
 */
export function UseAsFormatDialogHost({ store = asFormatDialogStore }: UseAsFormatDialogHostProps) {
  const { phase, target } = useUseAsFormatDialog(store);
  const setFormat = useSetSeriesFormat();

  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().reset(), [store]);

  const deps = useAsFormatDeps(setFormat.mutateAsync);

  // After it closes, the store keeps the episode: the exit animation (and the focus that goes back
  // to the row) still see the words and the job of the dialog that just closed.
  return (
    <UseAsFormatDialog
      open={phase !== 'closed'}
      target={target}
      saving={phase === 'saving'}
      onConfirm={() => void confirmUseAsFormat(deps, store)}
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
