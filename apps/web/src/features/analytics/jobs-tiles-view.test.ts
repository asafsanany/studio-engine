import type { AnalyticsTile } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_TONE_CLASS,
  countText,
  NO_NUMBER,
  NOTHING_TO_COMPARE,
  sparklineColor,
  sparkRows,
  sparkValueText,
  tileView,
} from './jobs-tiles-view';

const WEEKLY = Array.from({ length: 8 }, () => null);

function tile(overrides: Partial<AnalyticsTile>): AnalyticsTile {
  return {
    key: 'jobs-finished',
    unit: 'count',
    value: null,
    previous: null,
    numerator: null,
    denominator: null,
    previousNumerator: null,
    previousDenominator: null,
    series: WEEKLY,
    ...overrides,
  };
}

const durationTile = (value: number | null, previous: number | null) =>
  tile({ key: 'files-in-ready', unit: 'duration-sec', value, previous });

function ratioTile(
  now: [number, number],
  before: [number, number],
  overrides: Partial<AnalyticsTile> = {},
): AnalyticsTile {
  const share = ([n, d]: [number, number]) => (d === 0 ? null : n / d);
  return tile({
    key: 'approved-first-time',
    unit: 'ratio',
    value: share(now),
    previous: share(before),
    numerator: now[0],
    denominator: now[1],
    previousNumerator: before[0],
    previousDenominator: before[1],
    ...overrides,
  });
}

describe('countText', () => {
  it('writes a whole number, with a thousands separator once it needs one', () => {
    expect(countText(0)).toBe('0');
    expect(countText(31)).toBe('31');
    expect(countText(1204)).toBe('1,204');
  });
});

describe('tileView of a count (Jobs finished, Clients)', () => {
  it('says how many more, in green', () => {
    expect(tileView(tile({ value: 31, previous: 27 }))).toEqual({
      value: '31',
      change: '+4 on the 30 days before',
      tone: 'better',
    });
  });

  it('says how many fewer, with a real minus, in red', () => {
    expect(tileView(tile({ key: 'clients', value: 5, previous: 8 }))).toEqual({
      value: '5',
      change: '−3 on the 30 days before',
      tone: 'worse',
    });
  });

  it('says the same, in grey, when nothing changed', () => {
    expect(tileView(tile({ value: 6, previous: 6 }))).toEqual({
      value: '6',
      change: 'Same as the 30 days before',
      tone: 'same',
    });
  });

  it('counts zero jobs as a number, and compares it', () => {
    expect(tileView(tile({ value: 0, previous: 3 }))).toEqual({
      value: '0',
      change: '−3 on the 30 days before',
      tone: 'worse',
    });
  });

  it('has nothing to compare with when the 30 days before have no data', () => {
    expect(tileView(tile({ value: 5, previous: null }))).toEqual({
      value: '5',
      change: NOTHING_TO_COMPARE,
      tone: 'same',
    });
  });

  it('shows a dash and no change line when there is no number', () => {
    expect(tileView(tile({ value: null, previous: null }))).toEqual({
      value: NO_NUMBER,
      change: '',
      tone: 'same',
    });
    expect(NO_NUMBER).toBe('—');
  });
});

describe('tileView of a time (Files in → ready, Editing time)', () => {
  it('writes the median as the board does', () => {
    expect(tileView(durationTile(2 * 3600 + 40 * 60, null)).value).toBe('2 h 40 m');
    expect(tileView(durationTile(52 * 60, null)).value).toBe('52 min');
  });

  it('says faster, in green, when the time went down: lower is better', () => {
    expect(tileView(durationTile(9600, 9600 + 25 * 60))).toEqual({
      value: '2 h 40 m',
      change: '25 min faster',
      tone: 'better',
    });
  });

  it('says slower, in red, when the time went up', () => {
    expect(tileView(durationTile(52 * 60, 35 * 60))).toEqual({
      value: '52 min',
      change: '17 min slower',
      tone: 'worse',
    });
  });

  it('says the same, in grey, when it did not change to the second', () => {
    expect(tileView(durationTile(600, 600.2))).toEqual({
      value: '10 min',
      change: 'Same as the 30 days before',
      tone: 'same',
    });
  });

  it('has nothing to compare with, or no number, like a count', () => {
    expect(tileView(durationTile(600, null))).toMatchObject({ change: NOTHING_TO_COMPARE });
    expect(tileView(durationTile(null, 600))).toEqual({ value: '—', change: '', tone: 'same' });
  });
});

describe('tileView of x of y (Approved first time)', () => {
  it('says "19 of 24" and "was 14 of 21", in green when the share went up', () => {
    expect(tileView(ratioTile([19, 24], [14, 21]))).toEqual({
      value: '19 of 24',
      change: 'was 14 of 21',
      tone: 'better',
    });
  });

  it('is red when the share went down, and grey when it is the same', () => {
    expect(tileView(ratioTile([10, 24], [14, 21])).tone).toBe('worse');
    expect(tileView(ratioTile([14, 21], [2, 3])).tone).toBe('same');
  });

  it('shows a dash for 0 of 0, and keeps "was" for the window before', () => {
    expect(tileView(ratioTile([0, 0], [14, 21]))).toEqual({
      value: '—',
      change: 'was 14 of 21',
      tone: 'same',
    });
    expect(tileView(ratioTile([0, 0], [0, 0]))).toEqual({ value: '—', change: '', tone: 'same' });
  });

  it('has nothing to compare with when nothing was approved before', () => {
    expect(tileView(ratioTile([2, 3], [0, 0]))).toEqual({
      value: '2 of 3',
      change: NOTHING_TO_COMPARE,
      tone: 'same',
    });
  });

  it('says 0 of 2 when jobs were approved and none came first time', () => {
    expect(tileView(ratioTile([0, 2], [1, 2])).value).toBe('0 of 2');
  });
});

describe('the change line colours', () => {
  it('are the Money page greens, reds and greys', () => {
    expect(CHANGE_TONE_CLASS).toEqual({
      better: 'text-[#4ADE80]',
      worse: 'text-[#F87171]',
      same: 'text-muted-foreground',
    });
  });
});

describe('sparklineColor', () => {
  it('is green when better, red when worse, and the default blue otherwise', () => {
    expect(sparklineColor('better')).toBe('#4ADE80');
    expect(sparklineColor('worse')).toBe('#F87171');
    expect(sparklineColor('same')).toBeUndefined();
  });
});

describe('sparkRows', () => {
  const tile = (
    series: (number | null)[],
    unit: AnalyticsTile['unit'] = 'count',
  ): AnalyticsTile => ({
    key: 'jobs-finished',
    unit,
    value: 1,
    previous: 1,
    numerator: null,
    denominator: null,
    previousNumerator: null,
    previousDenominator: null,
    series,
  });

  it('says how long ago each week was, the newest as this week', () => {
    const rows = sparkRows(tile([1, 2, 3, null]));
    expect(rows.map((row) => row.title)).toEqual([
      '3 weeks ago',
      '2 weeks ago',
      'Last week',
      'This week',
    ]);
    expect(rows.map((row) => row.value)).toEqual([1, 2, 3, null]);
  });

  it('says how long ago each day was in the week period', () => {
    const rows = sparkRows(tile([1, 2, 3, 4]), 'week');
    expect(rows.map((row) => row.title)).toEqual([
      '3 days ago',
      '2 days ago',
      'Yesterday',
      'Today',
    ]);
  });

  it('says how long ago each day was for the Clients tile, in the month period too', () => {
    const rows = sparkRows({ ...tile([1, 2, 2]), key: 'clients' }, 'month');
    expect(rows.map((row) => row.title)).toEqual(['2 days ago', 'Yesterday', 'Today']);
  });

  it('writes a value the way its tile does: a count, a time, a share', () => {
    expect(sparkValueText(tile([]), 1204)).toBe('1,204');
    expect(sparkValueText(tile([], 'duration-sec'), 9600)).toBe('2 h 40 m');
    expect(sparkValueText(tile([], 'ratio'), 0.79)).toBe('79%');
  });
});
