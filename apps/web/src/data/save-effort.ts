// Setting a job's effort level (`PUT /api/jobs/:id/effort`).
//
// No optimistic update, like the note: the server decides (it refuses with a 409 once the job is
// editing, in review or ready), so the cache takes the job it answers with. Then the list is
// reloaded, which also repairs a cache that was behind when the answer was a refusal.

import type { Effort, Job } from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { Api, ApiError } from './api';
import { JOBS_KEY, upsertJob } from './jobs-cache';

/** First element of the mutation's key. */
export const SAVE_EFFORT_MUTATION_KEY = 'save-effort';

/** What is saved: the level for a job, or `null` for Default (Extra high). */
export interface SaveEffortVariables {
  id: string;
  effort: Effort | null;
}

export interface SaveEffortMutationParams {
  queryClient: QueryClient;
  api: Api;
}

/** The mutation: variables are `{ id, effort }`, the result is the job with its new effort. */
export function saveEffortMutationOptions({ queryClient, api }: SaveEffortMutationParams) {
  return mutationOptions<Job, ApiError, SaveEffortVariables>({
    mutationKey: [SAVE_EFFORT_MUTATION_KEY],
    mutationFn: ({ id, effort }) => api.saveEffort(id, effort),

    onSuccess(job) {
      queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => list && upsertJob(list, job));
    },

    onSettled() {
      void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    },
  });
}
