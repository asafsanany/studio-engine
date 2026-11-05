// The Analytics page's period in the address: `/analytics?period=week` for the last 7 days by day,
// `/analytics` (or `?period=month`) for the last 30 days by week. The address is the truth about
// which period is shown, so a reload keeps it and a link can point at either.
//
// - Month is the default, so choosing it takes the parameter out of the address.
// - Choosing a period replaces the history entry: it is a view of the same page, not a place to go
//   back to, so Back leaves the page and does not step through the switches.
// - Nothing scrolls: the page stays where it is while the other period's numbers arrive.
// - The last choice is remembered in this browser (localStorage), so the page opens on it from the
//   sidebar or any link without a period. An address that names a period wins, and is remembered.

import { type AnalyticsPeriod, DEFAULT_ANALYTICS_PERIOD, isAnalyticsPeriod } from '@studio/shared';
import type { AnyRouter } from '@tanstack/react-router';
import type { StateStorage } from 'zustand/middleware';
import { browserStorage, guardStorage } from '@/stores/jobs-ui';

/** localStorage key of the remembered period. Bump the `v1` suffix with its shape. */
export const ANALYTICS_PERIOD_STORAGE_KEY = 'studio.analytics.period.v1';

/** The optional `period` search parameter of the Analytics page. */
export interface AnalyticsSearch {
  period?: AnalyticsPeriod;
}

/**
 * `validateSearch` of the page: keeps `period` when it is `week` or `month` and drops it otherwise
 * (another word, a number, a list, nothing), which is the month.
 */
export function validateAnalyticsSearch(search: Record<string, unknown>): AnalyticsSearch {
  const { period } = search;
  return isAnalyticsPeriod(period) ? { period } : {};
}

/** The period a page's search asks for: `month` unless it says `week`. Reads any search, valid or not. */
export function periodOfSearch(search: unknown): AnalyticsPeriod {
  if (typeof search !== 'object' || search === null) return DEFAULT_ANALYTICS_PERIOD;
  const { period } = search as { period?: unknown };
  return isAnalyticsPeriod(period) ? period : DEFAULT_ANALYTICS_PERIOD;
}

/**
 * A change of the current page's search with `period` set, or taken out for the month (the
 * default); every other parameter stays. The router types `search` from the route in `to`, and
 * with no `to` (the page we are on) it can't know the route, so the function is handed over
 * untyped.
 */
function setPeriod(period: AnalyticsPeriod): never {
  const change = (search: Record<string, unknown>): Record<string, unknown> => {
    const { period: _was, ...rest } = search;
    return period === DEFAULT_ANALYTICS_PERIOD ? rest : { ...rest, period };
  };
  return change as never;
}

/** The period last chosen in this browser: `week` only when that is what was stored. */
export function rememberedPeriod(storage: StateStorage = browserStorage()): AnalyticsPeriod {
  const stored = guardStorage(storage).getItem(ANALYTICS_PERIOD_STORAGE_KEY);
  return stored === 'week' ? 'week' : DEFAULT_ANALYTICS_PERIOD;
}

/** Remembers `period` in this browser. Best effort: blocked storage only loses the memory. */
export function rememberPeriod(
  period: AnalyticsPeriod,
  storage: StateStorage = browserStorage(),
): void {
  guardStorage(storage).setItem(ANALYTICS_PERIOD_STORAGE_KEY, period);
}

/**
 * On the way into the page: an address that names a period is remembered and shown as it is
 * (`null`). One that names none (the sidebar, a reload of the plain /analytics) is shown in the
 * remembered period, so `week` asks the route to put `?period=week` in the address.
 */
export function periodToRestore(
  search: AnalyticsSearch,
  storage: StateStorage = browserStorage(),
): AnalyticsPeriod | null {
  if (search.period !== undefined) {
    rememberPeriod(search.period, storage);
    return null;
  }
  const remembered = rememberedPeriod(storage);
  return remembered === DEFAULT_ANALYTICS_PERIOD ? null : remembered;
}

/**
 * Shows `period` on the page and remembers it: the address changes in place and the page keeps its
 * scroll.
 */
export function selectPeriod(
  router: AnyRouter,
  period: AnalyticsPeriod,
  storage: StateStorage = browserStorage(),
): Promise<void> {
  rememberPeriod(period, storage);
  return router.navigate({ search: setPeriod(period), replace: true, resetScroll: false });
}
