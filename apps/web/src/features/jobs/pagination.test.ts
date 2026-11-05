import { describe, expect, it } from 'vitest';
import { lastPageIndex, PAGE_SIZE, type PageItem, pageItems, rangeText } from './pagination';

describe('PAGE_SIZE', () => {
  it('is ten jobs a page', () => {
    expect(PAGE_SIZE).toBe(10);
  });
});

describe('pageItems', () => {
  it('lists every page up to seven', () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(1, 2)).toEqual([1, 2]);
    expect(pageItems(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('is empty when there are no pages', () => {
    expect(pageItems(1, 0)).toEqual([]);
  });

  const cases: Array<[number, number, PageItem[]]> = [
    [1, 12, [1, 2, 3, 4, 5, 'gap-after', 12]],
    [3, 12, [1, 2, 3, 4, 5, 'gap-after', 12]],
    [4, 12, [1, 2, 3, 4, 5, 'gap-after', 12]],
    [5, 12, [1, 'gap-before', 4, 5, 6, 'gap-after', 12]],
    [6, 12, [1, 'gap-before', 5, 6, 7, 'gap-after', 12]],
    [9, 12, [1, 'gap-before', 8, 9, 10, 11, 12]],
    [12, 12, [1, 'gap-before', 8, 9, 10, 11, 12]],
  ];
  it.each(cases)('page %i of %i', (current, count, expected) => {
    expect(pageItems(current, count)).toEqual(expected);
  });

  it('never uses a gap for a single page', () => {
    for (let count = 8; count <= 30; count += 1) {
      for (let current = 1; current <= count; current += 1) {
        const items = pageItems(current, count);
        items.forEach((item, i) => {
          if (typeof item === 'number') return;
          const before = items[i - 1];
          const after = items[i + 1];
          expect(typeof before === 'number' && typeof after === 'number').toBe(true);
          expect((after as number) - (before as number)).toBeGreaterThan(2);
        });
        expect(items).toContain(current);
        expect(items[0]).toBe(1);
        expect(items.at(-1)).toBe(count);
      }
    }
  });
});

describe('rangeText', () => {
  it('names the rows on the page and the total', () => {
    expect(rangeText(0, 10, 12)).toBe('1–10 of 12');
    expect(rangeText(1, 10, 12)).toBe('11–12 of 12');
    expect(rangeText(0, 10, 3)).toBe('1–3 of 3');
    expect(rangeText(2, 10, 30)).toBe('21–30 of 30');
  });

  it('is "0 of 0" with no rows', () => {
    expect(rangeText(0, 10, 0)).toBe('0 of 0');
  });
});

describe('lastPageIndex', () => {
  it('is the zero-based index of the last page', () => {
    expect(lastPageIndex(10, 0)).toBe(0);
    expect(lastPageIndex(10, 10)).toBe(0);
    expect(lastPageIndex(10, 11)).toBe(1);
    expect(lastPageIndex(10, 12)).toBe(1);
    expect(lastPageIndex(10, 31)).toBe(3);
  });
});
