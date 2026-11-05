// PH18: the tab bar and Clients on the phone, on the built server with the fake runner, in Chrome
// at iPhone size (the `phone` project of playwright.config.ts), 390×844 like the design boards,
// with Chrome's emulated notch (47 px) and home indicator (34 px) and the Phone switch on. One
// engine, three clients: RGM (a job in Review, a failed one, one delivered, paid and archived),
// LAKESHORE (one in Review) and Levy Law (one in Review), so Jobs carries a badge of 4.
//
//   the tab bar     61 px at the bottom (49 + the 34 px home bar) on Jobs, Clients, a client and its
//                   Style; Jobs, Clients and Money (PH19); the active tab white and the others muted; the
//                   white badge on Jobs counts Review + Needs attention, archived left out; it stays
//                   at the bottom while a page scrolls; a sheet and the Review cover it; none in
//                   Settings
//   Clients         MClients: "Clients" and a search toggle, 64 px rows (a link each), the footer
//                   "3 clients", the search narrows it ("1 of 3 clients") and closing it clears it
//   a client        MClient: "‹ Clients", a 48 px avatar, the name, "N jobs · last job 3 min ago",
//                   an outlined Style button, the client's jobs as flat rows with no client in them
//                   and no tabs, the archived line "1 archived · Show" and then "Hide archived"
//   Style           MStyle: "‹ RGM", "style.md · updated …", the document as text; no Add files
//   links           the By client header, the sheet's client link and the Back links all go to the
//                   phone's pages
//
// The screenshots are attached to the report (test-results/, and the HTML report) next to the
// boards MJobs, MClients, MClient and MStyle; with PHONE_SHOTS_DIR set they are also written
// there. Nothing leaves the engine's origin.

import { copyFileSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({ viewport: { width: 390, height: 844 } });
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
const SLOT = '[data-slot="phone-tab-bar-slot"]';
const SHEET = '[data-slot="phone-job-sheet"]';
/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
/** The localStorage key of the time the "Add to Home Screen" card was put away (install-card.ts). */
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

/** The muted and the white of the tab labels (zinc-400 and zinc-50). */
const MUTED = 'rgb(161, 161, 170)';
const WHITE = 'rgb(250, 250, 250)';

interface JobOnServer {
  id: string;
  clientId: string;
  client: string;
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

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${engine.baseURL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, `POST ${path}: ${await response.clone().text()}`).toBeLessThan(300);
}

/** Review + Needs attention, archived left out: what the badge on Jobs must say. */
async function needYou(): Promise<number> {
  return (await jobsOnServer()).filter(
    (job) =>
      job.archivedAt === null && ['review', 'held', 'failed', 'cancelled'].includes(job.state),
  ).length;
}

const STYLE_MD = `# Style: RGM
Learned from ${JOB.election} (21 Oct 2026).
## Look
- Colours: green #16A34A (accent), white #FFFFFF (text), near-black #0A0A0A
- Fonts: Heebo 800 for titles and captions
- Titles: white on a green bar, upper third
## Editing
- Format: 1080×1920, about 30 s
- Pacing: quick, a cut on every move at the board
## Kit
Title card, captions, score card and end card, saved from ${JOB.election}.
`;

test.beforeAll(async () => {
  // Review on (the default for the app, set here so it is the same everywhere): an edit ends in
  // Review, which is what the badge counts.
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 20,
    review: true,
    phone: true,
    jobSheet: true,
  });

  // One at a time, each waited for until the engine lists it (jobs dropped into a new client
  // folder while earlier jobs are being edited are not always noticed).
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

  // RGM's third job is put away (archived), so the line "1 archived · Show" has something to offer.
  await post('/api/jobs/archive', { ids: [(await jobNamed(JOB.winners)).id] });

  // RGM's style: the engine reads it from the client's _Style folder.
  const styleDir = join(engine.inbox, RGM, '_Style');
  await mkdir(styleDir, { recursive: true });
  await writeFile(join(styleDir, 'style.md'), STYLE_MD);
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
async function open(page: Page, path = '/jobs', shell = true): Promise<string[]> {
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
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  if (shell) await expect(page.locator('[data-slot="phone-shell"]')).toBeVisible();
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

const tab = (page: Page, id: 'jobs' | 'clients' | 'money') =>
  page.locator(`${NAV} [data-tab="${id}"]`);
const colourOf = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).color);
const clientRows = (page: Page) =>
  page.locator('[data-slot="phone-clients-page"] li[data-client-id]');
const jobRows = (page: Page) => page.locator('[data-slot="phone-client-page"] li[data-job-id]');

/** What is at the middle of the tab bar's place on screen: `true` when it is the bar itself. */
function barIsOnTop(page: Page): Promise<boolean> {
  return page.evaluate((nav) => {
    const bar = document.querySelector(nav);
    if (bar === null) return false;
    const rect = bar.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit !== null && bar.contains(hit);
  }, NAV);
}

test('the tab bar: 61 px at the bottom, Jobs white with the badge, Clients and Money muted', async ({
  page,
}, testInfo) => {
  const pageErrors = await open(page);
  await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
  const nav = page.locator(NAV);
  await expect(nav).toBeVisible();

  // 61 px with the home bar (49 + 40% of 34), flush with the bottom of the screen, edge to edge.
  const box = await boxOf(nav);
  expect(Math.round(box.height)).toBe(61);
  expect(Math.round(box.y + box.height)).toBe(844);
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.width)).toBe(390);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(1);

  // Jobs, Clients and Money (PH19), in thirds, each at least 44 px high.
  await expect(page.locator(`${NAV} a`)).toHaveText([/Jobs/, 'Clients', 'Money']);
  for (const id of ['jobs', 'clients', 'money'] as const) {
    expect((await boxOf(tab(page, id))).height).toBeGreaterThanOrEqual(44);
  }

  // The tab of the page is white and says so; the other is muted.
  await expect(tab(page, 'jobs')).toHaveAttribute('aria-current', 'page');
  await expect(tab(page, 'clients')).not.toHaveAttribute('aria-current', 'page');
  await expect.poll(() => colourOf(tab(page, 'jobs'))).toBe(WHITE);
  await expect.poll(() => colourOf(tab(page, 'clients'))).toBe(MUTED);
  await expect(tab(page, 'money')).not.toHaveAttribute('aria-current', 'page');
  await expect.poll(() => colourOf(tab(page, 'money'))).toBe(MUTED);
  expect(await tab(page, 'jobs').evaluate((element) => getComputedStyle(element).cursor)).toBe(
    'pointer',
  );

  // The badge: a white pill with Review + Needs attention; the archived job is not in it.
  const badge = page.locator(`${NAV} [data-slot="phone-tab-badge"]`);
  await expect(badge).toHaveText(String(await needYou()));
  await expect(badge).toHaveText('4');
  expect(
    await badge.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color];
    }),
  ).toEqual([WHITE, 'rgb(9, 9, 11)']);
  await expect(tab(page, 'jobs')).toContainText('4 need you');

  await shoot(page, testInfo, 'tab-bar-jobs');
  expect(pageErrors).toEqual([]);
});

test('the bar stays at the bottom while the page scrolls, and the page ends above it', async ({
  page,
}) => {
  await open(page, '/clients');
  await page.setViewportSize({ width: 390, height: 360 });
  await expect(clientRows(page).first()).toBeVisible();
  await page.evaluate(() => {
    const scroller = document.querySelector('[data-slot="phone-scroll"]');
    scroller?.scrollTo(0, scroller.scrollHeight);
  });
  await page.waitForTimeout(300);
  const bar = await boxOf(page.locator(NAV));
  expect(Math.round(bar.y + bar.height)).toBe(360);
  // The last thing on the page (the footer) is not under the bar.
  const footer = await boxOf(page.getByText('3 clients', { exact: true }));
  expect(footer.y + footer.height).toBeLessThanOrEqual(bar.y + 1);
});

test('Clients (MClients): the title, 64 px rows that open the client, and the footer', async ({
  page,
}, testInfo) => {
  const pageErrors = await open(page);
  await tab(page, 'clients').tap();
  await expect(page).toHaveURL(/\/clients$/);

  const view = page.locator('[data-slot="phone-clients-page"]');
  await expect(view).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clients', level: 1 })).toBeVisible();
  await expect(page.locator('[data-slot="phone-back-header"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="phone-jobs-page"]')).toHaveCount(0);

  // Clients is the white tab now; the badge stays on Jobs.
  await expect(tab(page, 'clients')).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => colourOf(tab(page, 'clients'))).toBe(WHITE);
  await expect.poll(() => colourOf(tab(page, 'jobs'))).toBe(MUTED);
  await expect(page.locator(`${NAV} [data-slot="phone-tab-badge"]`)).toHaveText('4');

  // Three rows, newest last job first (the order is the Mac's), each 64 px or more, a link.
  await expect(clientRows(page)).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    const row = clientRows(page).nth(i);
    expect((await boxOf(row)).height).toBeGreaterThanOrEqual(64);
    await expect(row.locator('a')).toHaveAttribute('href', /^\/clients\/[0-9a-f]{12}$/);
  }
  const RGM_ROW = clientRows(page).filter({ hasText: RGM });
  await expect(RGM_ROW).toContainText('3 jobs · last job');
  await expect(RGM_ROW).toContainText(/last job (just now|\d+ min ago)/i);
  await expect(clientRows(page).filter({ hasText: TAVO })).toContainText('1 job · last job');
  // The avatar is 40 px; the chevron is on the right.
  expect(await boxOf(RGM_ROW.locator('[data-slot="avatar"]'))).toMatchObject({
    width: 40,
    height: 40,
  });
  await expect(RGM_ROW.locator('svg.lucide-chevron-right')).toBeVisible();
  await expect(view.getByText('3 clients', { exact: true })).toBeVisible();
  // New client stays on the Mac.
  await expect(page.getByText('New client')).toHaveCount(0);

  await shoot(page, testInfo, 'clients');

  // Search (MClients): the toggle opens a 16 px field; typing narrows the list and the footer.
  const toggle = page.getByRole('button', { name: 'Search clients' });
  expect((await boxOf(toggle)).height).toBeGreaterThanOrEqual(44);
  await toggle.tap();
  const field = page.getByRole('searchbox', { name: 'Search clients' });
  await expect(field).toBeFocused();
  expect(await field.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
  await field.fill('sg');
  await expect(clientRows(page)).toHaveCount(1);
  await expect(view.getByText('1 of 3 clients', { exact: true })).toBeVisible();
  await shoot(page, testInfo, 'clients-search');
  await field.fill('zzz');
  await expect(view.getByText('No matching clients.')).toBeVisible();
  await expect(view.getByText('0 of 3 clients', { exact: true })).toBeVisible();
  // Hebrew names are found too.
  await field.fill('משה');
  await expect(clientRows(page)).toHaveCount(1);
  await expect(clientRows(page).first()).toContainText(TAVO);
  // Closing the field ends the search.
  await toggle.tap();
  await expect(field).toHaveCount(0);
  await expect(clientRows(page)).toHaveCount(3);

  expect(pageErrors).toEqual([]);
});

test('a client (MClient): the header, its jobs as flat rows, the archived line, Style', async ({
  page,
}, testInfo) => {
  const pageErrors = await open(page, '/clients');
  await clientRows(page).filter({ hasText: RGM }).tap();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}$/);

  const view = page.locator('[data-slot="phone-client-page"]');
  await expect(view).toBeVisible();
  await expect(page.locator('[data-slot="phone-back-header"]')).toHaveCount(0);
  // Clients stays the white tab on a client's page.
  await expect(tab(page, 'clients')).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => colourOf(tab(page, 'clients'))).toBe(WHITE);

  // "‹ Clients", 44 px; a 48 px avatar; the name; "3 jobs · last job …"; the outlined Style button.
  const back = view.getByRole('link', { name: 'Clients', exact: true });
  expect((await boxOf(back)).height).toBeGreaterThanOrEqual(44);
  expect(await boxOf(view.locator('[data-slot="avatar"]'))).toMatchObject({
    width: 48,
    height: 48,
  });
  await expect(page.getByRole('heading', { name: RGM, level: 1 })).toBeVisible();
  await expect(view.locator('[data-slot="phone-client-header"]')).toContainText(
    /3 jobs · last job (just now|\d+ min ago)/,
  );
  const style = view.getByRole('link', { name: 'Style' });
  await expect(style).toHaveAttribute('data-variant', 'outline');
  expect((await boxOf(style)).height).toBeGreaterThanOrEqual(40);

  // The client's jobs: flat rows (58 px or more), only RGM's, the archived one hidden; no client in
  // the second line, no status tabs, no search.
  await expect(jobRows(page)).toHaveCount(2);
  await expect(jobRows(page).filter({ hasText: JOB.election })).toHaveCount(1);
  await expect(jobRows(page).filter({ hasText: JOB.interview })).toHaveCount(1);
  await expect(view.getByText(JOB.lakeshore)).toHaveCount(0);
  for (let i = 0; i < 2; i += 1) {
    const row = jobRows(page).nth(i);
    expect((await boxOf(row)).height).toBeGreaterThanOrEqual(58);
    await expect(row).not.toHaveAttribute('data-tree', /.*/);
    await expect(row.locator('p')).not.toContainText(`${RGM} ·`);
  }
  await expect(view.getByRole('tablist')).toHaveCount(0);
  await expect(view.getByRole('searchbox')).toHaveCount(0);

  // The archived line: "1 archived · Show", then the job appears and the line offers "Hide archived".
  await expect(view.getByText('1 archived ·')).toBeVisible();
  await shoot(page, testInfo, 'client');
  await view.getByRole('button', { name: 'Show', exact: true }).tap();
  await expect(jobRows(page)).toHaveCount(3);
  await expect(jobRows(page).filter({ hasText: JOB.winners })).toHaveAttribute('data-archived', '');
  await expect(view.getByText('1 archived shown ·')).toBeVisible();
  await view.getByRole('button', { name: 'Hide archived' }).tap();
  await expect(jobRows(page)).toHaveCount(2);

  // A tap on a row opens the job's sheet over it, and the sheet's client link comes back here.
  await jobRows(page).filter({ hasText: JOB.election }).locator('button[aria-label^="Open"]').tap();
  const sheet = page.locator(SHEET);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: JOB.election })).toBeVisible();
  // The sheet covers the tab bar.
  expect(await barIsOnTop(page)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  expect(await barIsOnTop(page)).toBe(true);

  // Style: the outlined button leads to the client's style.
  await style.tap();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}\/style$/);
  await expect(page.locator('[data-slot="phone-style-page"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('Style (MStyle): style.md as text at phone width, read only, with the tab bar', async ({
  page,
}, testInfo) => {
  const pageErrors = await open(page, `/clients/${(await jobNamed(JOB.election)).clientId}/style`);
  const view = page.locator('[data-slot="phone-style-page"]');
  await expect(view).toBeVisible();
  await expect(page.locator('[data-slot="phone-back-header"]')).toHaveCount(0);

  // "‹ RGM" (44 px) and "style.md" at the right ("· updated …" follows once a style run has written
  // it; this style.md was put in the folder by hand, so the engine has no time for it: the unit
  // tests cover the time).
  const back = view.getByRole('link', { name: RGM, exact: true });
  expect((await boxOf(back)).height).toBeGreaterThanOrEqual(44);
  await expect(view.getByText('style.md', { exact: true })).toBeVisible();

  // The document, as the Mac renders it: a title, sections and bullets, in a phone-wide column.
  await expect(view.getByRole('heading', { name: 'Style: RGM', level: 1 })).toBeVisible();
  await expect(view.getByRole('heading', { name: 'Look', level: 2 })).toBeVisible();
  await expect(view.getByText('Fonts: Heebo 800 for titles and captions')).toBeVisible();
  const article = await boxOf(view.locator('article'));
  expect(article.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Read only: no Add style files, no drop zone, no file input.
  await expect(page.getByText('Add style files')).toHaveCount(0);
  await expect(page.getByText(/Drop files|Browse files/)).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);

  // The tab bar is there with Clients white; "‹ RGM" goes back to the client.
  await expect(tab(page, 'clients')).toHaveAttribute('aria-current', 'page');
  await shoot(page, testInfo, 'style');
  await back.tap();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}$/);
  await expect(page.locator('[data-slot="phone-client-page"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('a client with no style yet says so; an unknown client is "No such client."', async ({
  page,
}) => {
  const pageErrors = await open(page, `/clients/${(await jobNamed(JOB.lakeshore)).clientId}/style`);
  await expect(page.getByText('No style yet.')).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);

  await page.goto(`${engine.baseURL}/clients/000000000000`);
  await expect(page.getByText('No such client.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to Clients' }).tap();
  await expect(page.locator('[data-slot="phone-clients-page"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('the By client header on Jobs links to the phone client page', async ({ page }) => {
  const pageErrors = await open(page);
  await page.locator('[data-slot="phone-jobs-page"] section[aria-label="RGM"] a').first().tap();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}$/);
  await expect(page.locator('[data-slot="phone-client-page"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: RGM, level: 1 })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('the job sheet’s client link goes to the phone client page', async ({ page }) => {
  const job = await jobNamed(JOB.lakeshore);
  const pageErrors = await open(page, `/jobs?job=${job.id}`);
  const sheet = page.locator(SHEET);
  await expect(sheet).toBeVisible();
  await sheet.getByRole('link', { name: LAKESHORE }).tap();
  await expect(page).toHaveURL(new RegExp(`/clients/${job.clientId}$`));
  await expect(page.locator('[data-slot="phone-client-page"]')).toBeVisible();
  await expect(sheet).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test('no tab bar in Settings, in the Review, or under a sheet', async ({ page }) => {
  const pageErrors = await open(page);
  await expect(page.locator(NAV)).toBeVisible();

  // Settings: the gear leads there, the slot is empty and hidden; back, the bar returns.
  await page.getByRole('link', { name: 'Settings' }).tap();
  await expect(page.locator('[data-slot="phone-settings-page"]')).toBeVisible();
  await expect(page.locator(NAV)).toHaveCount(0);
  await expect(page.locator(SLOT)).toBeHidden();
  await page.goto(`${engine.baseURL}/jobs`);
  await expect(page.locator(NAV)).toBeVisible();

  // A sheet (the job's) covers it; the View sheet too.
  await page.getByRole('button', { name: 'View', exact: true }).tap();
  const view = page.locator('[data-slot="phone-view-sheet"]');
  await expect(view).toBeVisible();
  expect(await barIsOnTop(page)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
  expect(await barIsOnTop(page)).toBe(true);

  // The Review is full screen: a Review row's Play icon opens it over the bar.
  const review = await jobNamed(JOB.myth);
  await page
    .locator(`[data-job-id="${review.id}"]`)
    .getByRole('button', { name: 'Review', exact: true })
    .tap();
  await expect(page.locator('[data-slot="phone-review"]')).toBeVisible();
  expect(await barIsOnTop(page)).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('messages sit above the tab bar, and at the home bar when a sheet covers it', async ({
  page,
}) => {
  await open(page);
  const lift = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--phone-toast-bottom'),
    );
  // The bar shows, nothing over it: 8 px above the bar (its 49 px and the home bar).
  expect(await lift()).toContain('49px');
  await page.getByRole('button', { name: 'View', exact: true }).tap();
  await expect(page.locator('[data-slot="phone-view-sheet"]')).toBeVisible();
  // A sheet covers the bar: the message goes back to the home bar.
  expect((await lift()).trim()).toBe('');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="phone-view-sheet"]')).toBeHidden();
  expect(await lift()).toContain('49px');
  // Settings has no bar.
  await page.getByRole('link', { name: 'Settings' }).tap();
  await expect(page.locator('[data-slot="phone-settings-page"]')).toBeVisible();
  expect((await lift()).trim()).toBe('');
});

test('a wide window keeps the Mac layout: the sidebar, no tab bar, the table of clients', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await open(page, '/clients', false);
  await expect(page.locator('[data-slot="sidebar-wrapper"]')).toBeVisible();
  await expect(page.locator(NAV)).toHaveCount(0);
  await expect(page.locator('[data-slot="phone-clients-page"]')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Clients' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
