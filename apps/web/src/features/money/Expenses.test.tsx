import type { MoneyExpenseCharge, MoneyExpenseItem, MoneyResponse } from '@studio/shared';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { moneyKey } from '@/data/money-query';
import { createTestQueryClient, makeMoneyResponse } from '@/data/test-utils';
import { renderApp, renderAt } from '@/lib/test-router';
import { createMemoryStorage } from '@/stores/jobs-ui';
import { createMoneyUiStore, defaultMoneyUiState, moneyUiStore } from '@/stores/money-ui';
import { ExpenseItemRow } from './ExpenseItemRow';
import { Expenses } from './Expenses';

// The Money page's store is the app's one, so every test starts it on October 2026 again.
beforeAll(() => {
  // zustand's server render reads the store's initial state; point it at the current one.
  moneyUiStore.getInitialState = () => moneyUiStore.getState();
});
beforeEach(() => {
  moneyUiStore.setState(defaultMoneyUiState('2026-10'));
});

// ---- A month of expenses: four subscriptions and eight stock clips, 12 payments in all ----

const monthly = (day: string, item: string, amountLabel: string, ils: number) => ({
  date: `2026-10-${day}`,
  item,
  what: 'Monthly plan',
  amountLabel,
  ils,
  job: null,
});

const CLIP_JOBS = [
  'Kova Coffee/Barista reel',
  'Lumen Yoga/Retreat teaser',
  'מאפיית הצפון/חלות לשבת',
  'Arc Fitness/Coach intro',
  'Kova Coffee/Autumn menu',
  'Lumen Yoga/Studio tour',
  'Noa Ceramics/Wheel session',
  'Arc Fitness/Member story',
];

const clips: MoneyExpenseCharge[] = CLIP_JOBS.map((job, i) => ({
  date: `2026-10-${String(14 + i).padStart(2, '0')}`,
  item: 'Stock footage',
  what: `Clip licence #${4831 + i * 7}`,
  amountLabel: '₪7.50',
  ils: 7.5,
  job,
}));

const claudeCharge = monthly('12', 'Claude Max plan', '$200.00', 740);
const elevenCharge = monthly('03', 'ElevenLabs Creator plan', '$22.00', 81.4);
const musicCharge = monthly('08', 'Music library', '₪49.00', 49);
const fontsCharge = monthly('05', 'Fonts', '₪30.00', 30);

const CLAUDE_ITEM: MoneyExpenseItem = {
  id: 'claude',
  name: 'Claude Max plan',
  kind: 'Subscription',
  billing: 'Monthly · renews Nov 12',
  amountLabel: '$200.00',
  ils: 740,
  charges: [claudeCharge],
  notes: [],
};
const ELEVEN_ITEM: MoneyExpenseItem = {
  id: 'eleven',
  name: 'ElevenLabs Creator plan',
  kind: 'Subscription',
  billing: 'Monthly · renews Nov 3',
  amountLabel: '$22.00',
  ils: 81.4,
  charges: [elevenCharge],
  notes: ['38,200 of 100,000 credits used: 124 min transcribed for 26 jobs.'],
};
const MUSIC_ITEM: MoneyExpenseItem = {
  id: 'music',
  name: 'Music library',
  kind: 'Subscription',
  billing: 'Monthly · renews Nov 8',
  amountLabel: '₪49.00',
  ils: 49,
  charges: [musicCharge],
  notes: [],
};
const FONTS_ITEM: MoneyExpenseItem = {
  id: 'fonts',
  name: 'Fonts',
  kind: 'Subscription',
  billing: 'Monthly · renews Nov 5',
  amountLabel: '₪30.00',
  ils: 30,
  charges: [fontsCharge],
  notes: [],
};
const STOCK_ITEM: MoneyExpenseItem = {
  id: 'use:Stock footage',
  name: 'Stock footage',
  kind: 'Per use',
  billing: '₪7.50 per clip',
  amountLabel: '8 clips',
  ils: 60,
  charges: clips,
  notes: [],
};
const ITEMS = [CLAUDE_ITEM, ELEVEN_ITEM, MUSIC_ITEM, FONTS_ITEM, STOCK_ITEM];

/** The month's payments the way the API lists them: by date. */
const CHARGES = [elevenCharge, fontsCharge, musicCharge, claudeCharge, ...clips].sort((a, b) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
);

function makeData(expenses: Partial<MoneyResponse['expenses']> = {}, month = '2026-10') {
  return makeMoneyResponse({
    month,
    expenses: {
      items: ITEMS,
      charges: CHARGES,
      total: 960.4,
      usdToIls: 3.7,
      ...expenses,
    },
  });
}

/** The Expenses section as the server renders it, over `data` (`null`: nothing loaded yet). */
async function expenses(data: MoneyResponse | null = makeData()): Promise<string> {
  const client = createTestQueryClient();
  if (data) client.setQueryData(moneyKey(data.month), data);
  const markup = await renderAt('/money', <Expenses />, client);
  return section(markup);
}

function section(markup: string): string {
  return markup.match(/<section[^>]*aria-labelledby="exp-h"[^>]*>.*?<\/section>/s)?.[0] ?? '';
}

/** The visible words of some markup, tags removed. */
function words(markup: string): string {
  return markup.replace(/<[^>]*>/g, '');
}

function bodyOf(markup: string): string {
  return markup.match(/<tbody[^>]*>(.*?)<\/tbody>/s)?.[1] ?? '';
}

function rowsIn(markup: string): string[] {
  return [...bodyOf(markup).matchAll(/<tr[^>]*>.*?<\/tr>/gs)].map((m) => m[0]);
}

/** The header cells' text, in order. */
function headers(markup: string): string[] {
  const head = markup.match(/<thead[^>]*>(.*?)<\/thead>/s)?.[1] ?? '';
  return [...head.matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map((m) => words(m[1] ?? ''));
}

/** The whole details row of the open item `id`. */
function detailsOf(markup: string, id: string): string {
  const row = new RegExp(`<tr[^>]*data-item-details="${id}"[^>]*>.*?</tr>`, 's');
  return markup.match(row)?.[0] ?? '';
}

function openButtons(markup: string): number {
  return (markup.match(/aria-expanded="true"/g) ?? []).length;
}

/** The widths the `<colgroup>` gives, in px, `null` for a column that takes what is left. */
function columnWidths(markup: string): Array<string | null> {
  const group = markup.match(/<colgroup>.*?<\/colgroup>/s)?.[0] ?? '';
  return [...group.matchAll(/<col(?=[\s/>])([^>]*)>/g)].map(
    (m) => m[1]?.match(/width:\s*(\d+)px/)?.[1] ?? null,
  );
}

describe('<Expenses> the board’s measures', () => {
  it('Items: the board’s columns plus the gaps, so the figures sit where the board has them', async () => {
    // The board: 130 · 220 · 110 · 110 with 12 px between and 12 px at the frame's edge.
    expect(columnWidths(await expenses())).toEqual([null, '142', '232', '122', '128']);
  });

  it('All charges: the same, with the date column the board’s 110 px plus its gaps', async () => {
    moneyUiStore.setState({ expensesView: 'charges' });
    expect(columnWidths(await expenses())).toEqual(['128', null, null, '122', '128']);
  });

  it('makes every row and the footer 45 px, as the board does (44 and its line)', async () => {
    const items = await expenses();
    expect(rowsIn(items).every((row) => row.includes('h-[45px]'))).toBe(true);
    expect(items.match(/<tfoot[^>]*>.*?<\/tfoot>/s)?.[0]).toContain('h-[45px]');
    moneyUiStore.setState({ expensesView: 'charges' });
    const charges = await expenses();
    expect(rowsIn(charges).every((row) => row.includes('h-[45px]'))).toBe(true);
    expect(charges.match(/<tfoot[^>]*>.*?<\/tfoot>/s)?.[0]).toContain('h-[45px]');
  });

  it('has the switch the way the Ledger’s is: a 29 px chosen button raised on the page colour', async () => {
    const markup = await expenses();
    const triggers = [...markup.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger).toContain('h-[29px]');
      expect(trigger).toContain('data-[state=active]:bg-background');
      expect(trigger).not.toContain('data-[state=active]:bg-input/30');
    }
  });

  it('says the range under the table with "Showing", in a pager named "Expense pages"', async () => {
    const markup = await expenses();
    expect(markup).toContain('Showing 1–5 of 5 items');
    expect(markup).toContain('aria-label="Expense pages"');
  });
});

describe('<Expenses> header', () => {
  it('is the section "Expenses", with the line about what it holds and the rate of the answer', async () => {
    const markup = await expenses();
    expect(markup).toMatch(/<h2 id="exp-h"[^>]*>Expenses<\/h2>/);
    expect(markup).toContain(
      'Everything you actually paid this month: subscriptions and usage charges. Dollar amounts are converted at ₪3.70.',
    );
    const other = await expenses(makeData({ usdToIls: 3.41 }));
    expect(other).toContain('converted at ₪3.41.');
  });

  it('has the switch "Items" | "All charges" at the right, Items picked at first', async () => {
    const markup = await expenses();
    expect(markup).toMatch(/<div[^>]*role="tablist"[^>]*aria-label="Show expenses as"/);
    const tabs = [...markup.matchAll(/<button([^>]*role="tab"[^>]*)>(.*?)<\/button>/gs)].map(
      (m) => ({ label: m[2], selected: /aria-selected="true"/.test(m[1] ?? '') }),
    );
    expect(tabs).toEqual([
      { label: 'Items', selected: true },
      { label: 'All charges', selected: false },
    ]);
    expect(markup.indexOf('>Expenses</h2>')).toBeLessThan(markup.indexOf('role="tablist"'));
  });

  it('picks All charges when that is what the store remembers', async () => {
    moneyUiStore.setState({ expensesView: 'charges' });
    const markup = await expenses();
    expect(markup).toMatch(/aria-selected="true"[^>]*>All charges</);
    expect(markup).not.toMatch(/aria-selected="true"[^>]*>Items</);
  });

  it('shows only the heading until the first answer is in', async () => {
    const markup = await expenses(null);
    expect(markup).toMatch(/<h2 id="exp-h"[^>]*>Expenses<\/h2>/);
    expect(markup).not.toContain('Everything you actually paid');
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('<table');
  });
});

describe('<Expenses> Items view', () => {
  it('has the columns Item · Kind · Billing · Amount · This month', async () => {
    expect(headers(await expenses())).toEqual(['Item', 'Kind', 'Billing', 'Amount', 'This month']);
  });

  it('has no sort arrows: the list is not sortable', async () => {
    const head = (await expenses()).match(/<thead[^>]*>.*?<\/thead>/s)?.[0] ?? '';
    expect(head).not.toContain('<button');
    expect(head).not.toContain('<svg');
  });

  it('lists every item with its kind, billing, amount and this month to the agora', async () => {
    const rows = rowsIn(await expenses()).map(words);
    expect(rows).toEqual([
      'Claude Max planSubscriptionMonthly · renews Nov 12$200.00₪740.00',
      'ElevenLabs Creator planSubscriptionMonthly · renews Nov 3$22.00₪81.40',
      'Music librarySubscriptionMonthly · renews Nov 8₪49.00₪49.00',
      'FontsSubscriptionMonthly · renews Nov 5₪30.00₪30.00',
      'Stock footagePer use₪7.50 per clip8 clips₪60.00',
    ]);
  });

  it('has every row closed, each with a button that says what opening it shows', async () => {
    const markup = await expenses();
    expect(openButtons(markup)).toBe(0);
    expect((markup.match(/aria-expanded="false"/g) ?? []).length).toBe(5);
    expect(markup).toContain('aria-label="Show the charges of Claude Max plan"');
    expect(markup).toContain('aria-label="Show the charges of Stock footage"');
    expect(markup).not.toContain('data-item-details');
  });

  it('puts the footer under the rows: the count, then the month’s total to the agora', async () => {
    const markup = await expenses();
    const foot = markup.match(/<tfoot[^>]*>.*?<\/tfoot>/s)?.[0] ?? '';
    expect(words(foot)).toBe('5 items · total this month₪960.40');
    expect(foot).toContain('font-semibold');
  });

  it('says which items are showing, in the pager', async () => {
    const markup = await expenses();
    expect(words(markup.match(/<span[^>]*aria-live[^>]*>.*?<\/span>/s)?.[0] ?? '')).toBe(
      'Showing 1–5 of 5 items',
    );
    expect(markup).toContain('aria-label="Expense pages"');
  });

  it('makes the amounts tabular and the item names direction-aware', async () => {
    const [claude = ''] = rowsIn(await expenses());
    expect(claude).toMatch(/<td[^>]*tabular-nums[^>]*>\$200\.00<\/td>/);
    expect(claude).toMatch(/<td[^>]*tabular-nums[^>]*>₪740\.00<\/td>/);
    expect(claude).toMatch(/<span dir="auto"[^>]*>Claude Max plan<\/span>/);
  });

  it('reads a Hebrew name right to left, from its own direction', async () => {
    const hebrew: MoneyExpenseItem = {
      ...MUSIC_ITEM,
      id: 'music-he',
      name: 'ספריית מוזיקה',
    };
    const markup = await expenses(makeData({ items: [hebrew] }));
    expect(markup).toMatch(
      /<span dir="auto"[^>]*unicode-bidi:plaintext[^>]*>ספריית מוזיקה<\/span>/,
    );
  });

  it('opens a row anywhere: the name button stretches over the row, with a pointer and no ring of its own', async () => {
    const [claude = ''] = rowsIn(await expenses());
    const button = claude.match(/<button[^>]*>/)?.[0] ?? '';
    expect(button).toContain('after:absolute');
    expect(button).toContain('after:inset-0');
    expect(button).toContain('outline-none');
    expect(claude).toMatch(/<tr[^>]*relative/);
    // The grey keyboard-only line, as the Clients rows have it; never a blue ring.
    expect(claude).toContain('has-[button:focus-visible]:outline-foreground/30');
    expect(claude).not.toMatch(/blue/);
  });

  it('has no way to edit anything: no inputs, forms or action buttons', async () => {
    const markup = await expenses();
    expect(markup).not.toMatch(/<(input|form|textarea|select)/);
    const labels = [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((m) =>
      words(m[1] ?? ''),
    );
    expect(labels.filter((label) => /edit|delete|remove|add|save|new/i.test(label))).toEqual([]);
  });
});

describe('<Expenses> an open item', () => {
  it('shows the charges of the open item: date, what for, amount paid, in shekels', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'claude' } });
    const markup = await expenses();
    expect(openButtons(markup)).toBe(1);
    expect(markup).toContain('aria-label="Hide the charges of Claude Max plan"');
    const details = markup.match(/<tr[^>]*data-item-details="claude"[^>]*>.*?<\/tr>/s)?.[0] ?? '';
    expect(words(details)).toBe('Oct 12Monthly plan$200.00₪740.00');
    // Under its row, one cell across the table.
    expect(details).toContain('colSpan="5"');
    expect(markup.indexOf('data-item-id="claude"')).toBeLessThan(
      markup.indexOf('data-item-details'),
    );
  });

  it('turns the chevron of the open row, easing in and out', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'claude' } });
    const markup = await expenses();
    const [claude = '', eleven = ''] = rowsIn(markup);
    expect(claude).toContain('rotate-90');
    expect(claude).toContain('ease-in-out');
    expect(eleven).not.toContain('rotate-90');
  });

  it('shows an item’s notes under its charges', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'eleven' } });
    const details = detailsOf(await expenses(), 'eleven');
    expect(words(details)).toBe(
      'Oct 3Monthly plan$22.00₪81.4038,200 of 100,000 credits used: 124 min transcribed for 26 jobs.',
    );
  });

  it('says "for <Job>" after what a per-use charge was for, with the job folder’s name', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'use:Stock footage' } });
    const markup = await expenses();
    const details = detailsOf(markup, 'use:Stock footage');
    expect(words(details)).toContain('Clip licence #4831 · for Barista reel');
    expect(words(details)).toContain('Clip licence #4838 · for Retreat teaser');
    // The client is not part of it.
    expect(words(details)).not.toContain('Kova Coffee');
    // Eight charges, ₪7.50 each, in the currency paid and in shekels.
    expect((details.match(/₪7\.50/g) ?? []).length).toBe(16);
  });

  it('reads a Hebrew job name on its own, so the dots and the English around it keep their order', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'use:Stock footage' } });
    const details = detailsOf(await expenses(), 'use:Stock footage');
    expect(details).toContain('<bdi>Clip licence #4845</bdi> · for <bdi>חלות לשבת</bdi>');
  });

  it('writes a note on its own line, direction-aware', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'eleven' } });
    const markup = await expenses();
    expect(markup).toMatch(/<span dir="auto"[^>]*>38,200 of 100,000 credits used/);
  });

  it('says so when an open item has no charges and no notes', async () => {
    const bare: MoneyExpenseItem = { ...CLAUDE_ITEM, charges: [], notes: [] };
    moneyUiStore.setState({ open: { kind: 'item', id: 'claude' } });
    const markup = await expenses(makeData({ items: [bare] }));
    expect(markup).toContain('No charges this month.');
  });

  it('keeps every other row closed', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'music' } });
    const markup = await expenses();
    expect((markup.match(/aria-expanded="false"/g) ?? []).length).toBe(4);
    expect(markup.match(/data-item-details/g)).toHaveLength(1);
  });

  it('opens nothing when the open row is a ledger job', async () => {
    moneyUiStore.setState({ open: { kind: 'job', id: 'claude' } });
    const markup = await expenses();
    expect(openButtons(markup)).toBe(0);
    expect(markup).not.toContain('data-item-details');
  });

  it('opens nothing when the open item is not in this month', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'gone' } });
    expect(openButtons(await expenses())).toBe(0);
  });
});

describe('<Expenses> one open row on the whole page', () => {
  it('closes an open Ledger job when an item is opened', () => {
    const store = createMoneyUiStore(createMemoryStorage(), '2026-10');
    store.getState().toggleOpen({ kind: 'job', id: 'a1' });
    expect(store.getState().open).toEqual({ kind: 'job', id: 'a1' });
    store.getState().toggleOpen({ kind: 'item', id: 'claude' });
    expect(store.getState().open).toEqual({ kind: 'item', id: 'claude' });
  });

  it('closes the open item again with a second click, and when a job is opened', () => {
    const store = createMoneyUiStore(createMemoryStorage(), '2026-10');
    store.getState().toggleOpen({ kind: 'item', id: 'claude' });
    store.getState().toggleOpen({ kind: 'item', id: 'claude' });
    expect(store.getState().open).toBeNull();
    store.getState().toggleOpen({ kind: 'item', id: 'claude' });
    store.getState().toggleOpen({ kind: 'job', id: 'a1' });
    expect(store.getState().open).toEqual({ kind: 'job', id: 'a1' });
  });

  it('shows the item opened in the store and no ledger job, then the other way round', async () => {
    moneyUiStore.getState().toggleOpen({ kind: 'job', id: 'a1' });
    expect(openButtons(await expenses())).toBe(0);
    moneyUiStore.getState().toggleOpen({ kind: 'item', id: 'fonts' });
    const markup = await expenses();
    expect(openButtons(markup)).toBe(1);
    expect(markup).toContain('aria-label="Hide the charges of Fonts"');
    moneyUiStore.getState().toggleOpen({ kind: 'job', id: 'a2' });
    expect(openButtons(await expenses())).toBe(0);
  });

  it('is what clicking a row does: it asks to toggle that item and nothing else', () => {
    const onToggle = vi.fn();
    const row = ExpenseItemRow({ item: CLAUDE_ITEM, open: false, onToggle });
    const buttons = elementsOf(row, 'button');
    // One button on the row, and the details row (closed) has none.
    expect(buttons).toHaveLength(1);
    for (const button of buttons) (button.props as { onClick: () => void }).onClick();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('starts the view over from the first page when it is switched', () => {
    const store = createMoneyUiStore(createMemoryStorage(), '2026-10');
    store.getState().setExpensesPage(1);
    store.getState().setExpensesView('charges');
    expect(store.getState()).toMatchObject({ expensesView: 'charges', expensesPage: 0 });
  });
});

/** Every element of type `tag` under `node`, in order. Function components are not called, only their children read. */
function elementsOf(node: ReactNode, tag: string): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => elementsOf(child, tag));
  if (!isValidElement(node)) return [];
  const own = node.type === tag ? [node] : [];
  return [...own, ...elementsOf((node.props as { children?: ReactNode }).children, tag)];
}

describe('<Expenses> All charges view', () => {
  beforeEach(() => {
    moneyUiStore.setState({ expensesView: 'charges' });
  });

  it('has the columns Date · Item · What for · Amount · In ₪', async () => {
    expect(headers(await expenses())).toEqual(['Date', 'Item', 'What for', 'Amount', 'In ₪']);
  });

  it('lists the payments by date, the earliest first, ten to a page', async () => {
    const rows = rowsIn(await expenses()).map(words);
    expect(rows).toHaveLength(10);
    expect(rows.slice(0, 5)).toEqual([
      'Oct 3ElevenLabs Creator planMonthly plan$22.00₪81.40',
      'Oct 5FontsMonthly plan₪30.00₪30.00',
      'Oct 8Music libraryMonthly plan₪49.00₪49.00',
      'Oct 12Claude Max planMonthly plan$200.00₪740.00',
      'Oct 14Stock footageClip licence #4831 · for Barista reel₪7.50₪7.50',
    ]);
  });

  it('sorts by date even if the answer did not', async () => {
    const markup = await expenses(makeData({ charges: [...CHARGES].reverse() }));
    const dates = rowsIn(markup).map((row) => words(row).match(/^[A-Z][a-z]{2} \d+/)?.[0]);
    expect(dates).toEqual([
      'Oct 3',
      'Oct 5',
      'Oct 8',
      'Oct 12',
      'Oct 14',
      'Oct 15',
      'Oct 16',
      'Oct 17',
      'Oct 18',
      'Oct 19',
    ]);
  });

  it('reads a per-job charge as "Clip licence #4831 · for Retreat teaser"', async () => {
    const markup = await expenses();
    expect(words(markup)).toContain('Clip licence #4838 · for Retreat teaser');
  });

  it('shows the amount as paid and the shekels to the agora, both tabular', async () => {
    const [, , , claude = ''] = rowsIn(await expenses());
    expect(claude).toMatch(/<td[^>]*tabular-nums[^>]*>\$200\.00<\/td>/);
    expect(claude).toMatch(/<td[^>]*tabular-nums[^>]*>₪740\.00<\/td>/);
  });

  it('puts the footer under the rows: how many charges, and the month’s total', async () => {
    const foot = (await expenses()).match(/<tfoot[^>]*>.*?<\/tfoot>/s)?.[0] ?? '';
    expect(words(foot)).toBe('12 charges · total this month₪960.40');
  });

  it('says which charges are showing: "Showing 1–10 of 12 charges"', async () => {
    const markup = await expenses();
    expect(words(markup.match(/<span[^>]*aria-live[^>]*>.*?<\/span>/s)?.[0] ?? '')).toBe(
      'Showing 1–10 of 12 charges',
    );
    expect(markup).toContain('aria-label="Go to page 2"');
    expect(markup).not.toContain('aria-label="Go to page 3"');
  });

  it('shows the second page with the last two charges', async () => {
    moneyUiStore.setState({ expensesPage: 1 });
    const markup = await expenses();
    const rows = rowsIn(markup).map(words);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^Oct 20/);
    expect(rows[1]).toMatch(/^Oct 21/);
    expect(words(markup.match(/<span[^>]*aria-live[^>]*>.*?<\/span>/s)?.[0] ?? '')).toBe(
      'Showing 11–12 of 12 charges',
    );
    expect(markup).toMatch(
      /aria-current="page"[^>]*aria-label="Go to page 2"|aria-label="Go to page 2"[^>]*aria-current="page"/,
    );
  });

  it('clamps a page past the last to the last', async () => {
    moneyUiStore.setState({ expensesPage: 9 });
    const markup = await expenses();
    expect(rowsIn(markup)).toHaveLength(2);
    expect(words(markup)).toContain('Showing 11–12 of 12 charges');
  });

  it('shows no item open or closed: the rows are not buttons', async () => {
    const markup = await expenses();
    expect(bodyOf(markup)).not.toContain('<button');
    expect(openButtons(markup)).toBe(0);
  });

  it('reads a Hebrew item name from its own direction', async () => {
    const hebrew = { ...elevenCharge, item: 'ספריית מוזיקה' };
    const markup = await expenses(makeData({ charges: [hebrew] }));
    expect(markup).toMatch(/<span dir="auto"[^>]*>ספריית מוזיקה<\/span>/);
    // Right to left inside, but at the left edge of its cell like every other name.
    expect(markup).toMatch(/<span dir="auto"[^>]*text-left[^>]*>ספריית מוזיקה<\/span>/);
  });
});

describe('<Expenses> paging the Items view', () => {
  it('shows ten items a page, and the rest on the next', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      ...MUSIC_ITEM,
      id: `item-${i}`,
      name: `Item ${String(i + 1).padStart(2, '0')}`,
    }));
    const first = await expenses(makeData({ items: many }));
    expect(rowsIn(first)).toHaveLength(10);
    expect(words(first)).toContain('Showing 1–10 of 13 items');
    expect(words(first)).toContain('13 items · total this month₪960.40');
    moneyUiStore.setState({ expensesPage: 1 });
    const second = await expenses(makeData({ items: many }));
    expect(rowsIn(second).map((row) => words(row).slice(0, 7))).toEqual([
      'Item 11',
      'Item 12',
      'Item 13',
    ]);
    expect(words(second)).toContain('Showing 11–13 of 13 items');
  });

  it('keeps an open item open on its page', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      ...MUSIC_ITEM,
      id: `item-${i}`,
      name: `Item ${i}`,
    }));
    moneyUiStore.setState({ open: { kind: 'item', id: 'item-3' } });
    const markup = await expenses(makeData({ items: many }));
    expect(markup).toContain('data-item-details="item-3"');
  });
});

describe('<Expenses> an empty month', () => {
  const none = { items: [], charges: [], total: 0 };

  it('says "No expenses in October." in place of the table, the pager and the footer', async () => {
    const markup = await expenses(makeData(none));
    expect(words(markup)).toContain('No expenses in October.');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('Expense pages');
    expect(markup).not.toContain('total this month');
  });

  it('names the month of the answer', async () => {
    moneyUiStore.setState({ month: '2026-09' });
    const markup = await expenses(makeData(none, '2026-09'));
    expect(words(markup)).toContain('No expenses in September.');
  });

  it('says it in the All charges view too, and keeps the header and the switch', async () => {
    moneyUiStore.setState({ expensesView: 'charges' });
    const markup = await expenses(makeData(none));
    expect(words(markup)).toContain('No expenses in October.');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('Everything you actually paid');
  });
});

describe('<Expenses> on the Money page', () => {
  it('has a footer total equal to the Expenses banner, which keeps whole shekels', async () => {
    const client = createTestQueryClient();
    client.setQueryData(moneyKey('2026-10'), makeData());
    const markup = await renderApp('/money', client);
    const banner =
      markup.match(/<section[^>]*aria-label="Expenses"[^>]*>.*?<\/section>/s)?.[0] ?? '';
    expect(words(banner)).toContain('₪960');
    expect(words(section(markup))).toContain('5 items · total this month₪960.40');
  });

  it('follows the month in the store', async () => {
    moneyUiStore.setState({ month: '2026-09' });
    const client = createTestQueryClient();
    client.setQueryData(
      moneyKey('2026-09'),
      makeData({ items: [], charges: [], total: 0 }, '2026-09'),
    );
    const markup = await renderApp('/money', client);
    expect(words(section(markup))).toContain('No expenses in September.');
  });
});

// ---- A month with agorot in it: the rows add up to the footer to the agora (CVP-205) ----

/** Money text such as "₪1,032.80" in agorot: 103280. */
function agorot(text: string): number {
  return Math.round(Number(text.replace(/[₪,]/g, '')) * 100);
}

/** The cells of one row of markup, as words. */
function cellsOf(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => words(m[1] ?? ''));
}

/** The amount in the footer, which the table sets apart from the count. */
function footerAmount(markup: string): string {
  const foot = markup.match(/<tfoot[^>]*>.*?<\/tfoot>/s)?.[0] ?? '';
  const cells = cellsOf(foot);
  return cells[cells.length - 1] ?? '';
}

const charge = (
  date: string,
  item: string,
  what: string,
  amountLabel: string,
  ils: number,
  job: string | null = null,
): MoneyExpenseCharge => ({ date, item, what, amountLabel, ils, job });

const AGOROT_CHARGES: MoneyExpenseCharge[] = [
  charge('2026-10-02', 'Claude Code', 'Monthly plan', '$243.20', 899.9),
  charge('2026-10-04', 'ChatGPT', 'Monthly plan', '$18.89', 69.9),
  charge(
    '2026-10-14',
    'Stock footage',
    'Clip licence #4831',
    '₪7.50',
    7.5,
    'Kova Coffee/Barista reel',
  ),
  charge('2026-10-18', 'ElevenLabs', 'Extra credits', '$10.00', 37, null),
  charge('2026-10-20', 'Music licence', 'Track', '$5.00', 18.5, 'Lumen Yoga/Retreat teaser'),
];

const agorotItem = (
  c: MoneyExpenseCharge,
  id: string,
  kind: MoneyExpenseItem['kind'],
): MoneyExpenseItem => ({
  id,
  name: c.item,
  kind,
  billing: kind === 'Subscription' ? 'Monthly' : 'Per use',
  amountLabel: c.amountLabel,
  ils: c.ils,
  charges: [c],
  notes: [],
});

const AGOROT_ITEMS = AGOROT_CHARGES.map((c, i) =>
  agorotItem(c, `agorot-${i}`, i < 2 ? 'Subscription' : 'Per use'),
);

function makeAgorotData(): MoneyResponse {
  const data = makeData({ items: AGOROT_ITEMS, charges: AGOROT_CHARGES, total: 1032.8 });
  // The Expenses banner carries the same month total.
  const { expenses } = data.banners;
  return { ...data, banners: { ...data.banners, expenses: { ...expenses, value: 1032.8 } } };
}

describe('<Expenses> a month with agorot', () => {
  it('Items: This month shows each amount to the agora, not rounded to whole shekels', async () => {
    const rows = rowsIn(await expenses(makeAgorotData()));
    expect(rows.map((row) => cellsOf(row).at(-1))).toEqual([
      '₪899.90',
      '₪69.90',
      '₪7.50',
      '₪37.00',
      '₪18.50',
    ]);
  });

  it('Items: the This month column adds up to the footer total, to the agora', async () => {
    const markup = await expenses(makeAgorotData());
    const sum = rowsIn(markup).reduce((total, row) => total + agorot(cellsOf(row).at(-1) ?? ''), 0);
    expect(footerAmount(markup)).toBe('₪1,032.80');
    expect(sum).toBe(103280);
    expect(sum).toBe(agorot(footerAmount(markup)));
    expect(words(markup.match(/<tfoot[^>]*>.*?<\/tfoot>/s)?.[0] ?? '')).toBe(
      '5 items · total this month₪1,032.80',
    );
  });

  it('All charges: the In ₪ column adds up to the footer total, to the agora', async () => {
    moneyUiStore.setState({ expensesView: 'charges' });
    const markup = await expenses(makeAgorotData());
    const sum = rowsIn(markup).reduce((total, row) => total + agorot(cellsOf(row).at(-1) ?? ''), 0);
    expect(footerAmount(markup)).toBe('₪1,032.80');
    expect(sum).toBe(agorot(footerAmount(markup)));
  });

  it('an open item’s charge line shows the same agorot as its row', async () => {
    moneyUiStore.setState({ open: { kind: 'item', id: 'agorot-4' } });
    const markup = await expenses(makeAgorotData());
    const details = detailsOf(markup, 'agorot-4');
    expect(words(details)).toBe('Oct 20Track · for Retreat teaser$5.00₪18.50');
    expect(cellsOf(rowsIn(markup)[4] ?? '').at(-1)).toBe('₪18.50');
  });

  it('the Expenses banner keeps whole shekels while the footer shows agorot', async () => {
    const client = createTestQueryClient();
    client.setQueryData(moneyKey('2026-10'), makeAgorotData());
    const markup = await renderApp('/money', client);
    const banner =
      markup.match(/<section[^>]*aria-label="Expenses"[^>]*>.*?<\/section>/s)?.[0] ?? '';
    expect(words(banner)).toContain('₪1,033');
    expect(words(banner)).not.toContain('₪1,032.80');
    expect(words(section(markup))).toContain('5 items · total this month₪1,032.80');
  });
});
