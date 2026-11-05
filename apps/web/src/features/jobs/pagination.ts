/** Jobs per page. */
export const PAGE_SIZE = 10;

/** A page number to show (1-based) or a gap standing for the pages left out. */
export type PageItem = number | 'gap-before' | 'gap-after';

/**
 * The page buttons: every page up to seven, otherwise the first, the last and the pages next to
 * the current one, with a gap where pages are left out. `current` is 1-based.
 *
 *     1 … 4 [5] 6 … 12
 */
export function pageItems(current: number, count: number): PageItem[] {
  if (count <= 7) return Array.from({ length: Math.max(0, count) }, (_, i) => i + 1);

  let start = Math.max(2, Math.min(current - 1, count - 4));
  let end = Math.min(count - 1, Math.max(current + 1, 5));
  // A gap that would hide a single page shows that page instead.
  if (start === 3) start = 2;
  if (end === count - 2) end = count - 1;
  const items: PageItem[] = [1];
  if (start > 2) items.push('gap-before');
  for (let page = start; page <= end; page += 1) items.push(page);
  if (end < count - 1) items.push('gap-after');
  items.push(count);
  return items;
}

/** "1–10 of 12", "11–12 of 12", "0 of 0". `pageIndex` is zero-based. */
export function rangeText(pageIndex: number, pageSize: number, total: number): string {
  if (total <= 0) return '0 of 0';
  const from = pageIndex * pageSize + 1;
  const to = Math.min((pageIndex + 1) * pageSize, total);
  return `${from}–${to} of ${total}`;
}

/** The last valid zero-based page for `total` rows (0 when there are none). */
export function lastPageIndex(pageSize: number, total: number): number {
  return Math.max(0, Math.ceil(total / pageSize) - 1);
}
