// What the sheet's header says about a job's status: the word, the dot's colour and, for a cut that
// has been revised, which round it is.

import { isFolderDeleted, type Job, jobStage } from '@studio/shared';
import { type IconKind, iconKindOf } from '@/features/jobs/JobStatusIcon';

/** The status badge: a coloured dot, a word and, for a revised cut, a muted "round 2". */
export interface SheetStatus {
  label: string;
  /** The dot's background colour (a utility class, so Tailwind finds it). */
  dot: string;
  /** "round 2" next to "Ready to review" once notes were sent; `null` otherwise. */
  round: string | null;
}

/** The word of each status. A ready job says its stage; a render run says Rendering. */
const LABELS = {
  arriving: 'Arriving',
  queued: 'Queued',
  held: 'Held',
  editing: 'Editing',
  review: 'Ready to review',
  approved: 'Approved',
  delivered: 'Delivered',
  uploaded: 'Uploaded',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const satisfies Record<IconKind, string>;

/** The dot's colour: the status colours the list's icons and counters use. */
const DOTS = {
  arriving: 'bg-status-neutral',
  queued: 'bg-status-neutral',
  held: 'bg-status-held',
  editing: 'bg-status-editing',
  review: 'bg-status-review',
  approved: 'bg-status-ready',
  delivered: 'bg-status-delivered',
  uploaded: 'bg-status-uploaded',
  paid: 'bg-status-paid',
  failed: 'bg-status-failed',
  cancelled: 'bg-status-cancelled',
} as const satisfies Record<IconKind, string>;

/**
 * The status of a job for the sheet's header: its state, or for a ready job its stage (Approved,
 * Delivered, Uploaded, Paid). An editing job on a render run (after Approve) is Rendering, in the same blue.
 *
 * The round is numbered as the cut is, the way the boards do: `Job.round` counts the rounds of
 * notes that were sent, so the cut that has them is round `job.round + 1`, shown from the second.
 */
export function sheetStatus(
  job: Pick<Job, 'state' | 'delivery' | 'runKind' | 'round'>,
): SheetStatus {
  const kind = iconKindOf(job);
  const rendering = job.state === 'editing' && job.runKind === 'render';
  return {
    label: rendering ? 'Rendering' : LABELS[kind],
    dot: DOTS[kind],
    round: job.state === 'review' && job.round > 0 ? `round ${job.round + 1}` : null,
  };
}

/** Whether the job is done with, so its name is drawn muted as in the list: paid, or its folder is gone. */
export function isDoneWith(job: Job): boolean {
  return jobStage(job) === 'paid' || isFolderDeleted(job);
}

/** "14:43": a moment on the wall clock of the browser, 24-hour. */
export function clockTime(moment: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}
