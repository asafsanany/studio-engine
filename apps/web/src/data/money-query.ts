// The Money page's query (`['money', month]`): everything the page shows for one month, from
// `GET /api/money?month=YYYY-MM`. The server says over SSE when the numbers may have changed (a
// job was delivered, money.json was edited, review time was added; see job-events.ts), which only
// says "this changed": every cached month is then loaded again (the ones on screen at once, the
// others when they are next shown). Not polled.

import type { MoneyPriceResponse, MoneyResponse } from '@studio/shared';
import { keepPreviousData, type QueryClient, queryOptions } from '@tanstack/react-query';
import type { Api, ApiError } from './api';

/** The key every month's answer is cached under: `['money', month]`. */
export const MONEY_KEY = ['money'] as const;

/** The key of one month's answer. */
export function moneyKey(month: string) {
  return [...MONEY_KEY, month] as const;
}

/**
 * Options of the `['money', month]` query: fresh until the server says otherwise. While another
 * month loads, the month that was on screen stays (`placeholderData`), so picking a month does not
 * empty the page for a moment; `data.month` says which month the numbers are for.
 */
export function moneyQueryOptions(api: Api, month: string) {
  return queryOptions<MoneyResponse, ApiError>({
    queryKey: moneyKey(month),
    queryFn: ({ signal }) => api.getMoney(month, signal),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

/**
 * The key of what Mark delivered would charge `client` now: `['money', 'price', client]`. It sits
 * under {@link MONEY_KEY}, so a `money.changed` (money.json was edited) loads it again too.
 */
export function moneyPriceKey(client: string) {
  return [...MONEY_KEY, 'price', client] as const;
}

/** Options of the `['money', 'price', client]` query: fresh until the server says otherwise. */
export function moneyPriceQueryOptions(api: Api, client: string) {
  return queryOptions<MoneyPriceResponse, ApiError>({
    queryKey: moneyPriceKey(client),
    queryFn: ({ signal }) => api.getMoneyPrice(client, signal),
    staleTime: Infinity,
  });
}

/**
 * The numbers may have changed on the server: loads every month that is on screen again (and marks
 * the rest stale). Does nothing while nobody shows the page. A fetch already in flight is replaced:
 * it may have read the server before the change.
 */
export function reloadMoney(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: MONEY_KEY });
}
