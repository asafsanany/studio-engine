// The series queries and actions (Series plan §5 and §6): whether series are on, a client's series,
// one series with its series.md, and the hooks of the actions (series-mutations.ts). While the
// Series switch is off (`/api/health` says `series: false`, and until its answer is in) nothing is
// asked: the series routes would only answer 404 "Series are off.", and the page shows nothing of
// series. The caches and their events are series-cache.ts.

import type { HealthResponse, SeriesResponse, SeriesSummary } from '@studio/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { healthQueryOptions } from './health-query';
import { type SeriesApi, seriesApi } from './series-api';
import { clientSeriesKey, seriesKey } from './series-cache';
import {
  retrySeriesMutationOptions,
  seriesFormatMutationOptions,
  setJobSeriesMutationOptions,
  startSeriesMutationOptions,
  undoSeriesMutationOptions,
} from './series-mutations';

/** A 4xx (an unknown series, series off) will not change by asking again, so it is not retried. */
function retryUnless4xx(_count: number, error: ApiError): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/** Whether series are on, from the server's health answer: false until it is in. */
export function seriesEnabled(health: HealthResponse | undefined): boolean {
  return health?.series ?? false;
}

/**
 * Options of the `['series', 'client', clientId]` query: the client's series, by name. Fresh
 * forever (SSE says when it changes). `enabled` is whether series are on.
 */
export function clientSeriesQueryOptions(api: SeriesApi, clientId: string, enabled = true) {
  return queryOptions<SeriesSummary[], ApiError>({
    queryKey: clientSeriesKey(clientId),
    queryFn: async ({ signal }) => (await api.listClientSeries(clientId, signal)).series,
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/**
 * Options of the `['series', 'one', seriesId]` query: the series and its series.md. Fresh forever
 * (SSE says when it changes); a series that is gone answers 404 and is not asked again.
 */
export function seriesQueryOptions(api: SeriesApi, seriesId: string, enabled = true) {
  return queryOptions<SeriesResponse, ApiError>({
    queryKey: seriesKey(seriesId),
    queryFn: ({ signal }) => api.getSeries(seriesId, signal),
    staleTime: Infinity,
    retry: retryUnless4xx,
    enabled,
  });
}

/**
 * Whether series are on (`/api/health`): false until the answer is in, so nothing of series shows
 * on a page that has not heard yet. Every series menu item, column and page asks this first.
 */
export function useSeriesEnabled(): boolean {
  return seriesEnabled(useQuery(healthQueryOptions(api)).data);
}

/**
 * The client's series (`['series', 'client', clientId]`), by name, with their episode counts.
 * `data` is `undefined` until the first answer, and stays so while series are off (nothing is
 * asked). Kept current by the series and job events.
 */
export function useClientSeries(clientId: string) {
  const enabled = useSeriesEnabled();
  return useQuery(clientSeriesQueryOptions(seriesApi, clientId, enabled));
}

/**
 * One series and its series.md (`['series', 'one', seriesId]`). `data` is `undefined` until the
 * first answer, and stays so while series are off. Kept current by the `series.*` events.
 */
export function useSeries(seriesId: string) {
  const enabled = useSeriesEnabled();
  return useQuery(seriesQueryOptions(seriesApi, seriesId, enabled));
}

/**
 * Start a series: `const start = useStartSeries(); await start.mutateAsync({ jobId, name })`
 * resolves with the series, now learning. A refusal is an `ApiError` with the server's reason (409,
 * or 422 for the name: the dialog shows that one under the input).
 */
export function useStartSeries() {
  const queryClient = useQueryClient();
  return useMutation(startSeriesMutationOptions({ queryClient, api: seriesApi }));
}

/** Use as the series format: `mutateAsync({ seriesId, jobId })`, resolving with the series. */
export function useSetSeriesFormat() {
  const queryClient = useQueryClient();
  return useMutation(seriesFormatMutationOptions({ queryClient, api: seriesApi }));
}

/** The Series submenu: `mutateAsync({ jobId, seriesId })` (`null`: "Not in a series"), resolving with the job. */
export function useSetJobSeries() {
  const queryClient = useQueryClient();
  return useMutation(setJobSeriesMutationOptions({ queryClient, api: seriesApi }));
}

/** The toast's Undo of Start a series: `mutateAsync({ seriesId, clientId })`. */
export function useUndoSeries() {
  const queryClient = useQueryClient();
  return useMutation(undoSeriesMutationOptions({ queryClient, api: seriesApi }));
}

/** Retry of a failed series: `mutateAsync(seriesId)`, resolving with the series, learning again. */
export function useRetrySeries() {
  const queryClient = useQueryClient();
  return useMutation(retrySeriesMutationOptions({ queryClient, api: seriesApi }));
}
