// The phone's side of web push (Mobile plan §6, PH11), mounted at /api/push:
//
//   GET    /key                 { publicKey }: the VAPID key to subscribe with. 503 when the keys
//                               cannot be made or read (push.json).
//   POST   /devices             Registers the browser's push subscription (PushSubscription.toJSON()).
//                               A known endpoint keeps its id and switches. 201 (new) or 200, with
//                               the PushDevice; the label comes from the User-Agent.
//   GET    /devices/:id         The PushDevice, so the Settings section can show its switches. 404
//                               once the device is gone (the phone drops it when it unsubscribes).
//   PUT    /devices/:id         { events: { review?, failed?, approved?, queueEmpty?, badge? } }: the
//                               switches named change, the others stay. Answers the PushDevice.
//   DELETE /devices/:id         Forgets the device. 204, also when there was none.
//   POST   /devices/:id/test    Sends "Test from Studio Engine" to that device, whatever its switches
//                               say. 204; 404 unknown device; 410 the phone dropped its subscription
//                               (the device is deleted); 502 the push service did not take it.
//
// The subscription (endpoint and keys) goes in and never comes back out.
//
// Whose devices (Team plan, TM2): a device belongs to the login that registered it. The admin may
// use every device. An editor may register their own phone and read, change, delete and test only
// the devices they registered; any other device id is a 404 for them, as if it were not there. A
// device registered before the team existed has no owner and is the admin's. An editor who
// registers the endpoint of a device that is someone else's gets a 409 and changes nothing.

import {
  type ApiError,
  type PushKeyResponse,
  pushDeviceUpdateSchema,
  pushSubscriptionSchema,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import {
  PushDeviceOwnedError,
  type PushDeviceRepository,
  type StoredPushDevice,
  toPushDevice,
} from '../db/index.js';
import { deviceLabelFromUserAgent } from '../push/device-label.js';
import type { PushService } from '../push/push-service.js';
import { VapidKeysError } from '../push/vapid-keys.js';
import { viewerOf } from '../team/viewer-scope.js';

export interface PushRouteOptions {
  devices: Pick<PushDeviceRepository, 'register' | 'get' | 'setEvents' | 'remove'>;
  push: Pick<PushService, 'sendTest'>;
  /** The VAPID public key. Throws `VapidKeysError` when the keys cannot be made or read. */
  publicKey: () => string;
}

const error = (message: string): ApiError => ({ error: message });

const NO_SUCH_DEVICE = 'No such device.';

/** Whether the viewer may use this device: the admin any, an editor their own. Routes mounted alone have no viewer. */
function mayUse(c: Context, device: StoredPushDevice): boolean {
  const viewer = viewerOf(c);
  return viewer === undefined || viewer.role === 'admin' || device.owner === viewer.email;
}

export function createPushRoutes({ devices, push, publicKey }: PushRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/key', (c) => {
    try {
      const body: PushKeyResponse = { publicKey: publicKey() };
      return c.json(body);
    } catch (err) {
      if (err instanceof VapidKeysError) {
        return c.json(error(`Notifications are not available: ${err.message}`), 503);
      }
      throw err;
    }
  });

  routes.post('/devices', async (c) => {
    const badBody = error(
      'Send the subscription as JSON: { "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } }.',
    );
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(badBody, 400);
    }
    const parsed = pushSubscriptionSchema.safeParse(body);
    if (!parsed.success) return c.json(badBody, 400);

    const viewer = viewerOf(c);
    try {
      const { device, created } = devices.register({
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        label: deviceLabelFromUserAgent(c.req.header('user-agent')),
        ...(viewer === undefined ? {} : { owner: viewer.email, admin: viewer.role === 'admin' }),
      });
      return c.json(toPushDevice(device), created ? 201 : 200);
    } catch (err) {
      if (err instanceof PushDeviceOwnedError) return c.json(error(err.message), 409);
      throw err;
    }
  });

  routes.get('/devices/:id', (c) => {
    const device = devices.get(c.req.param('id'));
    if (device === null || !mayUse(c, device)) return c.json(error(NO_SUCH_DEVICE), 404);
    return c.json(toPushDevice(device));
  });

  routes.put('/devices/:id', async (c) => {
    const badBody = error(
      'Send the switches as JSON: { "events": { "review": true, "failed": true, "approved": true, "queueEmpty": false, "badge": true } }, any of them.',
    );
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(badBody, 400);
    }
    const parsed = pushDeviceUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json(badBody, 400);

    const id = c.req.param('id');
    const current = devices.get(id);
    if (current === null || !mayUse(c, current)) return c.json(error(NO_SUCH_DEVICE), 404);
    const device = devices.setEvents(id, parsed.data.events);
    if (device === null) return c.json(error(NO_SUCH_DEVICE), 404);
    return c.json(toPushDevice(device));
  });

  routes.delete('/devices/:id', (c) => {
    const id = c.req.param('id');
    const current = devices.get(id);
    // Someone else's device is not there for an editor; the admin's delete of an unknown id stays a 204.
    if (current !== null && !mayUse(c, current)) return c.json(error(NO_SUCH_DEVICE), 404);
    devices.remove(id);
    return c.body(null, 204);
  });

  routes.post('/devices/:id/test', async (c) => {
    const id = c.req.param('id');
    const current = devices.get(id);
    if (current !== null && !mayUse(c, current)) return c.json(error(NO_SUCH_DEVICE), 404);
    switch (await push.sendTest(id)) {
      case 'sent':
        return c.body(null, 204);
      case 'missing':
        return c.json(error(NO_SUCH_DEVICE), 404);
      case 'gone':
        return c.json(
          error('This phone is no longer subscribed. Turn notifications on again.'),
          410,
        );
      case 'failed':
        return c.json(error('The push service did not take the test. Try again in a moment.'), 502);
    }
  });

  return routes;
}
