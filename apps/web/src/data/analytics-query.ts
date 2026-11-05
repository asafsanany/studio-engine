// The Analytics page's query (`['analytics', period]`): everything the page shows for one period,
// from `GET /api/analytics?period=week|month`. The server says over SSE when the numbers may have
// changed (a job moved, a delivery was marked, review time was added; see job-events.ts), which
// only says "this changed": the numbers are then loaded again, once the events have died down.
// Not polled.

import type { AnalyticsPeriod, AnalyticsResponse } from '@studio/shared';
import { keepPreviousData, type QueryClient, queryOptions } from '@tanstack/react-query';
import type { Api, ApiError } from './api';

/** The key every period's answer is cached under: `['analytics', period]`. */
export const ANALYTICS_KEY = ['analytics'] as const;

/** The key of one period's answer. */
export function analyticsKey(period: AnalyticsPeriod) {
  return [...ANALYTICS_KEY, period] as const;
}

/**
 * How long the numbers wait for a quiet moment before they are loaded again. A running edit sends
 * an update every few seconds, and the page is worked out from all the jobs, so a burst of events
 * asks once, after the burst.
 */
export const ANALYTICS_RELOAD_DELAY_MS = 2_000;

/** The longest a stream of changes can keep the numbers waiting: a long edit still shows up. */
export const ANALYTICS_RELOAD_MAX_WAIT_MS = 10_000;

/**
 * Options of the `['analytics', period]` query: fresh until the server says otherwise. While the
 * other period loads, the page that was on screen stays (`placeholderData`), so switching Week and
 * Month does not empty the page for a moment; `data.period` says which period the numbers are for.
 */
export function analyticsQueryOptions(api: Api, period: AnalyticsPeriod) {
  return queryOptions<AnalyticsResponse, ApiError>({
    queryKey: analyticsKey(period),
    queryFn: ({ signal }) => api.getAnalytics(period, signal),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

/** The reload each client is waiting to do, and when its wait began: a client has at most one. */
const waiting = new WeakMap<QueryClient, { timer: ReturnType<typeof setTimeout>; since: number }>();

/**
 * The numbers may have changed on the server: loads them again once `delayMs` pass with no further
 * change (each change starts the wait again), and at the latest `maxWaitMs` after the first one of
 * a stream. If the page is open it shows the new numbers for its period; the other period (and the
 * page if it is not open) is marked stale and loaded when it is next shown. Does nothing while no
 * answer was ever loaded (the page was never opened, or the switch is off): there is nothing to
 * refresh, and no timer is left behind.
 */
export function reloadAnalytics(
  queryClient: QueryClient,
  delayMs: number = ANALYTICS_RELOAD_DELAY_MS,
  maxWaitMs: number = ANALYTICS_RELOAD_MAX_WAIT_MS,
): void {
  if (queryClient.getQueryCache().findAll({ queryKey: ANALYTICS_KEY }).length === 0) return;
  const now = Date.now();
  const pending = waiting.get(queryClient);
  if (pending !== undefined) clearTimeout(pending.timer);
  const since = pending?.since ?? now;
  const wait = Math.max(0, Math.min(delayMs, since + maxWaitMs - now));
  waiting.set(queryClient, {
    since,
    timer: setTimeout(() => {
      waiting.delete(queryClient);
      void queryClient.invalidateQueries({ queryKey: ANALYTICS_KEY });
    }, wait),
  });
}

/** Drops a reload that is waiting (the client is going away, or a test is done). */
export function cancelAnalyticsReload(queryClient: QueryClient): void {
  const pending = waiting.get(queryClient);
  if (pending !== undefined) clearTimeout(pending.timer);
  waiting.delete(queryClient);
}
