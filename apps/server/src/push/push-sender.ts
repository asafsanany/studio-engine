// The one place that talks to a push service (Apple's, Google's, Mozilla's) through `web-push`.
// Everything else sends through a `PushSender`, so tests hand in a fake and no real push is ever
// sent from them.

import { PUSH_TTL_SEC, type PushPayload } from '@studio/shared';
import webpush from 'web-push';
import type { VapidKeys } from './vapid-keys.js';

/** A device's push subscription: where to send, and the keys that encrypt what is sent. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends one payload to one subscription. Rejects with a `PushSendError`. */
export interface PushSender {
  send(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<void>;
}

/**
 * Why a push did not go. `statusCode` is the push service's answer (404 and 410 mean the
 * subscription is gone for good), or `null` when it never answered. The message never holds the
 * endpoint, which is a secret of the subscription.
 */
export class PushSendError extends Error {
  readonly statusCode: number | null;
  readonly code: string | null;

  constructor(message: string, statusCode: number | null = null, code: string | null = null) {
    super(message);
    this.name = 'PushSendError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The subscription is gone: the app was removed from the phone, or notifications were turned off. */
export function isGone(error: unknown): boolean {
  return error instanceof PushSendError && (error.statusCode === 404 || error.statusCode === 410);
}

export interface WebPushSenderOptions {
  /** The VAPID keys; asked at every send, so keys that could not be made fail that send only. */
  keys: () => VapidKeys;
  /** The VAPID subject: a `mailto:` or https address of whoever runs this engine. */
  subject: () => string;
}

/** The real sender, with a one-hour TTL. */
export function createWebPushSender({ keys, subject }: WebPushSenderOptions): PushSender {
  return {
    async send(subscription, payload) {
      try {
        const { publicKey, privateKey } = keys();
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
          { TTL: PUSH_TTL_SEC, vapidDetails: { subject: subject(), publicKey, privateKey } },
        );
      } catch (err) {
        if (err instanceof PushSendError) throw err;
        if (err instanceof webpush.WebPushError) {
          throw new PushSendError(`The push service answered ${err.statusCode}.`, err.statusCode);
        }
        const code = (err as NodeJS.ErrnoException).code;
        throw new PushSendError(
          `The push could not be sent${code ? ` (${code})` : ''}.`,
          null,
          code ?? null,
        );
      }
    },
  };
}

/** `generateVAPIDKeys` of web-push, for `ensureVapidKeys`. */
export function generateVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys();
}
