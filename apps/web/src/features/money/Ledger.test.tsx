import type { MoneyExpenseCharge, MoneyLedgerEntry, MoneyResponse } from '@studio/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { moneyKey } from '@/data/money-query';
import { createTestQueryClient, makeMoneyResponse } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { createMemoryStorage } from '@/stores/jobs-ui';
import { createMoneyUiStore, defaultMoneyUiState, moneyUiStore } from '@/stores/money-ui';
import { Ledger } from './Ledger';
import { clientDotColor, LEDGER_GRID_TEMPLATE } from './ledger-view';

// The Ledger reads the app's one Money UI store; every test starts it on October 2026 again.
beforeAll(() => {
  // zustand's server render reads the store's initial state; point it at the current one.
  moneyUiStore.getInitialState = () => moneyUiStore.getState();
});
beforeEach(() => {
  moneyUiStore.setState(defaultMoneyUiState('2026-10'));
});

const CLIENTS = [
  ['Kova Coffee', 'c-kova'],
  ['Arc Fitness', 'c-arc'],
  ['Lumen Yoga', 'c-lumen'],
  ['מאפיית הצפון', 'c-bakery'],
] as const;

function clip(ils: number, what: string): MoneyExpenseCharge {
  return {
    date: '2026-10-14',
    item: 'Stock footage',
    what,
    amountLabel: '₪7.50',
    ils,
    job: 'Kova Coffee/Barista reel',
  };
}

/**
 * `count` delivered jobs; job 0 is the newest and has two clips (₪15), the rest cost nothing. Job 1
 * was paid on the 30th, the others have not been.
 */
function jobs(count: number): MoneyLedgerEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const [client, clientId] = CLIENTS[i % CLIENTS.length] ?? CLIENTS[0];
    const clips = i === 0 ? [clip(7.5, 'Clip licence #4831'), clip(7.5, 'Clip licence #4838')] : [];
    const expenses = clips.length * 7.5;
    return {
      jobId: `j${String(i).padStart(2, '0')}`,
      name: i === 3 ? 'חלות לשבת' : `Job ${String(i).padStart(2, '0')}`,
      client,
      clientId,
      // Newest first: job 0 on the 28th.
      deliveredAt: `2026-10-${String(28 - i).padStart(2, '0')}T09:00:00.000Z`,
      listedAt: `2026-10-${String(28 - i).padStart(2, '0')}T09:00:00.000Z`,
      paidOn: i === 1 ? '2026-10-30' : null,
      archived: false,
      income: 200,
      expenses,
      profit: 200 - expenses,
      reviewSec: 360,
      charges: clips,
    };
  });
}

/** A month that adds up the way the server's does: the banners are the jobs and the subscriptions. */
function monthOf(
  ledger: MoneyLedgerEntry[],
  subscriptions = [
    { id: 'claude', name: 'Claude plan', ils: 740 },
    { id: 'el', name: 'ElevenLabs', ils: 81.4 },
  ],
): MoneyResponse {
  const base = makeMoneyResponse();
  const subsTotal = subscriptions.reduce((sum, s) => sum + s.ils, 0);
  const jobExpenses = ledger.reduce((sum, e) => sum + e.expenses, 0);
  const income = ledger.reduce((sum, e) => sum + e.income, 0);
  const expenses = Math.round((subsTotal + jobExpenses) * 100) / 100;
  const banner = (value: number) => ({ value, previous: 0, history: new Array(8).fill(0) });
  const owing = ledger.filter((e) => e.paidOn === null);
  const renewals: MoneyExpenseCharge[] = subscriptions.map((s) => ({
    date: '2026-10-12',
    item: s.name,
    what: 'Monthly plan',
    amountLabel: `₪${s.ils}`,
    ils: s.ils,
    job: null,
  }));
  return {
    ...base,
    ledger,
    subscriptions,
    banners: {
      income: {
        ...banner(income),
        unpaid: { value: owing.reduce((sum, e) => sum + e.income, 0), count: owing.length },
      },
      expenses: banner(expenses),
      profit: banner(Math.round((income - expenses) * 100) / 100),
    },
    expenses: {
      ...base.expenses,
      items: subscriptions.map((s, i) => ({
        id: s.id,
        name: s.name,
        kind: 'Subscription' as const,
        billing: 'Monthly · renews Nov 12',
        amountLabel: `₪${s.ils}`,
        ils: s.ils,
        charges: [renewals[i] as MoneyExpenseCharge],
        notes: [],
      })),
      charges: [...renewals, ...ledger.flatMap((e) => e.charges)],
      total: expenses,
    },
  };
}

/** The Ledger over `data` (`null`: nothing loaded yet) with the Money UI store as it is now. */
async function ledger(data: MoneyResponse | null = monthOf(jobs(26))) {
  const client = createTestQueryClient();
  if (data) client.setQueryData(moneyKey(data.month), data);
  return renderAt('/money', <Ledger />, client);
}

/** The `data-job-id`s of the rows, in the order they are on the page. */
const jobIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);

/** The text of each header cell. */
const headerTexts = (markup: string) =>
  (markup.match(/<th[\s\S]*?<\/th>/g) ?? []).map((th) => th.replace(/<[^>]*>/g, '').trim());

/** The row (`<tr>` to `</tr>`) of the job with this id. */
function row(markup: string, id: string): string {
  return markup.match(new RegExp(`<tr[^>]*data-job-id="${id}"[^>]*>.*?</tr>`, 's'))?.[0] ?? '';
}

/** The text of a row of the Month summary, cells separated by "|". */
function summaryRowText(markup: string, id: string): string {
  const html =
    markup.match(new RegExp(`<div[^>]*data-summary-row="${id}"[^>]*>(.*?)</div>`, 's'))?.[1] ?? '';
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, '|')
    .replace(/\|+/g, '|');
}

/** The whole block of the Month summary. */
function summary(markup: string): string {
  return markup.match(/<div[^>]*aria-label="Month summary"[\s\S]*$/)?.[0] ?? '';
}

describe('<Ledger>: a job that is not delivered yet', () => {
  const idle = (): MoneyLedgerEntry => ({
    jobId: 'idle',
    name: '97 Window Ad',
    client: 'Pinewood',
    clientId: 'c-pinewood',
    deliveredAt: null,
    listedAt: '2026-10-29T09:00:00.000Z',
    paidOn: null,
    archived: false,
    income: 0,
    expenses: 11.57,
    profit: -11.57,
    reviewSec: 0,
    charges: [
      {
        date: '2026-10-26',
        item: 'Higgsfield',
        what: 'Pictures and clips',
        amountLabel: '$3.13',
        ils: 11.57,
        job: 'Pinewood/97 Window Ad',
      },
    ],
  });
  const data = () => monthOf([idle(), ...jobs(3)]);

  it('is a row among the delivered ones, newest first, saying it is not delivered yet', async () => {
    const markup = await ledger(data());
    expect(jobIds(markup)[0]).toBe('idle');
    const idleRow = row(markup, 'idle');
    expect(idleRow).toContain('Not delivered yet');
    expect(idleRow).toContain('₪11.57');
    expect(idleRow).toContain('−₪12');
  });

  it('has no paid day for it, and does not call it owed', async () => {
    const markup = await ledger(data());
    expect(row(markup, 'idle')).toMatch(/data-cell="paid"[^>]*>—</);
  });

  it('counts the delivered jobs apart in the month summary', async () => {
    const markup = await ledger(data());
    expect(markup).toContain('3 delivered · 1 not delivered yet');
  });
});

describe('<Ledger>: the section', () => {
  it('is the section named by its "Ledger" heading, with the one-line description', async () => {
    const markup = await ledger();
    expect(markup).toMatch(/<section[^>]*aria-labelledby="ledger-h"/);
    expect(markup).toMatch(/<h2 id="ledger-h"[^>]*>Ledger<\/h2>/);
    expect(markup).toContain(
      'Every job this month, delivered or not: what it earned, what it cost and what you kept. Open a row for the details.',
    );
  });

  it('is the heading and the switch alone before the first answer, and has no action buttons', async () => {
    const markup = await ledger(null);
    expect(markup).toContain('>Ledger</h2>');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('aria-label="Month summary"');
  });

  it('has a segmented control, "Every job" | "By client", with the first one pressed', async () => {
    const markup = await ledger();
    const group =
      markup.match(/<div[^>]*aria-label="Group the ledger"[^>]*>.*?<\/div>/s)?.[0] ?? '';
    const buttons = group.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons.map((b) => b.replace(/<[^>]*>/g, ''))).toEqual(['Every job', 'By client']);
    expect(buttons[0]).toContain('aria-pressed="true"');
    expect(buttons[1]).toContain('aria-pressed="false"');
  });

  it('remembers By client as the pressed one', async () => {
    moneyUiStore.setState({ grouping: 'client' });
    const markup = await ledger();
    const group =
      markup.match(/<div[^>]*aria-label="Group the ledger"[^>]*>.*?<\/div>/s)?.[0] ?? '';
    const [every, byClient] = group.match(/<button[^>]*>/g) ?? [];
    expect(every).toContain('aria-pressed="false"');
    expect(byClient).toContain('aria-pressed="true"');
  });

  it('uses no blue and no transition other than ease-in-out', async () => {
    const markup = await ledger();
    expect(markup).not.toMatch(/ring-blue|outline-blue|ease-linear|ease-in(?!-out)|ease-out/);
  });
});

describe('<Ledger>: the table', () => {
  it('has the columns Job, Client, Delivered, Paid, Income, Expenses and Profit', async () => {
    expect(headerTexts(await ledger())).toEqual([
      'Job',
      'Client',
      'Delivered',
      'Paid',
      'Income',
      'Expenses',
      'Profit',
    ]);
  });

  it('is sorted by Delivered, newest first, and says so only on that column', async () => {
    const markup = await ledger();
    const headers = markup.match(/<th[\s\S]*?<\/th>/g) ?? [];
    const sort = headers.map((th) => th.match(/aria-sort="(\w+)"/)?.[1]);
    expect(sort).toEqual(['none', 'none', 'descending', 'none', 'none', 'none', 'none']);
    // An arrow on the sorted column only; the others carry the hidden hover arrow.
    expect(headers.filter((th) => /lucide-arrow-down(?!-)/.test(th))).toHaveLength(1);
    expect(headers[2]).toMatch(/lucide-arrow-down(?!-)/);
    for (const i of [0, 1, 3, 4, 5, 6]) {
      expect(headers[i]).toContain('lucide-arrow-up-down');
      expect(headers[i]).toContain('opacity-0');
    }
  });

  it('lists the newest job first and 10 jobs on a page', async () => {
    const ids = jobIds(await ledger());
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe('j00');
    expect(ids[9]).toBe('j09');
  });

  it('puts the money in right-aligned, tabular cells', async () => {
    const markup = await ledger();
    const cells = row(markup, 'j01').match(/<td[^>]*>.*?<\/td>/gs) ?? [];
    expect(cells).toHaveLength(7);
    for (const cell of cells.slice(4)) {
      expect(cell).toContain('text-right');
      expect(cell).toContain('tabular-nums');
    }
    expect(cells[4]).toContain('>₪200<');
    expect(cells[6]).toContain('>₪200<');
  });

  it('shows a muted dash when the job cost nothing, and agorot when it did', async () => {
    const markup = await ledger();
    const free = row(markup, 'j01').match(/<td[^>]*>.*?<\/td>/gs) ?? [];
    expect(free[5]).toContain('>—<');
    expect(free[5]).toContain('text-zinc-500');
    const paid = row(markup, 'j00').match(/<td[^>]*>.*?<\/td>/gs) ?? [];
    expect(paid[5]).toContain('>₪15.00<');
    expect(paid[5]).not.toContain('text-zinc-500');
    expect(paid[6]).toContain('>₪185<');
  });

  it('writes the day it was paid in the Paid column, and a muted "Not yet" while it was not', async () => {
    const markup = await ledger();
    const cell = (id: string) => (row(markup, id).match(/<td[^>]*>.*?<\/td>/gs) ?? [])[3] ?? '';
    // Job 1 was paid on the 30th: plain text, month first, like the Delivered column.
    expect(cell('j01')).toContain('>Oct 30<');
    expect(cell('j01')).not.toContain('text-muted-foreground');
    expect(cell('j01')).toContain('tabular-nums');
    expect(cell('j00')).toContain('>Not yet<');
    expect(cell('j00')).toContain('text-muted-foreground');
    expect(cell('j02')).toContain('>Not yet<');
  });

  it('keeps the Paid column left-aligned, like Delivered, with its header sorting like the others', async () => {
    const markup = await ledger();
    const headers = markup.match(/<th[\s\S]*?<\/th>/g) ?? [];
    expect(headers[3]).not.toContain('justify-end');
    expect(headers[3]).toContain('>Paid<');
    expect(headers[3]).toContain('lucide-arrow-up-down');
  });

  it('writes the delivery as month, day and time', async () => {
    const markup = await ledger();
    const cell = (row(markup, 'j00').match(/<td[^>]*>.*?<\/td>/gs) ?? [])[2] ?? '';
    expect(cell).toMatch(/>Oct 2[78], \d{2}:\d{2}</);
    expect(cell).toContain('text-muted-foreground');
  });

  it('lets Hebrew names read right to left from their own side, flush with the column', async () => {
    const markup = await ledger();
    const hebrew = row(markup, 'j03');
    expect(hebrew).toMatch(/<span[^>]*dir="auto"[^>]*>חלות לשבת<\/span>/);
    expect(hebrew).toContain('class="bidi');
    expect(hebrew).toMatch(/dir="auto"[^>]*>מאפיית הצפון</);
  });

  it('is fixed-width for every column but Job, so the Month summary can line up with it', async () => {
    const markup = await ledger();
    const cols = markup.match(/<col(?=[\s/>])[^>]*>/g) ?? [];
    expect(cols).toHaveLength(7);
    expect(cols.map((c) => c.match(/width:\s*(\d+)px/)?.[1] ?? null)).toEqual([
      null,
      '202',
      '152',
      '112',
      '122',
      '122',
      '128',
    ]);
    expect(markup).toContain('table-fixed');
  });

  it('shows no action buttons: the only buttons are the switch, the sort headers, the row toggles and the pager', async () => {
    const markup = await ledger();
    const labels = (markup.match(/<button[^>]*>.*?<\/button>/gs) ?? []).map((b) => {
      const aria = b.match(/aria-label="([^"]*)"/)?.[1];
      return aria ?? b.replace(/<[^>]*>/g, '').trim();
    });
    for (const label of labels) {
      expect(label).toMatch(
        /^(Every job|By client|Job|Client|Delivered|Paid|Income|Expenses|Profit|(Show|Hide) the money details of .*|Go to .*|Previous|Next|\d+)$/,
      );
    }
  });
});

describe('<Ledger>: the pager', () => {
  it('says which jobs are showing, as the board does ("Showing 1–10 of 26 jobs")', async () => {
    const markup = await ledger();
    expect(markup).toContain('Showing 1–10 of 26 jobs');
    expect(markup).toContain('aria-label="Ledger pages"');
    expect(markup).toContain('aria-label="Go to next page"');
    expect(markup).toContain('aria-label="Go to page 3"');
    expect(markup).toMatch(/aria-label="Go to previous page"[^>]*disabled/);
  });

  it('shows the last, shorter page', async () => {
    moneyUiStore.setState({ ledgerPage: 2 });
    const markup = await ledger();
    expect(markup).toContain('Showing 21–26 of 26 jobs');
    expect(jobIds(markup)).toHaveLength(6);
    expect(markup).toMatch(/aria-label="Go to next page"[^>]*disabled/);
  });

  it('clamps a page past the last one to the last', async () => {
    moneyUiStore.setState({ ledgerPage: 99 });
    const markup = await ledger();
    expect(markup).toContain('Showing 21–26 of 26 jobs');
    expect(jobIds(markup)).toHaveLength(6);
  });

  it('shows one page of fewer than 10 jobs with the pager disabled', async () => {
    const markup = await ledger(monthOf(jobs(3)));
    expect(markup).toContain('Showing 1–3 of 3 jobs');
    expect(markup).toMatch(/aria-label="Go to previous page"[^>]*disabled/);
    expect(markup).toMatch(/aria-label="Go to next page"[^>]*disabled/);
  });
});

describe('<Ledger>: an open job', () => {
  beforeEach(() => {
    moneyUiStore.setState({ open: { kind: 'job', id: 'j00' } });
  });

  it('opens the one job that is the open row, with its toggle expanded and a rotated chevron', async () => {
    const markup = await ledger();
    const open = row(markup, 'j00');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-label="Hide the money details of Job 00"');
    expect(open).toContain('rotate-90');
    expect(open).toContain('ease-in-out');
    for (const id of ['j01', 'j02', 'j05']) {
      expect(row(markup, id)).toContain('aria-expanded="false"');
      expect(row(markup, id)).not.toContain('rotate-90');
    }
    expect((markup.match(/aria-expanded="true"/g) ?? []).length).toBe(1);
    expect((markup.match(/data-detail="income"/g) ?? []).length).toBe(1);
  });

  it('has four columns, each with a small uppercase title', async () => {
    const markup = await ledger();
    const titles = [
      ...markup.matchAll(/<div data-detail="(\w+)"[^>]*><span class="([^"]*)">([^<]*)</g),
    ];
    expect(titles.map((m) => m[3])).toEqual(['Income', 'Expenses', 'Profit', 'Your time']);
    for (const m of titles) expect(m[2]).toContain('uppercase');
    expect(markup).toContain('grid-cols-4');
  });

  it('says the price, the charge groups, the margin and the review time', async () => {
    const markup = await ledger();
    const text = markup
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]*>/g, '|')
      .replace(/\|+/g, '|');
    expect(text).toContain('Price| · your price per job');
    expect(text).toContain('Delivered|');
    expect(text).toContain('Stock footage| · 2 clips at ₪7.50');
    expect(text).toContain('₪15.00');
    expect(text).toContain('Margin');
    expect(text).toContain('93%');
    expect(text).toContain('Review and notes');
    expect(text).toContain('6 min');
    expect(text).toContain('Per hour of your time');
    expect(text).toContain('₪1,850/h');
  });

  it('says after the price when it was delivered and that it is not paid yet, in muted text', async () => {
    const markup = await ledger();
    const income = markup.match(/data-detail="income"[\s\S]*?<div class="mt-auto/)?.[0] ?? '';
    const lines =
      income.match(/<div class="flex justify-between gap-3">.*?<\/span><\/div>/gs) ?? [];
    const text = (html: string) =>
      html
        .replace(/<!-- -->/g, '')
        .replace(/<[^>]*>/g, '|')
        .replace(/\|+/g, '|');
    expect(lines.map(text)).toEqual([
      expect.stringMatching(/^\|Price\| · your price per job\|₪200\|$/),
      expect.stringMatching(/^\|Delivered\|\d{1,2} Oct, \d{2}:\d{2}\|$/),
      '|Paid|Not yet|',
    ]);
    // The labels of both lines are muted; so is "Not yet", but not the date.
    expect(lines[1]).toMatch(/<span class="min-w-0 text-muted-foreground">/);
    expect(lines[1]).not.toMatch(/tabular-nums text-muted-foreground/);
    expect(lines[2]).toMatch(/<span class="min-w-0 text-muted-foreground">/);
    expect(lines[2]).toMatch(/tabular-nums text-muted-foreground">Not yet</);
  });

  it('says the day it was paid, day first, when it was', async () => {
    moneyUiStore.setState({ open: { kind: 'job', id: 'j01' } });
    const markup = await ledger();
    const income = markup.match(/data-detail="income"[\s\S]*?<div class="mt-auto/)?.[0] ?? '';
    const text = income
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]*>/g, '|')
      .replace(/\|+/g, '|');
    expect(text).toContain('|Paid|30 Oct|');
    expect(income).not.toContain('Not yet');
  });

  it('puts every total on one shared bottom line, coloured as the board has them', async () => {
    const markup = await ledger();
    const total = (id: string) =>
      markup.match(
        new RegExp(`data-detail="${id}".*?(<div class="mt-auto[^"]*">.*?</div>)`, 's'),
      )?.[1] ?? '';
    for (const id of ['income', 'expenses', 'profit', 'time']) {
      expect(total(id), id).toContain('mt-auto');
      expect(total(id), id).toContain('border-t');
    }
    expect(total('income')).toMatch(/text-\[#4ADE80\][^>]*>₪200</);
    expect(total('expenses')).toMatch(/text-\[#F87171\][^>]*>₪15\.00</);
    expect(total('profit')).toContain('>₪185.00<');
    expect(total('time')).toContain('>₪1,850/h<');
    expect(markup).toContain('items-stretch');
  });

  it('says "Nothing paid for this job" and greys the total for a job with no charges', async () => {
    moneyUiStore.setState({ open: { kind: 'job', id: 'j01' } });
    const markup = await ledger();
    expect(markup).toContain('Nothing paid for this job');
    const total =
      markup.match(/data-detail="expenses".*?(<div class="mt-auto[^"]*">.*?<\/div>)/s)?.[1] ?? '';
    expect(total).toMatch(/text-\[#A1A1AA\][^>]*>₪0\.00</);
    expect(total).not.toContain('F87171');
  });

  it('has a dash per hour when the job has no review time', async () => {
    const ledgerRows = jobs(3).map((e, i) => (i === 1 ? { ...e, reviewSec: 0 } : e));
    moneyUiStore.setState({ open: { kind: 'job', id: 'j01' } });
    const markup = await ledger(monthOf(ledgerRows));
    const time =
      markup.match(/data-detail="time".*?(<div class="mt-auto[^"]*">.*?<\/div>)/s)?.[1] ?? '';
    expect(time).toContain('>—<');
  });

  it('shows no details when the open row is an expense item, not a job', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'claude' } });
    const markup = await ledger();
    expect(markup).not.toContain('data-detail=');
    expect(markup).not.toContain('aria-expanded="true"');
  });

  it('shows no details when the open job is on another page', async () => {
    moneyUiStore.setState({ ledgerPage: 1 });
    const markup = await ledger();
    expect(markup).not.toContain('data-detail=');
  });
});

describe('<Ledger>: By client', () => {
  beforeEach(() => {
    moneyUiStore.setState({ grouping: 'client' });
  });

  it('shows one header per client, opens the first one, and pages by client', async () => {
    const markup = await ledger();
    expect([...markup.matchAll(/data-client-id="([^"]+)"/g)].map((m) => m[1])).toHaveLength(4);
    // Nothing was chosen, so the first client on the page (Arc Fitness) is open, as on the board.
    expect(jobIds(markup)).toEqual(['j01', 'j05', 'j09', 'j13', 'j17', 'j21', 'j25']);
    expect(markup.match(/data-client-id="c-arc"[^>]*>.*?aria-expanded="(\w+)"/s)?.[1]).toBe('true');
    expect(markup).toContain('Showing 1–4 of 4 clients');
  });

  it('shows no jobs when the open client was closed', async () => {
    moneyUiStore.setState({ clientOpen: null });
    const markup = await ledger();
    expect(jobIds(markup)).toEqual([]);
    expect(markup).not.toContain('aria-expanded="true"');
  });

  it('opens the first client of the page that is showing', async () => {
    const many = jobs(11).map((e, i) => ({ ...e, client: `Client ${i}`, clientId: `c${i}` }));
    moneyUiStore.setState({ ledgerPage: 1 });
    const markup = await ledger(monthOf(many));
    // The second page holds one client; it is open, so its one job shows.
    expect([...markup.matchAll(/data-client-id="([^"]+)"/g)]).toHaveLength(1);
    expect(jobIds(markup)).toHaveLength(1);
  });

  it('puts the client who kept the most first, with the number of jobs and the subtotals', async () => {
    const markup = await ledger();
    const headers = [...markup.matchAll(/<tr[^>]*data-client-id="([^"]+)"[^>]*>.*?<\/tr>/gs)];
    // Arc and Kova have 7 jobs each, but Kova's newest has clips (₪15), so it kept ₪15 less. Lumen
    // and the bakery have 6 and tie, so they go by name (Latin before Hebrew).
    expect(headers.map((m) => m[1])).toEqual(['c-arc', 'c-kova', 'c-lumen', 'c-bakery']);
    const text = (html: string) => html.replace(/<[^>]*>/g, '|').replace(/\|+/g, '|');
    expect(text(headers[0]?.[0] ?? '')).toContain('Arc Fitness|7 jobs|');
    expect(text(headers[0]?.[0] ?? '')).toContain('|₪1,400|₪0|₪1,400|');
    expect(text(headers[1]?.[0] ?? '')).toContain('Kova Coffee|7 jobs|');
    expect(text(headers[1]?.[0] ?? '')).toContain('|₪1,400|₪15|₪1,385|');
    expect(text(headers[2]?.[0] ?? '')).toContain('Lumen Yoga|6 jobs|');
    expect(text(headers[2]?.[0] ?? '')).toContain('|₪1,200|₪0|₪1,200|');
  });

  it('keeps a client header to the table’s seven cells: nothing under Delivered or Paid, the subtotals under the money', async () => {
    const markup = await ledger();
    const header = markup.match(/<tr[^>]*data-client-id="c-arc"[^>]*>.*?<\/tr>/s)?.[0] ?? '';
    const cells = header.match(/<td[^>]*>.*?<\/td>/gs) ?? [];
    expect(cells).toHaveLength(7);
    const plain = cells.map((cell) => cell.replace(/<[^>]*>/g, '').trim());
    expect(plain.slice(1)).toEqual(['7 jobs', '', '', '₪1,400', '₪0', '₪1,400']);
  });

  it('makes a client header 44 px high, a job row 45 (the board’s line is inside the header)', async () => {
    const markup = await ledger();
    const header = markup.match(/<tr[^>]*data-client-id="c-arc"[^>]*>/)?.[0] ?? '';
    expect(header).toContain('h-11');
    expect(header).not.toContain('h-[45px]');
    expect(row(markup, 'j01')).toContain('h-[45px]');
  });

  it('puts a dot in the colour of the client’s avatar on the left of the name, in a left-to-right pair', async () => {
    const markup = await ledger();
    const header = markup.match(/<tr[^>]*data-client-id="c-bakery"[^>]*>.*?<\/tr>/s)?.[0] ?? '';
    expect(header).toContain(`background-color:${clientDotColor('מאפיית הצפון')}`);
    expect(header).toMatch(
      /<span dir="ltr"[^>]*><span aria-hidden="true"[^>]*><\/span><span dir="auto"[^>]*>מאפיית הצפון<\/span>/,
    );
  });

  it('opens one client at a time, with its jobs indented under it', async () => {
    moneyUiStore.setState({ clientOpen: 'c-arc' });
    const markup = await ledger();
    const open = markup.match(/<tr[^>]*data-client-id="c-arc"[^>]*>.*?<\/tr>/s)?.[0] ?? '';
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('rotate-90');
    expect(markup.match(/data-client-id="c-kova"[^>]*>.*?aria-expanded="(\w+)"/s)?.[1]).toBe(
      'false',
    );
    const ids = jobIds(markup);
    // Arc Fitness has jobs 01, 05, 09, 13, 17, 21, 25: all of them, newest first.
    expect(ids).toEqual(['j01', 'j05', 'j09', 'j13', 'j17', 'j21', 'j25']);
    expect(row(markup, 'j01')).toContain('pl-6');
  });

  it('opens a job under a client, and only that one', async () => {
    moneyUiStore.setState({ clientOpen: 'c-kova', open: { kind: 'job', id: 'j00' } });
    const markup = await ledger();
    expect(row(markup, 'j00')).toContain('aria-expanded="true"');
    expect((markup.match(/data-detail="income"/g) ?? []).length).toBe(1);
  });

  it('pages by client: eleven clients make a second page of one', async () => {
    const many = jobs(11).map((e, i) => ({ ...e, client: `Client ${i}`, clientId: `c${i}` }));
    moneyUiStore.setState({ ledgerPage: 1 });
    const markup = await ledger(monthOf(many));
    expect(markup).toContain('Showing 11–11 of 11 clients');
    expect([...markup.matchAll(/data-client-id="([^"]+)"/g)]).toHaveLength(1);
  });
});

describe('<Ledger>: an empty month', () => {
  it('says "No jobs in October." under the headers, with no pager', async () => {
    const markup = await ledger(monthOf([], []));
    expect(markup).toContain('No jobs in October.');
    expect(headerTexts(markup)).toHaveLength(7);
    expect(markup).not.toContain('Go to next page');
    expect(markup).not.toContain('aria-label="Month summary"');
  });

  it('still shows the Month summary when a subscription was paid, so the loss is explained', async () => {
    const markup = await ledger(monthOf([]));
    expect(markup).toContain('No jobs in October.');
    expect(summary(markup)).toContain('Monthly subscriptions');
  });

  it('says the month by its name', async () => {
    const data = { ...monthOf([], []), month: '2026-09' };
    moneyUiStore.setState({ month: '2026-09' });
    expect(await ledger(data)).toContain('No jobs in September.');
  });
});

describe('<Ledger>: the Month summary', () => {
  it('is a separate tinted block with its own border and a gap above, not rows of the table', async () => {
    const markup = await ledger();
    const block = markup.match(/<div[^>]*aria-label="Month summary"[^>]*>/)?.[0] ?? '';
    expect(block).toContain('border');
    expect(block).toContain('bg-white/[0.035]');
    expect(block).toContain('mt-2.5');
    expect(block).toContain('rounded-[10px]');
    // After the table's frame and the pager, outside the <table>.
    expect(markup.indexOf('aria-label="Month summary"')).toBeGreaterThan(
      markup.indexOf('</table>'),
    );
    expect(markup.indexOf('aria-label="Month summary"')).toBeGreaterThan(
      markup.indexOf('1–10 of 26 jobs'),
    );
  });

  it('is titled "October summary" with small uppercase Income, Expenses and Profit labels', async () => {
    const block = summary(await ledger());
    expect(block).toMatch(/<span class="col-span-4">October summary<\/span>/);
    const header = block.match(/<div[^>]*uppercase[^>]*>.*?<\/div>/s)?.[0] ?? '';
    expect(header.replace(/<[^>]*>/g, '|').replace(/\|+/g, '|')).toBe(
      '|October summary|Income|Expenses|Profit|',
    );
    expect(header).toContain('text-xs');
  });

  it('uses the same columns as the table, so its amounts sit under Income, Expenses and Profit', async () => {
    const block = summary(await ledger());
    const grids = block.match(/grid-template-columns:\s*([^;"]+)/g) ?? [];
    expect(grids.length).toBeGreaterThan(3);
    for (const grid of grids) expect(grid).toContain(LEDGER_GRID_TEMPLATE);
  });

  it('has the board’s row heights: 40, 56 for the line with its list, and 53 for the profit line', async () => {
    const block = summary(await ledger());
    const rowOf = (id: string) =>
      block.match(new RegExp(`<div[^>]*data-summary-row="${id}"[^>]*>`))?.[0] ?? '';
    expect(rowOf('jobs')).toContain('min-h-10');
    expect(rowOf('subscriptions')).toContain('min-h-14');
    expect(block).toContain('min-h-[53px]');
  });

  it('says how many jobs were delivered, and the jobs’ income, expenses and profit', async () => {
    const block = summary(await ledger());
    expect(summaryRowText(block, 'jobs')).toBe(
      '|Jobs| · 26 delivered · 25 not paid yet (₪5,000)|₪5,200|₪15|₪5,185|',
    );
  });

  it('leaves out "not paid yet" when every job is paid', async () => {
    const allPaid = jobs(3).map((e) => ({ ...e, paidOn: '2026-10-30' }));
    const block = summary(await ledger(monthOf(allPaid)));
    expect(summaryRowText(block, 'jobs')).toBe('|Jobs| · 3 delivered|₪600|₪15|₪585|');
  });

  it('says "1 not paid yet" for the one that is owed', async () => {
    const one = jobs(3).map((e, i) => (i === 2 ? e : { ...e, paidOn: '2026-10-30' }));
    const block = summary(await ledger(monthOf(one)));
    expect(summaryRowText(block, 'jobs')).toContain(' · 3 delivered · 1 not paid yet (₪200)');
  });

  it('keeps the Month summary’s label across the four columns before Income, so the amounts stay under the table’s', async () => {
    const block = summary(await ledger());
    const labels = block.match(/<span class="col-span-\d[^"]*">/g) ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const label of labels) expect(label).toContain('col-span-4');
  });

  it('lists the monthly subscriptions that no job carries, with a dash, their total and minus it', async () => {
    const block = summary(await ledger());
    expect(summaryRowText(block, 'subscriptions')).toBe(
      '|Monthly subscriptions|Not charged to a job: Claude plan ₪740 · ElevenLabs ₪81|—|₪821|−₪821|',
    );
    expect(block).toMatch(/<span dir="auto" class="text-xs text-muted-foreground">Not charged/);
  });

  it('ends with "Profit this month", the Profit banner’s number at 18 px, green', async () => {
    const markup = await ledger();
    const block = summary(markup);
    expect(block).toContain('Profit this month');
    const profit = block.match(/<span data-summary-profit=""[^>]*>([^<]*)<\/span>/);
    expect(profit?.[1]).toBe('₪4,364');
    expect(profit?.[0]).toContain('text-[18px]');
    expect(profit?.[0]).toContain('font-bold');
    expect(profit?.[0]).toContain('text-[#4ADE80]');
    expect(block).toMatch(/border-t border-white\/\[0\.14\]/);
  });

  it('shows the same profit as the Profit banner', async () => {
    const data = monthOf(jobs(26));
    const profit = data.banners.profit.value;
    expect(profit).toBeCloseTo(5200 - 15 - 821.4, 5);
    const block = summary(await ledger(data));
    expect(block).toContain('>₪4,364<');
  });

  it('turns the profit red below zero', async () => {
    const data = monthOf(jobs(2), [{ id: 'claude', name: 'Claude plan', ils: 740 }]);
    const block = summary(await ledger(data));
    const profit = block.match(/<span data-summary-profit=""[^>]*>([^<]*)<\/span>/);
    expect(profit?.[1]).toBe('−₪355');
    expect(profit?.[0]).toContain('text-[#F87171]');
    expect(profit?.[0]).not.toContain('4ADE80');
  });

  it('adds the muted reconciling line when the rows do not add up to the banners', async () => {
    const data = monthOf(jobs(2));
    const off: MoneyResponse = {
      ...data,
      banners: {
        ...data.banners,
        expenses: { ...data.banners.expenses, value: data.banners.expenses.value + 7.5 },
        profit: { ...data.banners.profit, value: data.banners.profit.value - 7.5 },
      },
    };
    const block = summary(await ledger(off));
    expect(block).toContain('Job costs paid in another month');
    expect(block).toMatch(/<div[^>]*text-muted-foreground[^>]*data-summary-row="adjustment"/);
  });

  it('follows the month: September has a September summary', async () => {
    const data = { ...monthOf(jobs(3)), month: '2026-09' };
    moneyUiStore.setState({ month: '2026-09' });
    expect(summary(await ledger(data))).toContain('September summary');
  });
});

describe('the Ledger and the store', () => {
  const newStore = () => createMoneyUiStore(createMemoryStorage(), '2026-10');

  it('opens a job, then an expense item: the job closes', () => {
    const store = newStore();
    store.getState().toggleOpen({ kind: 'job', id: 'j00' });
    expect(store.getState().open).toEqual({ kind: 'job', id: 'j00' });
    store.getState().toggleOpen({ kind: 'item', id: 'claude' });
    expect(store.getState().open).toEqual({ kind: 'item', id: 'claude' });
    store.getState().toggleOpen({ kind: 'job', id: 'j01' });
    expect(store.getState().open).toEqual({ kind: 'job', id: 'j01' });
  });

  it('closes a job by clicking it again', () => {
    const store = newStore();
    store.getState().toggleOpen({ kind: 'job', id: 'j00' });
    store.getState().toggleOpen({ kind: 'job', id: 'j00' });
    expect(store.getState().open).toBeNull();
  });

  it('opens one client at a time', () => {
    const store = newStore();
    store.getState().setClientOpen('c-kova');
    store.getState().setClientOpen('c-arc');
    expect(store.getState().clientOpen).toBe('c-arc');
    store.getState().setClientOpen(null);
    expect(store.getState().clientOpen).toBeNull();
  });

  it('starts the pages over when the grouping changes', () => {
    const store = newStore();
    store.getState().setLedgerPage(2);
    store.getState().setGrouping('client');
    expect(store.getState()).toMatchObject({ grouping: 'client', ledgerPage: 0 });
  });
});
