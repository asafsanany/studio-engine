import { groupOf, isArchived, type Job } from '@studio/shared';
import type { StatusTab } from '@/stores/jobs-ui';

/** The four engine counters in the header. */
export interface EngineCounts {
  editing: number;
  queued: number;
  review: number;
  attention: number;
}

/**
 * All the summary needs from a job. Typed narrowly so it does not depend on the full `Job`; a job
 * without `archivedAt` is not archived.
 */
export type SummaryJob = Pick<Job, 'state' | 'delivery'> & Partial<Pick<Job, 'archivedAt'>>;

/**
 * Counts for the header. `editing` and `queued` are exact states (a job that is still `arriving`
 * is neither); `review` is the jobs waiting for the person's review; `attention` is the whole Needs
 * attention group (held, failed and cancelled), so it equals the count on the Jobs page's "Needs
 * attention" tab while Show archived is off.
 *
 * Archived jobs are left out of all four: they are put away, so an archived failed video does not
 * ask for the person.
 */
export function countEngine(jobs: ReadonlyArray<SummaryJob>): EngineCounts {
  const counts: EngineCounts = { editing: 0, queued: 0, review: 0, attention: 0 };
  for (const job of jobs) {
    if (isArchived({ archivedAt: job.archivedAt ?? null })) continue;
    if (job.state === 'editing') counts.editing += 1;
    else if (job.state === 'queued') counts.queued += 1;
    else if (job.state === 'review') counts.review += 1;
    if (groupOf(job) === 'attention') counts.attention += 1;
  }
  return counts;
}

/** "1 needs attention" but "0 / 2 / 3 need attention". */
export function attentionLabel(count: number): string {
  return count === 1 ? 'needs attention' : 'need attention';
}

export interface SummaryItem {
  key: keyof EngineCounts;
  /** Tailwind class for the 6 px dot (status colours). */
  dot: string;
  label: (count: number) => string;
  /** Status tab a click switches to: editing and queued are both "In progress", review has its own. */
  tab: Extract<StatusTab, 'progress' | 'review' | 'attention'>;
}

export const SUMMARY_ITEMS: readonly SummaryItem[] = [
  { key: 'editing', dot: 'bg-status-editing', label: () => 'editing', tab: 'progress' },
  { key: 'queued', dot: 'bg-status-neutral', label: () => 'queued', tab: 'progress' },
  { key: 'review', dot: 'bg-status-review', label: () => 'in review', tab: 'review' },
  { key: 'attention', dot: 'bg-status-failed', label: attentionLabel, tab: 'attention' },
];
