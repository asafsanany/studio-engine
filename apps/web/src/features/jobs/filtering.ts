import { groupOf, isArchived, type Job } from '@studio/shared';
import { STATUS_TABS, type StatusTab } from '@/stores/jobs-ui';

// Invisible direction marks (left-to-right / right-to-left, embeddings, isolates) that Hebrew and
// mixed names sometimes carry, and Hebrew vowel and cantillation points: neither should stop a
// search from matching. The Hebrew block's punctuation (maqaf U+05BE, paseq U+05C0, sof pasuq
// U+05C3, nun hafukha U+05C6) sits among the points and is not one of them, so it is skipped.
const IGNORED_MARKS =
  /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;

// Dashes, apostrophes and quotation marks that look alike and are typed differently: names carry
// "–" or the Hebrew maqaf "־" where a keyboard types "-", and Hebrew abbreviations use geresh "׳"
// and gershayim "״" where a keyboard types "'" and '"'.
const DASHES = /[\u2010-\u2015\u05BE]/g;
const APOSTROPHES = /[\u2018\u2019\u05F3]/g;
const QUOTES = /[\u201C\u201D\u05F4]/g;

/**
 * Text prepared for comparing: composed, lower-cased, without marks that do not change the word,
 * and with look-alike punctuation made the same.
 */
function foldForSearch(text: string): string {
  return text
    .normalize('NFC')
    .replace(IGNORED_MARKS, '')
    .replace(DASHES, '-')
    .replace(APOSTROPHES, "'")
    .replace(QUOTES, '"')
    .toLowerCase();
}

/**
 * Whether the search matches a job. Case-insensitive, works for Hebrew and mixed names. The query
 * is split on spaces and every word must appear somewhere in "name client", so "arc coach" finds
 * "Coach intro reel" from Arc Fitness. An empty query matches everything.
 */
export function matchesSearch(job: Pick<Job, 'name' | 'client'>, query: string): boolean {
  return matchesText(`${job.name} ${job.client}`, query);
}

/**
 * Whether every word of the query appears in the text, folded as `matchesSearch` does. An empty
 * query matches everything. The Clients page searches its names with this.
 */
export function matchesText(text: string, query: string): boolean {
  const words = foldForSearch(query).split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = foldForSearch(text);
  return words.every((word) => haystack.includes(word));
}

/**
 * Whether a job belongs under a status tab: `all` takes every job, the rest its `groupOf` (a
 * ready job is under Approved, Delivered or Paid by its stage).
 */
export function matchesTab(job: Pick<Job, 'state' | 'delivery'>, tab: StatusTab): boolean {
  return tab === 'all' || groupOf(job) === tab;
}

export interface JobFilter {
  tab: StatusTab;
  search: string;
  /**
   * View › Show archived. Off, archived jobs are out of the answer; on, they sit in their usual tab
   * with the others.
   */
  showArchived: boolean;
}

/**
 * The jobs the lists show: all of them with Show archived on, and without the archived ones with it
 * off. The order is kept.
 */
export function visibleJobs<T extends Pick<Job, 'archivedAt'>>(
  jobs: readonly T[],
  showArchived: boolean,
): readonly T[] {
  return showArchived ? jobs : jobs.filter((job) => !isArchived(job));
}

/** The jobs under the tab that match the search, in their original order. */
export function filterJobs(jobs: readonly Job[], { tab, search, showArchived }: JobFilter): Job[] {
  return visibleJobs(jobs, showArchived).filter(
    (job) => matchesTab(job, tab) && matchesSearch(job, search),
  );
}

/** How many jobs are archived, in every tab: the number at the end of View › Show archived. */
export function archivedCount(jobs: readonly Pick<Job, 'archivedAt'>[]): number {
  return jobs.filter(isArchived).length;
}

/** Whether the search has a word in it (it is not empty or blank). */
export function hasSearchWords(search: string): boolean {
  return foldForSearch(search).split(/\s+/u).some(Boolean);
}

/**
 * How many archived jobs the current tab and search would show if Show archived were on: the "2
 * more archived" under a search. It is 0 without a word typed, because the archive is only offered
 * as an answer to a search.
 */
export function archivedMatchCount(
  jobs: readonly Job[],
  { tab, search }: Omit<JobFilter, 'showArchived'>,
): number {
  if (!hasSearchWords(search)) return 0;
  return jobs.filter((job) => isArchived(job) && matchesTab(job, tab) && matchesSearch(job, search))
    .length;
}

/**
 * How many jobs each tab holds (the numbers on the tabs). The search does not change them. With
 * Show archived off the archived jobs are not counted anywhere; on, they count in their usual tab
 * and in All.
 */
export function tabCounts(
  jobs: readonly Pick<Job, 'state' | 'delivery' | 'archivedAt'>[],
  showArchived: boolean,
): Record<StatusTab, number> {
  const counts = Object.fromEntries(STATUS_TABS.map((tab) => [tab, 0])) as Record<
    StatusTab,
    number
  >;
  for (const job of visibleJobs(jobs, showArchived)) {
    counts.all += 1;
    counts[groupOf(job)] += 1;
  }
  return counts;
}
