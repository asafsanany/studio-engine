import type { AnalyticsServiceRow } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { costText, planLines, servicesPeriodText, servicesTotalText } from './services-view';

function row(overrides: Partial<AnalyticsServiceRow> = {}): AnalyticsServiceRow {
  return {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    forWhat: 'Music',
    cost: 'paid',
    plans: [{ name: 'ElevenLabs (Starter)', price: '$6.00 a month' }],
    planMissing: false,
    ils: 22.2,
    uses: null,
    gap: null,
    ...overrides,
  };
}

describe('servicesPeriodText', () => {
  it('names the window of the period', () => {
    expect(servicesPeriodText('month')).toBe('Last 30 days');
    expect(servicesPeriodText('week')).toBe('Last 7 days');
  });
});

describe('costText', () => {
  it('is Free for a free service, whole shekels from ₪10, agorot below', () => {
    expect(costText(row({ cost: 'free', ils: null }))).toBe('Free');
    expect(costText(row({ ils: 899.9 }))).toBe('₪900');
    expect(costText(row({ ils: 5.55 }))).toBe('₪5.55');
    expect(costText(row({ ils: 0 }))).toBe('₪0');
  });
});

describe('planLines', () => {
  it('says each plan with its price', () => {
    expect(planLines(row())).toEqual([
      { text: 'ElevenLabs (Starter) · $6.00 a month', missing: false },
    ]);
  });

  it('says a plan is missing from money.json, so it can be added', () => {
    expect(planLines(row({ plans: [], planMissing: true }))).toEqual([
      { text: 'No plan in money.json yet', missing: true },
    ]);
  });

  it('says pay per use for a paid service without a plan, and no plan needed for a free one', () => {
    expect(planLines(row({ plans: [] }))).toEqual([{ text: 'Pay per use', missing: false }]);
    expect(planLines(row({ cost: 'free', plans: [], ils: null }))).toEqual([
      { text: 'No plan needed', missing: false },
    ]);
  });
});

describe('servicesTotalText', () => {
  it('says what was paid in the period', () => {
    expect(servicesTotalText({ totalIls: 1003.5 })).toBe('Paid in the period: ₪1,004');
  });
});
