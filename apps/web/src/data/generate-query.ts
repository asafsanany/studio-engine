// A generated job's Generate stage as the page holds it (Generated videos, GN0): the
// `['job-generate', jobId]` query (`GET /api/jobs/:id/generate`) and how the `job.generate` event
// keeps it current. The Jobs row reads it through the cached job, the job sheet through the job and
// the stage's History (`['job-generate', jobId, 'history']`, GN9).
//
// - Nothing is asked while the Generate switch is off (`/api/health`'s `generate`): `data` stays
//   `undefined`, and the page shows nothing of generating, exactly as before Generated videos.
// - The answer is the job's GenerateState, or `null` for a job that has no Generate stage. Ask only
//   about a job the list says is generated (its `generate` is set): `enabled` is for that.
// - `job.generate` carries the whole state, so it is written into the cache as it is (no request),
//   and into the cached job's `generate`, so the Jobs row follows without asking. A `hello`
//   invalidates every job's state (job-events.ts), since events may have been missed.

import type {
  GenerateHistoryEvent,
  GenerateNotePlan,
  GenerateState,
  Job,
  JobGenerateEvent,
} from '@studio/shared';
import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { type Api, ApiError, api } from './api';
import { generateEnabled, healthQueryOptions } from './health-query';
import { JOBS_KEY } from './jobs-cache';

/** Every generate query starts with this. Its own root on purpose: invalidating ['jobs'] matches by prefix. */
export const JOB_GENERATE_KEY = ['job-generate'] as const;

/** One job's Generate stage: ['job-generate', jobId]. */
export function jobGenerateKey(jobId: string): readonly ['job-generate', string] {
  return ['job-generate', jobId] as const;
}

/**
 * Options of the `['job-generate', jobId]` query: fresh until an event says otherwise
 * (`job.generate` writes it, a `hello` invalidates it). A 4xx will not change by asking again, so
 * it is not retried.
 */
export function jobGenerateQueryOptions(client: Api, jobId: string) {
  return queryOptions<GenerateState | null, ApiError>({
    queryKey: jobGenerateKey(jobId),
    queryFn: ({ signal }) => client.getJobGenerate(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

/**
 * Writes a job's Generate state into the cache, and into the cached job list when the job is in
 * it (a job there that has no other change keeps its object; the list is not reloaded).
 */
export function applyJobGenerate(
  queryClient: QueryClient,
  jobId: string,
  generate: GenerateState,
): void {
  queryClient.setQueryData<GenerateState | null>(jobGenerateKey(jobId), generate);
  // What the stage did moves with its state: a History that is open asks for the file again.
  void queryClient.invalidateQueries({ queryKey: generateHistoryKey(jobId) });
  queryClient.setQueryData<Job[]>(JOBS_KEY, (list) =>
    list?.map((job) => (job.id === jobId ? { ...job, generate } : job)),
  );
}

/** The `job.generate` event: the state it carries goes into the cache as it is. */
export function applyJobGenerateEvent(queryClient: QueryClient, event: JobGenerateEvent): void {
  applyJobGenerate(queryClient, event.jobId, event.generate);
}

/** Whether Generated videos are on (`/api/health`'s `generate`): false until the answer is in. */
export function useGenerateEnabled(): boolean {
  return generateEnabled(useQuery(healthQueryOptions(api)).data);
}

/**
 * A job's Generate stage (`['job-generate', jobId]`): `data` is the GenerateState, `null` for a job
 * that has none, and `undefined` until the first answer, while Generated videos are off (nothing is
 * asked) and while `enabled` is false. Kept current by the `job.generate` event.
 */
export function useJobGenerate(jobId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const on = useGenerateEnabled();
  return useQuery({ ...jobGenerateQueryOptions(api, jobId), enabled: on && enabled });
}

/** One job's Generate History: ['job-generate', jobId, 'history']. */
export function generateHistoryKey(jobId: string): readonly ['job-generate', string, 'history'] {
  return ['job-generate', jobId, 'history'] as const;
}

/**
 * Options of the `['job-generate', jobId, 'history']` query (GN9): what the Generate stage did,
 * oldest first (`[]` for a job with none). Fresh until an event says otherwise (`job.generate`
 * invalidates it); a 4xx will not change by asking again, so it is not retried.
 */
export function generateHistoryQueryOptions(client: Api, jobId: string) {
  return queryOptions<GenerateHistoryEvent[], ApiError>({
    queryKey: generateHistoryKey(jobId),
    queryFn: ({ signal }) => client.getGenerateHistory(jobId, signal),
    staleTime: Infinity,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

/**
 * A generated job's Generate History: `data` is the events, `[]` for a job with none, and
 * `undefined` until the first answer, while Generated videos are off (nothing is asked) and while
 * `enabled` is false. Ask only about a job that has a Generate stage.
 */
export function useJobGenerateHistory(
  jobId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const on = useGenerateEnabled();
  return useQuery({ ...generateHistoryQueryOptions(api, jobId), enabled: on && enabled });
}

/** One job's note-hint plan: ['job-generate', jobId, 'review-plan']. */
export function generateReviewPlanKey(
  jobId: string,
): readonly ['job-generate', string, 'review-plan'] {
  return ['job-generate', jobId, 'review-plan'] as const;
}

/**
 * Options of the `['job-generate', jobId, 'review-plan']` query (GN8): the clips and voice lines
 * the note hints in Review read. A revise round changes both files, so it is asked again whenever
 * Review opens (stale at once); `null` is a job with no hand-off yet.
 */
export function generateReviewPlanQueryOptions(client: Api, jobId: string) {
  return queryOptions<GenerateNotePlan | null, ApiError>({
    queryKey: generateReviewPlanKey(jobId),
    queryFn: ({ signal }) => client.getGenerateReviewPlan(jobId, signal),
    staleTime: 0,
    retry: (_count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
}

/**
 * The plan the note hints read for a generated job in Review: `data` is the plan, `null` for a job
 * with no hand-off, and `undefined` until the first answer, while Generated videos are off (nothing
 * is asked) and while `enabled` is false.
 */
export function useGenerateReviewPlan(
  jobId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const on = useGenerateEnabled();
  return useQuery({ ...generateReviewPlanQueryOptions(api, jobId), enabled: on && enabled });
}
