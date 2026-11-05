import type { MoneyExpenseCharge } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  chargeDate,
  chargeJobName,
  chargesByDate,
  countText,
  EXPENSES_VIEW_LABELS,
  emptyExpensesText,
  expensesDescription,
  expensesFooter,
  expensesRangeText,
  openItemId,
  pageSlice,
} from './expenses-view';

function charge(
  date: string,
  item = 'Stock footage',
  what = 'Clip licence #1',
): MoneyExpenseCharge {
  return { date, item, what, amountLabel: '₪7.50', ils: 7.5, job: null };
}

describe('expensesDescription', () => {
  it('says what the list holds and the rate, to the agora', () => {
    expect(expensesDescription(3.7)).toBe(
      'Everything you actually paid this month: subscriptions and usage charges. Dollar amounts are converted at ₪3.70.',
    );
  });

  it('follows the rate of the answer', () => {
    expect(expensesDescription(3.456)).toContain('converted at ₪3.46.');
    expect(expensesDescription(4)).toContain('converted at ₪4.00.');
  });
});

describe('the switch', () => {
  it('lists Items, then All charges', () => {
    expect(EXPENSES_VIEW_LABELS).toEqual([
      { view: 'items', label: 'Items' },
      { view: 'charges', label: 'All charges' },
    ]);
  });
});

describe('emptyExpensesText', () => {
  it('names the month', () => {
    expect(emptyExpensesText('2026-10')).toBe('No expenses in October.');
    expect(emptyExpensesText('2027-01')).toBe('No expenses in January.');
  });
});

describe('countText', () => {
  it('uses the noun of the view, in the right number', () => {
    expect(countText('items', 5)).toBe('5 items');
    expect(countText('items', 1)).toBe('1 item');
    expect(countText('charges', 12)).toBe('12 charges');
    expect(countText('charges', 1)).toBe('1 charge');
    expect(countText('charges', 0)).toBe('0 charges');
  });
});

describe('expensesFooter', () => {
  it('reads "N items · total this month ₪X" with the month’s total to the agora', () => {
    expect(expensesFooter('items', 5, 1032.8)).toEqual({
      label: '5 items · total this month',
      amount: '₪1,032.80',
      text: '5 items · total this month ₪1,032.80',
    });
  });

  it('counts charges in the other view', () => {
    expect(expensesFooter('charges', 12, 960.4).text).toBe('12 charges · total this month ₪960.40');
  });

  it('shows agorot always, so the rows above it add up to it', () => {
    expect(expensesFooter('items', 2, 4239.6).amount).toBe('₪4,239.60');
    expect(expensesFooter('items', 2, 81.4).amount).toBe('₪81.40');
    expect(expensesFooter('items', 1, 970).amount).toBe('₪970.00');
    expect(expensesFooter('items', 1, 0).amount).toBe('₪0.00');
  });

  it('is not thrown off by float noise in a sum of agorot', () => {
    expect(expensesFooter('items', 5, 899.9 + 69.9 + 7.5 + 37 + 18.5).amount).toBe('₪1,032.80');
  });
});

describe('expensesRangeText', () => {
  it('says which rows are showing and of how many', () => {
    expect(expensesRangeText('charges', 0, 10, 12)).toBe('Showing 1–10 of 12 charges');
    expect(expensesRangeText('charges', 1, 10, 12)).toBe('Showing 11–12 of 12 charges');
    expect(expensesRangeText('items', 0, 10, 5)).toBe('Showing 1–5 of 5 items');
  });

  it('says one row in the singular', () => {
    expect(expensesRangeText('items', 0, 10, 1)).toBe('Showing 1–1 of 1 item');
  });

  it('says 0–0 with nothing to show', () => {
    expect(expensesRangeText('charges', 0, 10, 0)).toBe('Showing 0–0 of 0 charges');
  });
});

describe('pageSlice', () => {
  const rows = Array.from({ length: 12 }, (_, i) => i + 1);

  it('takes ten rows a page', () => {
    const first = pageSlice(rows, 0, 10);
    expect(first.rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(first).toMatchObject({ pageIndex: 0, pageCount: 2, total: 12 });
    const second = pageSlice(rows, 1, 10);
    expect(second.rows).toEqual([11, 12]);
    expect(second).toMatchObject({ pageIndex: 1, pageCount: 2, total: 12 });
  });

  it('clamps a page past the last to the last', () => {
    expect(pageSlice(rows, 5, 10)).toMatchObject({ rows: [11, 12], pageIndex: 1 });
  });

  it('clamps a negative or nonsense page to the first', () => {
    expect(pageSlice(rows, -3, 10).pageIndex).toBe(0);
    expect(pageSlice(rows, Number.NaN, 10).pageIndex).toBe(0);
    expect(pageSlice(rows, Number.POSITIVE_INFINITY, 10).pageIndex).toBe(0);
    expect(pageSlice(rows, 0.9, 10).pageIndex).toBe(0);
  });

  it('is one empty page with no rows', () => {
    expect(pageSlice([], 0, 10)).toEqual({ rows: [], pageIndex: 0, pageCount: 1, total: 0 });
    expect(pageSlice([], 3, 10).pageIndex).toBe(0);
  });

  it('fills exactly ten rows with exactly one page', () => {
    expect(pageSlice(rows.slice(0, 10), 0, 10)).toMatchObject({ pageCount: 1, total: 10 });
    expect(pageSlice(rows.slice(0, 10), 1, 10)).toMatchObject({ pageIndex: 0 });
  });

  it('does not change the rows it was given', () => {
    const before = rows.slice();
    pageSlice(rows, 1, 10);
    expect(rows).toEqual(before);
  });
});

describe('openItemId', () => {
  it('is the id of the open item', () => {
    expect(openItemId({ kind: 'item', id: 'claude' })).toBe('claude');
  });

  it('is null with no open row, or with a ledger job open', () => {
    expect(openItemId(null)).toBeNull();
    expect(openItemId({ kind: 'job', id: 'claude' })).toBeNull();
  });
});

describe('chargeDate', () => {
  it('writes the month in three letters and the day without a zero', () => {
    expect(chargeDate('2026-10-12')).toBe('Oct 12');
    expect(chargeDate('2026-10-03')).toBe('Oct 3');
    expect(chargeDate('2027-01-31')).toBe('Jan 31');
    expect(chargeDate('2026-12-01')).toBe('Dec 1');
  });

  it('gives back anything that is not a day as it came', () => {
    expect(chargeDate('soon')).toBe('soon');
    expect(chargeDate('2026-13-01')).toBe('2026-13-01');
  });
});

describe('chargeJobName', () => {
  it('is the job’s folder name, the part after the slash', () => {
    expect(chargeJobName('Lumen Yoga/Retreat teaser')).toBe('Retreat teaser');
    expect(chargeJobName('מאפיית הצפון/חלות לשבת')).toBe('חלות לשבת');
  });

  it('keeps everything after the first slash, and a path with none as it is', () => {
    expect(chargeJobName('Client/Job/Part')).toBe('Job/Part');
    expect(chargeJobName('Lonely')).toBe('Lonely');
  });
});

describe('chargesByDate', () => {
  it('puts the earliest day first', () => {
    const sorted = chargesByDate([
      charge('2026-10-14'),
      charge('2026-10-03'),
      charge('2026-10-08'),
    ]);
    expect(sorted.map((c) => c.date)).toEqual(['2026-10-03', '2026-10-08', '2026-10-14']);
  });

  it('keeps charges of one day in the order they came', () => {
    const sorted = chargesByDate([
      charge('2026-10-05', 'Fonts', 'Monthly plan'),
      charge('2026-10-02', 'Stock footage', 'Clip licence #2'),
      charge('2026-10-05', 'Stock footage', 'Clip licence #1'),
    ]);
    expect(sorted.map((c) => c.what)).toEqual([
      'Clip licence #2',
      'Monthly plan',
      'Clip licence #1',
    ]);
  });

  it('does not change the list it was given', () => {
    const list = [charge('2026-10-14'), charge('2026-10-03')];
    chargesByDate(list);
    expect(list.map((c) => c.date)).toEqual(['2026-10-14', '2026-10-03']);
  });
});
