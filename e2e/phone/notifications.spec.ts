// PH12: notifications on the phone, on the built server with the fake runner, in Chrome at the
// boards' size (390×844, touch, an iPhone user agent; the `phone` project of playwright.config.ts).
// Chrome can't be started as a Home Screen app, so the page is told it is one
// (`navigator.standalone`), and the browser's permission question and push subscription are
// mocked: `Notification.requestPermission` answers as the test says, and `pushManager.subscribe`
// hands back a subscription whose endpoint is a closed port on this Mac (127.0.0.1:9), so the
// engine's pushes go nowhere. Everything else is real: the engine's key and device routes, the
// service worker (public/sw.js, registered and active), the Settings switches saved on the engine.
//
//   Turn on       the Jobs card (board MTurnOn) asks inside the tap, subscribes with the engine's
//                 65-byte key and registers this phone; Settings (board MSettings) then shows a
//                 switch per event, each saved on the engine, and "Send a test"
//   Not now       remembered; Settings keeps "Turn on", which works the same
//   a refusal     the card says once how to allow notifications in iOS Settings; Settings too
//   a tap         a notification's address opens the job's sheet (a job in Review gets its Review
//                 over it, see push-delivery.spec.ts), from a cold open and from the service
//                 worker's message to an open app; the app icon counts Review + Needs attention
//                 while the app is open
//   the worker    a push delivered to the real service worker shows its title, body and tag
//
// The screenshots are attached to the report, and written to $PHONE_SHOTS_DIR when it is set.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({ viewport: { width: 390, height: 844 } });

/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
/** The localStorage keys of the push code (push-store.ts). */
const DEVICE_KEY = 'studio.push.deviceId.v1';
const CARD_KEY = 'studio.notifyCard.v1';

const CARD = '[data-slot="notify-card"]';
const SETTINGS = '[data-slot="phone-settings-page"]';
const SHEET = '[data-slot="phone-job-sheet"]';

/** A valid-looking subscription's keys: a 65-byte P-256 point and a 16-byte secret. */
const P256DH = Buffer.alloc(65, 4).toString('base64url');
const AUTH = Buffer.alloc(16, 7).toString('base64url');

let engine: Engine;
let version: string;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 1_000, fakeSpeed: 10, review: false, phone: true });
  version = ((await (await fetch(`${engine.baseURL}/api/health`)).json()) as { version: string })
    .version;
});

test.afterAll(async () => {
  await engine?.stop();
});

interface MockOptions {
  /** What the permission question answers. */
  answer?: 'granted' | 'denied';
  /** The permission before anything is asked. */
  permission?: 'default' | 'granted';
}

/**
 * Opens `path` as the Home Screen app with the push mocks of the header, and returns the page's
 * errors so far, which every test expects to be none. The mocks keep their state in localStorage
 * (keys `e2e.push.*`), so a reload is the same phone.
 */
async function openApp(
  page: Page,
  path: string,
  testInfo: TestInfo,
  { answer = 'granted', permission = 'default' }: MockOptions = {},
): Promise<string[]> {
  // A closed port on this Mac: a push the engine tries goes nowhere. One endpoint per test.
  const endpoint = `https://127.0.0.1:9/e2e-push/${testInfo.testId}`;
  await page.addInitScript(
    ({ endpoint, p256dh, auth, answer, permission, seenKey, version }) => {
      localStorage.setItem(seenKey, version);
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });

      const key = (name: string) => `e2e.push.${name}`;
      const get = (name: string) => localStorage.getItem(key(name));
      const set = (name: string, value: string) => localStorage.setItem(key(name), value);
      if (get('answer') === null) set('answer', answer);
      if (get('permission') === null) set('permission', permission);

      // All the app reads of `Notification`: the permission and the question.
      const FakeNotification = {
        get permission() {
          return get('permission') ?? 'default';
        },
        requestPermission(): Promise<string> {
          set('asked', String(Number(get('asked') ?? '0') + 1));
          const reply = get('answer') ?? 'granted';
          set('permission', reply);
          return Promise.resolve(reply);
        },
      };
      Object.defineProperty(window, 'Notification', {
        value: FakeNotification,
        configurable: true,
        writable: true,
      });

      const subscription = () => ({
        endpoint,
        expirationTime: null,
        options: { applicationServerKey: null, userVisibleOnly: true },
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        unsubscribe: async () => {
          set('subscribed', '0');
          return true;
        },
      });
      PushManager.prototype.getSubscription = async () =>
        (get('subscribed') === '1' ? subscription() : null) as unknown as PushSubscription;
      PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
        const bytes = new Uint8Array(options?.applicationServerKey as ArrayBuffer);
        set('keyBytes', String(bytes.length));
        set('userVisibleOnly', String(options?.userVisibleOnly));
        set('subscribed', '1');
        return subscription() as unknown as PushSubscription;
      };

      const badges: number[] = [];
      (window as unknown as { e2eBadges: number[] }).e2eBadges = badges;
      navigator.setAppBadge = async (count?: number) => {
        badges.push(count ?? 0);
      };
      navigator.clearAppBadge = async () => {
        badges.push(0);
      };
    },
    {
      endpoint,
      p256dh: P256DH,
      auth: AUTH,
      answer,
      permission,
      seenKey: LAST_SEEN_KEY,
      version,
    },
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  return pageErrors;
}

/** A value the mocks keep (`e2e.push.<name>`) or the app keeps (a full key). */
const stored = (page: Page, key: string) =>
  page.evaluate((name) => localStorage.getItem(name), key);
const mock = (page: Page, name: string) => stored(page, `e2e.push.${name}`);

interface DeviceOnServer {
  id: string;
  label: string;
  events: Record<string, boolean>;
}

async function deviceOnServer(id: string): Promise<DeviceOnServer | null> {
  const response = await fetch(`${engine.baseURL}/api/push/devices/${encodeURIComponent(id)}`);
  return response.status === 404 ? null : ((await response.json()) as DeviceOnServer);
}

/** Attaches the page as a screenshot to the report, and writes it to $PHONE_SHOTS_DIR if set. */
async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const body = await page.screenshot();
  await testInfo.attach(`${name}-390x844.png`, { body, contentType: 'image/png' });
  const dir = process.env.PHONE_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}-390x844.png`), body);
  }
}

/** The switch of the Settings row named `label`. */
const switchOf = (page: Page, label: string) =>
  page.locator(SETTINGS).getByRole('switch', { name: new RegExp(`^${label}`) });

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('Turn on', () => {
  test('the Jobs card asks in the tap, subscribes with the engine’s key and registers this phone', async ({
    page,
  }, testInfo) => {
    const pageErrors = await openApp(page, '/jobs', testInfo);
    const card = page.locator(CARD);
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Turn on notifications' })).toBeVisible();
    await expect(card).toContainText(
      'Get a notification when an edit is ready to review, when a job fails and when a final video is ready to send. You can pick which ones in Settings.',
    );
    for (const name of ['Not now', 'Turn on']) {
      const box = await card.getByRole('button', { name }).boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    }
    // Under the Jobs title, as the Add to Home Screen card sits in a browser tab.
    const title = await page.getByRole('heading', { name: 'Jobs', exact: true }).boundingBox();
    const cardBox = await card.boundingBox();
    expect((cardBox?.y ?? 0) >= (title?.y ?? 0) + (title?.height ?? 0)).toBe(true);
    // The Add to Home Screen card is not shown in the Home Screen app.
    await expect(page.locator('[data-slot="install-card"]')).toHaveCount(0);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    // The service worker is registered at the root and active before anything is asked.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration('/');
          return registration?.active?.scriptURL ?? null;
        }),
      )
      .toBe(`${engine.baseURL}/sw.js`);
    await shoot(page, testInfo, 'notify-card');

    await card.getByRole('button', { name: 'Turn on' }).click();
    await expect(card).toHaveCount(0);
    expect(await mock(page, 'asked')).toBe('1');
    expect(await mock(page, 'keyBytes')).toBe('65');
    expect(await mock(page, 'userVisibleOnly')).toBe('true');

    // The engine has this phone, with the default switches.
    const id = await stored(page, DEVICE_KEY);
    expect(id).toBeTruthy();
    const device = await deviceOnServer(id as string);
    expect(device).toMatchObject({
      label: 'iPhone',
      events: { review: true, failed: true, approved: true, queueEmpty: false, badge: true },
    });

    // The card does not come back.
    await page.reload();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('Settings shows a switch per event, saves each on the engine, and sends a test', async ({
    page,
  }, testInfo) => {
    const pageErrors = await openApp(page, '/jobs', testInfo);
    await page.locator(CARD).getByRole('button', { name: 'Turn on' }).click();
    await expect(page.locator(CARD)).toHaveCount(0);
    const id = (await stored(page, DEVICE_KEY)) as string;

    await page.getByRole('link', { name: 'Settings' }).click();
    const settings = page.locator(SETTINGS);
    const section = settings.locator('section', {
      has: page.getByRole('heading', { name: 'Notifications on this phone' }),
    });
    await expect(section).toBeVisible();
    await expect(section).toContainText('On');
    // Above "This phone", as the board has it.
    const sectionBox = await section.boundingBox();
    const thisPhone = await settings
      .getByRole('heading', { name: 'This phone', exact: true })
      .boundingBox();
    expect((sectionBox?.y ?? 0) < (thisPhone?.y ?? 0)).toBe(true);

    const expected = [
      ['Ready to review', 'true'],
      ['Failed', 'true'],
      ['Approved · ready to send', 'true'],
      ['Queue is empty', 'false'],
      ['Count on the app icon', 'true'],
    ];
    for (const [label, checked] of expected) {
      await expect(switchOf(page, label as string)).toHaveAttribute(
        'aria-checked',
        checked as string,
      );
    }
    await expect(section).toContainText('A job stopped with an error, a Claude usage limit too');
    // Each row is a 56 px target; the test button is 44 px.
    for (const row of await section.locator('label').all()) {
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(56);
    }
    const testButton = section.getByRole('button', { name: 'Send a test' });
    expect((await testButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await shoot(page, testInfo, 'notify-settings');

    // A tap anywhere on a row flips its switch, and the engine keeps it.
    await section.getByText('Everything you dropped in is done').click();
    await expect(switchOf(page, 'Queue is empty')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await deviceOnServer(id))?.events.queueEmpty).toBe(true);
    await switchOf(page, 'Failed').click();
    await expect(switchOf(page, 'Failed')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await deviceOnServer(id))?.events.failed).toBe(false);

    // A reload reads the switches back from the engine.
    await page.reload();
    await expect(switchOf(page, 'Queue is empty')).toHaveAttribute('aria-checked', 'true');
    await expect(switchOf(page, 'Failed')).toHaveAttribute('aria-checked', 'false');
    await expect(switchOf(page, 'Ready to review')).toHaveAttribute('aria-checked', 'true');

    // "Send a test" with the engine's own answer: its push goes to the closed port, so the push
    // service "refuses" it and the section says so.
    await section.getByRole('button', { name: 'Send a test' }).click();
    await expect(section.getByRole('alert')).toContainText(
      'The push service did not take the test. Try again in a moment.',
    );

    // The engine sent it (204, answered here so nothing is pushed): "Test sent to this phone" for
    // 2.5 s, then "Send a test" again.
    await page.route('**/api/push/devices/*/test', (route) => route.fulfill({ status: 204 }));
    await section.getByRole('button', { name: 'Send a test' }).click();
    const sent = section.getByRole('button', { name: 'Test sent to this phone' });
    await expect(sent).toBeVisible();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await shoot(page, testInfo, 'notify-settings-test-sent');
    const sentAt = Date.now();
    await expect(section.getByRole('button', { name: 'Send a test' })).toBeVisible({
      timeout: 5_000,
    });
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(1_500);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Not now and a refusal', () => {
  test('“Not now” is remembered; Settings keeps Turn on, which works the same', async ({
    page,
  }, testInfo) => {
    const pageErrors = await openApp(page, '/jobs', testInfo);
    const card = page.locator(CARD);
    await card.getByRole('button', { name: 'Not now' }).click();
    await expect(card).toHaveCount(0);
    expect(await stored(page, CARD_KEY)).toBe('dismissed');
    expect(await mock(page, 'asked')).toBeNull();
    await page.reload();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await expect(card).toHaveCount(0);

    await page.getByRole('link', { name: 'Settings' }).click();
    const section = page.locator(SETTINGS).locator('section', {
      has: page.getByRole('heading', { name: 'Notifications on this phone' }),
    });
    await expect(section).toContainText('Off');
    await expect(section).toContainText('Get a notification when a job needs you.');
    await expect(section.getByRole('switch')).toHaveCount(0);
    await shoot(page, testInfo, 'notify-settings-off');

    await section.getByRole('button', { name: 'Turn on' }).click();
    await expect(switchOf(page, 'Ready to review')).toHaveAttribute('aria-checked', 'true');
    await expect(section).toContainText('On');
    expect(await mock(page, 'asked')).toBe('1');
    expect(await deviceOnServer((await stored(page, DEVICE_KEY)) as string)).not.toBeNull();
    expect(pageErrors).toEqual([]);
  });

  test('a refusal: the card says once how to allow notifications in iOS Settings, and Settings says so too', async ({
    page,
  }, testInfo) => {
    const pageErrors = await openApp(page, '/jobs', testInfo, { answer: 'denied' });
    const card = page.locator(CARD);
    await card.getByRole('button', { name: 'Turn on' }).click();
    await expect(card.getByRole('heading', { name: 'Notifications are off' })).toBeVisible();
    await expect(card).toContainText(
      'open the iPhone’s Settings, tap Notifications, then Studio Engine, and turn on Allow Notifications.',
    );
    expect(await mock(page, 'subscribed')).toBeNull();
    expect(await stored(page, DEVICE_KEY)).toBeNull();
    await shoot(page, testInfo, 'notify-card-denied');

    await card.getByRole('button', { name: 'Got it' }).click();
    await expect(card).toHaveCount(0);
    // Said once: not again after a reload.
    await page.reload();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await expect(card).toHaveCount(0);

    await page.getByRole('link', { name: 'Settings' }).click();
    const section = page.locator(SETTINGS).locator('section', {
      has: page.getByRole('heading', { name: 'Notifications on this phone' }),
    });
    await expect(section).toContainText('Off');
    await expect(section).toContainText('turn on Allow Notifications');
    await expect(section.getByRole('button')).toHaveCount(0);
    await shoot(page, testInfo, 'notify-settings-denied');
    expect(pageErrors).toEqual([]);
  });
});

test.describe('a tapped notification and the app icon', () => {
  const CLIENT = 'Pings';
  const JOB = 'Failed early';
  let jobId: string;

  test.beforeAll(async () => {
    await engine.createJob({ client: CLIENT, job: JOB, failAt: 'plan' });
    await expect
      .poll(
        async () => {
          const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as {
            id: string;
            name: string;
            state: string;
          }[];
          const job = jobs.find((candidate) => candidate.name === JOB);
          if (job?.state === 'failed') jobId = job.id;
          return job?.state;
        },
        { timeout: 60_000 },
      )
      .toBe('failed');
  });

  test('“Ready to review”’s address opens the job’s sheet for a job no longer in Review, and is cleaned', async ({
    page,
  }, testInfo) => {
    const pageErrors = await openApp(page, `/jobs?job=${jobId}&review=1`, testInfo, {
      permission: 'granted',
    });
    await expect(page.locator(SHEET)).toBeVisible();
    await expect(page.locator(SHEET)).toContainText(JOB);
    await expect.poll(() => new URL(page.url()).search).toBe(`?job=${jobId}`);
    expect(pageErrors).toEqual([]);
  });

  test('the service worker’s message opens the address in the open app, without a reload', async ({
    page,
  }, testInfo) => {
    const pageErrors = await openApp(page, '/settings', testInfo, { permission: 'granted' });
    await expect(page.locator(SETTINGS)).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { notReloaded: boolean }).notReloaded = true;
    });
    // What public/sw.js posts on a notificationclick when the app is open.
    await page.evaluate((url) => {
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', { data: { type: 'studio-engine:open', url } }),
      );
    }, `/jobs?job=${jobId}`);
    await expect(page.locator(SHEET)).toBeVisible();
    await expect(page.locator(SHEET)).toContainText(JOB);
    expect(new URL(page.url()).pathname).toBe('/jobs');
    expect(
      await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded),
    ).toBe(true);
    // Another site's address is ignored.
    await page.evaluate(() => {
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'studio-engine:open', url: 'https://example.com/' },
        }),
      );
    });
    await page.waitForTimeout(300);
    expect(new URL(page.url()).origin).toBe(engine.baseURL);
    expect(pageErrors).toEqual([]);
  });

  test('while the app is open, the icon counts Review + Needs attention', async ({
    page,
  }, testInfo) => {
    const pageErrors = await openApp(page, '/jobs', testInfo, { permission: 'granted' });
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    // One failed job (Needs attention), nothing in Review.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { e2eBadges: number[] }).e2eBadges))
      .toContain(1);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('the service worker', () => {
  test('a push delivered to it shows the notification with its title, body, tag and address', async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['notifications'], { origin: engine.baseURL });
    const pageErrors = await openApp(page, '/jobs', testInfo, { permission: 'granted' });
    const cdp = await context.newCDPSession(page);
    const registrationId = new Promise<string>((resolve) => {
      cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
        const ours = registrations.find(
          (registration) =>
            registration.scopeURL === `${engine.baseURL}/` && !registration.isDeleted,
        );
        if (ours) resolve(ours.registrationId);
      });
    });
    await cdp.send('ServiceWorker.enable');
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await navigator.serviceWorker.getRegistration('/'))?.active?.state,
        ),
      )
      .toBe('activated');

    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: engine.baseURL,
      registrationId: await registrationId,
      data: JSON.stringify({
        title: 'Ready to review',
        body: 'Project tour · LAKESHORE',
        url: '/jobs?job=j1&review=1',
        tag: 'j1',
        badge: 2,
      }),
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          const shown = await registration.getNotifications();
          return shown.map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }));
        }),
      )
      .toEqual([
        {
          title: 'Ready to review',
          body: 'Project tour · LAKESHORE',
          tag: 'j1',
          data: { url: '/jobs?job=j1&review=1' },
        },
      ]);
    expect(pageErrors).toEqual([]);
  });
});
