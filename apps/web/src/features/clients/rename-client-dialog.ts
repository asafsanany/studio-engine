import { type ClientRow, clientNameProblem, normalizeClientName } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/** The client "Rename client" is about. */
export interface RenameClientTarget {
  clientId: string;
  name: string;
}

/**
 * The "Rename client" dialog, kept at page level like "Assign to…": the row only asks
 * (`askToRenameClient`), the page shows the dialog (`RenameClientDialogHost`) and sends the
 * request. `client` is what the question is about; `null` while no dialog shows. `name` is what is
 * in the input, and `error` the server's reason when the rename failed (a name that is taken, a
 * job the engine is working on).
 */
export interface RenameClientDialogState {
  client: RenameClientTarget | null;
  name: string;
  pending: boolean;
  error: string | null;
  ask: (client: RenameClientTarget) => void;
  setName: (name: string) => void;
  setPending: (pending: boolean) => void;
  fail: (error: string) => void;
  dismiss: () => void;
}

export function createRenameClientDialogStore(
  // A server render reads a store's initial state, so tests build one already in the state to see.
  initial: Partial<Pick<RenameClientDialogState, 'client' | 'name' | 'pending' | 'error'>> = {},
): StoreApi<RenameClientDialogState> {
  return createStore<RenameClientDialogState>()((set) => ({
    client: null,
    name: '',
    pending: false,
    error: null,
    ...initial,
    ask: (client) => set({ client, name: client.name, pending: false, error: null }),
    // Typing again clears the server's last answer: it was about the name before.
    setName: (name) => set({ name, error: null }),
    setPending: (pending) => set({ pending, error: null }),
    fail: (error) => set({ pending: false, error }),
    dismiss: () => set({ client: null, name: '', pending: false, error: null }),
  }));
}

export const renameClientDialogStore = createRenameClientDialogStore();

/** Asks the page for the "Rename client" dialog. */
export function askToRenameClient(client: RenameClientTarget): void {
  renameClientDialogStore.getState().ask(client);
}

export function useRenameClientDialog(
  store: StoreApi<RenameClientDialogState> = renameClientDialogStore,
) {
  return useStore(store);
}

/**
 * What the dialog shows about the typed name: `problem` is why it cannot be a client's name (the
 * rules of New client, and only once something is typed: an empty box is just not ready), and
 * `ready` is whether Rename can be pressed: a name a client can have that is not its own
 * (compared in NFC).
 */
export function renameClientReadiness(
  client: RenameClientTarget | null,
  name: string,
): { problem: string | null; ready: boolean } {
  const typed = clientNameProblem(name);
  const unchanged = client !== null && normalizeClientName(name) === client.name.normalize('NFC');
  return {
    problem: name.trim() === '' ? null : typed,
    ready: client !== null && typed === null && !unchanged,
  };
}

/** What `confirmRenameClient` needs from the page. */
export interface RenameClientDeps {
  /** `api.renameClient`. */
  rename: (clientId: string, name: string) => Promise<ClientRow>;
  /** The client is renamed (its id is new, and its jobs'): the page updates its lists. */
  onRenamed: (before: RenameClientTarget, renamed: ClientRow) => Promise<void> | void;
  /** Tells the person it is done. */
  notify: (message: string) => void;
}

/**
 * Rename was pressed (or Enter): sends the name and waits for the answer. A refusal stays in the
 * dialog under the input. When it is done the dialog closes, the page is told, and the person gets
 * a message. Does nothing unless `renameClientReadiness` says the name is ready, or while a request
 * is on its way. Resolves with the client's new row, or `null` when nothing was renamed.
 */
export async function confirmRenameClient(
  deps: RenameClientDeps,
  store: StoreApi<RenameClientDialogState> = renameClientDialogStore,
): Promise<ClientRow | null> {
  const { client, name, pending } = store.getState();
  if (client === null || pending || !renameClientReadiness(client, name).ready) return null;
  store.getState().setPending(true);
  let renamed: ClientRow;
  try {
    renamed = await deps.rename(client.clientId, name);
  } catch (err) {
    store.getState().fail(err instanceof Error ? err.message : String(err));
    return null;
  }
  store.getState().dismiss();
  await deps.onRenamed(client, renamed);
  deps.notify(`Renamed to “${renamed.client}”`);
  return renamed;
}
