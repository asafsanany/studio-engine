import { type Job, jobNameProblem, normalizeJobName } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/** What the "Rename this video" dialog needs to know about the job it is about. */
export type RenameTarget = Pick<Job, 'id' | 'client' | 'name'>;

/**
 * The "Rename this video" dialog, kept at page level like the delete dialog: the row only asks
 * (`askToRename`), the page shows the dialog (`RenameJobDialogHost`) and sends the request. `job` is
 * what the question is about; `null` while no dialog shows. `name` is what is in the input, and
 * `error` the server's reason when the rename failed (a name that is taken, a job that is busy).
 */
export interface RenameDialogState {
  job: RenameTarget | null;
  name: string;
  pending: boolean;
  error: string | null;
  ask: (job: RenameTarget) => void;
  setName: (name: string) => void;
  setPending: (pending: boolean) => void;
  fail: (error: string) => void;
  dismiss: () => void;
}

export function createRenameDialogStore(
  // A server render reads a store's initial state, so tests build one already in the state to see.
  initial: Partial<Pick<RenameDialogState, 'job' | 'name' | 'pending' | 'error'>> = {},
): StoreApi<RenameDialogState> {
  return createStore<RenameDialogState>()((set) => ({
    job: null,
    name: '',
    pending: false,
    error: null,
    ...initial,
    ask: (job) => set({ job, name: job.name, pending: false, error: null }),
    // Typing again clears the server's last answer: it was about the name before.
    setName: (name) => set({ name, error: null }),
    setPending: (pending) => set({ pending, error: null }),
    fail: (error) => set({ pending: false, error }),
    dismiss: () => set({ job: null, name: '', pending: false, error: null }),
  }));
}

export const renameDialogStore = createRenameDialogStore();

/** Asks the page for the "Rename this video" dialog. */
export function askToRename(job: RenameTarget): void {
  renameDialogStore.getState().ask(job);
}

export function useRenameDialog(store: StoreApi<RenameDialogState> = renameDialogStore) {
  return useStore(store);
}

/**
 * What the dialog shows about the typed name: `problem` is why it cannot be a folder's name (only
 * once something is typed: an empty box is just not ready), and `ready` is whether Rename can be
 * pressed: a name a folder can have that is not the job's own (compared in NFC).
 */
export function renameReadiness(
  job: RenameTarget | null,
  name: string,
): { problem: string | null; ready: boolean } {
  const typed = jobNameProblem(name);
  const unchanged = job !== null && normalizeJobName(name) === job.name.normalize('NFC');
  return {
    problem: name.trim() === '' ? null : typed,
    ready: job !== null && typed === null && !unchanged,
  };
}

/** What `confirmRename` needs from the page. */
export interface RenameDeps {
  /** `api.renameJob`. */
  rename: (id: string, name: string) => Promise<Job>;
  /** The job is renamed (its id is new): the page updates its list and moves an open sheet. */
  onRenamed: (before: RenameTarget, renamed: Job) => Promise<void> | void;
  /** Tells the person it is done. */
  notify: (message: string, description: string) => void;
}

/**
 * Rename was pressed (or Enter): sends the name and waits for the answer. A refusal (a name that
 * is taken, a job the engine is working in) stays in the dialog under the input. When it is done
 * the dialog closes, the page is told, and the person gets a message. Does nothing unless
 * `renameReadiness` says the name is ready, or while a request is on its way. Resolves with the
 * renamed job, or `null` when nothing was renamed.
 */
export async function confirmRename(
  deps: RenameDeps,
  store: StoreApi<RenameDialogState> = renameDialogStore,
): Promise<Job | null> {
  const { job, name, pending } = store.getState();
  if (job === null || pending || !renameReadiness(job, name).ready) return null;
  store.getState().setPending(true);
  let renamed: Job;
  try {
    renamed = await deps.rename(job.id, name);
  } catch (err) {
    store.getState().fail(err instanceof Error ? err.message : String(err));
    return null;
  }
  store.getState().dismiss();
  await deps.onRenamed(job, renamed);
  deps.notify(`Renamed to “${renamed.name}”`, renamed.client);
  return renamed;
}
