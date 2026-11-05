import { STATUS_GROUPS } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import type { StateStorage } from 'zustand/middleware';
import {
  createJobsUiStore,
  createMemoryStorage,
  defaultJobsUiState,
  guardStorage,
  isStatusTab,
  migratePersistedShowArchived,
  resolveUpdater,
  SHOW_ARCHIVED_STORAGE_KEY,
  SHOW_ARCHIVED_STORAGE_VERSION,
  STATUS_TABS,
  sameSorting,
} from './jobs-ui';

describe('jobs-ui store: defaults', () => {
  it('starts on the All tab, with no search, on the first page', () => {
    const s = createJobsUiStore().getState();
    expect(s.statusTab).toBe('all');
    expect(s.search).toBe('');
    expect(s.pageIndex).toBe(0);
  });

  it('holds the tab, the search, the page and the View switches and nothing else: no sorting, no column choices', () => {
    expect(Object.keys(defaultJobsUiState()).sort()).toEqual([
      'byClient',
      'pageIndex',
      'search',
      'showArchived',
      'statusTab',
    ]);
    const keys = Object.keys(createJobsUiStore().getState()).sort();
    expect(keys).toEqual([
      'byClient',
      'pageIndex',
      'search',
      'setByClient',
      'setPageIndex',
      'setSearch',
      'setShowArchived',
      'setStatusTab',
      'showArchived',
      'statusTab',
    ]);
  });

  it('starts with Show archived off', () => {
    expect(createJobsUiStore(createMemoryStorage()).getState().showArchived).toBe(false);
    expect(defaultJobsUiState().showArchived).toBe(false);
  });

  it('exports the tab list for the UI', () => {
    expect(STATUS_TABS).toEqual([
      'all',
      'progress',
      'review',
      'approved',
      'delivered',
      'uploaded',
      'paid',
      'attention',
    ]);
  });

  it('has the same tabs as the status groups, in the same order', () => {
    expect([...STATUS_TABS]).toEqual([...STATUS_GROUPS]);
  });

  it('knows which values are tabs', () => {
    for (const tab of STATUS_TABS) expect(isStatusTab(tab), tab).toBe(true);
    expect(isStatusTab('review')).toBe(true);
    expect(isStatusTab('')).toBe(false);
    expect(isStatusTab('editing')).toBe(false);
    expect(isStatusTab('All')).toBe(false);
  });

  it('gives every store its own state: one store changing leaves the other alone', () => {
    const a = createJobsUiStore();
    const b = createJobsUiStore();
    a.getState().setSearch('acme');
    a.getState().setPageIndex(2);
    expect(b.getState().search).toBe('');
    expect(b.getState().pageIndex).toBe(0);
  });
});

describe('jobs-ui store: OnChangeFn setters', () => {
  it('accept a plain value or an updater function', () => {
    const store = createJobsUiStore();
    const s = () => store.getState();

    s().setStatusTab('approved');
    expect(s().statusTab).toBe('approved');
    s().setStatusTab((prev) => (prev === 'approved' ? 'attention' : 'all'));
    expect(s().statusTab).toBe('attention');

    s().setSearch('acme');
    s().setSearch((prev) => `${prev} spring`);
    expect(s().search).toBe('acme spring');

    s().setPageIndex(3);
    s().setPageIndex((prev) => prev + 1);
    expect(s().pageIndex).toBe(4);
  });

  it('keeps pageIndex a non-negative integer', () => {
    const store = createJobsUiStore();
    store.getState().setPageIndex(-2);
    expect(store.getState().pageIndex).toBe(0);
    store.getState().setPageIndex(2.9);
    expect(store.getState().pageIndex).toBe(2);
    store.getState().setPageIndex(Number.NaN);
    expect(store.getState().pageIndex).toBe(0);
  });
});

describe('jobs-ui store: page reset', () => {
  function onPage(page: number) {
    const store = createJobsUiStore();
    store.getState().setPageIndex(page);
    return store;
  }

  it('resets to page 0 when the status tab changes', () => {
    const store = onPage(4);
    store.getState().setStatusTab('progress');
    expect(store.getState().pageIndex).toBe(0);
  });

  it('resets to page 0 when the search changes', () => {
    const store = onPage(4);
    store.getState().setSearch('acme');
    expect(store.getState().pageIndex).toBe(0);
  });

  it('leaves the page alone when the new value equals the old one', () => {
    const store = onPage(4);
    store.getState().setStatusTab('all');
    store.getState().setSearch('');
    expect(store.getState().pageIndex).toBe(4);
  });

  it('does not tell anyone when nothing changed', () => {
    const store = onPage(4);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.getState().setStatusTab('all');
    store.getState().setSearch('');
    store.getState().setPageIndex(4);
    expect(notified).toBe(0);
  });
});

describe('jobs-ui store: only the View switches are remembered', () => {
  it('starts the tab, the search and the page fresh in a new store, whatever the last one held', () => {
    const storage = createMemoryStorage();
    const first = createJobsUiStore(storage);
    first.getState().setStatusTab('attention');
    first.getState().setSearch('acme');
    first.getState().setPageIndex(3);

    const second = createJobsUiStore(storage).getState();
    expect(second.statusTab).toBe('all');
    expect(second.search).toBe('');
    expect(second.pageIndex).toBe(0);
  });

  it('accepts a value or an updater for Show archived, and leaves the page where it is', () => {
    const store = createJobsUiStore(createMemoryStorage());
    store.getState().setPageIndex(2);
    store.getState().setShowArchived(true);
    expect(store.getState().showArchived).toBe(true);
    expect(store.getState().pageIndex).toBe(2);
    store.getState().setShowArchived((on) => !on);
    expect(store.getState().showArchived).toBe(false);
  });

  it('does not tell anyone when Show archived is set to what it already is', () => {
    const store = createJobsUiStore(createMemoryStorage());
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.getState().setShowArchived(false);
    expect(notified).toBe(0);
  });

  it('keeps the switch under studio.jobs.showArchived.v1 and brings it back in a new store', () => {
    const storage = createMemoryStorage();
    createJobsUiStore(storage).getState().setShowArchived(true);

    expect(SHOW_ARCHIVED_STORAGE_KEY).toBe('studio.jobs.showArchived.v1');
    expect(JSON.parse(String(storage.getItem(SHOW_ARCHIVED_STORAGE_KEY)))).toEqual({
      state: { showArchived: true, byClient: false },
      version: SHOW_ARCHIVED_STORAGE_VERSION,
    });
    expect(createJobsUiStore(storage).getState().showArchived).toBe(true);

    createJobsUiStore(storage).getState().setShowArchived(false);
    expect(createJobsUiStore(storage).getState().showArchived).toBe(false);
  });

  it('remembers nothing else: the stored value holds the two switches alone', () => {
    const storage = createMemoryStorage();
    const store = createJobsUiStore(storage);
    store.getState().setShowArchived(true);
    store.getState().setSearch('acme');
    store.getState().setStatusTab('paid');
    const stored = JSON.parse(String(storage.getItem(SHOW_ARCHIVED_STORAGE_KEY)));
    expect(Object.keys(stored.state)).toEqual(['showArchived', 'byClient']);
  });

  it('starts off for a stored value that is not a clear yes: junk, the wrong type, another version', () => {
    for (const stored of [
      '{"state":{"showArchived":"yes"},"version":1}',
      '{"state":{"showArchived":1},"version":1}',
      '{"state":null,"version":1}',
      '{"state":{"showArchived":true},"version":7}',
      'not json',
      '',
    ]) {
      const storage = createMemoryStorage();
      storage.setItem(SHOW_ARCHIVED_STORAGE_KEY, stored);
      expect(createJobsUiStore(storage).getState().showArchived, stored).toBe(false);
    }
  });

  it('migrates only the current version', () => {
    expect(
      migratePersistedShowArchived({ showArchived: true }, SHOW_ARCHIVED_STORAGE_VERSION),
    ).toEqual({ showArchived: true, byClient: false });
    expect(migratePersistedShowArchived({ showArchived: true, byClient: true }, 0)).toEqual({
      showArchived: false,
      byClient: false,
    });
  });

  it('keeps Show archived for a value saved before By client existed, with By client off', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      SHOW_ARCHIVED_STORAGE_KEY,
      JSON.stringify({ state: { showArchived: true }, version: SHOW_ARCHIVED_STORAGE_VERSION }),
    );
    const state = createJobsUiStore(storage).getState();
    expect(state.showArchived).toBe(true);
    expect(state.byClient).toBe(false);
  });

  it('works when the storage is blocked (private mode): the switch still turns on in memory', () => {
    const blocked: StateStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = createJobsUiStore(blocked);
    expect(store.getState().showArchived).toBe(false);
    expect(() => store.getState().setShowArchived(true)).not.toThrow();
    expect(store.getState().showArchived).toBe(true);
  });
});

describe('jobs-ui store: View › By client', () => {
  it('starts off', () => {
    expect(defaultJobsUiState().byClient).toBe(false);
    expect(createJobsUiStore(createMemoryStorage()).getState().byClient).toBe(false);
  });

  it('accepts a value or an updater, and leaves the page where it is', () => {
    const store = createJobsUiStore(createMemoryStorage());
    store.getState().setPageIndex(2);
    store.getState().setByClient(true);
    expect(store.getState().byClient).toBe(true);
    expect(store.getState().pageIndex).toBe(2);
    store.getState().setByClient((on) => !on);
    expect(store.getState().byClient).toBe(false);
  });

  it('does not tell anyone when it is set to what it already is', () => {
    const store = createJobsUiStore(createMemoryStorage());
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.getState().setByClient(false);
    expect(notified).toBe(0);
  });

  it('is remembered next to Show archived, each independent of the other', () => {
    const storage = createMemoryStorage();
    const first = createJobsUiStore(storage);
    first.getState().setByClient(true);
    expect(createJobsUiStore(storage).getState()).toMatchObject({
      byClient: true,
      showArchived: false,
    });

    first.getState().setShowArchived(true);
    first.getState().setByClient(false);
    expect(createJobsUiStore(storage).getState()).toMatchObject({
      byClient: false,
      showArchived: true,
    });
  });

  it('starts off for a stored value that is not a clear yes', () => {
    for (const stored of [
      '{"state":{"byClient":"yes"},"version":1}',
      '{"state":{"byClient":1},"version":1}',
      '{"state":null,"version":1}',
      '{"state":{"byClient":true},"version":7}',
    ]) {
      const storage = createMemoryStorage();
      storage.setItem(SHOW_ARCHIVED_STORAGE_KEY, stored);
      expect(createJobsUiStore(storage).getState().byClient, stored).toBe(false);
    }
  });
});

describe('the helpers the Clients store shares', () => {
  it('resolveUpdater takes a value or a function of the previous value', () => {
    expect(resolveUpdater(5, 1)).toBe(5);
    expect(resolveUpdater((previous: number) => previous + 1, 1)).toBe(2);
  });

  it('sameSorting compares the columns and the directions, in order', () => {
    expect(sameSorting([], [])).toBe(true);
    expect(sameSorting([{ id: 'a', desc: true }], [{ id: 'a', desc: true }])).toBe(true);
    expect(sameSorting([{ id: 'a', desc: true }], [{ id: 'a', desc: false }])).toBe(false);
    expect(sameSorting([{ id: 'a', desc: true }], [{ id: 'b', desc: true }])).toBe(false);
    expect(sameSorting([{ id: 'a', desc: true }], [])).toBe(false);
  });

  it('createMemoryStorage keeps what it is given and forgets what is removed', () => {
    const storage = createMemoryStorage();
    expect(storage.getItem('k')).toBeNull();
    storage.setItem('k', 'v');
    expect(storage.getItem('k')).toBe('v');
    storage.removeItem('k');
    expect(storage.getItem('k')).toBeNull();
  });

  it('guardStorage keeps working when the storage throws', () => {
    const broken: StateStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const guarded = guardStorage(broken);
    expect(guarded.getItem('k')).toBeNull();
    expect(() => guarded.setItem('k', 'v')).not.toThrow();
    expect(() => guarded.removeItem('k')).not.toThrow();
  });
});
