// Typed fetch wrappers for web push (Mobile plan §6), one per route of `PUSH_ROUTES`, built like
// api.ts's: every answer is parsed with the shared schemas, and every failure is an `ApiError`
// carrying the engine's words. The engine side is PH11; this is the phone's (PH12).

import {
  PUSH_ROUTES,
  type PushDevice,
  type PushEventsPatch,
  pushDeviceSchema,
  pushKeyResponseSchema,
} from '@studio/shared';
import { ApiError, createJsonClient, type JsonClientOptions } from '@/data/api';

/** The subscription as the browser gives it (`PushSubscription.toJSON()`). */
export interface PushSubscriptionJson {
  endpoint?: string;
  keys?: Record<string, string>;
}

export interface PushApi {
  /** `GET /api/push/key`: the VAPID public key (base64url). 503 when the engine has no usable keys. */
  getKey(signal?: AbortSignal): Promise<string>;
  /**
   * `POST /api/push/devices`: registers this phone's subscription and answers with its device. A
   * subscription the engine knows keeps its id and switches.
   */
  registerDevice(subscription: PushSubscriptionJson, signal?: AbortSignal): Promise<PushDevice>;
  /** `GET /api/push/devices/:id`: the device, or `null` when the engine no longer has it (404). */
  getDevice(id: string, signal?: AbortSignal): Promise<PushDevice | null>;
  /** `PUT /api/push/devices/:id`: changes the switches named. 404 for a device that is gone. */
  updateDevice(id: string, events: PushEventsPatch, signal?: AbortSignal): Promise<PushDevice>;
  /** `DELETE /api/push/devices/:id`: forgets the device (also when it was gone already). */
  deleteDevice(id: string, signal?: AbortSignal): Promise<void>;
  /**
   * `POST /api/push/devices/:id/test`: sends "Test from Studio Engine" to this phone. 404 unknown
   * device, 410 the subscription is gone (the engine deleted the device), 502 the push service
   * refused it.
   */
  sendTest(id: string, signal?: AbortSignal): Promise<void>;
}

function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
}

export function createPushApi(options: JsonClientOptions = {}): PushApi {
  const { request, parse } = createJsonClient(options);

  return {
    async getKey(signal) {
      return parse(pushKeyResponseSchema, await request(PUSH_ROUTES.key, { signal })).publicKey;
    },
    async registerDevice(subscription, signal) {
      const answer = await request(PUSH_ROUTES.devices, jsonInit('POST', subscription, signal));
      return parse(pushDeviceSchema, answer);
    },
    async getDevice(id, signal) {
      try {
        return parse(pushDeviceSchema, await request(PUSH_ROUTES.device(id), { signal }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    async updateDevice(id, events, signal) {
      const answer = await request(PUSH_ROUTES.device(id), jsonInit('PUT', { events }, signal));
      return parse(pushDeviceSchema, answer);
    },
    async deleteDevice(id, signal) {
      await request(PUSH_ROUTES.device(id), { method: 'DELETE', signal });
    },
    async sendTest(id, signal) {
      await request(PUSH_ROUTES.test(id), { method: 'POST', signal });
    },
  };
}

/** The app's push client: same origin. Tests build their own with `createPushApi`. */
export const pushApi: PushApi = createPushApi();
