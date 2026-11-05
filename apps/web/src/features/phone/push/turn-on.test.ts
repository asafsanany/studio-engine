import { DEFAULT_PUSH_EVENTS, type PushDevice } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/api';
import type { PushRegistrationLike, PushSubscriptionLike } from './push-browser';
import { type TurnOnDeps, turnOnNotifications } from './turn-on';

const DEVICE: PushDevice = {
  id: 'd1',
  label: 'iPhone',
  events: { ...DEFAULT_PUSH_EVENTS },
  createdAt: '2026-10-22T10:00:00.000Z',
  lastOkAt: null,
};

const SUBSCRIPTION: PushSubscriptionLike = {
  endpoint: 'https://push.example/1',
  toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }),
  unsubscribe: async () => true,
};

function deps(overrides: Partial<TurnOnDeps> = {}) {
  const order: string[] = [];
  const subscribe = vi.fn(async () => {
    order.push('subscribe');
    return SUBSCRIPTION;
  });
  const registration: PushRegistrationLike = {
    pushManager: { getSubscription: async () => null, subscribe },
  };
  const api = {
    getKey: vi.fn(async () => {
      order.push('key');
      return 'AQID';
    }),
    registerDevice: vi.fn(async () => {
      order.push('register');
      return DEVICE;
    }),
  };
  const requestPermission = vi.fn(async () => {
    order.push('permission');
    return 'granted';
  });
  return {
    order,
    subscribe,
    api,
    requestPermission,
    deps: {
      requestPermission,
      registration: async () => registration,
      api,
      ...overrides,
    } satisfies TurnOnDeps,
  };
}

describe('turnOnNotifications', () => {
  it('asks, subscribes with the engine’s key and registers this phone, in that order', async () => {
    const { deps: d, order, subscribe, api } = deps();
    await expect(turnOnNotifications(d)).resolves.toEqual({ kind: 'on', device: DEVICE });
    expect(order).toEqual(['permission', 'key', 'subscribe', 'register']);
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(api.registerDevice).toHaveBeenCalledWith(SUBSCRIPTION.toJSON());
  });

  it('asks before anything is awaited: the question is inside the tap', () => {
    const { deps: d, requestPermission } = deps();
    void turnOnNotifications(d);
    // Called synchronously, as the tap's handler runs.
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('uses a key fetched ahead instead of asking the engine during the tap', async () => {
    const { deps: d, order } = deps({ publicKey: 'AQID' });
    await turnOnNotifications(d);
    expect(order).toEqual(['permission', 'subscribe', 'register']);
  });

  it('stops at a refusal, and at a question left unanswered, without subscribing', async () => {
    const denied = deps({ requestPermission: async () => 'denied' });
    await expect(turnOnNotifications(denied.deps)).resolves.toEqual({ kind: 'denied' });
    expect(denied.subscribe).not.toHaveBeenCalled();

    const unanswered = deps({ requestPermission: async () => 'default' });
    await expect(turnOnNotifications(unanswered.deps)).resolves.toEqual({ kind: 'dismissed' });
    expect(unanswered.api.registerDevice).not.toHaveBeenCalled();
  });

  it('says why when the key, the subscription or the registration fails', async () => {
    const noKey = deps();
    noKey.api.getKey.mockRejectedValueOnce(
      new ApiError(503, 'Notifications are not available: push.json is unreadable.'),
    );
    await expect(turnOnNotifications(noKey.deps)).resolves.toEqual({
      kind: 'failed',
      message: 'Notifications are not available: push.json is unreadable.',
    });

    const noSubscription = deps();
    noSubscription.subscribe.mockRejectedValueOnce(new Error('Registration failed'));
    await expect(turnOnNotifications(noSubscription.deps)).resolves.toEqual({
      kind: 'failed',
      message: 'Registration failed',
    });

    const notRegistered = deps();
    notRegistered.api.registerDevice.mockRejectedValueOnce(
      new ApiError(0, 'Cannot reach the Studio Engine server.'),
    );
    await expect(turnOnNotifications(notRegistered.deps)).resolves.toMatchObject({
      kind: 'failed',
      message: 'Cannot reach the Studio Engine server.',
    });

    const throws = deps({
      requestPermission: () => {
        throw new TypeError('');
      },
    });
    await expect(turnOnNotifications(throws.deps)).resolves.toEqual({
      kind: 'failed',
      message: 'Something went wrong.',
    });
  });
});
