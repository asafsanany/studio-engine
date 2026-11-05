// PH5: the phone Settings page, "What's new" as a bottom sheet and "Can't reach your Mac", on the
// built server with the fake runner, in Chrome at the design boards' size (390×844, touch, an
// iPhone user agent; the `phone` project of playwright.config.ts). Nothing leaves the engine's
// origin.
//
//   Settings        the gear's page: back link, "This phone" (connected, over Tailscale, the
//                   address this page was opened at) and "About" (What's new, the version)
//   What's new      a bottom sheet (700 px at most) with the same notes newest first and one "Got it",
//                   opened on launch for releases not seen yet and from Settings; a release's
//                   screenshot fills the screen on black when tapped, and tapping again closes it
//   Can't reach     when the engine is out of reach for more than 5 s the page is replaced by the
//                   message, with "Try again" and when it last answered; it goes away by itself when
//                   the engine answers again, and the page underneath is as it was
//
// The pages of the four design boards (MSettingsBasic, MWhatsNew, MWhatsNewShot, MOffline) are
// attached to the report as <name>-390x844.png, and written to $PHONE_SHOTS_DIR when it is set.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { startProxy } from '../support/tcp-proxy.ts';

/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';

/** The size of the design boards. */
const BOARD = { width: 390, height: 844 };

test.use({ viewport: BOARD });

let engine: Engine;
let version: string;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 4, review: false, phone: true });
  version = ((await (await fetch(`${engine.baseURL}/api/health`)).json()) as { version: string })
    .version;
});

test.afterAll(async () => {
  await engine?.stop();
});

/**
 * Opens `path` in a browser that has seen the notes up to `lastSeen` (default: this version, so no
 * sheet greets it), and returns the page's errors so far, which every test expects to be none.
 * `base` is where the engine is reached (default: directly).
 */
async function open(
  page: Page,
  path: string,
  lastSeen = version,
  base = engine.baseURL,
): Promise<string[]> {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [LAST_SEEN_KEY, lastSeen],
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}${path}`);
  return pageErrors;
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

/** Whether version `a` ("v0.13.1") is newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const left = a.slice(1).split('.').map(Number);
  const right = b.slice(1).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((left[i] as number) !== (right[i] as number))
      return (left[i] as number) > (right[i] as number);
  }
  return false;
}

const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('Settings', () => {
  test('the gear’s page: back link, this phone, the address, About and the version', async ({
    page,
  }, testInfo) => {
    const pageErrors = await open(page, '/settings');
    const settings = page.locator('[data-slot="phone-settings-page"]');
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    // "‹ Jobs" is at least 44 px tall and leads back to the jobs list.
    const back = settings.getByRole('link', { name: 'Jobs' });
    expect((await back.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    await expect(settings.getByText('Connected to your Mac')).toBeVisible();
    await expect(settings.getByText('Over Tailscale, only your devices')).toBeVisible();
    await expect(settings.getByRole('img', { name: 'Connected' })).toBeVisible();
    // The address is the one this page was opened at.
    await expect(settings.getByText(new URL(engine.baseURL).host)).toBeVisible();
    await expect(settings.getByRole('button', { name: 'What’s new' })).toBeVisible();
    await expect(settings.getByText('Version')).toBeVisible();
    await expect(settings.getByText(version, { exact: true })).toBeVisible();

    // Nothing is reserved on screen for the notifications section yet.
    const slot = settings.locator('[data-slot="phone-settings-notifications"]');
    await expect(slot).toBeHidden();

    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await shoot(page, testInfo, 'phone-settings-basic');

    await back.click();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/jobs');
    expect(pageErrors).toEqual([]);
  });
});

test.describe('What’s new', () => {
  test('the Settings row opens this version’s notes as a bottom sheet; Got it and Esc close it', async ({
    page,
  }) => {
    const pageErrors = await open(page, '/settings');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'What’s new' }).click();
    const sheet = page.getByRole('dialog', { name: /^What.s new$/ });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(`v${version}`);

    // A bottom sheet: it sits on the bottom edge, full width, no taller than 700 px.
    await expect
      .poll(async () => {
        const box = await sheet.boundingBox();
        return box === null ? null : Math.round(box.y + box.height);
      })
      .toBe(BOARD.height);
    const box = await sheet.boundingBox();
    expect(Math.round(box?.x ?? -1)).toBe(0);
    expect(Math.round(box?.width ?? 0)).toBe(BOARD.width);
    expect(box?.height ?? 0).toBeLessThanOrEqual(700);

    // One way to dismiss it: "Got it", a button at least 44 px tall and as wide as the sheet. The
    // only other button a release may bring is its screenshot's "<alt>: enlarge" (0.15.0 has one).
    await expect(sheet.getByRole('button', { name: 'Got it' })).toHaveCount(1);
    await expect(sheet.getByRole('button', { name: /^(?!Got it$)(?!.*: enlarge$)/ })).toHaveCount(
      0,
    );
    const gotIt = sheet.getByRole('button', { name: 'Got it' });
    expect((await gotIt.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await gotIt.click();
    await expect(sheet).toBeHidden();

    // Esc closes it too.
    await page.getByRole('button', { name: 'What’s new' }).click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('releases not seen yet open on launch, newest first; a screenshot fills the screen on a tap', async ({
    page,
  }, testInfo) => {
    // Seen up to 0.12.12: everything after it is new, including 0.13.0, which has a screenshot.
    const pageErrors = await open(page, '/jobs', '0.12.12');
    const sheet = page.getByRole('dialog', { name: /^What.s new$/ });
    await expect(sheet).toBeVisible();

    const badges = await sheet
      .locator('[data-slot="whats-new-release"] h3 [data-slot="badge"]')
      .allTextContents();
    expect(badges.length).toBeGreaterThan(1);
    expect(badges[0]).toBe(`v${version}`);
    expect(badges).toContain('v0.13.0');
    for (let i = 1; i < badges.length; i++) {
      expect(
        isNewer(badges[i - 1] as string, badges[i] as string),
        `${badges[i - 1]} before ${badges[i]}`,
      ).toBe(true);
    }
    // Wait for it to finish sliding up before measuring or shooting it.
    await expect
      .poll(async () => {
        const settled = await sheet.boundingBox();
        return settled === null ? null : Math.round(settled.y + settled.height);
      })
      .toBe(BOARD.height);
    const box = await sheet.boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual(700);
    await shoot(page, testInfo, 'phone-whats-new');

    // The screenshot: full width in the sheet, with an expand mark.
    const shot = sheet.getByRole('button', { name: /What changed in version 0\.13\.0: enlarge/ });
    await shot.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await expect(shot.locator('[data-slot="whats-new-expand"]')).toBeVisible();
    await shoot(page, testInfo, 'phone-whats-new-scrolled');
    const inSheet = await shot.boundingBox();
    expect(Math.round(inSheet?.width ?? 0)).toBeGreaterThanOrEqual(BOARD.width - 40);

    // Tapped, it fills the screen on black; tapped again, it closes, and the sheet is still there.
    await shot.click();
    const zoom = page.getByRole('dialog', { name: 'What changed in version 0.13.0' });
    await expect(zoom).toBeVisible();
    await expect
      .poll(async () => {
        const zoomBox = await zoom.boundingBox();
        return zoomBox === null
          ? null
          : [zoomBox.x, zoomBox.y, zoomBox.width, zoomBox.height].map(Math.round);
      })
      .toEqual([0, 0, BOARD.width, BOARD.height]);
    expect(await zoom.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      'rgb(0, 0, 0)',
    );
    await expect(zoom).toContainText('Tap to close');
    await shoot(page, testInfo, 'phone-whats-new-shot');

    await page.touchscreen.tap(BOARD.width / 2, BOARD.height / 2);
    await expect(zoom).toBeHidden();
    await expect(sheet).toBeVisible();

    // "Got it" closes the sheet and remembers this version, so the next launch shows nothing.
    await sheet.getByRole('button', { name: 'Got it' }).click();
    await expect(sheet).toBeHidden();
    expect(await page.evaluate((key) => localStorage.getItem(key), LAST_SEEN_KEY)).toBe(version);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Can’t reach your Mac', () => {
  /** The proxy of the test being run, closed afterwards. */
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;

  test.beforeEach(async () => {
    proxy = await startProxy(new URL(engine.baseURL));
  });

  test.afterEach(async () => {
    await proxy?.close();
  });

  test('after 5 s without the engine the page is replaced by the message; it goes away by itself', async ({
    page,
  }, testInfo) => {
    const via = proxy as NonNullable<typeof proxy>;
    const pageErrors = await open(page, '/jobs', version, via.url);
    const jobs = page.locator('[data-slot="phone-jobs-page"]');
    const offline = page.locator('[data-slot="phone-offline"]');
    await expect(jobs).toBeVisible();
    await expect(offline).toHaveCount(0);
    // The events stream must be up before the Mac "goes away", or there is nothing to break.
    await page.waitForTimeout(1_000);

    const away = Date.now();
    await via.cut();

    // Not at once, and not after 2 s either (that is only the Mac layout's small notice) ...
    await page.waitForTimeout(3_000);
    await expect(offline).toHaveCount(0);
    // ... but once the engine has been away for more than 5 s.
    await expect(offline).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - away).toBeGreaterThanOrEqual(5_000);

    await expect(offline.getByRole('heading', { name: 'Can’t reach your Mac' })).toBeVisible();
    await expect(
      offline.getByText(
        'Studio Engine runs on your Mac. Check that the Mac is awake and that Tailscale is on, on the Mac and on this phone.',
      ),
    ).toBeVisible();
    await expect(offline.getByText(/^Last connected today at \d\d:\d\d$/)).toBeVisible();
    // The page is not shown stale underneath: it is hidden, not gone.
    await expect(jobs).toBeHidden();
    await expect(jobs).toHaveCount(1);
    const tryAgain = offline.getByRole('button', { name: 'Try again' });
    expect((await tryAgain.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await shoot(page, testInfo, 'phone-offline');

    // "Try again" shows that it tried, and the screen stays while the Mac is still away.
    await tryAgain.click();
    await expect(offline.getByRole('button', { name: 'Trying…' })).toBeVisible();
    await expect(offline.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(offline).toBeVisible();

    // The Mac is back: the events stream finds it again and the page returns by itself.
    await via.restore();
    await expect(offline).toHaveCount(0, { timeout: 15_000 });
    await expect(jobs).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('a break of a second or two never shows the message', async ({ page }) => {
    const via = proxy as NonNullable<typeof proxy>;
    // Remember whether the message ever appeared, not only whether it is there at the end.
    await page.addInitScript(() => {
      const w = window as unknown as { sawOffline: boolean };
      w.sawOffline = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-slot="phone-offline"]')) w.sawOffline = true;
      }).observe(document, { childList: true, subtree: true });
    });
    const pageErrors = await open(page, '/jobs', version, via.url);
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await page.waitForTimeout(1_000);

    await via.cut();
    await page.waitForTimeout(1_000);
    await via.restore();
    // The events stream finds the engine again within a few seconds; give it, and the 5 s, time.
    await page.waitForTimeout(7_000);

    expect(
      await page.evaluate(() => (window as unknown as { sawOffline: boolean }).sawOffline),
    ).toBe(false);
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
