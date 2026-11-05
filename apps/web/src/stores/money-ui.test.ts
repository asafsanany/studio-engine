import { describe, expect, it } from 'vitest';
import type { StateStorage } from 'zustand/middleware';
import { createMemoryStorage } from './jobs-ui';
import {
  createMoneyUiStore,
  currentMonth,
  defaultMoneyUiState,
  MONEY_PAGE_SIZE,
  MONEY_VIEW_STORAGE_KEY,
  MONEY_VIEW_STORAGE_VERSION,
  migratePersistedView,
} from './money-ui';

/** What the store wrote to storage, parsed. */
function readStored(storage: StateStorage) {
  const raw = storage.getItem(MONEY_VIEW_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw as string);
}

function storeWith(stored: unknown, version = MONEY_VIEW_STORAGE_VERSION) {
  const storage = createMemoryStorage();
  storage.setItem(MONEY_VIEW_STORAGE_KEY, JSON.stringify({ state: stored, version }));
  return createMoneyUiStore(storage, '2026-10');
}

const newStore = () => createMoneyUiStore(createMemoryStorage(), '2026-10');

describe('money-ui store: defaults', () => {
  it('starts on the month it is given, with no row open, Every job, Items and the first pages', () => {
    expect(newStore().getState()).toMatchObject({
      month: '2026-10',
      open: null,
      grouping: 'job',
      expensesView: 'items',
      ledgerPage: 0,
      expensesPage: 0,
    });
    // No client chosen: the first one on the page opens by itself (see the open client below).
    expect(newStore().getState().clientOpen).toBeUndefined();
  });

  it('starts on this month, on this machine’s calendar, when it is not told', () => {
    const state = createMoneyUiStore(createMemoryStorage()).getState();
    expect(state.month).toBe(currentMonth());
    expect(state.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it('gives every store its own state', () => {
    const a = newStore();
    const b = newStore();
    a.getState().toggleOpen({ kind: 'job', id: 'a' });
    expect(b.getState().open).toBeNull();
    expect(defaultMoneyUiState('2026-10')).toEqual(defaultMoneyUiState('2026-10'));
  });

  it('pages hold 10 rows', () => {
    expect(MONEY_PAGE_SIZE).toBe(10);
  });
});

describe('currentMonth', () => {
  it('is the month of the moment it is given', () => {
    // The 15th, so every time zone agrees on the month.
    expect(currentMonth(Date.UTC(2026, 9, 15, 12))).toBe('2026-10');
    expect(currentMonth(Date.UTC(2027, 0, 15, 12))).toBe('2027-01');
  });
});

describe('money-ui store: the one open row', () => {
  it('opens a row, and opening another job closes the first', () => {
    const store = newStore();
    const s = () => store.getState();
    s().toggleOpen({ kind: 'job', id: 'a' });
    expect(s().open).toEqual({ kind: 'job', id: 'a' });
    s().toggleOpen({ kind: 'job', id: 'b' });
    expect(s().open).toEqual({ kind: 'job', id: 'b' });
  });

  it('closes the open ledger job when an expense item is opened, and the other way round', () => {
    const store = newStore();
    const s = () => store.getState();
    s().toggleOpen({ kind: 'job', id: 'a' });
    s().toggleOpen({ kind: 'item', id: 'claude' });
    expect(s().open).toEqual({ kind: 'item', id: 'claude' });
    s().toggleOpen({ kind: 'job', id: 'a' });
    expect(s().open).toEqual({ kind: 'job', id: 'a' });
  });

  it('closes the row when it is toggled again', () => {
    const store = newStore();
    store.getState().toggleOpen({ kind: 'item', id: 'claude' });
    store.getState().toggleOpen({ kind: 'item', id: 'claude' });
    expect(store.getState().open).toBeNull();
  });

  it('tells a job from an item that has the same id', () => {
    const store = newStore();
    store.getState().toggleOpen({ kind: 'job', id: 'x' });
    store.getState().toggleOpen({ kind: 'item', id: 'x' });
    expect(store.getState().open).toEqual({ kind: 'item', id: 'x' });
  });

  it('does not keep the object it is given, so a caller changing it cannot open another row', () => {
    const store = newStore();
    const row = { kind: 'job' as const, id: 'a' };
    store.getState().toggleOpen(row);
    row.id = 'b';
    expect(store.getState().open).toEqual({ kind: 'job', id: 'a' });
  });
});

describe('money-ui store: the open client', () => {
  it('starts with no choice made, which is the first client of the page open', () => {
    expect(newStore().getState().clientOpen).toBeUndefined();
  });

  it('opens one client group at a time, and closes it with null', () => {
    const store = newStore();
    const s = () => store.getState();
    s().setClientOpen('kova');
    expect(s().clientOpen).toBe('kova');
    s().setClientOpen('arc');
    expect(s().clientOpen).toBe('arc');
    s().setClientOpen(null);
    expect(s().clientOpen).toBeNull();
  });

  it('is separate from the open row', () => {
    const store = newStore();
    store.getState().toggleOpen({ kind: 'job', id: 'a' });
    store.getState().setClientOpen('kova');
    expect(store.getState().open).toEqual({ kind: 'job', id: 'a' });
  });

  it('goes back to the first client of the page on another page or another grouping', () => {
    const store = newStore();
    const s = () => store.getState();
    s().setClientOpen('kova');
    s().setLedgerPage(0);
    expect(s().clientOpen).toBe('kova');
    s().setLedgerPage(1);
    expect(s().clientOpen).toBeUndefined();
    s().setClientOpen(null);
    s().setGrouping('client');
    expect(s().clientOpen).toBeUndefined();
    s().setClientOpen('arc');
    s().setGrouping('client');
    expect(s().clientOpen).toBe('arc');
  });
});

describe('money-ui store: the month', () => {
  it('another month closes the open row and the open client, and starts both pages over', () => {
    const store = newStore();
    const s = () => store.getState();
    s().toggleOpen({ kind: 'job', id: 'a' });
    s().setClientOpen('kova');
    s().setLedgerPage(2);
    s().setExpensesPage(1);
    s().setMonth('2026-09');
    expect(s()).toMatchObject({
      month: '2026-09',
      open: null,
      ledgerPage: 0,
      expensesPage: 0,
    });
    expect(s().clientOpen).toBeUndefined();
  });

  it('keeps the switches when the month changes', () => {
    const store = newStore();
    store.getState().setGrouping('client');
    store.getState().setExpensesView('charges');
    store.getState().setMonth('2026-09');
    expect(store.getState()).toMatchObject({ grouping: 'client', expensesView: 'charges' });
  });

  it('leaves everything as it is when the same month is picked again', () => {
    const store = newStore();
    store.getState().toggleOpen({ kind: 'job', id: 'a' });
    store.getState().setLedgerPage(2);
    store.getState().setMonth('2026-10');
    expect(store.getState()).toMatchObject({
      open: { kind: 'job', id: 'a' },
      ledgerPage: 2,
    });
  });
});

describe('money-ui store: the switches and the pages', () => {
  it('another grouping starts the Ledger over from page 1; the same one does not', () => {
    const store = newStore();
    const s = () => store.getState();
    s().setLedgerPage(3);
    s().setGrouping('job');
    expect(s().ledgerPage).toBe(3);
    s().setGrouping('client');
    expect(s()).toMatchObject({ grouping: 'client', ledgerPage: 0 });
  });

  it('another view starts the Expenses over from page 1; the same one does not', () => {
    const store = newStore();
    const s = () => store.getState();
    s().setExpensesPage(2);
    s().setExpensesView('items');
    expect(s().expensesPage).toBe(2);
    s().setExpensesView('charges');
    expect(s()).toMatchObject({ expensesView: 'charges', expensesPage: 0 });
  });

  it('keeps the two tables’ pages apart', () => {
    const store = newStore();
    store.getState().setLedgerPage(2);
    store.getState().setExpensesPage(1);
    expect(store.getState()).toMatchObject({ ledgerPage: 2, expensesPage: 1 });
  });

  it('turns a page into a whole number, never below the first', () => {
    const store = newStore();
    const s = () => store.getState();
    s().setLedgerPage(-3);
    expect(s().ledgerPage).toBe(0);
    s().setLedgerPage(2.7);
    expect(s().ledgerPage).toBe(2);
    s().setLedgerPage(Number.NaN);
    expect(s().ledgerPage).toBe(0);
    s().setExpensesPage(Number.POSITIVE_INFINITY);
    expect(s().expensesPage).toBe(0);
  });
});

describe('money-ui store: persistence', () => {
  it('remembers the grouping and the Expenses view, and nothing else', () => {
    const storage = createMemoryStorage();
    const store = createMoneyUiStore(storage, '2026-10');
    store.getState().setGrouping('client');
    store.getState().setExpensesView('charges');
    store.getState().toggleOpen({ kind: 'job', id: 'a' });
    store.getState().setClientOpen('kova');
    store.getState().setLedgerPage(2);
    store.getState().setExpensesPage(1);
    store.getState().setMonth('2026-09');

    expect(readStored(storage)).toEqual({
      state: { grouping: 'client', expensesView: 'charges' },
      version: MONEY_VIEW_STORAGE_VERSION,
    });
  });

  it('brings the switches back in a new store, with everything else fresh', () => {
    const storage = createMemoryStorage();
    const first = createMoneyUiStore(storage, '2026-10');
    first.getState().setGrouping('client');
    first.getState().setExpensesView('charges');
    first.getState().toggleOpen({ kind: 'job', id: 'a' });
    first.getState().setLedgerPage(2);

    const second = createMoneyUiStore(storage, '2026-11');
    expect(second.getState()).toMatchObject({
      grouping: 'client',
      expensesView: 'charges',
      month: '2026-11',
      open: null,
      ledgerPage: 0,
      expensesPage: 0,
    });
    expect(second.getState().clientOpen).toBeUndefined();
  });

  it('ignores values it does not know, since localStorage can be edited by hand', () => {
    expect(storeWith({ grouping: 'planet', expensesView: 7 }).getState()).toMatchObject({
      grouping: 'job',
      expensesView: 'items',
    });
    expect(storeWith('nonsense').getState()).toMatchObject({
      grouping: 'job',
      expensesView: 'items',
    });
    expect(storeWith({ grouping: 'client' }).getState()).toMatchObject({
      grouping: 'client',
      expensesView: 'items',
    });
  });

  it('does not take the month or the pages from storage', () => {
    const state = storeWith({
      month: '1999-01',
      open: { kind: 'job', id: 'a' },
      ledgerPage: 5,
    }).getState();
    expect(state.month).toBe('2026-10');
    expect(state.open).toBeNull();
    expect(state.ledgerPage).toBe(0);
  });

  it('falls back to the defaults for a version it does not know', () => {
    expect(migratePersistedView({ grouping: 'client', expensesView: 'charges' }, 0)).toEqual({
      grouping: 'job',
      expensesView: 'items',
    });
    expect(
      migratePersistedView(
        { grouping: 'client', expensesView: 'charges' },
        MONEY_VIEW_STORAGE_VERSION,
      ),
    ).toEqual({ grouping: 'client', expensesView: 'charges' });
  });

  it('keeps working when the storage throws', () => {
    const broken: StateStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = createMoneyUiStore(broken, '2026-10');
    store.getState().setGrouping('client');
    expect(store.getState().grouping).toBe('client');
  });
});
