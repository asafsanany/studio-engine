import { describe, expect, it } from 'vitest';
import { sparklineDomain, sparklineDotRadius } from './sparkline-layout';

describe('sparklineDomain', () => {
  it('runs from the lowest value to the highest', () => {
    expect(sparklineDomain([4, 6, 8, 6, 12, 8, 14, 15])).toEqual([4, 15]);
  });

  it('skips the weeks with no data', () => {
    expect(sparklineDomain([null, 3, null, 9])).toEqual([3, 9]);
  });

  it('puts a flat line in the middle, or along the bottom when it is all 0', () => {
    expect(sparklineDomain([5, 5, 5])).toEqual([4, 6]);
    expect(sparklineDomain([0, 0, 0])).toEqual([0, 1]);
  });

  it('has an axis for no data at all', () => {
    expect(sparklineDomain([null, null])).toEqual([0, 1]);
    expect(sparklineDomain([])).toEqual([0, 1]);
  });
});

describe('sparklineDotRadius', () => {
  const rows = (values: (number | null)[], marked: number[] = []) =>
    values.map((value, index) => ({ value, marked: marked.includes(index) }));
  const radii = (list: ReturnType<typeof rows>) => list.map((_, i) => sparklineDotRadius(list, i));

  it('gives the latest point a dot and nothing else on a line with no gaps, as it always did', () => {
    expect(radii(rows([4, 6, 8, 6]))).toEqual([0, 0, 0, 2.5]);
    // Rows without a `marked` field at all are the same.
    const plain = [{ value: 1 }, { value: 2 }, { value: 3 }];
    expect(plain.map((_, i) => sparklineDotRadius(plain, i))).toEqual([0, 0, 2.5]);
  });

  it('gives a point alone between gaps a smaller dot', () => {
    expect(radii(rows([1, null, 5, null, 7]))).toEqual([2, 0, 2, 0, 2.5]);
  });

  it('gives each marked point a dot like the latest one', () => {
    expect(radii(rows([4, 6, 8, 6, 9, 7], [1, 4]))).toEqual([0, 2.5, 0, 0, 2.5, 2.5]);
  });

  it('gives a point with no value no dot, marked or not', () => {
    expect(radii(rows([4, null, 8], [1]))).toEqual([2, 0, 2.5]);
    expect(radii(rows([4, 8, null], [2]))).toEqual([0, 0, 0]);
  });

  it('has no dot for a point that is not there', () => {
    expect(sparklineDotRadius([], 0)).toBe(0);
    expect(sparklineDotRadius(rows([1, 2]), 5)).toBe(0);
  });
});
