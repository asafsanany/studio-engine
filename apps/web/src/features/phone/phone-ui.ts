import { createStore, useStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { browserStorage, guardStorage } from '@/stores/jobs-ui';

/**
 * UI state that exists only on the phone: the By client switch of the jobs list's View sheet (jobs
 * one step in under their client, with tree lines). It is on by default and remembered per
 * browser, as the Mac's Show archived switch is. Show archived itself is not here: the phone reads
 * the Mac's remembered switch from the Jobs UI store, so the two never disagree.
 */

/** localStorage key of the persisted switch. Bump the `v1` suffix with the schema. */
export const BY_CLIENT_STORAGE_KEY = 'studio.phone.byClient.v1';

/** Version of the persisted shape (see `migrate`). */
export const BY_CLIENT_STORAGE_VERSION = 1;

export interface PhoneUiState {
  /** View › By client. On (how it starts), each client's jobs sit under its name. */
  byClient: boolean;
}

export interface PhoneUiActions {
  setByClient: (byClient: boolean) => void;
}

export type PhoneUiStore = PhoneUiState & PhoneUiActions;

/** The slice that survives a reload. */
export interface PersistedByClient {
  byClient: boolean;
}

export function defaultPhoneUiState(): PhoneUiState {
  return { byClient: true };
}

/**
 * The persisted switch from untrusted input (localStorage is user-editable): off only for an
 * explicit `false`, so anything unreadable leaves the default, which is on.
 */
function toPersistedByClient(value: unknown): PersistedByClient {
  const stored =
    typeof value === 'object' && value !== null
      ? (value as { byClient?: unknown }).byClient
      : undefined;
  return { byClient: stored !== false };
}

/** zustand `migrate`: version 1 is the first shape; any other version falls back to the default. */
export function migratePersistedByClient(persisted: unknown, version: number): PersistedByClient {
  return version === BY_CLIENT_STORAGE_VERSION
    ? toPersistedByClient(persisted)
    : toPersistedByClient(undefined);
}

/**
 * Build a phone UI store. `storage` is injectable so tests can simulate a reload by creating a
 * second store over the same storage; the app's store uses this browser's localStorage.
 */
export function createPhoneUiStore(storage: StateStorage = browserStorage()) {
  return createStore<PhoneUiStore>()(
    persist(
      (set) => ({
        ...defaultPhoneUiState(),
        setByClient: (byClient) =>
          set((state) => (state.byClient === byClient ? state : { byClient })),
      }),
      {
        name: BY_CLIENT_STORAGE_KEY,
        version: BY_CLIENT_STORAGE_VERSION,
        storage: createJSONStorage(() => guardStorage(storage)),
        partialize: (state): PersistedByClient => ({ byClient: state.byClient }),
        migrate: (persisted, version) => migratePersistedByClient(persisted, version),
        merge: (persisted, current) => ({ ...current, ...toPersistedByClient(persisted) }),
      },
    ),
  );
}

/** The app-wide store, with the By client switch persisted to this browser's localStorage. */
export const phoneUiStore = createPhoneUiStore();

export function usePhoneUiStore<T>(selector: (state: PhoneUiStore) => T): T {
  return useStore(phoneUiStore, selector);
}
