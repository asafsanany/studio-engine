// What the phone's Money page says (boards MMoney, MMoneyWarn), as pure functions over the Mac's
// own view models: the banners come from `bannerViews`, the order of the jobs and the clients from
// `ledgerPage`, an open job's details from `jobDetail`, the footer from `monthSummary` and the
// expenses from `expenses-view`. Nothing here works out an amount, a percentage or a total: it picks
// and words what those already say, so the phone and the Mac cannot disagree about a month. The
// components only lay these out.

import type {
  MoneyExpenseCharge,
  MoneyExpenseItem,
  MoneyFileState,
  MoneyLedgerEntry,
  MoneyResponse,
} from '@studio/shared';
import { type ExpensesView, MONEY_PAGE_SIZE } from '@/stores/money-ui';
import { type BannerView, bannerViews, incomeDescription } from '../money/banner-view';
import { chargesByDate, emptyExpensesText, expensesFooter } from '../money/expenses-view';
import { formatIls, formatIlsAgorot } from '../money/format';
import {
  ARCHIVED_UNPAID_TEXT,
  type ClientGroup,
  DEFAULT_LEDGER_SORT,
  type DetailTone,
  deliveredDayText,
  deliveredOnly,
  jobDetail,
  type LedgerGroupingMode,
  ledgerPage,
  monthSummary,
  NOT_CHARGED_PREFIX,
  NOT_DELIVERED_TEXT,
  paidText,
  summaryHasContent,
} from '../money/ledger-view';

/** What the board calls a delivered job. The Mac's page says "jobs"; the phone's boards say videos. */
export const VIDEO = { one: 'video', many: 'videos' } as const;

/** "1 video", "26 videos". */
export function videoCountText(count: number): string {
  return `${count} ${count === 1 ? VIDEO.one : VIDEO.many}`;
}

// --- the banners and the warning ---------------------------------------------------------------

/**
 * The three banners of the month, as the Mac prints them (whole shekels, the same change and the
 * same pill), with the Income card counting "videos" as the board does: "26 videos at ₪40".
 */
export function phoneBanners(
  data: Pick<MoneyResponse, 'month' | 'banners' | 'ledger'>,
): BannerView[] {
  return bannerViews(data.month, data.banners, deliveredOnly(data.ledger)).map((banner) =>
    banner.kind === 'income'
      ? { ...banner, description: incomeDescription(deliveredOnly(data.ledger), VIDEO) }
      : banner,
  );
}

/** The warning line while money.json has a mistake and the last good numbers are shown (board MMoneyWarn). */
export const PHONE_MONEY_LAST_GOOD_TEXT =
  'money.json has a mistake, so this page shows the last good numbers. Run pnpm run doctor on the Mac to see it.';

/** The same, when there is no good version either, so the numbers are only the defaults. */
export const PHONE_MONEY_DEFAULTS_TEXT =
  'money.json has a mistake and no good version is saved, so prices and expenses are defaults and Mark delivered is off. Run pnpm run doctor on the Mac.';

/** The line under the title for the state of money.json, or `null` while the file is fine. */
export function moneyFileLine(moneyFile: MoneyFileState): string | null {
  if (moneyFile.status === 'ok') return null;
  return moneyFile.status === 'defaults' ? PHONE_MONEY_DEFAULTS_TEXT : PHONE_MONEY_LAST_GOOD_TEXT;
}

// --- the Ledger --------------------------------------------------------------------------------

/** How many rows show before "Show all": the Mac's page size (there is no pager on the phone). */
export const PHONE_MONEY_ROWS = MONEY_PAGE_SIZE;

/** How many of a client's videos its open group lists; the rest are counted ("and 9 more"). */
export const GROUP_PREVIEW_ROWS = 3;

/** What the button says once every row is out: it folds the list back to its first rows. */
export const SHOW_FEWER_TEXT = 'Show fewer';

/** The nouns of the lists that have a "Show all" button. */
export const LIST_UNITS = {
  videos: VIDEO,
  clients: { one: 'client', many: 'clients' },
  items: { one: 'item', many: 'items' },
  charges: { one: 'charge', many: 'charges' },
} as const;

/**
 * The button under a list longer than its first rows: "Show all 26 videos", then "Show fewer".
 * `null` when the list fits in its first rows.
 */
export function showAllLabel(
  total: number,
  unit: { one: string; many: string },
  expanded: boolean,
): string | null {
  if (total <= PHONE_MONEY_ROWS) return null;
  return expanded ? SHOW_FEWER_TEXT : `Show all ${total} ${total === 1 ? unit.one : unit.many}`;
}

/** What a row says about the money for a video: the day it was paid, "Archived" or "Not paid yet". */
export interface PaidLine {
  text: string;
  /** Delivered, not paid and not archived: the amber one. */
  owed: boolean;
}

export const NOT_PAID_YET_TEXT = 'Not paid yet';

export function paidLine(
  entry: Pick<MoneyLedgerEntry, 'paidOn' | 'archived'> & { deliveredAt?: string | null },
): PaidLine {
  // Not delivered yet: nothing is owed, and the row already says so where it says "delivered".
  if (entry.deliveredAt === null) return { text: '', owed: false };
  if (entry.paidOn !== null) return { text: `Paid ${paidText(entry.paidOn)}`, owed: false };
  if (entry.archived) return { text: ARCHIVED_UNPAID_TEXT, owed: false };
  return { text: NOT_PAID_YET_TEXT, owed: true };
}

/** One video's row: "client · delivered Oct 21 · Paid Oct 22" under its name, the profit on the right. */
export interface PhoneJobRow {
  jobId: string;
  name: string;
  client: string;
  delivered: string;
  paid: PaidLine;
  profit: string;
}

export function phoneJobRow(entry: MoneyLedgerEntry, timeZone?: string): PhoneJobRow {
  return {
    jobId: entry.jobId,
    name: entry.name,
    client: entry.client,
    delivered:
      entry.deliveredAt === null
        ? NOT_DELIVERED_TEXT.toLowerCase()
        : `delivered ${deliveredDayText(entry.deliveredAt, timeZone)}`,
    paid: paidLine(entry),
    profit: formatIls(entry.profit),
  };
}

/** One of the four lines of an open video: Income, Expenses, Profit, Your time. */
export interface PhoneDetailRow {
  id: 'income' | 'expenses' | 'profit' | 'time';
  title: string;
  /** The muted lines under the title. */
  notes: string[];
  /** The amount at the right (the total of the Mac's column). */
  value: string;
  tone: DetailTone;
}

/** Whole shekels for a whole number of them (₪40), to the agora otherwise (₪39.50): how the board's open video reads its Profit. */
function shekelsOrAgorot(value: number): string {
  return Math.round(value * 100) % 100 === 0 ? formatIls(value) : formatIlsAgorot(value);
}

/**
 * The details of an open video: the Mac's four columns (`jobDetail`), one line each. Every amount
 * is the Mac's total for that column (the Profit without a needless ".00", as the board has it);
 * only the words around them are the board's.
 */
export function phoneJobDetail(entry: MoneyLedgerEntry, timeZone?: string): PhoneDetailRow[] {
  return jobDetail(entry, timeZone).map((column): PhoneDetailRow => {
    const { id, title, total } = column;
    switch (id) {
      case 'income':
        return {
          id,
          title,
          notes: [
            entry.deliveredAt === null
              ? `${NOT_DELIVERED_TEXT}: no income until it is`
              : `Price ${formatIls(entry.income)} · delivered ${deliveredDayText(entry.deliveredAt, timeZone)} · ${paidLine(entry).text}`,
          ],
          value: total.value,
          tone: total.tone,
        };
      case 'expenses':
        // The Mac says "—" for a job that cost nothing in its table row; so does the phone.
        return entry.charges.length === 0
          ? {
              id,
              title,
              notes: [`Nothing paid for this ${VIDEO.one}`],
              value: '—',
              tone: total.tone,
            }
          : {
              id,
              title,
              notes: column.lines.map((line) =>
                [line.label, line.note, line.value].filter((part) => part !== null).join(' · '),
              ),
              value: total.value,
              tone: total.tone,
            };
      default:
        return {
          id,
          title,
          notes: column.lines.map((line) =>
            line.value === null
              ? line.label
              : id === 'time'
                ? `${line.label} · ${line.value}`
                : `${line.label} ${line.value}`,
          ),
          value: id === 'profit' ? shekelsOrAgorot(entry.profit) : total.value,
          tone: total.tone,
        };
    }
  });
}

/** What the Ledger shows now: the first rows of the month, or all of them. */
export type PhoneLedgerView =
  | {
      grouping: 'job';
      /** Every video of the month. */
      total: number;
      rows: MoneyLedgerEntry[];
      /** The button under the list, or `null` while everything fits. */
      more: string | null;
    }
  | {
      grouping: 'client';
      /** Every client of the month. */
      total: number;
      groups: ClientGroup[];
      more: string | null;
    };

/**
 * The Ledger in the Mac's order (newest delivery first; the client who kept the most first in "By
 * client"), cut after the first rows unless `expanded`.
 */
export function phoneLedger(
  entries: readonly MoneyLedgerEntry[],
  options: { grouping: LedgerGroupingMode; expanded: boolean },
): PhoneLedgerView {
  const view = ledgerPage(entries, {
    grouping: options.grouping,
    sort: DEFAULT_LEDGER_SORT,
    page: 0,
    pageSize: options.expanded ? Number.MAX_SAFE_INTEGER : PHONE_MONEY_ROWS,
  });
  if (view.grouping === 'client') {
    return {
      grouping: 'client',
      total: view.total,
      groups: view.groups,
      more: showAllLabel(view.total, LIST_UNITS.clients, options.expanded),
    };
  }
  return {
    grouping: 'job',
    total: view.total,
    rows: view.jobs,
    more: showAllLabel(view.total, LIST_UNITS.videos, options.expanded),
  };
}

/** A client's open group: its first videos, and what is left said in words. */
export function groupPreview(group: ClientGroup): {
  rows: MoneyLedgerEntry[];
  more: string | null;
} {
  const left = group.jobs.length - GROUP_PREVIEW_ROWS;
  return {
    rows: group.jobs.slice(0, GROUP_PREVIEW_ROWS),
    more: left > 0 ? `and ${left} more` : null,
  };
}

/** What a client's header says under its name: "12 videos". */
export function groupCountText(group: ClientGroup): string {
  return videoCountText(group.jobs.length);
}

/** The Ledger's heading over the list: the first column is the video, or the client. */
export function ledgerColumnLabel(grouping: LedgerGroupingMode): string {
  return grouping === 'client' ? 'Client' : 'Job';
}

/** "No videos in October." for a month with nothing in the Ledger. */
export function emptyLedgerText(monthName: string): string {
  return `No ${VIDEO.many} in ${monthName}.`;
}

// --- the footer of the Ledger ------------------------------------------------------------------

/** One line of the footer: a label and an amount, with a muted note under them. */
export interface FooterLine {
  id: 'jobs' | 'not-charged' | 'adjustment';
  label: string;
  value: string;
  /** red for money that went out. */
  tone: 'plain' | 'red' | 'muted';
  note: string | null;
}

export interface PhoneFooter {
  lines: FooterLine[];
  /** The last line: the Profit banner's amount, green or red as the banner is. */
  profit: { value: string; tone: 'good' | 'bad' };
}

/**
 * The footer under the Ledger's rows, from the Mac's Month summary: the videos, the payments that
 * belong to no video (the subscriptions and the general charges as one line), the line that
 * reconciles a job cost paid in another month when there is one, and the Profit banner's amount.
 * `null` for a month that has nothing to add up.
 */
export function phoneFooter(data: MoneyResponse): PhoneFooter | null {
  if (!summaryHasContent(data)) return null;
  const summary = monthSummary(data);
  const lines: FooterLine[] = [];

  const jobs = summary.rows.find((row) => row.id === 'jobs');
  if (jobs !== undefined) {
    const bought =
      (jobs.expenses ?? 0) > 0
        ? `${formatIlsAgorot(jobs.expenses ?? 0)} bought for ${VIDEO.many}`
        : `nothing bought for a ${VIDEO.one}`;
    lines.push({
      id: 'jobs',
      label: `${videoCountText(deliveredOnly(data.ledger).length)} delivered`,
      value: formatIls(jobs.profit ?? 0),
      tone: 'plain',
      note: `${formatIls(jobs.income ?? 0)} income, ${bought}`,
    });
  }

  const notCharged = summary.rows.filter((row) => row.id === 'subscriptions' || row.id === 'other');
  if (notCharged.length > 0) {
    lines.push({
      id: 'not-charged',
      label: `Not charged to a ${VIDEO.one}`,
      value: formatIls(notCharged.reduce((sum, row) => sum + (row.profit ?? 0), 0)),
      tone: 'red',
      note: notCharged
        .map((row) => (row.detail ?? '').replace(NOT_CHARGED_PREFIX, ''))
        .filter((text) => text !== '')
        .join(' · '),
    });
  }

  const adjustment = summary.rows.find((row) => row.id === 'adjustment');
  if (adjustment !== undefined) {
    lines.push({
      id: 'adjustment',
      label: adjustment.label,
      value: formatIls(adjustment.profit ?? 0),
      tone: 'muted',
      note: adjustment.detail,
    });
  }

  return {
    lines,
    profit: { value: formatIls(summary.total.profit), tone: summary.total.tone },
  };
}

// --- the Expenses ------------------------------------------------------------------------------

/** The line under "Expenses". */
export const PHONE_EXPENSES_TEXT = 'Every subscription and charge this month.';

/** One row of the Expenses: the name and what it is, the amount in shekels and, when it was paid in another currency, that amount. */
export interface PhoneExpenseRow {
  key: string;
  name: string;
  /** The muted line under the name (an item's kind and billing); `null` for a charge, which draws its own. */
  sub: string | null;
  charge: MoneyExpenseCharge | null;
  ils: string;
  /** The amount as paid ("$200.00") when it is not the shekel amount; `''` otherwise. */
  orig: string;
}

function expenseAmounts(ils: number, amountLabel: string): { ils: string; orig: string } {
  const inShekels = formatIlsAgorot(ils);
  return { ils: inShekels, orig: amountLabel === inShekels ? '' : amountLabel };
}

/** The cadence the board leaves out of "Subscription · renews Nov 1": a monthly plan is the usual one; a yearly one still says so. */
const MONTHLY_PREFIX = /^Monthly · /;

function itemRow(item: MoneyExpenseItem): PhoneExpenseRow {
  return {
    key: item.id,
    name: item.name,
    sub: `${item.kind} · ${item.billing.replace(MONTHLY_PREFIX, '')}`,
    charge: null,
    ...expenseAmounts(item.ils, item.amountLabel),
  };
}

function chargeRow(charge: MoneyExpenseCharge, index: number): PhoneExpenseRow {
  return {
    key: `${charge.date}-${charge.item}-${index}`,
    name: charge.item,
    sub: null,
    charge,
    ...expenseAmounts(charge.ils, charge.amountLabel),
  };
}

export interface PhoneExpenses {
  view: ExpensesView;
  /** Every row of the view. */
  total: number;
  rows: PhoneExpenseRow[];
  more: string | null;
  /** "2 items · total this month" and the month's total, to the agora. */
  footer: { label: string; amount: string };
  /** The line that replaces the list when the month has nothing in it. */
  empty: string | null;
}

/** The Expenses of the month as Items or All charges, cut after the first rows unless `expanded`. */
export function phoneExpenses(
  expenses: MoneyResponse['expenses'],
  options: { view: ExpensesView; expanded: boolean; month: string },
): PhoneExpenses {
  const { view, expanded, month } = options;
  const all =
    view === 'items' ? expenses.items.map(itemRow) : chargesByDate(expenses.charges).map(chargeRow);
  const footer = expensesFooter(view, all.length, expenses.total);
  return {
    view,
    total: all.length,
    rows: expanded ? all : all.slice(0, PHONE_MONEY_ROWS),
    more: showAllLabel(all.length, LIST_UNITS[view === 'items' ? 'items' : 'charges'], expanded),
    footer: { label: footer.label, amount: footer.amount },
    empty: all.length === 0 ? emptyExpensesText(month) : null,
  };
}
