import { describe, expect, it, vi } from 'vitest';
import {
  base64UrlToBytes,
  notificationPermission,
  type PushRegistrationLike,
  type PushSubscriptionLike,
  type PushWindow,
  pushSupport,
  sameKey,
  subscribeWith,
} from './push-browser';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function win(overrides: Partial<PushWindow> & { standalone?: boolean } = {}): PushWindow {
  const { standalone = true, ...rest } = overrides;
  return {
    navigator: { userAgent: IPHONE, standalone, serviceWorker: {} },
    localStorage: { getItem: () => null, setItem: () => undefined },
    Notification: { permission: 'default', requestPermission: async () => 'granted' },
    PushManager: function PushManager() {},
    ...rest,
  };
}

describe('pushSupport', () => {
  it('is supported in the Home Screen app with service workers, push and notifications', () => {
    expect(pushSupport(win())).toBe('supported');
  });

  it('counts the display-mode media query as the Home Screen app too', () => {
    const viaQuery = win({
      standalone: false,
      matchMedia: (query) => ({ matches: query === '(display-mode: standalone)' }),
    });
    expect(pushSupport(viaQuery)).toBe('supported');
  });

  it('is a browser tab outside the Home Screen app, whatever the browser has', () => {
    expect(pushSupport(win({ standalone: false }))).toBe('browser');
  });

  it('is unsupported in a Home Screen app without push (iOS before 16.4)', () => {
    expect(pushSupport(win({ PushManager: undefined }))).toBe('unsupported');
    expect(pushSupport(win({ Notification: undefined }))).toBe('unsupported');
    expect(pushSupport(win({ navigator: { userAgent: IPHONE, standalone: true } }))).toBe(
      'unsupported',
    );
  });
});

describe('notificationPermission', () => {
  it('reads Notification.permission, and default where there is none or it is odd', () => {
    const asked = (permission: string) =>
      notificationPermission(win({ Notification: { permission, requestPermission: vi.fn() } }));
    expect(asked('granted')).toBe('granted');
    expect(asked('denied')).toBe('denied');
    expect(asked('default')).toBe('default');
    expect(asked('prompt')).toBe('default');
    expect(notificationPermission(win({ Notification: undefined }))).toBe('default');
  });
});

describe('base64UrlToBytes', () => {
  it('decodes base64url, with or without padding', () => {
    expect([...base64UrlToBytes('AQID')]).toEqual([1, 2, 3]);
    expect([...base64UrlToBytes('-_8')]).toEqual([251, 255]);
    expect([...base64UrlToBytes('-_8=')]).toEqual([251, 255]);
    expect(base64UrlToBytes(Buffer.alloc(65, 4).toString('base64url'))).toHaveLength(65);
  });
});

describe('sameKey', () => {
  const key = new Uint8Array([1, 2, 3]);
  it('compares the bytes, and takes a browser that does not say as the same key', () => {
    expect(sameKey(new Uint8Array([1, 2, 3]).buffer, key)).toBe(true);
    expect(sameKey(new Uint8Array([1, 2, 4]).buffer, key)).toBe(false);
    expect(sameKey(new Uint8Array([1, 2]).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(true);
    expect(sameKey(undefined, key)).toBe(true);
  });
});

describe('subscribeWith', () => {
  function subscription(key: number[] | null): PushSubscriptionLike {
    return {
      endpoint: 'https://push.example/1',
      options: { applicationServerKey: key === null ? null : new Uint8Array(key).buffer },
      toJSON: () => ({ endpoint: 'https://push.example/1' }),
      unsubscribe: vi.fn(async () => true),
    };
  }

  function registration(existing: PushSubscriptionLike | null) {
    const fresh = subscription([1, 2, 3]);
    const subscribe = vi.fn(async () => fresh);
    const reg: PushRegistrationLike = {
      pushManager: { getSubscription: async () => existing, subscribe },
    };
    return { reg, subscribe, fresh };
  }

  it('keeps the subscription this phone has when it was made with the same key', async () => {
    const existing = subscription([1, 2, 3]);
    const { reg, subscribe } = registration(existing);
    await expect(subscribeWith(reg, 'AQID')).resolves.toBe(existing);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('subscribes with the key, user-visible only, when there is none', async () => {
    const { reg, subscribe, fresh } = registration(null);
    await expect(subscribeWith(reg, 'AQID')).resolves.toBe(fresh);
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
  });

  it('drops a subscription made with another key before subscribing again', async () => {
    const existing = subscription([7, 7, 7]);
    const { reg, subscribe, fresh } = registration(existing);
    await expect(subscribeWith(reg, 'AQID')).resolves.toBe(fresh);
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalled();
  });
});
