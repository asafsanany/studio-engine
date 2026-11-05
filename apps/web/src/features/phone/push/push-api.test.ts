import { DEFAULT_PUSH_EVENTS, type PushDevice } from '@studio/shared';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@/data/api';
import { BASE_URL } from '@/data/test-utils';
import { createPushApi } from './push-api';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createPushApi({ baseUrl: BASE_URL });

const DEVICE: PushDevice = {
  id: 'd 1',
  label: 'iPhone',
  events: { ...DEFAULT_PUSH_EVENTS },
  createdAt: '2026-10-22T10:00:00.000Z',
  lastOkAt: null,
};
const SUBSCRIPTION = {
  endpoint: 'https://push.example/1',
  keys: { p256dh: 'p', auth: 'a' },
};

describe('push api', () => {
  it('getKey answers the public key', async () => {
    server.use(
      http.get(`${BASE_URL}/api/push/key`, () => HttpResponse.json({ publicKey: 'BKey' })),
    );
    await expect(api.getKey()).resolves.toBe('BKey');
  });

  it('getKey carries the engine’s words when it has no keys (503)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/push/key`, () =>
        HttpResponse.json({ error: 'Notifications are not available: x' }, { status: 503 }),
      ),
    );
    await expect(api.getKey()).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'Notifications are not available: x',
    });
  });

  it('registerDevice posts the subscription as it is and answers the device', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE_URL}/api/push/devices`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(DEVICE, { status: 201 });
      }),
    );
    await expect(api.registerDevice(SUBSCRIPTION)).resolves.toEqual(DEVICE);
    expect(body).toEqual(SUBSCRIPTION);
  });

  it('getDevice answers the device, and null once the engine has dropped it (404)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/push/devices/d%201`, () => HttpResponse.json(DEVICE)),
      http.get(`${BASE_URL}/api/push/devices/gone`, () =>
        HttpResponse.json({ error: 'No such device.' }, { status: 404 }),
      ),
      http.get(`${BASE_URL}/api/push/devices/broken`, () =>
        HttpResponse.json({ error: 'Internal server error' }, { status: 500 }),
      ),
    );
    await expect(api.getDevice('d 1')).resolves.toEqual(DEVICE);
    await expect(api.getDevice('gone')).resolves.toBeNull();
    await expect(api.getDevice('broken')).rejects.toBeInstanceOf(ApiError);
  });

  it('updateDevice puts only the switches named', async () => {
    let body: unknown;
    server.use(
      http.put(`${BASE_URL}/api/push/devices/d%201`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...DEVICE, events: { ...DEVICE.events, failed: false } });
      }),
    );
    await expect(api.updateDevice('d 1', { failed: false })).resolves.toMatchObject({
      events: { failed: false },
    });
    expect(body).toEqual({ events: { failed: false } });
  });

  it('deleteDevice and sendTest take the engine’s 204, which has no body', async () => {
    server.use(
      http.delete(
        `${BASE_URL}/api/push/devices/d%201`,
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.post(
        `${BASE_URL}/api/push/devices/d%201/test`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    await expect(api.deleteDevice('d 1')).resolves.toBeUndefined();
    await expect(api.sendTest('d 1')).resolves.toBeUndefined();
  });

  it('sendTest carries why the test did not go: gone (410) or refused (502)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/push/devices/gone/test`, () =>
        HttpResponse.json(
          { error: 'This phone is no longer subscribed. Turn notifications on again.' },
          { status: 410 },
        ),
      ),
      http.post(`${BASE_URL}/api/push/devices/d1/test`, () =>
        HttpResponse.json(
          { error: 'The push service did not take the test. Try again in a moment.' },
          { status: 502 },
        ),
      ),
    );
    await expect(api.sendTest('gone')).rejects.toMatchObject({
      status: 410,
      message: 'This phone is no longer subscribed. Turn notifications on again.',
    });
    await expect(api.sendTest('d1')).rejects.toMatchObject({ status: 502 });
  });
});
