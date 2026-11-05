// Studio Engine's service worker (Mobile plan §6, PH12). Plain JS at the root scope, registered
// only by the phone layout in the Home Screen app (features/phone/push/PhonePush.tsx), because iOS
// gives web push only to Home Screen apps (iOS 16.4 and later).
//
//   push                     shows the notification the engine sent ({ title, body, url, tag,
//                            badge? }, PH11) and sets the count on the app icon when it carries one
//   notificationclick        brings the app forward and opens the notification's address in it, or
//                            opens the app at that address when it is closed
//   pushsubscriptionchange   subscribes again, registers the new subscription with the engine, gives
//                            it the old one's switches and forgets the old one
//
// It has no fetch handler and keeps no offline cache: every request goes to the network as if it
// were not there. The page side talks to it with two messages (OPEN_MESSAGE, DEVICE_MESSAGE).
//
// Unit-tested in node with a fake `self` (src/features/phone/push/sw.test.ts): it touches nothing
// but `self` and the globals every worker has (URL, atob).

/** Sent to an open window: open this address in the app (`{ type, url }`). */
const OPEN_MESSAGE = 'studio-engine:open';
/** Sent to open windows after a new subscription: this phone's device is now `id`. */
const DEVICE_MESSAGE = 'studio-engine:device';

/** The notification's icon (iOS shows the app's own icon whatever this says). */
const ICON = '/icon-192.png';
/** What a push that can't be read shows. iOS needs every push to show something. */
const FALLBACK = { title: 'Studio Engine', body: '', url: '/jobs', tag: 'studio-engine' };

const KEY_ROUTE = '/api/push/key';
const DEVICES_ROUTE = '/api/push/devices';
const deviceRoute = (id) => `${DEVICES_ROUTE}/${encodeURIComponent(id)}`;

/** The push's JSON, with the fallback for whatever is missing or wrong in it. */
function readPayload(data) {
  let json = null;
  try {
    json = data ? data.json() : null;
  } catch {
    json = null;
  }
  const payload = json && typeof json === 'object' ? json : {};
  const text = (value, otherwise) =>
    typeof value === 'string' && value !== '' ? value : otherwise;
  return {
    title: text(payload.title, FALLBACK.title),
    body: typeof payload.body === 'string' ? payload.body : FALLBACK.body,
    // Only an address of this app: a path, never another site.
    url:
      typeof payload.url === 'string' &&
      payload.url.startsWith('/') &&
      !payload.url.startsWith('//')
        ? payload.url
        : FALLBACK.url,
    tag: text(payload.tag, FALLBACK.tag),
    badge: Number.isInteger(payload.badge) && payload.badge >= 0 ? payload.badge : undefined,
  };
}

/** Puts `count` on the app icon (0 clears it). Never fails: not every browser has a badge. */
async function setBadge(count) {
  const nav = self.navigator;
  try {
    if (count > 0 && typeof nav?.setAppBadge === 'function') await nav.setAppBadge(count);
    else if (count === 0 && typeof nav?.clearAppBadge === 'function') await nav.clearAppBadge();
  } catch {
    // No permission for a badge, or no badge at all: the notification still shows.
  }
}

async function showPush(payload) {
  const shown = self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    // A newer notification about the same job replaces the older one, and still alerts.
    renotify: true,
    icon: ICON,
    data: { url: payload.url },
  });
  const badge = payload.badge === undefined ? null : setBadge(payload.badge);
  await Promise.all([shown, badge]);
}

/** The address a notification opens: its own, or the jobs list. */
function urlOf(notification) {
  const url = notification?.data?.url;
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
    ? url
    : FALLBACK.url;
}

/** The windows of this app, the one in front first. */
async function appWindows() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows
    .filter((client) => new URL(client.url).origin === self.location.origin)
    .sort((a, b) => Number(b.focused === true) - Number(a.focused === true));
}

/**
 * Opens `url` in the app: an open window comes forward and is asked to go there (the page does
 * it with its router, so nothing reloads); with no window, the app opens at that address.
 */
async function openUrl(url) {
  const [open] = await appWindows();
  if (!open) {
    await self.clients.openWindow(new URL(url, self.location.origin).href);
    return;
  }
  try {
    await open.focus();
  } catch {
    // Focus is only allowed during the click; the page still gets the message.
  }
  open.postMessage({ type: OPEN_MESSAGE, url });
}

/** A request to the engine (same origin) with an optional JSON body: its status and JSON body. */
async function send(method, path, body) {
  const init = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await self.fetch(path, init);
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
  return {
    status: response.status,
    json: response.status === 204 ? null : await response.json(),
  };
}

/** A base64url string (the engine's VAPID key) as bytes, for `pushManager.subscribe`. */
function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The push service replaced this phone's subscription (or dropped it): subscribe again with the
 * same key, register the new subscription, carry the old device's switches over to the new one
 * and forget the old one, then tell open windows the new device's id. The old device is found by
 * registering the old subscription: the engine answers 200 with the device it already has for
 * that endpoint (201 means it had dropped it, and its switches are only the defaults).
 */
async function renewSubscription(oldSubscription, newSubscription) {
  let next = newSubscription;
  if (!next) {
    const key =
      oldSubscription?.options?.applicationServerKey ??
      base64UrlToBytes((await send('GET', KEY_ROUTE)).json.publicKey);
    next = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  }
  const device = (await send('POST', DEVICES_ROUTE, next.toJSON())).json;

  if (oldSubscription && oldSubscription.endpoint !== next.endpoint) {
    try {
      const old = await send('POST', DEVICES_ROUTE, oldSubscription.toJSON());
      if (old.json.id !== device.id) {
        if (old.status === 200) {
          await send('PUT', deviceRoute(device.id), { events: old.json.events });
        }
        await send('DELETE', deviceRoute(old.json.id));
      }
    } catch {
      // The new device keeps the default switches; the engine drops the old one on its next push.
    }
  }

  for (const client of await appWindows()) {
    client.postMessage({ type: DEVICE_MESSAGE, id: device.id });
  }
}

self.addEventListener('install', () => {
  // Nothing to cache: the new worker takes over at once.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil(showPush(readPayload(event.data)));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openUrl(urlOf(event.notification)));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(renewSubscription(event.oldSubscription ?? null, event.newSubscription ?? null));
});
