import { z } from 'zod';

// The money file (Phase 4 plan, §2 and §3): every price the owner charges and every shekel they pay live
// in <dataDir>/money.json, which they edit by hand. This module is the schema of that file and the
// money maths on it, as pure functions. Reading the file is the server's job (money/money-file.ts).
//
// Dates are calendar days written YYYY-MM-DD. They are compared as text and counted with plain
// year/month/day numbers, never through a Date, so the result cannot shift with the time zone of
// the machine (a Date at local midnight is a different UTC day in Israel than in New York).

/** The file's name inside the data folder. */
export const MONEY_FILE_NAME = 'money.json';

/** What a dollar is worth in shekels until money.json says otherwise. */
export const DEFAULT_USD_TO_ILS = 3.7;

/** The price of one delivered job until money.json says otherwise, in shekels. */
export const DEFAULT_PRICE_PER_JOB = 200;

// --- calendar days -----------------------------------------------------------------------------

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** How many days `month` (1-12) of `year` has. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Whether `value` is a real calendar day written YYYY-MM-DD ("2026-02-30" is not). */
export function isCalendarDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** The calendar day `day` of `month` in `year`, as YYYY-MM-DD. `day` must exist in that month. */
function formatDay(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The renewal `day` inside a month: day 31 in a 30-day month is the 30th, and so on. */
function clampedDay(year: number, month: number, day: number): string {
  return formatDay(year, month, Math.min(day, daysInMonth(year, month)));
}

function assertCalendarDay(value: string): void {
  if (!isCalendarDay(value)) {
    throw new RangeError(`Not a calendar day written YYYY-MM-DD: ${JSON.stringify(value)}`);
  }
}

// --- months ------------------------------------------------------------------------------------

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Whether `value` is a month written YYYY-MM ("2026-10"; "2026-13" and "2026-1" are not). */
export function isMonth(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

/** A calendar month, YYYY-MM. */
export const monthSchema = z
  .string()
  .refine(isMonth, 'must be a month written YYYY-MM, like 2026-10');

function assertMonth(value: string): [year: number, month: number] {
  const match = MONTH_PATTERN.exec(value);
  if (!match) throw new RangeError(`Not a month written YYYY-MM: ${JSON.stringify(value)}`);
  return [Number(match[1]), Number(match[2])];
}

/**
 * The first and the last calendar day of `month` ("2026-10" is "2026-10-01" and "2026-10-31"), the
 * range to give `chargesBetween`. Throws a RangeError when `month` is not YYYY-MM.
 */
export function monthRange(month: string): { first: string; last: string } {
  const [year, number] = assertMonth(month);
  return {
    first: formatDay(year, number, 1),
    last: formatDay(year, number, daysInMonth(year, number)),
  };
}

/** The month `delta` months after `month` (before it when negative): "2026-01" and -1 is "2025-12". */
export function addMonths(month: string, delta: number): string {
  const [year, number] = assertMonth(month);
  const index = year * 12 + (number - 1) + delta;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1, 2)}`;
}

const monthFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar month a moment (milliseconds since the epoch) falls in on a wall clock set to
 * `timeZone` (an IANA name such as "Asia/Jerusalem"): the same instant is October in Israel and
 * still September in New York. Throws a RangeError for a time zone the runtime does not know.
 */
export function localMonthOf(ms: number, timeZone: string): string {
  let formatter = monthFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
    });
    monthFormatters.set(timeZone, formatter);
  }
  let year = '';
  let month = '';
  for (const part of formatter.formatToParts(ms)) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
  }
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}`;
}

// --- schema ------------------------------------------------------------------------------------

export const MONEY_CURRENCIES = ['ILS', 'USD'] as const;
export const moneyCurrencySchema = z.enum(MONEY_CURRENCIES);
export type MoneyCurrency = z.infer<typeof moneyCurrencySchema>;

/** A real calendar day, YYYY-MM-DD. */
export const calendarDaySchema = z
  .string()
  .refine(isCalendarDay, 'must be a date written YYYY-MM-DD, like 2026-10-14');

/** A job's `rel_path`: `Client/Job`. */
const jobRelPathSchema = z
  .string()
  .regex(/^[^/]+\/[^/]+$/, 'must be the client folder and the job folder: "Client/Job"');

/**
 * A payment that comes back on a schedule. `day` is the day of the month it is taken on (a short
 * month takes its last day instead); a yearly one also needs `month`. `since` is the first day it
 * can be taken and `until` the last, both included.
 */
export const moneySubscriptionSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    amount: z.number().nonnegative(),
    currency: moneyCurrencySchema,
    every: z.enum(['month', 'year']),
    day: z.number().int().min(1).max(31),
    month: z.number().int().min(1).max(12).optional(),
    since: calendarDaySchema,
    until: calendarDaySchema.optional(),
    /**
     * What the plan includes a month, when it is paid for in credits (ElevenLabs): with it the
     * engine can say what one credit costs and show a job's share of the plan. Optional.
     */
    credits: z.number().int().positive().optional(),
  })
  .superRefine((subscription, ctx) => {
    if (subscription.every === 'year' && subscription.month === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['month'],
        message: 'is needed when every is "year": the month it renews in, 1 to 12',
      });
    }
    if (subscription.every === 'month' && subscription.month !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['month'],
        message: 'only applies when every is "year"; remove it or change every',
      });
    }
    if (subscription.until !== undefined && subscription.until < subscription.since) {
      ctx.addIssue({
        code: 'custom',
        path: ['until'],
        message: 'must not be before since',
      });
    }
  });
export type MoneySubscription = z.output<typeof moneySubscriptionSchema>;

/** A one-off or per-use payment. `job` (`Client/Job`) makes it that job's expense. */
export const moneyChargeSchema = z.strictObject({
  date: calendarDaySchema,
  item: z.string().min(1),
  what: z.string().min(1),
  amount: z.number().nonnegative(),
  currency: moneyCurrencySchema,
  job: jobRelPathSchema.optional(),
});
export type MoneyCharge = z.output<typeof moneyChargeSchema>;

/**
 * A cost the engine worked out from what it recorded (Higgsfield's dollars on a generated video,
 * the credits of ElevenLabs' music, the dollars of a client's Instagram scan), not one the owner typed
 * into money.json. It names its job when a video caused it, and has none when it did not (the
 * scan of a client's Instagram): like a money.json charge without `job`, the month counts it once
 * and no job's expenses do.
 * `includedIn` is the id of the subscription whose plan already paid for it (ElevenLabs credits):
 * the job shows it, but the month does not count it a second time next to the plan's renewal.
 * `credits` is how many of the plan's credits it used, for the plan's small print.
 */
export interface MoneyServiceCharge extends MoneyCharge {
  includedIn?: string;
  credits?: number;
}

/** The whole file. Every field has a default, so `{}` is valid; an unknown key is an error. */
export const moneyFileSchema = z
  .strictObject({
    currency: z.literal('ILS').default('ILS'),
    usdToIls: z.number().positive().default(DEFAULT_USD_TO_ILS),
    pricePerJob: z.number().nonnegative().default(DEFAULT_PRICE_PER_JOB),
    /** Client folder name to price. A client not in here pays `pricePerJob`. */
    clientPrices: z.record(z.string().min(1), z.number().nonnegative()).default({}),
    subscriptions: z.array(moneySubscriptionSchema).default([]),
    charges: z.array(moneyChargeSchema).default([]),
  })
  .superRefine((file, ctx) => {
    // The id names a subscription everywhere else, so two of them can't share one.
    const seen = new Set<string>();
    file.subscriptions.forEach((subscription, index) => {
      if (seen.has(subscription.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['subscriptions', index, 'id'],
          message: `"${subscription.id}" is used by another subscription; ids must be unique`,
        });
      }
      seen.add(subscription.id);
    });
  });
export type MoneyFile = z.output<typeof moneyFileSchema>;

/** What a missing money.json means: the default price and rate, no subscriptions, no charges. */
export const DEFAULT_MONEY: MoneyFile = moneyFileSchema.parse({});

// --- maths -------------------------------------------------------------------------------------

/**
 * Rounds to whole agorot (two decimals), halves away from zero. The value is shifted by writing
 * it as text with "e2", which keeps 1.005 at 1.01 where `Math.round(1.005 * 100)` gives 1.
 */
export function roundIls(value: number): number {
  const magnitude = Math.abs(value);
  // Past 1e15 a double has no fraction left, so there is nothing to round.
  if (!Number.isFinite(value) || magnitude >= 1e15) return value;
  // Below half an agora it is 0, and a number this small would be written with an exponent.
  if (magnitude < 0.005) return 0;
  const rounded = Math.round(Number(`${magnitude}e2`)) / 100;
  return value < 0 ? -rounded : rounded;
}

/** `amount` in shekels, to the agora: dollars are converted at `usdToIls`. */
export function toIls(
  amount: number,
  currency: MoneyCurrency,
  money: Pick<MoneyFile, 'usdToIls'>,
): number {
  return roundIls(currency === 'USD' ? amount * money.usdToIls : amount);
}

/**
 * What `client` pays for a job: its entry in `clientPrices`, otherwise `pricePerJob`. Folder
 * names are matched as written first, then with both sides NFC-normalised, because macOS can hand
 * back the decomposed spelling of a name that was typed precomposed.
 */
export function priceForClient(
  money: Pick<MoneyFile, 'pricePerJob' | 'clientPrices'>,
  client: string,
): number {
  const exact = Object.hasOwn(money.clientPrices, client) ? money.clientPrices[client] : undefined;
  if (exact !== undefined) return exact;
  const wanted = client.normalize('NFC');
  for (const [name, price] of Object.entries(money.clientPrices)) {
    if (name.normalize('NFC') === wanted) return price;
  }
  return money.pricePerJob;
}

/** One payment on a given day: a `charges` entry, or one renewal of a subscription. */
export interface MoneyChargeLine extends MoneyCharge {
  /** The amount in shekels, to the agora. */
  ils: number;
  /** Set on a renewal: the `id` of the subscription it comes from. */
  subscriptionId?: string;
  /** Set on a job's share of a plan that is already paid for: the `id` of that subscription. */
  includedIn?: string;
}

/** The renewal days of `subscription` between `from` and `to`, both included. */
function renewalDays(subscription: MoneySubscription, from: string, to: string): string[] {
  const first = subscription.since > from ? subscription.since : from;
  const last =
    subscription.until !== undefined && subscription.until < to ? subscription.until : to;
  if (first > last) return [];

  const [firstYear = 0, firstMonth = 1] = first.split('-').map(Number);
  const [lastYear = 0, lastMonth = 1] = last.split('-').map(Number);
  const days: string[] = [];
  const keep = (day: string) => {
    if (day >= first && day <= last) days.push(day);
  };

  if (subscription.every === 'year') {
    // A yearly renewal without a month (the schema refuses that) falls on its `since` month.
    const month = subscription.month ?? Number(subscription.since.slice(5, 7));
    for (let year = firstYear; year <= lastYear; year++) {
      keep(clampedDay(year, month, subscription.day));
    }
    return days;
  }

  for (
    let index = firstYear * 12 + firstMonth - 1;
    index <= lastYear * 12 + lastMonth - 1;
    index++
  ) {
    keep(clampedDay(Math.floor(index / 12), (index % 12) + 1, subscription.day));
  }
  return days;
}

const byDate = (a: { date: string }, b: { date: string }) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

/**
 * One charge per renewal of every subscription from `fromDate` to `toDate`, both included, oldest
 * first. Nothing before a subscription's `since` or after its `until`; a renewal on day 31 in a
 * shorter month is taken on that month's last day; a yearly one renews on its `month` and `day`.
 * Throws a RangeError when a date is not a calendar day written YYYY-MM-DD.
 */
export function subscriptionCharges(
  money: Pick<MoneyFile, 'subscriptions' | 'usdToIls'>,
  fromDate: string,
  toDate: string,
): MoneyChargeLine[] {
  assertCalendarDay(fromDate);
  assertCalendarDay(toDate);

  const lines: MoneyChargeLine[] = [];
  for (const subscription of money.subscriptions) {
    for (const date of renewalDays(subscription, fromDate, toDate)) {
      lines.push({
        date,
        item: subscription.name,
        what: subscription.every === 'year' ? 'Yearly subscription' : 'Monthly subscription',
        amount: subscription.amount,
        currency: subscription.currency,
        ils: toIls(subscription.amount, subscription.currency, money),
        subscriptionId: subscription.id,
      });
    }
  }
  return lines.sort(byDate);
}

/**
 * Every payment from `from` to `to`, both included, oldest first: the subscriptions' renewals and
 * the `charges` entries dated in that range. On the same day a renewal comes before an entry.
 */
export function chargesBetween(
  money: Pick<MoneyFile, 'subscriptions' | 'charges' | 'usdToIls'>,
  from: string,
  to: string,
): MoneyChargeLine[] {
  const renewals = subscriptionCharges(money, from, to);
  const entries = money.charges
    .filter((charge) => charge.date >= from && charge.date <= to)
    .map(
      (charge): MoneyChargeLine => ({
        ...charge,
        ils: toIls(charge.amount, charge.currency, money),
      }),
    );
  return [...renewals, ...entries].sort(byDate);
}

// --- the Money page's answer -------------------------------------------------------------------

/** How many months a banner's history holds: the month shown and the seven before it. */
export const MONEY_HISTORY_MONTHS = 8;

/**
 * One payment as the Money page lists it. `amountLabel` is what was paid in the currency it was
 * paid in ("$200.00", "₪7.50") and `ils` is the same in shekels (a number, to the agora: the page
 * does the rounding for display). `job` is the job's `Client/Job` path for a payment made for one
 * video, otherwise null; a subscription's renewal reads "Monthly plan" or "Yearly plan".
 */
export const moneyExpenseChargeSchema = z.object({
  date: calendarDaySchema,
  item: z.string().min(1),
  what: z.string().min(1),
  amountLabel: z.string().min(1),
  ils: z.number(),
  job: z.string().min(1).nullable(),
  /**
   * Set (true) on a job's share of a plan that is already paid for (ElevenLabs credits): the job's
   * expenses count it, the month's do not, because the plan's renewal is in the month. Left out
   * for every other payment.
   */
  included: z.boolean().optional(),
});
export type MoneyExpenseCharge = z.infer<typeof moneyExpenseChargeSchema>;

/**
 * One of the three banners. `history` holds `MONEY_HISTORY_MONTHS` values, oldest first, the last
 * of them the month shown (so it equals `value`) and the one before it the previous month (so it
 * equals `previous`). Shekels, to the agora.
 */
export const moneyBannerSchema = z.object({
  value: z.number(),
  previous: z.number(),
  history: z.array(z.number()).length(MONEY_HISTORY_MONTHS),
});
export type MoneyBanner = z.infer<typeof moneyBannerSchema>;

/**
 * What of the month's income has not come in yet: the jobs of the month's ledger whose `paidOn`
 * is `null`. `value` is their income in shekels, to the agora; `count` is how many jobs.
 */
export const moneyUnpaidSchema = z.object({
  value: z.number(),
  count: z.number().int().nonnegative(),
});
export type MoneyUnpaid = z.infer<typeof moneyUnpaidSchema>;

/** The Income banner: a banner, and how much of it is not paid yet. */
export const moneyIncomeBannerSchema = moneyBannerSchema.extend({ unpaid: moneyUnpaidSchema });
export type MoneyIncomeBanner = z.infer<typeof moneyIncomeBannerSchema>;

/**
 * A job of the month: one delivered in it, or one not delivered yet that was added in it (it costs
 * money before it earns any; income 0). `deliveredAt` is an ISO timestamp and `paidOn` the calendar day
 * the money came in (`null` while unpaid); `income` is the price frozen at delivery; `expenses` is what the money file's `charges` name this job in (whatever their date),
 * itemised in `charges`; `profit` is income minus expenses. `reviewSec` is the time the owner spent
 * reviewing the job.
 */
export const moneyLedgerEntrySchema = z.object({
  jobId: z.string().min(1),
  name: z.string().min(1),
  client: z.string().min(1),
  clientId: z.string().min(1),
  /** When the owner marked the job delivered; `null` for a job that is not delivered (yet), which still costs money. */
  deliveredAt: z.iso.datetime().nullable(),
  /**
   * The moment the row is listed under (the month it belongs to and where it sorts): the delivery,
   * or for a job not delivered yet the moment it was added. It moves to the delivery when it comes.
   */
  listedAt: z.iso.datetime(),
  paidOn: calendarDaySchema.nullable(),
  /**
   * The job is archived. Archived means paid already or not needed (the owner, CVP-202), so an archived
   * job that has no `paidOn` is not counted as "not paid yet" (CVP-210). It still counts as income.
   */
  archived: z.boolean(),
  income: z.number(),
  expenses: z.number(),
  profit: z.number(),
  reviewSec: z.number().int().nonnegative(),
  charges: z.array(moneyExpenseChargeSchema),
});
export type MoneyLedgerEntry = z.infer<typeof moneyLedgerEntrySchema>;

/** A subscription that was charged in the month, and what that was in shekels. */
export const moneySubscriptionLineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ils: z.number(),
});
export type MoneySubscriptionLine = z.infer<typeof moneySubscriptionLineSchema>;

export const MONEY_EXPENSE_KINDS = ['Subscription', 'Per use'] as const;

/**
 * Something the owner pays for: a subscription, or the `charges` that share an item name ("Per use").
 * `billing` says how it is paid ("Monthly · renews Nov 12", "₪7.50 per clip", or "Per use" when
 * the uses cost different amounts); `amountLabel` is the price of the plan ("$200.00") or how much
 * was used ("8 clips"); `ils` is the month's total; `charges` are the month's payments; `notes`
 * are lines of small print (none yet).
 */
export const moneyExpenseItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(MONEY_EXPENSE_KINDS),
  billing: z.string().min(1),
  amountLabel: z.string().min(1),
  ils: z.number(),
  charges: z.array(moneyExpenseChargeSchema),
  notes: z.array(z.string()),
});
export type MoneyExpenseItem = z.infer<typeof moneyExpenseItemSchema>;

/** Everything paid in the month. `total` is the Expenses banner; `usdToIls` is the rate used. */
export const moneyExpensesSchema = z.object({
  items: z.array(moneyExpenseItemSchema),
  charges: z.array(moneyExpenseChargeSchema),
  total: z.number(),
  usdToIls: z.number().positive(),
});
export type MoneyExpenses = z.infer<typeof moneyExpensesSchema>;

/**
 * How money.json is doing, as the Money page tells it:
 * - `ok`: the file is valid, or there is none (the defaults are then right);
 * - `last-good`: the file has a mistake, so the last good numbers are used;
 * - `defaults`: the file has a mistake and no good version was ever saved, so the numbers are only
 *   the defaults and Mark delivered is refused.
 */
export const MONEY_FILE_STATUSES = ['ok', 'last-good', 'defaults'] as const;
export const moneyFileStatusSchema = z.enum(MONEY_FILE_STATUSES);
export type MoneyFileStatus = z.infer<typeof moneyFileStatusSchema>;

/**
 * The state of money.json: its `status`, and, when that is not `ok`, the first problem in the file
 * as one short line ("charges[2].date: must be a date written YYYY-MM-DD"). `issue` is `null`
 * while the file is fine.
 */
export const moneyFileStateSchema = z.object({
  status: moneyFileStatusSchema,
  issue: z.string().min(1).nullable(),
});
export type MoneyFileState = z.infer<typeof moneyFileStateSchema>;

/** A money.json that is fine: no warning to show. */
export const MONEY_FILE_OK: MoneyFileState = { status: 'ok', issue: null };

/**
 * `GET /api/money?month=YYYY-MM`: everything the Money page shows for one month. `months` has
 * every month with a delivery or a charge, and this month, newest first. `moneyFile` says whether
 * money.json has a mistake, which is the same for every month.
 */
export const moneyResponseSchema = z.object({
  month: monthSchema,
  months: z.array(monthSchema),
  banners: z.object({
    income: moneyIncomeBannerSchema,
    expenses: moneyBannerSchema,
    profit: moneyBannerSchema,
  }),
  /** The month's jobs, newest delivery first. */
  ledger: z.array(moneyLedgerEntrySchema),
  /** The subscriptions charged in the month, in the order of the money file. */
  subscriptions: z.array(moneySubscriptionLineSchema),
  expenses: moneyExpensesSchema,
  moneyFile: moneyFileStateSchema,
});
export type MoneyResponse = z.infer<typeof moneyResponseSchema>;

/**
 * `GET /api/money/price?client=<name>`: what Mark delivered would charge `client` now (the price
 * the delivery would be recorded with) and the month (YYYY-MM) it would count in. The phone asks
 * it for "Sent it to <client>?" before the job is delivered, when the job has no price of its own.
 */
export const moneyPriceResponseSchema = z.object({
  client: z.string().min(1),
  price: z.number().nonnegative(),
  currency: z.string().min(1),
  month: monthSchema,
});
export type MoneyPriceResponse = z.infer<typeof moneyPriceResponseSchema>;
