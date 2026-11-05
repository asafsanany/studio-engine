// Setting the effort of a job's review rounds (`PUT /api/jobs/:id/review-effort`, Quick fixes).
//
// Instant: the Effort menu in Review shows the new choice the moment it is picked, because the menu
// reads it from the cached job. The choice is put on the cached job at once and put back if the
// server refuses (it answers 409 once the job has left Review), and a toast says why. When it
// accepts, the cache takes the job it answers with, and the list is reloaded either way, which also
// repairs a cache that was behind. (The edit's own effort, `save-effort.ts`, waits for the answer:
// it is rarely changed and the server often refuses it.)

import type { Effort, Job } from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { Api, ApiError } from './api';
import { JOBS_KEY, upsertJob } from './jobs-cache';

/** First element of the mutation's key; the second is the job. */
export const SET_REVIEW_EFFORT_MUTATION_KEY = 'set-review-effort';

/** The toast of a refused change; the server's reason goes under it. */
export const REVIEW_EFFORT_FAILED_TEXT = 'Could not change the effort';

export interface SetReviewEffortMutationParams {
  queryClient: QueryClient;
  api: Api;
  /** The job whose review rounds the level is for. */
  jobId: string;
  /** `toast.error` of sonner, or a stand-in in tests. */
  notify: (message: string, options: { description: string }) => void;
}

/** What `onMutate` remembers for `onError`: the level the job had, when the cache held the job. */
export interface SetReviewEffortContext {
  previous?: { reviewEffort: Effort | null };
}

/** The cached job gets this review effort, where it stands in the list (nothing else changes). */
function putReviewEffort(queryClient: QueryClient, jobId: string, reviewEffort: Effort | null) {
  queryClient.setQueryData<Job[]>(JOBS_KEY, (list) =>
    list?.map((job) => (job.id === jobId ? { ...job, reviewEffort } : job)),
  );
}

/**
 * The mutation: the variable is the level (`null` is Auto, the default), the result is the job
 * with its new `reviewEffort`. A refusal puts the old level back and says why through `notify`
 * (the server's own words), and also rejects `mutateAsync`.
 */
export function setReviewEffortMutationOptions({
  queryClient,
  api,
  jobId,
  notify,
}: SetReviewEffortMutationParams) {
  return mutationOptions<Job, ApiError, Effort | null, SetReviewEffortContext>({
    mutationKey: [SET_REVIEW_EFFORT_MUTATION_KEY, jobId],
    mutationFn: (effort) => api.saveReviewEffort(jobId, effort),

    async onMutate(effort) {
      // A reload that finishes after the change would put the old level back for a moment.
      await queryClient.cancelQueries({ queryKey: JOBS_KEY });
      const job = queryClient.getQueryData<Job[]>(JOBS_KEY)?.find((j) => j.id === jobId);
      if (job === undefined) return {};
      putReviewEffort(queryClient, jobId, effort);
      return { previous: { reviewEffort: job.reviewEffort } };
    },

    onError(error, _effort, context) {
      if (context?.previous !== undefined) {
        putReviewEffort(queryClient, jobId, context.previous.reviewEffort);
      }
      notify(REVIEW_EFFORT_FAILED_TEXT, { description: error.message });
    },

    onSuccess(job) {
      queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => list && upsertJob(list, job));
    },

    onSettled() {
      void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    },
  });
}
