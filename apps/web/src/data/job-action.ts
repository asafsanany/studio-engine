// Job actions (start, hold, release, cancel, resume, retry, send_notes, approve) with an optimistic
// update.
//
// The button feels instant because the cached job is moved to its next state at once, using the
// same state machine the server uses. Then:
//   - success: the server's job replaces the optimistic one;
//   - error:   only this job is put back as it was (jobs that changed meanwhile keep their update);
//   - always:  the list is reloaded, so the cache ends up as the server has it.
//
// The instant Release picks arriving or queued with the server's settle delay (`/api/health`,
// health-query.ts), and with the 60 s default until that answer is in. A Release that restores the
// place in line (`restorePlace`, the note dialog's) also shows that place: the job takes the
// `settledAt` it had before it was held, and every queued job's `placeInLine` is worked out again
// from the queue order, as the server does (`withQueuePlaces`).
//
// If the machine refuses the action for the cached job (the page is behind the server, or the
// action is nonsense) nothing is changed optimistically and the request is still sent: the server
// is the judge, its 409 says in words why, and the reload after it repairs the stale cache.

import {
  eventForAction,
  InvalidTransition,
  type Job,
  type JobAction,
  type JobActionOptions,
  type ReviewNote,
  transition,
} from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { Api, ApiError } from './api';
import { cachedSettleMs } from './health-query';
import { findJob, JOBS_KEY, upsertJob, withQueuePlaces } from './jobs-cache';
import { notesKey } from './notes-cache';

/** First element of every action mutation's key; the second is the action. */
export const JOB_ACTION_MUTATION_KEY = 'job-action';

/** What `onMutate` remembers for `onError`. Empty when nothing was changed optimistically. */
export interface JobActionContext {
  /** The job as it was in the cache before the optimistic change. */
  previous?: Job;
  /** The job as the optimistic change left it. */
  optimistic?: Job;
}

export interface JobActionMutationParams extends JobActionOptions {
  queryClient: QueryClient;
  api: Api;
  action: JobAction;
  /** The clock for the optimistic `updatedAt`. Tests pass a fixed one. */
  now?: () => Date;
}

/** Whether an action on job `id` is on its way to the server right now. */
export function isJobActionPending(queryClient: QueryClient, id: string): boolean {
  return (
    queryClient.isMutating({
      mutationKey: [JOB_ACTION_MUTATION_KEY],
      predicate: (mutation) => mutation.state.variables === id,
    }) > 0
  );
}

/** Whether `a` is the same version of a job as `b`: what an optimistic change sets and a reload replaces. */
function sameVersion(a: Job, b: Job): boolean {
  return a.state === b.state && a.updatedAt === b.updatedAt;
}

/** The mutation of one action; the variable is the job id. */
export function jobActionMutationOptions({
  queryClient,
  api,
  action,
  restorePlace = false,
  now = () => new Date(),
}: JobActionMutationParams) {
  const options: JobActionOptions = { restorePlace };
  /** The list with the queue places worked out again, when the job joined the queue with a restored place. */
  const placed = (list: Job[], job: Job): Job[] =>
    restorePlace && job.state === 'queued' ? withQueuePlaces(list) : list;
  return mutationOptions<Job, ApiError, string, JobActionContext>({
    mutationKey: [JOB_ACTION_MUTATION_KEY, action],
    mutationFn: (id) =>
      restorePlace
        ? api.runJobAction(id, action, undefined, options)
        : api.runJobAction(id, action),

    async onMutate(id) {
      // A fetch that finishes after the optimistic change would wipe it; the reload on settle
      // fetches again.
      await queryClient.cancelQueries({ queryKey: JOBS_KEY });
      const previous = findJob(queryClient.getQueryData<Job[]>(JOBS_KEY), id);
      if (previous === undefined) return {};

      let optimistic: Job;
      try {
        optimistic = transition(previous, eventForAction(action, options), now(), {
          settleMs: cachedSettleMs(queryClient),
        });
      } catch (error) {
        if (error instanceof InvalidTransition) return {};
        throw error;
      }
      queryClient.setQueryData<Job[]>(
        JOBS_KEY,
        (list) => list && placed(upsertJob(list, optimistic), optimistic),
      );
      return { previous, optimistic };
    },

    onSuccess(job) {
      queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => list && upsertJob(list, job));
      // Send notes took every unsent note into the round. Not in onMutate: a refused Send ("Wait
      // for the voice notes…") keeps the notes.
      if (action === 'send_notes') {
        queryClient.setQueryData<ReviewNote[]>(notesKey(job.id), (list) => list && []);
      }
    },

    onError(_error, id, context) {
      const { previous, optimistic } = context ?? {};
      if (previous === undefined || optimistic === undefined) return;
      queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => {
        const current = findJob(list, id);
        // A reload already replaced the optimistic job: that one is the truth, leave it.
        if (list === undefined || current === undefined || !sameVersion(current, optimistic)) {
          return list;
        }
        return upsertJob(list, previous);
      });
    },

    onSettled() {
      // Not awaited: the button is free as soon as the answer is in, not when the reload is.
      void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    },
  });
}
