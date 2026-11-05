// The Settings page's feature switches, from `GET /api/settings` (admin only, so it is asked only
// while the viewer is the admin). The save and the restart in settings-mutations.ts keep it current.

import type { SettingsResponse } from '@studio/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { type Api, ApiError, api } from './api';
import { useIsAdmin } from './hooks';

/** The TanStack Query key of the settings. */
export const SETTINGS_KEY = ['settings'] as const;

/** Only the admin changes them, through the mutations: half a minute is fresh. */
export const SETTINGS_STALE_MS = 30_000;

/** A 4xx (an editor, an engine too old to have the route) will not change by asking again. */
function retryUnless4xx(_count: number, error: ApiError): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/** Options of the `['settings']` query. `enabled` is whether the viewer is the admin. */
export function settingsQueryOptions(client: Api, enabled = true) {
  return queryOptions<SettingsResponse, ApiError>({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => client.getSettings(signal),
    staleTime: SETTINGS_STALE_MS,
    retry: retryUnless4xx,
    enabled,
  });
}

/** The settings, for the admin. `data` is `undefined` until the answer is in. */
export function useSettings() {
  const admin = useIsAdmin();
  return useQuery(settingsQueryOptions(api, admin));
}
