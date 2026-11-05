// PH17: Share and get paid on the phone, from start to finish, on the built server with the fake
// runner, in Chrome at iPhone size (the `phone` project of playwright.config.ts), 390×844 like the
// design boards, with Chrome's emulated notch (47 px) and home indicator (34 px) and the Phone
// switch on. `navigator.share` is the stand-in of support/share-stub.ts (Chrome on the Mac has no
// iPhone share sheet). Two videos of RGM (₪40 each): an older one, delivered a while ago and not
// paid, and an Approved one. A second tab on the Money page stays open the whole time, so the
// numbers are seen moving as the phone's actions land (the page refreshes on `money.changed`).
//
//   share            the Approved row's Share opens the sheet; the sheet gets the MP4 and Share
//                    video hands it to the share sheet as `<job>.mp4`, inside the tap
//   Sent it?         "Sent it to RGM?" asks, Mark delivered answers: the Delivered sheet and its
//                    message with Undo; Money: Income ₪40 → ₪80, not paid yet 1 → 2 videos
//   Undo             back to Approved, Share video in hand; Money back to ₪40 and 1 video
//   delivered again  Mark delivered from the sheet's list this time; Money ₪80 and 2 videos again
//   Mark paid        Mark paid… opens the bottom sheet over the job sheet with the shared video
//                    ticked; the older one is ticked too: "Mark 2 paid", ₪80; the message says
//                    "2 videos from RGM marked paid · ₪80", the job sheet reads Paid, and Money has
//                    nothing left unpaid with both ledger rows paid; income stays ₪80
//   paid, Undo       Undo takes both payments back: Money says not paid yet again
//   the boards       measured at each step against the boards' own numbers (MJobSheet: the sheet's
//                    shell, header, pill, 48 px button, flat 48 px list with no chevron,
//                    the Sent it? card; MJobSheetDelivered: "Today · ₪40 not paid"; the
//                    message 12 px from the sides, 42 px from the bottom, 36 px Undo; MJobSheetPaid)
//
// The screenshots are attached to the report (test-results/, and the HTML report) next to the
// boards MJobSheet, MJobSheetSent, MJobSheetDelivered, MMarkPaid and MJobSheetPaid; with
// PHONE_SHOTS_DIR set they are also written there. Nothing leaves the engine's origin.

import { copyFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { action, badge, rowOf } from '../support/jobs-ui.ts';
import { sharesOf, stubShare } from '../support/share-stub.ts';

test.use({ viewport: { width: 390, height: 844 } });

const CLIENT = 'RGM';
const NEW_JOB = 'טורניר בחירות שש בש';
const OLD_JOB = 'ראיון עם השחקן';
/** The board's file: 27 MB. */
const SIZE = 27_000_000;
const WAIT = { timeout: 90_000 };

const SHEET = '[data-slot="phone-job-sheet"]';
const PAY_SHEET = '[data-slot="phone-mark-paid-sheet"]';
/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
/** The localStorage key of the time the "Add to Home Screen" card was put away (install-card.ts). */
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  delivery: { price: number; currency: string; paidOn: string | null } | null;
}

let engine: Engine;
const ids = { fresh: '', old: '' };

async function jobsOnServer(): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const found = (await jobsOnServer()).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no job named ${name}`);
  return found;
}

/** Where the two videos stand on the server: delivered or not, paid on which day. */
async function standing(): Promise<{
  fresh: JobOnServer['delivery'];
  old: JobOnServer['delivery'];
}> {
  const jobs = await jobsOnServer();
  return {
    fresh: jobs.find((candidate) => candidate.name === NEW_JOB)?.delivery ?? null,
    old: jobs.find((candidate) => candidate.name === OLD_JOB)?.delivery ?? null,
  };
}

/** Today on the browser's clock, the way the Mark paid sheet writes it (`YYYY-MM-DD`). */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** This month's name, as the app writes it ("October"). */
const thisMonth = () => new Date().toLocaleString('en-US', { month: 'long' });

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 20,
    review: false,
    phone: true,
    jobSheet: true,
  });
  // The engine's data folder sits next to its inbox (support/engine.ts): RGM's price is ₪40.
  await writeFile(
    join(dirname(engine.inbox), 'data', 'money.json'),
    JSON.stringify({ clientPrices: { [CLIENT]: 40 } }),
  );
  // One at a time, each waited for until it is ready (jobs dropped into a new client folder
  // while earlier jobs are being edited are not always noticed).
  for (const job of [OLD_JOB, NEW_JOB]) {
    await engine.createJob({ client: CLIENT, job });
    await expect
      .poll(
        async () => (await jobsOnServer().catch(() => [])).find((j) => j.name === job)?.state,
        WAIT,
      )
      .toBe('ready');
  }
  ids.old = (await jobNamed(OLD_JOB)).id;
  ids.fresh = (await jobNamed(NEW_JOB)).id;
  // The older video was delivered some time ago and never paid.
  const delivered = await fetch(`${engine.baseURL}/api/jobs/${ids.old}/deliver`, {
    method: 'POST',
  });
  expect(delivered.status).toBeLessThan(300);
  // The shared video is the one that Share is for: the board's 27 MB, so the bar has a way to go.
  await writeFile(join(engine.exportsDir, CLIENT, `${NEW_JOB}.mp4`), Buffer.alloc(SIZE, 7));
});

test.afterAll(async () => {
  await engine?.stop();
});

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

const sheet = (page: Page) => page.locator(SHEET);

/** The labels of the sheet's Details rows, top to bottom. */
const detailLabels = (page: Page) =>
  sheet(page)
    .locator('[data-detail]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-detail')));
const paySheet = (page: Page) => page.locator(PAY_SHEET);
const bigButton = (page: Page) => page.locator(`${SHEET} [data-sheet-action]`);
const sentCard = (page: Page) => page.locator(`${SHEET} [data-slot="share-sent"]`);
const pillOf = (page: Page) => page.locator(`${SHEET} [data-slot="job-sheet-status"]`);
const menuRow = (page: Page, id: string) => page.locator(`${SHEET} [data-menu-row="${id}"]`);
const messages = (page: Page) => page.locator('[data-sonner-toast]');
const confirmButton = (page: Page) =>
  paySheet(page).locator('[data-slot="phone-mark-paid-confirm"]');
const payBoxes = (page: Page) => paySheet(page).getByRole('checkbox');

/** The Money page's Income banner, and the "not paid yet" line in it (absent when all is paid). */
const income = (money: Page) => money.locator('[data-banner="income"]');
const unpaid = (money: Page) => income(money).locator('[data-unpaid]');
// The Money tab on the phone (PH19): a video's row says "Not paid yet" or "Paid Oct 14" in `data-paid`.
const paidCell = (money: Page, id: string) => money.locator(`[data-job-id="${id}"] [data-paid]`);

/** What the boards say a sheet is made of, as the app draws it now (computed style and boxes). */
async function sheetLook(page: Page) {
  return sheet(page).evaluate((content) => {
    const find = (selector: string) => content.querySelector<HTMLElement>(selector);
    const style = (element: Element | null) => (element ? getComputedStyle(element) : null);
    const box = (element: Element | null) => {
      const rect = element?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    };
    const dialog = content.closest<HTMLElement>('[role="dialog"]');
    const menu = find('[data-slot="phone-sheet-menu"]');
    const rows = [...(menu?.querySelectorAll<HTMLElement>('[data-menu-row]') ?? [])];
    const title = find('h2');
    const meta = find('[data-slot="phone-sheet-meta"]');
    const pill = find('[data-slot="job-sheet-status"]');
    const big = find('[data-sheet-action]');
    const top = dialog?.getBoundingClientRect().y ?? 0;
    const at = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect ? { y: +(rect.y - top).toFixed(1), h: +rect.height.toFixed(1) } : null;
    };
    const heading = [...content.querySelectorAll('h3')].find((h) => h.textContent === 'Details');
    const offsets = {
      avatar: at(find('[data-slot="avatar"]')),
      title: at(title),
      client: at(find('[data-slot="job-sheet-client"]')),
      close: at(find('button[aria-label="Close"]')),
      pill: at(pill),
      big: at(big),
      sent: at(find('[data-slot="share-sent"]')),
      rows: rows.map((row) => at(row)),
      details: at(heading),
    };
    return {
      offsets,
      dialog: {
        ...box(dialog),
        radius: style(dialog)?.borderTopLeftRadius,
        background: style(dialog)?.backgroundColor,
        borderTop: style(dialog)?.borderTopWidth,
      },
      grabber: box(find('[data-slot="sheet-grabber"] > span')),
      title: {
        fontSize: style(title)?.fontSize,
        lineHeight: style(title)?.lineHeight,
        fontWeight: style(title)?.fontWeight,
      },
      close: box(find('button[aria-label="Close"]')),
      pill: { height: box(pill)?.height, radius: style(pill)?.borderTopLeftRadius },
      meta: { text: meta?.textContent, fontSize: style(meta)?.fontSize, color: style(meta)?.color },
      big: big
        ? {
            height: box(big)?.height,
            width: box(big)?.width,
            radius: style(big)?.borderTopLeftRadius,
            background: style(big)?.backgroundColor,
            fontSize: style(big)?.fontSize,
          }
        : null,
      menu: {
        lines: menu?.querySelectorAll('hr').length,
        rowHeights: rows.map((row) => row.getBoundingClientRect().height),
        rowFontSizes: rows.map((row) => getComputedStyle(row).fontSize),
        rowPaddingLeft: rows.map((row) => getComputedStyle(row).paddingLeft),
        chevrons: rows.map((row) => row.querySelectorAll('svg.lucide-chevron-right').length),
      },
    };
  });
}

/** The message at the bottom, as the boards draw it: 12 px from the sides, 42 px up, 36 px Undo. */
async function messageLook(page: Page, text: string) {
  const message = messages(page).filter({ hasText: text });
  await expect(message).toBeVisible();
  await page.waitForTimeout(450);
  return message.evaluate((toast) => {
    const rect = toast.getBoundingClientRect();
    const style = getComputedStyle(toast);
    const undo = toast.querySelector('[data-button]')?.getBoundingClientRect();
    return {
      left: rect.x,
      right: window.innerWidth - (rect.x + rect.width),
      bottom: window.innerHeight - (rect.y + rect.height),
      radius: style.borderTopLeftRadius,
      fontSize: style.fontSize,
      textWrap: style.textWrap,
      undoHeight: undo?.height,
    };
  });
}

async function menuRowIds(page: Page): Promise<string[]> {
  return page
    .locator(`${SHEET} [data-menu-row]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-row') ?? ''));
}

/** The sheets have stopped moving (they slide in over 200 ms). */
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(450);
}

test('share an Approved video, deliver it, Undo, deliver again, then mark it and an older one paid', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  // Both tabs: this version's "What's new" seen, the install card put away, and a phone with a
  // notch and a home indicator (the boards' status bar and home indicator).
  await context.addInitScript(
    ([seen, value, card]) => {
      localStorage.setItem(seen as string, value as string);
      localStorage.setItem(card as string, String(Date.now()));
    },
    [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
  );
  await stubShare(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  });

  // The Money tab: one delivered video of RGM, not paid yet.
  const money = await context.newPage();
  money.on('pageerror', (error) => pageErrors.push(error.message));
  await money.goto(`${engine.baseURL}/money`);
  await expect(income(money)).toContainText('₪40');
  await expect(unpaid(money)).toContainText('₪40');
  await expect(unpaid(money)).toContainText('not paid yet · 1 video');
  await expect(paidCell(money, ids.old)).toHaveText('Not paid yet');

  await page.bringToFront();
  await page.goto(`${engine.baseURL}/jobs`);
  await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
  const row = rowOf(page, NEW_JOB);

  await test.step('share: the sheet gets the MP4, and Share video hands it over as <job>.mp4', async () => {
    await expect(badge(row, 'Approved')).toBeVisible();
    await action(row, 'Share video').tap();
    await expect.poll(() => new URL(page.url()).searchParams.get('job')).toBe(ids.fresh);
    await expect(sheet(page)).toBeVisible();
    await expect(pillOf(page)).toHaveText('Approved');
    await expect(bigButton(page)).toHaveText('Share video', { timeout: 30_000 });
    await settled(page);
    await shoot(page, testInfo, 'qa-approved');

    // MJobSheet: the shell, the header, the pill, the 48 px button, a flat list of 48 px rows.
    const look = await sheetLook(page);
    // Where the board puts each part, from the top of the sheet (MJobSheet measured in Chrome at
    // 390 px): the avatar and × at 26, the 24 px name at 27 and the 20 px client under it at 53,
    // the pill at 85, the button at 123, the list from 188, Details at 349 (the board has Download MP4 as a fourth row; Share video
    // replaced it, U16, and Share video is the button here, so it is not in the list).
    expect(look.offsets).toMatchObject({
      avatar: { y: 26, h: 40 },
      title: { y: 27, h: 24 },
      client: { y: 53, h: 20 },
      close: { y: 26, h: 44 },
      pill: { y: 85, h: 22 },
      big: { y: 123, h: 48 },
      rows: [{ y: 188 }, { y: 236 }, { y: 284 }],
      details: { y: 349 },
    });
    expect(look.dialog).toMatchObject({
      x: 0,
      width: 390,
      radius: '16px',
      background: 'rgb(24, 24, 27)',
      borderTop: '1px',
    });
    expect(Math.round((look.dialog.y ?? 0) + (look.dialog.height ?? 0))).toBe(844);
    // The bar: 36 × 5, centred, 8 px under the sheet's 1 px top border.
    expect(look.grabber).toMatchObject({ width: 36, height: 5, x: 177 });
    expect((look.grabber?.y ?? 0) - (look.dialog.y ?? 0)).toBe(9);
    expect(look.title).toEqual({ fontSize: '18px', lineHeight: '24px', fontWeight: '600' });
    expect(look.close).toMatchObject({ width: 44, height: 44 });
    expect(look.pill).toEqual({ height: 22, radius: '6px' });
    expect(look.meta).toMatchObject({ fontSize: '13px', color: 'rgb(161, 161, 170)' });
    expect(look.big).toEqual({
      height: 48,
      width: 358,
      radius: '8px',
      background: 'rgb(37, 99, 235)',
      fontSize: '15px',
    });
    // Mark delivered, the look, Archive: 48 px each, 16 px in, 15 px, no line
    // between them and no chevron.
    expect(look.menu.rowHeights).toEqual([48, 48, 48]);
    expect(look.menu.rowFontSizes).toEqual(['15px', '15px', '15px']);
    expect(look.menu.rowPaddingLeft).toEqual(['16px', '16px', '16px']);
    expect(look.menu.lines).toBe(0);
    expect(look.menu.chevrons).toEqual([0, 0, 0]);

    await bigButton(page).tap();
    expect(await sharesOf(page)).toEqual([
      { name: `${NEW_JOB}.mp4`, type: 'video/mp4', size: SIZE, files: 1, inTap: true },
    ]);
  });

  await test.step('Sent it to RGM?: Mark delivered; Money counts it', async () => {
    await expect(sentCard(page)).toContainText(`Sent it to ${CLIENT}?`);
    await expect(sentCard(page)).toContainText(
      `Mark it delivered, and ₪40 counts in ${thisMonth()}.`,
    );
    await page.waitForTimeout(250);
    await shoot(page, testInfo, 'qa-sent');
    // MJobSheetSent: the card is 16 px in from both sides, 10 px radius, 14 px padding, 44 px buttons.
    const card = await sentCard(page).evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: rect.x,
        width: rect.width,
        radius: style.borderTopLeftRadius,
        padding: style.paddingTop,
        buttons: [...node.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height),
      };
    });
    expect(card).toEqual({ x: 16, width: 358, radius: '10px', padding: '14px', buttons: [44, 44] });
    // It takes the button's place (123 px from the top, 131 px tall) and the list follows at 271.
    const askLook = await sheetLook(page);
    expect(askLook.offsets.sent).toMatchObject({ y: 123, h: 130.9 });
    expect(askLook.offsets.rows[0]?.y).toBeCloseTo(270.9, 0);
    expect(askLook.big).toBeNull();

    await sentCard(page).getByRole('button', { name: 'Mark delivered' }).tap();
    const message = messages(page).filter({
      hasText: `Delivered to ${CLIENT} · ₪40 counts in ${thisMonth()}`,
    });
    await expect(message).toBeVisible();
    await expect(pillOf(page)).toHaveText('Delivered');
    await expect(bigButton(page)).toHaveText(/Mark paid/);
    expect((await standing()).fresh).toMatchObject({ price: 40, currency: 'ILS', paidOn: null });
    await page.waitForTimeout(450);
    await shoot(page, testInfo, 'qa-delivered');

    // MJobSheetDelivered: "Today · ₪40 not paid"; Mark paid… is the 48 px button; and the message
    // is 12 px from the sides, 42 px from the bottom (34 + 8), 36 px Undo, text that wraps pretty.
    await expect(sheet(page).locator('[data-slot="phone-sheet-meta"]')).toHaveText(
      'Today · ₪40 not paid',
    );
    const deliveredLook = await sheetLook(page);
    expect(deliveredLook.big).toMatchObject({ height: 48, width: 358 });
    // The board's list: Share video, Not delivered yet, Archive from 188; Details at 349.
    expect(deliveredLook.offsets).toMatchObject({
      pill: { y: 85 },
      big: { y: 123 },
      rows: [{ y: 188 }, { y: 236 }, { y: 284 }],
      details: { y: 349 },
    });
    // Details are the board's (the owner, CVP-277): Delivered, Price, Paid "Not yet", File; no History.
    expect(await detailLabels(page)).toEqual(['Delivered', 'Price', 'Paid', 'File']);
    await expect(sheet(page).locator('[data-detail="Paid"] dd')).toHaveText('Not yet');
    await expect(sheet(page).getByRole('button', { name: 'History' })).toHaveCount(0);
    expect(
      await messageLook(page, `Delivered to ${CLIENT} · ₪40 counts in ${thisMonth()}`),
    ).toMatchObject({
      left: 12,
      right: 12,
      bottom: 42,
      radius: '10px',
      fontSize: '14px',
      textWrap: 'pretty',
      undoHeight: 36,
    });

    // Money, live in the other tab: two videos of ₪40 now.
    await expect(income(money)).toContainText('₪80');
    await expect(unpaid(money)).toContainText('₪80');
    await expect(unpaid(money)).toContainText('not paid yet · 2 videos');
    await expect(paidCell(money, ids.fresh)).toHaveText('Not paid yet');
  });

  await test.step('Undo: back to Approved with Share video, and Money takes the ₪40 back', async () => {
    await messages(page)
      .filter({ hasText: 'Delivered to' })
      .getByRole('button', { name: 'Undo' })
      .tap();
    await expect(pillOf(page)).toHaveText('Approved');
    await expect(bigButton(page)).toHaveText('Share video');
    await expect(sheet(page)).toBeVisible();
    await expect.poll(async () => (await standing()).fresh, WAIT).toBeNull();
    await expect(income(money)).toContainText('₪40');
    await expect(income(money)).not.toContainText('₪80');
    await expect(unpaid(money)).toContainText('not paid yet · 1 video');
    await expect(money.locator(`[data-job-id="${ids.fresh}"]`)).toHaveCount(0);
  });

  await test.step('delivered again, from the sheet’s list this time', async () => {
    expect((await menuRowIds(page))[0]).toBe('deliver');
    await menuRow(page, 'deliver').tap();
    await expect(pillOf(page)).toHaveText('Delivered');
    await expect(bigButton(page)).toHaveText(/Mark paid/);
    await expect.poll(async () => (await standing()).fresh, WAIT).toMatchObject({ price: 40 });
    await expect(income(money)).toContainText('₪80');
    await expect(unpaid(money)).toContainText('not paid yet · 2 videos');
  });

  await test.step('Mark paid: the shared video and the older one, 2 videos, ₪80', async () => {
    await bigButton(page).tap();
    await expect(paySheet(page)).toBeVisible();
    await settled(page);
    await expect(paySheet(page).getByRole('heading')).toHaveText(`Mark paid · ${CLIENT}`);
    await expect(paySheet(page)).toContainText('Not paid yet · 2');
    // Newest first; only the video it was opened from is ticked.
    const names = await paySheet(page)
      .locator('label[for^="phone-mark-paid-"]')
      .filter({ hasText: 'Delivered' })
      .evaluateAll((rows) => rows.map((r) => r.querySelector('[dir="auto"]')?.textContent ?? ''));
    expect(names).toEqual([NEW_JOB, OLD_JOB]);
    expect(
      await payBoxes(page).evaluateAll((boxes) => boxes.map((b) => b.getAttribute('aria-checked'))),
    ).toEqual(['true', 'false']);
    await expect(confirmButton(page)).toHaveText('Mark paid');
    await expect(paySheet(page)).toContainText('1 video · ₪40');

    // The older video too: the whole row is the target.
    await paySheet(page)
      .locator('label[for^="phone-mark-paid-"]')
      .filter({ hasText: OLD_JOB })
      .tap();
    await expect(confirmButton(page)).toHaveText('Mark 2 paid');
    await expect(paySheet(page)).toContainText('2 videos · ₪80');
    await page.waitForTimeout(250);
    await shoot(page, testInfo, 'qa-mark-paid');

    await confirmButton(page).tap();
    await expect(paySheet(page)).toHaveCount(0);
    const message = messages(page).filter({ hasText: 'marked paid' });
    await expect(message).toHaveCount(1);
    await expect(message).toContainText(`2 videos from ${CLIENT} marked paid · ₪80`);
    await expect.poll(standing, WAIT).toMatchObject({
      fresh: { paidOn: today() },
      old: { paidOn: today() },
    });
    // The job sheet behind it shows the change.
    await expect(pillOf(page)).toHaveText('Paid');
    await expect(bigButton(page)).toHaveCount(0);
    await page.waitForTimeout(450);
    await shoot(page, testInfo, 'qa-paid');

    // MJobSheetPaid: no big button, "Paid <day> · ₪40", flat 48 px rows: Share video, Not paid
    // yet, Archive (and, with company, Archive all paid · 2).
    const now = new Date();
    const day = `${now.getDate()} ${now.toLocaleString('en-US', { month: 'short' })}`;
    await expect(sheet(page).locator('[data-slot="phone-sheet-meta"]')).toHaveText(
      `Paid ${day} · ₪40`,
    );
    const paidLook = await sheetLook(page);
    expect(paidLook.big).toBeNull();
    // The board's list starts at 124 (no button) and has three rows; with a second paid video of
    // the client the shared menu adds Archive all paid · 2, so Details sit 48 px lower than 285.
    expect(paidLook.offsets).toMatchObject({
      pill: { y: 85 },
      rows: [{ y: 124 }, { y: 172 }, { y: 220 }, { y: 268 }],
      details: { y: 333 },
    });
    expect(paidLook.menu.rowHeights).toEqual([48, 48, 48, 48]);
    expect(paidLook.menu.lines).toBe(0);
    expect(paidLook.menu.chevrons).toEqual([0, 0, 0, 0]);
    // Details are the board's (the owner, CVP-277): Delivered, Paid <day>, Price, File.
    expect(await detailLabels(page)).toEqual(['Delivered', 'Paid', 'Price', 'File']);
    await expect(sheet(page).locator('[data-detail="Paid"] dd')).toHaveText(day);

    // Money: still ₪80 earned, and nothing left unpaid; both ledger rows say when.
    await expect(income(money)).toContainText('₪80');
    await expect(unpaid(money)).toHaveCount(0);
    await expect(paidCell(money, ids.fresh)).toHaveText(/^Paid [A-Z][a-z]{2} \d{1,2}$/);
    await expect(paidCell(money, ids.old)).toHaveText(/^Paid [A-Z][a-z]{2} \d{1,2}$/);
  });

  await test.step('Undo on the payments message: Money owes the ₪80 again', async () => {
    await messages(page)
      .filter({ hasText: 'marked paid' })
      .getByRole('button', { name: 'Undo' })
      .tap();
    await expect.poll(standing, WAIT).toMatchObject({
      fresh: { paidOn: null },
      old: { paidOn: null },
    });
    await expect(sheet(page)).toBeVisible();
    await expect(pillOf(page)).toHaveText('Delivered');
    await expect(unpaid(money)).toContainText('₪80');
    await expect(unpaid(money)).toContainText('not paid yet · 2 videos');
    expect(new URL(page.url()).searchParams.get('job')).toBe(ids.fresh);
  });

  expect(pageErrors).toEqual([]);
});
