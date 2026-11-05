import { useEffect } from 'react';
import type { StoreApi } from 'zustand';
import { useStartSeries, useUndoSeries } from '@/data';
import { rowFocusTarget } from '@/features/jobs/row-focus';
import { StartSeriesDialog } from './StartSeriesDialog';
import {
  confirmStartSeries,
  type StartSeriesDeps,
  type StartSeriesDialogState,
  startSeriesDialogStore,
  useStartSeriesDialog,
} from './start-series-dialog';
import {
  announceSeriesRefused,
  announceSeriesStarted,
  announceSeriesUndone,
  announceSeriesUndoRefused,
} from './start-series-toasts';

/** What the requests need of the server: the two mutations the host owns. */
interface StartSeriesMutations {
  start: StartSeriesDeps['startSeries'];
  /** `POST /api/series/:id/undo`; rejects with the server's words (409 after ten seconds). */
  undo: (variables: { seriesId: string; clientId: string }) => Promise<unknown>;
}

/**
 * The dialog's dependencies over the server: a started series is told with a message whose Undo
 * sends the series' undo and says how that went (it can be refused, after ten seconds).
 */
export function startSeriesDeps({ start, undo }: StartSeriesMutations): StartSeriesDeps {
  return {
    startSeries: start,
    done: (target, series) =>
      announceSeriesStarted(target, series, () => {
        undo({ seriesId: series.id, clientId: target.clientId }).then(
          () => announceSeriesUndone(target, series),
          (error: unknown) =>
            announceSeriesUndoRefused(
              target,
              error instanceof Error ? error.message : String(error),
            ),
        );
      }),
    refused: announceSeriesRefused,
  };
}

interface StartSeriesDialogHostProps {
  /** Where the dialog's state lives. Tests pass their own; the page uses the shared one. */
  store?: StoreApi<StartSeriesDialogState>;
}

/**
 * The "Start a series from <job>?" dialog for the whole Jobs page (and a client's page, which
 * shares the list). A ready row's menu item only asks (`askToStartSeries`); the dialog and its
 * request live here, one level above the list, so they survive the row moving to another page.
 *
 * - "Start series" keeps the dialog (spinner, not closable) until the server answers. A name it
 *   refuses (422) stays in the dialog with the server's words under the input. Any other answer
 *   closes the dialog and a message says "Started the series X. Its format is being learned from J."
 *   with Undo for ten seconds, or, if the server refused (409: the job is not ready, a style or
 *   series pass of the client is running), says why. Undo sends the series' undo and says how that
 *   went too.
 * - Closing gives focus to the row's action button, or to the row itself, when the row is on the
 *   page (there is no trigger element to give it back to).
 *
 * Mount it once, on the page, next to `UseLookDialogHost`. Renders nothing while no dialog is open.
 */
export function StartSeriesDialogHost({
  store = startSeriesDialogStore,
}: StartSeriesDialogHostProps) {
  const { phase, target, name, problem } = useStartSeriesDialog(store);
  const start = useStartSeries();
  const undo = useUndoSeries();

  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().reset(), [store]);

  // Undo is asked for from a message that outlives the dialog (and the page): `mutateAsync` is the
  // same function for as long as the host lives, and keeps working after it is gone.
  const deps = startSeriesDeps({ start: start.mutateAsync, undo: undo.mutateAsync });

  // After it closes, the store keeps the job: the exit animation (and the focus that goes back to
  // the row) still see the words and the job of the dialog that just closed.
  return (
    <StartSeriesDialog
      open={phase !== 'closed'}
      target={target}
      name={name}
      problem={problem}
      saving={phase === 'saving'}
      onNameChange={(next) => store.getState().setName(next)}
      onConfirm={() => void confirmStartSeries(deps, store)}
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
