import type { StockItem } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StockPanel } from './JobSheetStock';
import { sheetStock } from './sheet-stock';

// The markup of the sheet's "Stock media" part (Stock media, ST6).

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

const panel = (items: StockItem[], variant?: 'phone') => {
  const rows = sheetStock(items);
  if (rows === null) throw new Error('nothing taken');
  return renderToStaticMarkup(<StockPanel rows={rows} {...(variant ? { variant } : {})} />);
};

describe('StockPanel', () => {
  it('has the heading, the two sources and a row for each item', () => {
    const html = panel([sfx, photo]);
    expect(html).toContain('aria-label="Stock media"');
    expect(html).toContain('Openverse · Unsplash');
    expect(html).toContain('data-stock="sfx-1"');
    expect(html).toContain('data-stock="photo-1"');
    expect(html).toContain('Sound effect');
    expect(html).toContain('1.2 s · CC BY · Openverse');
    expect(html).toContain('4000 × 6000 · Unsplash License · Unsplash');
  });

  it('links the title to its page and the creator to theirs, in a new tab, safely', () => {
    const html = panel([sfx]);
    expect(html).toContain('href="https://freesound.org/s/1/"');
    expect(html).toContain('href="https://freesound.org/people/jane/"');
    expect(html).toContain('>by Jane Doe</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('names a creator without a link in plain text', () => {
    const html = panel([photo]);
    expect(html).toContain('by Sam Lee · ');
    expect(html).not.toContain('>by Sam Lee</a>');
  });

  it('is wider in its label column on the phone', () => {
    expect(panel([sfx], 'phone')).toContain('grid-cols-[112px_minmax(0,1fr)]');
    expect(panel([sfx])).toContain('grid-cols-[96px_minmax(0,1fr)]');
  });
});
