import { describe, expect, it } from 'vitest';
import { cellWidth, tableWidth } from './column-widths';

describe('cell widths', () => {
  it('gives each cell half of each neighbouring gap, and the row padding at the two ends', () => {
    expect(cellWidth(190, 0, 8)).toBe(190 + 12 + 6);
    expect(cellWidth(110, 1, 8)).toBe(110 + 6 + 6);
    expect(cellWidth(72, 7, 8)).toBe(72 + 6 + 12);
    expect(cellWidth(100, 0, 1)).toBe(100 + 12 + 12);
  });

  it('adds up to the content, the gaps and the row padding', () => {
    const content = [190, 110, 172, 64, 84, 108, 270, 52];
    expect(tableWidth(content)).toBe(1050 + 7 * 12 + 2 * 12);
  });

  it('is nothing for no columns', () => {
    expect(tableWidth([])).toBe(0);
  });
});
