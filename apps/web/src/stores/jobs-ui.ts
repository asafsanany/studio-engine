import type { OnChangeFn, SortingState, Updater } from '@tanstack/react-table';
import { createStore, useStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * UI state for the Jobs page: the status tab, the search, the page and the View switches (Show
 * archived, By client). The list reads it and the toolbar writes it, so the two never talk to each
 * other directly. Only the switches are remembered per browser; the tab, search and page always
 * start fresh. The client's page reads the Show archived switch too.
 */

/**
 * localStorage key for the persisted View switches. It keeps the name it had when Show archived
 * was the only one; By client was added to the same value. Bump the `v1` suffix with the schema.
 */
export const SHOW_ARCHIVED_STORAGE_KEY = 'studio.jobs.showArchived.v1';

/** Version of the persisted shape (see `migrate`). */
export const SHOW_ARCHIVED_STORAGE_VERSION = 1;

/** The status tabs above the list, in display order. */
export const STATUS_TABS = [
  'all',
  'progress',
  'review',
  'approved',
  'delivered',
  'uploaded',
  'paid',
  'attention',
] as const;
export type StatusTab = (typeof STATUS_TABS)[number];

/** Whether a value is one of the tabs. */
export function isStatusTab(value: string): value is StatusTab {
  return (STATUS_TABS as readonly string[]).includes(value);
}

export interface JobsUiState {
  statusTab: StatusTab;
  search: string;
  /** Zero-based page. Reset to 0 whenever the tab or the search actually changes. */
  pageIndex: number;
  /**
   * View › Show archived. Off (how it starts), archived jobs are out of every tab, count and page;
   * on, they sit in their usual tab, faded. Remembered per browser.
   */
  showArchived: boolean;
  /**
   * View › By client. On, the Jobs page puts each client's jobs under its name, all of them on one
   * page (no pager); off (how it starts), one flat list, ten to a page. A client's page is always
   * flat. Remembered per browser.
   */
  byClient: boolean;
}

/** Every setter takes a value or an updater function, exactly like TanStack's `OnChangeFn`. */
export interface JobsUiActions {
  setStatusTab: OnChangeFn<StatusTab>;
  setSearch: OnChangeFn<string>;
  setPageIndex: OnChangeFn<number>;
  /** Turns Show archived on or off. The page stays where it is; paging clamps itself. */
  setShowArchived: OnChangeFn<boolean>;
  /** Turns By client on or off. */
  setByClient: OnChangeFn<boolean>;
}

/** The slice that survives a reload: the two View switches. */
export interface PersistedShowArchived {
  showArchived: boolean;
  byClient: boolean;
}

export type JobsUiStore = JobsUiState & JobsUiActions;

export function defaultJobsUiState(): JobsUiState {
  return { statusTab: 'all', search: '', pageIndex: 0, showArchived: false, byClient: false };
}

/** Resolve a TanStack `Updater` (a value or a function of the previous value). */
export function resolveUpdater<T>(updater: Updater<T>, previous: T): T {
  return typeof updater === 'function' ? (updater as (old: T) => T)(previous) : updater;
}

/** Whether two sortings are the same columns in the same directions. The Clients store uses it. */
export function sameSorting(a: SortingState, b: SortingState): boolean {
  return a.length === b.length && a.every((s, i) => s.id === b[i]?.id && s.desc === b[i]?.desc);
}

/** In-memory `StateStorage`: the fallback outside a browser, and handy for tests. */
export function createMemoryStorage(): StateStorage {
  const items = new Map<string, string>();
  return {
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => {
      items.set(name, value);
    },
    removeItem: (name) => {
      items.delete(name);
    },
  };
}

/** Never let a broken storage (private mode, quota, blocked cookies) break the UI. */
export function guardStorage(storage: StateStorage): StateStorage {
  return {
    getItem: (name) => {
      try {
        return storage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        return storage.setItem(name, value);
      } catch {
        // Persistence is best-effort; the in-memory state stays correct.
      }
    },
    removeItem: (name) => {
      try {
        return storage.removeItem(name);
      } catch {
        // See setItem.
      }
    },
  };
}

export function browserStorage(): StateStorage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Accessing localStorage can throw (blocked site data).
  }
  return createMemoryStorage();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The persisted switches from untrusted input (localStorage is user-editable): each is on only for
 * `true`, so a value saved before By client existed leaves it off.
 */
function toPersistedShowArchived(value: unknown): PersistedShowArchived {
  return {
    showArchived: isRecord(value) && value.showArchived === true,
    byClient: isRecord(value) && value.byClient === true,
  };
}

/** zustand `migrate`: version 1 is the first shape; any other version falls back to off. */
export function migratePersistedShowArchived(
  persisted: unknown,
  version: number,
): PersistedShowArchived {
  return version === SHOW_ARCHIVED_STORAGE_VERSION
    ? toPersistedShowArchived(persisted)
    : toPersistedShowArchived(undefined);
}

/**
 * Build a Jobs UI store. `storage` is injectable so tests can simulate a reload by creating a
 * second store over the same storage; the app's store uses this browser's localStorage.
 */
export function createJobsUiStore(storage: StateStorage = browserStorage()) {
  return createStore<JobsUiStore>()(
    persist(
      (set) => ({
        ...defaultJobsUiState(),

        // Changing the tab or the search starts the list over from page 0, but only when the value
        // really changes (a no-op update must not bounce the user off their page).
        setStatusTab: (updater) =>
          set((s) => {
            const statusTab = resolveUpdater(updater, s.statusTab);
            return statusTab === s.statusTab ? s : { statusTab, pageIndex: 0 };
          }),
        setSearch: (updater) =>
          set((s) => {
            const search = resolveUpdater(updater, s.search);
            return search === s.search ? s : { search, pageIndex: 0 };
          }),

        setPageIndex: (updater) =>
          set((s) => {
            const next = resolveUpdater(updater, s.pageIndex);
            const pageIndex = Number.isFinite(next) ? Math.max(0, Math.trunc(next)) : 0;
            return pageIndex === s.pageIndex ? s : { pageIndex };
          }),

        // The list keeps the page number inside its last page, so no reset is needed here.
        setShowArchived: (updater) =>
          set((s) => {
            const showArchived = resolveUpdater(updater, s.showArchived);
            return showArchived === s.showArchived ? s : { showArchived };
          }),

        // Grouping changes what a page holds (one page, or ten), and the list keeps the page inside
        // the pages there are, so nothing is reset here either.
        setByClient: (updater) =>
          set((s) => {
            const byClient = resolveUpdater(updater, s.byClient);
            return byClient === s.byClient ? s : { byClient };
          }),
      }),
      {
        name: SHOW_ARCHIVED_STORAGE_KEY,
        version: SHOW_ARCHIVED_STORAGE_VERSION,
        storage: createJSONStorage(() => guardStorage(storage)),
        // Only the switches are remembered; the tab, the search and the page are per visit.
        partialize: (s): PersistedShowArchived => ({
          showArchived: s.showArchived,
          byClient: s.byClient,
        }),
        migrate: (persisted, version) => migratePersistedShowArchived(persisted, version),
        merge: (persisted, current) => ({ ...current, ...toPersistedShowArchived(persisted) }),
      },
    ),
  );
}

/** The app-wide store, with the View switches persisted to this browser's localStorage. */
export const jobsUiStore = createJobsUiStore();

export function useJobsUiStore<T>(selector: (state: JobsUiStore) => T): T {
  return useStore(jobsUiStore, selector);
}
