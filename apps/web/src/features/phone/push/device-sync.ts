import type { PushDevice } from '@studio/shared';
import type { PushApi } from './push-api';
import type { PushRegistrationLike } from './push-browser';

/**
 * Brings the engine and this phone back in step as the app opens (notifications allowed). The
 * subscription is what counts; the stored device id follows it:
 *
 * - No subscription (the push service or iOS dropped it): the stored device is forgotten, here
 *   and on the engine, so Settings offers Turn on again. Answers `null`.
 * - A subscription: it is registered again (`POST`; the engine answers with the device it has
 *   for that endpoint, or a new one). When that is not the stored device (the service worker
 *   re-subscribed while the app was closed, see `pushsubscriptionchange` in public/sw.js, or the
 *   stored id was lost), the stored device's switches are carried over and it is forgotten.
 *   Answers the device.
 */
export async function syncPushDevice(deps: {
  registration: PushRegistrationLike;
  storedId: string | null;
  api: Pick<PushApi, 'registerDevice' | 'getDevice' | 'updateDevice' | 'deleteDevice'>;
}): Promise<PushDevice | null> {
  const { api, storedId } = deps;
  const subscription = await deps.registration.pushManager.getSubscription();
  if (subscription === null) {
    if (storedId !== null) await api.deleteDevice(storedId).catch(() => undefined);
    return null;
  }

  const device = await api.registerDevice(subscription.toJSON());
  if (storedId === null || storedId === device.id) return device;

  // Another device was this phone's: keep its switches, then forget it.
  const before = await api.getDevice(storedId).catch(() => null);
  if (before === null) return device;
  const carried = await api.updateDevice(device.id, before.events).catch(() => device);
  await api.deleteDevice(storedId).catch(() => undefined);
  return carried;
}
