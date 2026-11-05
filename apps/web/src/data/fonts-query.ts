// The Fonts queries (Fonts plan, "Web"): whether Fonts are on, the list, and one family with its
// pane's facts. While the Fonts switch is off (`/api/health` says `fonts: false`, and until its
// answer is in) nothing is asked: every Fonts route would only answer 404 "Fonts are off.". The
// caches and their events are fonts-cache.ts; the actions font-mutations.ts.
//
//   ['fonts']                every Fonts query (hello invalidates them all): FONTS_KEY
//   ['fonts', 'list']        the families, the catalog of faces and the open requests
//                            (GET /api/fonts): FONT_LIST_KEY
//   ['fonts', 'one', slug]   one family with its faces (GET /api/fonts/:slug): fontKey(slug)
//
// Both are fresh forever: `font.changed` and `font.removed` patch them as they come.

import type { FontFamilyDetail, FontsListResponse } from '@studio/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { type FontsApi, fontsApi } from './fonts-api';
import { fontsEnabled, fontsInNotesEnabled, healthQueryOptions } from './health-query';

/** Every Fonts query starts with this. */
export const FONTS_KEY = ['fonts'] as const;

/** The list: ['fonts', 'list']. */
export const FONT_LIST_KEY = ['fonts', 'list'] as const;

/** One family: ['fonts', 'one', slug]. */
export function fontKey(slug: string): readonly ['fonts', 'one', string] {
  return ['fonts', 'one', slug] as const;
}

/** A 4xx (an unknown or deleted family, Fonts off) will not change by asking again. */
function retryUnless4xx(_count: number, error: ApiError): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/** Options of the list query. `enabled` is whether Fonts are on. */
export function fontsQueryOptions(client: FontsApi, enabled = true) {
  return queryOptions<FontsListResponse, ApiError>({
    queryKey: FONT_LIST_KEY,
    queryFn: ({ signal }) => client.listFonts(signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/** Options of one family's query; one that is gone answers 404 and is not asked again. */
export function fontQueryOptions(client: FontsApi, slug: string, enabled = true) {
  return queryOptions<FontFamilyDetail, ApiError>({
    queryKey: fontKey(slug),
    queryFn: ({ signal }) => client.getFont(slug, signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/**
 * Whether Fonts are on (`/api/health`): false until the answer is in, so nothing of Fonts shows on
 * a page that has not heard yet: no sidebar item, and /fonts is Not found.
 */
export function useFontsEnabled(): boolean {
  return fontsEnabled(useQuery(healthQueryOptions(api)).data);
}

/**
 * Whether notes can name a font (`/api/health`: both Fonts switches are on): false until the
 * answer is in, so the @ picker's fonts, "Used in" and the live preview do not show on a page that
 * has not heard yet.
 */
export function useFontsInNotesEnabled(): boolean {
  return fontsInNotesEnabled(useQuery(healthQueryOptions(api)).data);
}

/**
 * The families, the catalog and the open requests. `data` is `undefined` until the first answer,
 * and stays so while Fonts are off (nothing is asked).
 */
export function useFonts() {
  const enabled = useFontsEnabled();
  return useQuery(fontsQueryOptions(fontsApi, enabled));
}

/**
 * One family with its faces. `data` is `undefined` until the first answer, and stays so while
 * Fonts are off. Kept current by the font events.
 */
export function useFont(slug: string | undefined) {
  const enabled = useFontsEnabled() && slug !== undefined;
  return useQuery(fontQueryOptions(fontsApi, slug ?? '', enabled));
}
