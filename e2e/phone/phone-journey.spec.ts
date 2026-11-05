// PH7: Mobile 1 from start to finish, on the built server with the fake runner, in Chrome at the
// design boards' size (390×844, touch, an iPhone user agent; the `phone` project of
// playwright.config.ts). The engine is started with the Phone switch left alone, so every test here
// also proves the layout is on by default. Nothing leaves the engine's origin.
//
//   the walk            the list with its tabs and counts, View (By client off and on, Show
//                       archived), search with the archived line, a sheet opened from a row that a
//                       reload keeps, Effort changed in it, Retry of a failed job, and a swipe down
//                       on the grabber that closes it (a short one springs back)
//   a queue that waits  Hold, then Release, from the sheet of a queued row; the engine going away:
//                       the quiet "Reconnecting" line after 2 s, "Can't reach your Mac" after 5 s,
//                       and the page coming back by itself
//   first paint         the Mac layout never shows on the way to the phone layout (the engine's
//                       answer is held back), and a second visit starts in the phone layout at once
//   safe areas          Chrome's emulated notch and home indicator (47 px and 34 px, the board's
//                       status bar and home indicator): the header stays under the notch while the
//                       rows scroll, the sheets clear the home indicator, and a sheet opened with
//                       the page (a notification's address) does not squeeze the page behind it
//
// 390×844 and 430×932 screenshots are attached to the report, and written to $PHONE_SHOTS_DIR when
// it is set (a folder for each size).

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { devices, expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { action, badge, rowOf } from '../support/jobs-ui.ts';
import { startProxy } from '../support/tcp-proxy.ts';

const PHONE_SHELL = '[data-slot="phone-shell"]';
const MAC_FRAME = '[data-slot="sidebar-wrapper"]';
const PAGE = '[data-slot="phone-jobs-page"]';
const SHEET = '[data-slot="phone-job-sheet"]';
const GRABBER = '[data-slot="sheet-grabber"]';

/** The localStorage keys of the web app: "What's new" seen, the Add to Home Screen card away. */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

const WAIT = { timeout: 90_000 };

// The size of the design boards; the screenshots are of it.
test.use({ viewport: { width: 390, height: 844 } });

const SIZES = [
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

interface JobOnServer {
  id: string;
  clientId: string;
  client: string;
  name: string;
  state: string;
  effort: string | null;
  archivedAt: string | null;
}

async function jobsOf(engine: Engine): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

async function jobNamed(engine: Engine, name: string): Promise<JobOnServer> {
  const job = (await jobsOf(engine)).find((candidate) => candidate.name === name);
  if (job === undefined) throw new Error(`no job named ${name}`);
  return job;
}

async function follow(
  engine: Engine,
  name: string,
  until: (job: JobOnServer) => boolean,
): Promise<JobOnServer> {
  let last: JobOnServer | undefined;
  await expect
    .poll(async () => {
      last = (await jobsOf(engine)).find((candidate) => candidate.name === name);
      return last !== undefined && until(last);
    }, WAIT)
    .toBe(true);
  if (last === undefined) throw new Error(`no job named ${name}`);
  return last;
}

async function post(engine: Engine, path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${engine.baseURL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, `POST ${path}: ${await response.clone().text()}`).toBeLessThan(300);
}

async function versionOf(engine: Engine): Promise<string> {
  const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  return health.version;
}

/**
 * Opens `path` in a browser that has already seen this version's "What's new" and, unless
 * `installCard` is set, put the Add to Home Screen card away (a new browser is greeted with both).
 * Returns the page's errors so far, which every test expects to be none. `base` is where the
 * engine is reached (default: directly).
 */
async function open(
  page: Page,
  engine: Engine,
  path = '/jobs',
  base = engine.baseURL,
  { installCard = false }: { installCard?: boolean } = {},
): Promise<string[]> {
  const version = await versionOf(engine);
  await page.addInitScript(
    ([seen, version, card, away]) => {
      localStorage.setItem(seen as string, version as string);
      if (away) localStorage.setItem(card as string, String(Date.now()));
    },
    [LAST_SEEN_KEY, version, INSTALL_CARD_KEY, !installCard],
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}${path}`);
  return pageErrors;
}

/** The page and its first rows are there. */
async function listed(page: Page): Promise<void> {
  await expect(page.locator(PHONE_SHELL)).toBeVisible();
  await expect(page.locator(PAGE)).toBeVisible();
  await expect(page.locator('[data-job-id]').first()).toBeVisible(WAIT);
}

/**
 * The words of each tab with its count ("Review 1"), in order. Found by role in the markup, not by
 * the accessibility tree: behind a modal sheet the page is `aria-hidden`.
 */
async function tabs(page: Page): Promise<string[]> {
  return (await page.locator('[role="tab"]').allInnerTexts()).map((text) =>
    text.replace(/\s+/g, ' ').trim(),
  );
}

const rows = (page: Page) => page.locator('[data-job-id]');
const sections = (page: Page) => page.locator(`${PAGE} section:not([data-slot="install-card"])`);
const viewSheet = (page: Page) => page.getByRole('dialog', { name: 'View' });
const pillOf = (page: Page): Locator => page.locator(`${SHEET} [data-slot="job-sheet-status"]`);
const bigButton = (page: Page): Locator => page.locator(`${SHEET} [data-sheet-action]`);
const menuRow = (page: Page, id: string): Locator =>
  page.locator(`${SHEET} [data-menu-row="${id}"]`);

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'the element is on the page').not.toBeNull();
  return box as { x: number; y: number; width: number; height: number };
}

/** Attaches a screenshot to the report, and writes it to $PHONE_SHOTS_DIR/<size>/ if set. */
async function shoot(page: Page, name: string, testInfo: TestInfo) {
  const size = page.viewportSize() as { width: number; height: number };
  const label = `${size.width}x${size.height}`;
  const body = await page.screenshot();
  await testInfo.attach(`${name}-${label}.png`, { body, contentType: 'image/png' });
  const dir = process.env.PHONE_SHOTS_DIR;
  if (dir) {
    await mkdir(join(dir, label), { recursive: true });
    await writeFile(join(dir, label, `${name}-${label}.png`), body);
  }
}

/** Drags the sheet's grabber `dy` px down in `steps` moves, and lets go. */
async function swipeDown(page: Page, dy: number, steps = 8): Promise<void> {
  const grabber = await boxOf(page.locator(`${SHEET} ${GRABBER}`).first());
  const x = grabber.x + grabber.width / 2;
  const y = grabber.y + grabber.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) await page.mouse.move(x, y + (dy * step) / steps);
  await page.mouse.up();
}

test.describe('the walk, with the switch at its default', () => {
  let engine: Engine;
  let brokenDir: string;

  const CLIENT = { latin: 'Acme', hebrew: 'דוד לוי' } as const;
  const JOB = {
    spring: 'Spring promo',
    broken: 'Broken render',
    six: 'Myth or fact 6',
    five: 'Myth or fact 5',
  } as const;

  test.beforeAll(async () => {
    // No `phone` option: the engine's own default is what is under test.
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: 20, review: false });
    // One at a time, each waited for until the engine lists it (see PH3's hand-off).
    const toMake: ReadonlyArray<readonly [client: string, job: string, failAt?: string]> = [
      [CLIENT.latin, JOB.spring],
      [CLIENT.hebrew, JOB.six],
      [CLIENT.hebrew, JOB.five],
      [CLIENT.latin, JOB.broken, 'render'],
    ];
    for (const [client, job, failAt] of toMake) {
      const dir = await engine.createJob({ client, job, failAt });
      if (job === JOB.broken) brokenDir = dir;
      await follow(engine, job, () => true);
    }
    await follow(engine, JOB.spring, (job) => job.state === 'ready');
    await follow(engine, JOB.six, (job) => job.state === 'ready');
    await follow(engine, JOB.five, (job) => job.state === 'ready');
    await follow(engine, JOB.broken, (job) => job.state === 'failed');

    // Delivered; and Paid and archived.
    await post(engine, `/api/jobs/${(await jobNamed(engine, JOB.six)).id}/deliver`);
    const five = await jobNamed(engine, JOB.five);
    await post(engine, `/api/jobs/${five.id}/deliver`);
    await post(engine, '/api/payments', { jobIds: [five.id], paidOn: '2026-10-14' });
    await post(engine, '/api/jobs/archive', { ids: [five.id] });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('the list, View, search, a sheet from a row, Effort, Retry and a swipe down', async ({
    page,
  }, testInfo) => {
    expect(await (await fetch(`${engine.baseURL}/api/health`)).json()).toMatchObject({
      phone: true,
    });
    const pageErrors = await open(page, engine);
    await listed(page);
    await expect(page.locator(MAC_FRAME)).toHaveCount(0);

    await test.step('the list: the eight tabs with their counts, and a tab filters', async () => {
      expect(await tabs(page)).toEqual([
        'All 3',
        'In progress 0',
        'Review 0',
        'Approved 1',
        'Delivered 1',
        'Uploaded 0',
        'Paid 0',
        'Needs attention 1',
      ]);
      await page.getByRole('tab', { name: /^Needs attention/ }).tap();
      await expect(rows(page)).toHaveCount(1);
      await expect(rowOf(page, JOB.broken)).toBeVisible();
      await page.getByRole('tab', { name: /^All/ }).tap();
      await expect(rows(page)).toHaveCount(3);
      await shoot(page, 'phone-jobs', testInfo);
    });

    await test.step('View: By client off and on, and Show archived', async () => {
      await page.getByRole('button', { name: 'View', exact: true }).tap();
      const sheet = viewSheet(page);
      await expect(sheet).toBeVisible();
      await shoot(page, 'phone-jobs-view', testInfo);

      await expect(sections(page)).toHaveCount(2);
      await sheet.getByRole('switch', { name: /^By client/ }).tap();
      await expect(sections(page)).toHaveCount(0);
      await expect(rowOf(page, JOB.spring)).toContainText(`${CLIENT.latin} · `);
      await sheet.getByRole('switch', { name: /^By client/ }).tap();
      await expect(sections(page)).toHaveCount(2);

      await sheet.getByRole('switch', { name: /^Show archived/ }).tap();
      await expect(rows(page)).toHaveCount(4);
      await expect(rowOf(page, JOB.five)).toHaveAttribute('data-archived', '');
      await expect.poll(async () => (await tabs(page))[0]).toBe('All 4');
      await sheet.getByRole('button', { name: 'Close' }).tap();
      await expect(sheet).toBeHidden();

      // Remembered: the same after a reload. Then put it back.
      await page.reload();
      await listed(page);
      await expect(rows(page)).toHaveCount(4);
      await page.getByRole('button', { name: 'View', exact: true }).tap();
      await viewSheet(page)
        .getByRole('switch', { name: /^Show archived/ })
        .tap();
      await expect(rows(page)).toHaveCount(3);
      await viewSheet(page).getByRole('button', { name: 'Close' }).tap();
    });

    await test.step('search: Hebrew names, and the archived line', async () => {
      await page.getByRole('button', { name: 'Search jobs and clients' }).tap();
      const field = page.getByRole('searchbox', { name: 'Search jobs and clients' });
      await field.fill('Myth');
      await expect(rows(page)).toHaveCount(1);
      await expect(rowOf(page, JOB.six)).toBeVisible();
      await expect(page.getByText('1 more archived ·')).toBeVisible();
      await shoot(page, 'phone-jobs-search', testInfo);
      await page.getByRole('button', { name: 'Search jobs and clients' }).tap();
      await expect(page.locator('input[type="search"]')).toHaveCount(0);
      await expect(rows(page)).toHaveCount(3);
    });

    const broken = await jobNamed(engine, JOB.broken);

    await test.step('a sheet from a row: the address keeps it through a reload', async () => {
      await page.getByRole('button', { name: `Open ${JOB.broken}` }).tap();
      await expect.poll(() => new URL(page.url()).searchParams.get('job')).toBe(broken.id);
      await expect(page.locator(SHEET)).toBeVisible();
      await expect(pillOf(page)).toHaveText('Failed at Render');
      await page.reload();
      await expect(page.locator(SHEET)).toBeVisible();
      await expect(pillOf(page)).toHaveText('Failed at Render');
      await page.waitForTimeout(450);
      await shoot(page, 'phone-job-sheet', testInfo);
    });

    await test.step('Effort changed in the sheet is saved by the engine', async () => {
      await menuRow(page, 'effort').tap();
      const group = page.locator(SHEET).getByRole('radiogroup', { name: 'Effort' });
      await group.getByRole('radio', { name: /^High/ }).tap();
      await expect(menuRow(page, 'effort')).toContainText('High');
      await expect.poll(async () => (await jobNamed(engine, JOB.broken)).effort).toBe('high');
    });

    await test.step('a short drag on the grabber springs back; a long one closes the sheet', async () => {
      await swipeDown(page, 30, 6);
      await page.waitForTimeout(400);
      await expect(page.locator(SHEET)).toBeVisible();
      await expect
        .poll(() => page.getByRole('dialog').evaluate((sheet) => getComputedStyle(sheet).transform))
        .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

      await swipeDown(page, 180);
      await expect(page.locator(SHEET)).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get('job')).toBeNull();
    });

    await test.step('Retry of the failed job from its sheet', async () => {
      // The marker goes, so the render works the second time.
      await rm(join(brokenDir, '.fail-at-render'), { force: true });
      await page.getByRole('button', { name: `Open ${JOB.broken}` }).tap();
      await expect(bigButton(page)).toHaveText('Retry from Render');
      await bigButton(page).tap();
      await expect(pillOf(page)).not.toHaveText(/^Failed/);
      await follow(engine, JOB.broken, (job) => job.state === 'ready');
      await expect(pillOf(page)).toHaveText('Approved');
      await page.getByRole('button', { name: 'Close' }).first().tap();
      await expect(page.locator(SHEET)).toHaveCount(0);
      const row = rowOf(page, JOB.broken);
      await expect(badge(row, 'Approved')).toBeVisible();
      // An Approved row's next step is Share (PH15).
      await expect(action(row, 'Share video')).toBeVisible();
    });

    await test.step('Archive from a sheet is said out loud, with Undo (the page draws the toaster)', async () => {
      await page.getByRole('button', { name: `Open ${JOB.spring}` }).tap();
      await expect(page.locator(SHEET)).toBeVisible();
      await menuRow(page, 'archive').tap();
      const message = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: `Archived “${JOB.spring}”` });
      await expect(message).toBeVisible();
      await expect.poll(async () => (await jobNamed(engine, JOB.spring)).archivedAt).not.toBeNull();
      await message.getByRole('button', { name: 'Undo' }).tap();
      await expect.poll(async () => (await jobNamed(engine, JOB.spring)).archivedAt).toBeNull();
    });

    expect(pageErrors).toEqual([]);
  });

  for (const size of SIZES) {
    test(`the list and a sheet fit a ${size.width}×${size.height} phone`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['iPhone 15'].userAgent,
      });
      try {
        const page = await context.newPage();
        const pageErrors = await open(page, engine);
        await listed(page);
        const overflow = () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
        expect(await overflow()).toBeLessThanOrEqual(0);
        await shoot(page, 'size-jobs', testInfo);

        const job = await jobNamed(engine, JOB.spring);
        await page.goto(`${engine.baseURL}/jobs?job=${job.id}`);
        await expect(page.locator(SHEET)).toBeVisible();
        await page.waitForTimeout(450);
        expect(await overflow()).toBeLessThanOrEqual(0);
        const sheet = await boxOf(page.getByRole('dialog'));
        expect(sheet.x).toBe(0);
        expect(sheet.width).toBe(size.width);
        expect(Math.round(sheet.y + sheet.height)).toBe(size.height);
        await shoot(page, 'size-job-sheet', testInfo);
        expect(pageErrors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('first paint: the Mac layout never shows, and a second visit starts in the phone layout', async ({
    page,
  }) => {
    const version = await versionOf(engine);
    await page.addInitScript(
      ([seen, version, card]) => {
        localStorage.setItem(seen as string, version as string);
        localStorage.setItem(card as string, String(Date.now()));
        const w = window as unknown as { sawMac: boolean };
        w.sawMac = false;
        new MutationObserver(() => {
          if (document.querySelector('[data-slot="sidebar-wrapper"]')) w.sawMac = true;
        }).observe(document, { childList: true, subtree: true });
      },
      [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
    );
    // The engine's answer to /api/health is held back, as a slow connection holds it.
    await page.route('**/api/health', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    const sawMac = () => page.evaluate(() => (window as unknown as { sawMac: boolean }).sawMac);

    // Never visited: a dark page for the moment the answer takes, then the phone layout.
    await page.goto(engine.baseURL);
    await expect(page.locator('[data-slot="layout-pending"]')).toBeVisible();
    await expect(page.locator(PHONE_SHELL)).toBeVisible(WAIT);
    expect(await sawMac()).toBe(false);

    // Visited: the last answer was kept, so the phone layout is there before the next one is.
    const asked = Date.now();
    await page.reload();
    await expect(page.locator(PHONE_SHELL)).toBeVisible({ timeout: 1_000 });
    expect(Date.now() - asked).toBeLessThan(1_500);
    expect(await sawMac()).toBe(false);
    await expect(page.locator(MAC_FRAME)).toHaveCount(0);
  });

  test('a wide window never waits for the engine to answer: the Mac layout at once', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route('**/api/health', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await open(page, engine);
    await expect(page.locator(MAC_FRAME)).toBeVisible({ timeout: 1_000 });
    await expect(page.locator('[data-slot="layout-pending"]')).toHaveCount(0);
  });

  test.describe('safe areas (Chrome’s emulated notch: 47 px on top, 34 px at the bottom)', () => {
    async function withInsets(page: Page): Promise<void> {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 47, bottom: 34, left: 0, right: 0 },
      });
    }

    test('the header clears the notch and stays under it while the rows scroll', async ({
      page,
    }) => {
      await withInsets(page);
      // Short enough that the four rows scroll.
      await page.setViewportSize({ width: 390, height: 420 });
      const pageErrors = await open(page, engine);
      await listed(page);

      const heading = await boxOf(page.getByRole('heading', { name: 'Jobs', exact: true }));
      expect(heading.y).toBeGreaterThanOrEqual(47);

      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(300);
      const top = page.locator('[data-slot="phone-jobs-top"]');
      expect((await boxOf(top)).y).toBeCloseTo(47, 0);
      // Nothing scrolls through the notch's strip: what is there is the stuck header's cover.
      const covered = await page.evaluate(() =>
        Boolean(document.elementFromPoint(195, 20)?.closest('[data-slot="phone-jobs-top"]')),
      );
      expect(covered).toBe(true);
      expect(pageErrors).toEqual([]);
    });

    test('the View sheet and the job sheet clear the home indicator', async ({ page }) => {
      await withInsets(page);
      const pageErrors = await open(page, engine);
      await listed(page);

      await page.getByRole('button', { name: 'View', exact: true }).tap();
      const view = viewSheet(page);
      await expect(view).toBeVisible();
      await page.waitForTimeout(450);
      const padding = (sheet: Locator) =>
        sheet.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingBottom));
      expect(await padding(view)).toBeGreaterThanOrEqual(34);
      await view.getByRole('button', { name: 'Close' }).tap();

      // The job sheet is at the bottom edge with the same room under its content.
      const job = await jobNamed(engine, JOB.spring);
      await page.goto(`${engine.baseURL}/jobs?job=${job.id}`);
      await expect(page.locator(SHEET)).toBeVisible();
      await page.waitForTimeout(450);
      const sheetBox = await boxOf(page.getByRole('dialog'));
      expect(Math.round(sheetBox.y + sheetBox.height)).toBe(page.viewportSize()?.height);
      expect(await padding(page.getByRole('dialog'))).toBeGreaterThanOrEqual(34);
      expect(pageErrors).toEqual([]);
    });

    test('a sheet opened with the page does not squeeze the page behind it, card showing', async ({
      page,
    }) => {
      await withInsets(page);
      const job = await jobNamed(engine, JOB.spring);
      // As a notification opens a job on a phone that has not put the install card away.
      const pageErrors = await open(page, engine, `/jobs?job=${job.id}`, engine.baseURL, {
        installCard: true,
      });
      await expect(page.locator('[data-slot="install-card"]')).toBeVisible();
      await expect(page.locator(SHEET)).toBeVisible();
      await page.waitForTimeout(450);
      const widths = await page.evaluate(() => ({
        shell: document.querySelector('[data-slot="phone-shell"]')?.getBoundingClientRect().width,
        body: getComputedStyle(document.body).marginRight,
        window: window.innerWidth,
      }));
      expect(widths.body).toBe('0px');
      expect(widths.shell).toBe(widths.window);
      expect(pageErrors).toEqual([]);
    });
  });
});

test.describe('a queue that waits', () => {
  let engine: Engine;
  const CLIENT = 'Acme';
  const EDITING = 'Editing now';
  const FIRST = 'Queue first';
  const SECOND = 'Queue second';

  test.beforeAll(async () => {
    // A fake edit takes a minute at speed 1: far longer than this describe.
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: 1, review: false });
    for (const name of [EDITING, FIRST, SECOND]) {
      await engine.createJob({ client: CLIENT, job: name });
      await follow(engine, name, (job) => job.state === 'editing' || job.state === 'queued');
    }
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('Hold, then Release, from the sheet of a queued row', async ({ page }) => {
    const pageErrors = await open(page, engine);
    await listed(page);
    const first = await follow(engine, FIRST, (job) => job.state === 'queued');

    await page.getByRole('button', { name: `Open ${FIRST}` }).tap();
    await expect.poll(() => new URL(page.url()).searchParams.get('job')).toBe(first.id);
    await expect(pillOf(page)).toHaveText(/^Queued · #\d in line$/);

    await menuRow(page, 'hold').tap();
    await expect(pillOf(page)).toHaveText('Held');
    await expect(bigButton(page)).toHaveText('Release');
    await follow(engine, FIRST, (job) => job.state === 'held');
    // The row behind the sheet says so too.
    await expect(badge(rowOf(page, FIRST), 'Held')).toBeVisible();

    await bigButton(page).tap();
    await expect(pillOf(page)).toHaveText(/^Queued/);
    await follow(engine, FIRST, (job) => job.state === 'queued');
    expect(pageErrors).toEqual([]);
  });

  test('the Mac going away: a quiet line after 2 s, "Can’t reach your Mac" after 5 s, and back by itself', async ({
    page,
  }, testInfo) => {
    const proxy = await startProxy(new URL(engine.baseURL));
    try {
      const pageErrors = await open(page, engine, '/jobs', proxy.url);
      await listed(page);
      const offline = page.locator('[data-slot="phone-offline"]');
      // The events stream must be up before the Mac "goes away", or there is nothing to break.
      await page.waitForTimeout(1_000);

      await proxy.cut();
      // Between 2 s and 5 s the list is still there, with a quiet "Reconnecting" line over it.
      await expect(page.getByText('Reconnecting to the engine…')).toBeVisible({ timeout: 4_500 });
      await expect(offline).toHaveCount(0);
      await expect(page.locator(PAGE)).toBeVisible();
      await shoot(page, 'phone-reconnecting', testInfo);

      // After 5 s the page is replaced by the message.
      await expect(offline.getByRole('heading', { name: 'Can’t reach your Mac' })).toBeVisible({
        timeout: 10_000,
      });
      await shoot(page, 'phone-offline', testInfo);

      // The Mac is back: the page returns by itself, with the line gone.
      await proxy.restore();
      await expect(offline).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator(PAGE)).toBeVisible();
      await expect(page.getByText('Reconnecting to the engine…')).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});
