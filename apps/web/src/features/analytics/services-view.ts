import type { AnalyticsPeriod, AnalyticsServiceRow, AnalyticsServices } from '@studio/shared';
import { homeCurrencySymbol } from '@studio/shared';
import { formatIls, formatIlsAgorot } from '../money/format';

// What the Services card says for each row (CLAUDE.md › APIs and services): plain words, worked out
// here so the card only lays them out. A paid service is a row with its plan and what it cost in
// the period; a free one says Free and nothing else.

/** The period's name as the card's subtitle says it. */
export function servicesPeriodText(period: AnalyticsPeriod): string {
  return period === 'week' ? 'Last 7 days' : 'Last 30 days';
}

/** What a row cost in the period: whole shekels, agorot under ₪10; "Free" for a free one. */
export function costText(row: Pick<AnalyticsServiceRow, 'cost' | 'ils'>): string {
  if (row.cost === 'free') return 'Free';
  const ils = row.ils ?? 0;
  if (ils === 0) return `${homeCurrencySymbol()}0`;
  return ils < 10 ? formatIlsAgorot(ils) : formatIls(ils);
}

/** The plan column: its plans, one line each, or what is missing. */
export function planLines(row: AnalyticsServiceRow): { text: string; missing: boolean }[] {
  if (row.cost === 'free') return [{ text: 'No plan needed', missing: false }];
  if (row.planMissing) return [{ text: 'No plan in money.json yet', missing: true }];
  if (row.plans.length === 0) return [{ text: 'Pay per use', missing: false }];
  return row.plans.map((plan) => ({ text: `${plan.name} · ${plan.price}`, missing: false }));
}

/** The line under the table: what was paid in the period across everything. */
export function servicesTotalText(services: Pick<AnalyticsServices, 'totalIls'>): string {
  return `Paid in the period: ${formatIls(services.totalIls)}`;
}
