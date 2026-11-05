import { groupOf, type Job } from '@studio/shared';
import type { CSSProperties } from 'react';
import { toast } from 'sonner';
import { STATUS_LABELS } from '@/components/jobs/StatusBadge';
import { ACTION_ERROR_MS } from './cells/ActionError';
import { TAB_LABELS } from './JobsToolbar';
import { UNDO_BUTTON_CLASS } from './use-look/use-look-toasts';

/** How long a message about the archive stays: long enough to read it and reach for Undo. */
export const ARCHIVE_TOAST_MS = 7000;

/**
 * The messages about the archive are 420 px wide, the board's, where sonner's are 356: "Archived
 * “<name>” · it still counts on Money" then fits on one line, with Undo beside it. Sonner draws a
 * toast `var(--width)` wide, so this widens just these (the delivery messages have their own
 * width), and a toast is anchored to the right edge, so it grows to the left.
 */
export const ARCHIVE_TOAST_STYLE = { '--width': '420px' } as CSSProperties;

/** What a message needs to know about a job: its id and its name. */
export type ArchiveToastJob = Pick<Job, 'id' | 'name'>;

/**
 * The toast id of one kind of message about the archive: the newest replaces the one before (so
 * Undo is always the newest change's). Each kind has its own id: Undo closes its message when it is
 * pressed, and a message that reuses the id of one that is closing is swallowed by it. "All paid"
 * has no job of its own.
 */
export const archiveToastId = (
  kind: 'archived' | 'unarchived' | 'left' | 'undo-refused',
  jobId: string,
) => `archive:${kind}:${jobId}`;

/** The id of the message after Archive all paid. */
export const ARCHIVED_PAID_TOAST_ID = 'archive:paid';

/** A message that lasts 7 s, 420 px wide, and has Undo, a quiet outlined button (the Use this look message's). */
function withUndo(onUndo: () => void) {
  return {
    duration: ARCHIVE_TOAST_MS,
    style: ARCHIVE_TOAST_STYLE,
    action: { label: 'Undo', onClick: onUndo },
    classNames: { actionButton: UNDO_BUTTON_CLASS },
  };
}

/** After Archive: `Archived “<name>” · it still counts on Money`, with Undo. The name keeps its direction. */
export function announceArchived(job: ArchiveToastJob, onUndo: () => void): void {
  toast(
    <>
      Archived “<bdi>{job.name}</bdi>” · it still counts on Money
    </>,
    { id: archiveToastId('archived', job.id), ...withUndo(onUndo) },
  );
}

/** After Archive all paid: `Archived 3 paid videos · they still count on Money`, with Undo. */
export function announceArchivedPaid(count: number, onUndo: () => void): void {
  toast(`Archived ${count} paid videos · they still count on Money`, {
    id: ARCHIVED_PAID_TOAST_ID,
    ...withUndo(onUndo),
  });
}

/**
 * After Unarchive: `Back in Paid: “<name>”`, with Undo. `job` is the job as the server answered,
 * which says the tab it is back in (a finished job by its stage).
 */
export function announceUnarchived(
  job: Pick<Job, 'id' | 'name' | 'state' | 'delivery'>,
  onUndo: () => void,
): void {
  toast(
    <>
      Back in {TAB_LABELS[groupOf(job)]}: “<bdi>{job.name}</bdi>”
    </>,
    { id: archiveToastId('unarchived', job.id), ...withUndo(onUndo) },
  );
}

/**
 * After Retry, Resume or Release on an archived job: `Left the archive: “<name>” is queued again`.
 * There is nothing to undo; the server took the job out of the archive by itself. `job` is the job
 * as the server answered, in its new state.
 */
export function announceLeftArchive(job: Pick<Job, 'id' | 'name' | 'state'>): void {
  toast(
    <>
      Left the archive: “<bdi>{job.name}</bdi>” is {STATUS_LABELS[job.state].toLowerCase()} again
    </>,
    { id: archiveToastId('left', job.id), duration: ARCHIVE_TOAST_MS, style: ARCHIVE_TOAST_STYLE },
  );
}

/**
 * The server refused an Undo (409: the job started editing meanwhile) or could not be reached:
 * `Couldn't undo “<name>”` (or, for several videos, how many), then the server's own words. The
 * name keeps its own direction.
 */
export function announceArchiveUndoRefused(
  jobs: readonly ArchiveToastJob[],
  message: string,
): void {
  const [first] = jobs;
  toast.error(
    jobs.length === 1 && first !== undefined ? (
      <>
        Couldn&apos;t undo “<bdi>{first.name}</bdi>”
      </>
    ) : (
      `Couldn't undo for ${jobs.length} videos`
    ),
    {
      id: archiveToastId('undo-refused', first?.id ?? 'paid'),
      description: message,
      duration: ACTION_ERROR_MS,
    },
  );
}
