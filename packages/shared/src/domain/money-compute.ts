import { homeCurrencySymbol } from '../home-currency.ts';
import { paidAmountOf } from './job.ts';
import {
  addMonths,
  chargesBetween,
  daysInMonth,
  isMonth,
  localMonthOf,
  MONEY_FILE_OK,
  MONEY_HISTORY_MONTHS,
  type MoneyBanner,
  type MoneyChargeLine,
  type MoneyCurrency,
  type MoneyExpenseCharge,
  type MoneyExpenseItem,
  type MoneyFile,
  type MoneyFileState,
  type MoneyIncomeBanner,
  type MoneyLedgerEntry,
  type MoneyResponse,
  type MoneyServiceCharge,
  type MoneySubscription,
  type MoneySubscriptionLine,
  monthRange,
  roundIls,
  subscriptionCharges,
  toIls,
} from './money.ts';

// The Money page's numbers (Phase 4 plan, §3 and §4), worked out from the delivered jobs and the
// money file as pure functions: the same input always gives the same answer, in any time zone of
// the machine, because the time zone is an input. The server's route (routes/money.ts) only reads
// the two and hands them here.

/** A delivered job, as `computeMoney` reads it. The server's stored `Delivery` fits it exactly. */
export interface MoneyDelivery {
  jobId: string;
  clientId: string;
  client: string;
  name: string;
  /** `Client/Job`: how a charge in the money file names the job. */
  relPath: string;
  /** When the owner marked the job delivered: milliseconds since the epoch. */
  deliveredAt: number;
  /** What the client paid for the job, frozen when it was delivered. */
  price: number;
  /** `ILS`, or `USD` (converted at the money file's rate). Anything else is read as shekels. */
  currency: string;
  /** Seconds the owner spent reviewing the job. */
  reviewSec: number;
  /** The calendar day the money came in (YYYY-MM-DD); `null` while the job is not paid. */
  paidOn: string | null;
  /**
   * What the client actually paid, in `currency`, once it is paid; `null` (or left out) while it is
   * not, and on a job paid before it could be typed. Income is this when it is set, else `price`.
   */
  paidAmount?: number | null;
}

/**
 * A job that has no delivery. It already costs money (the services, a stock clip), so the ledger
 * lists it in the month it was added, with no income yet. The server sends every job that is not
 * delivered; a job with a delivery is a `MoneyDelivery` instead.
 */
export interface MoneyUndeliveredJob {
  jobId: string;
  clientId: string;
  client: string;
  name: string;
  /** `Client/Job`: how a charge in the money file names the job. */
  relPath: string;
  /** When the job was added: milliseconds since the epoch. */
  addedAt: number;
}

export interface ComputeMoneyInput {
  /** Every delivery, in any order. The ones outside the eight months shown only fill `months`. */
  deliveries: readonly MoneyDelivery[];
  /** The jobs without a delivery, listed in the month they were added. Default: none. */
  undelivered?: readonly MoneyUndeliveredJob[];
  money: Pick<MoneyFile, 'usdToIls' | 'subscriptions' | 'charges'>;
  /** The month to work out, YYYY-MM. */
  month: string;
  /** IANA time zone whose calendar decides what month a delivery falls in (the machine's). */
  timeZone: string;
  /** The current moment in milliseconds, for "this month". Default: the clock. */
  now?: number;
  /**
   * The ids of the jobs that are archived now. An archived job's delivery still counts as income,
   * but not as "not paid yet": archived means paid already or not needed. Default: none.
   */
  archivedJobIds?: ReadonlySet<string>;
  /** How the money file is doing (the server's loader knows); carried into the answer as it is. Default: fine. */
  moneyFile?: MoneyFileState;
  /**
   * What the services cost, worked out from what the engine recorded (Higgsfield's dollars,
   * ElevenLabs' credits, Apify's Instagram scans: service-charges.ts). One that names a job is
   * that job's expense like a `charges` entry that names the job; one without a job (a client's
   * scan) is a payment of the month only, like a `charges` entry without one. The month counts
   * them too, except the ones a plan already paid for (`includedIn`): those would be counted
   * twice next to the plan's renewal. Default: none.
   */
  serviceCharges?: readonly MoneyServiceCharge[];
}

// --- labels ------------------------------------------------------------------------------------

const MONTH_NAMES = [
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
];

const CURRENCY_SYMBOLS: Record<MoneyCurrency, string> = {
  get ILS() {
    return homeCurrencySymbol();
  },
  USD: '$',
};

const amountFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$200.00", "₪7.50", "₪1,250.00": an amount in the currency it was paid in. */
function amountLabel(amount: number, currency: MoneyCurrency): string {
  return `${CURRENCY_SYMBOLS[currency]}${amountFormat.format(amount)}`;
}

/** "Nov 12", or "Nov 12, 2027" when the year matters. */
function dayLabel(day: string, withYear: boolean): string {
  const [year = '', month = '1', date = '1'] = day.split('-');
  const label = `${MONTH_NAMES[Number(month) - 1] ?? ''} ${Number(date)}`;
  return withYear ? `${label}, ${year}` : label;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** The day a renewal on `day` takes place in a month: a short month takes its last day. */
function renewalIn(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(Math.min(day, daysInMonth(year, month)), 2)}`;
}

/**
 * How a subscription is paid, from its charge on `chargeDate`: "Monthly · renews Nov 12", "Yearly
 * · renews Mar 5, 2027", or "Monthly · last charge Oct 12" when its `until` comes before the next
 * renewal.
 */
function subscriptionBilling(subscription: MoneySubscription, chargeDate: string): string {
  const [year = 0, month = 1] = chargeDate.split('-').map(Number);
  const yearly = subscription.every === 'year';
  const nextYear = yearly || month === 12 ? year + 1 : year;
  const nextMonth = yearly ? month : (month % 12) + 1;
  const next = renewalIn(nextYear, nextMonth, subscription.day);
  const name = yearly ? 'Yearly' : 'Monthly';
  if (subscription.until !== undefined && next > subscription.until) {
    return `${name} · last charge ${dayLabel(chargeDate, yearly)}`;
  }
  return `${name} · renews ${dayLabel(next, yearly)}`;
}

/**
 * What one use of an item buys, as a word: "clip" for an item whose charges read "Clip licence
 * #4831", "Clip licence #4838", and so on. It needs at least two charges that read the same once
 * the trailing number is taken off, so a one-off purchase ("Sony 50mm lens") never gets a noun
 * made of its first word. A charge that reads "<kind> · <who>" ("Instagram scan · Falcon FPV") is
 * taken by its kind alone, so the uses of different people still agree, and the noun is the kind's
 * last word ("scan"). It is given every charge of the item, not only this month's, so the word
 * does not change from one month to the next. Otherwise "use".
 */
function useNoun(charges: readonly { what: string }[]): string {
  const [first] = charges;
  if (first === undefined || charges.length < 2) return 'use';
  const stem = (what: string) =>
    (what.split(' · ')[0] ?? what)
      .replace(/\s*#?\d[\w-]*\s*$/, '')
      .trim()
      .toLowerCase();
  const wanted = stem(first.what);
  if (!charges.every((charge) => stem(charge.what) === wanted)) return 'use';
  // Plain letters only: a Hebrew word does not take an English "s".
  const noun = first.what.includes(' · ')
    ? /([a-z]+(?:['-][a-z]+)*)$/.exec(wanted)?.[1]
    : /^[a-z]+(?:['-][a-z]+)*/.exec(wanted)?.[0];
  return noun ?? 'use';
}

function plural(noun: string, count: number): string {
  if (count === 1) return noun;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

// --- the sums ----------------------------------------------------------------------------------

const sum = <T>(list: readonly T[], value: (item: T) => number): number =>
  roundIls(list.reduce((total, item) => total + value(item), 0));

/** Oldest first; a renewal stays before an entry of the same day. */
const byDate = (a: { date: string }, b: { date: string }): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

/** `Client/Job` as the file spells it and as the folder spells it can differ in Unicode form. */
const jobKey = (relPath: string): string => relPath.normalize('NFC');

/**
 * Works out one month of the Money page.
 *
 * - A job belongs to the month of its `deliveredAt` on the calendar of `timeZone`; being paid
 *   later moves nothing (its ledger row only carries `paidOn`).
 * - Income is the sum of what those jobs earned: what was paid for a paid one (`paidAmount`, which
 *   can be less than its price, or 0), the price it was delivered at otherwise; a job's expenses are the money file's `charges` that
 *   name its `relPath` (whatever their date); its profit is the difference.
 * - The Expenses banner is every payment dated in the month: the subscriptions' renewals and the
 *   `charges` entries, jobs' or not. Profit is income minus that.
 * - Each banner carries the previous month and the eight months up to the one shown. A month
 *   before the data begins is 0.
 * - The Income banner also says how much of the month's ledger is not paid yet (`unpaid`): the
 *   jobs whose `paidOn` is `null`, their count and their income. An archived job is left out of
 *   it (archived means paid already or not needed), though it stays in the ledger and the income.
 * - Anything that cost 0 is not listed (not as a charge, not as an item), but still counts as 0.
 * - Shekels are numbers to the agora: $22 at 3.7 is 81.4, and the page rounds it for display.
 */
export function computeMoney(input: ComputeMoneyInput): MoneyResponse {
  const {
    deliveries,
    undelivered = [],
    money,
    month,
    timeZone,
    now = Date.now(),
    archivedJobIds,
    moneyFile = MONEY_FILE_OK,
    serviceCharges = [],
  } = input;
  if (!isMonth(month))
    throw new RangeError(`Not a month written YYYY-MM: ${JSON.stringify(month)}`);

  const subscriptionById = new Map(money.subscriptions.map((s) => [s.id, s]));

  // What the month counts as paid: money.json's charges, and the services' that no plan paid for.
  const counted: typeof money = {
    ...money,
    charges: [
      ...money.charges,
      ...serviceCharges.filter((charge) => charge.includedIn === undefined),
    ],
  };

  // Deliveries by the month they fall in, and what each is worth in shekels.
  const deliveriesByMonth = new Map<string, MoneyDelivery[]>();
  for (const delivery of deliveries) {
    const key = localMonthOf(delivery.deliveredAt, timeZone);
    const list = deliveriesByMonth.get(key);
    if (list === undefined) deliveriesByMonth.set(key, [delivery]);
    else list.push(delivery);
  }
  // The jobs not delivered yet, by the month they were added in.
  const undeliveredByMonth = new Map<string, MoneyUndeliveredJob[]>();
  for (const job of undelivered) {
    const key = localMonthOf(job.addedAt, timeZone);
    const list = undeliveredByMonth.get(key);
    if (list === undefined) undeliveredByMonth.set(key, [job]);
    else list.push(job);
  }
  const incomeOf = (delivery: MoneyDelivery): number =>
    toIls(paidAmountOf(delivery), delivery.currency === 'USD' ? 'USD' : 'ILS', money);

  const linesIn = (m: string): MoneyChargeLine[] => {
    const { first, last } = monthRange(m);
    return chargesBetween(counted, first, last);
  };

  // --- banners ---
  const trail = Array.from({ length: MONEY_HISTORY_MONTHS }, (_, index) =>
    addMonths(month, index - (MONEY_HISTORY_MONTHS - 1)),
  ).map((m) => {
    const income = sum(deliveriesByMonth.get(m) ?? [], incomeOf);
    const expenses = sum(linesIn(m), (line) => line.ils);
    return { income, expenses, profit: roundIls(income - expenses) };
  });
  const banner = (kind: 'income' | 'expenses' | 'profit'): MoneyBanner => {
    const history = trail.map((totals) => totals[kind]);
    return { value: history[history.length - 1] ?? 0, previous: history.at(-2) ?? 0, history };
  };

  // --- how a payment reads ---
  const describe = (line: MoneyChargeLine): MoneyExpenseCharge => {
    const subscription =
      line.subscriptionId === undefined ? undefined : subscriptionById.get(line.subscriptionId);
    return {
      date: line.date,
      item: line.item,
      what:
        subscription === undefined
          ? line.what
          : subscription.every === 'year'
            ? 'Yearly plan'
            : 'Monthly plan',
      amountLabel: amountLabel(line.amount, line.currency),
      ils: line.ils,
      job: line.job ?? null,
      ...(line.includedIn === undefined ? {} : { included: true }),
    };
  };

  // --- the ledger ---
  const jobLines = new Map<string, MoneyChargeLine[]>();
  for (const charge of [...money.charges, ...serviceCharges]) {
    if (charge.job === undefined) continue;
    const line = { ...charge, ils: toIls(charge.amount, charge.currency, money) };
    const key = jobKey(charge.job);
    const list = jobLines.get(key);
    if (list === undefined) jobLines.set(key, [line]);
    else list.push(line);
  }
  const entryOf = (
    job: Pick<MoneyDelivery, 'jobId' | 'clientId' | 'client' | 'name' | 'relPath'>,
    listedAt: number,
    delivery: MoneyDelivery | null,
  ): MoneyLedgerEntry => {
    const lines = (jobLines.get(jobKey(job.relPath)) ?? [])
      .filter((line) => line.ils > 0)
      .sort(byDate);
    const income = delivery === null ? 0 : incomeOf(delivery);
    const expenses = sum(lines, (line) => line.ils);
    return {
      jobId: job.jobId,
      name: job.name,
      client: job.client,
      clientId: job.clientId,
      deliveredAt: delivery === null ? null : new Date(delivery.deliveredAt).toISOString(),
      listedAt: new Date(listedAt).toISOString(),
      paidOn: delivery?.paidOn ?? null,
      archived: archivedJobIds?.has(job.jobId) ?? false,
      income,
      expenses,
      profit: roundIls(income - expenses),
      reviewSec: delivery?.reviewSec ?? 0,
      charges: lines.map(describe),
    };
  };
  const ledger: MoneyLedgerEntry[] = [
    ...(deliveriesByMonth.get(month) ?? []).map((delivery) =>
      entryOf(delivery, delivery.deliveredAt, delivery),
    ),
    ...(undeliveredByMonth.get(month) ?? []).map((job) => entryOf(job, job.addedAt, null)),
  ].sort((a, b) => Date.parse(b.listedAt) - Date.parse(a.listedAt) || (a.jobId < b.jobId ? -1 : 1));

  // --- the expenses ---
  const paid = linesIn(month).filter((line) => line.ils > 0);
  const subscriptions: MoneySubscriptionLine[] = [];
  const items: MoneyExpenseItem[] = [];

  // Subscriptions come in the order of the file.
  for (const subscription of money.subscriptions) {
    const lines = paid.filter((line) => line.subscriptionId === subscription.id);
    const last = lines[lines.length - 1];
    if (last === undefined) continue;
    const ils = sum(lines, (line) => line.ils);
    const { first, last: lastDay } = monthRange(month);
    const planCredits = serviceCharges
      .filter(
        (charge) =>
          charge.includedIn === subscription.id && charge.date >= first && charge.date <= lastDay,
      )
      .reduce((total, charge) => total + (charge.credits ?? 0), 0);
    subscriptions.push({ id: subscription.id, name: subscription.name, ils });
    items.push({
      id: subscription.id,
      name: subscription.name,
      kind: 'Subscription',
      billing: subscriptionBilling(subscription, last.date),
      amountLabel: amountLabel(subscription.amount, subscription.currency),
      ils,
      charges: lines.map(describe),
      notes:
        planCredits > 0
          ? [`Videos used ${planCredits.toLocaleString('en-US')} credits of the plan this month`]
          : [],
    });
  }

  // Then one item per name of the charges, in the order they were first paid.
  const uses = new Map<string, MoneyChargeLine[]>();
  for (const line of paid) {
    if (line.subscriptionId !== undefined) continue;
    const list = uses.get(line.item);
    if (list === undefined) uses.set(line.item, [line]);
    else list.push(line);
  }
  for (const [name, lines] of uses) {
    const [first] = lines;
    if (first === undefined) continue;
    const noun = useNoun(counted.charges.filter((charge) => charge.item === name));
    const unitPrice = lines.every(
      (line) => line.amount === first.amount && line.currency === first.currency,
    );
    items.push({
      id: `use:${name}`,
      name,
      kind: 'Per use',
      billing: unitPrice ? `${amountLabel(first.amount, first.currency)} per ${noun}` : 'Per use',
      amountLabel: `${lines.length} ${plural(noun, lines.length)}`,
      ils: sum(lines, (line) => line.ils),
      charges: lines.map(describe),
      notes: [],
    });
  }

  // What of the month's income has not come in: the ledger's jobs with no `paidOn`, leaving out
  // the archived ones (paid already or not needed).
  const unpaidJobs = ledger.filter(
    (entry) => entry.deliveredAt !== null && entry.paidOn === null && !entry.archived,
  );
  const incomeBanner: MoneyIncomeBanner = {
    ...banner('income'),
    unpaid: { value: sum(unpaidJobs, (entry) => entry.income), count: unpaidJobs.length },
  };

  return {
    month,
    months: monthsWithData({
      deliveriesByMonth,
      undeliveredByMonth,
      money: counted,
      thisMonth: localMonthOf(now, timeZone),
    }),
    banners: { income: incomeBanner, expenses: banner('expenses'), profit: banner('profit') },
    ledger,
    subscriptions,
    expenses: {
      items,
      charges: paid.map(describe),
      total: sum(paid, (line) => line.ils),
      usdToIls: money.usdToIls,
    },
    moneyFile,
  };
}

/**
 * Every month that has a delivery or a payment, and `thisMonth`, newest first. A subscription
 * pays in every month from its first day up to this month; the `charges` entries count wherever
 * they are dated.
 */
function monthsWithData({
  deliveriesByMonth,
  undeliveredByMonth,
  money,
  thisMonth,
}: {
  deliveriesByMonth: ReadonlyMap<string, unknown>;
  undeliveredByMonth: ReadonlyMap<string, unknown>;
  money: Pick<MoneyFile, 'usdToIls' | 'subscriptions' | 'charges'>;
  thisMonth: string;
}): string[] {
  const months = new Set<string>([
    thisMonth,
    ...deliveriesByMonth.keys(),
    ...undeliveredByMonth.keys(),
  ]);
  for (const charge of money.charges) months.add(charge.date.slice(0, 7));
  if (money.subscriptions.length > 0) {
    const earliest = money.subscriptions.reduce(
      (first, subscription) => (subscription.since < first ? subscription.since : first),
      money.subscriptions[0]?.since ?? '',
    );
    for (const line of subscriptionCharges(money, earliest, monthRange(thisMonth).last)) {
      months.add(line.date.slice(0, 7));
    }
  }
  return [...months].sort().reverse();
}
