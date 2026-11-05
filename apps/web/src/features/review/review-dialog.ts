import type { Job } from '@studio/shared';
import { createStore, type StoreApi, useStore } from 'zustand';

/**
 * The review dialog, kept at page level like the "Stop this edit?" dialog (`cancel-dialog.ts`): a
 * row only asks (`openReview`), and the page shows the dialog (`ReviewDialogHost`), so what is on
 * screen does not depend on which rows are on the page.
 *
 * - `session` counts the openings. The host keys the dialog by it, so every opening is a fresh
 *   component (the playhead, the hover and the recorder of the last one don't carry over) while the
 *   closed one stays mounted for its fade-out until the next opening replaces it.
 * - A Send or Approve in flight (`submitting`) stops the dialog from following the job's state: the
 *   optimistic update moves the job to queued before the server answers, and the dialog must not
 *   close on that.
 * - The composer's drafts live for the browser session only (not localStorage), per job id.
 */

/** Send notes or Approve: the footer action that is on its way (W10). */
export type ReviewSubmitAction = 'send_notes' | 'approve';
export type ReviewSubmitResult = { ok: true; stayOpen?: boolean } | { ok: false; error: string };

export interface ReviewDialogState {
  /** The job whose dialog is open; null while none is. */
  jobId: string | null;
  /** Counts the openings (0 before the first). The host keys the dialog by it, so every opening starts fresh. */
  session: number;
  /** The composer's unsent text, per job id (W10). Kept after the dialog closes, for the session. */
  drafts: Readonly<Record<string, string>>;
  /** Send or Approve is on its way: the dialog can't be closed and stops following the job's state. */
  submitting: ReviewSubmitAction | null;
  /** Why the last Send or Approve was refused, in the server's words; shown in the footer (W10). */
  submitError: string | null;
  /** Opens the dialog for a job. Ignored while submitting; counts a new session and clears the error. */
  open: (jobId: string) => void;
  /** Closes the dialog. Ignored while submitting; clears the error. */
  close: () => void;
  /** Keeps the composer's text for a job; '' removes it. */
  setDraft: (jobId: string, text: string) => void;
  /** Send or Approve was pressed: false unless the dialog is open and nothing is submitting. */
  beginSubmit: (action: ReviewSubmitAction) => boolean;
  /**
   * The server answered: ok closes the dialog (the phone's Review asks to `stayOpen`: its footer
   * says it is done and has a Close), not ok keeps it open with the reason. Ignored when nothing
   * is submitting.
   */
  endSubmit: (result: ReviewSubmitResult) => void;
  /**
   * The open dialog's job changed (or left the list): closes and returns true when it is no longer
   * in review and nothing is submitting. Otherwise changes nothing and returns false. With `chat`
   * (Draft & chat on) a job that waits in line or runs keeps it open too.
   */
  checkJob: (jobId: string, job: Job | undefined, chat?: boolean) => boolean;
  /** The page is gone: closes and forgets the submission; the drafts (and the session count) stay. */
  reset: () => void;
}

type ReviewDialogInitial = Partial<
  Pick<ReviewDialogState, 'jobId' | 'session' | 'drafts' | 'submitting' | 'submitError'>
>;

/**
 * A new store, closed. `initial` starts it somewhere else (tests that server-render a state: a
 * server render reads a store's initial state, not what was set on it later).
 */
export function createReviewDialogStore(
  initial: ReviewDialogInitial = {},
): StoreApi<ReviewDialogState> {
  return createStore<ReviewDialogState>()((set, get) => ({
    jobId: null,
    session: 0,
    drafts: {},
    submitting: null,
    submitError: null,
    ...initial,

    open: (jobId) => {
      if (get().submitting !== null) return;
      set((state) => ({ jobId, session: state.session + 1, submitError: null }));
    },

    close: () => {
      if (get().submitting !== null) return;
      set({ jobId: null, submitError: null });
    },

    setDraft: (jobId, text) => {
      set((state) => {
        const { [jobId]: _removed, ...rest } = state.drafts;
        return { drafts: text === '' ? rest : { ...rest, [jobId]: text } };
      });
    },

    beginSubmit: (action) => {
      const { jobId, submitting } = get();
      if (jobId === null || submitting !== null) return false;
      set({ submitting: action, submitError: null });
      return true;
    },

    endSubmit: (result) => {
      if (get().submitting === null) return;
      if (result.ok) {
        set({
          submitting: null,
          submitError: null,
          ...(result.stayOpen === true ? {} : { jobId: null }),
        });
      } else set({ submitting: null, submitError: result.error });
    },

    checkJob: (jobId, job, chat = false) => {
      const { jobId: current, submitting } = get();
      if (current !== jobId || submitting !== null || job?.state === 'review') return false;
      // The job's chat (Draft & chat) follows the job through its runs: it stays open while one
      // waits or goes on, and Send and Approve leave it open to show the round or the render.
      if (chat && (job?.state === 'queued' || job?.state === 'editing')) return false;
      set({ jobId: null, submitError: null });
      return true;
    },

    reset: () => set({ jobId: null, submitting: null, submitError: null }),
  }));
}

/** The app-wide store. Tests that need isolation build their own with `createReviewDialogStore`. */
export const reviewDialogStore = createReviewDialogStore();

/** The row's Review button and its Review… menu item. */
export function openReview(
  jobId: string,
  store: StoreApi<ReviewDialogState> = reviewDialogStore,
): void {
  store.getState().open(jobId);
}

/** The draft of one job ('' when none). */
export function reviewDraftOf(state: Pick<ReviewDialogState, 'drafts'>, jobId: string): string {
  return state.drafts[jobId] ?? '';
}

/** The dialog's state, for the host. */
export function useReviewDialog(store: StoreApi<ReviewDialogState> = reviewDialogStore) {
  return useStore(store, (state) => state);
}
