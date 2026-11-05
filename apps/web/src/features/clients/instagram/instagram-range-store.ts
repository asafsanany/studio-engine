import { DEFAULT_INSTAGRAM_RANGE, INSTAGRAM_RANGES, type InstagramRange } from '@studio/shared';
import { createStore, useStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { browserStorage, guardStorage } from '@/stores/jobs-ui';

/**
 * The range of the client page's Instagram section (Since us / 90 days / 30 days), remembered per
 * viewer: it is the same on every client's page and comes back after a reload. It is a view
 * control, not data, so it lives here and not in the address.
 */

/** localStorage key for the persisted range. Bump the `v1` suffix with the schema. */
export const INSTAGRAM_RANGE_STORAGE_KEY = 'studio.clients.instagramRange.v1';

/** Version of the persisted shape (see `migrate`). */
export const INSTAGRAM_RANGE_STORAGE_VERSION = 1;

export interface InstagramRangeState {
  range: InstagramRange;
}

export interface InstagramRangeActions {
  setRange: (range: InstagramRange) => void;
}

export type InstagramRangeStore = InstagramRangeState & InstagramRangeActions;

/** The slice that survives a reload. */
export interface PersistedInstagramRange {
  range: InstagramRange;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored range that is one of the three, otherwise the default (localStorage is user-editable). */
function toPersisted(value: unknown): PersistedInstagramRange {
  const stored = isRecord(value) ? value.range : undefined;
  const range = INSTAGRAM_RANGES.find((one) => one === stored);
  return { range: range ?? DEFAULT_INSTAGRAM_RANGE };
}

/** zustand `migrate`: version 1 is the first shape; any other version falls back to the default. */
export function migratePersistedRange(
  persisted: unknown,
  version: number,
): PersistedInstagramRange {
  return version === INSTAGRAM_RANGE_STORAGE_VERSION
    ? toPersisted(persisted)
    : toPersisted(undefined);
}

/**
 * Build the range store. `storage` is injectable so tests can simulate a reload by creating a
 * second store over the same storage.
 */
export function createInstagramRangeStore(storage: StateStorage = browserStorage()) {
  return createStore<InstagramRangeStore>()(
    persist(
      (set) => ({
        range: DEFAULT_INSTAGRAM_RANGE,
        setRange: (range) =>
          set((state) =>
            INSTAGRAM_RANGES.includes(range) && range !== state.range ? { range } : state,
          ),
      }),
      {
        name: INSTAGRAM_RANGE_STORAGE_KEY,
        version: INSTAGRAM_RANGE_STORAGE_VERSION,
        storage: createJSONStorage(() => guardStorage(storage)),
        partialize: (state): PersistedInstagramRange => ({ range: state.range }),
        migrate: (persisted, version) => migratePersistedRange(persisted, version),
        merge: (persisted, current) => ({ ...current, ...toPersisted(persisted) }),
      },
    ),
  );
}

/** The app-wide store, persisted to this browser's localStorage. */
export const instagramRangeStore = createInstagramRangeStore();

export function useInstagramRangeStore<T>(selector: (state: InstagramRangeStore) => T): T {
  return useStore(instagramRangeStore, selector);
}
