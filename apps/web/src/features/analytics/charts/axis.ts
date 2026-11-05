// Axis maths for the Analytics charts: round numbers for the grid lines, and which labels of a long
// row there is room for. Pure functions, no drawing.

/** Step sizes that read well on an axis, as a fraction of a power of ten: 1, 2, 2.5, 5, 10. */
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

/**
 * A round step (1, 2, 2.5 or 5 times a power of ten) that covers `0..max` in about `intervals`
 * steps, never fewer: 5 hours in 5 intervals is 1, 8 dollars in 4 is 2, 100% in 4 is 25%.
 * 1 for a `max` that is not above 0.
 */
export function niceStep(max: number, intervals: number): number {
  if (!Number.isFinite(max) || max <= 0 || intervals < 1) return 1;
  const raw = max / intervals;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = NICE_STEPS.find((step) => fraction <= step + 1e-9) ?? 10;
  return nice * power;
}

/** Float noise off a multiple of a step: 0.1 * 3 is 0.30000000000000004. */
function clean(value: number): number {
  return Number(value.toPrecision(12));
}

export interface AxisScale {
  /** The top of the axis: the first round step at or above the largest value. */
  max: number;
  /** The grid lines from 0 to `max`, lowest first. */
  ticks: number[];
}

/**
 * The scale for data whose largest value is `dataMax`: `0..max` in round steps, about `intervals`
 * of them. Nothing above 0 (no data, or all zero) gives 0..1 so the chart still has a scale.
 */
export function niceScale(dataMax: number, intervals = 4): AxisScale {
  const step = niceStep(dataMax, intervals);
  const top = dataMax > 0 ? Math.ceil(dataMax / step - 1e-9) * step : step;
  const count = Math.round(top / step);
  return {
    max: clean(top),
    ticks: Array.from({ length: count + 1 }, (_, i) => clean(i * step)),
  };
}

/** A scale with a fixed top (100%, say) and `intervals` equal steps: 0, 25, 50, 75, 100. */
export function fixedScale(max: number, intervals = 4): AxisScale {
  const steps = Math.max(1, Math.round(intervals));
  return {
    max,
    ticks: Array.from({ length: steps + 1 }, (_, i) => clean((max * i) / steps)),
  };
}

export interface ScaleOptions {
  /** The top of the axis. Default: a round number above the largest value. */
  yMax?: number;
  /** About how many grid steps there are (exactly, with a `yMax`). Default 4. */
  intervals?: number;
}

/** The axis for `values`: `yMax` split evenly when it is given, else round steps over the data. */
export function scaleFor(values: readonly (number | null)[], options: ScaleOptions): AxisScale {
  const intervals = options.intervals ?? 4;
  if (options.yMax !== undefined) return fixedScale(options.yMax, intervals);
  const numbers = values.filter((value): value is number => value !== null);
  return niceScale(numbers.length > 0 ? Math.max(...numbers) : 0, intervals);
}

/**
 * The scale for counts (jobs a day): whole numbers only, 0 up to a round number at or above `max`,
 * in about three steps, never fewer than one.
 */
export function countScale(max: number): AxisScale {
  const step = Math.max(1, Math.ceil(niceStep(max, 3)));
  const top = Math.max(step, Math.ceil(max / step) * step);
  return { max: top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
}
