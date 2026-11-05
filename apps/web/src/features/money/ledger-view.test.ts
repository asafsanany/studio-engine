import type { MoneyExpenseCharge, MoneyLedgerEntry, MoneyResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeMoneyResponse } from '@/data/test-utils';
import {
  chargeNoun,
  clampPage,
  clientDotColor,
  DEFAULT_LEDGER_SORT,
  deliveredDayText,
  deliveredDetailText,
  deliveredText,
  groupByClient,
  groupCharges,
  jobCountText,
  jobDetail,
  LEDGER_COLUMN_IDS,
  LEDGER_COLUMNS,
  LEDGER_GRID_TEMPLATE,
  LEDGER_MIN_WIDTH,
  ledgerCellWidth,
  ledgerPage,
  marginText,
  monthSummary,
  NOT_DELIVERED_TEXT,
  NOT_PAID_TEXT,
  nextSort,
  pageCountOf,
  pageSlice,
  paidCellText,
  paidDetailText,
  paidText,
  profitPerHour,
  reviewMinutes,
  sortLedger,
  summaryHasContent,
} from './ledger-view';

function entry(id: string, overrides: Partial<MoneyLedgerEntry> = {}): MoneyLedgerEntry {
  const deliveredAt =
    'deliveredAt' in overrides ? overrides.deliveredAt : '2026-10-05T09:00:00.000Z';
  return {
    jobId: id,
    name: id,
    client: 'Kova Coffee',
    clientId: 'c-kova',
    deliveredAt: '2026-10-05T09:00:00.000Z',
    listedAt: deliveredAt ?? '2026-10-05T09:00:00.000Z',
    paidOn: null,
    archived: false,
    income: 200,
    expenses: 0,
    profit: 200,
    reviewSec: 360,
    charges: [],
    ...overrides,
  };
}

function charge(
  item: string,
  what: string,
  ils: number,
  overrides: Partial<MoneyExpenseCharge> = {},
): MoneyExpenseCharge {
  return {
    date: '2026-10-14',
    item,
    what,
    amountLabel: `₪${ils.toFixed(2)}`,
    ils,
    job: 'Kova Coffee/Barista reel',
    ...overrides,
  };
}

const ids = (entries: readonly MoneyLedgerEntry[]) => entries.map((e) => e.jobId);

describe('LEDGER columns', () => {
  it('are Job, Client, Delivered, Paid, Income, Expenses and Profit, on the board’s grid', () => {
    expect(LEDGER_COLUMN_IDS).toEqual([
      'name',
      'client',
      'delivered',
      'paid',
      'income',
      'expenses',
      'profit',
    ]);
    expect(LEDGER_GRID_TEMPLATE).toBe('minmax(240px, 1fr) 190px 140px 100px 110px 110px 110px');
  });

  it('put Paid between Delivered and Income, left-aligned like the date before it', () => {
    const order = [...LEDGER_COLUMN_IDS];
    expect(order.indexOf('paid')).toBe(order.indexOf('delivered') + 1);
    expect(order.indexOf('income')).toBe(order.indexOf('paid') + 1);
    expect(LEDGER_COLUMNS.paid).toMatchObject({ label: 'Paid', align: 'start', textual: false });
  });

  it('give the table the same widths as the Jobs table counts: content plus the gaps and the padding', () => {
    // 12 px at each end of a row, half of the 12 px gap beside every inner edge.
    expect(ledgerCellWidth('name')).toBe(240 + 12 + 6);
    expect(ledgerCellWidth('client')).toBe(190 + 12);
    expect(ledgerCellWidth('profit')).toBe(110 + 6 + 12);
    expect(ledgerCellWidth('paid')).toBe(100 + 12);
    // 1,000 of content, 6 gaps of 12 and 12 px of padding at each end.
    expect(LEDGER_MIN_WIDTH).toBe(1000 + 6 * 12 + 24);
  });
});

describe('nextSort', () => {
  it('starts the text columns A to Z and the others with the most or the newest', () => {
    expect(nextSort(DEFAULT_LEDGER_SORT, 'name')).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort(DEFAULT_LEDGER_SORT, 'client')).toEqual({ key: 'client', dir: 'asc' });
    expect(nextSort(DEFAULT_LEDGER_SORT, 'income')).toEqual({ key: 'income', dir: 'desc' });
    expect(nextSort(DEFAULT_LEDGER_SORT, 'profit')).toEqual({ key: 'profit', dir: 'desc' });
    expect(nextSort(DEFAULT_LEDGER_SORT, 'paid')).toEqual({ key: 'paid', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'delivered')).toEqual({
      key: 'delivered',
      dir: 'desc',
    });
  });

  it('flips the direction of the column that is sorted already', () => {
    expect(nextSort({ key: 'delivered', dir: 'desc' }, 'delivered')).toEqual({
      key: 'delivered',
      dir: 'asc',
    });
    expect(nextSort({ key: 'delivered', dir: 'asc' }, 'delivered')).toEqual({
      key: 'delivered',
      dir: 'desc',
    });
  });
});

describe('sortLedger', () => {
  const jobs = [
    entry('a', {
      name: 'Barista reel',
      client: 'Kova Coffee',
      deliveredAt: '2026-10-05T09:00:00.000Z',
      income: 200,
      expenses: 15,
      profit: 185,
    }),
    entry('b', {
      name: 'Morning flow',
      client: 'Lumen Yoga',
      deliveredAt: '2026-10-12T10:30:00.000Z',
      income: 250,
      expenses: 0,
      profit: 250,
    }),
    entry('c', {
      name: 'חלות לשבת',
      client: 'מאפיית הצפון',
      deliveredAt: '2026-10-01T08:00:00.000Z',
      income: 150,
      expenses: 30,
      profit: 120,
    }),
  ];

  it('is newest delivery first by default', () => {
    expect(ids(sortLedger(jobs))).toEqual(['b', 'a', 'c']);
  });

  it('sorts every column, in both directions', () => {
    const sorted = (key: Parameters<typeof nextSort>[1], dir: 'asc' | 'desc') =>
      ids(sortLedger(jobs, { key, dir }));
    expect(sorted('delivered', 'asc')).toEqual(['c', 'a', 'b']);
    expect(sorted('income', 'desc')).toEqual(['b', 'a', 'c']);
    expect(sorted('income', 'asc')).toEqual(['c', 'a', 'b']);
    expect(sorted('expenses', 'desc')).toEqual(['c', 'a', 'b']);
    expect(sorted('expenses', 'asc')).toEqual(['b', 'a', 'c']);
    expect(sorted('profit', 'desc')).toEqual(['b', 'a', 'c']);
    expect(sorted('profit', 'asc')).toEqual(['c', 'a', 'b']);
    // Latin names, then Hebrew ones, each in alphabetical order.
    expect(sorted('name', 'asc')).toEqual(['a', 'b', 'c']);
    expect(sorted('name', 'desc')).toEqual(['c', 'b', 'a']);
    expect(sorted('client', 'asc')).toEqual(['a', 'b', 'c']);
    expect(sorted('client', 'desc')).toEqual(['c', 'b', 'a']);
  });

  describe('by Paid', () => {
    const paid = [
      entry('early', { paidOn: '2026-10-09', deliveredAt: '2026-10-01T09:00:00.000Z' }),
      entry('late', { paidOn: '2026-10-23', deliveredAt: '2026-10-02T09:00:00.000Z' }),
      entry('owed-old', { paidOn: null, deliveredAt: '2026-10-03T09:00:00.000Z' }),
      entry('owed-new', { paidOn: null, deliveredAt: '2026-10-20T09:00:00.000Z' }),
      entry('next-month', { paidOn: '2026-11-02', deliveredAt: '2026-10-04T09:00:00.000Z' }),
    ];

    it('puts the jobs that are not paid yet first on the first click, the newest delivery first among them', () => {
      expect(ids(sortLedger(paid, nextSort(DEFAULT_LEDGER_SORT, 'paid')))).toEqual([
        'owed-new',
        'owed-old',
        'next-month',
        'late',
        'early',
      ]);
    });

    it('puts them last on the second click, after the latest payment, the oldest payment first', () => {
      expect(ids(sortLedger(paid, { key: 'paid', dir: 'asc' }))).toEqual([
        'early',
        'late',
        'next-month',
        'owed-new',
        'owed-old',
      ]);
    });

    it('keeps jobs paid on the same day newest delivery first, then by id', () => {
      const sameDay = [
        entry('b', { paidOn: '2026-10-09', deliveredAt: '2026-10-05T09:00:00.000Z' }),
        entry('a', { paidOn: '2026-10-09', deliveredAt: '2026-10-05T09:00:00.000Z' }),
        entry('c', { paidOn: '2026-10-09', deliveredAt: '2026-10-08T09:00:00.000Z' }),
      ];
      expect(ids(sortLedger(sameDay, { key: 'paid', dir: 'asc' }))).toEqual(['c', 'a', 'b']);
    });

    it('orders the jobs inside each client by it too, and leaves the client subtotals alone', () => {
      const groups = groupByClient(paid, { key: 'paid', dir: 'desc' });
      expect(groups).toHaveLength(1);
      expect(ids(groups[0]?.jobs ?? [])).toEqual([
        'owed-new',
        'owed-old',
        'next-month',
        'late',
        'early',
      ]);
      expect(groups[0]).toMatchObject({ income: 1000, expenses: 0, profit: 1000 });
    });
  });

  it('compares names as a person would: case is ignored and "Clip 2" comes before "Clip 10"', () => {
    const named = [
      entry('x', { name: 'clip 10' }),
      entry('y', { name: 'Clip 2' }),
      entry('z', { name: 'Apple' }),
    ];
    expect(ids(sortLedger(named, { key: 'name', dir: 'asc' }))).toEqual(['z', 'y', 'x']);
  });

  it('keeps jobs that compare equal newest delivery first, then by id, whatever the input order', () => {
    const equal = [
      entry('b', { deliveredAt: '2026-10-05T09:00:00.000Z' }),
      entry('a', { deliveredAt: '2026-10-05T09:00:00.000Z' }),
      entry('c', { deliveredAt: '2026-10-09T09:00:00.000Z' }),
    ];
    const order = ids(sortLedger(equal, { key: 'income', dir: 'desc' }));
    expect(order).toEqual(['c', 'a', 'b']);
    expect(ids(sortLedger([...equal].reverse(), { key: 'income', dir: 'asc' }))).toEqual(order);
  });

  it('does not touch the list it is given', () => {
    const copy = [...jobs];
    sortLedger(jobs, { key: 'name', dir: 'asc' });
    expect(jobs).toEqual(copy);
  });
});

describe('groupByClient', () => {
  const jobs = [
    entry('k1', {
      client: 'Kova Coffee',
      clientId: 'kova',
      income: 200,
      expenses: 15,
      profit: 185,
      deliveredAt: '2026-10-02T09:00:00.000Z',
    }),
    entry('k2', {
      client: 'Kova Coffee',
      clientId: 'kova',
      income: 200,
      expenses: 0,
      profit: 200,
      deliveredAt: '2026-10-09T09:00:00.000Z',
    }),
    entry('l1', { client: 'Lumen Yoga', clientId: 'lumen', income: 250, expenses: 0, profit: 250 }),
    entry('b1', {
      client: 'מאפיית הצפון',
      clientId: 'bakery',
      income: 150,
      expenses: 30,
      profit: 120,
    }),
  ];

  it('makes one group per client with its subtotals', () => {
    const groups = groupByClient(jobs);
    const kova = groups.find((g) => g.clientId === 'kova');
    expect(kova).toMatchObject({ client: 'Kova Coffee', income: 400, expenses: 15, profit: 385 });
    expect(kova?.jobs).toHaveLength(2);
    expect(groups.map((g) => g.jobs.length).reduce((a, b) => a + b, 0)).toBe(jobs.length);
  });

  it('lists the client who kept the most first', () => {
    expect(groupByClient(jobs).map((g) => g.clientId)).toEqual(['kova', 'lumen', 'bakery']);
  });

  it('breaks a tie by client name', () => {
    const tied = [
      entry('z', { client: 'Zed', clientId: 'zed', profit: 100 }),
      entry('a', { client: 'Alpha', clientId: 'alpha', profit: 100 }),
    ];
    expect(groupByClient(tied).map((g) => g.client)).toEqual(['Alpha', 'Zed']);
  });

  it('orders the jobs inside each group by the sort, not the groups', () => {
    const byIncomeAsc = groupByClient(jobs, { key: 'delivered', dir: 'asc' });
    expect(byIncomeAsc.map((g) => g.clientId)).toEqual(['kova', 'lumen', 'bakery']);
    expect(ids(byIncomeAsc[0]?.jobs ?? [])).toEqual(['k1', 'k2']);
    expect(ids(groupByClient(jobs)[0]?.jobs ?? [])).toEqual(['k2', 'k1']);
  });

  it('adds up without float dust', () => {
    const cents = [
      entry('a', { clientId: 'x', income: 0.1, expenses: 0, profit: 0.1 }),
      entry('b', { clientId: 'x', income: 0.2, expenses: 0, profit: 0.2 }),
    ];
    expect(groupByClient(cents)[0]?.income).toBe(0.3);
  });

  it('is empty for no jobs', () => {
    expect(groupByClient([])).toEqual([]);
  });
});

describe('jobCountText', () => {
  it('says 1 job and N jobs', () => {
    expect(jobCountText(1)).toBe('1 job');
    expect(jobCountText(0)).toBe('0 jobs');
    expect(jobCountText(26)).toBe('26 jobs');
  });
});

describe('clientDotColor', () => {
  it('is the same colour for the same client, whatever the case or spaces, and differs between clients', () => {
    expect(clientDotColor('Arc Fitness')).toBe(clientDotColor(' arc fitness '));
    expect(clientDotColor('Arc Fitness')).not.toBe(clientDotColor('Kova Coffee'));
    expect(clientDotColor('Arc Fitness')).toMatch(/^hsl\(\d{1,3} 70% 55%\)$/);
  });
});

describe('pages', () => {
  it('counts pages, at least one', () => {
    expect(pageCountOf(0, 10)).toBe(1);
    expect(pageCountOf(10, 10)).toBe(1);
    expect(pageCountOf(11, 10)).toBe(2);
    expect(pageCountOf(26, 10)).toBe(3);
  });

  it('keeps a page inside the pages there are', () => {
    expect(clampPage(0, 3)).toBe(0);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(3, 3)).toBe(2);
    expect(clampPage(99, 3)).toBe(2);
    expect(clampPage(-1, 3)).toBe(0);
    expect(clampPage(Number.NaN, 3)).toBe(0);
    expect(clampPage(1.9, 3)).toBe(1);
    expect(clampPage(5, 1)).toBe(0);
  });

  it('slices a page', () => {
    const items = Array.from({ length: 26 }, (_, i) => i);
    expect(pageSlice(items, 0, 10)).toHaveLength(10);
    expect(pageSlice(items, 2, 10)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(pageSlice(items, 3, 10)).toEqual([]);
  });
});

describe('ledgerPage', () => {
  const jobs = Array.from({ length: 26 }, (_, i) =>
    entry(`j${String(i).padStart(2, '0')}`, {
      client: `Client ${i % 12}`,
      clientId: `c${i % 12}`,
      deliveredAt: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T09:00:00.000Z`,
      profit: 200 - i,
    }),
  );

  it('"Every job" pages by job, 10 to a page', () => {
    const first = ledgerPage(jobs, {
      grouping: 'job',
      sort: DEFAULT_LEDGER_SORT,
      page: 0,
      pageSize: 10,
    });
    expect(first).toMatchObject({ grouping: 'job', page: 0, pageCount: 3, total: 26 });
    expect(first.grouping === 'job' && first.jobs).toHaveLength(10);
    const last = ledgerPage(jobs, {
      grouping: 'job',
      sort: DEFAULT_LEDGER_SORT,
      page: 2,
      pageSize: 10,
    });
    expect(last.grouping === 'job' && last.jobs).toHaveLength(6);
  });

  it('"By client" pages by client, and a client shows with all its jobs', () => {
    const first = ledgerPage(jobs, {
      grouping: 'client',
      sort: DEFAULT_LEDGER_SORT,
      page: 0,
      pageSize: 10,
    });
    expect(first).toMatchObject({ grouping: 'client', page: 0, pageCount: 2, total: 12 });
    if (first.grouping !== 'client') throw new Error('expected clients');
    expect(first.groups).toHaveLength(10);
    // 26 jobs over 12 clients: clients 0 and 1 have 3 jobs each, the rest 2.
    expect(first.groups.reduce((n, g) => n + g.jobs.length, 0)).toBeGreaterThan(10);
    const second = ledgerPage(jobs, {
      grouping: 'client',
      sort: DEFAULT_LEDGER_SORT,
      page: 1,
      pageSize: 10,
    });
    expect(second.grouping === 'client' && second.groups).toHaveLength(2);
  });

  it('clamps a page past the end to the last one, and an empty month is page 1 of 1', () => {
    const past = ledgerPage(jobs, {
      grouping: 'job',
      sort: DEFAULT_LEDGER_SORT,
      page: 40,
      pageSize: 10,
    });
    expect(past.page).toBe(2);
    const none = ledgerPage([], {
      grouping: 'client',
      sort: DEFAULT_LEDGER_SORT,
      page: 5,
      pageSize: 10,
    });
    expect(none).toMatchObject({ page: 0, pageCount: 1, total: 0, groups: [] });
  });

  it('puts the sorted jobs on the pages', () => {
    const page = ledgerPage(jobs, {
      grouping: 'job',
      sort: { key: 'profit', dir: 'desc' },
      page: 0,
      pageSize: 10,
    });
    expect(page.grouping === 'job' && ids(page.jobs)[0]).toBe('j00');
  });
});

describe('deliveredDayText', () => {
  it('writes the month and the day without the time, on the wall clock of the zone', () => {
    expect(deliveredDayText('2026-10-21T09:00:00.000Z', 'UTC')).toBe('Oct 21');
    expect(deliveredDayText('2026-10-05T21:00:00.000Z', 'Asia/Jerusalem')).toBe('Oct 6');
    expect(deliveredDayText('nonsense')).toBe('—');
  });
});

describe('deliveredText', () => {
  it('writes the month, the day and the time on the wall clock of the zone', () => {
    expect(deliveredText('2026-10-05T09:00:00.000Z', 'UTC')).toBe('Oct 5, 09:00');
    expect(deliveredText('2026-10-05T09:00:00.000Z', 'Asia/Jerusalem')).toBe('Oct 5, 12:00');
    expect(deliveredText('2026-10-05T09:00:00.000Z', 'America/New_York')).toBe('Oct 5, 05:00');
  });

  it('writes midnight as 00:00 of the next day, never 24:00', () => {
    expect(deliveredText('2026-10-05T21:00:00.000Z', 'Asia/Jerusalem')).toBe('Oct 6, 00:00');
    expect(deliveredText('2026-10-05T00:05:00.000Z', 'UTC')).toBe('Oct 5, 00:05');
  });

  it('spells the months from its own table', () => {
    const names = Array.from(
      { length: 12 },
      (_, i) =>
        deliveredText(`2026-${String(i + 1).padStart(2, '0')}-15T12:00:00.000Z`, 'UTC').split(
          ' ',
        )[0],
    );
    expect(names).toEqual([
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
    ]);
  });

  it('is a dash for a moment it cannot read', () => {
    expect(deliveredText('not a date', 'UTC')).toBe('—');
    expect(deliveredDetailText('not a date', 'UTC')).toBe('—');
  });

  it('reads the machine’s own zone when none is given', () => {
    expect(deliveredText('2026-10-05T09:00:00.000Z')).toMatch(/^Oct [56], \d{2}:\d{2}$/);
  });
});

describe('deliveredDetailText', () => {
  it('writes the day first, then the month and the time, as the open row does', () => {
    expect(deliveredDetailText('2026-10-16T15:40:00.000Z', 'Asia/Jerusalem')).toBe('16 Oct, 18:40');
    expect(deliveredDetailText('2026-10-05T09:00:00.000Z', 'UTC')).toBe('5 Oct, 09:00');
    expect(deliveredDetailText('2026-10-05T21:00:00.000Z', 'Asia/Jerusalem')).toBe('6 Oct, 00:00');
  });
});

describe('paidText', () => {
  it('writes the day the money came in as the Paid column does, month first', () => {
    expect(paidText('2026-10-14')).toBe('Oct 14');
    expect(paidText('2026-11-02')).toBe('Nov 2');
    expect(paidText('2027-01-09')).toBe('Jan 9');
  });

  it('is read from the text, never through a Date, so no time zone can move it', () => {
    expect(paidText('2026-03-01')).toBe('Mar 1');
    expect(paidText('2026-12-31')).toBe('Dec 31');
  });

  it('is a dash for something that is not a day', () => {
    expect(paidText('')).toBe('—');
    expect(paidText('soon')).toBe('—');
  });

  it('is written day first in the open row', () => {
    expect(paidDetailText('2026-10-23')).toBe('23 Oct');
    expect(paidDetailText('2026-11-02')).toBe('2 Nov');
    expect(paidDetailText('nope')).toBe('—');
  });

  it('says "Not yet" for a job that is not paid', () => {
    expect(NOT_PAID_TEXT).toBe('Not yet');
  });

  it('says "Archived" for an archived job that is not paid: it is not owed (CVP-210)', () => {
    expect(paidCellText({ paidOn: null, archived: true })).toBe('Archived');
    expect(paidCellText({ paidOn: null, archived: false })).toBe('Not yet');
    // Paid is paid, archived or not.
    expect(paidCellText({ paidOn: '2026-10-23', archived: true })).toBe(paidText('2026-10-23'));
  });
});

describe('margin, review time and the hourly rate', () => {
  it('shows what a job kept of its price as a whole percentage', () => {
    expect(marginText(185, 200)).toBe('93%');
    expect(marginText(200, 200)).toBe('100%');
    expect(marginText(0, 200)).toBe('0%');
    expect(marginText(-24, 200)).toBe('−12%');
    expect(marginText(5, 0)).toBe('—');
  });

  it('counts review in minutes, one at least once there is any', () => {
    expect(reviewMinutes(0)).toBe(0);
    expect(reviewMinutes(10)).toBe(1);
    expect(reviewMinutes(360)).toBe(6);
    expect(reviewMinutes(389)).toBe(6);
    expect(reviewMinutes(390)).toBe(7);
  });

  it('divides the profit by the hours of review, and has no rate without review', () => {
    expect(profitPerHour({ profit: 185, reviewSec: 360 })).toBeCloseTo(1850, 5);
    expect(profitPerHour({ profit: 100, reviewSec: 3600 })).toBe(100);
    expect(profitPerHour({ profit: -50, reviewSec: 1800 })).toBe(-100);
    expect(profitPerHour({ profit: 185, reviewSec: 0 })).toBeNull();
  });
});

describe('chargeNoun', () => {
  it('is the first word when the payments say the same thing but for their number', () => {
    expect(chargeNoun([{ what: 'Clip licence #4831' }, { what: 'Clip licence #4838' }])).toBe(
      'clip',
    );
    expect(chargeNoun([{ what: 'Photo 12' }, { what: 'photo 13' }])).toBe('photo');
    expect(chargeNoun([{ what: 'Track no. 4' }, { what: 'Track no. 9' }])).toBe('track');
  });

  it('is nothing when it is not obvious', () => {
    expect(chargeNoun([{ what: 'Clip licence #1' }])).toBeNull();
    expect(chargeNoun([{ what: 'Clip licence #1' }, { what: 'Voice pack #2' }])).toBeNull();
    expect(chargeNoun([{ what: 'רישיון קליפ 1' }, { what: 'רישיון קליפ 2' }])).toBeNull();
    expect(chargeNoun([{ what: '4831' }, { what: '4838' }])).toBeNull();
    expect(chargeNoun([])).toBeNull();
  });

  it('keeps a word that ends in "no" whole ("Piano 5" is a piano, not a "pia")', () => {
    expect(chargeNoun([{ what: 'Piano 5' }, { what: 'Piano 6' }])).toBe('piano');
  });
});

describe('groupCharges', () => {
  it('turns two payments of the same amount into "2 clips at ₪7.50" with the total', () => {
    const groups = groupCharges([
      charge('Stock footage', 'Clip licence #4831', 7.5),
      charge('Stock footage', 'Clip licence #4838', 7.5),
    ]);
    expect(groups).toEqual([
      { item: 'Stock footage', count: 2, total: 15, note: '2 clips at ₪7.50' },
    ]);
  });

  it('writes "2 × ₪7.50" when no noun shows', () => {
    const groups = groupCharges([
      charge('Stock footage', 'Pack A', 7.5),
      charge('Stock footage', 'Pack B', 7.5),
    ]);
    expect(groups[0]).toMatchObject({ count: 2, total: 15, note: '2 × ₪7.50' });
  });

  it('writes the purpose of a lone payment', () => {
    expect(groupCharges([charge('Voice-over', 'Hebrew narration', 120)])).toEqual([
      { item: 'Voice-over', count: 1, total: 120, note: 'Hebrew narration' },
    ]);
  });

  it('counts payments of different amounts', () => {
    const groups = groupCharges([
      charge('Music', 'Track 1', 20),
      charge('Music', 'Track 2', 35.5),
      charge('Music', 'Track 3', 20),
    ]);
    expect(groups[0]).toMatchObject({ count: 3, total: 75.5, note: '3 charges' });
  });

  it('makes one line per item, in the order of the first payment', () => {
    const groups = groupCharges([
      charge('Voice-over', 'Narration', 120),
      charge('Stock footage', 'Clip licence #1', 7.5),
      charge('Stock footage', 'Clip licence #2', 7.5),
    ]);
    expect(groups.map((g) => g.item)).toEqual(['Voice-over', 'Stock footage']);
  });

  it('pluralizes plain nouns', () => {
    const many = (what: string) =>
      groupCharges([charge('A', `${what} 1`, 5), charge('A', `${what} 2`, 5)])[0]?.note;
    expect(many('Box')).toBe('2 boxes at ₪5.00');
    expect(many('Story')).toBe('2 stories at ₪5.00');
    expect(many('Day')).toBe('2 days at ₪5.00');
  });

  it('is empty for a job that cost nothing', () => {
    expect(groupCharges([])).toEqual([]);
  });
});

describe('jobDetail', () => {
  const withClips = entry('a', {
    income: 200,
    expenses: 15,
    profit: 185,
    reviewSec: 360,
    charges: [
      charge('Stock footage', 'Clip licence #4831', 7.5),
      charge('Stock footage', 'Clip licence #4838', 7.5),
    ],
  });

  it('has four columns: Income, Expenses, Profit and Your time', () => {
    expect(jobDetail(withClips).map((c) => c.title)).toEqual([
      'Income',
      'Expenses',
      'Profit',
      'Your time',
    ]);
  });

  it('says the price, the charges, the margin and the review time, with a total each', () => {
    const [income, expenses, profit, time] = jobDetail(withClips, 'Asia/Jerusalem');
    expect(income).toMatchObject({
      lines: [
        { label: 'Price', note: 'your price per job', value: '₪200' },
        { label: 'Delivered', value: '5 Oct, 12:00' },
        { label: 'Paid', value: 'Not yet' },
      ],
      total: { label: 'Income', value: '₪200', tone: 'green' },
    });
    expect(expenses).toMatchObject({
      lines: [{ label: 'Stock footage', note: '2 clips at ₪7.50', value: '₪15.00' }],
      total: { label: 'Expenses', value: '₪15.00', tone: 'red' },
    });
    expect(profit).toMatchObject({
      lines: [{ label: 'Margin', value: '93%' }],
      total: { label: 'Profit', value: '₪185.00', tone: 'plain' },
    });
    expect(time).toMatchObject({
      lines: [{ label: 'Review and notes', value: '6 min' }],
      total: { label: 'Per hour of your time', value: '₪1,850/h', tone: 'plain' },
    });
  });

  it('says when it was delivered and whether it is paid, after the price, and leaves the total alone', () => {
    const income = jobDetail(withClips, 'Asia/Jerusalem')[0];
    expect(income?.lines).toEqual([
      {
        label: 'Price',
        note: 'your price per job',
        value: '₪200',
        muted: false,
        valueMuted: false,
      },
      { label: 'Delivered', note: null, value: '5 Oct, 12:00', muted: true, valueMuted: false },
      { label: 'Paid', note: null, value: 'Not yet', muted: true, valueMuted: true },
    ]);
    expect(income?.total).toEqual({ label: 'Income', value: '₪200', tone: 'green' });
  });

  it('says the day it was paid when it was', () => {
    const paid = entry('p', { paidOn: '2026-10-23', deliveredAt: '2026-10-16T15:40:00.000Z' });
    const income = jobDetail(paid, 'Asia/Jerusalem')[0];
    expect(income?.lines.map((l) => [l.label, l.value, l.valueMuted])).toEqual([
      ['Price', '₪200', false],
      ['Delivered', '16 Oct, 18:40', false],
      ['Paid', '23 Oct', false],
    ]);
  });

  it('says "Nothing paid for this job" and a grey total when it cost nothing', () => {
    const expenses = jobDetail(entry('b'))[1];
    expect(expenses?.lines).toEqual([
      {
        label: 'Nothing paid for this job',
        note: null,
        value: null,
        muted: true,
        valueMuted: false,
      },
    ]);
    expect(expenses?.total).toEqual({ label: 'Expenses', value: '₪0.00', tone: 'grey' });
  });

  it('has a dash per hour, and says so, without review time', () => {
    const time = jobDetail(entry('c', { reviewSec: 0 }))[3];
    expect(time?.total.value).toBe('—');
    expect(time?.lines[0]).toMatchObject({ label: 'No review time yet', muted: true });
  });

  it('writes a loss with the real minus', () => {
    const loss = jobDetail(
      entry('d', {
        income: 100,
        expenses: 130,
        profit: -30,
        charges: [charge('Ads', 'Boost', 130)],
      }),
    );
    expect(loss[2]?.total.value).toBe('−₪30.00');
    expect(loss[2]?.lines[0]?.value).toBe('−30%');
    expect(loss[1]?.total.tone).toBe('red');
  });
});

// --- the Month summary -----------------------------------------------------------------------

interface MonthOptions {
  jobs: MoneyLedgerEntry[];
  subscriptions?: { id: string; name: string; ils: number }[];
  /** General entries of the money file dated in the month. */
  others?: MoneyExpenseCharge[];
  /** Charges for jobs that are in no row of the ledger, dated in the month. */
  strays?: MoneyExpenseCharge[];
}

/**
 * A month the way the server computes it: the banners are the jobs' prices, and every charge dated
 * in the month (renewals, general entries, job charges whose job is delivered in another month and
 * the dated-in-the-month charges of this month's jobs).
 */
function month({
  jobs,
  subscriptions = [],
  others = [],
  strays = [],
}: MonthOptions): MoneyResponse {
  const renewals = subscriptions.map((s) =>
    charge(s.name, 'Monthly plan', s.ils, { job: null, amountLabel: `₪${s.ils}.00` }),
  );
  const jobCharges = jobs.flatMap((j) => j.charges).filter((c) => c.date.startsWith('2026-10'));
  const all = [...renewals, ...others, ...jobCharges, ...strays];
  const total = all.reduce((sum, c) => sum + c.ils, 0);
  const income = jobs.reduce((sum, j) => sum + j.income, 0);
  const base = makeMoneyResponse();
  const banner = (value: number) => ({ value, previous: 0, history: new Array(8).fill(0) });
  const owing = jobs.filter((j) => j.paidOn === null);
  return {
    ...base,
    month: '2026-10',
    banners: {
      income: {
        ...banner(income),
        unpaid: { value: owing.reduce((sum, j) => sum + j.income, 0), count: owing.length },
      },
      expenses: banner(total),
      profit: banner(income - total),
    },
    ledger: jobs,
    subscriptions,
    expenses: {
      items: [
        ...subscriptions.map((s, i) => ({
          id: s.id,
          name: s.name,
          kind: 'Subscription' as const,
          billing: 'Monthly · renews Nov 12',
          amountLabel: `₪${s.ils}.00`,
          ils: s.ils,
          charges: [renewals[i] as MoneyExpenseCharge],
          notes: [],
        })),
        ...[...new Set(others.map((c) => c.item))].map((item) => ({
          id: `use:${item}`,
          name: item,
          kind: 'Per use' as const,
          billing: 'Per use',
          amountLabel: '1 use',
          ils: others.filter((c) => c.item === item).reduce((s, c) => s + c.ils, 0),
          charges: others.filter((c) => c.item === item),
          notes: [],
        })),
      ],
      charges: all,
      total,
      usdToIls: 3.7,
    },
  };
}

/** The sum of a column of the summary rows (a dash counts as nothing). */
function columnSum(
  summary: ReturnType<typeof monthSummary>,
  key: 'income' | 'expenses' | 'profit',
) {
  return Math.round(summary.rows.reduce((sum, row) => sum + (row[key] ?? 0), 0) * 100) / 100;
}

describe('monthSummary', () => {
  const clips = [
    charge('Stock footage', 'Clip licence #4831', 7.5),
    charge('Stock footage', 'Clip licence #4838', 7.5),
  ];

  it('is titled with the month and starts with the jobs', () => {
    const jobs = [
      entry('a', { expenses: 15, profit: 185, charges: clips }),
      entry('b'),
      entry('c'),
    ];
    const summary = monthSummary(month({ jobs }));
    expect(summary.title).toBe('October summary');
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({
      id: 'jobs',
      label: 'Jobs',
      note: '3 delivered · 3 not paid yet (₪600)',
      income: 600,
      expenses: 15,
      profit: 585,
    });
  });

  describe('the Jobs line', () => {
    const jobsNote = (jobs: MoneyLedgerEntry[]) =>
      monthSummary(month({ jobs })).rows.find((r) => r.id === 'jobs')?.note;

    it('says how many are not paid yet and what they come to, after how many were delivered', () => {
      const jobs = [
        entry('a', { paidOn: '2026-10-14' }),
        entry('b'),
        entry('c', { income: 40 }),
        entry('d', { income: 40 }),
        entry('e', { paidOn: '2026-10-09' }),
      ];
      expect(jobsNote(jobs)).toBe('5 delivered · 3 not paid yet (₪280)');
    });

    it('drops the unpaid part when everything is paid', () => {
      const jobs = [entry('a', { paidOn: '2026-10-14' }), entry('b', { paidOn: '2026-10-15' })];
      expect(jobsNote(jobs)).toBe('2 delivered');
    });

    it('writes the amount in whole shekels, with thousands', () => {
      const jobs = Array.from({ length: 7 }, (_, i) => entry(`j${i}`, { income: 200.4 }));
      expect(jobsNote(jobs)).toBe('7 delivered · 7 not paid yet (₪1,403)');
    });

    it('is the Income banner’s count and amount, so the card and the summary always agree', () => {
      const data = month({ jobs: [entry('a'), entry('b', { paidOn: '2026-10-09' })] });
      const edited: MoneyResponse = {
        ...data,
        banners: {
          ...data.banners,
          income: { ...data.banners.income, unpaid: { value: 55, count: 4 } },
        },
      };
      expect(monthSummary(edited).rows[0]?.note).toBe('2 delivered · 4 not paid yet (₪55)');
    });
  });

  it('adds the monthly subscriptions: no income, their total as an expense and minus it as profit', () => {
    const jobs = [entry('a'), entry('b')];
    const summary = monthSummary(
      month({
        jobs,
        subscriptions: [
          { id: 'claude', name: 'Claude plan', ils: 740 },
          { id: 'el', name: 'ElevenLabs', ils: 81.4 },
          { id: 'music', name: 'Music library', ils: 49 },
        ],
      }),
    );
    const subs = summary.rows.find((r) => r.id === 'subscriptions');
    expect(subs).toMatchObject({
      label: 'Monthly subscriptions',
      detail: 'Not charged to a job: Claude plan ₪740 · ElevenLabs ₪81 · Music library ₪49',
      income: null,
      expenses: 870.4,
      profit: -870.4,
      muted: false,
    });
  });

  it('has no subscriptions row when nothing was subscribed', () => {
    expect(monthSummary(month({ jobs: [entry('a')] })).rows.map((r) => r.id)).toEqual(['jobs']);
  });

  it('adds "Other expenses" for general entries of the money file, and not for renewals or job charges', () => {
    const jobs = [entry('a', { expenses: 15, profit: 185, charges: clips })];
    const summary = monthSummary(
      month({
        jobs,
        subscriptions: [{ id: 'claude', name: 'Claude plan', ils: 740 }],
        others: [
          charge('Domain', 'Renewal', 55, { job: null }),
          charge('Hosting', 'Yearly', 20, { job: null }),
          charge('Domain', 'Second domain', 10, { job: null }),
        ],
      }),
    );
    expect(summary.rows.map((r) => r.id)).toEqual(['jobs', 'subscriptions', 'other']);
    expect(summary.rows[2]).toMatchObject({
      label: 'Other expenses',
      detail: 'Not charged to a job: Domain ₪65 · Hosting ₪20',
      income: null,
      expenses: 85,
      profit: -85,
    });
  });

  it('ends with the Income and Expenses banners and the Profit banner', () => {
    const jobs = [entry('a'), entry('b')];
    const data = month({ jobs, subscriptions: [{ id: 'claude', name: 'Claude plan', ils: 740 }] });
    expect(monthSummary(data).total).toEqual({
      income: 400,
      expenses: 740,
      profit: -340,
      tone: 'bad',
    });
    const better = month({
      jobs: [entry('a'), entry('b'), entry('c'), entry('d')],
      subscriptions: [{ id: 'claude', name: 'Claude plan', ils: 740 }],
    });
    expect(monthSummary(better).total).toMatchObject({ profit: 60, tone: 'good' });
  });

  it('is green at exactly zero', () => {
    const data = month({
      jobs: [entry('a', { income: 740 })],
      subscriptions: [{ id: 'c', name: 'Claude', ils: 740 }],
    });
    expect(monthSummary(data).total).toMatchObject({ profit: 0, tone: 'good' });
  });

  it('shows the Profit banner’s own number', () => {
    const data = month({ jobs: [entry('a'), entry('b')] });
    const edited: MoneyResponse = {
      ...data,
      banners: { ...data.banners, profit: { ...data.banners.profit, value: 123.45 } },
    };
    expect(monthSummary(edited).total.profit).toBe(123.45);
  });

  it('reconciles by itself: with no gap there is no extra line', () => {
    const jobs = [entry('a', { expenses: 15, profit: 185, charges: clips }), entry('b')];
    const summary = monthSummary(
      month({
        jobs,
        subscriptions: [{ id: 'claude', name: 'Claude plan', ils: 740 }],
        others: [charge('Domain', 'Renewal', 55, { job: null })],
      }),
    );
    expect(summary.rows.some((r) => r.id === 'adjustment')).toBe(false);
    expect(columnSum(summary, 'income')).toBe(summary.total.income);
    expect(columnSum(summary, 'expenses')).toBe(summary.total.expenses);
    expect(columnSum(summary, 'profit')).toBe(summary.total.profit);
  });

  it('adds a muted "paid in another month" line when a job’s charge is dated outside the month', () => {
    // The job has ₪15 of clips, paid in September: they are in the job's expenses and profit, but
    // not in October's Expenses banner.
    const september = [
      charge('Stock footage', 'Clip licence #1', 7.5, { date: '2026-09-28' }),
      charge('Stock footage', 'Clip licence #2', 7.5, { date: '2026-09-28' }),
    ];
    const jobs = [entry('a', { expenses: 15, profit: 185, charges: september }), entry('b')];
    const summary = monthSummary(
      month({ jobs, subscriptions: [{ id: 'claude', name: 'Claude plan', ils: 740 }] }),
    );
    const adjustment = summary.rows.find((r) => r.id === 'adjustment');
    expect(adjustment).toMatchObject({
      label: 'Job costs paid in another month',
      muted: true,
      income: null,
      expenses: -15,
      profit: 15,
    });
    expect(columnSum(summary, 'income')).toBe(summary.total.income);
    expect(columnSum(summary, 'expenses')).toBe(summary.total.expenses);
    expect(columnSum(summary, 'profit')).toBe(summary.total.profit);
  });

  it('adds it too for a charge dated in the month for a job delivered in another month', () => {
    const stray = charge('Stock footage', 'Clip licence #9', 7.5, {
      job: 'Arc Fitness/Coach intro',
    });
    const summary = monthSummary(month({ jobs: [entry('a'), entry('b')], strays: [stray] }));
    const adjustment = summary.rows.find((r) => r.id === 'adjustment');
    expect(adjustment).toMatchObject({ expenses: 7.5, profit: -7.5 });
    expect(columnSum(summary, 'expenses')).toBe(summary.total.expenses);
    expect(columnSum(summary, 'profit')).toBe(summary.total.profit);
  });

  it('reconciles in every column in a month with everything at once', () => {
    const jobs = [
      entry('a', { expenses: 15, profit: 185, charges: clips }),
      entry('b', {
        expenses: 7.5,
        profit: 192.5,
        charges: [charge('Music', 'Track 1', 7.5, { date: '2026-11-02' })],
      }),
      entry('c', { income: 250, profit: 250 }),
    ];
    const summary = monthSummary(
      month({
        jobs,
        subscriptions: [
          { id: 'claude', name: 'Claude plan', ils: 740 },
          { id: 'music', name: 'Music library', ils: 49 },
        ],
        others: [charge('Domain', 'Renewal', 55, { job: null })],
        strays: [
          charge('Stock footage', 'Clip licence #9', 7.5, { job: 'Arc Fitness/Coach intro' }),
        ],
      }),
    );
    expect(columnSum(summary, 'income')).toBe(summary.total.income);
    expect(columnSum(summary, 'expenses')).toBe(summary.total.expenses);
    expect(columnSum(summary, 'profit')).toBe(summary.total.profit);
  });

  it('works for a month with no jobs but a subscription: a loss', () => {
    const summary = monthSummary(
      month({ jobs: [], subscriptions: [{ id: 'claude', name: 'Claude plan', ils: 740 }] }),
    );
    expect(summary.rows[0]).toMatchObject({
      note: '0 delivered',
      income: 0,
      expenses: 0,
      profit: 0,
    });
    expect(summary.total).toMatchObject({ income: 0, expenses: 740, profit: -740, tone: 'bad' });
    expect(columnSum(summary, 'profit')).toBe(-740);
  });
});

describe('summaryHasContent', () => {
  it('is false for a month with nothing in it, true as soon as there is a job, a subscription or an amount', () => {
    expect(summaryHasContent(month({ jobs: [] }))).toBe(false);
    expect(summaryHasContent(month({ jobs: [entry('a')] }))).toBe(true);
    expect(
      summaryHasContent(
        month({ jobs: [], subscriptions: [{ id: 'c', name: 'Claude', ils: 740 }] }),
      ),
    ).toBe(true);
    expect(
      summaryHasContent(
        month({ jobs: [], others: [charge('Domain', 'Renewal', 55, { job: null })] }),
      ),
    ).toBe(true);
  });
});

describe('a job that is not delivered yet', () => {
  const idle = entry('idle', {
    deliveredAt: null,
    listedAt: '2026-10-25T20:00:00.000Z',
    income: 0,
    expenses: 11.57,
    profit: -11.57,
  });

  it('says so where the delivery and the payment would be', () => {
    expect(paidCellText(idle)).toBe('—');
    const [income] = jobDetail(idle);
    expect(income?.lines).toEqual([
      {
        label: NOT_DELIVERED_TEXT,
        note: 'no income until it is',
        value: null,
        muted: true,
        valueMuted: false,
      },
    ]);
  });

  it('sorts among the delivered jobs by the day it was added', () => {
    const delivered = entry('delivered', { deliveredAt: '2026-10-22T09:00:00.000Z' });
    const older = entry('older', { deliveredAt: '2026-10-05T09:00:00.000Z' });
    expect(sortLedger([older, idle, delivered]).map((row) => row.jobId)).toEqual([
      'idle',
      'delivered',
      'older',
    ]);
  });
});

describe('monthSummary with a job’s share of a plan', () => {
  const base = (): MoneyResponse => {
    const idle = entry('idle', {
      deliveredAt: null,
      income: 0,
      expenses: 12.07,
      profit: -12.07,
      charges: [
        charge('Higgsfield', 'Pictures and clips', 11.57, { job: 'Pinewood/97 Window Ad' }),
        charge('ElevenLabs', 'Voice (150 credits)', 0.5, {
          job: 'Pinewood/97 Window Ad',
          included: true,
        }),
      ],
    });
    const shown = makeMoneyResponse();
    return {
      ...shown,
      ledger: [idle],
      subscriptions: [{ id: 'eleven', name: 'ElevenLabs', ils: 22.2 }],
      banners: {
        income: {
          value: 0,
          previous: 0,
          history: Array(8).fill(0),
          unpaid: { value: 0, count: 0 },
        },
        expenses: { value: 33.77, previous: 0, history: Array(8).fill(0) },
        profit: { value: -33.77, previous: 0, history: Array(8).fill(0) },
      },
    };
  };

  it('takes the plan-paid part out so the block still adds up, without calling it another month', () => {
    const summary = monthSummary(base());
    const included = summary.rows.find((row) => row.id === 'included');
    expect(included).toMatchObject({
      label: 'Already in the plans above',
      expenses: -0.5,
      profit: 0.5,
      muted: true,
    });
    expect(summary.rows.find((row) => row.id === 'adjustment')).toBeUndefined();
  });
});
