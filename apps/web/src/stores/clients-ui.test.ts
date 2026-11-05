import { describe, expect, it } from 'vitest';
import type { StateStorage } from 'zustand/middleware';
import {
  CLIENT_COLUMN_IDS,
  CLIENTS_SORT_STORAGE_KEY,
  CLIENTS_SORT_STORAGE_VERSION,
  createClientsUiStore,
  defaultClientsUiState,
  migratePersistedSort,
} from './clients-ui';
import { createMemoryStorage } from './jobs-ui';

const LAST_JOB_NEWEST = [{ id: 'last', desc: true }];

/** What the store wrote to storage, parsed. */
function readStored(storage: StateStorage) {
  const raw = storage.getItem(CLIENTS_SORT_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw as string);
}

function storeWith(stored: unknown, version = CLIENTS_SORT_STORAGE_VERSION) {
  const storage = createMemoryStorage();
  storage.setItem(CLIENTS_SORT_STORAGE_KEY, JSON.stringify({ state: stored, version }));
  return createClientsUiStore(storage);
}

describe('clients-ui store: defaults', () => {
  it('starts on Last job, newest first, with no search, on the first page', () => {
    const s = createClientsUiStore(createMemoryStorage()).getState();
    expect(s.sorting).toEqual(LAST_JOB_NEWEST);
    expect(s.search).toBe('');
    expect(s.pageIndex).toBe(0);
  });

  it('names the three columns the sort can use', () => {
    expect(CLIENT_COLUMN_IDS).toEqual(['client', 'jobs', 'last']);
  });

  it('gives every store its own default objects', () => {
    expect(defaultClientsUiState().sorting).not.toBe(defaultClientsUiState().sorting);
  });
});

describe('clients-ui store: setters', () => {
  it('accept a plain value or an updater function, like TanStack Table does', () => {
    const store = createClientsUiStore(createMemoryStorage());
    const s = () => store.getState();

    s().setSearch('acme');
    s().setSearch((previous) => `${previous} fitness`);
    expect(s().search).toBe('acme fitness');

    s().setSorting([{ id: 'client', desc: false }]);
    s().setSorting((previous) => previous.map((sort) => ({ ...sort, desc: true })));
    expect(s().sorting).toEqual([{ id: 'client', desc: true }]);

    s().setPageIndex(3);
    s().setPageIndex((previous) => previous + 1);
    expect(s().pageIndex).toBe(4);
  });

  it('starts over from page 1 only when the search or the sort really changes', () => {
    const store = createClientsUiStore(createMemoryStorage());
    const s = () => store.getState();
    s().setPageIndex(2);

    s().setSearch('');
    s().setSorting([...LAST_JOB_NEWEST]);
    expect(s().pageIndex).toBe(2);

    s().setSearch('a');
    expect(s().pageIndex).toBe(0);
    s().setPageIndex(2);
    s().setSorting([{ id: 'jobs', desc: true }]);
    expect(s().pageIndex).toBe(0);
  });

  it('keeps the page a whole number that is not negative', () => {
    const store = createClientsUiStore(createMemoryStorage());
    store.getState().setPageIndex(-3);
    expect(store.getState().pageIndex).toBe(0);
    store.getState().setPageIndex(2.7);
    expect(store.getState().pageIndex).toBe(2);
    store.getState().setPageIndex(Number.NaN);
    expect(store.getState().pageIndex).toBe(0);
  });
});

describe('clients-ui store: persistence', () => {
  it('remembers the sort and nothing else', () => {
    const storage = createMemoryStorage();
    const store = createClientsUiStore(storage);
    store.getState().setSearch('arc');
    store.getState().setPageIndex(2);
    store.getState().setSorting([{ id: 'jobs', desc: true }]);

    expect(readStored(storage)).toEqual({
      state: { sorting: [{ id: 'jobs', desc: true }] },
      version: CLIENTS_SORT_STORAGE_VERSION,
    });
  });

  it('brings the sort back after a reload, with the search and the page fresh', () => {
    const storage = createMemoryStorage();
    const before = createClientsUiStore(storage);
    before.getState().setSorting([{ id: 'client', desc: false }]);
    before.getState().setSearch('arc');
    before.getState().setPageIndex(1);

    const after = createClientsUiStore(storage).getState();
    expect(after.sorting).toEqual([{ id: 'client', desc: false }]);
    expect(after.search).toBe('');
    expect(after.pageIndex).toBe(0);
  });

  it.each([
    ['a sort of a column that does not exist', { sorting: [{ id: 'size', desc: true }] }],
    ['a sort with no direction', { sorting: [{ id: 'jobs' }] }],
    ['a sort that is not a list', { sorting: 'jobs' }],
    ['an empty sort', { sorting: [] }],
    ['no sort at all', {}],
    ['something that is not an object', 'jobs'],
  ])('falls back to the default for %s', (_, stored) => {
    expect(storeWith(stored).getState().sorting).toEqual(LAST_JOB_NEWEST);
  });

  it('keeps one sort when the stored list has more', () => {
    const store = storeWith({
      sorting: [
        { id: 'jobs', desc: false },
        { id: 'client', desc: true },
      ],
    });
    expect(store.getState().sorting).toEqual([{ id: 'jobs', desc: false }]);
  });

  it('starts from the default when the stored version is not the current one', () => {
    const store = storeWith({ sorting: [{ id: 'jobs', desc: false }] }, 99);
    expect(store.getState().sorting).toEqual(LAST_JOB_NEWEST);
    expect(migratePersistedSort({ sorting: [{ id: 'jobs', desc: false }] }, 0)).toEqual({
      sorting: LAST_JOB_NEWEST,
    });
    expect(
      migratePersistedSort(
        { sorting: [{ id: 'jobs', desc: false }] },
        CLIENTS_SORT_STORAGE_VERSION,
      ),
    ).toEqual({ sorting: [{ id: 'jobs', desc: false }] });
  });

  it('works when storage throws (private mode, blocked site data)', () => {
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
    const store = createClientsUiStore(broken);
    expect(() => store.getState().setSorting([{ id: 'jobs', desc: true }])).not.toThrow();
    expect(store.getState().sorting).toEqual([{ id: 'jobs', desc: true }]);
  });
});
