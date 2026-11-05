import type { Job } from '@studio/shared';

/** What a table column sorts by: text or a number. The Clients table sorts its columns with these. */
export type SortValue = string | number;

/** A timestamp as epoch milliseconds; an unparsable one sorts as the oldest. */
export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// Names compare the way a person would sort them: case and accents ignored, "Clip 2" before
// "Clip 10". Pinned to English so the order does not depend on the machine's language; Hebrew
// letters sort after Latin ones and in alphabetical order among themselves.
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Ascending comparison of two sort values (TanStack reverses it for a descending sort). Numbers
 * compare as numbers, text with the collator above.
 */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  return collator.compare(String(a), String(b));
}

/**
 * The order jobs start from before they are sorted: newest added first, then by id. Jobs that
 * compare equal after the sort keep this order, so ties never depend on the order the cache
 * happens to hold, and a job's own updates never move it between its equals (neither field
 * changes).
 */
export function tieBreakOrder(jobs: readonly Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const byAdded = toMs(b.addedAt) - toMs(a.addedAt);
    if (byAdded !== 0) return byAdded;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The order of the Jobs list: last updated first. Jobs updated at the same moment stay in
 * `tieBreakOrder` (the sort is stable). There is no other order and nothing to change it.
 */
export function lastUpdatedOrder(jobs: readonly Job[]): Job[] {
  return tieBreakOrder(jobs).sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt));
}
