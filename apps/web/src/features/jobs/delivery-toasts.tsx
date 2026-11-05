import type { Job } from '@studio/shared';
import type { CSSProperties } from 'react';
import { toast } from 'sonner';
import { ACTION_ERROR_MS } from './cells/ActionError';
import { deliveredMonth, formatPrice, isPriced } from './delivery-text';
import { UNDO_BUTTON_CLASS } from './use-look/use-look-toasts';

/** How long a message about a delivery stays: long enough to read it and reach for Undo. */
export const DELIVERY_TOAST_MS = 7000;

/**
 * The messages about a delivery or a payment are 380 px wide, the board's, where sonner's are 356:
 * "Delivered to <client> · ₪40 counts in October" then fits on one line. Sonner draws a toast
 * `var(--width)` wide, so this widens just these (the other messages keep sonner's width), and a
 * toast is anchored to the right edge, so it grows to the left.
 */
export const DELIVERY_TOAST_STYLE = { '--width': '380px' } as CSSProperties;

/** What a message needs to know about a job: its client and the delivery it had or got. */
export type DeliveryToastJob = Pick<Job, 'id' | 'client' | 'delivery'>;

/**
 * The toast id of one kind of message about a job: the newest replaces the one before (so Undo is
 * always the newest change's). Each kind has its own id: Undo closes its message when it is
 * pressed, and a message that reuses the id of one that is closing is swallowed by it.
 */
export const deliveryToastId = (
  kind: 'delivered' | 'undelivered' | 'unpaid' | 'approved' | 'unapproved' | 'undo-refused',
  jobId: string,
) => `delivery:${kind}:${jobId}`;

/** "₪40 counts in October" / "₪40 taken off October": the price and month of a delivery. */
function priceAndMonth(job: DeliveryToastJob, verb: string): string | null {
  const { delivery } = job;
  if (delivery === null || !isPriced(delivery)) return null;
  return `${formatPrice(delivery.price, delivery.currency)} ${verb} ${deliveredMonth(delivery)}`;
}

/**
 * A message that lasts 7 s, 380 px wide, and has Undo, a quiet outlined button (the Use this look
 * message's). With nothing to undo it is the message alone.
 */
function withUndo(onUndo: (() => void) | undefined) {
  return {
    duration: DELIVERY_TOAST_MS,
    style: DELIVERY_TOAST_STYLE,
    ...(onUndo === undefined
      ? {}
      : {
          action: { label: 'Undo', onClick: onUndo },
          classNames: { actionButton: UNDO_BUTTON_CLASS },
        }),
  };
}

/**
 * After Mark delivered: "Delivered to <client> · ₪40 counts in October", with Undo. `job` is the
 * job as the server answered, with its delivery. The client keeps its own direction.
 */
export function announceDelivered(job: DeliveryToastJob, onUndo: () => void): void {
  const counts = priceAndMonth(job, 'counts in');
  toast(
    <>
      Delivered to <bdi>{job.client}</bdi>
      {counts === null ? '' : ` · ${counts}`}
    </>,
    { id: deliveryToastId('delivered', job.id), ...withUndo(onUndo) },
  );
}

/**
 * After Not delivered yet: "Back to Approved · ₪40 taken off October", with Undo. `job` is the job
 * as it was before (its delivery is what is taken off).
 */
export function announceUndelivered(job: DeliveryToastJob, onUndo: () => void): void {
  const taken = priceAndMonth(job, 'taken off');
  toast(`Back to Approved${taken === null ? '' : ` · ${taken}`}`, {
    id: deliveryToastId('undelivered', job.id),
    ...withUndo(onUndo),
  });
}

/**
 * After Not delivered yet on a video whose folder was deleted (CVP-204): "Delivery removed · ₪40
 * taken off October". There is no job to go back to Approved and Mark delivered cannot bring the
 * delivery back, so the message has no Undo and says why. `job` is the video as it was.
 */
export function announceDeliveryRemoved(job: DeliveryToastJob): void {
  const taken = priceAndMonth(job, 'taken off');
  toast(`Delivery removed${taken === null ? '' : ` · ${taken}`}`, {
    id: deliveryToastId('undelivered', job.id),
    description: 'Its folder is deleted, so it can’t go back to Approved.',
    ...withUndo(undefined),
  });
}

/**
 * After Approve (the row's menu): `Approved “<name>” · the final video is rendering`. There is no
 * Undo: Unapprove waits until the render is done (it is in the same menu then). The name keeps its
 * own direction.
 */
export function announceApproved(job: Pick<Job, 'id' | 'name'>): void {
  toast(
    <>
      Approved “<bdi>{job.name}</bdi>” · the final video is rendering
    </>,
    { id: deliveryToastId('approved', job.id), ...withUndo(undefined) },
  );
}

/**
 * After Unapprove: `Back in Review: “<name>”`. There is no Undo: Approve renders the video again.
 * `job` is the job as the server answered. The name keeps its own direction.
 */
export function announceUnapproved(job: Pick<Job, 'id' | 'name'>): void {
  toast(
    <>
      Back in Review: “<bdi>{job.name}</bdi>”
    </>,
    { id: deliveryToastId('unapproved', job.id), ...withUndo(undefined) },
  );
}

/**
 * After Not paid yet: "Back to Delivered · not paid yet", with Undo (when there is a payment to put
 * back). A video with a reel linked to it (its delivery has `uploadedAt`) goes back to Uploaded, so
 * the message says that. `job` is the job as it was, paid, or as the server answered.
 */
export function announceUnpaid(
  job: Pick<Job, 'id'> & { delivery?: Pick<NonNullable<Job['delivery']>, 'uploadedAt'> | null },
  onUndo: (() => void) | undefined,
): void {
  const stage = job.delivery?.uploadedAt === undefined ? 'Delivered' : 'Uploaded';
  toast(`Back to ${stage} · not paid yet`, {
    id: deliveryToastId('unpaid', job.id),
    ...withUndo(onUndo),
  });
}

/**
 * The server refused an Undo (409: the job moved on meanwhile, say it was paid) or could not be
 * reached: "Couldn't undo <client> / <job>", then the server's own words. The names keep their own
 * direction.
 */
export function announceDeliveryUndoRefused(
  job: Pick<Job, 'id' | 'client' | 'name'>,
  message: string,
): void {
  toast.error(
    <>
      Couldn&apos;t undo <bdi>{job.client}</bdi> / <bdi>{job.name}</bdi>
    </>,
    {
      id: deliveryToastId('undo-refused', job.id),
      description: message,
      duration: ACTION_ERROR_MS,
    },
  );
}
