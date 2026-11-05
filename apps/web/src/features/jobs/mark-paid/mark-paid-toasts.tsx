import { toast } from 'sonner';
import { ACTION_ERROR_MS } from '../cells/ActionError';
import { DELIVERY_TOAST_MS, DELIVERY_TOAST_STYLE } from '../delivery-toasts';
import { UNDO_BUTTON_CLASS } from '../use-look/use-look-toasts';
import { formatTotal, type OwedJob, videoCount } from './pay-list';

/** The client a payment was from: what the messages call it, and the key that tells its messages apart. */
export interface PaidClient {
  clientId: string;
  client: string;
}

/**
 * The toast id of one kind of message about a payment. The jobs it covers are in the id, so the
 * message of a payment that is paid again after an Undo replaces the old one, while two different
 * payments each keep their own Undo. Each kind has its own id: Undo closes its message when it is
 * pressed, and a message that reuses the id of one that is closing is swallowed by it.
 */
export const paymentToastId = (kind: 'paid' | 'undo-refused', jobIds: readonly string[]) =>
  `mark-paid:${kind}:${jobIds.join(',')}`;

/**
 * After Mark paid: "3 videos from <client> marked paid · ₪120" ("1 video from …" for one), with
 * Undo. `paid` is the jobs as the server answered, so the total is what was paid for them.
 * It stays 7 s and is as wide as the other delivery messages. The client keeps its own direction.
 */
export function announcePaid(
  { client }: PaidClient,
  paid: readonly OwedJob[],
  onUndo: () => void,
): void {
  toast(
    <>
      {videoCount(paid.length)} from <bdi>{client}</bdi> marked paid · {formatTotal(paid)}
    </>,
    {
      id: paymentToastId(
        'paid',
        paid.map((job) => job.id),
      ),
      duration: DELIVERY_TOAST_MS,
      style: DELIVERY_TOAST_STYLE,
      action: { label: 'Undo', onClick: onUndo },
      classNames: { actionButton: UNDO_BUTTON_CLASS },
    },
  );
}

/**
 * The server refused an Undo of a payment (409: a video moved on meanwhile) or could not be
 * reached: "Couldn't undo the payment from <client>", then the server's own words.
 */
export function announcePaymentUndoRefused(
  { client }: PaidClient,
  jobIds: readonly string[],
  message: string,
): void {
  toast.error(
    <>
      Couldn&apos;t undo the payment from <bdi>{client}</bdi>
    </>,
    {
      id: paymentToastId('undo-refused', jobIds),
      description: message,
      duration: ACTION_ERROR_MS,
    },
  );
}
