/// <reference types="node" />
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { SERVICE_WORKER_URL, SW_DEVICE_MESSAGE, SW_OPEN_MESSAGE } from './push-browser';

// public/sw.js is plain JS for the browser, so it is run here as it is, in a context of its own
// whose only globals are a fake `self` (what a worker sees) and the few builtins a worker has
// (URL, atob). Events are dispatched to the listeners it adds, and their `waitUntil` awaited.

const SOURCE = readFileSync(
  new URL(`../../../../public${SERVICE_WORKER_URL}`, import.meta.url),
  'utf8',
);
const ORIGIN = 'https://mac.tail1234.ts.net';

interface FakeWindow {
  url: string;
  focused?: boolean;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function appWindow(path: string, focused = false): FakeWindow {
  return {
    url: `${ORIGIN}${path}`,
    focused,
    focus: vi.fn(async () => undefined),
    postMessage: vi.fn(),
  };
}

interface Answer {
  status: number;
  body?: unknown;
}

/** A fake subscription: `toJSON` is what the engine receives. */
function subscription(endpoint: string, key: number[] | null = [1, 2, 3]) {
  return {
    endpoint,
    options: { applicationServerKey: key === null ? null : new Uint8Array(key).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
  };
}

/** Loads the worker with a fake `self`. `answers` answers its requests by "METHOD path". */
function loadWorker(
  options: {
    windows?: FakeWindow[];
    answers?: Record<string, Answer | ((body: unknown) => Answer)>;
    badges?: boolean;
    subscribe?: (opts: { applicationServerKey: Uint8Array }) => unknown;
  } = {},
) {
  const listeners = new Map<string, (event: unknown) => void>();
  const requests: { method: string; path: string; body: unknown }[] = [];
  const windows = options.windows ?? [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    registration: {
      showNotification: vi.fn(async () => undefined),
      pushManager: {
        subscribe: vi.fn(
          async (opts: { applicationServerKey: Uint8Array }) =>
            options.subscribe?.(opts) ?? subscription('https://push.example/new'),
        ),
      },
    },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
    navigator:
      options.badges === false
        ? {}
        : {
            setAppBadge: vi.fn(async () => undefined),
            clearAppBadge: vi.fn(async () => undefined),
          },
    fetch: vi.fn(async (path: string, init: { method: string; body?: string }) => {
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      requests.push({ method: init.method, path, body });
      const found = options.answers?.[`${init.method} ${path}`];
      const answer = typeof found === 'function' ? found(body) : (found ?? { status: 404 });
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body,
      };
    }),
  };
  vm.runInNewContext(SOURCE, { self, URL, atob });

  /** Dispatches an event the way the browser does and waits for what it handed to waitUntil. */
  async function dispatch(type: string, event: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    const listener = listeners.get(type);
    if (!listener) throw new Error(`no ${type} listener`);
    listener({ ...event, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
  }

  return { self, listeners, requests, dispatch };
}

/** A push event's data, as `PushMessageData`. */
const data = (payload: unknown) => ({ json: () => payload });

const device = (
  id: string,
  events = { review: true, failed: true, approved: true, queueEmpty: false, badge: true },
) => ({
  id,
  label: 'iPhone',
  events,
  createdAt: '2026-10-22T10:00:00.000Z',
  lastOkAt: null,
});

describe('public/sw.js', () => {
  it('listens for install, activate, push, notificationclick and pushsubscriptionchange, and never for fetch', () => {
    const { listeners } = loadWorker();
    expect([...listeners.keys()].sort()).toEqual([
      'activate',
      'install',
      'notificationclick',
      'push',
      'pushsubscriptionchange',
    ]);
    expect(listeners.has('fetch')).toBe(false);
  });

  it('takes over at once: skipWaiting on install, clients.claim on activate', async () => {
    const { self, dispatch } = loadWorker();
    await dispatch('install');
    expect(self.skipWaiting).toHaveBeenCalled();
    await dispatch('activate');
    expect(self.clients.claim).toHaveBeenCalled();
  });

  it('sends the page the same messages the page listens for', () => {
    expect(SOURCE).toContain(`'${SW_OPEN_MESSAGE}'`);
    expect(SOURCE).toContain(`'${SW_DEVICE_MESSAGE}'`);
  });
});

describe('push', () => {
  it('shows the title, body, tag and icon, keeps the address, and puts the badge on the icon', async () => {
    const { self, dispatch } = loadWorker();
    await dispatch('push', {
      data: data({
        title: 'Ready to review',
        body: 'סיור בפרויקט · LAKESHORE',
        url: '/jobs?job=j1&review=1',
        tag: 'j1',
        badge: 3,
      }),
    });
    expect(self.registration.showNotification).toHaveBeenCalledWith('Ready to review', {
      body: 'סיור בפרויקט · LAKESHORE',
      tag: 'j1',
      renotify: true,
      icon: '/icon-192.png',
      data: { url: '/jobs?job=j1&review=1' },
    });
    expect(self.navigator.setAppBadge).toHaveBeenCalledWith(3);
    expect(self.navigator.clearAppBadge).not.toHaveBeenCalled();
  });

  it('clears the badge at 0 and leaves it alone when the push carries none', async () => {
    const zero = loadWorker();
    await zero.dispatch('push', {
      data: data({ title: 'Queue is empty', body: '', url: '/jobs', tag: 'queue-empty', badge: 0 }),
    });
    expect(zero.self.navigator.clearAppBadge).toHaveBeenCalled();
    expect(zero.self.navigator.setAppBadge).not.toHaveBeenCalled();

    const none = loadWorker();
    await none.dispatch('push', {
      data: data({ title: 'Failed at Render', body: 'a · b', url: '/jobs?job=j2', tag: 'j2' }),
    });
    expect(none.self.registration.showNotification).toHaveBeenCalled();
    expect(none.self.navigator.setAppBadge).not.toHaveBeenCalled();
    expect(none.self.navigator.clearAppBadge).not.toHaveBeenCalled();
  });

  it('still shows the notification where there is no badge, or the badge is refused', async () => {
    const without = loadWorker({ badges: false });
    await without.dispatch('push', {
      data: data({ title: 'Ready to review', body: 'x', url: '/jobs', tag: 't', badge: 2 }),
    });
    expect(without.self.registration.showNotification).toHaveBeenCalled();

    const refused = loadWorker();
    refused.self.navigator.setAppBadge?.mockRejectedValueOnce(new Error('NotAllowedError'));
    await refused.dispatch('push', {
      data: data({ title: 'Ready to review', body: 'x', url: '/jobs', tag: 't', badge: 2 }),
    });
    expect(refused.self.registration.showNotification).toHaveBeenCalled();
  });

  it('shows something for a push it cannot read, and never opens another site', async () => {
    const { self, dispatch } = loadWorker();
    await dispatch('push', {
      data: {
        json: () => {
          throw new SyntaxError('not JSON');
        },
      },
    });
    await dispatch('push', {});
    await dispatch('push', {
      data: data({ title: '', url: 'https://example.com/x', tag: '', badge: -1 }),
    });
    await dispatch('push', { data: data({ title: 'Hi', url: '//example.com/x', tag: 't' }) });
    const calls = self.registration.showNotification.mock.calls as unknown as [
      string,
      { body: string; tag: string; data: { url: string } },
    ][];
    expect(calls.map(([title, o]) => [title, o.body, o.tag, o.data.url])).toEqual([
      ['Studio Engine', '', 'studio-engine', '/jobs'],
      ['Studio Engine', '', 'studio-engine', '/jobs'],
      ['Studio Engine', '', 'studio-engine', '/jobs'],
      ['Hi', '', 't', '/jobs'],
    ]);
    expect(self.navigator.setAppBadge).not.toHaveBeenCalled();
  });
});

describe('notificationclick', () => {
  const click = (url?: unknown) => {
    const notification = { data: url === undefined ? undefined : { url }, close: vi.fn() };
    return { notification };
  };

  it('closes the notification, brings the open app forward and hands it the address', async () => {
    const jobs = appWindow('/jobs');
    const { self, dispatch } = loadWorker({ windows: [jobs] });
    const event = click('/jobs?job=j1&review=1');
    await dispatch('notificationclick', event);
    expect(event.notification.close).toHaveBeenCalled();
    expect(jobs.focus).toHaveBeenCalled();
    expect(jobs.postMessage).toHaveBeenCalledWith({
      type: SW_OPEN_MESSAGE,
      url: '/jobs?job=j1&review=1',
    });
    expect(self.clients.openWindow).not.toHaveBeenCalled();
    expect(self.clients.matchAll).toHaveBeenCalledWith({
      type: 'window',
      includeUncontrolled: true,
    });
  });

  it('picks the window in front, and never a window of another site', async () => {
    const other = { ...appWindow('/x', true), url: 'https://example.com/x' };
    const back = appWindow('/settings');
    const front = appWindow('/jobs', true);
    const { dispatch } = loadWorker({ windows: [other, back, front] });
    await dispatch('notificationclick', click('/jobs?job=j2'));
    expect(front.postMessage).toHaveBeenCalledWith({ type: SW_OPEN_MESSAGE, url: '/jobs?job=j2' });
    expect(back.postMessage).not.toHaveBeenCalled();
    expect(other.postMessage).not.toHaveBeenCalled();
  });

  it('still hands over the address when focus is refused', async () => {
    const jobs = appWindow('/jobs');
    jobs.focus.mockRejectedValueOnce(new Error('InvalidAccessError'));
    const { dispatch } = loadWorker({ windows: [jobs] });
    await dispatch('notificationclick', click('/jobs'));
    expect(jobs.postMessage).toHaveBeenCalledWith({ type: SW_OPEN_MESSAGE, url: '/jobs' });
  });

  it('opens the app at the address when it is closed', async () => {
    const { self, dispatch } = loadWorker({ windows: [] });
    await dispatch('notificationclick', click('/jobs?job=j3'));
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/jobs?job=j3`);
  });

  it('opens the jobs list for a notification without a usable address', async () => {
    const { self, dispatch } = loadWorker({ windows: [] });
    await dispatch('notificationclick', click('https://example.com/'));
    await dispatch('notificationclick', click());
    expect(self.clients.openWindow.mock.calls).toEqual([[`${ORIGIN}/jobs`], [`${ORIGIN}/jobs`]]);
  });
});

describe('pushsubscriptionchange', () => {
  it('registers the new subscription, carries the old device’s switches over and forgets it', async () => {
    const jobs = appWindow('/jobs');
    const quiet = { review: true, failed: false, approved: true, queueEmpty: true, badge: false };
    const { requests, dispatch } = loadWorker({
      windows: [jobs],
      answers: {
        'POST /api/push/devices': (body) =>
          (body as { endpoint: string }).endpoint === 'https://push.example/old'
            ? { status: 200, body: device('old', quiet) }
            : { status: 201, body: device('new') },
        'PUT /api/push/devices/new': { status: 200, body: device('new', quiet) },
        'DELETE /api/push/devices/old': { status: 204 },
      },
    });
    await dispatch('pushsubscriptionchange', {
      oldSubscription: subscription('https://push.example/old'),
      newSubscription: subscription('https://push.example/new'),
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/push/devices',
        body: { endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } },
      },
      {
        method: 'POST',
        path: '/api/push/devices',
        body: { endpoint: 'https://push.example/old', keys: { p256dh: 'p', auth: 'a' } },
      },
      { method: 'PUT', path: '/api/push/devices/new', body: { events: quiet } },
      { method: 'DELETE', path: '/api/push/devices/old', body: undefined },
    ]);
    expect(jobs.postMessage).toHaveBeenCalledWith({ type: SW_DEVICE_MESSAGE, id: 'new' });
  });

  it('subscribes again with the old subscription’s key when the browser gives no new one', async () => {
    const { self, requests, dispatch } = loadWorker({
      answers: {
        'POST /api/push/devices': (body) =>
          (body as { endpoint: string }).endpoint === 'https://push.example/old'
            ? { status: 201, body: device('dropped') }
            : { status: 201, body: device('new') },
        'DELETE /api/push/devices/dropped': { status: 204 },
      },
    });
    await dispatch('pushsubscriptionchange', {
      oldSubscription: subscription('https://push.example/old', [9, 8, 7]),
    });
    const [[opts]] = self.registration.pushManager.subscribe.mock.calls as unknown as [
      [{ userVisibleOnly: boolean; applicationServerKey: ArrayBuffer }],
    ];
    expect(opts.userVisibleOnly).toBe(true);
    expect([...new Uint8Array(opts.applicationServerKey)]).toEqual([9, 8, 7]);
    // The engine had dropped the old one already (201): its switches are only the defaults, so
    // nothing is carried over; the row it just made for it is deleted.
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/push/devices',
      'POST /api/push/devices',
      'DELETE /api/push/devices/dropped',
    ]);
  });

  it('asks the engine for its key when there is no old subscription either', async () => {
    const { self, requests, dispatch } = loadWorker({
      answers: {
        // "AQID" is base64url for the bytes 1, 2, 3; "-_8" for 251, 255.
        'GET /api/push/key': { status: 200, body: { publicKey: 'AQID-_8' } },
        'POST /api/push/devices': { status: 201, body: device('new') },
      },
    });
    await dispatch('pushsubscriptionchange', {});
    const [[opts]] = self.registration.pushManager.subscribe.mock.calls as unknown as [
      [{ applicationServerKey: Uint8Array }],
    ];
    expect([...opts.applicationServerKey]).toEqual([1, 2, 3, 251, 255]);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/push/key',
      'POST /api/push/devices',
    ]);
  });

  it('keeps the new device with the defaults when the old one cannot be looked up', async () => {
    const jobs = appWindow('/jobs');
    const { requests, dispatch } = loadWorker({
      windows: [jobs],
      answers: {
        'POST /api/push/devices': (body) =>
          (body as { endpoint: string }).endpoint === 'https://push.example/old'
            ? { status: 400, body: { error: 'bad' } }
            : { status: 201, body: device('new') },
      },
    });
    await dispatch('pushsubscriptionchange', {
      oldSubscription: subscription('https://push.example/old'),
      newSubscription: subscription('https://push.example/new'),
    });
    expect(requests.map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(jobs.postMessage).toHaveBeenCalledWith({ type: SW_DEVICE_MESSAGE, id: 'new' });
  });

  it('looks nothing up when the endpoint did not change', async () => {
    const { requests, dispatch } = loadWorker({
      answers: { 'POST /api/push/devices': { status: 200, body: device('same') } },
    });
    await dispatch('pushsubscriptionchange', {
      oldSubscription: subscription('https://push.example/same'),
      newSubscription: subscription('https://push.example/same'),
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/push/devices']);
  });
});
