// PH16: Mark paid as a bottom sheet, and phone-sized messages with Undo, on the built server with
// the fake runner, in Chrome at iPhone size (the `phone` project of playwright.config.ts), 390×844
// like the design boards, with Chrome's emulated notch (47 px) and home indicator (34 px) and the
// Phone switch on. One engine, Levi's three videos delivered (newest first: Myth or fact 5,
// Myth or fact 4, Common questions 5), one more of their delivered and archived, and one of RGM's:
//
//   the Delivered sheet   MJobSheetDelivered: Mark paid… is the big 48 px button; the list is
//                         Share video, Not delivered yet and Archive, 48 px rows
//   the Mark paid sheet   MMarkPaid: a bottom sheet over the job sheet, "Mark paid · <client>",
//                         "Not paid yet · 3" with Select all / Clear, 56 px rows with a 20 px
//                         checkbox, "Paid on" (16 px, never later than today), the full-width
//                         "Mark paid" / "Mark 2 paid" and the total under it; only the video it
//                         was opened from ticked; the archived and the other client's left out
//   paying 2 of 3         the fake engine records two payments; the message sits at the bottom,
//                         12 px from the sides and 8 px above the home bar, with Undo and no ×
//   the Paid sheet        MJobSheetPaid: Not paid yet in the list, and its own message with Undo;
//                         a tap on Undo leaves the job sheet open
//   swipe down            a finger drags the sheet down from anywhere on it (its list, its total):
//                         far enough closes it without paying, the job sheet stays; the date field
//                         keeps its own touches
//   one toaster           the Jobs page and a client's page (a Mac page inside the phone shell)
//                         each have exactly one region for messages, and one Mark paid sheet
//
// The screenshots are attached to the report (test-results/, and the HTML report) next to the
// boards MJobSheetDelivered, MMarkPaid and MJobSheetPaid; with PHONE_SHOTS_DIR set they are also
// written there. Nothing leaves the engine's origin.

import { copyFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { action, rowOf } from '../support/jobs-ui.ts';
import { stubShare } from '../support/share-stub.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ mode: 'serial' });

const TAVO = 'Levy Law';
const RGM = 'RGM';
const JOB = {
  five: 'Myth or fact 5',
  four: 'Myth or fact 4',
  faq: 'Common questions 5',
  archived: 'Myth or fact 3',
  rgm: 'Backgammon tournament',
} as const;
const WAIT = { timeout: 90_000 };

const SHEET = '[data-slot="phone-job-sheet"]';
const PAY_SHEET = '[data-slot="phone-mark-paid-sheet"]';
/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
/** The localStorage key of the time the "Add to Home Screen" card was put away (install-card.ts). */
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

interface JobOnServer {
  id: string;
  clientId: string;
  name: string;
  state: string;
  archivedAt: string | null;
  delivery: { price: number; paidOn: string | null; paidAmount?: number | null } | null;
}

let engine: Engine;
const ids: Record<keyof typeof JOB, string> = {
  five: '',
  four: '',
  faq: '',
  archived: '',
  rgm: '',
};

async function jobsOnServer(): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const found = (await jobsOnServer()).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no job named ${name}`);
  return found;
}

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${engine.baseURL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, `POST ${path}: ${await response.clone().text()}`).toBeLessThan(300);
}

/** Who has been paid, by job: the day, or `null` for delivered and not paid yet. */
async function paidOn(): Promise<Record<string, string | null>> {
  const jobs = await jobsOnServer();
  return Object.fromEntries(
    Object.entries(JOB).map(([key, name]) => [
      key,
      jobs.find((candidate) => candidate.name === name)?.delivery?.paidOn ?? null,
    ]),
  );
}

/** Today on the browser's clock, the way the sheet writes it (`YYYY-MM-DD`). */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 20,
    review: false,
    phone: true,
    jobSheet: true,
  });
  // The engine's data folder sits next to its inbox (support/engine.ts): both clients pay ₪40.
  await writeFile(
    join(dirname(engine.inbox), 'data', 'money.json'),
    JSON.stringify({ clientPrices: { [TAVO]: 40, [RGM]: 40 } }),
  );

  // One at a time, each waited for until the engine lists it (jobs dropped into a new client
  // folder while earlier jobs are being edited are not always noticed).
  const toMake: ReadonlyArray<readonly [client: string, job: string]> = [
    [TAVO, JOB.faq],
    [TAVO, JOB.four],
    [TAVO, JOB.five],
    [TAVO, JOB.archived],
    [RGM, JOB.rgm],
  ];
  for (const [client, job] of toMake) {
    await engine.createJob({ client, job });
    await expect
      .poll(async () => (await jobsOnServer()).some((candidate) => candidate.name === job), WAIT)
      .toBe(true);
  }
  await expect
    .poll(
      async () => (await jobsOnServer()).every((candidate) => candidate.state === 'ready'),
      WAIT,
    )
    .toBe(true);

  for (const key of Object.keys(JOB) as (keyof typeof JOB)[]) {
    ids[key] = (await jobNamed(JOB[key])).id;
  }
  // Delivered oldest first, so that the list shows Myth or fact 5 first; the archived one is
  // delivered and put away without being paid.
  for (const key of ['archived', 'faq', 'four', 'five', 'rgm'] as const) {
    await post(`/api/jobs/${ids[key]}/deliver`);
    // The newest delivery is the one with the later time: keep them apart.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
  await post('/api/jobs/archive', { ids: [ids.archived] });
});

test.afterAll(async () => {
  await engine?.stop();
});

/** Chrome's emulated notch and home indicator: the boards' status bar (47 px) and home indicator (34 px). */
async function emulateSafeAreas(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  });
}

/**
 * Opens `path` in a browser that has seen this version's "What's new" and put the install card
 * away, on a phone with a notch and a home indicator; returns the page's errors so far.
 */
async function open(page: Page, path = '/jobs'): Promise<string[]> {
  await emulateSafeAreas(page);
  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  await page.addInitScript(
    ([seen, value, card]) => {
      localStorage.setItem(seen as string, value as string);
      localStorage.setItem(card as string, String(Date.now()));
    },
    [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
  );
  // Chrome has no iPhone share sheet: a stand-in that can share files (support/share-stub.ts).
  await stubShare(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  await expect(page.locator('[data-slot="phone-shell"]')).toBeVisible();
  return pageErrors;
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}-390x844.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}-390x844.png`, { path, contentType: 'image/png' });
  const dir = process.env.PHONE_SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(path, join(dir, `${name}-390x844.png`));
  }
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'the element is on the page').not.toBeNull();
  return box as { x: number; y: number; width: number; height: number };
}

const sheet = (page: Page) => page.locator(SHEET);
const paySheet = (page: Page) => page.locator(PAY_SHEET);
const bigButton = (page: Page) => page.locator(`${SHEET} [data-sheet-action]`);
const pillOf = (page: Page) => page.locator(`${SHEET} [data-slot="job-sheet-status"]`);
const menuRow = (page: Page, id: string) => page.locator(`${SHEET} [data-menu-row="${id}"]`);
const messages = (page: Page) => page.locator('[data-sonner-toast]');
const regions = (page: Page) => page.locator('section[aria-label^="Notifications"]');
const confirmButton = (page: Page) =>
  paySheet(page).locator('[data-slot="phone-mark-paid-confirm"]');
const payRows = (page: Page) =>
  paySheet(page).locator('label[for^="phone-mark-paid-"]').filter({ hasText: 'Delivered' });
const payBoxes = (page: Page) => paySheet(page).getByRole('checkbox');

async function menuRowIds(page: Page): Promise<string[]> {
  return page
    .locator(`${SHEET} [data-menu-row]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-row') ?? ''));
}

/** The sheets have stopped moving (they slide in over 200 ms). */
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(450);
}

test('the Delivered sheet: Mark paid… is the big button, and the list reads as 48 px rows', async ({
  page,
}, testInfo) => {
  const pageErrors = await open(page, `/jobs?job=${ids.five}`);
  await expect(sheet(page)).toBeVisible();
  await settled(page);

  await expect(pillOf(page)).toHaveText('Delivered');
  await expect(bigButton(page)).toHaveText('Mark paid…');
  await expect(bigButton(page)).toHaveAttribute('data-sheet-action', 'pay');
  const big = await boxOf(bigButton(page));
  expect(big.height).toBe(48);
  expect(big.width).toBe(390 - 32);

  // Mark paid… is the button, so the list holds the other ways: the video, a step back, the archive.
  expect(await menuRowIds(page)).toEqual(['share', 'undeliver', 'archive']);
  await expect(menuRow(page, 'share')).toHaveText('Share video');
  // Share replaces Download MP4 on the phone: no download link is reachable while it can share.
  await expect(sheet(page).locator('a[download]')).toHaveCount(0);
  await expect(menuRow(page, 'undeliver')).toHaveText('Not delivered yet');
  await expect(menuRow(page, 'archive')).toHaveText('Archive');
  for (const id of ['share', 'undeliver', 'archive']) {
    const row = await boxOf(menuRow(page, id));
    expect(row.height, id).toBeGreaterThanOrEqual(48);
    expect(row.width, id).toBe(390);
  }
  await shoot(page, testInfo, 'delivered-sheet');
  expect(pageErrors).toEqual([]);
});

test('Mark paid… opens the bottom sheet over the job sheet; paying 2 of 3 works end to end', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const pageErrors = await open(page, `/jobs?job=${ids.five}`);
  await expect(sheet(page)).toBeVisible();
  await settled(page);

  await test.step('opens as a bottom sheet, with the question and only the asked video ticked', async () => {
    await bigButton(page).tap();
    await expect(paySheet(page)).toBeVisible();
    await settled(page);
    // One Mark paid sheet, and no dialog of the Mac.
    await expect(paySheet(page)).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: /Mark paid/ })).toHaveCount(1);

    const box = await boxOf(paySheet(page));
    expect(box.x).toBe(0);
    expect(box.width).toBe(390);
    // It sits on the bottom edge of the screen.
    expect(Math.round(box.y + box.height)).toBe(844);

    await expect(paySheet(page).getByRole('heading')).toHaveText(`Mark paid · ${TAVO}`);
    await expect(paySheet(page)).toContainText(
      'Which videos does this payment cover, and what was paid for each?',
    );
    // Newest first; the archived video and RGM's are left out.
    await expect(paySheet(page)).toContainText('Not paid yet · 3');
    await expect(payRows(page)).toHaveCount(3);
    const names = await payRows(page).evaluateAll((rows) =>
      rows.map((row) => row.querySelector('[dir="auto"]')?.textContent ?? ''),
    );
    expect(names).toEqual([JOB.five, JOB.four, JOB.faq]);
    await expect(paySheet(page)).not.toContainText(JOB.archived);
    await expect(paySheet(page)).not.toContainText(JOB.rgm);
    for (const [index, row] of (await payRows(page).all()).entries()) {
      await expect(row).toContainText(/Delivered \d{1,2} [A-Z][a-z]{2}/);
      const rowBox = await boxOf(row);
      expect(rowBox.height, `row ${index}`).toBeGreaterThanOrEqual(56);
      // What was paid for it starts at its price, in a 16 px field on the row's right.
      const amount = paySheet(page).getByLabel(`Paid for ${names[index]}`);
      await expect(amount).toHaveValue('40');
      const amountBox = await boxOf(amount);
      expect(amountBox.height).toBe(40);
      expect(amountBox.x + amountBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    }
    // 20 px checkboxes; only the video it was opened from is ticked.
    const checks = await payBoxes(page).all();
    expect(checks).toHaveLength(3);
    for (const check of checks) {
      const checkBox = await boxOf(check);
      expect([checkBox.width, checkBox.height]).toEqual([20, 20]);
    }
    expect(
      await payBoxes(page).evaluateAll((boxes) => boxes.map((b) => b.getAttribute('aria-checked'))),
    ).toEqual(['true', 'false', 'false']);
    await expect(confirmButton(page)).toHaveText('Mark paid');
    await expect(paySheet(page)).toContainText('1 video · ₪40');
  });

  await test.step('Paid on: a 16 px date field of today that cannot be later; the button is full width', async () => {
    const field = paySheet(page).getByLabel('Paid on');
    await expect(field).toHaveValue(today());
    await expect(field).toHaveAttribute('max', today());
    expect(await field.evaluate((input) => getComputedStyle(input).fontSize)).toBe('16px');
    const button = await boxOf(confirmButton(page));
    expect(button.height).toBe(48);
    expect(button.width).toBe(390 - 32);
    // The sheet clears the home indicator: the total's text ends above the 34 px strip.
    const total = await boxOf(paySheet(page).locator('p[aria-live="polite"]'));
    expect(total.y + total.height).toBeLessThanOrEqual(844 - 34);

    // A day after today cannot be sent.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await field.fill(
      `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`,
    );
    await expect(confirmButton(page)).toBeDisabled();
    await field.fill(today());
    await expect(confirmButton(page)).toBeEnabled();
  });

  await test.step('Select all / Clear, then two of three', async () => {
    const toggleAll = paySheet(page).getByRole('button', { name: 'Select all' });
    await toggleAll.tap();
    await expect(paySheet(page).getByRole('button', { name: 'Clear' })).toBeVisible();
    await expect(confirmButton(page)).toHaveText('Mark 3 paid');
    await expect(paySheet(page)).toContainText('3 videos · ₪120');
    await paySheet(page).getByRole('button', { name: 'Clear' }).tap();
    await expect(confirmButton(page)).toBeDisabled();
    await expect(paySheet(page)).toContainText('Nothing ticked');

    // Tap the rows themselves: the whole row is the target.
    await payRows(page).nth(0).tap();
    await payRows(page).nth(2).tap();
    await expect(confirmButton(page)).toHaveText('Mark 2 paid');
    await expect(paySheet(page)).toContainText('2 videos · ₪80');

    // The client paid nothing for the FAQ video: a tap in its field does not untick it.
    const faqAmount = paySheet(page).getByLabel(`Paid for ${JOB.faq}`);
    await faqAmount.tap();
    await faqAmount.fill('0');
    await expect(confirmButton(page)).toHaveText('Mark 2 paid');
    await expect(paySheet(page)).toContainText('2 videos · ₪40');
    await page.waitForTimeout(250);
    await shoot(page, testInfo, 'mark-paid');
  });

  await test.step('Mark 2 paid: the sheet closes, the engine has two payments, and the message says so', async () => {
    await confirmButton(page).tap();
    await expect(paySheet(page)).toHaveCount(0);
    await expect.poll(paidOn, WAIT).toMatchObject({ five: today(), faq: today(), four: null });
    // What was paid is kept with the price it was delivered at.
    expect((await jobNamed(JOB.faq)).delivery).toMatchObject({ price: 40, paidAmount: 0 });
    expect((await jobNamed(JOB.five)).delivery).toMatchObject({ price: 40, paidAmount: 40 });

    const message = messages(page).filter({ hasText: 'marked paid' });
    await expect(message).toHaveCount(1);
    await expect(message).toContainText(`2 videos from ${TAVO} marked paid · ₪40`);
    await expect(message.getByRole('button', { name: 'Undo' })).toBeVisible();
    // No ×, and one region for all messages.
    await expect(message.locator('[data-close-button]')).toHaveCount(0);
    await expect(regions(page)).toHaveCount(1);
    await page.waitForTimeout(450);

    // At the bottom: 12 px from both sides, 8 px above the home bar's 34 px (the board's 42).
    const toast = await boxOf(message);
    expect(toast.x).toBe(12);
    expect(toast.x + toast.width).toBe(390 - 12);
    expect(Math.round(toast.y + toast.height)).toBe(844 - 34 - 8);
    // Its Undo is a 36 px button.
    const undo = await boxOf(message.getByRole('button', { name: 'Undo' }));
    expect(undo.height).toBe(36);

    // The job sheet behind it shows the change: Myth or fact 5 is paid.
    await expect(pillOf(page)).toHaveText('Paid');
    await expect(bigButton(page)).toHaveCount(0);
    // Two videos of the client are paid now, so the shared menu also offers to archive them all.
    expect(await menuRowIds(page)).toEqual(['share', 'unpay', 'archive', 'archive-all-paid']);
    await expect(menuRow(page, 'unpay')).toHaveText('Not paid yet');
    await expect(menuRow(page, 'archive-all-paid')).toHaveText('Archive all paid · 2');
    await shoot(page, testInfo, 'paid-sheet');
  });

  await test.step('a tap on Undo takes both payments back and leaves the job sheet open', async () => {
    const message = messages(page).filter({ hasText: 'marked paid' });
    await message.getByRole('button', { name: 'Undo' }).tap();
    await expect.poll(paidOn, WAIT).toMatchObject({ five: null, faq: null, four: null });
    await expect(sheet(page)).toBeVisible();
    await expect(pillOf(page)).toHaveText('Delivered');
    await expect(bigButton(page)).toHaveText('Mark paid…');
    expect(new URL(page.url()).searchParams.get('job')).toBe(ids.five);
  });

  expect(pageErrors).toEqual([]);
});

test('the Paid sheet: Not paid yet in the list, with its message and Undo at the bottom', async ({
  page,
}, testInfo) => {
  await post('/api/payments', { jobIds: [ids.five], paidOn: today() });
  const pageErrors = await open(page, `/jobs?job=${ids.five}`);
  await expect(sheet(page)).toBeVisible();
  await settled(page);

  await expect(pillOf(page)).toHaveText('Paid');
  await expect(sheet(page).locator('[data-slot="phone-sheet-meta"]')).toContainText('Paid');
  expect(await menuRowIds(page)).toEqual(['share', 'unpay', 'archive']);
  for (const id of ['share', 'unpay', 'archive']) {
    const row = await boxOf(menuRow(page, id));
    expect(row.height, id).toBeGreaterThanOrEqual(48);
  }

  await menuRow(page, 'unpay').tap();
  const message = messages(page).filter({ hasText: 'Back to Delivered' });
  await expect(message).toBeVisible();
  await expect(message.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(pillOf(page)).toHaveText('Delivered');
  await expect.poll(paidOn, WAIT).toMatchObject({ five: null });
  await page.waitForTimeout(450);
  const toast = await boxOf(message);
  expect(toast.x).toBe(12);
  expect(toast.x + toast.width).toBe(390 - 12);
  await shoot(page, testInfo, 'not-paid-yet-message');

  // Undo puts the payment back; the sheet stays.
  await message.getByRole('button', { name: 'Undo' }).tap();
  await expect(pillOf(page)).toHaveText('Paid');
  await expect(sheet(page)).toBeVisible();
  // Leave the list as the next test expects it.
  await post('/api/payments/undo', { jobIds: [ids.five] });
  expect(pageErrors).toEqual([]);
});

test('from the Jobs list and from a client’s page: one Mark paid sheet, one region for messages', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors = await open(page, '/jobs');
  await expect(rowOf(page, JOB.four)).toBeVisible();
  await expect(regions(page)).toHaveCount(1);

  // The banknote on a Delivered row asks for the sheet; nothing is ticked but its video.
  await action(rowOf(page, JOB.four), 'Mark paid…').tap();
  await expect(paySheet(page)).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Mark paid/ })).toHaveCount(1);
  expect(
    await payBoxes(page).evaluateAll((boxes) => boxes.map((b) => b.getAttribute('aria-checked'))),
  ).toEqual(['false', 'true', 'false']);

  // A tap on the dimmed page leaves without paying anything.
  await page.mouse.click(195, 40);
  await expect(paySheet(page)).toHaveCount(0);
  expect((await paidOn()).four).toBeNull();

  // A Mac page inside the phone shell (a client's page) has the same sheet, and still one region.
  const clientId = (await jobNamed(JOB.four)).clientId;
  await page.goto(`${engine.baseURL}/clients/${clientId}`);
  await expect(page.locator('[data-slot="phone-shell"]')).toBeVisible();
  await expect(rowOf(page, JOB.four)).toBeVisible();
  await expect(regions(page)).toHaveCount(1);
  await action(rowOf(page, JOB.four), 'Mark paid…').tap();
  await expect(paySheet(page)).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: /Mark paid/ })).toHaveCount(1);

  await confirmButton(page).tap();
  await expect(paySheet(page)).toHaveCount(0);
  const message = messages(page).filter({ hasText: 'marked paid' });
  await expect(message).toHaveCount(1);
  await expect(message).toContainText(`1 video from ${TAVO} marked paid · ₪40`);
  await expect.poll(paidOn, WAIT).toMatchObject({ four: today() });

  // Back to how the list was.
  await message.getByRole('button', { name: 'Undo' }).tap();
  await expect.poll(paidOn, WAIT).toMatchObject({ four: null });
  expect(pageErrors).toEqual([]);
});

/** A finger at (x, y) moves `dy` px down in `steps` moves, `stepMs` apart, and lifts (real touches). */
async function fingerDrag(
  page: Page,
  { x, y }: { x: number; y: number },
  dy: number,
  { steps = 10, stepMs = 16 }: { steps?: number; stepMs?: number } = {},
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= steps; step++) {
    await page.waitForTimeout(stepMs);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y + (dy * step) / steps }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('a finger drags the Mark paid sheet down from anywhere on it: far enough closes it, unpaid', async ({
  page,
}) => {
  const pageErrors = await open(page, `/jobs?job=${ids.five}`);
  await expect(sheet(page)).toBeVisible();
  await settled(page);
  await bigButton(page).tap();
  await expect(paySheet(page)).toBeVisible();
  await settled(page);

  // A short, slow drag from the middle of the list springs back.
  const list = await boxOf(payRows(page).nth(1));
  const from = { x: list.x + list.width / 2, y: list.y + list.height / 2 };
  await fingerDrag(page, from, 20, { steps: 10, stepMs: 40 });
  await page.waitForTimeout(300);
  await expect(paySheet(page)).toBeVisible();
  expect(await paySheet(page).evaluate((node) => node.style.transform)).toBe('');

  // A long one closes it: nothing was paid, and the job sheet underneath is still there.
  await fingerDrag(page, from, 260);
  await expect(paySheet(page)).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  expect((await paidOn()).five).toBeNull();
  await expect(messages(page)).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
