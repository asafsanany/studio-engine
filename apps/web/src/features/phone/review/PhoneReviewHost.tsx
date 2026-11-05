import type { Job } from '@studio/shared';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { StoreApi } from 'zustand';
import { useDraftChatEnabled } from '@/data';
import { isRunning } from '@/features/job-chat/job-chat-logic';
import {
  type ReviewDialogState,
  reviewDialogStore,
  useReviewDialog,
} from '@/features/review/review-dialog';
import { REVIEW_DIALOG_TEXT } from '@/features/review/review-text';
import { PhoneChatReview } from './PhoneChatReview';
import { PhoneReview } from './PhoneReview';
import type { PhoneDone } from './phone-review';

interface PhoneReviewHostProps {
  /** The full job list from `useJobs()`: `undefined` until the first load. */
  jobs: readonly Job[] | undefined;
  /** Where the review's state lives. Tests pass their own; the shell uses the shared one. */
  store?: StoreApi<ReviewDialogState>;
}

/**
 * The phone Review for the whole app, in the phone shell next to the job sheet's host: whoever
 * wants a review (a Review row's Play icon, the job sheet's Review button) calls the Mac's
 * `openReview`, the same function the Mac's rows call, and this host shows it full screen. The
 * Mac's `ReviewDialogHost` stays out while the phone layout shows (see `JobsListSection`).
 *
 * - It follows the job as the Mac's host does: when the job leaves Review (or the list) while the
 *   review is open and no Send or Approve is in flight, it closes and a toast says so.
 * - After a Send or Approve went through it stays open instead: the footer says what happened and
 *   has a Close. The job has left Review by then, so the host stops following it until the
 *   review is closed.
 * - Closing keeps the same instance until the next opening replaces it, so it can fade out.
 * - Draft & chat (when on): a job that waits in line or runs shows its chat full screen
 *   (`PhoneChatReview`), and the review stays open through the run; after a Send or Approve the
 *   round, or the render, streams there, and back in Review it is a fresh phone Review.
 */
export function PhoneReviewHost({ jobs, store = reviewDialogStore }: PhoneReviewHostProps) {
  const { jobId, session } = useReviewDialog(store);
  const job = jobs?.find((candidate) => candidate.id === jobId);
  // What was sent or approved in this opening; an older opening's does not carry over.
  const [submitted, setSubmitted] = useState<{ session: number; done: PhoneDone } | null>(null);
  const done = submitted?.session === session ? submitted.done : null;
  const chat = useDraftChatEnabled();
  const running = chat && job !== undefined && isRunning(job);

  // With the chat, the done line gives way to the run it started: the chat shows it.
  useEffect(() => {
    if (running) setSubmitted(null);
  }, [running]);

  // Follow the job: it left Review or the list (and nothing is in flight or done) → close and say so.
  useEffect(() => {
    if (jobId === null || jobs === undefined || done !== null) return;
    if (store.getState().checkJob(jobId, job, chat)) toast(REVIEW_DIALOG_TEXT.left);
  }, [store, jobId, jobs, job, done, chat]);

  // Leaving the page closes the review; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().reset(), [store]);

  // The last job shown, for the closing animation.
  const last = useRef<Job | null>(null);
  useEffect(() => {
    if (job !== undefined) last.current = job;
  }, [job]);
  const shown = job ?? last.current;
  if (shown === null) return null;

  if (chat && isRunning(shown)) {
    return (
      <PhoneChatReview
        key={`${session}-chat`}
        job={shown}
        open={jobId !== null && job !== undefined}
        onOpenChange={(open) => {
          if (!open) store.getState().close();
        }}
      />
    );
  }

  return (
    <PhoneReview
      // A fresh review at every opening: the playhead and the open notes of the last one don't carry over.
      key={session}
      job={shown}
      store={store}
      open={jobId !== null && job !== undefined}
      onOpenChange={(open) => {
        if (!open) store.getState().close();
      }}
      done={done}
      onSubmitted={(sent) => setSubmitted({ session, done: sent })}
    />
  );
}
