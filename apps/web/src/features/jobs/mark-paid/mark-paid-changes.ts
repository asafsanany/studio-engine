import type { Job } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { ApiError, applyStageChange } from '@/data';
import type { Api } from '@/data/api';
import type { MarkPaidVariables } from '@/data/delivery-mutations';
import { isPriced } from '../delivery-text';
import { announcePaid, announcePaymentUndoRefused, type PaidClient } from './mark-paid-toasts';
import type { OwedJob } from './pay-list';

/** What a payment needs from the outside: the route (the mutation), Undo's route, and the jobs cache. */
export interface MarkPaidDeps {
  /** Mark paid (`useMarkPaid().mutateAsync`): the jobs, now paid, already in the cache. */
  markPaid: (variables: MarkPaidVariables) => Promise<Job[]>;
  api: Pick<Api, 'undoPaid'>;
  queryClient: QueryClient;
}

/** How a payment ended: done (and told), or refused with words for the dialog to show. */
export type PaymentOutcome = { ok: true } | { ok: false; message: string };

/**
 * What the dialog says when the server refuses the payment (409): a video it listed changed
 * meanwhile (paid from another window, or put back to Approved), so nothing was marked. The list
 * has been loaded again by then, so it already shows what is left.
 */
export const PAYMENT_CHANGED_TEXT = 'Something changed meanwhile. Check the list and try again.';

/** The words under the dialog's list for a payment that failed. */
export function paymentErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return PAYMENT_CHANGED_TEXT;
  return error instanceof Error ? error.message : String(error);
}

const hasDelivery = (job: Job): job is OwedJob => job.delivery !== null && isPriced(job.delivery);

/**
 * Undo of a payment: sends the jobs to Not paid yet and puts the jobs it answers with in the list.
 * It calls the route itself instead of using a mutation: the message outlives the dialog (and the
 * page), and an answer nobody is left to show would be lost. A refusal (409: a video moved on
 * meanwhile) or an unreachable server is told as a message of its own.
 */
async function undoPayment(
  deps: MarkPaidDeps,
  client: PaidClient,
  jobIds: readonly string[],
): Promise<void> {
  try {
    applyStageChange(deps.queryClient, await deps.api.undoPaid(jobIds));
  } catch (error) {
    announcePaymentUndoRefused(
      client,
      jobIds,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * "Mark N paid": sends the payment for `ticked` on `paidOn`, with what was paid for each
 * (`amounts`, by job id; one left out was paid its price). When it goes through it says so
 * ("3 videos from <client> marked paid · ₪120", what was paid) with an Undo that sends the same videos to Not paid
 * yet; when the server refuses or cannot be reached it says why, for the dialog to show, and
 * changes nothing. It does not depend on a component, so the message and its Undo outlive the dialog.
 */
export async function payOwed(
  deps: MarkPaidDeps,
  client: PaidClient,
  ticked: readonly OwedJob[],
  paidOn: string,
  amounts?: Readonly<Record<string, number>>,
): Promise<PaymentOutcome> {
  const jobIds = ticked.map((job) => job.id);
  let paid: OwedJob[];
  try {
    paid = (await deps.markPaid({ jobIds, paidOn, amounts })).filter(hasDelivery);
  } catch (error) {
    return { ok: false, message: paymentErrorText(error) };
  }
  announcePaid(client, paid, () => void undoPayment(deps, client, jobIds));
  return { ok: true };
}
