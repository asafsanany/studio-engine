import { describe, expect, it } from 'vitest';
import {
  emptyStockCache,
  emptyStockRecord,
  nextStockId,
  STOCK_FILES,
  STOCK_LIMITS,
  STOCK_SOURCES,
  type StockItem,
  stockCacheSchema,
  stockCreditLine,
  stockItemSchema,
  stockNeedsCredit,
  stockRecordSchema,
  stockResponseSchema,
} from './stock.ts';

const sfx: StockItem = {
  id: 'sfx-1',
  kind: 'sfx',
  source: 'openverse',
  sourceId: 'abc',
  file: 'sfx-1.mp3',
  title: 'Whoosh',
  creator: 'Jane Doe',
  creatorUrl: 'https://example.org/jane',
  license: 'by',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  sourceUrl: 'https://openverse.org/audio/abc',
  query: 'whoosh',
  run: 'run-1',
  durationMs: 1200,
  width: null,
  height: null,
  fetchedAt: '2026-10-25T10:00:00.000Z',
};

const photo: StockItem = {
  ...sfx,
  id: 'photo-1',
  kind: 'photo',
  source: 'unsplash',
  file: 'photo-1.jpg',
  title: 'A street at night',
  creator: 'Sam Lee',
  license: 'unsplash',
  durationMs: null,
  width: 4000,
  height: 6000,
};

describe('stock record', () => {
  it('reads what the stock script writes', () => {
    expect(stockRecordSchema.parse({ version: 1, items: [sfx, photo] }).items).toHaveLength(2);
    expect(stockRecordSchema.parse(emptyStockRecord()).items).toEqual([]);
  });

  it('rejects a bad id, an unknown license and a record of another version', () => {
    expect(stockItemSchema.safeParse({ ...sfx, id: 'music-1' }).success).toBe(false);
    expect(stockItemSchema.safeParse({ ...sfx, id: 'sfx-0' }).success).toBe(false);
    expect(stockItemSchema.safeParse({ ...sfx, license: 'by-nc' }).success).toBe(false);
    expect(stockRecordSchema.safeParse({ version: 2, items: [] }).success).toBe(false);
  });

  it('numbers each kind on its own', () => {
    const record = { version: 1 as const, items: [sfx, { ...sfx, id: 'sfx-3' }, photo] };
    expect(nextStockId(emptyStockRecord(), 'sfx')).toBe('sfx-1');
    expect(nextStockId(record, 'sfx')).toBe('sfx-4');
    expect(nextStockId(record, 'photo')).toBe('photo-2');
  });
});

describe('credit', () => {
  it('names the creator, the license and the source', () => {
    expect(stockCreditLine(sfx)).toBe('Whoosh by Jane Doe (CC BY, Openverse)');
    expect(stockCreditLine(photo)).toBe(
      'A street at night by Sam Lee (Unsplash License, Unsplash)',
    );
  });

  it('leaves out a creator the source did not name and falls back to the id for a title', () => {
    expect(stockCreditLine({ ...sfx, creator: ' ', title: '' })).toBe('sfx-1 (CC BY, Openverse)');
  });

  it('asks for credit on CC BY and Unsplash only', () => {
    expect(stockNeedsCredit('by')).toBe(true);
    expect(stockNeedsCredit('unsplash')).toBe(true);
    expect(stockNeedsCredit('cc0')).toBe(false);
    expect(stockNeedsCredit('pdm')).toBe(false);
  });
});

describe('contract', () => {
  it('keeps sound effects on Openverse and photos on Unsplash', () => {
    expect(STOCK_SOURCES).toEqual({ sfx: 'openverse', photo: 'unsplash' });
  });

  it('has limits that fit together', () => {
    expect(STOCK_LIMITS.sfxDefaultMaxSeconds).toBeLessThanOrEqual(STOCK_LIMITS.sfxMaxSeconds);
    expect(STOCK_FILES.record.startsWith(`${STOCK_FILES.dir}/`)).toBe(true);
    expect(STOCK_FILES.cache.startsWith(`${STOCK_FILES.dir}/`)).toBe(true);
  });

  it('reads an empty cache and a cache with a search', () => {
    expect(stockCacheSchema.parse(emptyStockCache()).searches).toEqual([]);
    const cache = {
      version: 1,
      searches: [
        {
          kind: 'sfx',
          query: 'whoosh',
          at: '2026-10-25T10:00:00.000Z',
          candidates: [
            {
              ref: 'c1',
              sourceId: 'abc',
              title: 'Whoosh',
              creator: 'Jane Doe',
              creatorUrl: null,
              license: 'by',
              licenseUrl: null,
              sourceUrl: 'https://openverse.org/audio/abc',
              downloadUrl: 'https://example.org/abc.mp3',
              fileType: 'mp3',
              trackUrl: null,
              durationMs: 1200,
              width: null,
              height: null,
            },
          ],
        },
      ],
    };
    expect(stockCacheSchema.parse(cache).searches[0]?.candidates).toHaveLength(1);
  });
});

describe('stock response', () => {
  it('parses a job with items and a job with none', () => {
    expect(stockResponseSchema.parse({ jobId: 'j1', items: [sfx, photo] }).items).toHaveLength(2);
    expect(stockResponseSchema.parse({ jobId: 'j1', items: [] }).items).toEqual([]);
    expect(stockResponseSchema.safeParse({ jobId: '', items: [] }).success).toBe(false);
  });
});
