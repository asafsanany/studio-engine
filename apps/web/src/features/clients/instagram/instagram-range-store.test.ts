import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@/stores/jobs-ui';
import {
  createInstagramRangeStore,
  INSTAGRAM_RANGE_STORAGE_KEY,
  INSTAGRAM_RANGE_STORAGE_VERSION,
  migratePersistedRange,
} from './instagram-range-store';

describe('the Instagram range, remembered per viewer', () => {
  it('starts on since us', () => {
    expect(createInstagramRangeStore(createMemoryStorage()).getState().range).toBe('since');
  });

  it('comes back after a reload', () => {
    const storage = createMemoryStorage();
    createInstagramRangeStore(storage).getState().setRange('30');
    expect(createInstagramRangeStore(storage).getState().range).toBe('30');
  });

  it('keeps the last choice', () => {
    const storage = createMemoryStorage();
    const store = createInstagramRangeStore(storage);
    store.getState().setRange('90');
    store.getState().setRange('since');
    expect(createInstagramRangeStore(storage).getState().range).toBe('since');
  });

  it('ignores a range that is not one of the three', () => {
    const store = createInstagramRangeStore(createMemoryStorage());
    store.getState().setRange('7' as never);
    expect(store.getState().range).toBe('since');
  });

  it('falls back to since us for a stored value somebody edited', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      INSTAGRAM_RANGE_STORAGE_KEY,
      JSON.stringify({ state: { range: 'forever' }, version: INSTAGRAM_RANGE_STORAGE_VERSION }),
    );
    expect(createInstagramRangeStore(storage).getState().range).toBe('since');
    storage.setItem(INSTAGRAM_RANGE_STORAGE_KEY, 'not json');
    expect(createInstagramRangeStore(storage).getState().range).toBe('since');
  });

  it('falls back to since us for a shape of another version', () => {
    expect(migratePersistedRange({ range: '30' }, 99)).toEqual({ range: 'since' });
    expect(migratePersistedRange({ range: '30' }, INSTAGRAM_RANGE_STORAGE_VERSION)).toEqual({
      range: '30',
    });
  });

  it('works when the storage throws (private mode)', () => {
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
    const store = createInstagramRangeStore(broken);
    store.getState().setRange('90');
    expect(store.getState().range).toBe('90');
  });
});
