// What the job sheet's "Stock media" part says (Stock media, ST6): the sound effects and photos a
// job's runs took from Openverse and Unsplash, each with who made it and under what license, so the
// credits are never lost. The part is the same Details-style rows: the kind in the label column, the
// title as the value and one muted line under it.

import { STOCK_LICENSE_NAMES, type StockItem } from '@studio/shared';

export const STOCK_TEXT = {
  heading: 'Stock media',
  sources: 'Openverse · Unsplash',
  labels: { sfx: 'Sound effect', photo: 'Photo' },
  sourceNames: { openverse: 'Openverse', unsplash: 'Unsplash' },
} as const;

export interface StockRowView {
  id: string;
  /** "Sound effect" or "Photo". */
  label: string;
  /** The item's title; its kind when the source gave none. */
  title: string;
  /** Where to read about it (the item's own page). */
  href: string;
  /** "by Jane Doe", or empty when the source did not name anyone. */
  creator: string;
  creatorHref: string | null;
  /** "1.2 s · CC BY · Openverse": what it is, its license and where it came from. */
  detail: string;
}

/** A sound effect's length: "1.2 s", "0.4 s". */
export function stockSeconds(durationMs: number): string {
  return `${(Math.round(durationMs / 100) / 10).toFixed(1)} s`;
}

/** The rows for a job's items, oldest first, or `null` when it took nothing. */
export function sheetStock(items: readonly StockItem[]): StockRowView[] | null {
  if (items.length === 0) return null;
  return items.map((item) => {
    const size =
      item.durationMs === null
        ? item.width === null || item.height === null
          ? null
          : `${item.width} × ${item.height}`
        : stockSeconds(item.durationMs);
    const creator = item.creator.trim();
    return {
      id: item.id,
      label: STOCK_TEXT.labels[item.kind],
      title: item.title.trim() === '' ? STOCK_TEXT.labels[item.kind] : item.title.trim(),
      href: item.sourceUrl,
      creator: creator === '' ? '' : `by ${creator}`,
      creatorHref: creator === '' ? null : item.creatorUrl,
      detail: [size, STOCK_LICENSE_NAMES[item.license], STOCK_TEXT.sourceNames[item.source]]
        .filter((part): part is string => part !== null)
        .join(' · '),
    };
  });
}
