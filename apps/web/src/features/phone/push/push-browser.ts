// What the browser offers for web push, and the few calls into it, behind small interfaces so the
// rules are tested with plain objects (Mobile plan §6, PH12). iOS gives web push only to a Home
// Screen app, on iOS 16.4 and later, and asks for permission only inside a tap.

import { type InstallCardWindow, isStandalone } from '../install-card';

/** The address of the service worker (public/sw.js), registered at the root scope. */
export const SERVICE_WORKER_URL = '/sw.js';

/** The messages the service worker sends to the page (keep in step with public/sw.js). */
export const SW_OPEN_MESSAGE = 'studio-engine:open';
export const SW_DEVICE_MESSAGE = 'studio-engine:device';

/**
 * Where this window stands for notifications:
 * - `browser`: a browser tab, not the Home Screen app. iOS has no web push there, so the app
 *   neither registers its service worker nor offers notifications.
 * - `unsupported`: the Home Screen app, but without web push (iOS before 16.4).
 * - `supported`: the Home Screen app with service workers, push and notifications.
 */
export type PushSupport = 'browser' | 'unsupported' | 'supported';

/** `Notification.permission`; `default` is "not asked yet". */
export type Permission = 'default' | 'granted' | 'denied';

/** The subscription calls used here (`PushSubscription`). */
export interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

/** The registration calls used here (`ServiceWorkerRegistration`). */
export interface PushRegistrationLike {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<PushSubscriptionLike>;
  };
}

/** The slice of `window` the push code reads, so tests pass a plain object. */
export interface PushWindow extends InstallCardWindow {
  navigator: InstallCardWindow['navigator'] & {
    serviceWorker?: unknown;
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  Notification?: {
    readonly permission: string;
    requestPermission(): Promise<string>;
  };
  PushManager?: unknown;
}

/** Where `win` stands for notifications; see {@link PushSupport}. */
export function pushSupport(win: PushWindow): PushSupport {
  if (!isStandalone(win)) return 'browser';
  const supported =
    win.navigator.serviceWorker !== undefined &&
    win.PushManager !== undefined &&
    win.Notification !== undefined;
  return supported ? 'supported' : 'unsupported';
}

/** The notification permission; `default` where there is no `Notification` at all. */
export function notificationPermission(win: PushWindow): Permission {
  const permission = win.Notification?.permission;
  return permission === 'granted' || permission === 'denied' ? permission : 'default';
}

/** A base64url string (the engine's VAPID key) as bytes, for `pushManager.subscribe`. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether a subscription's key is `key`. A browser that does not say counts as the same. */
export function sameKey(current: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (current === null || current === undefined) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
}

/**
 * This phone's subscription for `publicKey`: the one it has when it was made with that key,
 * otherwise a new one (an old one made with another key is dropped first, or `subscribe` throws).
 */
export async function subscribeWith(
  registration: PushRegistrationLike,
  publicKey: string,
): Promise<PushSubscriptionLike> {
  const key = base64UrlToBytes(publicKey);
  const existing = await registration.pushManager.getSubscription();
  if (existing !== null) {
    if (sameKey(existing.options?.applicationServerKey, key)) return existing;
    await existing.unsubscribe();
  }
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** The browser's `window` as a {@link PushWindow}, or `null` where there is none (tests). */
export function browserWindow(): PushWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as PushWindow);
}
