import type { Job } from '@studio/shared';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { StoreApi } from 'zustand';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useDraftChatEnabled } from '@/data';
import { rowFocusTarget } from '@/features/jobs/row-focus';
import { ReviewDialog } from './ReviewDialog';
import { type ReviewDialogState, reviewDialogStore, useReviewDialog } from './review-dialog';
import { REVIEW_DIALOG_TEXT } from './review-text';

interface ReviewDialogHostProps {
  /** The full job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** Where the dialog's state lives. Tests pass their own; the page uses the shared one. */
  store?: StoreApi<ReviewDialogState>;
}

/**
 * The review dialog for the whole Jobs page. A row's Review button or menu item only asks
 * (`openReview`); the dialog lives here, one level above the table, so it survives the row moving
 * to another page.
 *
 * - It follows the job: when the job leaves Review (or the list) while the dialog is open and no
 *   Send or Approve is in flight, the dialog closes and a toast says so. While one is in flight the
 *   dialog stays open even though the optimistic update already shows the job as queued.
 * - Closing keeps the same instance (so it can fade out) until the next opening replaces it, and
 *   gives focus to the row's Review button, or to the row, when it is on the page.
 *
 * Mount it once, on the page. It renders nothing until a dialog is asked for.
 */
export function ReviewDialogHost({ jobs, store = reviewDialogStore }: ReviewDialogHostProps) {
  const { jobId, session } = useReviewDialog(store);
  const job = jobs?.find((candidate) => candidate.id === jobId);
  // Draft & chat: the dialog is the job's chat, open through its runs too.
  const chat = useDraftChatEnabled();

  // Follow the job: it left Review or the list (and no Send/Approve is in flight) → close and say so.
  useEffect(() => {
    if (jobId === null || jobs === undefined) return;
    if (store.getState().checkJob(jobId, job, chat)) toast(REVIEW_DIALOG_TEXT.left);
  }, [store, jobId, jobs, job, chat]);

  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().reset(), [store]);

  // The last job shown, for the closing animation and the focus that goes back to its row.
  const last = useRef<Job | null>(null);
  useEffect(() => {
    if (job !== undefined) last.current = job;
  }, [job]);
  const shown = job ?? last.current;
  if (shown === null) return null;

  return (
    <TooltipProvider>
      <ReviewDialog
        // A fresh dialog at every opening: the playhead, the hover and the recorder of the last one don't carry over.
        key={session}
        job={shown}
        store={store}
        open={jobId !== null && job !== undefined}
        onOpenChange={(open) => {
          if (!open) store.getState().close();
        }}
        onCloseAutoFocus={(event) => {
          // No trigger element to give focus back to: the row's Review button gets it.
          event.preventDefault();
          if (last.current) rowFocusTarget(last.current.id)?.focus();
        }}
      />
    </TooltipProvider>
  );
}
