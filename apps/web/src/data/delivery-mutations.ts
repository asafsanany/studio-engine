// Mark delivered, Not delivered yet, Not paid yet and Mark paid: the actions that change a ready
// job's stage (Phase 4 §1), as mutations. The first three are a row's, with the job id as their
// variable; Mark paid is one payment for several jobs and belongs to the Mark paid dialog.
//
// No optimistic update: the server decides (409 unless the job is ready and not yet delivered, or
// delivered and not paid, ...), and a request is quick. The job the server answers with replaces
// the cached one, and the list is loaded again afterwards. The server also sends `job.upsert` for
// every job it touches, which keeps other windows right.
//
// The row mutations share the job actions' key (`JOB_ACTION_MUTATION_KEY`, then the action) and
// take the job id as their variable, so they behave like Hold or Retry: a stale event does not flip
// the job back while one is on its way (`isJobActionPending`), and a refusal nobody is left to
// show is told by the page (`watchRefusedActions`). Mark paid has a key of its own: its variable
// is several jobs, and the dialog it belongs to shows its refusal itself.

import { isFolderDeleted, type Job } from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { Api, ApiError } from './api';
import { JOB_ACTION_MUTATION_KEY } from './job-action';
import { JOBS_KEY, upsertJob } from './jobs-cache';
import { applyFolderDeletedJobs } from './orphan-deliveries';

/** The second element of these mutations' keys. */
export const DELIVERY_MUTATION_ACTIONS = ['deliver', 'undeliver', 'unpay'] as const;
export type DeliveryMutationAction = (typeof DELIVERY_MUTATION_ACTIONS)[number];

/** The key of Mark paid, the payment for several delivered videos at once. */
export const MARK_PAID_MUTATION_KEY = 'mark-paid';

/**
 * What a payment covers: these delivered videos, paid on this calendar day (`YYYY-MM-DD`), and
 * what was paid for each (by job id; a video left out was paid its price).
 */
export interface MarkPaidVariables {
  jobIds: readonly string[];
  paidOn: string;
  amounts?: Readonly<Record<string, number>>;
}

export interface DeliveryMutationParams {
  queryClient: QueryClient;
  api: Api;
}

/**
 * Puts jobs the server answered with into the cached list, and loads the list again. For the
 * Undo of a message, which calls the route itself (no mutation to do it). A video whose folder is
 * gone (`folderDeleted`, CVP-204) is not in that list: it goes to the list of such videos
 * (`applyFolderDeletedJobs`), which it joins while it is delivered and unpaid and leaves once it is
 * paid or its delivery is taken off.
 */
export function applyStageChange(queryClient: QueryClient, jobs: readonly Job[]): void {
  queryClient.setQueryData<Job[]>(JOBS_KEY, (list) => {
    if (list === undefined) return list;
    let next = list;
    for (const job of jobs) if (!isFolderDeleted(job)) next = upsertJob(next, job);
    return next;
  });
  void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
  applyFolderDeletedJobs(queryClient, jobs);
}

/** Mark delivered: the variable is the job id, the result the job with its `delivery`. */
export function deliverJobMutationOptions({ queryClient, api }: DeliveryMutationParams) {
  return mutationOptions<Job, ApiError, string>({
    mutationKey: [JOB_ACTION_MUTATION_KEY, 'deliver'],
    mutationFn: (id) => api.deliverJob(id),
    onSuccess: (job) => applyStageChange(queryClient, [job]),
    onError: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}

/** Not delivered yet: the variable is the job id, the result the job without a `delivery`. */
export function undeliverJobMutationOptions({ queryClient, api }: DeliveryMutationParams) {
  return mutationOptions<Job, ApiError, string>({
    mutationKey: [JOB_ACTION_MUTATION_KEY, 'undeliver'],
    mutationFn: (id) => api.undeliverJob(id),
    onSuccess: (job) => applyStageChange(queryClient, [job]),
    onError: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}

/** Not paid yet, for one job: the variable is the job id, the result that job, delivered again. */
export function undoPaidMutationOptions({ queryClient, api }: DeliveryMutationParams) {
  return mutationOptions<Job[], ApiError, string>({
    mutationKey: [JOB_ACTION_MUTATION_KEY, 'unpay'],
    mutationFn: (id) => api.undoPaid([id]),
    onSuccess: (jobs) => applyStageChange(queryClient, jobs),
    onError: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}

/**
 * Mark paid: one payment covers `jobIds` and came in on `paidOn`. The result is the jobs, now with
 * their paid day, in the order asked; they replace the cached ones. All or nothing: a 409 (one of
 * them changed meanwhile) changes nothing, and the list is loaded again so it shows what changed.
 */
export function markPaidMutationOptions({ queryClient, api }: DeliveryMutationParams) {
  return mutationOptions<Job[], ApiError, MarkPaidVariables>({
    mutationKey: [MARK_PAID_MUTATION_KEY],
    mutationFn: ({ jobIds, paidOn, amounts }) => api.markPaid(jobIds, paidOn, amounts),
    onSuccess: (jobs) => applyStageChange(queryClient, jobs),
    onError: () => void queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}
