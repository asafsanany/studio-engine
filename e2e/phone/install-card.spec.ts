// PH2: the Home Screen app, on the built server with the fake runner, in Chrome at iPhone 15 size
// (the `phone` project of playwright.config.ts), with the Phone switch on.
//
//   the card    "Add to Home Screen" shows in a browser tab, under the Jobs title, with its title,
//               three steps and two 44 px buttons; "Not now" and "Got it" put it away for 30 days
//               (29 days later it is still away, 31 days later it is back); it is not shown in the
//               Home Screen app, whether Safari says so (navigator.standalone) or the
//               display-mode: standalone media query matches (emulated: Chrome can't be started
//               as an installed app), not on a narrow window whose browser isn't an iPhone's, and
//               never on the Mac layout
//   the files   the manifest is served as application/manifest+json and Chrome reads it without
//               errors; the icons are the images themselves with a long cache, not the app's own
//               page; index.html links them, and the page is dark before its stylesheet arrives
//
// Safari's own Add to Home Screen is checked by hand in the iOS Simulator, not here. Nothing
// leaves the engine's origin.

import { type Browser, devices, expect, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';

const PHONE_SHELL = '[data-slot="phone-shell"]';
const INSTALL_CARD = '[data-slot="install-card"]';
const MAC_FRAME = '[data-slot="sidebar-wrapper"]';

/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
/** The localStorage key of the time the card was last put away (install-card.ts). */
const DISMISSED_KEY = 'studio.installCard.dismissedAt';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 4, review: false, phone: true });
});

test.afterAll(async () => {
  await engine?.stop();
});

async function engineVersion(): Promise<string> {
  const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  return health.version;
}

/**
 * Opens `path` in a browser that has already seen this version's "What's new" (a new browser is
 * greeted with it, and it blocks the page), and returns the page's errors so far, which every test
 * expects to be none.
 */
async function open(page: Page, path: string): Promise<string[]> {
  const version = await engineVersion();
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [LAST_SEEN_KEY, version],
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  return pageErrors;
}

/** Pretends the card was put away `daysAgo` days ago, then loads the Jobs page again (its home). */
async function dismissedDaysAgo(page: Page, daysAgo: number): Promise<void> {
  await page.evaluate(
    ([key, at]) => localStorage.setItem(key as string, String(at)),
    [DISMISSED_KEY, Date.now() - daysAgo * DAY_MS - 60_000],
  );
  await page.goto(`${engine.baseURL}/jobs`);
  await expect(page.locator(PHONE_SHELL)).toBeVisible();
}

/** A browser at the size of the design boards (390×844), as PH0's screenshots are taken. */
async function phoneContext(browser: Browser, userAgent = devices['iPhone 15'].userAgent) {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent,
  });
}

test.describe('the Add to Home Screen card', () => {
  test('shows in a browser tab: the title, the three steps and two buttons of 44 px', async ({
    page,
  }) => {
    const pageErrors = await open(page, '/jobs');
    const card = page.locator(INSTALL_CARD);

    await expect(page.locator(PHONE_SHELL)).toBeVisible();
    await expect(card).toBeVisible();
    await expect(
      card.getByRole('heading', { name: 'Put Studio Engine on your Home Screen' }),
    ).toBeVisible();
    await expect(card.getByRole('listitem')).toHaveText([
      /^1\s*Tap Share\s*in Safari$/,
      /^2\s*Tap Add to Home Screen$/,
      /^3\s*Open Studio Engine from its icon$/,
    ]);
    await expect(card.getByRole('img', { name: 'the Share icon' })).toBeVisible();
    for (const name of ['Not now', 'Got it']) {
      const box = await card.getByRole('button', { name }).boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
    }

    // It sits under the Jobs title (board MFirstOpen) and above the rows, not above the title.
    const title = await page.getByRole('heading', { name: 'Jobs', exact: true }).boundingBox();
    const cardBox = await card.boundingBox();
    expect(title).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect((cardBox?.y ?? 0) >= (title?.y ?? 0) + (title?.height ?? 0)).toBe(true);

    // The card sits inside the phone, with no sideways scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(pageErrors).toEqual([]);
  });

  test('“Not now” puts it away for 30 days, and “Got it” does the same', async ({ page }) => {
    const pageErrors = await open(page, '/jobs');
    const card = page.locator(INSTALL_CARD);
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: 'Not now' }).click();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toMatch(/^\d+$/);

    // Away after a reload, and on the other pages.
    await page.reload();
    await expect(page.locator(PHONE_SHELL)).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.goto(`${engine.baseURL}/settings`);
    await expect(page.locator('[data-slot="phone-settings-page"]')).toBeVisible();
    await expect(card).toHaveCount(0);

    // 29 days later it is still away; after 31 it is back.
    await dismissedDaysAgo(page, 29);
    await expect(card).toHaveCount(0);
    await dismissedDaysAgo(page, 31);
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: 'Got it' }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.locator(PHONE_SHELL)).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('is not shown in the Home Screen app: navigator.standalone', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    });
    const pageErrors = await open(page, '/jobs');

    await expect(page.locator(PHONE_SHELL)).toBeVisible();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await expect(page.locator(INSTALL_CARD)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('is not shown in the Home Screen app: the display-mode: standalone media query', async ({
    page,
  }) => {
    // Emulated: only that one query says yes, so the layout's own width query still works.
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (query: string): MediaQueryList => {
        if (query.replace(/\s/g, '') !== '(display-mode:standalone)') return real(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        };
      };
    });
    const pageErrors = await open(page, '/jobs');

    await expect(page.locator(PHONE_SHELL)).toBeVisible();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await expect(page.locator(INSTALL_CARD)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('is not shown on a narrow window whose browser is not an iPhone’s', async ({ browser }) => {
    const context = await phoneContext(browser, MAC_USER_AGENT);
    try {
      const page = await context.newPage();
      const pageErrors = await open(page, '/jobs');

      await expect(page.locator(PHONE_SHELL)).toBeVisible();
      await expect(page.locator(INSTALL_CARD)).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('is never shown on the Mac layout', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const pageErrors = await open(page, '/jobs');

    await expect(page.locator(MAC_FRAME)).toBeVisible();
    await expect(page.locator(PHONE_SHELL)).toHaveCount(0);
    await expect(page.locator(INSTALL_CARD)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('the card at 390×844, for the design check', async ({ browser }, testInfo: TestInfo) => {
    const version = await engineVersion();
    const context = await phoneContext(browser);
    try {
      const page = await context.newPage();
      await page.addInitScript(
        ([key, value]) => localStorage.setItem(key as string, value as string),
        [LAST_SEEN_KEY, version],
      );
      await page.goto(`${engine.baseURL}/jobs`);
      await expect(page.locator(INSTALL_CARD)).toBeVisible();
      await testInfo.attach('install-card-390x844.png', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    } finally {
      await context.close();
    }
  });
});

test.describe('the Home Screen app files', () => {
  test('the manifest is served as application/manifest+json, and Chrome reads it without errors', async ({
    page,
  }) => {
    await open(page, '/jobs');
    const link = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(link).toBe('/manifest.webmanifest');

    const response = await page.request.get(`${engine.baseURL}${link}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/manifest+json');
    expect(response.headers()['cache-control']).toBe('no-cache');

    const cdp = await page.context().newCDPSession(page);
    const parsed = (await cdp.send('Page.getAppManifest')) as {
      url?: string;
      errors: Array<{ message: string }>;
      data?: string;
    };
    expect(parsed.errors.map((error) => error.message)).toEqual([]);
    expect(parsed.url).toBe(`${engine.baseURL}/manifest.webmanifest`);
    const data = JSON.parse(parsed.data ?? '{}') as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    expect(data).toMatchObject({
      name: 'Studio Engine',
      short_name: 'Studio',
      display: 'standalone',
      start_url: '/jobs',
    });
    expect(data.icons.map((icon) => `${icon.sizes} ${icon.purpose ?? 'any'}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
  });

  test('the icons are the images themselves, with a long cache, not the app’s own page', async ({
    page,
  }) => {
    await open(page, '/jobs');
    const appleTouch = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect(appleTouch).toBe('/apple-touch-icon.png');

    for (const path of [appleTouch, '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']) {
      const response = await page.request.get(`${engine.baseURL}${path}`);
      expect(response.status(), String(path)).toBe(200);
      expect(response.headers()['content-type'], String(path)).toBe('image/png');
      expect(response.headers()['cache-control'], String(path)).toBe('public, max-age=2592000');
      const body = await response.body();
      expect([...body.subarray(0, 4)], String(path)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });

  test('the page is dark before its stylesheet arrives, and says so to the browser', async ({
    page,
  }) => {
    await page.route('**/*.css', (route) => route.abort());
    await open(page, '/jobs');

    const head = await page.evaluate(() => {
      const html = getComputedStyle(document.documentElement);
      const meta = (name: string) =>
        document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
      return {
        background: html.backgroundColor,
        colorScheme: html.colorScheme,
        themeColor: meta('theme-color'),
        colorSchemeMeta: meta('color-scheme'),
        capable: meta('apple-mobile-web-app-capable'),
        statusBar: meta('apple-mobile-web-app-status-bar-style'),
        title: meta('apple-mobile-web-app-title'),
      };
    });
    expect(head).toEqual({
      background: 'rgb(9, 9, 11)',
      colorScheme: 'dark',
      themeColor: '#09090B',
      colorSchemeMeta: 'dark',
      capable: 'yes',
      statusBar: 'black-translucent',
      title: 'Studio Engine',
    });
  });
});
