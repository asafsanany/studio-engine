// Saving a job's note (`PUT /api/jobs/:id/note`).
//
// No optimistic update: the server decides (it trims the text, clears it when it is empty, and
// refuses it with a 409 once the job is editing or ready), so the cache takes the job it answers
// with. Then the list is reloaded, which also repairs a cache that was behind when the answer was
// a refusal.

import type { Job } from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { Api, ApiError } from './api';
import { JOBS_KEY, upsertJob } from './jobs-cache';

/** First element of the mutation's key. */
export const SAVE_NOTE_MUTATION_KEY = 'save-note';

/** What is saved: the whole note for a job (an empty text clears it). */
export interface SaveNoteVariables {
  id: string;
  note: string;
}

export interface SaveNoteMutationParams {
  queryClient: QueryClient;
  api: Api;
}

/** The mutation: variables are `{ id, note }`, the result is the job with its new note. */
export function saveNoteMutationOptions({ queryClient, api }: SaveNoteMutationParams) {
  return mutationOptions<Job, ApiError, SaveNoteVariables>({
    mutationKey: [SAVE_NOTE_MUTATION_KEY],
    mutationFn: ({ id, note }) => api.saveNote(id, note),

    onSuccess(job) {
      queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => list && upsertJob(list, job));
    },

    onSettled() {
      // Not awaited: the dialog can carry on as soon as the answer is in.
      void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    },
  });
}
