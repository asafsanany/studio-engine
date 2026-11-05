import { homeCurrencySymbol } from '@studio/shared';
// What the Jobs page says about a delivery (and the day a job was archived): the row's detail line
// ("Delivered 21 Oct · ₪40 not paid", "Posted Tue 20 Oct · 27.5K plays"), the price, and the month a
// delivery counts in. Month names are English whatever the system locale, from a table here rather
// than Intl, so ICU data can never change the text.

import {
  isFolderDeleted,
  type Job,
  type JobDelivery,
  jobStage,
  paidAmountOf,
} from '@studio/shared';
import { playsText } from '@/features/clients/instagram/instagram-text';

const MONTHS = [
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

/**
 * A delivery that carries its money. The admin's always does; an editor's job comes without the
 * price, currency and pay date (money is the admin's alone), and the screens then say nothing about
 * money for it.
 */
export type PricedDelivery = JobDelivery & { price: number; currency: string };

/** Whether the delivery carries its price (the admin's does, an editor's does not). */
export const isPriced = (delivery: JobDelivery): delivery is PricedDelivery =>
  delivery.price !== undefined && delivery.currency !== undefined;

/** The middle dot the rows separate their parts with. */
const SEPARATOR = ' · ';

/** What a video whose folder was deleted says first on its row (CVP-204). */
export const FOLDER_DELETED_TEXT = 'Folder deleted';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "Oct" for month 10 (1-12): the first three letters of its name. */
const shortMonth = (month: number): string => (MONTHS[month - 1] ?? '').slice(0, 3);

/**
 * The calendar day and month (1-12) of an instant on a wall clock set to `timeZone` (an IANA name)
 * or, when omitted, to the browser's own. A delivery is "21 Oct" by the day the person lived it.
 */
function localDayOf(
  iso: string,
  timeZone: string | undefined,
): { day: number; month: number; year: number } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  if (timeZone === undefined) {
    const date = new Date(ms);
    return { day: date.getDate(), month: date.getMonth() + 1, year: date.getFullYear() };
  }
  let day = 0;
  let month = 0;
  let year = 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  });
  for (const part of parts.formatToParts(ms)) {
    if (part.type === 'day') day = Number(part.value);
    if (part.type === 'month') month = Number(part.value);
    if (part.type === 'year') year = Number(part.value);
  }
  return { day, month, year };
}

/** "21 Oct" for the moment a job was marked delivered, on the browser's calendar. */
export function deliveredDay(
  delivery: Pick<JobDelivery, 'deliveredAt'>,
  timeZone?: string,
): string {
  const local = localDayOf(delivery.deliveredAt, timeZone);
  return local === null ? '' : `${local.day} ${shortMonth(local.month)}`;
}

/**
 * "Tue 20 Oct" for the moment the reel linked to the job was posted (`uploadedAt`), on the
 * browser's calendar; "" for a job with no reel. The weekday is worked out from the date, not from
 * ICU, like the month.
 */
export function postedDay(delivery: Pick<JobDelivery, 'uploadedAt'>, timeZone?: string): string {
  if (delivery.uploadedAt === undefined) return '';
  const local = localDayOf(delivery.uploadedAt, timeZone);
  if (local === null) return '';
  const weekday = WEEKDAYS[new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()];
  return `${weekday} ${local.day} ${shortMonth(local.month)}`;
}

/** What a day is called when it is the one it is now. */
export const TODAY_TEXT = 'Today';

/**
 * Whether the job was marked delivered on the same calendar day as `now` (the browser's, or
 * `timeZone`'s): the day and month match and it was less than a day ago, so the same date of
 * another year is not "today".
 */
export function deliveredToday(
  delivery: Pick<JobDelivery, 'deliveredAt'>,
  now: string | number | Date,
  timeZone?: string,
): boolean {
  const nowMs = new Date(now).getTime();
  const sentMs = Date.parse(delivery.deliveredAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(sentMs)) return false;
  if (Math.abs(nowMs - sentMs) >= 24 * 60 * 60 * 1000) return false;
  const nowDay = deliveredDay({ deliveredAt: new Date(nowMs).toISOString() }, timeZone);
  return nowDay !== '' && nowDay === deliveredDay(delivery, timeZone);
}

/** "21 Oct" for the moment a job was archived, on the browser's calendar. */
export function archivedDay(archivedAt: string, timeZone?: string): string {
  const local = localDayOf(archivedAt, timeZone);
  return local === null ? '' : `${local.day} ${shortMonth(local.month)}`;
}

/** "23 Oct" for the calendar day (YYYY-MM-DD) a payment came in. It has no time zone to convert. */
export function paidDay(paidOn: string): string {
  const [, month, day] = paidOn.split('-');
  return `${Number(day)} ${shortMonth(Number(month))}`;
}

/** "October": the month a delivery counts in as income, on the browser's calendar. */
export function deliveredMonth(
  delivery: Pick<JobDelivery, 'deliveredAt'>,
  timeZone?: string,
): string {
  const local = localDayOf(delivery.deliveredAt, timeZone);
  return local === null ? '' : (MONTHS[local.month - 1] ?? '');
}

/** "October" for the month "2026-10" (YYYY-MM): the month a delivery made now counts in. */
export function monthName(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1] ?? '';
}

/** Currencies with a sign of their own; any other is written as its code in front of the number. */
const SIGNS: Readonly<Record<string, string>> = {
  get ILS() {
    return homeCurrencySymbol();
  },
  USD: '$',
};

const priceFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** "₪40", "₪37.50", "$25": the price frozen when the job was marked delivered. */
/** The sign a price in `currency` starts with: "₪", "$", or the code and a space ("EUR "). */
export function priceSign(currency: string): string {
  return SIGNS[currency] ?? `${currency} `;
}

export function formatPrice(price: number, currency: string): string {
  const sign = priceSign(currency);
  const digits = Number.isInteger(price) ? priceFormat.format(price) : price.toFixed(2);
  return `${sign}${digits}`;
}

/** "₪40 not paid": what a delivered or uploaded video is still owed, as the rows write it. */
function owedText(delivery: PricedDelivery): string {
  return `${formatPrice(delivery.price, delivery.currency)} not paid`;
}

/**
 * The line of a delivered, uploaded or paid job; `uploadedSays` is what an uploaded job's line says
 * after the day: the reel's `plays` (the Jobs list) or the `money` it is still owed (the phone's
 * sheet header, which has no other room for it).
 */
function detailLine(
  job: Pick<Job, 'state' | 'delivery'>,
  timeZone: string | undefined,
  uploadedSays: 'plays' | 'money',
): string | null {
  const { delivery } = job;
  if (job.state !== 'ready' || delivery === null) return null;
  const lead = isFolderDeleted(job) ? `${FOLDER_DELETED_TEXT}${SEPARATOR}` : '';
  const uploaded = jobStage(job) === 'uploaded';
  // A linked reel says when it was posted, where Delivered says when it was sent.
  const sent = uploaded
    ? `Posted ${postedDay(delivery, timeZone)}`
    : `Delivered ${deliveredDay(delivery, timeZone)}`;
  // The reel's plays, when they are known: the money is not on this line then.
  if (uploaded && uploadedSays === 'plays') {
    return delivery.reelPlays === undefined
      ? `${lead}${sent}`
      : `${lead}${sent}${SEPARATOR}${playsText(delivery.reelPlays)}`;
  }
  // An editor's job has no money: "Delivered 21 Oct" and nothing about the price or payment.
  if (!isPriced(delivery)) return `${lead}${sent}`;
  if (delivery.paidOn == null) return `${lead}${sent}${SEPARATOR}${owedText(delivery)}`;
  const paid = formatPrice(paidAmountOf(delivery), delivery.currency);
  return `${lead}Paid ${paidDay(delivery.paidOn)}${SEPARATOR}${paid}`;
}

/**
 * The detail line of a delivered, uploaded or paid row, or `null` for a job that is none of them (an
 * approved job keeps the line every ready job has: its length and size):
 * - delivered: "Delivered 21 Oct · ₪40 not paid"
 * - uploaded (a reel is linked to it): "Posted Tue 20 Oct · 27.5K plays", the day the reel was posted
 *   and how it is doing (its plays the short way, as the Instagram section writes them: 980, 18.4K,
 *   1.2M; none when they are not known). What it is still owed is `uploadedOwedText`, which the
 *   row's tooltip says.
 * - paid: "Paid 23 Oct · ₪40", what the client paid (which can be less than the price, or ₪0)
 * A video whose folder was deleted says so first: "Folder deleted · Delivered 21 Oct · ₪40 not
 * paid".
 * It reads the job's own delivery, so a job that left ready (a retry) has none: only a ready job
 * has a stage.
 */
export function deliveryDetail(
  job: Pick<Job, 'state' | 'delivery'>,
  timeZone?: string,
): string | null {
  return detailLine(job, timeZone, 'plays');
}

/**
 * The same line with the money where an uploaded job's says its plays: "Posted Tue 20 Oct · ₪40 not
 * paid". The phone sheet's header uses it (the reel's numbers have their own row in its Details).
 */
export function deliveryMoneyDetail(
  job: Pick<Job, 'state' | 'delivery'>,
  timeZone?: string,
): string | null {
  return detailLine(job, timeZone, 'money');
}

/**
 * "₪40 not paid", for the tooltip of an uploaded row: the money its line leaves out. `null` for any
 * other job, and for an editor's (money is the admin's alone).
 */
export function uploadedOwedText(job: Pick<Job, 'state' | 'delivery'>): string | null {
  const { delivery } = job;
  if (job.state !== 'ready' || delivery === null || !isPriced(delivery)) return null;
  return jobStage(job) === 'uploaded' ? owedText(delivery) : null;
}
