// The Instagram DMs page's data: the list (asked again every 30 s while the page is open, since the
// engine reads the DMs every minute), Check now and Show in Finder.
//
//   ['dms']   GET /api/dms: DMS_KEY

import type { DmsResponse } from '@studio/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiError } from './api';
import { type DmsApi, dmsApi } from './dms-api';

export const DMS_KEY = ['dms'] as const;

/** How often the open page asks for the list again. */
export const DMS_REFRESH_MS = 30_000;

export function dmsQueryOptions(client: DmsApi = dmsApi) {
  return queryOptions<DmsResponse, ApiError>({
    queryKey: DMS_KEY,
    queryFn: ({ signal }) => client.listDms(signal),
    refetchInterval: DMS_REFRESH_MS,
  });
}

/** The connection and the items; `data` is `undefined` until the first answer. */
export function useDms() {
  return useQuery(dmsQueryOptions());
}

/** Check now: the DMs read right away; the list takes what it answers. */
export function useCheckDms(client: DmsApi = dmsApi) {
  const queryClient = useQueryClient();
  return useMutation<DmsResponse, ApiError>({
    mutationKey: ['check-dms'],
    mutationFn: () => client.checkDms(),
    onSuccess: (answer) => queryClient.setQueryData(DMS_KEY, answer),
  });
}

/** Show in Finder for an item's file. */
export function useRevealDm(client: DmsApi = dmsApi) {
  return useMutation<void, ApiError, string>({
    mutationKey: ['reveal-dm'],
    mutationFn: (id) => client.revealDm(id),
  });
}
