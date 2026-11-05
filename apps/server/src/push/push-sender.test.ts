import { afterEach, describe, expect, it, vi } from 'vitest';

// `web-push` is replaced: nothing here can reach a push service.
vi.mock('web-push', () => {
  class WebPushError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    default: {
      WebPushError,
      sendNotification: vi.fn(),
      generateVAPIDKeys: vi.fn(() => ({ publicKey: 'pub', privateKey: 'priv' })),
    },
  };
});

import webpush from 'web-push';
import { createWebPushSender, generateVapidKeys, isGone, PushSendError } from './push-sender.js';
import { FAKE_KEYS } from './test-utils.js';

const send = vi.mocked(webpush.sendNotification);
const SUBSCRIPTION = { endpoint: 'https://web.push.apple.com/secret-token', ...FAKE_KEYS };
const PAYLOAD = { title: 'Ready to review', body: 'Spring · Bakery', url: '/jobs', tag: 'a1' };
const sender = createWebPushSender({
  keys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
  subject: () => 'mailto:owner@example.com',
});

afterEach(() => {
  send.mockReset();
});

describe('createWebPushSender', () => {
  it('sends the payload as JSON with a one-hour TTL, signed with the keys and the subject', async () => {
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    await sender.send(SUBSCRIPTION, PAYLOAD);

    expect(send).toHaveBeenCalledWith(
      { endpoint: SUBSCRIPTION.endpoint, keys: { p256dh: FAKE_KEYS.p256dh, auth: FAKE_KEYS.auth } },
      JSON.stringify(PAYLOAD),
      {
        TTL: 3600,
        vapidDetails: { subject: 'mailto:owner@example.com', publicKey: 'pub', privateKey: 'priv' },
      },
    );
  });

  it('turns the push service’s refusal into a PushSendError with its status and no endpoint', async () => {
    const refusal = new webpush.WebPushError(
      'Received unexpected response code',
      410,
      {},
      'gone',
      SUBSCRIPTION.endpoint,
    );
    send.mockRejectedValue(refusal);

    const error = await sender.send(SUBSCRIPTION, PAYLOAD).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PushSendError);
    expect(error).toMatchObject({ statusCode: 410, code: null });
    expect(String((error as Error).message)).not.toContain('secret-token');
    expect(isGone(error)).toBe(true);
  });

  it('keeps the network error code and no status', async () => {
    send.mockRejectedValue(
      Object.assign(new Error('connect ECONNRESET 17.1.2.3:443'), { code: 'ECONNRESET' }),
    );

    const error = await sender.send(SUBSCRIPTION, PAYLOAD).catch((e: unknown) => e);

    expect(error).toMatchObject({ statusCode: null, code: 'ECONNRESET' });
    expect(isGone(error)).toBe(false);
  });

  it('fails the send, not the engine, when the keys cannot be had', async () => {
    const broken = createWebPushSender({
      keys: () => {
        throw new Error('push.json is broken');
      },
      subject: () => 'mailto:owner@example.com',
    });

    await expect(broken.send(SUBSCRIPTION, PAYLOAD)).rejects.toBeInstanceOf(PushSendError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('isGone', () => {
  it('is true for a 404 and a 410 only', () => {
    expect(isGone(new PushSendError('x', 404))).toBe(true);
    expect(isGone(new PushSendError('x', 410))).toBe(true);
    expect(isGone(new PushSendError('x', 400))).toBe(false);
    expect(isGone(new PushSendError('x', 500))).toBe(false);
    expect(isGone(new PushSendError('x', null))).toBe(false);
    expect(isGone(new Error('x'))).toBe(false);
  });
});

describe('generateVapidKeys', () => {
  it('asks web-push for a pair', () => {
    expect(generateVapidKeys()).toEqual({ publicKey: 'pub', privateKey: 'priv' });
  });
});
