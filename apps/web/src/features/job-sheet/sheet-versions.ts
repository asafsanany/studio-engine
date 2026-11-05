// What the job sheet's Versions part says (Plane VE2): one row per preview version of the job,
// "Cut 3 · today 14:58 · 0:42", newest first, with the Current badge (and Approved on it once the
// job is approved), and the rules for "Go back to this version…". Every run that ends in Review
// leaves one version (`GET /api/jobs/:id/versions`), so "Cut n" is the version's `n`. No React, no
// network: tested on plain values; the clock and the time zone are parameters.

import { clock, type Job, type JobVersion, type TimeInput, VERSION_MESSAGES } from '@studio/shared';
import { addedText } from './sheet-details';

/** The words of the part. */
export const SHEET_VERSIONS_TEXT = {
  heading: 'Versions',
  /** A job from before versions, or one that has not reached Review yet. */
  empty: 'No versions yet',
  /** The versions could not be loaded (the engine is down or the job is gone). */
  failed: 'Couldn’t load the versions',
  current: 'Current',
  approved: 'Approved',
  view: 'View',
  more: 'More',
  goBack: 'Go back to this version…',
  /** The preview viewer's footer button: the same question, asked from the cut on show. */
  goBackHere: 'Go back to this version',
  /** The confirm dialog's buttons. */
  keep: 'Cancel',
  confirm: 'Go back',
  going: 'Going back…',
  /** Why Go back waits on the cut the job is already on. */
  isCurrent: 'This is the current cut',
} as const;

/** "Cut 3". */
export function cutName(n: number): string {
  return `Cut ${n}`;
}

/** "today 14:58", "yesterday 16:19" or "21 Oct 10:01": when a cut was made. "" when it cannot be read. */
export function versionWhen(iso: TimeInput, now: TimeInput, timeZone?: string): string {
  const text = addedText(iso, now, timeZone).replace(', ', ' ');
  return text.replace(/^(Today|Yesterday)/, (word) => word.toLowerCase());
}

/** A row as it is drawn. */
export interface VersionRow {
  n: number;
  /** "Cut 3". */
  name: string;
  /** "today 14:58 · 0:42", muted behind the name. */
  detail: string;
  current: boolean;
  /** The Approved badge: on the current row, once the job is approved. */
  approved: boolean;
  /** Why Go back is not offered for this row, or `null` when it is. */
  blocked: string | null;
}

/**
 * Why a job cannot go back to `version`, in the server's words (VERSION_MESSAGES), or `null`.
 * Mirrors what the server refuses: only a job in Review (not archived) can; the cut it is on
 * already has nothing to go back to. Unsent notes are the server's to refuse: it says so, and the
 * sheet shows that as a toast.
 */
export function goBackBlock(
  job: Pick<Job, 'state' | 'archivedAt'>,
  version: Pick<JobVersion, 'current'>,
): string | null {
  if (job.state !== 'review') return VERSION_MESSAGES.notInReview;
  if (job.archivedAt !== null) return VERSION_MESSAGES.archived;
  return version.current ? SHEET_VERSIONS_TEXT.isCurrent : null;
}

/** The versions as rows, in the order they came (newest first). */
export function versionRows(
  job: Pick<Job, 'state' | 'archivedAt' | 'approvedAt'>,
  versions: readonly JobVersion[],
  now: TimeInput,
  timeZone?: string,
): VersionRow[] {
  return versions.map((version) => ({
    n: version.n,
    name: cutName(version.n),
    detail: [versionWhen(version.createdAt, now, timeZone), clock(version.durationSec)]
      .filter((part) => part !== '')
      .join(' · '),
    current: version.current,
    approved: version.current && job.approvedAt !== null,
    blocked: goBackBlock(job, version),
  }));
}

/** The confirm dialog's question and what it says about the cut that stays. */
export function goBackQuestion(
  target: number,
  current: number | null,
): { title: string; description: string } {
  return {
    title: `Go back to ${cutName(target)}?`,
    description:
      current === null
        ? 'The cut you leave stays in Versions, so you can return to it.'
        : `${cutName(current)} stays in Versions, so you can return to it.`,
  };
}
