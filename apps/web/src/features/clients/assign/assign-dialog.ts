import { createStore, type StoreApi, useStore } from 'zustand';

/** The client "Assign to…" is about. */
export interface AssignTarget {
  clientId: string;
  name: string;
}

/**
 * The "Assign to…" dialog, kept at page level like the delete dialog: the row only asks
 * (`askToAssign`), the page shows the dialog (`AssignClientDialogHost`). `client` is what the
 * question is about; `null` while no dialog shows.
 */
export interface AssignDialogState {
  client: AssignTarget | null;
  ask: (client: AssignTarget) => void;
  dismiss: () => void;
}

export function createAssignDialogStore(): StoreApi<AssignDialogState> {
  return createStore<AssignDialogState>()((set) => ({
    client: null,
    ask: (client) => set({ client }),
    dismiss: () => set({ client: null }),
  }));
}

export const assignDialogStore = createAssignDialogStore();

/** Asks the page to open "Assign to…" for this client. */
export function askToAssign(client: AssignTarget): void {
  assignDialogStore.getState().ask(client);
}

export function useAssignDialog(store: StoreApi<AssignDialogState> = assignDialogStore) {
  return useStore(store);
}
