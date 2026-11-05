// PH20: design QA of Clients, a client, its Style and Money on the phone, at the boards' 390×844 and
// on a tall iPhone (430×932, an iPhone Pro Max: notch 59 px, home indicator 34 px), on the built
// server with the fake runner, in Chrome at iPhone size (the `phone` project of playwright.config.ts)
// with the Phone switch on. One engine (the one phone-clients.spec.ts uses: three clients, a job in
// Review for each, one failed, one put away) and the board's October for Money (support/money-board.ts).
//
// At each size:
//
//   the tab bar    on every top-level page (Jobs, `/`, Clients, a client, its Style, Money): the full
//                  width of the screen, 61 px high (49 + the 34 px home indicator), flush with the
//                  bottom, the page's own tab white, the badge on Jobs reading Review + Needs
//                  attention (4 here); none in Settings, none over a sheet, none over the Review
//   no overflow    no page is wider than the screen, nothing scrolls sideways
//   Clients …      MClients, MClient, MStyle, MMoney, MMoneyWarn: the pages are as wide as the
//                  screen, rows and banners keep the boards' margins (16 px) and heights, and a
//                  screenshot of each goes next to the board's
//
// The screenshots are attached to the report (test-results/, and the HTML report); with
// PHONE_SHOTS_DIR set they are also written there, named `<page>-<width>x<height>.png`. Nothing leaves
// the engine's origin.

import { copyFileSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { stubMoney } from '../support/money-board.ts';

test.describe.configure({ mode: 'serial' });

const TAVO = 'Levy Law';
const RGM = 'RGM';
const LAKESHORE = 'LAKESHORE';
const JOB = {
  election: 'Backgammon tournament',
  interview: 'Founder interview',
  winners: 'הכרזת הזוכים',
  lakeshore: 'Lakeshore promo',
  myth: 'Myth or fact 6',
} as const;
const WAIT = { timeout: 90_000 };

const NAV = '[data-slot="phone-tab-bar"]';
const SHEET = '[data-slot="phone-job-sheet"]';
const MONEY = '[data-slot="phone-money-page"]';
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';
const MUTED = 'rgb(161, 161, 170)';
const WHITE = 'rgb(250, 250, 250)';

/** The two phones: the boards' (notch 47) and a tall one (notch 59, a Dynamic Island). */
const SIZES = [
  { label: '390x844', width: 390, height: 844, top: 47 },
  { label: '430x932', width: 430, height: 932, top: 59 },
] as const;
type Size = (typeof SIZES)[number];

/** The style.md of the board MStyle. */
const STYLE_MD = `# Style: RGM
Learned from ${JOB.election} (21 Oct 2026).
## Look
- Colours: green #16A34A (accent), white #FFFFFF (text), near-black #0A0A0A
- Fonts: Heebo 800 for titles and captions
- Titles: white on a green bar, upper third
- Captions: two or three words a line, active word in green
- Logo: on the end card
## Editing
- Format: 1080×1920, about 30 s
- Pacing: quick, a cut on every move at the board
- Graphics: a score card between rounds, an end card
- Music: upbeat, from the job folder
## Kit
Title card, captions, score card and end card, saved from ${JOB.election}.
`;

interface JobOnServer {
  id: string;
  clientId: string;
  name: string;
  state: string;
  archivedAt: string | null;
}

let engine: Engine;

async function jobsOnServer(): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const found = (await jobsOnServer()).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no job named ${name}`);
  return found;
}

async function needYou(): Promise<number> {
  return (await jobsOnServer()).filter(
    (job) =>
      job.archivedAt === null && ['review', 'held', 'failed', 'cancelled'].includes(job.state),
  ).length;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 20,
    review: true,
    phone: true,
    jobSheet: true,
  });
  const toMake: ReadonlyArray<readonly [client: string, job: string, failAt?: string]> = [
    [RGM, JOB.election],
    [RGM, JOB.interview, 'brief'],
    [RGM, JOB.winners],
    [LAKESHORE, JOB.lakeshore],
    [TAVO, JOB.myth],
  ];
  for (const [client, job, failAt] of toMake) {
    await engine.createJob({ client, job, failAt });
    await expect
      .poll(async () => (await jobsOnServer()).some((candidate) => candidate.name === job), WAIT)
      .toBe(true);
  }
  await expect
    .poll(
      async () =>
        (await jobsOnServer()).every((candidate) =>
          candidate.name === JOB.interview
            ? candidate.state === 'failed'
            : candidate.state === 'review',
        ),
      WAIT,
    )
    .toBe(true);
  const archive = await fetch(`${engine.baseURL}/api/jobs/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [(await jobNamed(JOB.winners)).id] }),
  });
  expect(archive.status).toBeLessThan(300);
  const styleDir = join(engine.inbox, RGM, '_Style');
  await mkdir(styleDir, { recursive: true });
  await writeFile(join(styleDir, 'style.md'), STYLE_MD);
});

test.afterAll(async () => {
  await engine?.stop();
});

/** Chrome's emulated notch and home indicator (the home indicator is 34 px on every iPhone with one). */
async function emulateSafeAreas(page: Page, size: Size): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: size.top, bottom: 34, left: 0, right: 0 },
  });
}

/** Opens `path` on a phone of `size` that has seen this version's "What's new" and put the install card away. */
async function open(page: Page, size: Size, path: string): Promise<string[]> {
  await emulateSafeAreas(page, size);
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
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  await expect(page.locator('[data-slot="phone-shell"]')).toBeVisible();
  return pageErrors;
}

/**
 * A screenshot of the screen as it is. `whole` makes the screen as tall as the page for the shot (the
 * tab bar is fixed to the bottom of the screen, so it sits at the end of the page, as in the boards)
 * and puts it back.
 */
async function shoot(
  page: Page,
  testInfo: TestInfo,
  size: Size,
  name: string,
  whole = false,
): Promise<void> {
  if (whole) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: size.width, height: Math.max(height, size.height) });
    await page.waitForTimeout(300);
  }
  const file = `${name}-${size.label}.png`;
  const path = testInfo.outputPath(file);
  await page.screenshot({ path });
  await testInfo.attach(file, { path, contentType: 'image/png' });
  const dir = process.env.PHONE_SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(path, join(dir, file));
  }
  if (whole) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.waitForTimeout(300);
  }
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'the element is on the page').not.toBeNull();
  return box as { x: number; y: number; width: number; height: number };
}

const tab = (page: Page, id: 'jobs' | 'clients' | 'money') =>
  page.locator(`${NAV} [data-tab="${id}"]`);
const colourOf = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).color);

/** How far the page is wider than the screen: 0 when nothing can scroll sideways. */
function overflowX(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** `true` when what is at the middle of the tab bar's place on screen is the bar itself. */
function barIsOnTop(page: Page): Promise<boolean> {
  return page.evaluate((nav) => {
    const bar = document.querySelector(nav);
    if (bar === null) return false;
    const rect = bar.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit !== null && bar.contains(hit);
  }, NAV);
}

/** Scrolls so the top of `locator` is just under the top of the screen. */
async function scrollTo(page: Page, locator: Locator, offset = 12): Promise<void> {
  await locator.evaluate((element, gap) => {
    const top = element.getBoundingClientRect().top + window.scrollY - gap;
    window.scrollTo(0, Math.max(0, top));
  }, offset);
  await page.waitForTimeout(250);
}

for (const size of SIZES) {
  test.describe(size.label, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('the tab bar on every top-level page: full width, 61 px, flush, the right tab white, the badge', async ({
      page,
    }) => {
      const clientId = (await jobNamed(JOB.election)).clientId;
      await stubMoney(page);
      const pageErrors = await open(page, size, '/jobs');
      const pages: ReadonlyArray<readonly [path: string, active: 'jobs' | 'clients' | 'money']> = [
        ['/jobs', 'jobs'],
        ['/', 'jobs'],
        ['/clients', 'clients'],
        [`/clients/${clientId}`, 'clients'],
        [`/clients/${clientId}/style`, 'clients'],
        ['/money', 'money'],
      ];
      for (const [path, active] of pages) {
        await page.goto(`${engine.baseURL}${path}`);
        const nav = page.locator(NAV);
        await expect(nav, path).toBeVisible();
        // Full width, 61 px with the home indicator, flush with the bottom of the screen.
        const box = await boxOf(nav);
        expect(Math.round(box.x), `${path}: left`).toBe(0);
        expect(Math.round(box.width), `${path}: width`).toBe(size.width);
        expect(Math.round(box.height), `${path}: height`).toBe(61);
        expect(Math.round(box.y + box.height), `${path}: bottom`).toBe(size.height);
        // Three equal tabs, each at least 44 px tall.
        const boxes = await Promise.all(
          (['jobs', 'clients', 'money'] as const).map((id) => boxOf(tab(page, id))),
        );
        for (const tabBox of boxes)
          expect(tabBox.height, `${path}: tab`).toBeGreaterThanOrEqual(44);
        expect(
          new Set(boxes.map((tabBox) => Math.round(tabBox.width))).size,
          `${path}: equal tabs`,
        ).toBe(1);
        // The page's tab is the white one; the others are muted.
        await expect(tab(page, active), path).toHaveAttribute('aria-current', 'page');
        for (const id of ['jobs', 'clients', 'money'] as const) {
          await expect
            .poll(() => colourOf(tab(page, id)), { message: `${path}: ${id}` })
            .toBe(id === active ? WHITE : MUTED);
        }
        // The badge says how many need the owner, on every page.
        await expect(nav.locator('[data-slot="phone-tab-badge"]'), path).toHaveText(
          String(await needYou()),
        );
        expect(await overflowX(page), `${path}: sideways scroll`).toBeLessThanOrEqual(0);
        expect(await barIsOnTop(page), `${path}: bar on top`).toBe(true);
      }
      expect(pageErrors).toEqual([]);
    });

    test('no bar in Settings, over a sheet or over the Review', async ({ page }) => {
      const pageErrors = await open(page, size, '/jobs');
      await expect(page.locator(NAV)).toBeVisible();

      await page.getByRole('link', { name: 'Settings' }).tap();
      await expect(page.locator('[data-slot="phone-settings-page"]')).toBeVisible();
      await expect(page.locator(NAV)).toHaveCount(0);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await page.goto(`${engine.baseURL}/jobs`);
      await expect(page.locator(NAV)).toBeVisible();

      // The View sheet, then the job's sheet, each cover the bar (a full-screen layer).
      await page.getByRole('button', { name: 'View', exact: true }).tap();
      const view = page.locator('[data-slot="phone-view-sheet"]');
      await expect(view).toBeVisible();
      expect(await barIsOnTop(page)).toBe(false);
      await page.keyboard.press('Escape');
      await expect(view).toBeHidden();
      expect(await barIsOnTop(page)).toBe(true);

      const election = await jobNamed(JOB.election);
      await page.goto(`${engine.baseURL}/jobs?job=${election.id}`);
      const sheet = page.locator(SHEET);
      await expect(sheet).toBeVisible();
      expect(await barIsOnTop(page)).toBe(false);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      expect(await barIsOnTop(page)).toBe(true);

      // The sheet opened from a client's page and from Money covers the bar there too.
      await page.goto(`${engine.baseURL}/clients/${election.clientId}`);
      await page
        .locator(`[data-slot="phone-client-page"] [data-job-id="${election.id}"]`)
        .locator('button[aria-label^="Open"]')
        .tap();
      await expect(sheet).toBeVisible();
      expect(await barIsOnTop(page)).toBe(false);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();

      // The Review is full screen: it covers the bar too.
      await page.goto(`${engine.baseURL}/jobs`);
      await page
        .locator(`[data-job-id="${(await jobNamed(JOB.myth)).id}"]`)
        .getByRole('button', { name: 'Review', exact: true })
        .tap();
      await expect(page.locator('[data-slot="phone-review"]')).toBeVisible();
      expect(await barIsOnTop(page)).toBe(false);
      expect(pageErrors).toEqual([]);
    });

    test('Clients (MClients) and a client (MClient): margins, row heights, the whole width', async ({
      page,
    }, testInfo) => {
      const pageErrors = await open(page, size, '/clients');
      const list = page.locator('[data-slot="phone-clients-page"]');
      await expect(list).toBeVisible();
      const rows = list.locator('li[data-client-id]');
      await expect(rows).toHaveCount(3);
      for (let i = 0; i < 3; i += 1) {
        const row = await boxOf(rows.nth(i));
        expect(row.height).toBeGreaterThanOrEqual(64);
        expect(Math.round(row.x)).toBe(0);
        expect(Math.round(row.width)).toBe(size.width);
      }
      // 16 px of margin: the title and the avatar start at x = 16; the search toggle ends at 6 px.
      const title = await boxOf(page.getByRole('heading', { name: 'Clients', level: 1 }));
      expect(Math.round(title.x)).toBe(16);
      const avatar = await boxOf(rows.first().locator('[data-slot="avatar"]'));
      expect(Math.round(avatar.x)).toBe(16);
      const toggle = await boxOf(page.getByRole('button', { name: 'Search clients' }));
      expect(Math.round(toggle.x + toggle.width)).toBe(size.width - 6);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await shoot(page, testInfo, size, 'clients');
      await page.getByRole('button', { name: 'Search clients' }).tap();
      const field = page.getByRole('searchbox', { name: 'Search clients' });
      await expect(field).toBeFocused();
      // The toggle takes the board's grey (#27272A) while the field is open (it fades in).
      await expect
        .poll(() =>
          page
            .getByRole('button', { name: 'Search clients' })
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        )
        .toBe('rgb(39, 39, 42)');
      await shoot(page, testInfo, size, 'clients-search');
      await field.fill('sg');
      await expect(rows).toHaveCount(1);
      await shoot(page, testInfo, size, 'clients-search-sg');

      const election = await jobNamed(JOB.election);
      await page.goto(`${engine.baseURL}/clients/${election.clientId}`);
      const client = page.locator('[data-slot="phone-client-page"]');
      await expect(client).toBeVisible();
      const jobRows = client.locator('li[data-job-id]');
      await expect(jobRows).toHaveCount(2);
      for (let i = 0; i < 2; i += 1) {
        const row = await boxOf(jobRows.nth(i));
        expect(row.height).toBeGreaterThanOrEqual(58);
        expect(Math.round(row.width)).toBe(size.width);
      }
      // "‹ Clients": the board's link has 8 px around it and 4 px inside, so the chevron (20 px) starts
      // at 12; the label follows it by 2 px.
      const backChevron = await boxOf(
        client.getByRole('link', { name: 'Clients', exact: true }).locator('svg'),
      );
      expect(Math.round(backChevron.x)).toBe(12);
      expect(Math.round(backChevron.width)).toBe(20);
      // A row on the board's grid (16 px, a 24 px icon, 10 px, the name, then a 44 px button 6 px from
      // the edge): the icon centred at 28, the name from 50, the button 44 px square.
      const first = jobRows.first();
      const icon = await boxOf(first.locator('svg').first());
      expect(Math.round(icon.x + icon.width / 2)).toBe(28);
      const name = await boxOf(first.locator('[dir="auto"]').first());
      expect(Math.round(name.x)).toBe(50);
      const action = await boxOf(first.locator('button:not([aria-label^="Open"])').last());
      expect(Math.round(action.width)).toBe(44);
      expect(Math.round(action.height)).toBe(44);
      expect(Math.round(action.x + action.width)).toBe(size.width - 6);
      // The header: the avatar at 16 px, the Style button ends 16 px from the right edge.
      const header = client.locator('[data-slot="phone-client-header"]');
      expect(Math.round((await boxOf(header.locator('[data-slot="avatar"]'))).x)).toBe(16);
      const style = await boxOf(client.getByRole('link', { name: 'Style' }));
      expect(Math.round(style.x + style.width)).toBe(size.width - 16);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await shoot(page, testInfo, size, 'client');
      expect(pageErrors).toEqual([]);
    });

    test('Style (MStyle): the document keeps a 16 px column and no sideways scroll', async ({
      page,
    }, testInfo) => {
      const election = await jobNamed(JOB.election);
      // A style run sets the time of the file; this style.md was put in the folder by hand, so the
      // engine has none. The board's is "updated 1 h ago": give the answer that time, on a fixed clock.
      await page.clock.setFixedTime(new Date('2026-10-22T10:00:00.000Z'));
      await page.route(
        (url) => /^\/api\/clients\/[^/]+\/style$/.test(url.pathname),
        async (route) => {
          const response = await route.fetch();
          const style = (await response.json()) as Record<string, unknown>;
          await route.fulfill({
            response,
            json: { ...style, updatedAt: '2026-10-22T09:00:00.000Z' },
          });
        },
      );
      const pageErrors = await open(page, size, `/clients/${election.clientId}/style`);
      const view = page.locator('[data-slot="phone-style-page"]');
      await expect(view).toBeVisible();
      await expect(view.getByText('style.md · updated 1 h ago')).toBeVisible();
      await expect(view.getByRole('heading', { name: 'Style: RGM', level: 1 })).toBeVisible();
      const h1 = await boxOf(view.getByRole('heading', { name: 'Style: RGM', level: 1 }));
      expect(Math.round(h1.x)).toBe(16);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      // The board's rhythm, from the notch down (47 px in the board): the 44 px back row, 8 px, the
      // 22 px title (28.6 px high, 2 px under it), 10 px between blocks, a heading with 14 px above it.
      const tops = await page.evaluate((notch) => {
        const at = (selector: string) =>
          (document.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN) - notch;
        const article = '[data-slot="phone-style-page"] article';
        return {
          h1: at(`${article} h1`),
          p: at(`${article} h1 + p`),
          h2: at(`${article} h2`),
          ul: at(`${article} h2 + ul`),
        };
      }, size.top);
      const styleBack = await boxOf(
        view.getByRole('link', { name: RGM, exact: true }).locator('svg'),
      );
      expect(Math.round(styleBack.x)).toBe(12);
      expect(tops.h1).toBeCloseTo(52, 0);
      expect(tops.p).toBeCloseTo(92.6, 0);
      expect(tops.h2).toBeCloseTo(126.6, 0);
      expect(tops.ul).toBeCloseTo(173, 0);
      await shoot(page, testInfo, size, 'style');
      expect(pageErrors).toEqual([]);
    });

    test('Money (MMoney): banners, Ledger, By client, Expenses and the warning', async ({
      page,
    }, testInfo) => {
      await page.clock.setFixedTime(new Date('2026-10-22T10:00:00.000Z'));
      await stubMoney(page);
      const pageErrors = await open(page, size, '/money');
      const banner = (kind: 'income' | 'expenses' | 'profit') =>
        page.locator(`${MONEY} [data-banner="${kind}"]`);
      await expect(banner('income')).toBeVisible();
      // Three banners, each the page's width less the 16 px margins.
      for (const kind of ['income', 'expenses', 'profit'] as const) {
        const box = await boxOf(banner(kind));
        expect(Math.round(box.x), kind).toBe(16);
        expect(Math.round(box.width), kind).toBe(size.width - 32);
      }
      // The month picker is 40 px high and ends 16 px from the right edge.
      const picker = await boxOf(page.getByRole('combobox', { name: 'Month' }));
      expect(picker.height).toBe(40);
      expect(Math.round(picker.x + picker.width)).toBe(size.width - 16);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await shoot(page, testInfo, size, 'money');

      const ledger = page.locator('section[aria-labelledby="phone-ledger-h"]');
      const rows = ledger.locator('[data-job-id]');
      await expect(rows).toHaveCount(10);
      const ledgerBox = await boxOf(ledger);
      expect(Math.round(ledgerBox.x)).toBe(16);
      expect(Math.round(ledgerBox.width)).toBe(size.width - 32);
      // The board's first row is open (the phone starts with every row closed): open it for the shots.
      await rows.first().getByRole('button').tap();
      await expect(rows.first().locator('[data-job-detail]')).toBeVisible();
      await shoot(page, testInfo, size, 'money-full', true);
      await scrollTo(page, ledger.locator('h2'), 12);
      await shoot(page, testInfo, size, 'money-ledger');

      await ledger.getByRole('button', { name: 'By client' }).tap();
      await expect(ledger.locator('[data-client-id]')).toHaveCount(3);
      await scrollTo(page, ledger.locator('h2'), 12);
      await shoot(page, testInfo, size, 'money-by-client');
      await shoot(page, testInfo, size, 'money-by-client-full', true);

      const expenses = page.locator('section[aria-labelledby="phone-exp-h"]');
      await scrollTo(page, expenses.locator('h2'), 12);
      await shoot(page, testInfo, size, 'money-expenses');
      await expenses.getByRole('button', { name: 'All charges' }).tap();
      await shoot(page, testInfo, size, 'money-expenses-full', true);
      // The page ends above the bar: the last thing on it (the Expenses box) is not under it.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(250);
      const bar = await boxOf(page.locator(NAV));
      const last = await boxOf(expenses);
      expect(last.y + last.height).toBeLessThanOrEqual(bar.y + 1);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      expect(pageErrors).toEqual([]);
    });

    test('MMoneyWarn: a money.json mistake is one line under the title', async ({
      page,
    }, testInfo) => {
      await page.clock.setFixedTime(new Date('2026-10-22T10:00:00.000Z'));
      await stubMoney(page, {
        status: 'last-good',
        issue: 'subscriptions[0].day: expected a number',
      });
      const pageErrors = await open(page, size, '/money');
      const line = page.locator(`${MONEY} [data-money-file]`);
      await expect(line).toBeVisible();
      const box = await boxOf(line);
      expect(Math.round(box.x)).toBe(16);
      expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(size.width - 16);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
      await shoot(page, testInfo, size, 'money-warn');
      expect(pageErrors).toEqual([]);
    });
  });
}
