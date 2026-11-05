// Helpers shared by the push tests. Not part of the server build (see tsconfig.build.json).

import type { PushPayload } from '@studio/shared';
import type { PushSendError, PushSender, PushSubscriptionRecord } from './push-sender.js';

/** One call to the fake sender. */
export interface SentPush {
  endpoint: string;
  payload: PushPayload;
}

/**
 * A sender that sends nothing: it records every call and answers as told. `failWith` makes the
 * next sends to an endpoint reject, with a status code like a push service's (410 = gone).
 */
export class FakeSender implements PushSender {
  readonly sent: SentPush[] = [];
  private readonly failures = new Map<string, PushSendError>();

  failWith(endpoint: string, error: PushSendError): void {
    this.failures.set(endpoint, error);
  }

  async send(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<void> {
    this.sent.push({ endpoint: subscription.endpoint, payload });
    const failure = this.failures.get(subscription.endpoint);
    if (failure) throw failure;
  }

  /** What went to one endpoint. */
  to(endpoint: string): PushPayload[] {
    return this.sent.filter((push) => push.endpoint === endpoint).map((push) => push.payload);
  }
}

/** The keys a real subscription has, in the sizes web-push wants. */
export const FAKE_KEYS = { p256dh: `B${'a'.repeat(86)}`, auth: 'b'.repeat(22) };
