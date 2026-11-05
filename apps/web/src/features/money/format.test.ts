import { describe, expect, it } from 'vitest';
import {
  formatIls,
  formatIlsAgorot,
  monthLabel,
  monthName,
  pagerRangeText,
  roundWhole,
} from './format';

describe('formatIls', () => {
  it('writes whole shekels with a thousands separator', () => {
    expect(formatIls(0)).toBe('₪0');
    expect(formatIls(200)).toBe('₪200');
    expect(formatIls(4400)).toBe('₪4,400');
    expect(formatIls(1234567)).toBe('₪1,234,567');
  });

  it('rounds to the shekel, halves away from zero: 81.4 is ₪81 and 4,239.6 is ₪4,240', () => {
    expect(formatIls(81.4)).toBe('₪81');
    expect(formatIls(4239.6)).toBe('₪4,240');
    expect(formatIls(960.4)).toBe('₪960');
    expect(formatIls(0.5)).toBe('₪1');
    expect(formatIls(2.5)).toBe('₪3');
  });

  it('puts the real minus sign (U+2212) before the shekel sign', () => {
    expect(formatIls(-800)).toBe('−₪800');
    expect(formatIls(-1234.5)).toBe('−₪1,235');
    expect(formatIls(-2.5)).toBe('−₪3');
  });

  it('has no minus for an amount that rounds to nothing', () => {
    expect(formatIls(-0.4)).toBe('₪0');
    expect(formatIls(-0)).toBe('₪0');
  });
});

describe('formatIlsAgorot', () => {
  it('always writes two decimals', () => {
    expect(formatIlsAgorot(7.5)).toBe('₪7.50');
    expect(formatIlsAgorot(200)).toBe('₪200.00');
    expect(formatIlsAgorot(0)).toBe('₪0.00');
    expect(formatIlsAgorot(1250)).toBe('₪1,250.00');
    expect(formatIlsAgorot(81.4)).toBe('₪81.40');
  });

  it('puts the minus sign before the shekel sign, and none on a zero', () => {
    expect(formatIlsAgorot(-7.5)).toBe('−₪7.50');
    expect(formatIlsAgorot(-0.001)).toBe('₪0.00');
  });
});

describe('roundWhole', () => {
  it('rounds halves away from zero and never gives negative zero', () => {
    expect(roundWhole(2.5)).toBe(3);
    expect(roundWhole(-2.5)).toBe(-3);
    expect(roundWhole(-0.4)).toBe(0);
    expect(Object.is(roundWhole(-0.4), 0)).toBe(true);
    expect(roundWhole(4239.6)).toBe(4240);
  });
});

describe('monthName and monthLabel', () => {
  it('say the month in English, with the year for the label', () => {
    expect(monthName('2026-10')).toBe('October');
    expect(monthName('2026-01')).toBe('January');
    expect(monthName('2026-12')).toBe('December');
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('2025-09')).toBe('September 2025');
  });

  it('give back what is not a month as it came', () => {
    expect(monthName('2026-13')).toBe('2026-13');
    expect(monthLabel('soon')).toBe('soon');
  });
});

describe('pagerRangeText', () => {
  const jobs = { one: 'job', many: 'jobs' };

  it('says the range with "Showing", the way the board does', () => {
    expect(pagerRangeText(0, 10, 26, jobs)).toBe('Showing 1–10 of 26 jobs');
    expect(pagerRangeText(1, 10, 26, jobs)).toBe('Showing 11–20 of 26 jobs');
    expect(pagerRangeText(2, 10, 26, jobs)).toBe('Showing 21–26 of 26 jobs');
  });

  it('uses the singular for one row, and says 0–0 for none', () => {
    expect(pagerRangeText(0, 10, 1, jobs)).toBe('Showing 1–1 of 1 job');
    expect(pagerRangeText(0, 10, 0, jobs)).toBe('Showing 0–0 of 0 jobs');
  });
});
