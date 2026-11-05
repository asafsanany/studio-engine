import type { Job } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/**
 * The "Use this look for <client>?" dialog, kept at page level and keyed by job id, like the "Stop
 * this edit?" dialog (`cancel-dialog.ts`): a ready row's menu item only asks (`askToUseLook`); the
 * dialog and its request belong to the page (`UseLookDialogHost`), because the list is sorted by
 * Last updated and the row can move to another page while the person decides.
 *
 * One dialog at a time (it is modal), so the state is one target and a phase:
 *
 *   closed   nothing shows (the last target stays in the state while the dialog fades out)
 *   asking   the question is on screen, nothing has been sent
 *   saving   "Use this look" was pressed; the request is in flight and the dialog cannot be closed
 *
 * The request ends the dialog either way: an answer closes it and tells the person with a message
 * that has Undo (`deps.done`), and a refusal (409: the job is not ready, the style is being
 * analysed) closes it and says why in a message (`deps.refused`).
 */
export type UseLookPhase = 'closed' | 'asking' | 'saving';

/** What the dialog says about the job, as it was when the dialog was asked for. */
export interface UseLookTarget {
  jobId: string;
  jobName: string;
  clientId: string;
  client: string;
}

export interface UseLookDialogState {
  phase: UseLookPhase;
  /** The job the dialog is about, or the last one while it fades out; `null` before any. */
  target: UseLookTarget | null;
  /** A ready row's menu item: show the question for this job. Ignored while a request is in flight. */
  ask: (job: Job) => void;
  /** "Use this look": the question for `jobId` turns into the running request. `false` if it was not asked. */
  confirm: (jobId: string) => boolean;
  /** The request for `jobId` is answered: the dialog closes. */
  settle: (jobId: string) => void;
  /** "Cancel", Escape or a click outside. Never closes a request that is in flight. */
  dismiss: () => void;
  /** The page is gone: close whatever shows, a running request included (its answer is still told). */
  reset: () => void;
}

/** Everything the request needs from the outside: the server, and a way to tell the person. */
export interface UseLookDeps {
  /** `POST /api/jobs/:id/use-look`; rejects with the server's words (409). */
  applyLook: (jobId: string) => Promise<unknown>;
  /** The look is the client's: "<client> now uses the look from <job>." with Undo. */
  done: (target: UseLookTarget) => void;
  /** The server refused or could not be reached; its own words are `message`. */
  refused: (target: UseLookTarget, message: string) => void;
}

const CLOSED = { phase: 'closed', target: null } as const;

/**
 * A new store, closed. `initial` starts it somewhere else (tests that server-render a state: a
 * server render reads a store's initial state, not what was set on it later).
 */
export function createUseLookDialogStore(
  initial: Partial<Pick<UseLookDialogState, 'phase' | 'target'>> = {},
): StoreApi<UseLookDialogState> {
  return createStore<UseLookDialogState>()((set, get) => ({
    ...CLOSED,
    ...initial,

    ask: (job) => {
      // Only a finished job has a look to use; the menu offers the item on ready rows alone.
      if (get().phase === 'saving' || job.state !== 'ready') return;
      set({
        phase: 'asking',
        target: { jobId: job.id, jobName: job.name, clientId: job.clientId, client: job.client },
      });
    },

    confirm: (jobId) => {
      const { phase, target } = get();
      if (phase !== 'asking' || target?.jobId !== jobId) return false;
      set({ phase: 'saving' });
      return true;
    },

    settle: (jobId) => {
      const { phase, target } = get();
      // An answer for a dialog that is no longer there (the page was left meanwhile): nothing to do.
      if (phase !== 'saving' || target?.jobId !== jobId) return;
      set({ phase: 'closed' });
    },

    dismiss: () => {
      if (get().phase === 'saving') return;
      set({ phase: 'closed' });
    },

    reset: () => set({ ...CLOSED }),
  }));
}

/** The app-wide store. Tests that need isolation build their own with `createUseLookDialogStore`. */
export const lookDialogStore = createUseLookDialogStore();

/** Ask for the dialog for a job (the row's "Use this look for <client>…" menu item). */
export function askToUseLook(
  job: Job,
  store: StoreApi<UseLookDialogState> = lookDialogStore,
): void {
  store.getState().ask(job);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "Use this look": sends the request through `deps.applyLook`, closes the dialog when it is answered
 * and tells the person how it went. It runs on the store, not in a component, so the answer lands
 * (and is told) even if the host has unmounted.
 */
export async function confirmUseLook(
  deps: UseLookDeps,
  store: StoreApi<UseLookDialogState> = lookDialogStore,
): Promise<void> {
  const { target } = store.getState();
  if (target === null || !store.getState().confirm(target.jobId)) return;
  try {
    await deps.applyLook(target.jobId);
  } catch (error) {
    store.getState().settle(target.jobId);
    deps.refused(target, messageOf(error));
    return;
  }
  store.getState().settle(target.jobId);
  deps.done(target);
}

/** The dialog's state, for the host. */
export function useUseLookDialog(store: StoreApi<UseLookDialogState> = lookDialogStore) {
  return useStore(store, (state) => state);
}
