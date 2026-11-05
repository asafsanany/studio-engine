import type { Job } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/**
 * The "Delete this video?" dialog, kept at page level like the cancel dialog: the row only asks
 * (`askToDelete`), the page shows the dialog (`DeleteJobDialogHost`) and sends the request.
 * `job` is what the question is about; `null` while no dialog shows. `error` is the server's
 * reason when the delete failed.
 */
export interface DeleteDialogState {
  job: Pick<Job, 'id' | 'client' | 'name' | 'delivery'> | null;
  pending: boolean;
  error: string | null;
  ask: (job: Pick<Job, 'id' | 'client' | 'name' | 'delivery'>) => void;
  setPending: (pending: boolean) => void;
  fail: (error: string) => void;
  dismiss: () => void;
}

export function createDeleteDialogStore(): StoreApi<DeleteDialogState> {
  return createStore<DeleteDialogState>()((set) => ({
    job: null,
    pending: false,
    error: null,
    ask: (job) => set({ job, pending: false, error: null }),
    setPending: (pending) => set({ pending, error: null }),
    fail: (error) => set({ pending: false, error }),
    dismiss: () => set({ job: null, pending: false, error: null }),
  }));
}

export const deleteDialogStore = createDeleteDialogStore();

/** Asks the page to confirm deleting this job. */
export function askToDelete(job: Pick<Job, 'id' | 'client' | 'name' | 'delivery'>): void {
  deleteDialogStore.getState().ask(job);
}

export function useDeleteDialog(store: StoreApi<DeleteDialogState> = deleteDialogStore) {
  return useStore(store);
}
