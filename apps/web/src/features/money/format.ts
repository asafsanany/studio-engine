import { homeCurrencySymbol } from '@studio/shared';

// The Money page's numbers and months as text. Every shekel amount on the page comes from here,
// so the Banners, the Ledger and the Expenses read alike (approved design canvas, board "Money").
//
// - Amounts arrive as numbers to the agora (81.4). Banners and tables show whole shekels (₪81);
//   agorot (₪7.50) only where the board shows them: a job's expenses, the charges of an item, and
//   the Expenses tables (This month, In ₪ and the footer total), whose rows must add up to it.
// - A negative amount has the real minus sign (U+2212) in front of the shekel sign: −₪800.
// - Month names are English whatever the system locale, from a table here rather than Intl, so ICU
//   data can never change the text (the same rule as packages/shared's format.ts).

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Real minus, as the board writes it. */
const MINUS = '−';

const wholeFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const agorotFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * `value` rounded to whole shekels, halves away from zero (-2.5 is -3, as the shekel text shows
 * it). Banners compare these, so the change they print is exactly the difference of the two
 * amounts printed beside it.
 */
export function roundWhole(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  // Not negative zero: -0.4 is 0.
  return rounded === 0 ? 0 : rounded;
}

/** The sign that goes before `text` (an amount's digits): a minus, unless it rounds to nothing. */
function sign(value: number, text: string): string {
  return value < 0 && /[1-9]/.test(text) ? MINUS : '';
}

/** Whole shekels: ₪4,400; −₪800. The amount is rounded, 81.4 is ₪81 and 4,239.6 is ₪4,240. */
export function formatIls(value: number): string {
  const text = wholeFormat.format(Math.abs(roundWhole(value)));
  return `${sign(value, text)}${homeCurrencySymbol()}${text}`;
}

/** Shekels and agorot: ₪7.50; −₪1,250.00. For the amounts the board shows to the agora. */
export function formatIlsAgorot(value: number): string {
  const text = agorotFormat.format(Math.abs(value));
  return `${sign(value, text)}${homeCurrencySymbol()}${text}`;
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The month number (1-12) and year of a YYYY-MM string, or `undefined` for anything else. */
function parseMonth(month: string): { year: number; number: number } | undefined {
  const match = MONTH_PATTERN.exec(month);
  return match ? { year: Number(match[1]), number: Number(match[2]) } : undefined;
}

/** "October" for "2026-10". Anything that is not YYYY-MM is returned as it came. */
export function monthName(month: string): string {
  const parsed = parseMonth(month);
  return parsed ? (MONTH_NAMES[parsed.number - 1] ?? month) : month;
}

/** "October 2026" for "2026-10", as the month picker reads. */
export function monthLabel(month: string): string {
  const parsed = parseMonth(month);
  return parsed ? `${monthName(month)} ${parsed.year}` : month;
}

/** What a pager counts, in the singular and the plural: `{ one: 'job', many: 'jobs' }`. */
export interface PagerUnit {
  one: string;
  many: string;
}

/**
 * The range a pager says, as the board writes it: "Showing 1–10 of 26 jobs", "Showing 11–12 of 12
 * charges", "Showing 1–1 of 1 client". `pageIndex` is zero-based; no rows is "Showing 0–0 of 0 jobs".
 */
export function pagerRangeText(
  pageIndex: number,
  pageSize: number,
  total: number,
  unit: PagerUnit,
): string {
  const from = total <= 0 ? 0 : pageIndex * pageSize + 1;
  const to = total <= 0 ? 0 : Math.min((pageIndex + 1) * pageSize, total);
  return `Showing ${from}–${to} of ${total} ${total === 1 ? unit.one : unit.many}`;
}
