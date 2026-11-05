import type { StockItem } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { STOCK_TEXT, sheetStock, stockSeconds } from './sheet-stock';

const sfx: StockItem = {
  id: 'sfx-1',
  kind: 'sfx',
  source: 'openverse',
  sourceId: 'ov-1',
  file: 'sfx-1.mp3',
  title: 'Whoosh',
  creator: 'Jane Doe',
  creatorUrl: 'https://freesound.org/people/jane/',
  license: 'by',
  licenseUrl: null,
  sourceUrl: 'https://freesound.org/s/1/',
  query: 'whoosh',
  run: '',
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
  title: 'A street at night',
  creator: 'Sam Lee',
  creatorUrl: null,
  license: 'unsplash',
  sourceUrl: 'https://unsplash.com/photos/ph1',
  durationMs: null,
  width: 4000,
  height: 6000,
};

describe('sheetStock', () => {
  it('shows nothing for a job that took nothing', () => {
    expect(sheetStock([])).toBeNull();
  });

  it('describes a sound effect with its length, license and source', () => {
    expect(sheetStock([sfx])).toEqual([
      {
        id: 'sfx-1',
        label: 'Sound effect',
        title: 'Whoosh',
        href: 'https://freesound.org/s/1/',
        creator: 'by Jane Doe',
        creatorHref: 'https://freesound.org/people/jane/',
        detail: '1.2 s · CC BY · Openverse',
      },
    ]);
  });

  it('describes a photo with its size', () => {
    expect(sheetStock([photo])?.[0]).toMatchObject({
      label: 'Photo',
      title: 'A street at night',
      creator: 'by Sam Lee',
      creatorHref: null,
      detail: '4000 × 6000 · Unsplash License · Unsplash',
    });
  });

  it('keeps the order, and falls back to the kind for a missing title and to nothing for a missing creator', () => {
    const rows = sheetStock([photo, { ...sfx, title: ' ', creator: '' }]);
    expect(rows?.map((row) => row.id)).toEqual(['photo-1', 'sfx-1']);
    expect(rows?.[1]).toMatchObject({ title: 'Sound effect', creator: '', creatorHref: null });
  });

  it('leaves out a size it does not have', () => {
    expect(sheetStock([{ ...photo, width: null }])?.[0]?.detail).toBe(
      'Unsplash License · Unsplash',
    );
  });

  it('names its heading and sources', () => {
    expect(STOCK_TEXT.heading).toBe('Stock media');
    expect(stockSeconds(400)).toBe('0.4 s');
    expect(stockSeconds(12_000)).toBe('12.0 s');
  });
});
