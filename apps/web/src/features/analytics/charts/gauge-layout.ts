// The half-circle gauge of the two budget cards: a track, the part used drawn over it, and a white
// tick for how much of the month (or week) has passed. Pure functions, no drawing. The numbers are
// the board's: a 240 × 150 drawing, the arc 96 from the centre and 18 thick, the tick from 80 to
// 112 from the centre.

export const GAUGE_WIDTH = 240;
export const GAUGE_HEIGHT = 150;
export const GAUGE_CENTER = { x: 120, y: 124 } as const;
export const GAUGE_RADIUS = 96;
export const GAUGE_THICKNESS = 18;
/** The tick reaches from this far from the centre to that far. */
const TICK_INNER = 80;
const TICK_OUTER = 112;

/** The arc, from the left end to the right end across the top. */
export const GAUGE_ARC = `M ${GAUGE_CENTER.x - GAUGE_RADIUS} ${GAUGE_CENTER.y} A ${GAUGE_RADIUS} ${GAUGE_RADIUS} 0 0 1 ${GAUGE_CENTER.x + GAUGE_RADIUS} ${GAUGE_CENTER.y}`;

const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * What the drawing needs: how much of the arc is filled (`dash`, out of the arc's `pathLength` of
 * 100: the share used, never more than the whole arc) and where the tick stands (`null` for none).
 */
export interface GaugeLayout {
  dash: string;
  tick: { x1: number; y1: number; x2: number; y2: number } | null;
}

/** A point on the half circle at `share` of the way along it (0 the left end, 1 the right end), `radius` from the centre. */
function pointAt(share: number, radius: number): { x: number; y: number } {
  const angle = Math.PI * share;
  return {
    x: round1(GAUGE_CENTER.x - radius * Math.cos(angle)),
    y: round1(GAUGE_CENTER.y - radius * Math.sin(angle)),
  };
}

/** `used` and `tick` are shares, 0 to 1 (`used` may be more: the arc stays full). */
export function gaugeLayout(used: number, tick: number | null): GaugeLayout {
  const inner = tick === null ? null : pointAt(clamp01(tick), TICK_INNER);
  const outer = tick === null ? null : pointAt(clamp01(tick), TICK_OUTER);
  return {
    dash: `${round1(clamp01(used) * 100)} 100`,
    tick:
      inner === null || outer === null
        ? null
        : { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y },
  };
}
