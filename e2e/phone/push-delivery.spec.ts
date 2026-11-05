// PH13: the engine's side of notifications, end to end and with nothing sent for real. A second,
// isolated engine (temp HOME, data and inbox, a spare port, the fake runner) has test phones
// registered with it whose "push service" is a local mock (e2e/support/push-mock.ts): the engine
// sends each push to it with web-push as it would to Apple, and the mock decrypts it with the
// phone's own keys and checks the VAPID token. Jobs are dropped in the inbox and moved along; the
// spec reads what each phone received:
//
//   one push per event      Ready to review, Approved · ready to send, Failed at <Step>, Queue is
//                           empty and the test push, each once, with the title, body, address, tag
//                           and (for a phone with Count on the app icon on) the badge of board MPings
//   none when switched off  a phone with an event off gets nothing for it, and a switch flipped on
//                           the engine takes effect at once
//   what the push service   TTL one hour, aes128gcm, a VAPID token that verifies, and the answers of
//   says                    410 (the device is forgotten) and 500 (kept, and the route says 502)
//   a tap                   the address a "Ready to review" push carried, opened in the app on a
//                           phone, is the job's Review, full screen (the one browser step)
//
// The mock's log is attached to the report and printed; the screenshot of the tap is attached too,
// and written to $PHONE_SHOTS_DIR when it is set.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { type PushMock, type ReceivedPush, startPushMock } from '../support/push-mock.ts';

test.use({ viewport: { width: 390, height: 844 } });

/** The localStorage keys of the web app: "What's new" seen, the Add to Home Screen card away. */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

/** The User-Agent of an iPhone's Home Screen app: the engine labels the device from it. */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** How long a push may take to arrive, and how long to wait to be sure none more is coming. */
const ARRIVES_MS = 60_000;
const QUIET_MS = 2_000;

interface PushDevice {
  id: string;
  label: string;
  events: Record<'review' | 'failed' | 'approved' | 'queueEmpty' | 'badge', boolean>;
}

interface JobOnServer {
  id: string;
  name: string;
  client: string;
  state: string;
  failedAt: number | null;
}

let mock: PushMock;
let engine: Engine;
/** The engine's VAPID public key, as `GET /api/push/key` gives it to a phone. */
let vapidKey: string;
/** The devices the engine knows, by the name the mock knows them by. */
const ids = new Map<string, string>();

const api = (path: string) => `${engine.baseURL}${path}`;

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(api(path), {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': IPHONE_UA },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function jobs(): Promise<JobOnServer[]> {
  return (await (await send('GET', '/api/jobs')).json()) as JobOnServer[];
}

/** Waits for the job named `name` to be in `state`, and returns it. */
async function jobIn(name: string, state: string): Promise<JobOnServer> {
  let found: JobOnServer | undefined;
  await expect
    .poll(
      async () => {
        found = (await jobs()).find((job) => job.name === name);
        return found?.state;
      },
      { timeout: ARRIVES_MS, message: `${name} in ${state}` },
    )
    .toBe(state);
  return found as JobOnServer;
}

/** The titles `device` has received, oldest first. */
const titles = (device: string): string[] =>
  mock.received(device).map((push) => push.payload?.title ?? '(unreadable)');

/** Waits until `device` has received `count` pushes in all. */
async function waitForPushes(device: string, count: number): Promise<void> {
  await expect
    .poll(() => mock.received(device).length, {
      timeout: ARRIVES_MS,
      message: `pushes for ${device}: ${titles(device).join(', ')}`,
    })
    .toBe(count);
}

/** Long enough that a push that should not come would have: nothing more than `counts` arrived. */
async function expectQuiet(counts: Record<string, number>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  for (const [device, count] of Object.entries(counts)) {
    expect(titles(device), `${device} after the quiet`).toHaveLength(count);
  }
}

/** A push that went through, checked for what the push service sees of it. */
function expectDelivered(push: ReceivedPush | undefined): asserts push is ReceivedPush {
  expect(push, 'a push was received').toBeDefined();
  const received = push as ReceivedPush;
  expect(received.payload, 'its payload decrypts with the phone’s keys').not.toBeNull();
  expect(received.headers.ttl).toBe('3600');
  expect(received.headers.contentEncoding).toBe('aes128gcm');
  expect(received.vapid.signatureValid, 'the VAPID token verifies').toBe(true);
  expect(received.vapid.key, 'signed with the key the phone subscribed with').toBe(vapidKey);
  expect(received.vapid.audience).toBe(mock.origin);
  expect(received.vapid.subject).toMatch(/^(mailto:|https:\/\/)/);
  expect(received.vapid.expiresInSec ?? 0).toBeGreaterThan(0);
}

test.describe.configure({ mode: 'serial' });

// biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function needs from its first argument.
test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(90_000);
  mock = await startPushMock();
  engine = await startEngine({
    settleMs: 1_000,
    fakeSpeed: 10,
    review: true,
    phone: true,
    env: { NODE_EXTRA_CA_CERTS: mock.caFile },
  });
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixtures a function needs from its first argument.
test.afterAll(async ({}, testInfo) => {
  const log = mock?.log() ?? '';
  if (log !== '') {
    console.log(`\nWhat the mock push service received:\n${log}\n`);
    await testInfo.attach('push-mock.log', { body: log, contentType: 'text/plain' });
  }
  await engine?.stop();
  await mock?.stop();
});

test.describe('registering phones', () => {
  test('the engine hands out a VAPID key and takes three test phones', async () => {
    const key = (await (await send('GET', '/api/push/key')).json()) as { publicKey: string };
    vapidKey = key.publicKey;
    // An uncompressed P-256 point: what `pushManager.subscribe` needs as applicationServerKey.
    expect(Buffer.from(vapidKey, 'base64url')).toHaveLength(65);

    for (const [name, answer] of [
      ['phone', 201],
      ['quiet', 201],
      ['gone', 410],
      ['broken', 500],
    ] as const) {
      const response = await send('POST', '/api/push/devices', mock.subscribe(name, { answer }));
      expect(response.status, name).toBe(201);
      const device = (await response.json()) as PushDevice;
      expect(device.label).toBe('iPhone');
      expect(device.events).toEqual({
        review: true,
        failed: true,
        approved: true,
        queueEmpty: false,
        badge: true,
      });
      ids.set(name, device.id);
    }

    // "quiet" wants only Queue is empty, and no count on its icon.
    const update = await send('PUT', `/api/push/devices/${ids.get('quiet')}`, {
      events: { review: false, failed: false, approved: false, queueEmpty: true, badge: false },
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as PushDevice).events).toEqual({
      review: false,
      failed: false,
      approved: false,
      queueEmpty: true,
      badge: false,
    });
  });

  test('“Send a test” reaches only that phone, whatever its switches say', async () => {
    expect((await send('POST', `/api/push/devices/${ids.get('phone')}/test`)).status).toBe(204);
    await waitForPushes('phone', 1);
    expect((await send('POST', `/api/push/devices/${ids.get('quiet')}/test`)).status).toBe(204);
    await waitForPushes('quiet', 1);
    await expectQuiet({ phone: 1, quiet: 1 });

    const forPhone = mock.received('phone')[0];
    expectDelivered(forPhone);
    expect(forPhone.payload).toEqual({
      title: 'Test from Studio Engine',
      body: 'Notifications are working on this phone.',
      url: '/jobs',
      tag: 'test',
      badge: 0,
    });
    // Count on the app icon is off for "quiet": no badge in its push.
    const forQuiet = mock.received('quiet')[0];
    expectDelivered(forQuiet);
    expect(forQuiet.payload).toEqual({
      title: 'Test from Studio Engine',
      body: 'Notifications are working on this phone.',
      url: '/jobs',
      tag: 'test',
    });
  });

  test('a 410 from the push service forgets the phone; a 500 keeps it and the route says 502', async () => {
    const gone = await send('POST', `/api/push/devices/${ids.get('gone')}/test`);
    expect(gone.status).toBe(410);
    expect((await send('GET', `/api/push/devices/${ids.get('gone')}`)).status).toBe(404);

    const broken = await send('POST', `/api/push/devices/${ids.get('broken')}/test`);
    expect(broken.status).toBe(502);
    expect((await send('GET', `/api/push/devices/${ids.get('broken')}`)).status).toBe(200);
    // Nothing of either phone is a reason for the other two to hear anything.
    expect(titles('phone')).toHaveLength(1);
    expect(titles('quiet')).toHaveLength(1);
  });
});

test.describe('one push per event', () => {
  let good: JobOnServer;

  test('an edit that reaches Review: “Ready to review” to the phone, “Queue is empty” to the quiet one', async () => {
    await engine.createJob({ client: 'LAKESHORE', job: 'סיור בפרויקט' });
    good = await jobIn('סיור בפרויקט', 'review');
    await waitForPushes('phone', 2);
    await waitForPushes('quiet', 2);
    await expectQuiet({ phone: 2, quiet: 2 });

    const review = mock.received('phone')[1];
    expectDelivered(review);
    expect(review.payload).toEqual({
      title: 'Ready to review',
      body: 'סיור בפרויקט · LAKESHORE',
      url: `/jobs?job=${good.id}&review=1`,
      tag: good.id,
      // The job in Review is the one that needs the phone's owner.
      badge: 1,
    });

    const empty = mock.received('quiet')[1];
    expectDelivered(empty);
    expect(empty.payload).toEqual({
      title: 'Queue is empty',
      body: 'Everything you dropped in is done.',
      url: '/jobs',
      tag: 'queue-empty',
    });
  });

  test('Approve: “Approved · ready to send” to the phone once the render is done', async () => {
    const approve = await send('POST', `/api/jobs/${good.id}/approve`);
    expect(approve.status).toBe(200);
    await jobIn('סיור בפרויקט', 'ready');
    await waitForPushes('phone', 3);
    // The render is a job in the queue too: the quiet phone is told again when it is idle.
    await waitForPushes('quiet', 3);
    await expectQuiet({ phone: 3, quiet: 3 });

    const approved = mock.received('phone')[2];
    expectDelivered(approved);
    expect(approved.payload).toEqual({
      title: 'Approved · ready to send',
      body: 'סיור בפרויקט · LAKESHORE',
      url: `/jobs?job=${good.id}`,
      tag: good.id,
      // Nothing is in Review or needs attention any more: the icon is cleared.
      badge: 0,
    });
    expect(titles('quiet')).toEqual([
      'Test from Studio Engine',
      'Queue is empty',
      'Queue is empty',
    ]);
  });

  test('a failure: “Failed at <Step>” to the phone, not to the one with Failed off', async () => {
    await engine.createJob({ client: 'RGM', job: 'ראיון עם המייסד', failAt: 'plan' });
    const failed = await jobIn('ראיון עם המייסד', 'failed');
    await waitForPushes('phone', 4);
    await waitForPushes('quiet', 4);
    await expectQuiet({ phone: 4, quiet: 4 });

    const ping = mock.received('phone')[3];
    expectDelivered(ping);
    expect(ping.payload?.title).toMatch(/^Failed at [A-Z]/);
    expect(ping.payload).toEqual({
      title: ping.payload?.title,
      body: 'ראיון עם המייסד · RGM',
      url: `/jobs?job=${failed.id}`,
      tag: failed.id,
      // One job needs attention.
      badge: 1,
    });
    // "quiet" only heard that the queue went idle.
    expect(titles('quiet')[3]).toBe('Queue is empty');
  });

  test('a switch flipped on the engine takes effect at once, and a failed phone is told nothing it switched off', async () => {
    const off = await send('PUT', `/api/push/devices/${ids.get('phone')}`, {
      events: { failed: false },
    });
    expect(off.status).toBe(200);

    await engine.createJob({ client: 'RGM', job: 'מיתוס או אמת 6', failAt: 'plan' });
    await jobIn('מיתוס או אמת 6', 'failed');
    // The queue goes idle again: the quiet phone hears it, the other has Failed off.
    await waitForPushes('quiet', 5);
    await expectQuiet({ phone: 4, quiet: 5 });
  });
});

test.describe('a tap', () => {
  test('on “Ready to review”, from the address the push carried, opens the job’s Review full screen', async ({
    page,
  }, testInfo) => {
    await engine.createJob({ client: 'LAKESHORE', job: 'אדריכלות' });
    const job = await jobIn('אדריכלות', 'review');
    await waitForPushes('phone', 5);
    await waitForPushes('quiet', 6);
    const push = mock.received('phone')[4];
    expectDelivered(push);
    expect(push.payload?.title).toBe('Ready to review');
    const address = push.payload?.url ?? '';
    expect(address).toBe(`/jobs?job=${job.id}&review=1`);

    // The Home Screen app, opened by a tap on the notification: this address, a phone's size.
    const { version } = (await (await send('GET', '/api/health')).json()) as { version: string };
    await page.addInitScript(
      ([seen, current, card]) => {
        localStorage.setItem(seen as string, current as string);
        localStorage.setItem(card as string, String(Date.now()));
      },
      [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
    );
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(api(address));

    const review = page.locator('[data-slot="phone-review"]');
    await expect(review).toBeVisible();
    await expect(review.locator('[data-slot="preview-player"]')).toBeVisible();
    // The address is cleaned: the job's sheet is what the Review closes onto.
    await expect.poll(() => new URL(page.url()).search).toBe(`?job=${job.id}`);

    const body = await page.screenshot();
    await testInfo.attach('push-review-landing-390x844.png', {
      body,
      contentType: 'image/png',
    });
    const dir = process.env.PHONE_SHOTS_DIR;
    if (dir) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'push-review-landing-390x844.png'), body);
    }
    expect(pageErrors).toEqual([]);
  });
});

test.describe('what stays on the Mac', () => {
  test('the engine’s log never holds a phone’s endpoint', async () => {
    const log = await engine.readLog();
    expect(log).not.toContain(mock.origin);
    expect(log).not.toContain('/push/phone');
    expect(log).not.toContain('/push/quiet');
  });
});
