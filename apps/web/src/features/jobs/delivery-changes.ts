import { isFolderDeleted, type Job } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { applyStageChange } from '@/data';
import type { Api } from '@/data/api';
import {
  announceDelivered,
  announceDeliveryRemoved,
  announceDeliveryUndoRefused,
  announceUndelivered,
  announceUnpaid,
} from './delivery-toasts';

/** What the messages' Undo needs: the routes, and the jobs cache to put their answers in. */
export interface DeliveryChangeDeps {
  api: Pick<Api, 'deliverJob' | 'undeliverJob' | 'markPaid'>;
  queryClient: QueryClient;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Undo: calls the opposite route and puts the jobs it answers with in the list. It calls the route
 * itself instead of using a row's mutation: the message outlives its row (the job moves to another
 * tab or page), and an answer nobody is left to show would be lost. A refusal (409: the job moved
 * on meanwhile) or an unreachable server is told as a message of its own.
 */
async function undoWith(
  deps: DeliveryChangeDeps,
  job: Pick<Job, 'id' | 'client' | 'name'>,
  route: () => Promise<Job | Job[]>,
): Promise<void> {
  try {
    const answer = await route();
    applyStageChange(deps.queryClient, Array.isArray(answer) ? answer : [answer]);
  } catch (error) {
    announceDeliveryUndoRefused(job, messageOf(error));
  }
}

/**
 * Mark delivered went through: "Delivered to <client> · ₪40 counts in October". Its Undo is Not
 * delivered yet. `delivered` is the job as the server answered, with its delivery.
 */
export function afterDelivered(deps: DeliveryChangeDeps, delivered: Job): void {
  announceDelivered(delivered, () => {
    void undoWith(deps, delivered, () => deps.api.undeliverJob(delivered.id));
  });
}

/**
 * Not delivered yet went through: "Back to Approved · ₪40 taken off October". Its Undo is Mark
 * delivered again, which marks the job delivered now at the client's price now (the earlier moment
 * is gone with the delivery). `before` is the job as it was, with the delivery that was taken off.
 *
 * A video whose folder was deleted has no job to go back to Approved, and Mark delivered needs a
 * job: its message says the delivery was removed, with no Undo.
 */
export function afterUndelivered(deps: DeliveryChangeDeps, before: Job): void {
  if (isFolderDeleted(before)) {
    announceDeliveryRemoved(before);
    return;
  }
  announceUndelivered(before, () => {
    void undoWith(deps, before, () => deps.api.deliverJob(before.id));
  });
}

/**
 * Not paid yet went through: "Back to Delivered · not paid yet" ("Back to Uploaded" for a video with
 * a reel linked to it). Its Undo is the payment again, on the day and for the amount it had.
 * `before` is the job as it was, paid.
 */
export function afterUnpaid(deps: DeliveryChangeDeps, before: Job): void {
  const paidOn = before.delivery?.paidOn ?? null;
  const paidAmount = before.delivery?.paidAmount ?? null;
  const amounts = paidAmount === null ? undefined : { [before.id]: paidAmount };
  // Only a paid job offers Not paid yet, so it had a day; with none there is nothing to put back.
  announceUnpaid(
    before,
    paidOn === null
      ? undefined
      : () => {
          void undoWith(deps, before, () => deps.api.markPaid([before.id], paidOn, amounts));
        },
  );
}
