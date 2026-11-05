import type { JobAction } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { DeliveryMutationAction } from '@/data/delivery-mutations';
import { JOB_ACTION_MUTATION_KEY } from '@/data/job-action';

/**
 * The row actions whose refusal a row explains in its own tooltip (`ActionError`): the job actions
 * that go to the server from a row, and the stage changes (Mark delivered, Not delivered yet, Not
 * paid yet). Cancel is not one of them: its question and its answer belong to the page already
 * (`CancelDialogHost`). Mark paid… is not either: it is the dialog's.
 */
export const REFUSABLE_ACTIONS = [
  'start',
  'hold',
  'release',
  'resume',
  'retry',
  'deliver',
  'undeliver',
  'unpay',
] as const satisfies readonly (JobAction | DeliveryMutationAction)[];

export type RefusableAction = (typeof REFUSABLE_ACTIONS)[number];

/** A row action the server (or the network) turned down, for which no row is left to say so. */
export interface RefusedAction {
  jobId: string;
  action: RefusableAction;
  /** The server's own words ("Only a queued job can be held.") or the network's. */
  message: string;
}

function isRefusable(action: unknown): action is RefusableAction {
  return REFUSABLE_ACTIONS.some((candidate) => candidate === action);
}

/**
 * Calls `onRefused` for every Start now, Hold, Release, Resume, Retry, Mark delivered, Not
 * delivered yet or Not paid yet that is refused after the row that sent it has left the page;
 * returns "stop watching".
 *
 * A refused action is explained by a tooltip under its row's buttons, but the list sorts by Last
 * updated and a request changes the job (the optimistic update), so by the time the answer is in
 * the row may be on another page, or filtered out. That row's `ActionCell` is then unmounted, and
 * with it the `useMutation` observers that would have carried the answer to the tooltip.
 *
 * So the test is not where the row is but whether anything is left to show the answer: a refusal
 * is passed on only when no observer is attached to its mutation any more. (A row that went away
 * and came back is a new cell with new observers; it knows nothing of the old request, so it
 * counts as gone too.) While an observer is attached the tooltip has it and nothing is reported.
 */
export function watchRefusedActions(
  queryClient: QueryClient,
  onRefused: (refused: RefusedAction) => void,
): () => void {
  // Observers attached to each mutation. One that began before the watch is not in the map and
  // counts as 0: that only happens when the page was left and reopened with the request in
  // flight, and then its row is gone indeed.
  const attached = new WeakMap<object, number>();

  return queryClient.getMutationCache().subscribe((event) => {
    if (event.type === 'observerAdded') {
      attached.set(event.mutation, (attached.get(event.mutation) ?? 0) + 1);
    } else if (event.type === 'observerRemoved') {
      attached.set(event.mutation, Math.max(0, (attached.get(event.mutation) ?? 0) - 1));
    } else if (event.type === 'updated' && event.action.type === 'error') {
      const { mutation } = event;
      const [scope, action] = mutation.options.mutationKey ?? [];
      const jobId: unknown = mutation.state.variables;
      if (scope !== JOB_ACTION_MUTATION_KEY || !isRefusable(action)) return;
      if (typeof jobId !== 'string') return;
      if ((attached.get(mutation) ?? 0) > 0) return;
      const { error } = event.action;
      onRefused({ jobId, action, message: error instanceof Error ? error.message : String(error) });
    }
  });
}
