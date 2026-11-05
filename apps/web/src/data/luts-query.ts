// The LUTs queries (LUTs plan, "Web"): whether LUTs are on, the list, and one LUT with its pane's
// facts. While the LUTs switch is off (`/api/health` says `luts: false`, and until its answer is in)
// nothing is asked: every LUTs route would only answer 404 "LUTs are off.". The caches and their
// events are luts-cache.ts; the actions lut-mutations.ts.
//
//   ['luts']                every LUTs query (hello invalidates them all): LUTS_KEY
//   ['luts', 'list']        Yours and Built in (GET /api/luts): LUT_LIST_KEY
//   ['luts', 'one', slug]   one LUT (GET /api/luts/:slug): lutKey(slug)
//
// Both are fresh forever: `lut.changed` and `lut.removed` patch them as they come.

import type { LutDetail, LutListResponse } from '@studio/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { healthQueryOptions, lutsEnabled, lutsInEditsEnabled } from './health-query';
import { type LutsApi, lutsApi } from './luts-api';

/** Every LUTs query starts with this. */
export const LUTS_KEY = ['luts'] as const;

/** The list: ['luts', 'list']. */
export const LUT_LIST_KEY = ['luts', 'list'] as const;

/** One LUT: ['luts', 'one', slug]. */
export function lutKey(slug: string): readonly ['luts', 'one', string] {
  return ['luts', 'one', slug] as const;
}

/** A 4xx (an unknown or deleted LUT, LUTs off) will not change by asking again. */
function retryUnless4xx(_count: number, error: ApiError): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/** Options of the list query. `enabled` is whether LUTs are on. */
export function lutsQueryOptions(client: LutsApi, enabled = true) {
  return queryOptions<LutListResponse, ApiError>({
    queryKey: LUT_LIST_KEY,
    queryFn: ({ signal }) => client.listLuts(signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/** Options of one LUT's query; one that is gone answers 404 and is not asked again. */
export function lutQueryOptions(client: LutsApi, slug: string, enabled = true) {
  return queryOptions<LutDetail, ApiError>({
    queryKey: lutKey(slug),
    queryFn: ({ signal }) => client.getLut(slug, signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/**
 * Whether LUTs are on (`/api/health`): false until the answer is in, so nothing of LUTs shows on a
 * page that has not heard yet: no sidebar item, and /luts is Not found.
 */
export function useLutsEnabled(): boolean {
  return lutsEnabled(useQuery(healthQueryOptions(api)).data);
}

/**
 * Whether notes can name a LUT (`/api/health`: both LUTs switches are on): false until the answer
 * is in, so the @ picker and "Used in" do not show on a page that has not heard yet.
 */
export function useLutsInEditsEnabled(): boolean {
  return lutsInEditsEnabled(useQuery(healthQueryOptions(api)).data);
}

/**
 * Yours and Built in. `data` is `undefined` until the first answer, and stays so while LUTs are off
 * (nothing is asked).
 */
export function useLuts() {
  const enabled = useLutsEnabled();
  return useQuery(lutsQueryOptions(lutsApi, enabled));
}

/**
 * One LUT with its pane's facts. `data` is `undefined` until the first answer, and stays so while
 * LUTs are off. Kept current by the LUT events.
 */
export function useLut(slug: string | undefined) {
  const enabled = useLutsEnabled() && slug !== undefined;
  return useQuery(lutQueryOptions(lutsApi, slug ?? '', enabled));
}
