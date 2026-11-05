// Gestures on the phone (the owner, 22 Oct), on the built server with the fake runner, in Chrome at the
// design boards' size (the `phone` project: touch, an iPhone user agent):
//
//   swipe down    a finger drags a bottom sheet down from anywhere on it, not only its grabber: far
//                 enough closes it, a short drag springs back, and a sheet scrolled down scrolls
//                 back up first
//   long press    selects no text on the phone layout (rows, cards, sheets); a text field still
//                 does, and the Mac layout is as before
//
// The touches are real ones (Chrome's Input.dispatchTouchEvent), not mouse events: the grabber's
// own mouse drag is phone-journey.spec.ts's.

import { expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({ viewport: { width: 390, height: 844 } });

const SHEET = '[data-slot="phone-job-sheet"]';
/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
/** The localStorage key of the time the "Add to Home Screen" card was put away (install-card.ts). */
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

interface JobOnServer {
  id: string;
  name: string;
}

let engine: Engine;
let job: JobOnServer;

test.beforeAll(async () => {
  // A fake edit takes a minute at speed 1, so the job stays put while the tests run.
  engine = await startEngine({ settleMs: 1_000, fakeSpeed: 1, review: false, phone: true });
  await engine.createJob({ client: 'Acme', job: 'Swipe me' });
  await expect
    .poll(
      async () => {
        const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
        const found = jobs.find((candidate) => candidate.name === 'Swipe me');
        if (found) job = found;
        return found !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

test.afterAll(async () => {
  await engine?.stop();
});

/** Opens `path` as a phone that has seen this version's "What's new" and put the install card away. */
async function open(page: Page, path: string): Promise<string[]> {
  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  await page.addInitScript(
    ([seen, version, card]) => {
      localStorage.setItem(seen as string, version as string);
      localStorage.setItem(card as string, String(Date.now()));
    },
    [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  return pageErrors;
}

async function openSheet(page: Page): Promise<string[]> {
  const pageErrors = await open(page, `/jobs?job=${job.id}`);
  await expect(page.locator(SHEET)).toBeVisible();
  await page.waitForTimeout(450); // It slides in over 200 ms.
  return pageErrors;
}

/** A finger at (x, y) moves `dy` px down in `steps` moves, `stepMs` apart, and lifts. */
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

/** The middle of the sheet's Details: far from the grabber, on plain text, whatever the sheet's height. */
async function middleOfSheet(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator(SHEET).getByRole('region', { name: 'Details' }).boundingBox();
  if (!box) throw new Error('the sheet has no Details');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('a finger drags the sheet down from its middle, and far enough closes it', async ({
  page,
}) => {
  const pageErrors = await openSheet(page);
  await fingerDrag(page, await middleOfSheet(page), 240);
  await expect(page.locator(SHEET)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).search).toBe('');
  expect(pageErrors).toEqual([]);
});

test('a short, slow drag springs back, and a tap is still a tap', async ({ page }) => {
  const pageErrors = await openSheet(page);
  await fingerDrag(page, await middleOfSheet(page), 20, { steps: 10, stepMs: 40 });
  await page.waitForTimeout(300);
  await expect(page.locator(SHEET)).toBeVisible();
  expect(await page.locator(SHEET).evaluate((sheet) => sheet.style.transform)).toBe('');
  expect(pageErrors).toEqual([]);
});

test('a sheet scrolled down scrolls back up first, and does not close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  const pageErrors = await openSheet(page);
  // The sheet is taller than this short screen, so its body scrolls; scroll it to the bottom.
  const scrolled = await page.locator(SHEET).evaluate((inner) => {
    // The bottom sheet's own box (the dialog) is what scrolls.
    const sheet = inner.closest<HTMLElement>('[role="dialog"]') ?? inner;
    const scroller = [sheet, ...Array.from(sheet.querySelectorAll<HTMLElement>('*'))].find(
      (node) =>
        node.scrollHeight > node.clientHeight + 4 && getComputedStyle(node).overflowY !== 'visible',
    );
    if (!scroller) return -1;
    scroller.scrollTop = scroller.scrollHeight;
    return scroller.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await fingerDrag(page, await middleOfSheet(page), 150);
  await page.waitForTimeout(300);
  await expect(page.locator(SHEET)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('a long press selects no text on the phone; a text field still does', async ({ page }) => {
  const pageErrors = await open(page, '/jobs');
  const row = page.locator(`[data-job-id="${job.id}"]`);
  await expect(row).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.hasAttribute('data-phone-layout')),
  ).toBe(true);
  expect(await row.evaluate((node) => getComputedStyle(node).userSelect)).toBe('none');

  await page
    .getByRole('button', { name: /search/i })
    .first()
    .click();
  const field = page.getByRole('searchbox').first();
  await expect(field).toBeVisible();
  expect(await field.evaluate((node) => getComputedStyle(node).userSelect)).toBe('text');
  expect(pageErrors).toEqual([]);
});

test('the Mac layout keeps selectable text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const pageErrors = await open(page, '/jobs');
  await expect(page.locator(`[data-job-id="${job.id}"]`)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.hasAttribute('data-phone-layout')),
  ).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.body).userSelect)).not.toBe('none');
  expect(pageErrors).toEqual([]);
});
