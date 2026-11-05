// Show in Finder for a job (`POST /api/jobs/:id/reveal`): the export MP4 when there is one, else
// the job folder. Finder coming to the front is the sign that it worked, so success says nothing;
// a refusal (the folder is gone: 404) or an engine that cannot be reached is a toast carrying the
// server's words, like the client's Show in Finder (features/clients/reveal-client.ts).

import type { RevealJobResponse } from '@studio/shared';
import { mutationOptions } from '@tanstack/react-query';
import { type Api, ApiError } from './api';

/** First element of the mutation's key. */
export const REVEAL_JOB_MUTATION_KEY = 'reveal-job';

/** The toast of a failed reveal: one id, so a second try replaces the note instead of stacking. */
export const REVEAL_JOB_TOAST_ID = 'reveal-job';

type NotifyError = (message: string, options: { id: string; description?: string }) => unknown;

export interface RevealJobMutationParams {
  api: Api;
  /** `toast.error` of sonner, or a stand-in in tests. */
  notify: { error: NotifyError };
}

/**
 * The mutation: the variable is the job id, the result says what Finder was asked for. A failure
 * is said in a toast (the `ApiError`'s message is the server's) and also rejects `mutateAsync`.
 */
export function revealJobMutationOptions({ api, notify }: RevealJobMutationParams) {
  return mutationOptions<RevealJobResponse, ApiError, string>({
    mutationKey: [REVEAL_JOB_MUTATION_KEY],
    mutationFn: (jobId) => api.revealJob(jobId),
    onError(error) {
      notify.error("Couldn't show it in Finder", {
        id: REVEAL_JOB_TOAST_ID,
        description: error instanceof ApiError ? error.message : undefined,
      });
    },
  });
}
