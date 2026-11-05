// PH0: the Phone switch and the phone shell, on the built server with the fake runner, in Chrome at
// iPhone 15 size (the `phone` project of playwright.config.ts). Each describe has an engine of its
// own, so the switch can be on in one and off in the other:
//
//   switch on   the phone shell shows (not the sidebar), with the jobs page's stub; /settings is the
//               phone Settings stub; a page with no phone layout yet (Analytics) sits under a "‹ Back"
//               header whose button is at least 44 px tall and goes back to Jobs
//   wide window with the switch on, the same engine: the Mac layout, and /settings leads to /jobs
//   switch off  the Mac layout at the same size: the sidebar frame and the Jobs page, no phone
//               shell, and /settings leads to /jobs
//
// What the stubs say is not tested (they are replaced); what is, is which layout shows. Nothing
// leaves the engine's origin.

import { type Browser, devices, expect, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';

const PHONE_SHELL = '[data-slot="phone-shell"]';
const MAC_FRAME = '[data-slot="sidebar-wrapper"]';

/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';

/**
 * Opens `path` in a browser that has already seen this version's "What's new" (a new browser is
 * greeted with it, and it blocks the page), and returns the page's errors so far, which every test
 * expects to be none.
 */
async function open(page: Page, engine: Engine, path: string): Promise<string[]> {
  const { version } = (await healthOf(engine)) as { version: string };
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [LAST_SEEN_KEY, version],
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  return pageErrors;
}

/**
 * Screenshots of the phone pages at 390×844, the size of the design boards, attached to the report
 * (the HTML report of `pnpm e2e`, or `--reporter=json`). Each is taken in a context of its own at
 * that size: resizing the page's own window under mobile emulation makes Chrome tile the picture.
 */
async function shoot(
  browser: Browser,
  engine: Engine,
  testInfo: TestInfo,
  shots: ReadonlyArray<{ path: string; ready: string; name: string }>,
): Promise<void> {
  const { version } = (await healthOf(engine)) as { version: string };
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: devices['iPhone 15'].userAgent,
    });
    try {
      const page = await context.newPage();
      await page.addInitScript(
        ([key, value]) => localStorage.setItem(key as string, value as string),
        [LAST_SEEN_KEY, version],
      );
      await page.goto(`${engine.baseURL}${shot.path}`);
      await expect(page.locator(shot.ready)).toBeVisible();
      await testInfo.attach(`${shot.name}-390x844.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    } finally {
      await context.close();
    }
  }
}

async function healthOf(engine: Engine): Promise<unknown> {
  return (await fetch(`${engine.baseURL}/api/health`)).json();
}

test.describe('with the Phone switch on', () => {
  let engine: Engine;

  test.beforeAll(async () => {
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: 4, review: false, phone: true });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('the engine says so, and a phone-width window shows the phone shell, not the sidebar', async ({
    page,
  }) => {
    expect(await healthOf(engine)).toMatchObject({ phone: true });
    const pageErrors = await open(page, engine, '/jobs');

    await expect(page.locator(PHONE_SHELL)).toBeVisible();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await expect(page.locator(MAC_FRAME)).toHaveCount(0);
    // No Back header on a phone page; the tab bar (PH18) is in its slot at the bottom.
    await expect(page.locator('[data-slot="phone-back-header"]')).toHaveCount(0);
    await expect(
      page.locator('[data-slot="phone-tab-bar-slot"] [data-slot="phone-tab-bar"]'),
    ).toBeVisible();

    // The page reaches under the notch (index.html), so the shell's safe-area insets have a value.
    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewportMeta).toContain('viewport-fit=cover');

    // The page fits the phone: no sideways scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    expect(pageErrors).toEqual([]);
  });

  test('"/" is the phone jobs page too, and /settings is the phone Settings page', async ({
    page,
  }) => {
    const pageErrors = await open(page, engine, '/');
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();

    await page.goto(`${engine.baseURL}/settings`);
    await expect(page.locator('[data-slot="phone-settings-page"]')).toBeVisible();
    await expect(page.locator(MAC_FRAME)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/settings');

    // The stub's way back is a link to the jobs list.
    await page.locator('[data-slot="phone-settings-page"] a').click();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('a page with no phone layout yet sits under a Back header that leads back', async ({
    page,
  }) => {
    const pageErrors = await open(page, engine, '/analytics');
    const header = page.locator('[data-slot="phone-back-header"]');
    await expect(page.locator(PHONE_SHELL)).toBeVisible();
    await expect(header).toBeVisible();
    // The Mac's Analytics page is inside the shell.
    await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
    await expect(page.locator(MAC_FRAME)).toHaveCount(0);

    const back = header.getByRole('button', { name: 'Back' });
    const box = await back.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Opened directly, there is no history to go back to inside the app: Back goes to Jobs.
    await back.click();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/jobs');
    expect(pageErrors).toEqual([]);
  });

  test('the phone pages at 390×844, for the design check', async ({ browser }, testInfo) => {
    await shoot(browser, engine, testInfo, [
      { path: '/jobs', ready: '[data-slot="phone-jobs-page"]', name: 'phone-jobs' },
      { path: '/settings', ready: '[data-slot="phone-settings-page"]', name: 'phone-settings' },
      { path: '/analytics', ready: '[data-slot="phone-back-header"]', name: 'phone-back-header' },
    ]);
  });

  test('a wide window keeps the Mac layout, and /settings leads to /jobs', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors = await open(page, engine, '/settings');

    await expect(page.locator(MAC_FRAME)).toBeVisible();
    await expect(page.locator(PHONE_SHELL)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/jobs');
    await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});

test.describe('with the Phone switch off', () => {
  let engine: Engine;

  test.beforeAll(async () => {
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: 4, review: false, phone: false });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('a phone-width window keeps the Mac layout, as before', async ({ page }) => {
    expect(await healthOf(engine)).toMatchObject({ phone: false });
    const pageErrors = await open(page, engine, '/jobs');

    await expect(page.locator(MAC_FRAME)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();
    await expect(page.locator(PHONE_SHELL)).toHaveCount(0);
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('/settings leads to /jobs, and a client page has no Back header', async ({ page }) => {
    const pageErrors = await open(page, engine, '/settings');
    await expect(page.locator(MAC_FRAME)).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/jobs');

    await page.goto(`${engine.baseURL}/money`);
    await expect(page.locator(MAC_FRAME)).toBeVisible();
    await expect(page.locator('[data-slot="phone-back-header"]')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
