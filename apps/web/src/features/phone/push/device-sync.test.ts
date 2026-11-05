import { DEFAULT_PUSH_EVENTS, type PushDevice, type PushEvents } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { syncPushDevice } from './device-sync';
import type { PushRegistrationLike, PushSubscriptionLike } from './push-browser';

const device = (id: string, events: PushEvents = { ...DEFAULT_PUSH_EVENTS }): PushDevice => ({
  id,
  label: 'iPhone',
  events,
  createdAt: '2026-10-22T10:00:00.000Z',
  lastOkAt: null,
});

const SUBSCRIPTION: PushSubscriptionLike = {
  endpoint: 'https://push.example/now',
  toJSON: () => ({ endpoint: 'https://push.example/now', keys: { p256dh: 'p', auth: 'a' } }),
  unsubscribe: async () => true,
};

function setup(
  subscription: PushSubscriptionLike | null,
  registered: PushDevice,
  stored?: PushDevice | null,
) {
  const registration: PushRegistrationLike = {
    pushManager: { getSubscription: async () => subscription, subscribe: vi.fn() },
  };
  const api = {
    registerDevice: vi.fn(async () => registered),
    getDevice: vi.fn(async () => stored ?? null),
    updateDevice: vi.fn(async (id: string, events: Partial<PushEvents>) =>
      device(id, { ...DEFAULT_PUSH_EVENTS, ...events }),
    ),
    deleteDevice: vi.fn(async () => undefined),
  };
  return { registration, api };
}

describe('syncPushDevice', () => {
  it('registers the subscription again and keeps the stored device when it is the same', async () => {
    const { registration, api } = setup(SUBSCRIPTION, device('d1'));
    await expect(syncPushDevice({ registration, storedId: 'd1', api })).resolves.toEqual(
      device('d1'),
    );
    expect(api.registerDevice).toHaveBeenCalledWith(SUBSCRIPTION.toJSON());
    expect(api.getDevice).not.toHaveBeenCalled();
    expect(api.deleteDevice).not.toHaveBeenCalled();
  });

  it('finds the device again when the stored id was lost', async () => {
    const { registration, api } = setup(SUBSCRIPTION, device('d1'));
    await expect(syncPushDevice({ registration, storedId: null, api })).resolves.toEqual(
      device('d1'),
    );
  });

  it('carries the old device’s switches to the new one and forgets the old one', async () => {
    const quiet: PushEvents = {
      review: true,
      failed: false,
      approved: false,
      queueEmpty: true,
      badge: false,
    };
    const { registration, api } = setup(SUBSCRIPTION, device('new'), device('old', quiet));
    await expect(syncPushDevice({ registration, storedId: 'old', api })).resolves.toEqual(
      device('new', quiet),
    );
    expect(api.updateDevice).toHaveBeenCalledWith('new', quiet);
    expect(api.deleteDevice).toHaveBeenCalledWith('old');
  });

  it('takes the new device as it is when the old one is gone already', async () => {
    const { registration, api } = setup(SUBSCRIPTION, device('new'), null);
    await expect(syncPushDevice({ registration, storedId: 'old', api })).resolves.toEqual(
      device('new'),
    );
    expect(api.updateDevice).not.toHaveBeenCalled();
    expect(api.deleteDevice).not.toHaveBeenCalled();
  });

  it('forgets the stored device when this phone has no subscription any more', async () => {
    const { registration, api } = setup(null, device('unused'));
    await expect(syncPushDevice({ registration, storedId: 'd1', api })).resolves.toBeNull();
    expect(api.deleteDevice).toHaveBeenCalledWith('d1');
    expect(api.registerDevice).not.toHaveBeenCalled();

    const none = setup(null, device('unused'));
    await expect(
      syncPushDevice({ registration: none.registration, storedId: null, api: none.api }),
    ).resolves.toBeNull();
    expect(none.api.deleteDevice).not.toHaveBeenCalled();
  });

  it('fails when the engine can’t be reached, so the next open tries again', async () => {
    const { registration, api } = setup(SUBSCRIPTION, device('d1'));
    api.registerDevice.mockRejectedValueOnce(new Error('offline'));
    await expect(syncPushDevice({ registration, storedId: 'd1', api })).rejects.toThrow('offline');
  });
});
