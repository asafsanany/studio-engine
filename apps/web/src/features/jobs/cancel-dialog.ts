import { can, type Job } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/**
 * The "Stop this edit?" dialog, kept at page level and keyed by job id.
 *
 * The dialog used to belong to its table row, so it was lost when the row moved to another page
 * (the list is sorted by Last updated, so a busy job keeps moving) while the dialog was open or
 * the stop was still running. Now the row only asks (`ask`) and the page shows the dialog
 * (`CancelDialogHost`), so what is on screen no longer depends on which rows are on the page.
 *
 * One dialog at a time (it is modal), so the state is one job id and a phase:
 *
 *   asking   "Stop this edit?" is on screen, nothing has been sent
 *   stopping "Stop edit" was pressed; the request is in flight and the dialog cannot be closed
 *   note     the dialog has turned into a short note and an OK button: the edit ended by itself, the
 *            job is gone, or the server refused the stop
 */
export type CancelDialogPhase = 'asking' | 'stopping' | 'note';

/** A note replaces the question: a title, one sentence, and an OK button. */
export interface CancelDialogNote {
  title: string;
  description: string;
}

export const CANCEL_NOTES = {
  /** The edit ended (finished, failed, was cancelled elsewhere) while the question was open. */
  ended: { title: 'Nothing to stop', description: 'This edit is no longer running.' },
  /** The job disappeared from the list while the question was open. */
  gone: { title: 'Nothing to stop', description: 'This job is no longer in the list.' },
  /** The server refused or could not be reached; its own words follow as the description. */
  refusedTitle: "Couldn't stop this edit",
} as const satisfies Record<string, CancelDialogNote | string>;

/** What the dialog is about and how far it has got. `jobId` is `null` while no dialog shows. */
export interface CancelDialogState {
  jobId: string | null;
  phase: CancelDialogPhase;
  /** Set in the `note` phase. */
  note: CancelDialogNote | null;
  /** A row's Cancel… menu item: show the question for this job. Ignored while a stop is in flight. */
  ask: (jobId: string) => void;
  /** "Stop edit": the question for `jobId` turns into the running request. `false` if it was not asked. */
  confirm: (jobId: string) => boolean;
  /** The request for `jobId` is answered: no `error` closes the dialog, an `error` becomes the note. */
  settle: (jobId: string, error?: string) => void;
  /** Keeps the open question honest about the job: a note if it can no longer be cancelled. */
  checkJob: (jobId: string, job: Job | undefined) => void;
  /** "Keep editing", OK, Escape or a click outside. Never closes a stop that is in flight. */
  dismiss: () => void;
  /** The page is gone: close whatever shows, a running stop included (its answer is then ignored). */
  reset: () => void;
}

const CLOSED = { jobId: null, phase: 'asking', note: null } as const;

/** The note for a job that is shown a question but can no longer be cancelled; `null` if it can. */
export function noteForJob(job: Job | undefined): CancelDialogNote | null {
  if (job === undefined) return CANCEL_NOTES.gone;
  return can(job, 'cancel') ? null : CANCEL_NOTES.ended;
}

/**
 * A new store, closed. `initial` starts it somewhere else (tests that server-render a state: a
 * server render reads a store's initial state, not what was set on it later).
 */
export function createCancelDialogStore(
  initial: Partial<Pick<CancelDialogState, 'jobId' | 'phase' | 'note'>> = {},
): StoreApi<CancelDialogState> {
  return createStore<CancelDialogState>()((set, get) => ({
    ...CLOSED,
    ...initial,

    ask: (jobId) => {
      if (get().phase === 'stopping') return;
      set({ jobId, phase: 'asking', note: null });
    },

    confirm: (jobId) => {
      const { jobId: current, phase } = get();
      if (current !== jobId || phase !== 'asking') return false;
      set({ phase: 'stopping' });
      return true;
    },

    settle: (jobId, error) => {
      const { jobId: current, phase } = get();
      // An answer for a dialog that is no longer there (the page was left meanwhile): nothing to do.
      if (current !== jobId || phase !== 'stopping') return;
      set(
        error === undefined
          ? CLOSED
          : { phase: 'note', note: { title: CANCEL_NOTES.refusedTitle, description: error } },
      );
    },

    checkJob: (jobId, job) => {
      const { jobId: current, phase } = get();
      if (current !== jobId || phase !== 'asking') return;
      const note = noteForJob(job);
      if (note !== null) set({ phase: 'note', note });
    },

    dismiss: () => {
      if (get().phase === 'stopping') return;
      set(CLOSED);
    },

    reset: () => set(CLOSED),
  }));
}

/** The app-wide store. Tests that need isolation build their own with `createCancelDialogStore`. */
export const cancelDialogStore = createCancelDialogStore();

/** Open the question for a job (the row's Cancel… menu item). */
export function askToCancel(
  jobId: string,
  store: StoreApi<CancelDialogState> = cancelDialogStore,
): void {
  store.getState().ask(jobId);
}

/**
 * "Stop edit": sends the request through `cancel` and settles the dialog when it is answered. It
 * runs on the store, not in a component, so the answer lands even if the host has unmounted.
 */
export async function confirmCancel(
  jobId: string,
  cancel: (jobId: string) => Promise<unknown>,
  store: StoreApi<CancelDialogState> = cancelDialogStore,
): Promise<void> {
  if (!store.getState().confirm(jobId)) return;
  try {
    await cancel(jobId);
    store.getState().settle(jobId);
  } catch (error) {
    store.getState().settle(jobId, error instanceof Error ? error.message : String(error));
  }
}

/** The dialog's state, for the host. */
export function useCancelDialog(store: StoreApi<CancelDialogState> = cancelDialogStore) {
  return useStore(store, (state) => state);
}
