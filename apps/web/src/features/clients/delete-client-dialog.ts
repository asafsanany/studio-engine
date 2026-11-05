import { createStore, type StoreApi, useStore } from 'zustand';

/** The client "Delete client" is about. */
export interface DeleteClientTarget {
  clientId: string;
  name: string;
  /** How many videos the engine knows for it: the dialog says they go too. */
  jobCount: number;
}

/**
 * The "Delete this client?" dialog, kept at page level like "Rename client": the row only asks
 * (`askToDeleteClient`), the page shows the dialog (`DeleteClientDialogHost`) and sends the
 * request. `client` is what the question is about; `null` while no dialog shows. `error` is the
 * server's reason when the delete failed (a job the engine is working on, a folder it could not
 * move).
 */
export interface DeleteClientDialogState {
  client: DeleteClientTarget | null;
  pending: boolean;
  error: string | null;
  ask: (client: DeleteClientTarget) => void;
  setPending: (pending: boolean) => void;
  fail: (error: string) => void;
  dismiss: () => void;
}

export function createDeleteClientDialogStore(
  // A server render reads a store's initial state, so tests build one already in the state to see.
  initial: Partial<Pick<DeleteClientDialogState, 'client' | 'pending' | 'error'>> = {},
): StoreApi<DeleteClientDialogState> {
  return createStore<DeleteClientDialogState>()((set) => ({
    client: null,
    pending: false,
    error: null,
    ...initial,
    ask: (client) => set({ client, pending: false, error: null }),
    setPending: (pending) => set({ pending, error: null }),
    fail: (error) => set({ pending: false, error }),
    dismiss: () => set({ client: null, pending: false, error: null }),
  }));
}

export const deleteClientDialogStore = createDeleteClientDialogStore();

/** Asks the page to confirm deleting this client. */
export function askToDeleteClient(client: DeleteClientTarget): void {
  deleteClientDialogStore.getState().ask(client);
}

export function useDeleteClientDialog(
  store: StoreApi<DeleteClientDialogState> = deleteClientDialogStore,
) {
  return useStore(store);
}

/** What the dialog says goes: the folders to the Trash, and the videos and payments from the app. */
export function deleteClientWarning(jobCount: number): string {
  const folders = 'Its folder in Studio Inbox and its exports go to the Trash.';
  if (jobCount === 0) return folders;
  if (jobCount === 1)
    return `${folders} Its video is removed from the app, and its payment from Money.`;
  return `${folders} Its ${jobCount} videos are removed from the app, and their payments from Money.`;
}
