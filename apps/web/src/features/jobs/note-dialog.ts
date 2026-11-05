import { canEditNote, type Job } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';
import type { NoteAttachmentsSession } from './note-attachments';

/**
 * The "Note for the editor" dialog, kept at page level and keyed by job id, like the "Stop this
 * edit?" dialog (`cancel-dialog.ts`): a row's menu item only asks (`askForNote`); the dialog, its
 * requests and its auto-hold belong to the page (`NoteDialogHost`), because the row can move to
 * another page while the person writes.
 *
 * Auto-hold. Writing takes a while, and an arriving or queued job must not start editing before
 * the note is in. So opening the dialog on such a job holds it first (and waits for the server's
 * answer), and the dialog then owns that hold: Save puts the note and then releases the job,
 * Cancel, Escape or a click outside releases it without a note. Writing a note must not cost a job
 * its turn, so that release gives a queued job its place in line back (`deps.release` restores it;
 * the host sends `?restore=1`). A job that was already held, or failed, or cancelled, is not held
 * by the dialog and keeps its state. If the Hold is refused (the job has just started editing)
 * there is nothing to write into any more: the dialog does not open and the refusal is shown.
 *
 * Pictures (Songs, SG5). With the Songs switch on the dialog also takes pictures for the note
 * (`deps.attachments`, see `note-attachments.ts`; their state is not in this store). Save waits for
 * the uploads still on their way and stops, with the reason, if a picture did not attach; Cancel,
 * Escape and a click outside delete the pictures this opening added. Without `deps.attachments`
 * (the switch is off, or the phone) none of this happens and the rules are as they always were.
 *
 * One dialog at a time (it is modal), so the state is one job and a phase:
 *
 *   closed    nothing shows (the last job, text and words stay in the state while it fades out)
 *   holding   the Hold is on its way; the dialog opens when it is answered
 *   writing   the dialog is open and the text can be edited
 *   saving    Save was pressed; the note (and the Release) are on their way and it cannot be closed
 */
export type NoteDialogPhase = 'closed' | 'holding' | 'writing' | 'saving';

/** What the dialog says about the job: name and client, as they were when it was asked for. */
export interface NoteDialogJob {
  id: string;
  name: string;
  client: string;
}

/** The two requests the dialog sends on its own account, whose refusal has no dialog to show it. */
export type NoteHoldAction = 'hold' | 'release';

/** Everything the dialog needs from the outside: the server, and a way to tell the person. */
export interface NoteDialogDeps {
  /** `POST …/hold`; rejects when the server refuses. */
  hold: (jobId: string) => Promise<unknown>;
  /**
   * `POST …/release`, restoring the job's place in line (`?restore=1`: a queued job goes back
   * where it stood, not to the back of the queue); rejects when the server refuses.
   */
  release: (jobId: string) => Promise<unknown>;
  /** `PUT …/note` with the whole text; rejects with the server's words (409: not while editing). */
  save: (jobId: string, note: string) => Promise<unknown>;
  /** A Hold or Release was refused and no dialog is left to say so (a toast). */
  refused: (action: NoteHoldAction, jobId: string, message: string) => void;
  /** The pictures of the opening (Songs): waited for on Save, thrown away on Cancel. Left out, none. */
  attachments?: NoteAttachmentsSession;
}

export interface NoteDialogState {
  /** A row's menu asked for the dialog for this job; the host takes it (`takeAsked`) and starts it. */
  asked: Job | null;
  phase: NoteDialogPhase;
  /** The job of the dialog on screen, or the last one while it fades out. */
  job: NoteDialogJob | null;
  /** The textarea's content. */
  text: string;
  /** This dialog held the job, so it is this dialog's to release. */
  held: boolean;
  /** Why the last Save failed, in the server's words (or the network's); `null` when it did not. */
  error: string | null;

  /** The Note… menu item: remember that this job's dialog was asked for. Ignored while one is open. */
  ask: (job: Job) => void;
  /** The host takes the request: returns it and forgets it, so it starts once. */
  takeAsked: () => Job | null;
  /** The request starts: the job is shown to the dialog, held if it must be. `false` if one is open. */
  begin: (job: Job) => boolean;
  /** The Hold was answered: the dialog opens and owns the hold. `false` if it was closed meanwhile. */
  show: (jobId: string) => boolean;
  /** The Hold was refused: nothing opens. */
  cancelHold: (jobId: string) => void;
  /** The person typed. */
  setText: (text: string) => void;
  /** "Save": the text goes to the server. `false` if there is nothing to save (not writing). */
  startSaving: () => boolean;
  /** The note was refused or lost: back to writing, with the reason. */
  saveFailed: (jobId: string, message: string) => void;
  /** The note is in and the job is back in line: the dialog closes. */
  finish: (jobId: string) => void;
  /** Cancel, Escape, a click outside. Never closes a save that is in flight. */
  close: () => void;
  /** The page is gone: nothing is asked, nothing shows. */
  reset: () => void;
}

/** Arriving and queued jobs wait on their own, so the dialog holds them while the person writes. */
export function holdsWhileWriting(job: Pick<Job, 'state'>): boolean {
  return job.state === 'arriving' || job.state === 'queued';
}

/** Whether the dialog is open for a job that it is holding: the row says "while you write a note". */
export function isWritingNote(
  state: Pick<NoteDialogState, 'phase' | 'job' | 'held'>,
  jobId: string,
): boolean {
  return (
    (state.phase === 'writing' || state.phase === 'saving') && state.held && state.job?.id === jobId
  );
}

/** Whether the dialog is on screen. */
export function isNoteDialogOpen(state: Pick<NoteDialogState, 'phase'>): boolean {
  return state.phase === 'writing' || state.phase === 'saving';
}

const NOTHING = {
  asked: null,
  phase: 'closed',
  job: null,
  text: '',
  held: false,
  error: null,
} as const;

/**
 * A new store, closed. `initial` starts it somewhere else (tests that server-render a state: a
 * server render reads a store's initial state, not what was set on it later).
 */
export function createNoteDialogStore(
  initial: Partial<
    Pick<NoteDialogState, 'asked' | 'phase' | 'job' | 'text' | 'held' | 'error'>
  > = {},
): StoreApi<NoteDialogState> {
  return createStore<NoteDialogState>()((set, get) => ({
    ...NOTHING,
    ...initial,

    ask: (job) => {
      if (get().phase !== 'closed' || !canEditNote(job)) return;
      set({ asked: job });
    },

    takeAsked: () => {
      const { asked } = get();
      if (asked !== null) set({ asked: null });
      return asked;
    },

    begin: (job) => {
      if (get().phase !== 'closed') return false;
      set({
        phase: holdsWhileWriting(job) ? 'holding' : 'writing',
        job: { id: job.id, name: job.name, client: job.client },
        text: job.note ?? '',
        held: false,
        error: null,
      });
      return true;
    },

    show: (jobId) => {
      const { phase, job } = get();
      if (phase !== 'holding' || job?.id !== jobId) return false;
      set({ phase: 'writing', held: true });
      return true;
    },

    cancelHold: (jobId) => {
      const { phase, job } = get();
      if (phase === 'holding' && job?.id === jobId) set({ phase: 'closed' });
    },

    setText: (text) => set({ text }),

    startSaving: () => {
      if (get().phase !== 'writing') return false;
      set({ phase: 'saving', error: null });
      return true;
    },

    saveFailed: (jobId, message) => {
      const { phase, job } = get();
      if (phase === 'saving' && job?.id === jobId) set({ phase: 'writing', error: message });
    },

    finish: (jobId) => {
      const { phase, job } = get();
      if (phase === 'saving' && job?.id === jobId) set({ phase: 'closed' });
    },

    close: () => {
      if (get().phase === 'saving') return;
      set({ phase: 'closed' });
    },

    reset: () => set({ ...NOTHING }),
  }));
}

/** The app-wide store. Tests that need isolation build their own with `createNoteDialogStore`. */
export const noteDialogStore = createNoteDialogStore();

/** Ask for the dialog for a job (the row's Add note… / Edit note… menu item). */
export function askForNote(job: Job, store: StoreApi<NoteDialogState> = noteDialogStore): void {
  store.getState().ask(job);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the server answered 409: the job is not in the state the request needs. */
function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 409;
}

/**
 * Puts a job back in line. A refusal has no dialog to show it, so it is passed on, except the
 * 409 "not held": something else already released the job (or moved it on) while the dialog was
 * open, so there is nothing left for the dialog to undo and nothing to tell the person.
 */
async function release(jobId: string, deps: NoteDialogDeps): Promise<void> {
  try {
    await deps.release(jobId);
  } catch (error) {
    if (!isConflict(error)) deps.refused('release', jobId, messageOf(error));
  }
}

/**
 * Opens the dialog for `job`: an arriving or queued job is held first, and the dialog waits for
 * the server's answer. A refused Hold (the job has just started editing) opens nothing and is
 * passed to `deps.refused`. Jobs that cannot take a note (editing, ready) are ignored.
 *
 * It runs on the store, not in a component, so the answer lands even if the host has unmounted.
 */
export async function startNoteDialog(
  job: Job,
  deps: NoteDialogDeps,
  store: StoreApi<NoteDialogState> = noteDialogStore,
): Promise<void> {
  if (!canEditNote(job) || !store.getState().begin(job)) return;
  if (!holdsWhileWriting(job)) return;

  try {
    await deps.hold(job.id);
  } catch (error) {
    store.getState().cancelHold(job.id);
    deps.refused('hold', job.id, messageOf(error));
    return;
  }
  // The dialog was closed while the job was being held (the page was left): nobody is writing, so
  // the job must not stay held.
  if (!store.getState().show(job.id)) await release(job.id, deps);
}

/**
 * "Save": sends the text, then puts the job back in line, but only if the dialog held it. The
 * dialog closes when both are answered. If the note is refused (400, 404, 409 because the job has
 * started editing meanwhile, or the server cannot be reached) the dialog stays open with the text
 * as it was and says why; the job stays held, so Cancel still puts it back. A Release that is
 * refused after the note was saved does not keep the dialog open: the note is in, so it closes and
 * the refusal is passed to `deps.refused` (unless it is the 409 "not held", see `release`).
 *
 * With pictures (`deps.attachments`) they come first: Save waits for the uploads still on their
 * way and removes the earlier pictures that were taken off. A picture that did not attach, or a
 * removal the engine refuses, stops the save the same way a refused note does (the dialog stays
 * open and says why); once the note is in, the pictures are kept.
 */
export async function saveNoteDialog(
  deps: NoteDialogDeps,
  store: StoreApi<NoteDialogState> = noteDialogStore,
): Promise<void> {
  const { job, text, held } = store.getState();
  if (job === null || !store.getState().startSaving()) return;

  if (deps.attachments !== undefined) {
    let problem: string | null;
    try {
      problem = await deps.attachments.settle();
    } catch (error) {
      problem = messageOf(error);
    }
    if (problem !== null) {
      store.getState().saveFailed(job.id, problem);
      return;
    }
  }

  try {
    await deps.save(job.id, text);
  } catch (error) {
    store.getState().saveFailed(job.id, messageOf(error));
    return;
  }
  if (held) await release(job.id, deps);
  // The note is in: the pictures stay on it.
  deps.attachments?.keep();
  store.getState().finish(job.id);
}

/**
 * Cancel, Escape or a click outside: closes the dialog, and puts the job back in line if the
 * dialog held it. Does nothing while a save is in flight (it closes itself when that ends).
 */
export async function dismissNoteDialog(
  deps: NoteDialogDeps,
  store: StoreApi<NoteDialogState> = noteDialogStore,
): Promise<void> {
  const { phase, job, held } = store.getState();
  if (job === null || phase === 'closed' || phase === 'saving') return;
  store.getState().close();
  // The pictures this opening added go with it (and only those); nothing waits for them.
  if (phase === 'writing') void deps.attachments?.discard().catch(() => undefined);
  // While `holding` the Hold has not been answered, so there is nothing to release yet:
  // `startNoteDialog` finds the dialog closed when it is, and releases then.
  if (phase === 'writing' && held) await release(job.id, deps);
}

/** The dialog's state, for the host. */
export function useNoteDialog(store: StoreApi<NoteDialogState> = noteDialogStore) {
  return useStore(store, (state) => state);
}
