// The rules of the Mark paid dialog, as plain functions: which of a client's jobs it lists, which
// are ticked, what ticking them adds up to, and the words for it. Nothing here touches React, the
// network or the clock (the day comes in as an argument), so the rules are tested on plain data.

import { isArchived, isFolderDeleted, type Job, jobStage, paidAmountOf } from '@studio/shared';
import {
  deliveredDay,
  formatPrice,
  isPriced,
  type PricedDelivery,
  priceSign,
} from '../delivery-text';

/** A job the dialog lists: delivered (or uploaded) and not paid, so it has a delivery. */
export type OwedJob = Job & { delivery: PricedDelivery };

/**
 * What the dialog lists for a client: its delivered, unpaid videos, newest delivery first (ties
 * keep the order of the list they came from). A video with a reel linked to it (Uploaded) is
 * delivered and unpaid too, so it is listed. A paid video, an approved one and one that left
 * ready again (a retry keeps its delivery, but has no stage) are not owed. Neither is an archived
 * one: archived means paid already or not needed (the owner, CVP-202), so it is never offered for a
 * payment. A video whose folder was deleted is owed like any other (the owner, CVP-204): it is in the
 * list the page gives, with the client's other videos.
 */
export function owedJobs(jobs: readonly Job[] | undefined, clientId: string): OwedJob[] {
  const owed: OwedJob[] = [];
  for (const job of jobs ?? []) {
    if (
      job.clientId === clientId &&
      !isArchived(job) &&
      (jobStage(job) === 'delivered' || jobStage(job) === 'uploaded') &&
      job.delivery !== null &&
      isPriced(job.delivery)
    ) {
      owed.push({ ...job, delivery: job.delivery });
    }
  }
  // `sort` is stable, so videos delivered at the same moment keep the list's order.
  return owed.sort(
    (a, b) => Date.parse(b.delivery.deliveredAt) - Date.parse(a.delivery.deliveredAt),
  );
}

/** The ticks the dialog opens with: the video it was opened from, if it is still owed. */
export function initialTicked(owed: readonly OwedJob[], jobId: string): ReadonlySet<string> {
  return new Set(owed.some((job) => job.id === jobId) ? [jobId] : []);
}

/** The owed videos that are ticked, in the dialog's order. A tick for a video no longer owed is ignored. */
export function tickedJobs(owed: readonly OwedJob[], ticked: ReadonlySet<string>): OwedJob[] {
  return owed.filter((job) => ticked.has(job.id));
}

/** `ticked` with `jobId` ticked or unticked. */
export function toggleTicked(ticked: ReadonlySet<string>, jobId: string): ReadonlySet<string> {
  const next = new Set(ticked);
  if (!next.delete(jobId)) next.add(jobId);
  return next;
}

/** Whether every owed video is ticked (never with nothing owed): the button then reads "Clear". */
export function allTicked(owed: readonly OwedJob[], ticked: ReadonlySet<string>): boolean {
  return owed.length > 0 && tickedJobs(owed, ticked).length === owed.length;
}

/** "Select all" ticks every owed video; "Clear" (when all are ticked) unticks them. */
export function toggleAll(
  owed: readonly OwedJob[],
  ticked: ReadonlySet<string>,
): ReadonlySet<string> {
  return allTicked(owed, ticked) ? new Set() : new Set(owed.map((job) => job.id));
}

/**
 * What jobs add up to: what was paid for each (`paidAmount`), else the price it was delivered at.
 * "₪80", or "₪80 + $25" when they were priced in two currencies (a price is frozen at delivery, so
 * they can differ; they are not converted). Cents are rounded away from float noise. Empty for no
 * jobs.
 */
export function formatTotal(
  jobs: readonly { delivery: Pick<PricedDelivery, 'price' | 'currency' | 'paidAmount'> }[],
): string {
  const sums = new Map<string, number>();
  for (const { delivery } of jobs) {
    sums.set(delivery.currency, (sums.get(delivery.currency) ?? 0) + paidAmountOf(delivery));
  }
  return [...sums]
    .map(([currency, sum]) => formatPrice(Math.round(sum * 100) / 100, currency))
    .join(' + ');
}

/** "1 video" / "3 videos". */
export function videoCount(count: number): string {
  return count === 1 ? '1 video' : `${count} videos`;
}

/**
 * The amounts the person typed in the dialog, by job id, as typed ("40", "0", "37.5"). A video with
 * none shows, and is paid, the price it was delivered at.
 */
export type TypedAmounts = ReadonlyMap<string, string>;

/** The amount field's first text: the price it was delivered at, "40" or "37.5". */
export function amountText(price: number): string {
  return String(Math.round(price * 100) / 100);
}

/**
 * What a typed amount is worth, or `null` when it is not an amount: digits, with up to two
 * decimals after a point (or a comma); 0 is one. Spaces around it are ignored.
 */
export function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+([.,]\d{1,2})?$/.test(trimmed)) return null;
  return Number(trimmed.replace(',', '.'));
}

/** What the field of a video shows: what was typed for it, else its price. */
export function amountTextOf(job: OwedJob, typed: TypedAmounts): string {
  return typed.get(job.id) ?? amountText(job.delivery.price);
}

/** `typed` with `text` for `jobId`. */
export function typeAmount(typed: TypedAmounts, jobId: string, text: string): TypedAmounts {
  return new Map(typed).set(jobId, text);
}

/**
 * What the payment says was paid for each ticked video, by job id: its typed amount, or its price
 * when nothing was typed. `null` when a ticked video's field holds something that is not an amount
 * (the payment cannot be sent then).
 */
export function paidAmounts(
  ticked: readonly OwedJob[],
  typed: TypedAmounts,
): Record<string, number> | null {
  const amounts: Record<string, number> = {};
  for (const job of ticked) {
    const amount = parseAmount(amountTextOf(job, typed));
    if (amount === null) return null;
    amounts[job.id] = amount;
  }
  return amounts;
}

/**
 * The footer's total: "Nothing ticked", "1 video · ₪40" or "2 videos · ₪80", adding up what was
 * typed for each ticked video (a field that holds no amount counts as nothing).
 */
export function totalLabel(ticked: readonly OwedJob[], typed: TypedAmounts = new Map()): string {
  if (ticked.length === 0) return 'Nothing ticked';
  const paid = ticked.map((job) => ({
    delivery: { ...job.delivery, paidAmount: parseAmount(amountTextOf(job, typed)) ?? 0 },
  }));
  return `${videoCount(ticked.length)} · ${formatTotal(paid)}`;
}

/** The primary button: "Mark paid" for one video (or none), "Mark 2 paid" for more. */
export function confirmLabel(count: number): string {
  return count > 1 ? `Mark ${count} paid` : 'Mark paid';
}

/** The calendar day (`YYYY-MM-DD`) of `now` on the browser's clock: what "today" means to the person. */
export function todayLocal(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Whether `paidOn` is a day a payment can have come in: a full `YYYY-MM-DD`, not after `today`. */
export function isPaidOnAllowed(paidOn: string, today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(paidOn) && paidOn <= today;
}

/** One line of the dialog's list. */
export interface PayRow {
  id: string;
  name: string;
  /** "16 Oct": the day it was delivered. */
  delivered: string;
  /** "₪40": the price frozen when it was delivered. */
  price: string;
  /** The sign the amount field starts with: "₪". */
  sign: string;
  /** What the amount field holds: what was typed, else the price ("40"). */
  amount: string;
  /** The field holds an amount that can be sent (0 included). */
  amountValid: boolean;
  checked: boolean;
  /** Its folder was deleted: the dialog says so after the name. */
  folderDeleted: boolean;
}

/** The rows the dialog draws, from the owed videos, the ticks and the amounts typed. */
export function payRows(
  owed: readonly OwedJob[],
  ticked: ReadonlySet<string>,
  timeZone?: string,
  typed: TypedAmounts = new Map(),
): PayRow[] {
  return owed.map((job) => ({
    id: job.id,
    name: job.name,
    delivered: deliveredDay(job.delivery, timeZone),
    price: formatPrice(job.delivery.price, job.delivery.currency),
    sign: priceSign(job.delivery.currency),
    amount: amountTextOf(job, typed),
    amountValid: parseAmount(amountTextOf(job, typed)) !== null,
    checked: ticked.has(job.id),
    folderDeleted: isFolderDeleted(job),
  }));
}
