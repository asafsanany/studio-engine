// The tiles' sparklines: a small line over a handful of weekly values, in the idea of the Money
// page's (banner-view.ts), with gaps for the weeks that have no data. Pure functions, no drawing.

/**
 * The axis of a sparkline over `values`: the lowest value sits at the bottom and the highest at the
 * top; values that are all the same make a flat line in the middle, or along the bottom when they
 * are all 0. With no data at all there is nothing to draw, and the axis is 0 to 1.
 */
export function sparklineDomain(values: readonly (number | null)[]): [number, number] {
  const numbers = values.filter((value): value is number => value !== null);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  if (numbers.length === 0) return [0, 1];
  if (min !== max) return [min, max];
  return min === 0 ? [0, 1] : [min - 1, max + 1];
}

/** The dot on the latest point and on a point a row marks, in px (a point alone is a bit smaller). */
const BIG_DOT = 2.5;
const ALONE_DOT = 2;

/**
 * The radius of the dot on the point at `index`, 0 for none: the latest point has one, a point its
 * row marks has one, and a point alone between gaps has a smaller one (its line has nothing to show
 * it by). A point with no value has none. Rows that mark nothing get only the latest point's dot
 * and the ones of points alone, as the Analytics tiles always had.
 */
export function sparklineDotRadius(
  rows: readonly { value: number | null; marked?: boolean }[],
  index: number,
): number {
  const row = rows[index];
  if (row === undefined || row.value === null) return 0;
  if (index === rows.length - 1 || row.marked === true) return BIG_DOT;
  const alone =
    (rows[index - 1]?.value ?? null) === null && (rows[index + 1]?.value ?? null) === null;
  return alone ? ALONE_DOT : 0;
}
