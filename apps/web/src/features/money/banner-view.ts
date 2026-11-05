// What the three banners of the Money page say, as pure functions (approved design canvas, board
// "Money · banners, Ledger, Expenses (read-only)"). The Banners component only lays these out.
//
// Everything is worked out on whole shekels, the way the banner prints them: the change is the
// difference of the two amounts on the card, never a fraction of a shekel the card does not show.

import { addMonths, type MoneyResponse, type MoneyUnpaid } from '@studio/shared';
import { formatIls, formatIlsAgorot, monthName, roundWhole } from './format';

/** The three banners, left to right. */
export const BANNER_KINDS = ['income', 'expenses', 'profit'] as const;
export type BannerKind = (typeof BANNER_KINDS)[number];

/** How the change since last month reads: good (green), bad (red) or flat (grey). */
export type BannerTone = 'good' | 'bad' | 'flat';

/** Which way the amount went since last month. */
export type BannerDirection = 'up' | 'down' | 'flat';

/**
 * Whether the change from `previous` to `value` is good for the owner. More income and more profit are
 * good, less is bad; for expenses it is the other way round. No change at all (to the shekel) is
 * flat.
 */
export function bannerTone(kind: BannerKind, value: number, previous: number): BannerTone {
  const change = roundWhole(value) - roundWhole(previous);
  if (change === 0) return 'flat';
  const higherIsGood = kind !== 'expenses';
  return change > 0 === higherIsGood ? 'good' : 'bad';
}

/** Up, down or flat since last month, to the shekel. */
export function bannerDirection(value: number, previous: number): BannerDirection {
  const change = roundWhole(value) - roundWhole(previous);
  return change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
}

const MINUS = '−';

/**
 * The pill's text: the change as a percentage of last month, with its sign: "+18%", "−5%", "0%".
 * Last month at 0 has no percentage to give, so a month that has something says "New".
 */
export function bannerPercent(value: number, previous: number): string {
  const change = roundWhole(value) - roundWhole(previous);
  if (change === 0) return '0%';
  const before = Math.abs(roundWhole(previous));
  if (before === 0) return 'New';
  const percent = Math.round((Math.abs(change) / before) * 100);
  return `${change > 0 ? '+' : MINUS}${percent}%`;
}

/**
 * The line under the sparkline: "+₪800 vs September (₪4,400)", or "Same as September" when the
 * amount did not change. `month` is the month shown (YYYY-MM); the comparison is with the one
 * before it.
 */
export function bannerDelta(month: string, value: number, previous: number): string {
  const before = monthName(addMonths(month, -1));
  const change = roundWhole(value) - roundWhole(previous);
  if (change === 0) return `Same as ${before}`;
  const amount = formatIls(Math.abs(change));
  return `${change > 0 ? '+' : MINUS}${amount} vs ${before} (${formatIls(previous)})`;
}

/** What the Income description counts: the Mac says jobs, the phone's board says videos. */
export interface JobNoun {
  one: string;
  many: string;
}
const JOBS: JobNoun = { one: 'job', many: 'jobs' };

/**
 * The Income banner's description: "26 jobs at ₪200". When the jobs were not all priced alike
 * (a client with its own price) only the count is said. `noun` is what the jobs are called.
 */
export function incomeDescription(
  ledger: readonly { income: number }[],
  noun: JobNoun = JOBS,
): string {
  const count = ledger.length;
  const first = ledger[0];
  if (first === undefined) return `No ${noun.many} delivered`;
  const jobs = `${count} ${count === 1 ? noun.one : noun.many}`;
  if (!ledger.every((job) => job.income === first.income)) return jobs;
  const price = Number.isInteger(first.income)
    ? formatIls(first.income)
    : formatIlsAgorot(first.income);
  return `${jobs} at ${price}`;
}

/** What the Income banner says about money still owed: "₪120" and "not paid yet · 3 videos". */
export interface UnpaidLine {
  amount: string;
  text: string;
}

/**
 * The line under the Income description: the amount not paid yet and how many videos it is. `null`
 * when everything delivered this month is paid (or nothing was delivered), so the line is left out.
 */
export function unpaidLine(unpaid: MoneyUnpaid): UnpaidLine | null {
  if (unpaid.count <= 0) return null;
  const videos = `${unpaid.count} ${unpaid.count === 1 ? 'video' : 'videos'}`;
  return { amount: formatIls(unpaid.value), text: `not paid yet · ${videos}` };
}

/** The fixed words of the banners; the Income description depends on the ledger. */
export const BANNER_TEXT: Record<BannerKind, { title: string; description: string | null }> = {
  income: { title: 'Income', description: null },
  expenses: { title: 'Expenses', description: 'Subscriptions and API charges' },
  profit: { title: 'Profit', description: 'Income minus expenses' },
};

/**
 * The look of each tone, as the board has it: the card's border and tint, the pill's tint, and the
 * accent that colours the pill's text, the sparkline and the change line.
 */
export const BANNER_TONE_STYLES: Record<
  BannerTone,
  { card: string; pill: string; accent: string }
> = {
  good: {
    card: 'border-[rgba(74,222,128,0.35)] bg-[rgba(34,197,94,0.07)]',
    pill: 'bg-[rgba(74,222,128,0.14)]',
    accent: 'text-[#4ADE80]',
  },
  bad: {
    card: 'border-[rgba(248,113,113,0.38)] bg-[rgba(239,68,68,0.07)]',
    pill: 'bg-[rgba(248,113,113,0.14)]',
    accent: 'text-[#F87171]',
  },
  flat: {
    card: 'border-[rgba(255,255,255,0.1)] bg-transparent',
    pill: 'bg-[rgba(255,255,255,0.06)]',
    accent: 'text-[#A1A1AA]',
  },
};

/** The sparkline's size, in pixels. */
export const SPARKLINE_WIDTH = 150;
export const SPARKLINE_HEIGHT = 48;

/**
 * The points of the sparkline for `values` (oldest first): `line` for the polyline and `area` for
 * the filled polygon under it. The lowest value sits 4 px above the bottom and the highest 4 px
 * below the top, and the line starts and ends 2 px from the sides, so the stroke is never clipped.
 * Values that are all the same make a line along the bottom.
 */
export function sparklinePoints(
  values: readonly number[],
  width = SPARKLINE_WIDTH,
  height = SPARKLINE_HEIGHT,
): { line: string; area: string } {
  if (values.length === 0) return { line: '', area: '' };
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const last = values.length - 1;
  const points = values.map((v, i): [number, number] => [
    2 + (last === 0 ? 0.5 : i / last) * (width - 4),
    height - 4 - ((v - min) / range) * (height - 8),
  ]);
  const text = ([x, y]: [number, number]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const line = points.map(text).join(' ');
  const end = points[points.length - 1] ?? [0, 0];
  return { line, area: `2,${height} ${line} ${end[0].toFixed(1)},${height}` };
}

/** Everything one banner card shows. */
export interface BannerView {
  kind: BannerKind;
  title: string;
  description: string;
  tone: BannerTone;
  direction: BannerDirection;
  percent: string;
  value: string;
  delta: string;
  sparkline: { line: string; area: string };
  /** Only the Income card has one, and only while something delivered this month is not paid. */
  unpaid: UnpaidLine | null;
}

/** The three cards for `month`, from the response's banners and its ledger. */
export function bannerViews(
  month: string,
  banners: MoneyResponse['banners'],
  ledger: readonly { income: number }[],
): BannerView[] {
  return BANNER_KINDS.map((kind) => {
    const { value, previous, history } = banners[kind];
    const text = BANNER_TEXT[kind];
    return {
      kind,
      title: text.title,
      description: text.description ?? incomeDescription(ledger),
      tone: bannerTone(kind, value, previous),
      direction: bannerDirection(value, previous),
      percent: bannerPercent(value, previous),
      value: formatIls(value),
      delta: bannerDelta(month, value, previous),
      sparkline: sparklinePoints(history),
      unpaid: kind === 'income' ? unpaidLine(banners.income.unpaid) : null,
    };
  });
}
