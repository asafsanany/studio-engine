import { isArchived, type Job, jobListDetail, type TimeInput } from '@studio/shared';
import { archivedLineText } from '@/features/jobs/ArchivedLine';
import { deliveryDetail } from '@/features/jobs/delivery-text';
import {
  hasSearchWords,
  type JobFilter,
  matchesSearch,
  matchesTab,
} from '@/features/jobs/filtering';

// The rules of the phone jobs list (boards MJobs, MJobsView, MJobsSearch) that are not drawing:
// which jobs sit under which client and in what order, where the tree lines run, what the line
// that offers the archive says, and what a row's second line says. The phone changes the layout,
// never the rules: the filtering itself is the Mac's (`filterJobs`, `tabCounts`).

// The By client rules (the groups, the order of the clients, the tree flags) are shared with the
// Mac's list; the phone draws them its own way.
export {
  type ClientGroup,
  groupByClient,
  type TreeFlags,
  treeContinues,
  treeFlags,
  treePosition,
} from '@/features/jobs/by-client';

/**
 * The line at the end of the list that offers the archive: "N archived · Show", or "N more
 * archived · Show" under a search that already found rows. `count` is how many archived jobs the
 * tab and the search would bring in with Show archived on.
 */
export interface PhoneArchivedLine {
  count: number;
  more: boolean;
}

/**
 * The archive line for the current tab and search, or `null` when it has nothing to offer (Show
 * archived is on, or no archived job fits). Unlike the Mac's list, which offers the archive only
 * as an answer to a search (its View menu is the way back), the phone's list always ends with it,
 * as the board shows: View is two taps away there. `shownRows` is how many rows the list has; with
 * none, nothing is "more".
 */
export function phoneArchivedLine(
  jobs: readonly Job[],
  { tab, search, showArchived }: JobFilter,
  shownRows: number,
): PhoneArchivedLine | null {
  if (showArchived) return null;
  const count = jobs.filter(
    (job) => isArchived(job) && matchesTab(job, tab) && matchesSearch(job, search),
  ).length;
  if (count === 0) return null;
  return { count, more: hasSearchWords(search) && shownRows > 0 };
}

/** What the line says, "3 more archived · Show": the Mac's words (`archivedLineText`). */
export function phoneArchivedLineText(line: PhoneArchivedLine): string {
  return archivedLineText({ kind: 'show', ...line });
}

/** The part of the line before its "Show" button: "3 more archived ·". */
export function phoneArchivedLineLead(line: PhoneArchivedLine): string {
  return phoneArchivedLineText(line).replace(/ Show$/, '');
}

/**
 * What a job's second line says after the client: the Mac's detail (`deliveryDetail` for a
 * delivered or paid job, else `jobListDetail`: `listDetail` with a generated job's words): "Cut · graphics 2/5 · ~4 min left", "Delivered 21 Oct
 * · ₪40 not paid", "Failed at Render".
 */
export function phoneDetail(job: Job, now: TimeInput): string {
  return deliveryDetail(job) ?? jobListDetail(job, now);
}

/** Whether a job's detail is the red kind (a failed job's), as on the Mac. */
export function isFailedDetail(job: Pick<Job, 'state'>): boolean {
  return job.state === 'failed';
}
