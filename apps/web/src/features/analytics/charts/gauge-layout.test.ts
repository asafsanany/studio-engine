import { describe, expect, it } from 'vitest';
import { GAUGE_ARC, gaugeLayout } from './gauge-layout';

describe('gaugeLayout', () => {
  it('draws the arc across the top, from the left end to the right end', () => {
    expect(GAUGE_ARC).toBe('M 24 124 A 96 96 0 0 1 216 124');
  });

  it('fills as much of the arc as is used, out of 100', () => {
    expect(gaugeLayout(0.26, null).dash).toBe('26 100');
    expect(gaugeLayout(0, null).dash).toBe('0 100');
    expect(gaugeLayout(0.2571, null).dash).toBe('25.7 100');
  });

  it('keeps the arc full when more than all is used, and empty for less than none', () => {
    expect(gaugeLayout(1.4, null).dash).toBe('100 100');
    expect(gaugeLayout(-0.2, null).dash).toBe('0 100');
  });

  it('has no tick without one', () => {
    expect(gaugeLayout(0.5, null).tick).toBeNull();
  });

  it('puts the tick across the arc at the share of the way along it', () => {
    // Start of the arc: the left end, level with the centre.
    expect(gaugeLayout(0, 0).tick).toEqual({ x1: 40, y1: 124, x2: 8, y2: 124 });
    // Half way: straight up from the centre.
    expect(gaugeLayout(0, 0.5).tick).toEqual({ x1: 120, y1: 44, x2: 120, y2: 12 });
    // The end: the right end.
    expect(gaugeLayout(0, 1).tick).toEqual({ x1: 200, y1: 124, x2: 232, y2: 124 });
  });

  it('keeps the tick on the arc for a share outside 0 to 1', () => {
    expect(gaugeLayout(0, 3).tick).toEqual(gaugeLayout(0, 1).tick);
    expect(gaugeLayout(0, -1).tick).toEqual(gaugeLayout(0, 0).tick);
  });

  it('is the board’s tick at 76% of the way along', () => {
    const tick = gaugeLayout(0, 0.763).tick;
    expect(tick?.x1).toBeCloseTo(178.8, 0);
    expect(tick?.y1).toBeCloseTo(69.8, 0);
    expect(tick?.x2).toBeCloseTo(202.3, 0);
    expect(tick?.y2).toBeCloseTo(48.1, 0);
  });
});
