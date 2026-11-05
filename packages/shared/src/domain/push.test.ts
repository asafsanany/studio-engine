import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_EVENTS,
  PUSH_EVENT_KEYS,
  PUSH_NOTIFY_KEYS,
  PUSH_ROUTES,
  PUSH_URLS,
  pushDeviceSchema,
  pushDeviceUpdateSchema,
  pushEventsPatchSchema,
  pushEventsSchema,
  pushPayloadSchema,
  pushSubscriptionSchema,
} from './push.ts';

// A real subscription's sizes: the P-256 point is 65 bytes (87 characters), the secret 16 (22).
const P256DH = `B${'a'.repeat(86)}`;
const AUTH = 'b'.repeat(22);
const ENDPOINT = 'https://web.push.apple.com/QGxyz';

describe('the push events', () => {
  it('has the five switches of the Settings section, Queue is empty off by default', () => {
    expect(PUSH_EVENT_KEYS).toEqual(['review', 'failed', 'approved', 'queueEmpty', 'badge']);
    expect(PUSH_NOTIFY_KEYS).toEqual(['review', 'failed', 'approved', 'queueEmpty']);
    expect(DEFAULT_PUSH_EVENTS).toEqual({
      review: true,
      failed: true,
      approved: true,
      queueEmpty: false,
      badge: true,
    });
    expect(pushEventsSchema.parse(DEFAULT_PUSH_EVENTS)).toEqual(DEFAULT_PUSH_EVENTS);
  });

  it('wants all five and nothing else, but a patch may name any of them', () => {
    expect(pushEventsSchema.safeParse({ review: true }).success).toBe(false);
    expect(pushEventsSchema.safeParse({ ...DEFAULT_PUSH_EVENTS, sound: true }).success).toBe(false);
    expect(pushEventsPatchSchema.parse({ queueEmpty: true })).toEqual({ queueEmpty: true });
    expect(pushEventsPatchSchema.safeParse({ review: 'yes' }).success).toBe(false);
  });

  it('is updated with at least one switch', () => {
    expect(pushDeviceUpdateSchema.safeParse({ events: { badge: false } }).success).toBe(true);
    expect(pushDeviceUpdateSchema.safeParse({ events: {} }).success).toBe(false);
    expect(pushDeviceUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe('pushSubscriptionSchema', () => {
  it('takes PushSubscription.toJSON() and ignores what else it carries', () => {
    const parsed = pushSubscriptionSchema.parse({
      endpoint: ENDPOINT,
      expirationTime: null,
      keys: { p256dh: P256DH, auth: AUTH },
    });
    expect(parsed).toEqual({ endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } });
  });

  it('wants an https endpoint', () => {
    for (const endpoint of ['http://push.example.com/x', 'not a url', '']) {
      expect(
        pushSubscriptionSchema.safeParse({ endpoint, keys: { p256dh: P256DH, auth: AUTH } })
          .success,
      ).toBe(false);
    }
  });

  it('wants keys web-push can use: base64url, a 65-byte point and at least 16 bytes of secret', () => {
    const with_ = (keys: { p256dh: string; auth: string }) =>
      pushSubscriptionSchema.safeParse({ endpoint: ENDPOINT, keys }).success;
    expect(with_({ p256dh: P256DH, auth: AUTH })).toBe(true);
    expect(with_({ p256dh: `${P256DH}=`, auth: `${AUTH}==` })).toBe(true);
    expect(with_({ p256dh: 'short', auth: AUTH })).toBe(false);
    expect(with_({ p256dh: P256DH, auth: 'short' })).toBe(false);
    expect(with_({ p256dh: `${P256DH}+`, auth: AUTH })).toBe(false);
    expect(with_({ p256dh: P256DH, auth: 'has spaces in it......' })).toBe(false);
  });
});

describe('pushPayloadSchema and pushDeviceSchema', () => {
  it('has title, body, url, tag and an optional badge', () => {
    const payload = {
      title: 'Ready to review',
      body: 'Spring menu · Bakery',
      url: '/jobs',
      tag: 'a1',
    };
    expect(pushPayloadSchema.parse(payload)).toEqual(payload);
    expect(pushPayloadSchema.parse({ ...payload, badge: 0 }).badge).toBe(0);
    expect(pushPayloadSchema.safeParse({ ...payload, badge: -1 }).success).toBe(false);
    expect(
      pushPayloadSchema.safeParse({ ...payload, url: 'https://elsewhere.example' }).success,
    ).toBe(false);
    expect(pushPayloadSchema.safeParse({ ...payload, title: '' }).success).toBe(false);
  });

  it('describes a device without its subscription', () => {
    const device = {
      id: 'd1',
      label: 'iPhone',
      events: DEFAULT_PUSH_EVENTS,
      createdAt: '2026-10-22T10:00:00.000Z',
      lastOkAt: null,
    };
    expect(pushDeviceSchema.parse(device)).toEqual(device);
    expect(Object.keys(pushDeviceSchema.shape)).not.toContain('endpoint');
  });
});

describe('the addresses', () => {
  it('names the routes the phone calls', () => {
    expect(PUSH_ROUTES.key).toBe('/api/push/key');
    expect(PUSH_ROUTES.devices).toBe('/api/push/devices');
    expect(PUSH_ROUTES.device('a b')).toBe('/api/push/devices/a%20b');
    expect(PUSH_ROUTES.test('d1')).toBe('/api/push/devices/d1/test');
  });

  it('opens Review, the sheet or the list', () => {
    expect(PUSH_URLS.review('a1b2')).toBe('/jobs?job=a1b2&review=1');
    expect(PUSH_URLS.sheet('a1b2')).toBe('/jobs?job=a1b2');
    expect(PUSH_URLS.jobs).toBe('/jobs');
  });
});
