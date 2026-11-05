// The Expenses as text and pages: the pure part of the section (approved design canvas, board
// "Money", Expenses). Nothing here touches React, so the wording and the paging can be tested on
// their own.

import type { MoneyExpenseCharge } from '@studio/shared';
import type { ExpensesView, OpenRow } from '@/stores/money-ui';
import { formatIlsAgorot, monthName, type PagerUnit, pagerRangeText } from './format';

/** The label of each view in the switch, in the order the switch lists them. */
export const EXPENSES_VIEW_LABELS: ReadonlyArray<{ view: ExpensesView; label: string }> = [
  { view: 'items', label: 'Items' },
  { view: 'charges', label: 'All charges' },
];

/** What a view lists, said after the range and in the footer. */
export const EXPENSES_UNITS: Readonly<Record<ExpensesView, PagerUnit>> = {
  items: { one: 'item', many: 'items' },
  charges: { one: 'charge', many: 'charges' },
};

/** The line under "Expenses": what the list holds and the rate the dollars were converted at. */
export function expensesDescription(usdToIls: number): string {
  return `Everything you actually paid this month: subscriptions and usage charges. Dollar amounts are converted at ${formatIlsAgorot(usdToIls)}.`;
}

/** What replaces the list when the month has nothing in it: "No expenses in October." */
export function emptyExpensesText(month: string): string {
  return `No expenses in ${monthName(month)}.`;
}

/** "3 items" / "1 charge": the count with the view's noun, in the right number. */
export function countText(view: ExpensesView, count: number): string {
  const unit = EXPENSES_UNITS[view];
  return `${count} ${count === 1 ? unit.one : unit.many}`;
}

/**
 * The footer under the table. `label` is the count and `amount` the month's total, which the
 * table sets apart (the count at the left, the amount under the figures); `text` is the line they
 * read as together: "5 items · total this month ₪1,032.80". The total is the month's
 * (`data.expenses.total`), not the sum of the page shown. It is written to the agora, as the rows
 * above it are (This month in Items, In ₪ in All charges), so the figures always add up to it; the
 * Expenses banner keeps whole shekels.
 */
export function expensesFooter(
  view: ExpensesView,
  count: number,
  total: number,
): { label: string; amount: string; text: string } {
  const label = `${countText(view, count)} · total this month`;
  const amount = formatIlsAgorot(total);
  return { label, amount, text: `${label} ${amount}` };
}

/** The pager's range: "Showing 1–10 of 12 charges", "Showing 1–5 of 5 items". */
export function expensesRangeText(
  view: ExpensesView,
  pageIndex: number,
  pageSize: number,
  total: number,
): string {
  return pagerRangeText(pageIndex, pageSize, total, EXPENSES_UNITS[view]);
}

/** One page of rows. */
export interface PageSlice<T> {
  /** The rows of the page. */
  rows: T[];
  /** The page shown, zero-based and clamped into the pages that exist. */
  pageIndex: number;
  /** How many pages there are (at least 1, even with no rows). */
  pageCount: number;
  /** The rows across all pages. */
  total: number;
}

/**
 * The rows of page `page` (zero-based). A page past the last, or a nonsense number, is clamped, so
 * the table never shows an empty page because rows went away behind it.
 */
export function pageSlice<T>(rows: readonly T[], page: number, pageSize: number): PageSlice<T> {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const wanted = Number.isFinite(page) ? Math.trunc(page) : 0;
  const pageIndex = Math.min(Math.max(0, wanted), pageCount - 1);
  return {
    rows: rows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    pageIndex,
    pageCount,
    total: rows.length,
  };
}

/** The id of the open expense item, or `null` when no row is open or the open row is a job. */
export function openItemId(open: OpenRow | null): string | null {
  return open?.kind === 'item' ? open.id : null;
}

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** "Oct 12" for "2026-10-12", as the board writes a charge's date. Anything else comes back as it came. */
export function chargeDate(date: string): string {
  const match = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(date);
  if (!match) return date;
  return `${MONTH_ABBREVIATIONS[Number(match[1]) - 1]} ${Number(match[2])}`;
}

/** The job's folder name from its `Client/Job` path: "Retreat teaser" for "Lumen Yoga/Retreat teaser". */
export function chargeJobName(job: string): string {
  const slash = job.indexOf('/');
  return slash < 0 ? job : job.slice(slash + 1);
}

/** Every charge by date, the earliest first. Charges of one day stay in the order they came. */
export function chargesByDate(charges: readonly MoneyExpenseCharge[]): MoneyExpenseCharge[] {
  // Array.prototype.sort is stable, so a renewal listed before a same-day entry stays before it.
  return charges.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
