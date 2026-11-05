// The job sheet's stock query: the sound effects and photos one job's runs took from Openverse and
// Unsplash (`GET /api/jobs/:id/stock`, Stock media). Only an open sheet asks for them
// (`useJobStock(id, { enabled })`). The server pushes no event of its own for them: a run that took
// something changes the job (job-events.ts invalidates `jobStockKey(id)` on every `job.upsert`), and
// an item never changes after that, so an open sheet reads them again and a closed one just goes
// stale. The list is not polled.

import type { StockResponse } from '@studio/shared';
import { queryOptions } from '@tanstack/react-query';
import { type Api, ApiError } from './api';

/** Every job-stock query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const JOB_STOCK_KEY = ['job-stock'] as const;

/** One job's stock media: ['job-stock', jobId]. */
export function jobStockKey(jobId: string): readonly ['job-stock', string] {
  return ['job-stock', jobId] as const;
}

/**
 * Options of the `['job-stock', jobId]` query: what the job took, fresh until the job changes (the
 * events invalidate it). A 4xx (404 for a job that is gone) will not change by asking again, so it
 * is not retried.
 */
export function jobStockQueryOptions(api: Api, jobId: string) {
  return queryOptions<StockResponse, ApiError>({
    queryKey: jobStockKey(jobId),
    queryFn: ({ signal }) => api.getJobStock(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}
