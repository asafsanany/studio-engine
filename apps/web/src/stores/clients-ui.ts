import type { OnChangeFn, SortingState } from '@tanstack/react-table';
import { createStore, useStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { browserStorage, guardStorage, resolveUpdater, sameSorting } from './jobs-ui';

/**
 * UI state for the Clients table, built like the Jobs one: the table is fully controlled by it.
 * Only the sort is remembered per browser; the search and the page always start fresh.
 */

/** localStorage key for the persisted sort. Bump the `v1` suffix with the schema. */
export const CLIENTS_SORT_STORAGE_KEY = 'studio.clients.sort.v1';

/** Version of the persisted shape (see `migrate`). */
export const CLIENTS_SORT_STORAGE_VERSION = 1;

/** The Clients table's columns, left to right. The ids are also what the sort names. */
export const CLIENT_COLUMN_IDS = ['client', 'jobs', 'last'] as const;

/**
 * The columns while Clients × Instagram is on (board CLList, L1): the Instagram numbers take the
 * place of Jobs and Last job. A sort that names a column the table does not have now is ignored
 * (the clients stay in their starting order), so the stored sort survives a switch either way.
 */
export const CLIENT_INSTAGRAM_COLUMN_IDS = ['client', 'followers', 'week', 'ours'] as const;

export type ClientColumnId =
  | (typeof CLIENT_COLUMN_IDS)[number]
  | (typeof CLIENT_INSTAGRAM_COLUMN_IDS)[number];

/** Every id a stored sort may name. */
const SORTABLE_COLUMN_IDS: readonly string[] = [
  ...new Set([...CLIENT_COLUMN_IDS, ...CLIENT_INSTAGRAM_COLUMN_IDS]),
];

export interface ClientsUiState {
  search: string;
  sorting: SortingState;
  /** Zero-based page. Reset to 0 whenever the search or sorting actually changes. */
  pageIndex: number;
}

export interface ClientsUiActions {
  setSearch: OnChangeFn<string>;
  setSorting: OnChangeFn<SortingState>;
  setPageIndex: OnChangeFn<number>;
}

export type ClientsUiStore = ClientsUiState & ClientsUiActions;

/** The slice that survives a reload. */
export interface PersistedClientsSort {
  sorting: SortingState;
}

/** Last job, newest first. */
export function defaultClientsSorting(): SortingState {
  return [{ id: 'last', desc: true }];
}

export function defaultClientsUiState(): ClientsUiState {
  return { search: '', sorting: defaultClientsSorting(), pageIndex: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored sort that names one of the table's columns, otherwise the default. */
function sanitizeSorting(value: unknown): SortingState {
  const first = Array.isArray(value) ? value[0] : undefined;
  if (
    isRecord(first) &&
    typeof first.id === 'string' &&
    SORTABLE_COLUMN_IDS.includes(first.id) &&
    typeof first.desc === 'boolean'
  ) {
    return [{ id: first.id, desc: first.desc }];
  }
  return defaultClientsSorting();
}

/** The persisted sort from untrusted input (localStorage is user-editable). */
function toPersistedSort(value: unknown): PersistedClientsSort {
  return { sorting: sanitizeSorting(isRecord(value) ? value.sorting : undefined) };
}

/** zustand `migrate`: version 1 is the first shape; any other version falls back to the default. */
export function migratePersistedSort(persisted: unknown, version: number): PersistedClientsSort {
  return version === CLIENTS_SORT_STORAGE_VERSION
    ? toPersistedSort(persisted)
    : toPersistedSort(undefined);
}

/**
 * Build a Clients UI store. `storage` is injectable so tests can simulate a reload by creating a
 * second store over the same storage.
 */
export function createClientsUiStore(storage: StateStorage = browserStorage()) {
  return createStore<ClientsUiStore>()(
    persist(
      (set) => ({
        ...defaultClientsUiState(),

        // A changed search or sort starts the list over from page 0; an unchanged one does not.
        setSearch: (updater) =>
          set((s) => {
            const search = resolveUpdater(updater, s.search);
            return search === s.search ? s : { search, pageIndex: 0 };
          }),
        setSorting: (updater) =>
          set((s) => {
            const sorting = resolveUpdater(updater, s.sorting);
            return sameSorting(sorting, s.sorting) ? s : { sorting, pageIndex: 0 };
          }),
        setPageIndex: (updater) =>
          set((s) => {
            const next = resolveUpdater(updater, s.pageIndex);
            const pageIndex = Number.isFinite(next) ? Math.max(0, Math.trunc(next)) : 0;
            return pageIndex === s.pageIndex ? s : { pageIndex };
          }),
      }),
      {
        name: CLIENTS_SORT_STORAGE_KEY,
        version: CLIENTS_SORT_STORAGE_VERSION,
        storage: createJSONStorage(() => guardStorage(storage)),
        partialize: (s): PersistedClientsSort => ({ sorting: s.sorting }),
        migrate: (persisted, version) => migratePersistedSort(persisted, version),
        merge: (persisted, current) => ({ ...current, ...toPersistedSort(persisted) }),
      },
    ),
  );
}

/** The app-wide store, persisted to this browser's localStorage. */
export const clientsUiStore = createClientsUiStore();

export function useClientsUiStore<T>(selector: (state: ClientsUiStore) => T): T {
  return useStore(clientsUiStore, selector);
}
