import type { Job, ReviewNote } from '@studio/shared';
import { useCallback, useMemo, useRef } from 'react';
import { useJobFixes, useQuickFixesEnabled, useUndoFix } from '@/data';
import { fixFooter, type NoteFixLine, noteFixLines, waitingNotes } from './fix-lines';
import { type FooterInput, type FooterView, reviewFooter } from './notes-logic';

/** What a Review (the Mac's dialog, the phone's) needs of Quick fixes. */
export interface ReviewFixes {
  /** Quick fixes are on. Off, everything below is today's: no lines, `waiting` is every note, `footer` is `reviewFooter`. */
  enabled: boolean;
  /** Each note's line, by note id; `undefined` while Quick fixes are off (the cards stay as they were). */
  lines: ReadonlyMap<string, NoteFixLine> | undefined;
  /** The notes that wait for Send: what "Send N notes" counts. Every note while Quick fixes are off; `undefined` while the notes load. */
  waiting: readonly ReviewNote[] | undefined;
  /** The footer for these notes, with fixed notes, fixes under way and Auto's plan in its words. */
  footer: (input: FooterInput) => FooterView;
  /** Undo a fixed note's fix. A refusal is a toast with the server's reason. */
  undo: (fixId: string) => void;
  /** An Undo is on its way. */
  undoing: boolean;
}

type Computed = Pick<ReviewFixes, 'enabled' | 'lines' | 'waiting' | 'footer'>;

/**
 * Quick fixes in a job's Review: the fixes of this round (`useJobFixes`, asked only while the switch
 * is on and the job is in Review), the line under each note, the notes that wait for Send, the
 * footer and Undo. With a level instead of Auto (`reviewEffort`) no note is read or fixed, but a
 * fix that was made before still has its line and its Undo.
 *
 * `frozen`: Send or Approve is on its way, or the review is closing. Everything holds still, as the
 * notes do, so nothing flashes on the way out.
 */
export function useReviewFixes(
  job: Job,
  notes: readonly ReviewNote[] | undefined,
  frozen: boolean,
): ReviewFixes {
  const on = useQuickFixesEnabled();
  const { fixes, loaded } = useJobFixes(job.id, on && job.state === 'review');
  const undoFix = useUndoFix(job.id);
  const level = job.reviewEffort;
  const auto = level === null;
  const { reviseMinutes } = job;

  const computed = useMemo<Computed>(() => {
    if (!on) return { enabled: false, lines: undefined, waiting: notes, footer: reviewFooter };
    const context = { auto, loaded };
    return {
      enabled: true,
      lines: notes === undefined ? new Map() : noteFixLines(notes, fixes, context),
      waiting: notes === undefined ? undefined : waitingNotes(notes, fixes, context),
      footer: (input) => fixFooter({ ...input, fixes, auto, loaded, level, reviseMinutes }),
    };
  }, [on, notes, fixes, auto, loaded, level, reviseMinutes]);

  const held = useRef(computed);
  if (!frozen) held.current = computed;

  const { mutate } = undoFix;
  const undo = useCallback((fixId: string) => mutate(fixId), [mutate]);
  return { ...held.current, undo, undoing: undoFix.isPending };
}
