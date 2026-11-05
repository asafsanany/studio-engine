import type { PushDevice } from '@studio/shared';
import type { PushApi } from './push-api';
import { type PushRegistrationLike, subscribeWith } from './push-browser';

/**
 * What a Turn on came to:
 * - `on`: allowed, subscribed and registered with the engine; `device` is this phone.
 * - `denied`: the person said Don't Allow. iOS does not ask again: it is changed in iOS Settings.
 * - `dismissed`: the question went away unanswered (`default`); nothing changed.
 * - `failed`: allowed, but subscribing or registering did not work; `message` says why.
 */
export type TurnOnResult =
  | { kind: 'on'; device: PushDevice }
  | { kind: 'denied' }
  | { kind: 'dismissed' }
  | { kind: 'failed'; message: string };

export interface TurnOnDeps {
  /** `Notification.requestPermission`. */
  requestPermission: () => Promise<string>;
  /** The service worker's registration once it is active (`navigator.serviceWorker.ready`). */
  registration: () => Promise<PushRegistrationLike>;
  /** The engine's key when it was fetched ahead (so the tap goes straight to subscribing). */
  publicKey?: string;
  api: Pick<PushApi, 'getKey' | 'registerDevice'>;
}

/** The words of a failure, for the line under the button. */
function reason(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.';
}

/**
 * Turns notifications on for this phone: asks for permission, subscribes with the engine's key
 * and registers the subscription (`POST /api/push/devices`). Call it straight from the tap's
 * handler: the permission question is the first thing it does, before any await, because iOS
 * asks only inside a tap.
 */
export async function turnOnNotifications(deps: TurnOnDeps): Promise<TurnOnResult> {
  let permission: string;
  try {
    permission = await deps.requestPermission();
  } catch (error) {
    return { kind: 'failed', message: reason(error) };
  }
  if (permission === 'denied') return { kind: 'denied' };
  if (permission !== 'granted') return { kind: 'dismissed' };

  try {
    const [publicKey, registration] = await Promise.all([
      deps.publicKey ?? deps.api.getKey(),
      deps.registration(),
    ]);
    const subscription = await subscribeWith(registration, publicKey);
    const device = await deps.api.registerDevice(subscription.toJSON());
    return { kind: 'on', device };
  } catch (error) {
    return { kind: 'failed', message: reason(error) };
  }
}
