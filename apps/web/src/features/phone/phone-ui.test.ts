import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@/stores/jobs-ui';
import {
  BY_CLIENT_STORAGE_KEY,
  BY_CLIENT_STORAGE_VERSION,
  createPhoneUiStore,
  defaultPhoneUiState,
  migratePersistedByClient,
} from './phone-ui';

/** What the store wrote to storage, as the persisted object. */
function stored(storage: ReturnType<typeof createMemoryStorage>) {
  const raw = storage.getItem(BY_CLIENT_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw as string);
}

describe('the phone UI store', () => {
  it('starts with By client on', () => {
    expect(defaultPhoneUiState()).toEqual({ byClient: true });
    expect(createPhoneUiStore(createMemoryStorage()).getState().byClient).toBe(true);
  });

  it('remembers By client being turned off, across a reload', () => {
    const storage = createMemoryStorage();
    createPhoneUiStore(storage).getState().setByClient(false);
    expect(stored(storage)).toEqual({
      state: { byClient: false },
      version: BY_CLIENT_STORAGE_VERSION,
    });

    // A reload is a new store over the same storage.
    expect(createPhoneUiStore(storage).getState().byClient).toBe(false);
  });

  it('remembers it being turned back on', () => {
    const storage = createMemoryStorage();
    const store = createPhoneUiStore(storage);
    store.getState().setByClient(false);
    store.getState().setByClient(true);
    expect(createPhoneUiStore(storage).getState().byClient).toBe(true);
  });

  it('keeps nothing but the switch', () => {
    const storage = createMemoryStorage();
    createPhoneUiStore(storage).getState().setByClient(false);
    expect(Object.keys(stored(storage).state)).toEqual(['byClient']);
  });

  it('does not share its key with the Mac’s Show archived switch', () => {
    const storage = createMemoryStorage();
    createPhoneUiStore(storage).getState().setByClient(false);
    expect(storage.getItem('studio.jobs.showArchived.v1')).toBeNull();
  });

  it('starts on when the stored value is unreadable or from another version', () => {
    for (const raw of [
      'not json',
      '{"state":{"byClient":"no"},"version":1}',
      '{"state":null,"version":1}',
      '{"state":{"byClient":false},"version":99}',
    ]) {
      const storage = createMemoryStorage();
      storage.setItem(BY_CLIENT_STORAGE_KEY, raw);
      expect(createPhoneUiStore(storage).getState().byClient, raw).toBe(true);
    }
  });

  it('works with storage that throws (private mode)', () => {
    const broken = {
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
    const store = createPhoneUiStore(broken);
    expect(store.getState().byClient).toBe(true);
    store.getState().setByClient(false);
    expect(store.getState().byClient).toBe(false);
  });
});

describe('migratePersistedByClient', () => {
  it('reads version 1 and falls back to on for anything else', () => {
    expect(migratePersistedByClient({ byClient: false }, 1)).toEqual({ byClient: false });
    expect(migratePersistedByClient({ byClient: true }, 1)).toEqual({ byClient: true });
    expect(migratePersistedByClient({ byClient: false }, 2)).toEqual({ byClient: true });
    expect(migratePersistedByClient(undefined, 1)).toEqual({ byClient: true });
  });
});
