import { describe, expect, it } from 'vitest';
import type { PushWindow } from './push-browser';
import { createPushStore, NOTIFY_CARD_KEY, PUSH_DEVICE_KEY, type PushStorage } from './push-store';

function memoryStorage(initial: Record<string, string> = {}): PushStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

function win(permission: string): PushWindow & { Notification: { permission: string } } {
  return {
    navigator: { userAgent: 'iPhone' },
    localStorage: { getItem: () => null, setItem: () => undefined },
    Notification: { permission, requestPermission: async () => permission },
  };
}

describe('createPushStore', () => {
  it('starts with nothing remembered', () => {
    const store = createPushStore(memoryStorage(), win('default'));
    expect(store.getState()).toMatchObject({
      deviceId: null,
      cardMemory: null,
      permission: 'default',
    });
  });

  it('keeps the device id and the card’s memory for the next open', () => {
    const storage = memoryStorage();
    const store = createPushStore(storage, win('granted'));
    store.getState().setDeviceId('d1');
    store.getState().rememberCard('dismissed');
    expect(storage.data).toEqual({ [PUSH_DEVICE_KEY]: 'd1', [NOTIFY_CARD_KEY]: 'dismissed' });

    const reopened = createPushStore(storage, win('granted'));
    expect(reopened.getState()).toMatchObject({ deviceId: 'd1', cardMemory: 'dismissed' });

    reopened.getState().setDeviceId(null);
    expect(storage.data[PUSH_DEVICE_KEY]).toBeUndefined();
    expect(reopened.getState().deviceId).toBeNull();
  });

  it('ignores a memory it does not know', () => {
    const store = createPushStore(memoryStorage({ [NOTIFY_CARD_KEY]: 'maybe' }), win('default'));
    expect(store.getState().cardMemory).toBeNull();
  });

  it('reads the permission again when asked to', () => {
    const w = win('default');
    const store = createPushStore(memoryStorage(), w);
    w.Notification.permission = 'granted';
    expect(store.getState().permission).toBe('default');
    store.getState().refreshPermission();
    expect(store.getState().permission).toBe('granted');
  });

  it('works without storage at all (blocked site data), for this visit only', () => {
    const throwing: PushStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const store = createPushStore(throwing, null);
    expect(store.getState()).toMatchObject({ deviceId: null, permission: 'default' });
    store.getState().setDeviceId('d1');
    expect(store.getState().deviceId).toBe('d1');
  });
});
