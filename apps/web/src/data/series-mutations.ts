// The series actions (Series plan §5): Start a series, Use as the series format, putting a job in a
// series (or taking it out), the Undo of Start a series and Retry.
//
// No optimistic update: the server decides (409 and 422 with its reasons), so the caches take what
// it answers. A series an action answers is written over the cached one (`applySeries`, which
// keeps its markdown) and both its queries load again; the `series.changed` events then keep it
// right until its pass ends. A job put in a series goes into the jobs cache as the server answered.

import type { Job, Series } from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { ApiError } from './api';
import { JOBS_KEY, upsertJob } from './jobs-cache';
import type { SeriesApi } from './series-api';
import { applySeries, dropSeries, reloadClientSeries } from './series-cache';

/** First element of each series mutation's key. */
export const SERIES_MUTATION_KEYS = {
  start: 'start-series',
  format: 'series-format',
  setJob: 'set-job-series',
  undo: 'undo-series',
  retry: 'retry-series',
} as const;

export interface SeriesMutationParams {
  queryClient: QueryClient;
  api: SeriesApi;
}

/** Start a series: the variables are the Ready job and the name; the result is the series, learning. */
export function startSeriesMutationOptions({ queryClient, api }: SeriesMutationParams) {
  return mutationOptions<Series, ApiError, { jobId: string; name: string }>({
    mutationKey: [SERIES_MUTATION_KEYS.start],
    mutationFn: async ({ jobId, name }) => (await api.startSeries(jobId, name)).series,
    onSuccess: (series) => applySeries(queryClient, series),
  });
}

/** Use as the series format: the variables are the series and its Ready episode. */
export function seriesFormatMutationOptions({ queryClient, api }: SeriesMutationParams) {
  return mutationOptions<Series, ApiError, { seriesId: string; jobId: string }>({
    mutationKey: [SERIES_MUTATION_KEYS.format],
    mutationFn: async ({ seriesId, jobId }) => (await api.useAsFormat(seriesId, jobId)).series,
    onSuccess: (series) => applySeries(queryClient, series),
  });
}

/** The row menu's Series submenu: the variables are the job and its series, `null` for none. */
export function setJobSeriesMutationOptions({ queryClient, api }: SeriesMutationParams) {
  return mutationOptions<Job, ApiError, { jobId: string; seriesId: string | null }>({
    mutationKey: [SERIES_MUTATION_KEYS.setJob],
    mutationFn: ({ jobId, seriesId }) => api.setJobSeries(jobId, seriesId),
    onSuccess: (job) => {
      queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => list && upsertJob(list, job));
      void reloadClientSeries(queryClient, job.clientId);
    },
  });
}

/** The toast's Undo of Start a series: the variables say which series, and whose. */
export function undoSeriesMutationOptions({ queryClient, api }: SeriesMutationParams) {
  return mutationOptions<void, ApiError, { seriesId: string; clientId: string }>({
    mutationKey: [SERIES_MUTATION_KEYS.undo],
    mutationFn: ({ seriesId }) => api.undoSeries(seriesId),
    onSuccess: (_answer, { seriesId, clientId }) => dropSeries(queryClient, seriesId, clientId),
  });
}

/** Retry on the Format tab of a failed series: the variable is the series id. */
export function retrySeriesMutationOptions({ queryClient, api }: SeriesMutationParams) {
  return mutationOptions<Series, ApiError, string>({
    mutationKey: [SERIES_MUTATION_KEYS.retry],
    mutationFn: async (seriesId) => (await api.retrySeries(seriesId)).series,
    onSuccess: (series) => applySeries(queryClient, series),
  });
}
