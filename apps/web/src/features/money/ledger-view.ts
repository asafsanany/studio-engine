// What the Ledger of the Money page says, as pure functions (approved design canvas, board "Money ·
// banners, Ledger, Expenses (read-only)"): the order of the jobs, the client groups and their
// subtotals, the page of rows to show, the details of an open job and the Month summary. The
// Ledger component only lays these out.
//
// The numbers arrive from the server in shekels to the agora; whole shekels or agorot are the
// components' business (they use `formatIls` and `formatIlsAgorot`).

import {
  clientHue,
  type MoneyExpenseCharge,
  type MoneyLedgerEntry,
  type MoneyResponse,
  type MoneyUnpaid,
} from '@studio/shared';
import { cellWidth } from '../jobs/column-widths';
import { compareSortValues, type SortValue, toMs } from '../jobs/sorting';
import { formatIls, formatIlsAgorot, monthName } from './format';

/** The real minus the page writes before a negative amount or percentage. */
const MINUS = '−';

/** Rounds to whole agorot, so sums of amounts do not carry float dust (0.1 + 0.2). */
function toAgorot(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumOf<T>(items: readonly T[], pick: (item: T) => number): number {
  return toAgorot(items.reduce((sum, item) => sum + pick(item), 0));
}

/** Whether an amount is more than half an agora away from nothing. */
function isSignificant(value: number): boolean {
  return Math.abs(value) >= 0.005;
}

// --- columns and sorting -----------------------------------------------------------------------

/** The columns of the table, left to right. All of them sort. */
export const LEDGER_COLUMN_IDS = [
  'name',
  'client',
  'delivered',
  'paid',
  'income',
  'expenses',
  'profit',
] as const;
export type LedgerColumnId = (typeof LEDGER_COLUMN_IDS)[number];

export interface LedgerColumnSpec {
  /** Header text. */
  label: string;
  /**
   * The column's content width in px (the gaps and the row padding come on top, as in the Jobs
   * table). The Job column takes what the others leave, down to this width.
   */
  width: number;
  /** Numbers sit at the right edge of their column. */
  align: 'start' | 'end';
  /** Text columns sort A to Z on the first click; the others start with the most or the newest. */
  textual: boolean;
}

/** The board's grid: `minmax(240px, 1fr) 190px 140px 100px 110px 110px 110px`. */
export const LEDGER_COLUMNS: Readonly<Record<LedgerColumnId, LedgerColumnSpec>> = {
  name: { label: 'Job', width: 240, align: 'start', textual: true },
  client: { label: 'Client', width: 190, align: 'start', textual: true },
  delivered: { label: 'Delivered', width: 140, align: 'start', textual: false },
  paid: { label: 'Paid', width: 100, align: 'start', textual: false },
  income: { label: 'Income', width: 110, align: 'end', textual: false },
  expenses: { label: 'Expenses', width: 110, align: 'end', textual: false },
  profit: { label: 'Profit', width: 110, align: 'end', textual: false },
};

const COLUMN_WIDTHS = LEDGER_COLUMN_IDS.map((id) => LEDGER_COLUMNS[id].width);

/** The width of a column's cells in the table: its content plus the gaps and the row padding. */
export function ledgerCellWidth(id: LedgerColumnId): number {
  return cellWidth(
    LEDGER_COLUMNS[id].width,
    LEDGER_COLUMN_IDS.indexOf(id),
    LEDGER_COLUMN_IDS.length,
  );
}

/** The narrowest the table gets before its frame scrolls sideways. */
export const LEDGER_MIN_WIDTH = LEDGER_COLUMN_IDS.reduce((sum, id) => sum + ledgerCellWidth(id), 0);

/**
 * The same columns as a CSS grid (`minmax(240px, 1fr) 190px 140px 100px 110px 110px 110px`), with
 * the 12 px gap and 12 px of padding at each end. The Month summary uses it so that its Income,
 * Expenses and Profit sit exactly under the table's.
 */
export const LEDGER_GRID_TEMPLATE = COLUMN_WIDTHS.map((width, i) =>
  i === 0 ? `minmax(${width}px, 1fr)` : `${width}px`,
).join(' ');

export type SortDirection = 'asc' | 'desc';

export interface LedgerSort {
  key: LedgerColumnId;
  dir: SortDirection;
}

/** Delivered, newest first. */
export const DEFAULT_LEDGER_SORT: LedgerSort = { key: 'delivered', dir: 'desc' };

/**
 * The sort after a click on a header: the same column flips its direction; another column starts
 * with A to Z for the text columns and with the most (or newest) for the numbers and the date.
 */
export function nextSort(current: LedgerSort, key: LedgerColumnId): LedgerSort {
  if (current.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  return { key, dir: LEDGER_COLUMNS[key].textual ? 'asc' : 'desc' };
}

/**
 * A job not paid yet sorts after every day it could have been paid on, so the first click on Paid
 * (the newest first) brings the unpaid jobs to the top and a second click puts them last.
 */
function paidSortValue(paidOn: string | null): number {
  if (paidOn === null) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(paidOn);
  return Number.isFinite(ms) ? ms : 0;
}

const SORT_VALUE: Readonly<Record<LedgerColumnId, (entry: MoneyLedgerEntry) => SortValue>> = {
  name: (entry) => entry.name,
  client: (entry) => entry.client,
  delivered: (entry) => toMs(entry.listedAt),
  paid: (entry) => paidSortValue(entry.paidOn),
  income: (entry) => entry.income,
  expenses: (entry) => entry.expenses,
  profit: (entry) => entry.profit,
};

/**
 * The jobs in the order of `sort`. Jobs that compare equal stay newest delivery first (then by
 * id), so the order never depends on the order the server happened to send. A new array.
 */
export function sortLedger(
  entries: readonly MoneyLedgerEntry[],
  sort: LedgerSort = DEFAULT_LEDGER_SORT,
): MoneyLedgerEntry[] {
  const value = SORT_VALUE[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const primary = compareSortValues(value(a), value(b)) * sign;
    if (primary !== 0) return primary;
    const newest = toMs(b.listedAt) - toMs(a.listedAt);
    if (newest !== 0) return newest;
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
  });
}

// --- clients -----------------------------------------------------------------------------------

/** One client's jobs of the month, with what they add up to. */
export interface ClientGroup {
  clientId: string;
  client: string;
  /** The client's jobs, in the order of the sort. */
  jobs: MoneyLedgerEntry[];
  income: number;
  expenses: number;
  profit: number;
}

/**
 * The jobs grouped by client, the client who kept the most first (then by name). Inside a group
 * the jobs are in the order of `sort`, so a click on a header orders the jobs of every client.
 */
export function groupByClient(
  entries: readonly MoneyLedgerEntry[],
  sort: LedgerSort = DEFAULT_LEDGER_SORT,
): ClientGroup[] {
  const groups = new Map<string, ClientGroup>();
  for (const entry of sortLedger(entries, sort)) {
    let group = groups.get(entry.clientId);
    if (group === undefined) {
      group = {
        clientId: entry.clientId,
        client: entry.client,
        jobs: [],
        income: 0,
        expenses: 0,
        profit: 0,
      };
      groups.set(entry.clientId, group);
    }
    group.jobs.push(entry);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.income = sumOf(group.jobs, (job) => job.income);
    group.expenses = sumOf(group.jobs, (job) => job.expenses);
    group.profit = sumOf(group.jobs, (job) => job.profit);
  }
  return list.sort(
    (a, b) =>
      b.profit - a.profit ||
      compareSortValues(a.client, b.client) ||
      (a.clientId < b.clientId ? -1 : 1),
  );
}

/** "1 job", "26 jobs". */
export function jobCountText(count: number): string {
  return `${count} ${count === 1 ? 'job' : 'jobs'}`;
}

/** The colour of a client's dot: the hue of its avatar (same name, same colour), as a solid. */
export function clientDotColor(client: string): string {
  return `hsl(${clientHue(client)} 70% 55%)`;
}

// --- pages -------------------------------------------------------------------------------------

/** How many pages `total` rows make at `pageSize` a page; an empty list still has one. */
export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** A page number (zero-based) kept inside the pages there are; anything unusable is the first. */
export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.trunc(page)), Math.max(0, pageCount - 1));
}

/** The rows of one page. */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  return items.slice(page * pageSize, page * pageSize + pageSize);
}

export type LedgerGroupingMode = 'job' | 'client';

/** What the table shows: a page of jobs, or a page of client groups. */
export type LedgerPage =
  | {
      grouping: 'job';
      /** The page shown (zero-based), inside the pages there are. */
      page: number;
      pageCount: number;
      /** Every job of the month: what the pager counts. */
      total: number;
      jobs: MoneyLedgerEntry[];
    }
  | {
      grouping: 'client';
      page: number;
      pageCount: number;
      /** Every client of the month: what the pager counts. */
      total: number;
      groups: ClientGroup[];
    };

/**
 * The page of the Ledger to show. "Every job" pages by job; "By client" pages by client (a client
 * always shows with all its jobs). `page` may be past the end (it is the store's, and the number of
 * rows changes under it): it is clamped here.
 */
export function ledgerPage(
  entries: readonly MoneyLedgerEntry[],
  options: {
    grouping: LedgerGroupingMode;
    sort: LedgerSort;
    page: number;
    pageSize: number;
  },
): LedgerPage {
  const { grouping, sort, pageSize } = options;
  if (grouping === 'client') {
    const groups = groupByClient(entries, sort);
    const pageCount = pageCountOf(groups.length, pageSize);
    const page = clampPage(options.page, pageCount);
    return {
      grouping,
      page,
      pageCount,
      total: groups.length,
      groups: pageSlice(groups, page, pageSize),
    };
  }
  const jobs = sortLedger(entries, sort);
  const pageCount = pageCountOf(jobs.length, pageSize);
  const page = clampPage(options.page, pageCount);
  return { grouping, page, pageCount, total: jobs.length, jobs: pageSlice(jobs, page, pageSize) };
}

// --- one job -----------------------------------------------------------------------------------

const SHORT_MONTHS = [
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

const deliveredFormatters = new Map<string, Intl.DateTimeFormat>();

/** The month name, the day and the time of day of a moment, on the wall clock of `timeZone`. */
function deliveredParts(
  iso: string,
  timeZone?: string,
): { month: string; day: number; time: string } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const cacheKey = timeZone ?? '';
  let formatter = deliveredFormatters.get(cacheKey);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    deliveredFormatters.set(cacheKey, formatter);
  }
  const parts = formatter.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    month: SHORT_MONTHS[Number(part('month')) - 1] ?? '',
    day: Number(part('day')),
    time: `${part('hour').padStart(2, '0')}:${part('minute').padStart(2, '0')}`,
  };
}

/**
 * When a job was delivered, the way the board writes it: "Oct 5, 09:00", on the wall clock of
 * `timeZone` (default: this machine's, the one the month was cut on). Month names come from a
 * table here, never from Intl, so the text cannot change with the system language.
 */
export function deliveredText(iso: string, timeZone?: string): string {
  const parts = deliveredParts(iso, timeZone);
  return parts === null ? '—' : `${parts.month} ${parts.day}, ${parts.time}`;
}

/** The day of a moment without the time, the way the phone rows write it: "Oct 5". */
export function deliveredDayText(iso: string, timeZone?: string): string {
  const parts = deliveredParts(iso, timeZone);
  return parts === null ? '—' : `${parts.month} ${parts.day}`;
}

/** The same moment as the open row writes it, day first: "5 Oct, 09:00". */
export function deliveredDetailText(iso: string, timeZone?: string): string {
  const parts = deliveredParts(iso, timeZone);
  return parts === null ? '—' : `${parts.day} ${parts.month}, ${parts.time}`;
}

/** The month name and the day of a calendar day written YYYY-MM-DD; `null` for anything else. */
function paidParts(paidOn: string): { month: string; day: number } | null {
  const [, month = '', day = ''] = paidOn.split('-');
  const name = SHORT_MONTHS[Number(month) - 1];
  return name === undefined ? null : { month: name, day: Number(day) };
}

/** The day the money came in, as the Paid column writes it: "Oct 14". */
export function paidText(paidOn: string): string {
  const parts = paidParts(paidOn);
  return parts === null ? '—' : `${parts.month} ${parts.day}`;
}

/** The same day as the open row writes it, day first: "14 Oct". */
export function paidDetailText(paidOn: string): string {
  const parts = paidParts(paidOn);
  return parts === null ? '—' : `${parts.day} ${parts.month}`;
}

/** What the Paid column and the open row say for a job that has not been paid. */
export const NOT_PAID_TEXT = 'Not yet';

/**
 * What they say for an archived job that has not been paid: archived means paid already or not
 * needed, so it is not owed (CVP-210), and the Income banner leaves it out of "not paid yet".
 */
export const ARCHIVED_UNPAID_TEXT = 'Archived';

/** The jobs of the ledger that were delivered: the ones that earned, counted and priced alike. */
export function deliveredOnly(ledger: readonly MoneyLedgerEntry[]): MoneyLedgerEntry[] {
  return ledger.filter((entry) => entry.deliveredAt !== null);
}

/**
 * What the Delivered column and the open row say for a job that is not delivered yet. It still
 * costs money (the services, a stock clip), so it is listed, in the month it was added.
 */
export const NOT_DELIVERED_TEXT = 'Not delivered yet';

/** The Paid column's words for a job: the day it was paid, "Archived", or "Not yet"; "—" before it is delivered. */
export function paidCellText(
  entry: Pick<MoneyLedgerEntry, 'paidOn' | 'archived'> & { deliveredAt?: string | null },
): string {
  if (entry.deliveredAt === null) return '—';
  if (entry.paidOn !== null) return paidText(entry.paidOn);
  return entry.archived ? ARCHIVED_UNPAID_TEXT : NOT_PAID_TEXT;
}

/** What a job kept of what it earned, as a whole percentage: "93%", "−12%"; "—" with no income. */
export function marginText(profit: number, income: number): string {
  if (!(income > 0)) return '—';
  const percent = Math.round((Math.abs(profit) / income) * 100);
  return `${profit < 0 && percent > 0 ? MINUS : ''}${percent}%`;
}

/** The minutes of review, as the page says them: at least 1 once there is any review at all. */
export function reviewMinutes(reviewSec: number): number {
  return reviewSec > 0 ? Math.max(1, Math.round(reviewSec / 60)) : 0;
}

/** What the job kept for each hour of review: its profit divided by the hours. `null` without review. */
export function profitPerHour(
  entry: Pick<MoneyLedgerEntry, 'profit' | 'reviewSec'>,
): number | null {
  return entry.reviewSec > 0 ? entry.profit / (entry.reviewSec / 3600) : null;
}

// --- charges of one job ------------------------------------------------------------------------

/** The payments of one thing a job was charged for ("Stock footage"), as one line. */
export interface ChargeGroup {
  item: string;
  /** How many payments. */
  count: number;
  /** What they add up to, in shekels. */
  total: number;
  /**
   * Said after the item: "2 clips at ₪7.50" (equal payments with a noun that shows), "2 × ₪7.50"
   * (equal payments, no noun), "Clip licence #4831" (one payment: what it was for) or "3 charges"
   * (payments of different amounts).
   */
  note: string;
}

/** The last number of a description, with the sign in front of it: " #4831", " no. 12", " 7". */
const TRAILING_NUMBER = /(?:\s*[#№]\s*|\s+no\.?\s*|\s+)\d+\s*$/i;

/** "clip" to "clips", "box" to "boxes", "story" to "stories". */
function plural(noun: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/**
 * The noun of a group of payments, when it is plain: the payments say the same thing once their
 * number is taken off ("Clip licence #4831" and "Clip licence #4838"), and the first word of it is
 * a Latin word ("clip"). The money file has no unit field, so this is the rule the Expenses list
 * uses for "8 clips" too. `null` when it is not obvious (different texts, Hebrew, a lone payment).
 */
export function chargeNoun(charges: readonly Pick<MoneyExpenseCharge, 'what'>[]): string | null {
  if (charges.length < 2) return null;
  const texts = new Set(
    charges.map((c) => c.what.replace(TRAILING_NUMBER, '').trim().toLowerCase()),
  );
  if (texts.size !== 1) return null;
  const [text] = [...texts];
  const word = text?.split(/\s+/)[0] ?? '';
  return /^[a-z]+$/.test(word) ? word : null;
}

/**
 * One line per thing the job was charged for, in the order of the first payment:
 * "Stock footage · 2 clips at ₪7.50 · ₪15.00".
 */
export function groupCharges(charges: readonly MoneyExpenseCharge[]): ChargeGroup[] {
  const byItem = new Map<string, MoneyExpenseCharge[]>();
  for (const charge of charges) {
    const group = byItem.get(charge.item);
    if (group) group.push(charge);
    else byItem.set(charge.item, [charge]);
  }
  return [...byItem].map(([item, group]) => {
    const total = sumOf(group, (charge) => charge.ils);
    const first = group[0];
    const equal = group.every(
      (c) => Math.round(c.ils * 100) === Math.round((first?.ils ?? 0) * 100),
    );
    let note: string;
    if (group.length === 1) {
      note = first?.what ?? '';
    } else if (equal) {
      const noun = chargeNoun(group);
      const unit = formatIlsAgorot(first?.ils ?? 0);
      note = noun ? `${group.length} ${plural(noun)} at ${unit}` : `${group.length} × ${unit}`;
    } else {
      note = `${group.length} charges`;
    }
    return { item, count: group.length, total, note };
  });
}

// --- the open row ------------------------------------------------------------------------------

/** What colours the total at the bottom of a detail column. */
export type DetailTone = 'green' | 'red' | 'grey' | 'plain';

export interface DetailLine {
  label: string;
  /** Said after the label in muted text: "Price · your price per job". */
  note: string | null;
  /** The amount at the right of the line, or `null` for none. */
  value: string | null;
  /** The label (and its note) is muted: a line that only says when, or the "nothing paid" line. */
  muted: boolean;
  /** The amount (or date) at the right is muted too: "Not yet". */
  valueMuted: boolean;
}

export interface DetailColumn {
  id: 'income' | 'expenses' | 'profit' | 'time';
  title: string;
  lines: DetailLine[];
  total: { label: string; value: string; tone: DetailTone };
}

function line(
  label: string,
  value: string | null,
  note: string | null = null,
  muted = false,
  valueMuted = false,
): DetailLine {
  return { label, note, value, muted, valueMuted };
}

/**
 * The four columns of an open job: Income, Expenses, Profit and Your time. Each has its details on
 * top and its total, which the component puts on one shared bottom line. Income says, after the
 * price, when the job was delivered (on the wall clock of `timeZone`, this machine's by default,
 * like the table) and the day it was paid, or "Not yet".
 */
export function jobDetail(entry: MoneyLedgerEntry, timeZone?: string): DetailColumn[] {
  const groups = groupCharges(entry.charges);
  const perHour = profitPerHour(entry);
  const minutes = reviewMinutes(entry.reviewSec);
  return [
    {
      id: 'income',
      title: 'Income',
      lines:
        entry.deliveredAt === null
          ? [line(NOT_DELIVERED_TEXT, null, 'no income until it is', true)]
          : [
              line('Price', formatIls(entry.income), 'your price per job'),
              line('Delivered', deliveredDetailText(entry.deliveredAt, timeZone), null, true),
              entry.paidOn === null
                ? line(
                    'Paid',
                    entry.archived ? ARCHIVED_UNPAID_TEXT : NOT_PAID_TEXT,
                    null,
                    true,
                    true,
                  )
                : line('Paid', paidDetailText(entry.paidOn), null, true),
            ],
      total: { label: 'Income', value: formatIls(entry.income), tone: 'green' },
    },
    {
      id: 'expenses',
      title: 'Expenses',
      lines:
        groups.length > 0
          ? groups.map((group) => line(group.item, formatIlsAgorot(group.total), group.note))
          : [line('Nothing paid for this job', null, null, true)],
      total: {
        label: 'Expenses',
        value: formatIlsAgorot(entry.expenses),
        tone: entry.expenses > 0 ? 'red' : 'grey',
      },
    },
    {
      id: 'profit',
      title: 'Profit',
      lines: [line('Margin', marginText(entry.profit, entry.income))],
      total: { label: 'Profit', value: formatIlsAgorot(entry.profit), tone: 'plain' },
    },
    {
      id: 'time',
      title: 'Your time',
      lines:
        minutes > 0
          ? [line('Review and notes', `${minutes} min`)]
          : [line('No review time yet', null, null, true)],
      total: {
        label: 'Per hour of your time',
        value: perHour === null ? '—' : `${formatIls(perHour)}/h`,
        tone: 'plain',
      },
    },
  ];
}

// --- the month summary -------------------------------------------------------------------------

/**
 * One row of the Month summary. An amount that is `null` has nothing to say in that column and
 * prints a dash.
 */
export interface SummaryRow {
  id: 'jobs' | 'subscriptions' | 'other' | 'included' | 'adjustment';
  label: string;
  /** Said after the label on the same line, in muted text: "· 26 delivered". */
  note: string | null;
  /** A muted second line under the label. */
  detail: string | null;
  income: number | null;
  expenses: number | null;
  profit: number | null;
  /** The whole row is muted (the line that only reconciles the block). */
  muted: boolean;
}

export interface MonthSummary {
  /** "October summary". */
  title: string;
  rows: SummaryRow[];
  /** The last line: the Income and Expenses banners, and the Profit banner. */
  total: { income: number; expenses: number; profit: number; tone: 'good' | 'bad' };
}

/** What a Month summary line of payments that belong to no job says before it lists them. */
export const NOT_CHARGED_PREFIX = 'Not charged to a job: ';

/** Subscription charges are listed by name; a general expense by the item it is for. */
function namedAmounts(names: readonly { name: string; ils: number }[]): string {
  return names.map((entry) => `${entry.name} ${formatIls(entry.ils)}`).join(' · ');
}

/**
 * The payments of the month that belong to no job and are not a subscription renewing: the
 * general entries of the money file. Renewals are the charges of the subscription items; each is
 * taken off once, so a general entry that happens to read the same stays.
 */
function otherCharges(data: MoneyResponse): MoneyExpenseCharge[] {
  const renewals = new Map<string, number>();
  const keyOf = (c: MoneyExpenseCharge) => JSON.stringify([c.item, c.date, c.what, c.ils]);
  for (const item of data.expenses.items) {
    if (item.kind !== 'Subscription') continue;
    for (const charge of item.charges) {
      const key = keyOf(charge);
      renewals.set(key, (renewals.get(key) ?? 0) + 1);
    }
  }
  return data.expenses.charges.filter((charge) => {
    if (charge.job !== null) return false;
    const key = keyOf(charge);
    const left = renewals.get(key) ?? 0;
    if (left > 0) {
      renewals.set(key, left - 1);
      return false;
    }
    return true;
  });
}

/** The general payments added up per item, in the order of the first one. */
function otherByItem(charges: readonly MoneyExpenseCharge[]): { name: string; ils: number }[] {
  const byItem = new Map<string, number>();
  for (const charge of charges)
    byItem.set(charge.item, (byItem.get(charge.item) ?? 0) + charge.ils);
  return [...byItem].map(([name, ils]) => ({ name, ils: toAgorot(ils) }));
}

/** " · 2 not delivered yet": the jobs of the month that already cost money and have not earned yet; nothing when there are none. */
function notDeliveredNote(count: number): string {
  return count > 0 ? ` · ${count} not delivered yet` : '';
}

/** " · 3 not paid yet (₪120)": what is said after "5 delivered"; nothing when everything is paid. */
function unpaidNote(unpaid: MoneyUnpaid): string {
  return unpaid.count > 0 ? ` · ${unpaid.count} not paid yet (${formatIls(unpaid.value)})` : '';
}

/**
 * The block under the Ledger's pager. Its last line is the three banners, so the profit it shows
 * is always the Profit banner. The rows above explain it:
 *
 * - Jobs: the income, expenses and profit of the jobs in the list, and how many of them are not
 *   paid yet and what they come to (left out when all are paid).
 * - Monthly subscriptions (when there are any): not charged to a job, so no income, their total as
 *   an expense and minus their total as profit.
 * - Other expenses (when the money file has general entries): the same, for those.
 * - Job costs paid in another month (only when the rows above still do not add up to the
 *   banners): a job's charge dated in another month than its delivery is in the job's expenses but
 *   not in this month's banner, and the other way round. A muted line with the difference, so the
 *   block always reconciles.
 */
export function monthSummary(data: MoneyResponse): MonthSummary {
  const { income, expenses, profit } = data.banners;
  const jobs = {
    income: sumOf(data.ledger, (e) => e.income),
    expenses: sumOf(data.ledger, (e) => e.expenses),
    profit: sumOf(data.ledger, (e) => e.profit),
  };
  const { unpaid } = income;
  const delivered = deliveredOnly(data.ledger).length;
  const rows: SummaryRow[] = [
    {
      id: 'jobs',
      label: 'Jobs',
      note: `${delivered} delivered${notDeliveredNote(data.ledger.length - delivered)}${unpaidNote(unpaid)}`,
      detail: null,
      income: jobs.income,
      expenses: jobs.expenses,
      profit: jobs.profit,
      muted: false,
    },
  ];

  let rowsExpenses = jobs.expenses;
  const rowsIncome = jobs.income;
  let rowsProfit = jobs.profit;

  const subscriptionsTotal = sumOf(data.subscriptions, (s) => s.ils);
  if (data.subscriptions.length > 0) {
    rows.push({
      id: 'subscriptions',
      label: 'Monthly subscriptions',
      note: null,
      detail: `${NOT_CHARGED_PREFIX}${namedAmounts(data.subscriptions)}`,
      income: null,
      expenses: subscriptionsTotal,
      profit: -subscriptionsTotal,
      muted: false,
    });
    rowsExpenses += subscriptionsTotal;
    rowsProfit -= subscriptionsTotal;
  }

  const others = otherCharges(data);
  if (others.length > 0) {
    const othersTotal = sumOf(others, (c) => c.ils);
    rows.push({
      id: 'other',
      label: 'Other expenses',
      note: null,
      detail: `${NOT_CHARGED_PREFIX}${namedAmounts(otherByItem(others))}`,
      income: null,
      expenses: othersTotal,
      profit: -othersTotal,
      muted: false,
    });
    rowsExpenses += othersTotal;
    rowsProfit -= othersTotal;
  }

  // A job's share of a plan that is already paid (ElevenLabs credits) is in the job's expenses but
  // not in the month: the plan's renewal above is where the month paid it.
  const includedTotal = sumOf(
    data.ledger.flatMap((entry) => entry.charges.filter((charge) => charge.included === true)),
    (charge) => charge.ils,
  );
  if (isSignificant(toAgorot(includedTotal))) {
    rows.push({
      id: 'included',
      label: 'Already in the plans above',
      note: null,
      detail: 'The part of a job’s cost that a subscription already paid, like ElevenLabs credits.',
      income: null,
      expenses: -includedTotal,
      profit: includedTotal,
      muted: true,
    });
    rowsExpenses -= includedTotal;
    rowsProfit += includedTotal;
  }

  const incomeGap = toAgorot(income.value - rowsIncome);
  const expensesGap = toAgorot(expenses.value - rowsExpenses);
  const profitGap = toAgorot(profit.value - rowsProfit);
  if (isSignificant(incomeGap) || isSignificant(expensesGap) || isSignificant(profitGap)) {
    rows.push({
      id: 'adjustment',
      label: 'Job costs paid in another month',
      note: null,
      detail: 'Counted in the month they were paid, not the month the job was delivered.',
      income: isSignificant(incomeGap) ? incomeGap : null,
      expenses: isSignificant(expensesGap) ? expensesGap : null,
      profit: isSignificant(profitGap) ? profitGap : null,
      muted: true,
    });
  }

  return {
    title: `${monthName(data.month)} summary`,
    rows,
    total: {
      income: income.value,
      expenses: expenses.value,
      profit: profit.value,
      tone: profit.value >= 0 ? 'good' : 'bad',
    },
  };
}

/** Whether the block has anything to say: a month with no jobs, no payments and no profit has not. */
export function summaryHasContent(data: MoneyResponse): boolean {
  return (
    data.ledger.length > 0 ||
    data.subscriptions.length > 0 ||
    isSignificant(data.banners.income.value) ||
    isSignificant(data.banners.expenses.value) ||
    isSignificant(data.banners.profit.value)
  );
}
