// What the sheet's host shows, from the address and the job list.

import type { Job } from '@studio/shared';

export type SheetState =
  /** No job in the address: the sheet is closed. */
  | { kind: 'closed' }
  /** A job in the address, but the list has not arrived yet (a reload): nothing to show yet. */
  | { kind: 'waiting' }
  /** The job is in the list: its sheet. */
  | { kind: 'open'; job: Job }
  /** The job was open and has left the list (its folder was removed): "This job is gone". */
  | { kind: 'gone' }
  /** The address names a job the list never held: nothing opens, and the address is cleaned. */
  | { kind: 'unknown' };

export interface SheetStateInput {
  /** The job in the address, or `null`. */
  openId: string | null;
  /** The job list (with the videos whose folder was deleted); `undefined` until it has arrived. */
  jobs: readonly Job[] | undefined;
  /** The list has everything: the jobs, and the videos whose folder was deleted. */
  listComplete: boolean;
  /** The id of the job this host showed last: told apart from one it never saw. */
  seenId: string | null;
}

/**
 * The host's state. A job that is in the list opens. One that is not is either gone (the host had
 * it open: it was there, and the folder was removed) or unknown (it never was: a mistyped or stale
 * address), which is told apart by whether the host has shown it. Neither is decided before the
 * list is whole, so a reload on a job the list brings in late (a video whose folder was deleted)
 * does not lose it.
 */
export function sheetState({ openId, jobs, listComplete, seenId }: SheetStateInput): SheetState {
  if (openId === null) return { kind: 'closed' };
  if (jobs === undefined) return { kind: 'waiting' };
  const job = jobs.find((candidate) => candidate.id === openId);
  if (job !== undefined) return { kind: 'open', job };
  if (seenId === openId) return { kind: 'gone' };
  return listComplete ? { kind: 'unknown' } : { kind: 'waiting' };
}
