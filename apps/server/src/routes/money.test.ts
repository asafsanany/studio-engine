import {
  apiErrorSchema,
  type MoneyFile,
  type MoneyFileState,
  type MoneyResponse,
  moneyFileSchema,
  moneyPriceResponseSchema,
  moneyResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository, type NewDelivery } from '../db/delivery-repository.js';
import { JobRepository } from '../db/job-repository.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { type MoneyRouteOptions, machineTimeZone } from './money.js';

// The real routes and the real delivery repository on an in-memory database; the money file is a
// value the test holds. `computeMoney` has its own tests, so these check what the route adds: the
// inputs it gathers, the month it defaults to, and the 400.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const ZONE = 'Asia/Jerusalem';
/** The 21st of October 2026, 09:00 in Israel. */
const NOW = new Date('2026-10-21T09:00:00+03:00');

function setup(options: Partial<MoneyRouteOptions> = {}) {
  const db = memoryDb();
  opened.push(db);
  const deliveries = new DeliveryRepository(db);
  let file: MoneyFile = moneyFileSchema.parse({});
  let fileState: MoneyFileState = { status: 'ok', issue: null };
  const app = createApp({
    money: {
      deliveries,
      money: { get: () => file, fileState: () => fileState },
      timeZone: () => ZONE,
      clock: () => NOW,
      ...options,
    },
  });
  let next = 0;
  return {
    app,
    deliveries,
    deliver(at: string, overrides: Partial<NewDelivery> = {}) {
      next += 1;
      deliveries.record({
        jobId: `job${next}`,
        clientId: 'client1',
        client: 'Northwind Bakery',
        name: `Job ${next}`,
        relPath: `Northwind Bakery/Job ${next}`,
        deliveredAt: Date.parse(at),
        price: 200,
        currency: 'ILS',
        reviewSec: 120,
        ...overrides,
      });
    },
    setMoney(input: unknown) {
      file = moneyFileSchema.parse(input);
    },
    setFileState(next: MoneyFileState) {
      fileState = next;
    },
  };
}

async function get(app: ReturnType<typeof setup>['app'], query = ''): Promise<MoneyResponse> {
  const res = await app.request(`/api/money${query}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  return moneyResponseSchema.parse(await res.json());
}

describe('GET /api/money jobs not delivered yet', () => {
  it('lists a job without a delivery in the month it was added, with what it cost so far', async () => {
    const db = memoryDb();
    opened.push(db);
    const jobs = new JobRepository(db, { clock: fakeClock('2026-10-12T06:00:00.000Z') });
    jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad'));
    const { app, deliver } = setup({
      jobs,
      serviceCharges: async () => [
        {
          date: '2026-10-12',
          item: 'Higgsfield',
          what: 'Pictures and clips',
          amount: 3,
          currency: 'USD',
          job: 'Pinewood/97 Window Ad',
        },
      ],
    });
    deliver('2026-10-05T12:00:00+03:00');

    const body = await get(app);

    const idle = body.ledger.find((entry) => entry.name === '97 Window Ad');
    expect(idle).toMatchObject({ deliveredAt: null, income: 0, expenses: 11.1, profit: -11.1 });
    expect(body.ledger.map((entry) => entry.name)).toContain('Job 1');
    expect(body.banners.income.unpaid).toEqual({ value: 200, count: 1 });
  });

  it('leaves a delivered job to its delivery and does not list it twice', async () => {
    const db = memoryDb();
    opened.push(db);
    const jobs = new JobRepository(db);
    const { app, deliveries } = setup({ jobs });
    jobs.upsertFromScan(makeScan('Northwind Bakery', 'Job 1'));
    const [job] = jobs.getAll();
    deliveries.record({
      jobId: job?.id ?? '',
      clientId: 'client1',
      client: 'Northwind Bakery',
      name: 'Job 1',
      relPath: 'Northwind Bakery/Job 1',
      deliveredAt: Date.parse('2026-10-05T12:00:00+03:00'),
      price: 200,
      currency: 'ILS',
      reviewSec: 0,
    });

    const body = await get(app);

    expect(body.ledger.map((entry) => entry.name)).toEqual(['Job 1']);
    expect(body.ledger[0]?.deliveredAt).not.toBeNull();
  });
});

describe('GET /api/money service charges', () => {
  const higgsfield = {
    date: '2026-10-05',
    item: 'Higgsfield',
    what: 'Pictures and clips',
    amount: 3,
    currency: 'USD',
    job: 'Northwind Bakery/Job 1',
  } as const;

  it("puts what the services cost into the delivered job's expenses and the month's", async () => {
    const asked: { subscriptions: number; timeZone: string }[] = [];
    const { app, deliver } = setup({
      serviceCharges: ({ money, timeZone }) => {
        asked.push({ subscriptions: money.subscriptions.length, timeZone });
        return [higgsfield];
      },
    });
    deliver('2026-10-05T12:00:00+03:00');

    const body = await get(app);

    expect(asked).toEqual([{ subscriptions: 0, timeZone: ZONE }]);
    expect(body.ledger[0]?.charges.map((charge) => [charge.item, charge.amountLabel])).toEqual([
      ['Higgsfield', '$3.00'],
    ]);
    expect(body.ledger[0]?.expenses).toBe(11.1);
    expect(body.banners.expenses.value).toBe(11.1);
  });

  it('still answers when the services cannot be worked out', async () => {
    const { app, deliver } = setup({
      serviceCharges: () => Promise.reject(new Error('the usage log is torn')),
    });
    deliver('2026-10-05T12:00:00+03:00');

    const body = await get(app);

    expect(body.ledger[0]?.charges).toEqual([]);
    expect(body.banners.expenses.value).toBe(0);
  });
});

describe('GET /api/money', () => {
  it('answers this month by default, with nothing delivered and no money file', async () => {
    const { app } = setup();

    const body = await get(app);

    expect(body.month).toBe('2026-10');
    expect(body.months).toEqual(['2026-10']);
    expect(body.ledger).toEqual([]);
    expect(body.expenses).toEqual({ items: [], charges: [], total: 0, usdToIls: 3.7 });
    expect(body.banners.income).toEqual({
      value: 0,
      previous: 0,
      history: Array(8).fill(0),
      unpaid: { value: 0, count: 0 },
    });
  });

  it('answers the month it is asked for', async () => {
    const { app, deliver } = setup();
    deliver('2026-10-05T12:00:00+03:00');
    deliver('2026-10-06T12:00:00+03:00');
    deliver('2026-09-10T12:00:00+03:00');

    const october = await get(app, '?month=2026-10');
    const september = await get(app, '?month=2026-09');
    const august = await get(app, '?month=2026-08');

    expect(october.month).toBe('2026-10');
    expect(october.ledger.map((entry) => entry.name)).toEqual(['Job 2', 'Job 1']);
    expect(october.banners.income).toMatchObject({ value: 400, previous: 200 });
    expect(september.month).toBe('2026-09');
    expect(september.ledger.map((entry) => entry.name)).toEqual(['Job 3']);
    expect(august.ledger).toEqual([]);
    expect(august.banners.income.history.at(-2)).toBe(0);
    expect(august.months).toEqual(['2026-10', '2026-09']);
  });

  it('carries the day a job was paid, or null while it is not', async () => {
    const { app, deliver, deliveries } = setup();
    deliver('2026-10-05T12:00:00+03:00');
    deliver('2026-10-06T12:00:00+03:00');
    deliveries.markPaid(['job1'], '2026-10-14');

    const { ledger } = await get(app);

    expect(ledger.map((entry) => [entry.jobId, entry.paidOn])).toEqual([
      ['job2', null],
      ['job1', '2026-10-14'],
    ]);
  });

  it('says how much of the month is not paid yet: the jobs with no paid day, and their income', async () => {
    const { app, deliver, deliveries } = setup();
    deliver('2026-10-05T12:00:00+03:00');
    deliver('2026-10-06T12:00:00+03:00', { price: 40 });
    deliver('2026-10-07T12:00:00+03:00', { price: 40 });
    deliver('2026-09-20T12:00:00+03:00');
    deliveries.markPaid(['job1'], '2026-10-14');

    const october = await get(app, '?month=2026-10');
    expect(october.banners.income.unpaid).toEqual({ value: 80, count: 2 });
    expect((await get(app, '?month=2026-09')).banners.income.unpaid).toEqual({
      value: 200,
      count: 1,
    });

    deliveries.markPaid(['job2', 'job3'], '2026-10-15');
    expect((await get(app, '?month=2026-10')).banners.income.unpaid).toEqual({
      value: 0,
      count: 0,
    });
  });

  it('leaves the archived jobs out of not paid yet, read on every request', async () => {
    let archived = new Set<string>();
    const { app, deliver } = setup({ archivedJobIds: () => archived });
    deliver('2026-10-05T12:00:00+03:00');
    deliver('2026-10-06T12:00:00+03:00', { price: 40 });
    expect((await get(app, '?month=2026-10')).banners.income.unpaid).toEqual({
      value: 240,
      count: 2,
    });

    archived = new Set(['job1']);
    const october = await get(app, '?month=2026-10');
    expect(october.banners.income.unpaid).toEqual({ value: 40, count: 1 });
    expect(october.banners.income.value).toBe(240);
    expect(october.ledger.map((entry) => [entry.jobId, entry.archived])).toEqual([
      ['job2', false],
      ['job1', true],
    ]);
  });

  it('carries the review time and the price a job was delivered with', async () => {
    const { app, deliver } = setup();
    deliver('2026-10-05T12:00:00+03:00', { price: 250, reviewSec: 410 });

    const { ledger } = await get(app);

    expect(ledger).toEqual([
      {
        jobId: 'job1',
        name: 'Job 1',
        client: 'Northwind Bakery',
        clientId: 'client1',
        deliveredAt: '2026-10-05T09:00:00.000Z',
        listedAt: '2026-10-05T09:00:00.000Z',
        paidOn: null,
        archived: false,
        income: 250,
        expenses: 0,
        profit: 250,
        reviewSec: 410,
        charges: [],
      },
    ]);
  });

  it('says money.json is fine, with no problem to show', async () => {
    const { app } = setup();

    expect((await get(app)).moneyFile).toEqual({ status: 'ok', issue: null });
  });

  it('carries the state of money.json at each request: the last good numbers, or only the defaults', async () => {
    const { app, setFileState } = setup();

    setFileState({
      status: 'last-good',
      issue: 'charges[2].date: must be a date written YYYY-MM-DD, like 2026-10-14',
    });
    expect((await get(app)).moneyFile).toEqual({
      status: 'last-good',
      issue: 'charges[2].date: must be a date written YYYY-MM-DD, like 2026-10-14',
    });

    setFileState({ status: 'defaults', issue: 'pricePerJob: Invalid input' });
    expect((await get(app)).moneyFile).toEqual({
      status: 'defaults',
      issue: 'pricePerJob: Invalid input',
    });

    setFileState({ status: 'ok', issue: null });
    expect((await get(app)).moneyFile).toEqual({ status: 'ok', issue: null });
  });

  it('says it is fine for every month asked, and when the source of the money file has no state', async () => {
    const { app, setFileState } = setup();
    setFileState({ status: 'last-good', issue: 'usdToIls: Invalid input' });
    expect((await get(app, '?month=2026-08')).moneyFile.status).toBe('last-good');

    const bare = setup({ money: { get: () => moneyFileSchema.parse({}) } });
    expect((await get(bare.app)).moneyFile).toEqual({ status: 'ok', issue: null });
  });

  it('works from the money file as it is at each request', async () => {
    const { app, deliver, setMoney } = setup();
    deliver('2026-10-05T12:00:00+03:00', { relPath: 'Northwind Bakery/Spring menu' });

    expect((await get(app)).expenses.total).toBe(0);

    setMoney({
      usdToIls: 4,
      subscriptions: [
        {
          id: 'claude',
          name: 'Claude Max plan',
          amount: 200,
          currency: 'USD',
          every: 'month',
          day: 12,
          since: '2026-08-12',
        },
      ],
      charges: [
        {
          date: '2026-10-08',
          item: 'Stock footage',
          what: 'Clip licence #1',
          amount: 7.5,
          currency: 'ILS',
          job: 'Northwind Bakery/Spring menu',
        },
      ],
    });
    const body = await get(app);

    expect(body.expenses.usdToIls).toBe(4);
    expect(body.expenses.total).toBe(807.5);
    expect(body.subscriptions).toEqual([{ id: 'claude', name: 'Claude Max plan', ils: 800 }]);
    expect(body.ledger[0]).toMatchObject({ expenses: 7.5, profit: 192.5 });
    expect(body.months).toEqual(['2026-10', '2026-09', '2026-08']);
  });

  it('reads the month on the calendar of the time zone it is given', async () => {
    // 22:30 UTC on the 30th of September: October in Israel, still September in New York.
    const late = new Date('2026-09-30T22:30:00Z');
    const israel = setup({ timeZone: () => 'Asia/Jerusalem', clock: () => late });
    const newYork = setup({ timeZone: () => 'America/New_York', clock: () => late });
    israel.deliver('2026-09-30T22:30:00Z');
    newYork.deliver('2026-09-30T22:30:00Z');

    const inIsrael = await get(israel.app);
    const inNewYork = await get(newYork.app);

    expect(inIsrael.month).toBe('2026-10');
    expect(inIsrael.ledger).toHaveLength(1);
    expect(inNewYork.month).toBe('2026-09');
    expect(inNewYork.ledger).toHaveLength(1);
    // The same instant, so the same job, but not in the same month of the banner.
    expect(inNewYork.banners.income.previous).toBe(0);
    expect((await get(newYork.app, '?month=2026-10')).ledger).toEqual([]);
  });

  it("uses the machine's own time zone when none is given", async () => {
    const db = memoryDb();
    opened.push(db);
    const clock = () => new Date();
    const app = createApp({
      money: {
        deliveries: new DeliveryRepository(db),
        money: { get: () => moneyFileSchema.parse({}) },
        clock,
      },
    });
    const now = clock();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    expect((await get(app)).month).toBe(local);
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: machineTimeZone() })).not.toThrow();
  });

  describe('400', () => {
    it.each([
      ['a month that does not exist', '2026-13'],
      ['month zero', '2026-00'],
      ['a month without its zero', '2026-1'],
      ['a day', '2026-10-01'],
      ['a year', '2026'],
      ['words', 'October'],
      ['a slash', '2026/10'],
      ['a space', '%202026-10'],
      ['nothing', ''],
    ])('answers 400 for %s', async (_name, month) => {
      const { app } = setup();

      const res = await app.request(`/api/money?month=${month}`);

      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(await res.json()).error).toBe(
        'Send the month as YYYY-MM, like ?month=2026-10.',
      );
    });

    it('answers 400 for a bad month even when another parameter is fine', async () => {
      const { app } = setup();

      const res = await app.request('/api/money?month=nope&other=2026-10');

      expect(res.status).toBe(400);
    });

    it('ignores parameters it does not know', async () => {
      const { app } = setup();

      const body = await get(app, '?month=2026-09&year=1999&format=csv');

      expect(body.month).toBe('2026-09');
    });
  });

  it('only reads: anything else on the path is a JSON 404', async () => {
    const { app } = setup();

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await app.request('/api/money', { method });
      expect(res.status).toBe(404);
      expect(apiErrorSchema.parse(await res.json()).error).toBe('Not found');
    }
    expect((await app.request('/api/money/2026-10')).status).toBe(404);
  });

  it('is not there when the app is given no money', async () => {
    const res = await createApp({}).request('/api/money');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/money/price', () => {
  const price = async (app: ReturnType<typeof setup>['app'], client: string) => {
    const res = await app.request(`/api/money/price?client=${encodeURIComponent(client)}`);
    expect(res.status).toBe(200);
    return moneyPriceResponseSchema.parse(await res.json());
  };

  it('says what Mark delivered would charge the client now, and the month it counts in', async () => {
    const { app, setMoney } = setup();
    setMoney({ pricePerJob: 200, clientPrices: { 'Northwind Bakery': 40 } });

    expect(await price(app, 'Northwind Bakery')).toEqual({
      client: 'Northwind Bakery',
      price: 40,
      currency: 'ILS',
      month: '2026-10',
    });
    // A client the file does not name pays the price per job.
    expect((await price(app, 'Contoso')).price).toBe(200);
  });

  it('reads the money file at each request, and a Hebrew name as written', async () => {
    const { app, setMoney } = setup();
    setMoney({ clientPrices: { 'עו״ד דוד לוי': 40 } });
    expect((await price(app, 'עו״ד דוד לוי')).price).toBe(40);

    setMoney({ clientPrices: { 'עו״ד דוד לוי': 55 } });

    expect((await price(app, 'עו״ד דוד לוי')).price).toBe(55);
  });

  it('asks the price a delivery is recorded with when it is given one', async () => {
    const asked: string[] = [];
    const { app } = setup({
      priceFor: (client) => {
        asked.push(client);
        return { price: 37.5, currency: 'USD' };
      },
    });

    expect(await price(app, 'Northwind Bakery')).toMatchObject({ price: 37.5, currency: 'USD' });
    expect(asked).toEqual(['Northwind Bakery']);
  });

  it('says the month on the calendar of its time zone', async () => {
    // 23:30 on 31 October in Israel is still October there, already November in Tokyo.
    const clock = () => new Date('2026-10-31T23:30:00+02:00');

    const israel = setup({ clock, timeZone: () => ZONE });
    const tokyo = setup({ clock, timeZone: () => 'Asia/Tokyo' });

    expect((await price(israel.app, 'Contoso')).month).toBe('2026-10');
    expect((await price(tokyo.app, 'Contoso')).month).toBe('2026-11');
  });

  it.each([
    ['no client', ''],
    ['an empty client', '?client='],
    ['only spaces', '?client=%20%20'],
  ])('answers 400 for %s', async (_name, query) => {
    const { app } = setup();

    const res = await app.request(`/api/money/price${query}`);

    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error).toBe(
      'Send the client, like ?client=Northwind%20Bakery.',
    );
  });
});
