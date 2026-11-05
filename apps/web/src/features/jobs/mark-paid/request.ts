import type { Job } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/**
 * The page's request for the "Mark paid" dialog, kept at page level like the other row dialogs
 * (`cancel-dialog.ts`, `use-look-dialog.ts`): a delivered row's banknote button and its menu's
 * "Mark paid…" only ask (`askToMarkPaid`); the dialog itself, and the payment it sends, belong to a
 * host that reads the request (`useMarkPaidRequest`) and closes it (`close`). The list is sorted by
 * Last updated and rows move between pages, so the question must not belong to a row.
 *
 * The request names the job that was clicked and its client. The dialog lists every delivered,
 * unpaid video of that client, with the clicked one ticked. Nothing here renders the dialog, and no
 * host is mounted by this file.
 */
export interface MarkPaidRequest {
  /** The job whose "Mark paid…" was chosen: it starts ticked. */
  jobId: string;
  clientId: string;
  /** The client's name, for the dialog's title. */
  client: string;
}

export interface MarkPaidRequestState {
  /** What was asked for, or `null` while no dialog is wanted. */
  request: MarkPaidRequest | null;
  /** A delivered row's "Mark paid…": the dialog for this job's client is wanted. */
  ask: (job: Pick<Job, 'id' | 'clientId' | 'client'>) => void;
  /** The dialog is done with (paid, cancelled, Escape, the page was left): nothing is wanted. */
  close: () => void;
}

/** A new store, with no request. `initial` starts it with one (tests that server-render a state). */
export function createMarkPaidRequestStore(
  initial: MarkPaidRequest | null = null,
): StoreApi<MarkPaidRequestState> {
  return createStore<MarkPaidRequestState>()((set) => ({
    request: initial,
    ask: (job) => set({ request: { jobId: job.id, clientId: job.clientId, client: job.client } }),
    close: () => set({ request: null }),
  }));
}

/** The app-wide store. Tests that need isolation build their own with `createMarkPaidRequestStore`. */
export const markPaidRequestStore = createMarkPaidRequestStore();

/** Ask for the dialog (the row's banknote button, and "Mark paid…" in its menu). */
export function askToMarkPaid(
  job: Pick<Job, 'id' | 'clientId' | 'client'>,
  store: StoreApi<MarkPaidRequestState> = markPaidRequestStore,
): void {
  store.getState().ask(job);
}

/** What the dialog's host reads: the current `request` (or `null`) and `close()`. */
export function useMarkPaidRequest(store: StoreApi<MarkPaidRequestState> = markPaidRequestStore): {
  request: MarkPaidRequest | null;
  close: () => void;
} {
  const request = useStore(store, (state) => state.request);
  const close = useStore(store, (state) => state.close);
  return { request, close };
}
