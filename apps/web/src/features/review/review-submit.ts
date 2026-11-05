import type { StoreApi } from 'zustand';
import { sentToast } from './notes-logic';
import type { ReviewDialogState, ReviewSubmitAction } from './review-dialog';
import { FOOTER_TEXT } from './review-text';

export interface SubmitReviewDeps {
  store: StoreApi<ReviewDialogState>;
  /** `useJobAction(action).mutateAsync`. */
  run: (jobId: string) => Promise<unknown>;
  /** `toast.success`. Left out where the screen says it itself (the phone's footer). */
  notify?: (message: string) => void;
  /**
   * The phone's Review: after a success the dialog stays open, its footer says what happened and
   * has a Close. `onSubmitted` runs just before the store is told, in the same tick, so the host
   * knows before it sees the job leave Review.
   */
  stayOpen?: boolean;
  onSubmitted?: () => void;
}

/**
 * Send notes or Approve: keeps the dialog open while it runs, then closes it with a toast (or, on
 * the phone, leaves it open for its footer to say so), or keeps it open with the server's reason
 * (shown in the footer).
 *
 * `counts` are taken before the request: a successful Send clears the job's notes from the cache,
 * so they can't be read afterwards. Does nothing when the dialog is closed or a submission is
 * already on its way.
 */
export async function submitReview(
  action: ReviewSubmitAction,
  jobId: string,
  counts: { notes: number; styled: number },
  deps: SubmitReviewDeps,
): Promise<void> {
  const { store, run, notify, stayOpen, onSubmitted } = deps;
  if (!store.getState().beginSubmit(action)) return;
  try {
    await run(jobId);
  } catch (error) {
    store
      .getState()
      .endSubmit({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  onSubmitted?.();
  store.getState().endSubmit({ ok: true, stayOpen });
  notify?.(action === 'send_notes' ? sentToast(counts.notes, counts.styled) : FOOTER_TEXT.approved);
}
