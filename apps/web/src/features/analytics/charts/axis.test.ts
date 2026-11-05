import { describe, expect, it } from 'vitest';
import { countScale, fixedScale, niceScale, niceStep, scaleFor } from './axis';

describe('niceStep', () => {
  it.each([
    [5, 5, 1],
    [8, 4, 2],
    [1, 4, 0.25],
    [1, 2, 0.5],
    [100, 4, 25],
    [3.4, 5, 1],
    [47, 4, 20],
    [0.9, 3, 0.5],
    [12_000, 4, 5_000],
  ])('covers 0..%d in %d intervals with %d', (max, intervals, step) => {
    expect(niceStep(max, intervals)).toBeCloseTo(step, 10);
  });

  it('never makes the axis shorter than the data', () => {
    for (const max of [0.3, 1, 2.2, 7, 13, 99, 450, 3_001]) {
      const intervals = 4;
      expect(niceStep(max, intervals) * intervals).toBeGreaterThanOrEqual(max - 1e-9);
    }
  });

  it('is 1 when there is nothing above 0', () => {
    expect(niceStep(0, 4)).toBe(1);
    expect(niceStep(-3, 4)).toBe(1);
    expect(niceStep(Number.NaN, 4)).toBe(1);
    expect(niceStep(Number.POSITIVE_INFINITY, 4)).toBe(1);
  });
});

describe('niceScale', () => {
  it('goes from 0 to a round number above the largest value, in round steps', () => {
    expect(niceScale(2.6, 5)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceScale(7.4, 4)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(31, 4)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
  });

  it('ends on the largest value when it is already round', () => {
    expect(niceScale(5, 5)).toEqual({ max: 5, ticks: [0, 1, 2, 3, 4, 5] });
    expect(niceScale(8, 4)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
  });

  it('has no float noise in its ticks', () => {
    expect(niceScale(0.9, 3).ticks).toEqual([0, 0.5, 1]);
    expect(niceScale(0.3, 3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('still has a scale when there is nothing to draw', () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe('fixedScale', () => {
  it('splits a fixed top into equal steps', () => {
    expect(fixedScale(1, 4)).toEqual({ max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(fixedScale(1, 2)).toEqual({ max: 1, ticks: [0, 0.5, 1] });
    expect(fixedScale(5, 5).ticks).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('has no float noise in its ticks', () => {
    expect(fixedScale(0.3, 3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('has at least one step', () => {
    expect(fixedScale(1, 0).ticks).toEqual([0, 1]);
  });
});

describe('scaleFor', () => {
  it('splits a fixed top evenly', () => {
    expect(scaleFor([0.2, 0.9], { yMax: 1, intervals: 4 })).toEqual({
      max: 1,
      ticks: [0, 0.25, 0.5, 0.75, 1],
    });
  });

  it('rounds the largest value up when there is no fixed top, and skips the gaps', () => {
    expect(scaleFor([1.2, null, 6.1, 3], { intervals: 4 })).toEqual({
      max: 8,
      ticks: [0, 2, 4, 6, 8],
    });
  });

  it('still has a scale when every value is missing', () => {
    expect(scaleFor([null, null], {})).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe('countScale', () => {
  it('counts in whole numbers, a step of 1 for a few jobs', () => {
    expect(countScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(countScale(1)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it('has a scale for no jobs at all', () => {
    expect(countScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it('rounds up to a round step when there are many', () => {
    const big = countScale(40);
    expect(big.max).toBeGreaterThanOrEqual(40);
    expect(big.ticks.every(Number.isInteger)).toBe(true);
    expect(big.ticks[0]).toBe(0);
    expect(big.ticks.at(-1)).toBe(big.max);
  });
});
