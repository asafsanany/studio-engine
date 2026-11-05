import { describe, expect, it } from 'vitest';
import {
  localMonthOf,
  MONEY_HISTORY_MONTHS,
  type MoneyFile,
  type MoneyResponse,
  moneyFileSchema,
  moneyResponseSchema,
} from './money.ts';
import { computeMoney, type MoneyDelivery } from './money-compute.ts';

// The board of the Money page (canvas "Design", Phase 4, P4Money) is the fixture: in October 2026
// 26 jobs at ₪200 (four of them with two stock clips at ₪7.50), a $200 Claude plan, a $22
// ElevenLabs plan, a ₪49 music library and ₪30 of fonts, at 3.7 shekels to the dollar. The board
// shows ₪81 for ElevenLabs; the engine keeps the 81.4 it is and the page rounds it, so the
// expenses are 960.4 (₪960 on the page) and the profit 4,239.6 (₪4,240).

const ZONE = 'Asia/Jerusalem';
/** The 21st of October 2026, 09:00 in Israel. */
const NOW = Date.parse('2026-10-21T09:00:00+03:00');

function money(input: unknown = {}): MoneyFile {
  return moneyFileSchema.parse(input);
}

let counter = 0;

function delivery(overrides: Partial<MoneyDelivery> & { at?: string } = {}): MoneyDelivery {
  counter += 1;
  const { at = '2026-10-05T12:00:00+03:00', ...rest } = overrides;
  const name = rest.name ?? `Job ${counter}`;
  const client = rest.client ?? 'Kova Coffee';
  return {
    jobId: `job${String(counter).padStart(4, '0')}`,
    clientId: `client-${client}`,
    client,
    name,
    relPath: `${client}/${name}`,
    deliveredAt: Date.parse(at),
    price: 200,
    currency: 'ILS',
    reviewSec: 0,
    paidOn: null,
    ...rest,
  };
}

const CLIENTS: [client: string, names: string[]][] = [
  [
    'Kova Coffee',
    [
      'Barista reel',
      'Autumn menu',
      'Latte art tips',
      'New branch opening',
      'Cold brew launch',
      'Weekend specials',
      'Meet the roaster',
      'Pastry of the week',
    ],
  ],
  [
    'Arc Fitness',
    ['Class highlights', 'Coach intro', 'Member story', 'Spring challenge', 'Morning HIIT'],
  ],
  ['Lumen Yoga', ['Morning flow', 'Retreat teaser', 'Studio tour', 'Breathwork basics']],
  ['Noa Ceramics', ['Wheel session', 'Glazing day', 'Shop launch']],
  ['מאפיית הצפון', ['חלות לשבת', 'סיור במאפייה', 'מבצע חגים']],
  ['מרפאת מירה', ['ראיון עם ד״ר מירה', 'טיפים לחורף']],
  ['טל נכסים', ['סיור בנכס']],
];

/** The 26 jobs of October, delivered on the 1st to the 21st, 10:00 to 17:00. */
function octoberJobs(): MoneyDelivery[] {
  let index = 0;
  return CLIENTS.flatMap(([client, names]) =>
    names.map((name) => {
      index += 1;
      const day = String(1 + (index % 21)).padStart(2, '0');
      const hour = String(10 + (index % 8)).padStart(2, '0');
      return delivery({
        client,
        name,
        at: `2026-10-${day}T${hour}:30:00+03:00`,
        reviewSec: 360,
      });
    }),
  );
}

/** Jobs delivered in an earlier month: `count` of them, at the price they were delivered for. */
function jobsIn(month: string, count: number, overrides: Partial<MoneyDelivery> = {}) {
  return Array.from({ length: count }, (_, index) =>
    delivery({
      at: `${month}-${String(2 + index).padStart(2, '0')}T11:00:00+03:00`,
      ...overrides,
    }),
  );
}

const STOCK_JOBS = [
  'Kova Coffee/Barista reel',
  'Lumen Yoga/Retreat teaser',
  'טל נכסים/סיור בנכס',
  'Noa Ceramics/Shop launch',
];

function clipCharges(jobs: string[], month: string, firstNumber: number) {
  let number = firstNumber;
  return jobs.flatMap((job, jobIndex) =>
    [0, 1].map(() => {
      number += 7;
      return {
        date: `${month}-${String(3 + jobIndex).padStart(2, '0')}`,
        item: 'Stock footage',
        what: `Clip licence #${number}`,
        amount: 7.5,
        currency: 'ILS',
        job,
      };
    }),
  );
}

const SUBSCRIPTIONS = [
  {
    id: 'claude',
    name: 'Claude Max plan',
    amount: 200,
    currency: 'USD',
    every: 'month',
    day: 12,
    since: '2026-08-12',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs Creator plan',
    amount: 22,
    currency: 'USD',
    every: 'month',
    day: 3,
    since: '2026-08-03',
  },
  {
    id: 'music',
    name: 'Music library',
    amount: 49,
    currency: 'ILS',
    every: 'month',
    day: 8,
    since: '2026-08-08',
  },
  {
    id: 'fonts',
    name: 'Fonts',
    amount: 30,
    currency: 'ILS',
    every: 'month',
    day: 5,
    since: '2026-08-05',
  },
];

/** The board's money file, and September's five clips (₪37.50) for the previous month. */
function boardMoney(): MoneyFile {
  return money({
    usdToIls: 3.7,
    subscriptions: SUBSCRIPTIONS,
    charges: [
      ...clipCharges(STOCK_JOBS, '2026-10', 4810),
      ...Array.from({ length: 5 }, (_, index) => ({
        date: '2026-09-10',
        item: 'Stock footage',
        what: `Clip licence #${4700 + index * 7}`,
        amount: 7.5,
        currency: 'ILS',
        job: `Kova Coffee/Sept job ${index + 1}`,
      })),
    ],
  });
}

/** October's 26 jobs, September's 22, August's 10 and July's 5. */
function boardDeliveries(): MoneyDelivery[] {
  return [
    ...octoberJobs(),
    ...Array.from({ length: 22 }, (_, index) =>
      delivery({
        name: `Sept job ${index + 1}`,
        at: `2026-09-${String(1 + (index % 28)).padStart(2, '0')}T11:00:00+03:00`,
      }),
    ),
    ...jobsIn('2026-08', 10),
    ...jobsIn('2026-07', 5),
  ];
}

function compute(input: Partial<Parameters<typeof computeMoney>[0]> = {}): MoneyResponse {
  const result = computeMoney({
    deliveries: boardDeliveries(),
    money: boardMoney(),
    month: '2026-10',
    timeZone: ZONE,
    now: NOW,
    ...input,
  });
  // Whatever the case, the answer is what the route promises (this throws when it is not).
  return moneyResponseSchema.parse(result);
}

const sum = (list: number[]) => Math.round(list.reduce((a, b) => a + b, 0) * 100) / 100;

describe("computeMoney on the board's month", () => {
  const october = compute();

  it('adds up the three banners: income 5,200, expenses 960 and profit 4,240', () => {
    expect(october.banners.income.value).toBe(5200);
    // $22 at 3.7 is 81.4; the page shows whole shekels, so 960 and 4,240.
    expect(october.banners.expenses.value).toBe(960.4);
    expect(october.banners.profit.value).toBe(4239.6);
    expect(Math.round(october.banners.expenses.value)).toBe(960);
    expect(Math.round(october.banners.profit.value)).toBe(4240);
    expect(october.month).toBe('2026-10');
  });

  it('compares with the month before and keeps eight months of history, oldest first', () => {
    expect(MONEY_HISTORY_MONTHS).toBe(8);
    expect(october.banners.income).toEqual({
      value: 5200,
      previous: 4400,
      history: [0, 0, 0, 0, 1000, 2000, 4400, 5200],
      // None of the board's jobs is paid.
      unpaid: { value: 5200, count: 26 },
    });
    // Subscriptions start in August (₪900.40 a month); September has five clips on top.
    expect(october.banners.expenses).toEqual({
      value: 960.4,
      previous: 937.9,
      history: [0, 0, 0, 0, 0, 900.4, 937.9, 960.4],
    });
    expect(october.banners.profit).toEqual({
      value: 4239.6,
      previous: 3462.1,
      history: [0, 0, 0, 0, 1000, 1099.6, 3462.1, 4239.6],
    });
  });

  it('ends every history on the value and the previous month', () => {
    for (const banner of Object.values(october.banners)) {
      expect(banner.history).toHaveLength(MONEY_HISTORY_MONTHS);
      expect(banner.history.at(-1)).toBe(banner.value);
      expect(banner.history.at(-2)).toBe(banner.previous);
    }
  });

  it('lists the 26 jobs, newest delivery first, each with its income, expenses and profit', () => {
    expect(october.ledger).toHaveLength(26);
    const times = october.ledger.map((entry) => Date.parse(entry.listedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const withClips = october.ledger.filter((entry) => entry.expenses > 0);
    expect(withClips.map((entry) => `${entry.client}/${entry.name}`).sort()).toEqual(
      [...STOCK_JOBS].sort(),
    );
    for (const entry of october.ledger) {
      expect(entry.income).toBe(200);
      expect(entry.profit).toBe(entry.income - entry.expenses);
      expect(entry.reviewSec).toBe(360);
    }
    for (const entry of withClips) {
      expect(entry.expenses).toBe(15);
      expect(entry.profit).toBe(185);
      expect(entry.charges).toHaveLength(2);
    }
  });

  it('gives the summary rows: jobs 5,200 / 60 / 5,140, subscriptions 900, profit 4,240', () => {
    const jobsIncome = sum(october.ledger.map((entry) => entry.income));
    const jobsExpenses = sum(october.ledger.map((entry) => entry.expenses));
    const jobsProfit = sum(october.ledger.map((entry) => entry.profit));
    expect([jobsIncome, jobsExpenses, jobsProfit]).toEqual([5200, 60, 5140]);

    const subscriptions = sum(october.subscriptions.map((line) => line.ils));
    expect(subscriptions).toBe(900.4);
    expect(Math.round(subscriptions)).toBe(900);
    // "Profit this month" is the Profit banner.
    expect(sum([jobsProfit, -subscriptions])).toBe(october.banners.profit.value);
    expect(sum([jobsExpenses, subscriptions])).toBe(october.banners.expenses.value);
  });

  it('names the subscriptions charged this month, in the order of the file', () => {
    expect(october.subscriptions).toEqual([
      { id: 'claude', name: 'Claude Max plan', ils: 740 },
      { id: 'elevenlabs', name: 'ElevenLabs Creator plan', ils: 81.4 },
      { id: 'music', name: 'Music library', ils: 49 },
      { id: 'fonts', name: 'Fonts', ils: 30 },
    ]);
  });

  it("itemises a job's clips as charges with the date, the item and what they were for", () => {
    const teaser = october.ledger.find((entry) => entry.name === 'Retreat teaser');
    expect(teaser?.jobId).toMatch(/^job/);
    expect(teaser?.clientId).toBe('client-Lumen Yoga');
    expect(teaser?.charges).toEqual([
      {
        date: '2026-10-04',
        item: 'Stock footage',
        what: expect.stringMatching(/^Clip licence #48\d\d$/),
        amountLabel: '₪7.50',
        ils: 7.5,
        job: 'Lumen Yoga/Retreat teaser',
      },
      {
        date: '2026-10-04',
        item: 'Stock footage',
        what: expect.stringMatching(/^Clip licence #48\d\d$/),
        amountLabel: '₪7.50',
        ils: 7.5,
        job: 'Lumen Yoga/Retreat teaser',
      },
    ]);
    expect(teaser?.deliveredAt).toMatch(/^2026-10-\d\dT\d\d:30:00\.000Z$/);
  });

  it('lists the expenses as five items: four subscriptions and the stock footage', () => {
    const { items } = october.expenses;
    expect(
      items.map((item) => [item.id, item.kind, item.billing, item.amountLabel, item.ils]),
    ).toEqual([
      ['claude', 'Subscription', 'Monthly · renews Nov 12', '$200.00', 740],
      ['elevenlabs', 'Subscription', 'Monthly · renews Nov 3', '$22.00', 81.4],
      ['music', 'Subscription', 'Monthly · renews Nov 8', '₪49.00', 49],
      ['fonts', 'Subscription', 'Monthly · renews Nov 5', '₪30.00', 30],
      ['use:Stock footage', 'Per use', '₪7.50 per clip', '8 clips', 60],
    ]);
    expect(items.map((item) => item.name)).toEqual([
      'Claude Max plan',
      'ElevenLabs Creator plan',
      'Music library',
      'Fonts',
      'Stock footage',
    ]);
    expect(items[0]?.charges).toEqual([
      {
        date: '2026-10-12',
        item: 'Claude Max plan',
        what: 'Monthly plan',
        amountLabel: '$200.00',
        ils: 740,
        job: null,
      },
    ]);
    expect(items[4]?.charges).toHaveLength(8);
    expect(items.every((item) => item.notes.length === 0)).toBe(true);
  });

  it('totals the expenses to the Expenses banner, as items and as charges', () => {
    const { expenses } = october;
    expect(expenses.total).toBe(october.banners.expenses.value);
    expect(sum(expenses.items.map((item) => item.ils))).toBe(expenses.total);
    expect(sum(expenses.charges.map((charge) => charge.ils))).toBe(expenses.total);
    expect(expenses.usdToIls).toBe(3.7);
  });

  it('lists every charge of the month by date, with the job of a clip', () => {
    const { charges } = october.expenses;
    expect(charges).toHaveLength(12);
    const dates = charges.map((charge) => charge.date);
    expect(dates).toEqual([...dates].sort());
    // On the 3rd the plan renews and the first clips are bought; a renewal comes first.
    expect(charges[0]).toMatchObject({ date: '2026-10-03', item: 'ElevenLabs Creator plan' });
    expect(charges[1]).toMatchObject({ date: '2026-10-03', item: 'Stock footage' });
    expect(charges.find((charge) => charge.item === 'ElevenLabs Creator plan')).toEqual({
      date: '2026-10-03',
      item: 'ElevenLabs Creator plan',
      what: 'Monthly plan',
      amountLabel: '$22.00',
      ils: 81.4,
      job: null,
    });
    expect(charges.filter((charge) => charge.job !== null)).toHaveLength(8);
  });

  it('lists every month that has a delivery or a charge, and this month, newest first', () => {
    expect(october.months).toEqual(['2026-10', '2026-09', '2026-08', '2026-07']);
  });

  it('answers September from the same data: its jobs, its clips and its previous month', () => {
    const september = compute({ month: '2026-09' });
    expect(september.ledger).toHaveLength(22);
    expect(september.banners.income).toMatchObject({ value: 4400, previous: 2000 });
    expect(september.banners.expenses.value).toBe(937.9);
    expect(september.expenses.items.map((item) => item.id)).toContain('use:Stock footage');
    expect(september.months).toEqual(october.months);
  });

  it('does not change what it is given', () => {
    const deliveries = boardDeliveries();
    const file = boardMoney();
    const before = JSON.stringify([deliveries, file]);
    compute({ deliveries, money: file });
    expect(JSON.stringify([deliveries, file])).toBe(before);
  });
});

describe('an empty month', () => {
  it('has no jobs, no expenses and a banner of zeros', () => {
    const march = compute({ month: '2026-03' });
    expect(march.ledger).toEqual([]);
    expect(march.subscriptions).toEqual([]);
    expect(march.expenses).toEqual({ items: [], charges: [], total: 0, usdToIls: 3.7 });
    for (const banner of Object.values(march.banners)) {
      expect(banner).toMatchObject({ value: 0, previous: 0, history: Array(8).fill(0) });
    }
    // Nothing delivered, so nothing is owed.
    expect(march.banners.income.unpaid).toEqual({ value: 0, count: 0 });
  });

  it('still lists the months that have something, not the empty one it was asked for', () => {
    expect(compute({ month: '2026-03' }).months).toEqual([
      '2026-10',
      '2026-09',
      '2026-08',
      '2026-07',
    ]);
  });

  it('is all there is with no deliveries and no money file: this month, with the default rate', () => {
    const nothing = compute({ deliveries: [], money: money() });
    expect(nothing.months).toEqual(['2026-10']);
    expect(nothing.ledger).toEqual([]);
    expect(nothing.banners.profit.value).toBe(0);
    expect(nothing.expenses.usdToIls).toBe(3.7);
  });

  it('reads a month that has not come yet from the months around it', () => {
    const november = compute({ month: '2026-11' });
    expect(november.ledger).toEqual([]);
    // The subscriptions renew in November too, whether or not it has come yet.
    expect(november.banners.expenses.value).toBe(900.4);
    expect(november.banners.expenses.previous).toBe(960.4);
    expect(november.banners.income.history).toEqual([0, 0, 0, 1000, 2000, 4400, 5200, 0]);
  });
});

describe('subscriptions', () => {
  const domain = {
    id: 'domain',
    name: 'Domain',
    amount: 120,
    currency: 'ILS',
    every: 'year',
    month: 3,
    day: 5,
    since: '2025-03-05',
  };

  it('charges a yearly subscription only in the month it renews', () => {
    const file = money({ subscriptions: [domain] });

    const march = compute({ deliveries: [], money: file, month: '2026-03' });
    expect(march.expenses.items).toEqual([
      {
        id: 'domain',
        name: 'Domain',
        kind: 'Subscription',
        billing: 'Yearly · renews Mar 5, 2027',
        amountLabel: '₪120.00',
        ils: 120,
        charges: [
          {
            date: '2026-03-05',
            item: 'Domain',
            what: 'Yearly plan',
            amountLabel: '₪120.00',
            ils: 120,
            job: null,
          },
        ],
        notes: [],
      },
    ]);
    expect(march.subscriptions).toEqual([{ id: 'domain', name: 'Domain', ils: 120 }]);
    expect(march.banners.expenses).toMatchObject({ value: 120, previous: 0 });

    const april = compute({ deliveries: [], money: file, month: '2026-04' });
    expect(april.expenses.items).toEqual([]);
    expect(april.subscriptions).toEqual([]);
    expect(april.banners.expenses).toMatchObject({ value: 0, previous: 120 });
  });

  it('lists the months it renewed in, up to this month, and no later one', () => {
    const file = money({ subscriptions: [domain] });
    const { months } = compute({ deliveries: [], money: file });
    expect(months).toEqual(['2026-10', '2026-03', '2025-03']);
  });

  it('does not list months before it began or after it ended', () => {
    const file = money({
      subscriptions: [{ ...SUBSCRIPTIONS[3], since: '2026-08-05', until: '2026-09-30' }],
    });
    const { months } = compute({ deliveries: [], money: file });
    expect(months).toEqual(['2026-10', '2026-09', '2026-08']);
    // Ended: nothing in October, and in September the last charge says so.
    const september = compute({ deliveries: [], money: file, month: '2026-09' });
    expect(september.expenses.items[0]?.billing).toBe('Monthly · last charge Sep 5');
    expect(compute({ deliveries: [], money: file }).expenses.items).toEqual([]);
  });

  it('says when a short month moves the renewal', () => {
    const file = money({
      subscriptions: [
        { ...SUBSCRIPTIONS[3], id: 'late', name: 'Late', day: 31, since: '2026-01-31' },
      ],
    });
    const january = compute({ deliveries: [], money: file, month: '2026-01' });
    expect(january.expenses.items[0]?.billing).toBe('Monthly · renews Feb 28');
    const february = compute({
      deliveries: [],
      money: file,
      month: '2026-02',
      now: Date.parse('2026-02-10T10:00:00+02:00'),
    });
    expect(february.expenses.charges[0]?.date).toBe('2026-02-28');
    expect(february.expenses.items[0]?.billing).toBe('Monthly · renews Mar 31');
    expect(february.months).toEqual(['2026-02', '2026-01']);
  });

  it('rolls a December renewal into January of the next year', () => {
    const file = money({
      subscriptions: [{ ...SUBSCRIPTIONS[3], since: '2025-01-05' }],
    });
    const december = compute({ deliveries: [], money: file, month: '2025-12' });
    expect(december.expenses.items[0]?.billing).toBe('Monthly · renews Jan 5');
  });

  it('converts dollars at the rate of the file, to the agora', () => {
    const file = money({ usdToIls: 3.65, subscriptions: [SUBSCRIPTIONS[1]] });
    const { expenses } = compute({ deliveries: [], money: file });
    expect(expenses.items[0]).toMatchObject({ amountLabel: '$22.00', ils: 80.3 });
    expect(expenses.usdToIls).toBe(3.65);
  });
});

describe('charges', () => {
  const lens = {
    date: '2026-10-09',
    item: 'Camera shop',
    what: 'Sony 50mm lens',
    amount: 1250,
    currency: 'ILS',
  };

  it('counts a payment that names no job in the banner and the expenses, but not in the ledger', () => {
    const result = compute({ deliveries: octoberJobs(), money: money({ charges: [lens] }) });
    expect(result.banners.expenses.value).toBe(1250);
    expect(result.expenses.total).toBe(1250);
    expect(result.expenses.items).toEqual([
      expect.objectContaining({
        id: 'use:Camera shop',
        kind: 'Per use',
        billing: '₪1,250.00 per use',
        amountLabel: '1 use',
        ils: 1250,
      }),
    ]);
    expect(result.expenses.charges).toEqual([
      {
        date: '2026-10-09',
        item: 'Camera shop',
        what: 'Sony 50mm lens',
        amountLabel: '₪1,250.00',
        ils: 1250,
        job: null,
      },
    ]);
    expect(result.ledger.every((entry) => entry.expenses === 0)).toBe(true);
    expect(result.subscriptions).toEqual([]);
  });

  it('writes a dollar charge in dollars and its worth in shekels', () => {
    const result = compute({
      deliveries: [],
      money: money({ charges: [{ ...lens, amount: 12.5, currency: 'USD' }] }),
    });
    expect(result.expenses.charges[0]).toMatchObject({ amountLabel: '$12.50', ils: 46.25 });
  });

  it('gives an item a unit price only when every use cost the same', () => {
    const uses = (amounts: number[]) =>
      compute({
        deliveries: [],
        money: money({
          charges: amounts.map((amount, index) => ({
            date: `2026-10-0${index + 1}`,
            item: 'Stock footage',
            what: `Clip licence #${100 + index}`,
            amount,
            currency: 'ILS',
          })),
        }),
      }).expenses.items[0];

    expect(uses([7.5, 7.5, 7.5])).toMatchObject({
      billing: '₪7.50 per clip',
      amountLabel: '3 clips',
    });
    expect(uses([7.5, 9])).toMatchObject({ billing: 'Per use', amountLabel: '2 clips' });
    expect(uses([7.5])).toMatchObject({ billing: '₪7.50 per use', amountLabel: '1 use' });
  });

  it('names what a use buys only when the charges of the item always read the same', () => {
    const noun = (...whats: string[]) =>
      compute({
        deliveries: [],
        money: money({
          charges: whats.map((what, index) => ({
            date: `2026-10-0${index + 1}`,
            item: 'Things',
            what,
            amount: 10,
            currency: 'ILS',
          })),
        }),
      }).expenses.items[0]?.amountLabel;

    expect(noun('Clip licence #1', 'Clip licence #2')).toBe('2 clips');
    expect(noun('Batch 1', 'Batch 2', 'Batch 3')).toBe('3 batches');
    expect(noun('Delivery 1', 'Delivery 2')).toBe('2 deliveries');
    expect(noun('Clip licence #1', 'Music cue #2')).toBe('2 uses');
    expect(noun('Sony 50mm lens', 'Sony 85mm lens')).toBe('2 uses');
    expect(noun('רישיון קליפ 1', 'רישיון קליפ 2')).toBe('2 uses');
  });

  it('takes "<kind> · <who>" by its kind: the same kind of use for different people is one noun', () => {
    const noun = (...whats: string[]) =>
      compute({
        deliveries: [],
        money: money({
          charges: whats.map((what, index) => ({
            date: `2026-10-0${index + 1}`,
            item: 'Things',
            what,
            amount: 10,
            currency: 'ILS',
          })),
        }),
      }).expenses.items[0]?.amountLabel;

    expect(noun('Instagram scan · Falcon FPV', 'Instagram scan · Dana')).toBe('2 scans');
    expect(
      noun(
        'Instagram scan · Falcon FPV',
        'Instagram scan · Falcon FPV',
        'Instagram scan · Falcon FPV',
      ),
    ).toBe('3 scans');
    expect(noun('Instagram scan · Falcon FPV', 'Song read · Dana')).toBe('2 uses');
    expect(noun('Instagram scan · Falcon FPV')).toBe('1 use');
  });

  it('lists the charges of an item once each, whatever the order of the file', () => {
    const result = compute({
      deliveries: [],
      money: money({
        charges: [
          { date: '2026-10-20', item: 'B', what: 'later', amount: 1, currency: 'ILS' },
          { date: '2026-10-02', item: 'A', what: 'first', amount: 2, currency: 'ILS' },
          { date: '2026-10-10', item: 'B', what: 'middle', amount: 3, currency: 'ILS' },
        ],
      }),
    });
    // Items in the order they were first paid; the charges of an item and the list by date.
    expect(result.expenses.items.map((item) => item.name)).toEqual(['A', 'B']);
    expect(result.expenses.items[1]?.charges.map((charge) => charge.what)).toEqual([
      'middle',
      'later',
    ]);
    expect(result.expenses.charges.map((charge) => charge.what)).toEqual([
      'first',
      'middle',
      'later',
    ]);
  });

  it('leaves out anything that cost nothing, and still counts it as 0', () => {
    const file = money({
      subscriptions: [{ ...SUBSCRIPTIONS[3], id: 'free', name: 'Free trial', amount: 0 }],
      charges: [
        {
          date: '2026-10-02',
          item: 'Gift',
          what: 'Free clip',
          amount: 0,
          currency: 'ILS',
          job: 'Kova Coffee/Barista reel',
        },
      ],
    });
    const result = compute({ deliveries: octoberJobs(), money: file });
    expect(result.expenses).toEqual({ items: [], charges: [], total: 0, usdToIls: 3.7 });
    expect(result.subscriptions).toEqual([]);
    const reel = result.ledger.find((entry) => entry.name === 'Barista reel');
    expect(reel).toMatchObject({ expenses: 0, profit: 200, charges: [] });
    // The month still exists, so it can be picked.
    expect(result.months).toContain('2026-10');
  });

  it("charges a job whatever the date of the charge, but the month's banner only what is dated in it", () => {
    const file = money({
      charges: [
        {
          date: '2026-09-30',
          item: 'Stock footage',
          what: 'Clip licence #1',
          amount: 7.5,
          currency: 'ILS',
          job: 'Kova Coffee/Barista reel',
        },
      ],
    });
    const result = compute({ deliveries: octoberJobs(), money: file });
    const reel = result.ledger.find((entry) => entry.name === 'Barista reel');
    expect(reel).toMatchObject({ expenses: 7.5, profit: 192.5 });
    expect(result.banners.expenses.value).toBe(0);
    expect(
      compute({ deliveries: octoberJobs(), money: file, month: '2026-09' }).banners.expenses.value,
    ).toBe(7.5);
  });

  it('matches a charge to a job whichever way the macOS folder name is spelled', () => {
    // "Café" written as one letter (é) in the file and as e + an accent in the folder name.
    const composed = 'Café Noir/Teaser';
    const decomposed = 'Café Noir/Teaser';
    expect(composed).not.toBe(decomposed);
    const result = compute({
      deliveries: [delivery({ client: 'Café Noir', name: 'Teaser' })],
      money: money({
        charges: [
          {
            date: '2026-10-02',
            item: 'Stock footage',
            what: 'Clip',
            amount: 7.5,
            currency: 'ILS',
            job: composed,
          },
        ],
      }),
    });
    expect(result.ledger[0]).toMatchObject({ expenses: 7.5, profit: 192.5 });
  });
});

describe('prices', () => {
  it("reads each job at the price it was delivered for: a client's own price is in the banner and the ledger", () => {
    const lumen = delivery({ client: 'Lumen Yoga', name: 'Morning flow', price: 250 });
    const kova = delivery({ client: 'Kova Coffee', name: 'Barista reel', price: 200 });
    const result = compute({ deliveries: [lumen, kova], money: money() });
    expect(result.banners.income.value).toBe(450);
    expect(result.ledger.map((entry) => [entry.client, entry.income, entry.profit]).sort()).toEqual(
      [
        ['Kova Coffee', 200, 200],
        ['Lumen Yoga', 250, 250],
      ],
    );
  });

  it('converts a price in dollars, and reads any other currency as shekels', () => {
    const result = compute({
      deliveries: [
        delivery({ price: 100, currency: 'USD' }),
        delivery({ price: 80, currency: 'EUR' }),
      ],
      money: money(),
    });
    expect(result.ledger.map((entry) => entry.income).sort((a, b) => a - b)).toEqual([80, 370]);
    expect(result.banners.income.value).toBe(450);
  });

  it('keeps agorot where a price has them', () => {
    const result = compute({
      deliveries: [delivery({ price: 199.99 }), delivery({ price: 0.01 })],
      money: money(),
    });
    expect(result.banners.income.value).toBe(200);
    expect(result.banners.profit.value).toBe(200);
  });
});

describe('what month a job is in', () => {
  // 22:30 UTC on the 30th of September: past midnight in Israel (UTC+3), still the 30th in New York.
  const lateSeptember = delivery({ at: '2026-09-30T22:30:00Z', name: 'Midnight job' });

  it("counts it in October on Israel's calendar and in September on New York's", () => {
    const israel = compute({
      deliveries: [lateSeptember],
      timeZone: 'Asia/Jerusalem',
      money: money(),
    });
    expect(israel.ledger.map((entry) => entry.name)).toEqual(['Midnight job']);
    expect(israel.banners.income.value).toBe(200);
    expect(israel.months).toEqual(['2026-10']);

    const newYork = compute({
      deliveries: [lateSeptember],
      timeZone: 'America/New_York',
      money: money(),
    });
    expect(newYork.ledger).toEqual([]);
    expect(newYork.banners.income).toMatchObject({ value: 0, previous: 200 });
    expect(newYork.months).toEqual(['2026-10', '2026-09']);
  });

  it('puts the last and the first moment of a month on either side of the line, across a clock change', () => {
    // Israel went back to UTC+2 on the 25th of October: midnight is 22:00 UTC from then on.
    const lastMoment = delivery({ at: '2026-10-31T21:59:59.999Z', name: 'Last' });
    const firstMoment = delivery({ at: '2026-10-31T22:00:00.000Z', name: 'First' });
    const deliveries = [lastMoment, firstMoment];

    const october = compute({ deliveries, money: money() });
    expect(october.ledger.map((entry) => entry.name)).toEqual(['Last']);
    const november = compute({ deliveries, money: money(), month: '2026-11' });
    expect(november.ledger.map((entry) => entry.name)).toEqual(['First']);
  });

  it("is this month by the machine's calendar too", () => {
    // 22:30 UTC on the 31st of October is already the 1st of November in Israel, not yet in New York.
    const now = Date.parse('2026-10-31T22:30:00Z');
    expect(
      compute({ deliveries: [], money: money(), now, timeZone: 'Asia/Jerusalem' }).months,
    ).toEqual(['2026-11']);
    expect(
      compute({ deliveries: [], money: money(), now, timeZone: 'America/New_York' }).months,
    ).toEqual(['2026-10']);
  });
});

describe('paid jobs', () => {
  it('carries paidOn to the ledger row: the day it was paid, or null while it is not', () => {
    const result = compute({
      deliveries: [
        delivery({ at: '2026-10-10T12:00:00+03:00', name: 'Paid', paidOn: '2026-10-14' }),
        delivery({ at: '2026-10-08T12:00:00+03:00', name: 'Unpaid' }),
      ],
      money: money(),
    });

    expect(result.ledger.map((entry) => [entry.name, entry.paidOn])).toEqual([
      ['Paid', '2026-10-14'],
      ['Unpaid', null],
    ]);
    expect(moneyResponseSchema.safeParse(result).success).toBe(true);
  });

  it('keeps the income in the month of the delivery when the payment comes in a later month', () => {
    const deliveries = [
      delivery({ at: '2026-09-28T12:00:00+03:00', name: 'Late payer', paidOn: '2026-10-03' }),
    ];

    const september = compute({ deliveries, money: money(), month: '2026-09' });
    expect(september.banners.income.value).toBe(200);
    expect(september.ledger.map((entry) => [entry.name, entry.paidOn])).toEqual([
      ['Late payer', '2026-10-03'],
    ]);
    const october = compute({ deliveries, money: money(), month: '2026-10' });
    expect(october.ledger).toEqual([]);
    expect(october.banners.income).toMatchObject({ value: 0, previous: 200 });
  });
});

describe('what is not paid yet', () => {
  const income = (
    deliveries: MoneyDelivery[],
    month = '2026-10',
  ): MoneyResponse['banners']['income'] =>
    compute({ deliveries, money: money(), month }).banners.income;

  it("counts the month's jobs that have no paidOn, and what they come to", () => {
    const result = income([
      delivery({ at: '2026-10-10T12:00:00+03:00', name: 'Paid', paidOn: '2026-10-14' }),
      delivery({ at: '2026-10-08T12:00:00+03:00', name: 'Owed 1' }),
      delivery({ at: '2026-10-07T12:00:00+03:00', name: 'Owed 2', price: 40 }),
    ]);
    expect(result.unpaid).toEqual({ value: 240, count: 2 });
    // The banner's own value is still all three jobs: what was delivered, paid or not.
    expect(result.value).toBe(440);
  });

  it('counts what was paid for a paid job, ₪0 included, and the price of an unpaid one', () => {
    const october = compute({
      deliveries: [
        delivery({
          at: '2026-10-10T12:00:00+03:00',
          name: 'Free',
          paidOn: '2026-10-14',
          paidAmount: 0,
        }),
        delivery({
          at: '2026-10-09T12:00:00+03:00',
          name: 'Less',
          paidOn: '2026-10-14',
          paidAmount: 150,
        }),
        // Paid before an amount could be typed: it was paid its price.
        delivery({ at: '2026-10-08T12:00:00+03:00', name: 'Old', paidOn: '2026-10-14' }),
        delivery({ at: '2026-10-07T12:00:00+03:00', name: 'Owed' }),
      ],
      money: money(),
      month: '2026-10',
    });
    expect(october.banners.income.value).toBe(550);
    expect(october.banners.income.unpaid).toEqual({ value: 200, count: 1 });
    expect(october.ledger.map((entry) => [entry.name, entry.income])).toEqual([
      ['Free', 0],
      ['Less', 150],
      ['Old', 200],
      ['Owed', 200],
    ]);
  });

  it('is zero and none when everything delivered is paid', () => {
    const result = income([
      delivery({ at: '2026-10-10T12:00:00+03:00', paidOn: '2026-10-14' }),
      delivery({ at: '2026-10-08T12:00:00+03:00', paidOn: '2026-10-08' }),
    ]);
    expect(result.unpaid).toEqual({ value: 0, count: 0 });
    expect(result.value).toBe(400);
  });

  it('is in shekels, to the agora: a dollar price is converted and the sum carries no float dust', () => {
    const result = income([
      delivery({ at: '2026-10-10T12:00:00+03:00', price: 22, currency: 'USD' }),
      delivery({ at: '2026-10-09T12:00:00+03:00', price: 22, currency: 'USD' }),
      delivery({ at: '2026-10-08T12:00:00+03:00', price: 0.1 }),
      delivery({ at: '2026-10-07T12:00:00+03:00', price: 0.2 }),
    ]);
    // 81.4 + 81.4 + 0.1 + 0.2: 162.8 + 0.30000000000000004.
    expect(result.unpaid).toEqual({ value: 163.1, count: 4 });
  });

  it('is counted over the month shown only, not the months before it', () => {
    const deliveries = [
      delivery({ at: '2026-09-28T12:00:00+03:00', name: 'September job' }),
      delivery({ at: '2026-10-02T12:00:00+03:00', name: 'October job' }),
    ];
    expect(income(deliveries, '2026-10').unpaid).toEqual({ value: 200, count: 1 });
    expect(income(deliveries, '2026-09').unpaid).toEqual({ value: 200, count: 1 });
    expect(income(deliveries, '2026-08').unpaid).toEqual({ value: 0, count: 0 });
  });

  it('leaves archived jobs out (paid already or not needed), though they stay in the ledger and the income', () => {
    const owed = delivery({ at: '2026-10-08T12:00:00+03:00', name: 'Owed' });
    const archived = delivery({ at: '2026-10-07T12:00:00+03:00', name: 'Archived' });
    const result = compute({
      deliveries: [owed, archived],
      money: money(),
      archivedJobIds: new Set([archived.jobId]),
    });
    expect(result.banners.income.unpaid).toEqual({ value: 200, count: 1 });
    expect(result.banners.income.value).toBe(400);
    expect(result.ledger.map((entry) => [entry.name, entry.paidOn, entry.archived])).toEqual([
      ['Owed', null, false],
      ['Archived', null, true],
    ]);
  });

  it('marks no job archived when none is named', () => {
    const result = compute({ deliveries: [delivery()], money: money() });
    expect(result.ledger.map((entry) => entry.archived)).toEqual([false]);
    expect(result.banners.income.unpaid.count).toBe(1);
  });

  it('does not depend on when a job was paid: paid in a later month is still paid', () => {
    const deliveries = [
      delivery({ at: '2026-09-28T12:00:00+03:00', name: 'Late payer', paidOn: '2026-10-03' }),
    ];
    expect(income(deliveries, '2026-09').unpaid).toEqual({ value: 0, count: 0 });
  });

  it('is part of the answer the route promises: the schema needs it on the Income banner', () => {
    const result = compute({ deliveries: [delivery()], money: money() });
    expect(moneyResponseSchema.safeParse(result).success).toBe(true);

    const { unpaid: _unpaid, ...withoutUnpaid } = result.banners.income;
    expect(
      moneyResponseSchema.safeParse({
        ...result,
        banners: { ...result.banners, income: withoutUnpaid },
      }).success,
    ).toBe(false);
    for (const bad of [
      { value: 0, count: -1 },
      { value: 0, count: 1.5 },
    ]) {
      expect(
        moneyResponseSchema.safeParse({
          ...result,
          banners: { ...result.banners, income: { ...result.banners.income, unpaid: bad } },
        }).success,
      ).toBe(false);
    }
  });
});

describe('the state of the money file', () => {
  it('is fine unless it is told otherwise', () => {
    expect(compute().moneyFile).toEqual({ status: 'ok', issue: null });
  });

  it('is carried into the answer as it is given, for every month', () => {
    for (const moneyFile of [
      { status: 'last-good', issue: 'usdToIls: Invalid input' },
      { status: 'defaults', issue: 'cannot be read as JSON (Unexpected end of JSON input)' },
    ] as const) {
      expect(compute({ moneyFile }).moneyFile).toEqual(moneyFile);
      expect(compute({ moneyFile, month: '2026-08' }).moneyFile).toEqual(moneyFile);
    }
  });

  it('is needed by the schema, with a known status and a problem that is null or a line', () => {
    const result = compute();
    const { moneyFile: _moneyFile, ...without } = result;
    expect(moneyResponseSchema.safeParse(without).success).toBe(false);
    for (const bad of [
      { status: 'broken', issue: null },
      { status: 'defaults', issue: '' },
      { status: 'ok' },
    ]) {
      expect(moneyResponseSchema.safeParse({ ...result, moneyFile: bad }).success).toBe(false);
    }
  });
});

describe('bad input', () => {
  it.each(['2026-13', '2026-1', '2026-10-01', 'October', ''])('refuses the month %j', (month) => {
    expect(() => computeMoney({ deliveries: [], money: money(), month, timeZone: ZONE })).toThrow(
      RangeError,
    );
  });

  it('refuses a time zone it does not know', () => {
    expect(() =>
      computeMoney({
        deliveries: [delivery()],
        money: money(),
        month: '2026-10',
        timeZone: 'Mars/Olympus',
      }),
    ).toThrow(RangeError);
  });

  it('uses the clock for "this month" when it is not given one', () => {
    const result = computeMoney({
      deliveries: [],
      money: money(),
      month: '2026-10',
      timeZone: ZONE,
    });
    expect(result.months).toContain(localMonthOf(Date.now(), ZONE));
  });
});

describe('computeMoney: jobs that are not delivered yet', () => {
  const idle = {
    jobId: 'idle1',
    clientId: 'client-pinewood',
    client: 'Pinewood',
    name: '97 Window Ad',
    relPath: 'Pinewood/97 Window Ad',
    addedAt: Date.parse('2026-10-25T20:00:00+03:00'),
  };
  const file = money({
    charges: [
      {
        date: '2026-10-26',
        item: 'Stock',
        what: 'Clip',
        amount: 7.5,
        currency: 'ILS',
        job: 'Pinewood/97 Window Ad',
      },
    ],
  });
  const answer = computeMoney({
    deliveries: [delivery({ at: '2026-10-05T12:00:00+03:00', price: 200 })],
    undelivered: [idle],
    money: file,
    month: '2026-10',
    timeZone: ZONE,
    now: NOW,
  });
  const entry = answer.ledger.find((row) => row.jobId === 'idle1');

  it('lists the job in the month it was added, with no income and what it already cost', () => {
    expect(entry).toMatchObject({
      name: '97 Window Ad',
      client: 'Pinewood',
      deliveredAt: null,
      paidOn: null,
      income: 0,
      expenses: 7.5,
      profit: -7.5,
      reviewSec: 0,
    });
    expect(entry?.listedAt).toBe(new Date(idle.addedAt).toISOString());
    expect(entry?.charges.map((charge) => charge.item)).toEqual(['Stock']);
  });

  it('sorts it among the delivered jobs by when it is listed, newest first', () => {
    expect(answer.ledger.map((row) => row.jobId)).toEqual(['idle1', expect.any(String)]);
  });

  it('does not count it as owed: nothing was delivered, so nothing is unpaid', () => {
    expect(answer.banners.income.unpaid).toEqual({ value: 200, count: 1 });
    expect(answer.banners.income.value).toBe(200);
  });

  it('puts it in the month it was added, and lists that month', () => {
    const september = computeMoney({
      deliveries: [],
      undelivered: [{ ...idle, addedAt: Date.parse('2026-09-10T10:00:00+03:00') }],
      money: money(),
      month: '2026-09',
      timeZone: ZONE,
      now: NOW,
    });
    expect(september.ledger.map((row) => row.jobId)).toEqual(['idle1']);
    expect(september.months).toEqual(['2026-10', '2026-09']);
    expect(
      computeMoney({
        deliveries: [],
        undelivered: [idle],
        money: money(),
        month: '2026-09',
        timeZone: ZONE,
        now: NOW,
      }).ledger,
    ).toEqual([]);
  });

  it('is the old answer without them', () => {
    const without = computeMoney({
      deliveries: [delivery({ at: '2026-10-05T12:00:00+03:00', price: 200 })],
      money: file,
      month: '2026-10',
      timeZone: ZONE,
      now: NOW,
    });
    expect(without.ledger).toHaveLength(1);
  });
});
