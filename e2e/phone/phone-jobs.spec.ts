// PH3: the jobs list on the phone, on the built server with the fake runner, in Chrome at iPhone 15
// size (the `phone` project of playwright.config.ts), the Phone switch on. One engine, jobs made
// once, in two clients (one with Hebrew names):
//
//   Acme              Spring promo, Autumn reel (Approved), Broken render (Failed)
//   דוד לוי           Myth or fact 6 (Delivered, not paid),
//                     Myth or fact 5 (Paid and archived)
//
//   By client         on at first: a header per client (avatar, name, count), the jobs one step in
//                     with tree lines, the clients in order of their latest activity
//   View              a bottom sheet with two switches; By client is remembered across a reload,
//                     Show archived brings the archived video back, faded, with its box
//   Search            a 40 px field with 16 px text; "1 more archived · Show" under a search
//   Rows              at least 58 px, a 44 px next step; a tap on the row asks for the job's sheet
//   Next step         Share (Approved, PH15) opens the job's sheet, whose list marks it delivered
//                     (with a message and Undo); Mark paid… opens the bottom sheet
//   Header            View, Search and Settings, each 44 px; the tabs scroll sideways; the header
//                     and tabs stay under the top of the screen while the rows scroll
//   Hebrew            names read right to left inside left-to-right rows
//
// Screenshots at 390×844 (the size of the design boards) are attached to the report; with
// PHONE_SHOTS_DIR set they are also written there. Nothing leaves the engine's origin.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  type TestInfo,
  test,
} from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { action, badge, rowOf } from '../support/jobs-ui.ts';

const CLIENT = { latin: 'Acme', hebrew: 'דוד לוי' } as const;
const JOB = {
  spring: 'Spring promo',
  autumn: 'Autumn reel',
  broken: 'Broken render',
  six: 'Myth or fact 6',
  five: 'Myth or fact 5',
} as const;

const WAIT = { timeout: 90_000 };

/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const BY_CLIENT_KEY = 'studio.phone.byClient.v1';

interface JobOnServer {
  id: string;
  clientId: string;
  client: string;
  name: string;
  state: string;
  updatedAt: string;
  archivedAt: string | null;
  delivery: { paidOn: string | null } | null;
}

let engine: Engine;
let version: string;

async function jobsOnServer(): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const job = (await jobsOnServer()).find((candidate) => candidate.name === name);
  expect(job, `the server lists "${name}"`).toBeDefined();
  return job as JobOnServer;
}

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${engine.baseURL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, `POST ${path}: ${await response.clone().text()}`).toBeLessThan(300);
}

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 20, review: false, phone: true });
  version = ((await (await fetch(`${engine.baseURL}/api/health`)).json()) as { version: string })
    .version;

  // One at a time, each waited for until the engine lists it: jobs dropped into a client folder
  // that is new while earlier jobs are being edited are not always noticed (see the hand-off).
  const toMake: ReadonlyArray<readonly [client: string, job: string, failAt?: string]> = [
    [CLIENT.latin, JOB.spring],
    [CLIENT.hebrew, JOB.six],
    [CLIENT.latin, JOB.autumn],
    [CLIENT.hebrew, JOB.five],
    [CLIENT.latin, JOB.broken, 'render'],
  ];
  for (const [client, job, failAt] of toMake) {
    await engine.createJob({ client, job, failAt });
    await expect
      .poll(async () => (await jobsOnServer()).some((candidate) => candidate.name === job), WAIT)
      .toBe(true);
  }
  await expect
    .poll(async () => (await jobsOnServer()).map((job) => `${job.name}: ${job.state}`).sort(), WAIT)
    .toEqual(
      [
        `${JOB.autumn}: ready`,
        `${JOB.broken}: failed`,
        `${JOB.five}: ready`,
        `${JOB.six}: ready`,
        `${JOB.spring}: ready`,
      ].sort(),
    );

  // Delivered; and Paid and archived.
  await post(`/api/jobs/${(await jobNamed(JOB.six)).id}/deliver`);
  const five = await jobNamed(JOB.five);
  await post(`/api/jobs/${five.id}/deliver`);
  await post('/api/payments', { jobIds: [five.id], paidOn: '2026-10-14' });
  await post('/api/jobs/archive', { ids: [five.id] });
});

test.afterAll(async () => {
  await engine?.stop();
});

/**
 * Opens `path` in a browser that has already seen this version's "What's new" (a new browser is
 * greeted with it, and it blocks the page), and returns the page's errors so far, which every test
 * expects to be none. `storage` is more localStorage to start with.
 */
async function open(
  page: Page,
  path = '/jobs',
  storage: Record<string, string> = {},
): Promise<string[]> {
  await page.addInitScript(
    ([entries]) => {
      for (const [key, value] of entries as [string, string][]) localStorage.setItem(key, value);
    },
    [[[LAST_SEEN_KEY, version], ...Object.entries(storage)]],
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
  return pageErrors;
}

const rows = (page: Page) => page.locator('[data-job-id]');
// The client sections (the Add to Home Screen card is a section of the page too).
const sections = (page: Page) =>
  page.locator('[data-slot="phone-jobs-page"] section:not([data-slot="install-card"])');
const viewButton = (page: Page) => page.getByRole('button', { name: 'View', exact: true });
const searchButton = (page: Page) => page.getByRole('button', { name: 'Search jobs and clients' });
const viewSheet = (page: Page) => page.getByRole('dialog', { name: 'View' });
const byClientSwitch = (page: Page) => viewSheet(page).getByRole('switch', { name: /^By client/ });
const showArchivedSwitch = (page: Page) =>
  viewSheet(page).getByRole('switch', { name: /^Show archived/ });

/** The words of each tab with its count ("Review 1"), in order. */
async function tabs(page: Page): Promise<string[]> {
  return (await page.getByRole('tab').allInnerTexts()).map((text) =>
    text.replace(/\s+/g, ' ').trim(),
  );
}

/** The row of a job, by name. */
const rowNamed = (page: Page, name: string) => rowOf(page, name);

/** Where a box starts and how big it is; the test fails if it is not on the page. */
async function boxOf(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  expect(box, 'the element is on the page').not.toBeNull();
  return box as { x: number; y: number; width: number; height: number };
}

test('the list: By client with tree lines, 58 px rows, a 44 px next step, the Mac’s tabs', async ({
  page,
}) => {
  const pageErrors = await open(page);

  await test.step('the header: Jobs and three 44 px buttons', async () => {
    await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
    for (const name of ['View', 'Search jobs and clients', 'Settings']) {
      const box = await boxOf(
        page.getByRole(name === 'Settings' ? 'link' : 'button', { name, exact: true }),
      );
      expect(box.width, name).toBeGreaterThanOrEqual(44);
      expect(box.height, name).toBeGreaterThanOrEqual(44);
    }
  });

  await test.step('the eight tabs with counts follow Show archived (off)', async () => {
    expect(await tabs(page)).toEqual([
      'All 4',
      'In progress 0',
      'Review 0',
      'Approved 2',
      'Delivered 1',
      'Uploaded 0',
      'Paid 0',
      'Needs attention 1',
    ]);
    // Eight tabs do not fit in 393 px: the row scrolls sideways, and the page does not.
    const tabList = page.getByRole('tablist', { name: 'Filter by status' });
    const scrolls = await tabList.evaluate((list) => {
      const holder = list.parentElement?.parentElement as HTMLElement;
      return holder.scrollWidth > holder.clientWidth;
    });
    expect(scrolls).toBe(true);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  await test.step('By client is on: a header per client, the clients by latest activity', async () => {
    const jobs = (await jobsOnServer()).filter((job) => job.archivedAt === null);
    const latest = new Map<string, { client: string; at: number }>();
    for (const job of jobs) {
      const at = Math.max(latest.get(job.clientId)?.at ?? 0, Date.parse(job.updatedAt));
      latest.set(job.clientId, { client: job.client, at });
    }
    const expectedOrder = [...latest.values()]
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.client);
    expect(expectedOrder).toHaveLength(2);

    await expect(sections(page)).toHaveCount(2);
    const labels = await sections(page).evaluateAll((all) =>
      all.map((s) => s.getAttribute('aria-label')),
    );
    expect(labels).toEqual(expectedOrder);
    const acmeId = (await jobNamed(JOB.spring)).clientId;

    // The header: avatar (24 px), the name as a link to the client's page, how many jobs.
    const acme = page.locator(`section[aria-label="${CLIENT.latin}"]`);
    const header = acme.locator(':scope > div').first();
    await expect(header).toContainText(CLIENT.latin);
    await expect(header).toContainText('3');
    expect((await boxOf(header)).height).toBe(40);
    expect((await boxOf(header.locator('[data-slot="avatar"]'))).width).toBe(24);
    await expect(header.getByRole('link', { name: CLIENT.latin })).toHaveAttribute(
      'href',
      `/clients/${acmeId}`,
    );
  });

  await test.step('the tree: first, middle, last; elbows 7 px round; the line ends at the last', async () => {
    const acme = page.locator(`section[aria-label="${CLIENT.latin}"]`);
    const positions = await acme
      .locator('[data-job-id]')
      .evaluateAll((all) => all.map((li) => li.getAttribute('data-tree')));
    expect(positions).toEqual(['first', 'middle', 'last']);

    const hebrew = page.locator(`section[aria-label="${CLIENT.hebrew}"]`);
    expect(
      await hebrew
        .locator('[data-job-id]')
        .evaluateAll((all) => all.map((li) => li.getAttribute('data-tree'))),
    ).toEqual(['only']);

    // The geometry of the board: a 1 px line at x = 27.5 px, an elbow 15 px wide into the middle.
    const row = acme.locator('[data-job-id]').first();
    const geometry = await row.evaluate((li) => {
      const [elbow, line] = [...li.querySelectorAll(':scope > span[aria-hidden]')] as HTMLElement[];
      const rowBox = li.getBoundingClientRect();
      const elbowBox = elbow?.getBoundingClientRect();
      const style = elbow ? getComputedStyle(elbow) : null;
      return {
        elbowLeft: elbowBox ? elbowBox.left - rowBox.left : null,
        elbowWidth: elbowBox?.width ?? null,
        elbowHeight: elbowBox?.height ?? null,
        rowHeight: rowBox.height,
        radius: style?.borderBottomLeftRadius ?? null,
        color: style?.borderLeftColor ?? null,
        hasLine: line !== undefined,
      };
    });
    expect(geometry.elbowLeft).toBeCloseTo(27.5, 0);
    expect(geometry.elbowWidth).toBe(15);
    expect(geometry.radius).toBe('7px');
    expect(geometry.color).toBe('rgb(63, 63, 70)');
    expect(geometry.elbowHeight ?? 0).toBeCloseTo(geometry.rowHeight / 2 + 0.5, 0);
    expect(geometry.hasLine).toBe(true);
    // The last job ends its line at the elbow.
    const lastLines = await acme
      .locator('[data-job-id]')
      .last()
      .evaluate((li) => li.querySelectorAll(':scope > span[aria-hidden]').length);
    expect(lastLines).toBe(1);
  });

  await test.step('a row is at least 58 px, indented 44 px; its next step is a 44 px button', async () => {
    const spring = rowNamed(page, JOB.spring);
    const box = await boxOf(spring);
    expect(box.height).toBeGreaterThanOrEqual(58);
    const icon = await boxOf(spring.locator('[data-status]'));
    expect(icon.x - box.x).toBeGreaterThanOrEqual(44);
    const button = action(spring, 'Share video');
    const target = await boxOf(button);
    expect(target.width).toBe(44);
    expect(target.height).toBe(44);
    // Retry from Render on the failed job, Mark paid… on the delivered one; none on the paid one.
    await expect(action(rowNamed(page, JOB.broken), 'Retry from Render')).toBeVisible();
    await expect(action(rowNamed(page, JOB.six), 'Mark paid…')).toBeVisible();
    // The second line is "detail · time" under the client's name.
    await expect(spring).not.toContainText(CLIENT.latin);
    await expect(spring.locator('time')).toBeVisible();
    await expect(rowNamed(page, JOB.six)).toContainText('Delivered');
    await expect(rowNamed(page, JOB.six)).toContainText(/₪\d+ not paid/);
    await expect(rowNamed(page, JOB.broken)).toContainText('Failed at Render');
  });

  await test.step('Hebrew reads right to left inside a left-to-right row', async () => {
    const name = rowNamed(page, JOB.six).locator('.bidi').first();
    const style = await name.evaluate((el) => {
      const computed = getComputedStyle(el);
      const row = el.closest('[data-job-id]') as HTMLElement;
      return {
        dir: el.getAttribute('dir'),
        unicodeBidi: computed.unicodeBidi,
        textAlign: computed.textAlign,
        rowDirection: getComputedStyle(row).direction,
      };
    });
    expect(style.dir).toBe('auto');
    expect(style.unicodeBidi).toBe('plaintext');
    expect(style.textAlign).toBe('left');
    expect(style.rowDirection).toBe('ltr');
  });

  expect(pageErrors).toEqual([]);
});

test('a tap on a row asks for the job’s sheet; the next step is its own button', async ({
  page,
}) => {
  const pageErrors = await open(page);
  const autumn = rowNamed(page, JOB.autumn);

  const id = (await jobNamed(JOB.autumn)).id;
  await page.getByRole('button', { name: `Open ${JOB.autumn}` }).tap();
  await expect.poll(() => new URL(page.url()).searchParams.get('job')).toBe(id);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('job')).toBeNull();

  // An Approved row's next step is Share (PH15): it opens the job's sheet, where the video is
  // fetched and shared; Mark delivered is in the sheet's list, and moves the video on, with a
  // message.
  await action(autumn, 'Share video').tap();
  await expect.poll(() => new URL(page.url()).searchParams.get('job')).toBe(id);
  const sheet = page.locator('[data-slot="phone-job-sheet"]');
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-menu-row="deliver"]').tap();
  await expect(sheet.locator('[data-slot="job-sheet-status"]')).toHaveText('Delivered', WAIT);
  const message = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: `Delivered to ${CLIENT.latin}` });
  await expect(message).toBeVisible();
  // And its Undo puts it back (this test leaves the list as it found it); the sheet stays open.
  await message.getByRole('button', { name: 'Undo' }).tap();
  await expect(sheet.locator('[data-slot="job-sheet-status"]')).toHaveText('Approved');
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(badge(autumn, 'Approved')).toBeVisible();
  await expect(action(autumn, 'Share video')).toBeVisible();

  // Mark paid… asks for the phone's bottom sheet (PH16), which is as wide as the screen.
  await action(rowNamed(page, JOB.six), 'Mark paid…').tap();
  const dialog = page.getByRole('dialog', { name: /Mark paid/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-slot', 'phone-mark-paid-sheet');
  const box = await boxOf(dialog);
  expect(box.x).toBe(0);
  expect(box.width).toBe(393);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  expect(pageErrors).toEqual([]);
});

test('View: a bottom sheet with By client and Show archived, both remembered', async ({ page }) => {
  const pageErrors = await open(page);

  await viewButton(page).tap();
  const sheet = viewSheet(page);
  await expect(sheet).toBeVisible();
  // At the bottom of the screen, the full width.
  const box = await boxOf(sheet);
  const viewport = page.viewportSize() as { width: number; height: number };
  expect(box.x).toBe(0);
  expect(box.width).toBe(viewport.width);
  // It slides in from the bottom edge: wait for it to arrive there.
  await expect
    .poll(async () => {
      const arrived = await boxOf(sheet);
      return Math.round(arrived.y + arrived.height);
    })
    .toBe(viewport.height);
  await expect(sheet.getByText('Each client’s jobs under its name')).toBeVisible();
  await expect(
    sheet.getByText('Archived videos join their tabs, faded, with a box mark'),
  ).toBeVisible();
  // Show archived says how many are archived.
  await expect(viewSheet(page).locator('label', { hasText: 'Show archived' })).toContainText('1');
  await expect(byClientSwitch(page)).toBeChecked();
  await expect(showArchivedSwitch(page)).not.toBeChecked();
  // Rows are at least 60 px, switches 44 × 26.
  expect((await boxOf(byClientSwitch(page))).width).toBe(44);
  expect((await boxOf(byClientSwitch(page))).height).toBe(26);

  await test.step('By client off: a flat list, each row names its client; remembered after a reload', async () => {
    // A tap anywhere on the row flips its switch.
    await sheet.getByText('Each client’s jobs under its name').tap();
    await expect(byClientSwitch(page)).not.toBeChecked();
    await expect(sections(page)).toHaveCount(0);
    await expect(rowNamed(page, JOB.spring)).toContainText(`${CLIENT.latin} · `);
    expect(await page.evaluate((key) => localStorage.getItem(key), BY_CLIENT_KEY)).toContain(
      'false',
    );

    await sheet.getByRole('button', { name: 'Close' }).tap();
    await expect(sheet).toBeHidden();
    await page.reload();
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await expect(sections(page)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(4);
  });

  await test.step('Show archived: the archived video joins its tab, faded, with the box; the counts follow', async () => {
    await viewButton(page).tap();
    await showArchivedSwitch(page).tap();
    await expect(showArchivedSwitch(page)).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(viewSheet(page)).toBeHidden();

    await expect(rows(page)).toHaveCount(5);
    const five = rowNamed(page, JOB.five);
    await expect(five).toHaveAttribute('data-archived', '');
    await expect(five.locator('[aria-label="Archived"]')).toBeVisible();
    // Faded to 55%, the name muted (it is paid).
    const opacity = await five.locator('.bidi').evaluate((el) => {
      let node: Element | null = el;
      while (node !== null && node.parentElement?.tagName !== 'LI') node = node.parentElement;
      return node ? getComputedStyle(node).opacity : null;
    });
    expect(opacity).toBe('0.55');
    expect(await tabs(page)).toEqual([
      'All 5',
      'In progress 0',
      'Review 0',
      'Approved 2',
      'Delivered 1',
      'Uploaded 0',
      'Paid 1',
      'Needs attention 1',
    ]);
    // The same switch the Mac's View menu uses, remembered.
    expect(
      await page.evaluate(() => localStorage.getItem('studio.jobs.showArchived.v1')),
    ).toContain('true');
    await page.reload();
    await expect(rows(page)).toHaveCount(5);
  });

  expect(pageErrors).toEqual([]);
});

test('Search: a 40 px field with 16 px text, the Mac’s matching, "N more archived · Show"', async ({
  page,
}) => {
  const pageErrors = await open(page);
  await expect(page.locator('input[type="search"]')).toHaveCount(0);

  await searchButton(page).tap();
  const field = page.getByRole('searchbox', { name: 'Search jobs and clients' });
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  expect((await boxOf(field)).height).toBe(40);
  expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
  expect(await field.evaluate((el) => el.getAttribute('dir'))).toBe('auto');

  await test.step('the line at the end of the list offers the archive: "1 archived · Show"', async () => {
    await expect(page.getByText('1 archived ·')).toBeVisible();
  });

  await test.step('Hebrew finds the client’s videos; the archived one is "1 more archived"', async () => {
    await field.fill('Myth');
    await expect(rows(page)).toHaveCount(1);
    await expect(rowNamed(page, JOB.six)).toBeVisible();
    await expect(page.getByText('1 more archived ·')).toBeVisible();
    // A search the other client's name matches, in any case, over name and client.
    await field.fill('ACME spring');
    await expect(rows(page)).toHaveCount(1);
    await expect(rowNamed(page, JOB.spring)).toBeVisible();
    await expect(page.getByText('archived ·')).toHaveCount(0);
    await field.fill('zzzz');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText('No jobs match.')).toBeVisible();
  });

  await test.step('Show brings the archived video in and turns Show archived on', async () => {
    await field.fill('Myth');
    await page.getByRole('button', { name: 'Show', exact: true }).tap();
    await expect(rows(page)).toHaveCount(2);
    await expect(rowNamed(page, JOB.five)).toHaveAttribute('data-archived', '');
    await expect(page.getByText('archived ·')).toHaveCount(0);
  });

  await test.step('closing the field ends the search', async () => {
    await searchButton(page).tap();
    await expect(page.locator('input[type="search"]')).toHaveCount(0);
    await expect(rows(page)).toHaveCount(5);
  });

  expect(pageErrors).toEqual([]);
});

test('the tabs filter the list, and the gear leads to Settings', async ({ page }) => {
  const pageErrors = await open(page, '/jobs', {
    [BY_CLIENT_KEY]: JSON.stringify({ state: { byClient: false }, version: 1 }),
  });

  await page.getByRole('tab', { name: /^Needs attention/ }).tap();
  await expect(rows(page)).toHaveCount(1);
  await expect(rowNamed(page, JOB.broken)).toBeVisible();
  await page.getByRole('tab', { name: /^Approved/ }).tap();
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('tab', { name: /^Paid/ }).tap();
  await expect(page.getByText('No jobs match.')).toBeVisible();
  // The only paid video is archived: the line offers it.
  await expect(page.getByText('1 archived ·')).toBeVisible();
  await page.getByRole('tab', { name: /^All/ }).tap();
  await expect(rows(page)).toHaveCount(4);

  await page.getByRole('link', { name: 'Settings', exact: true }).tap();
  await expect(page.locator('[data-slot="phone-settings-page"]')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/settings');

  expect(pageErrors).toEqual([]);
});

test('the header and the tabs stay under the top of the screen while the rows scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 380 });
  const pageErrors = await open(page);
  await expect(rows(page)).toHaveCount(4);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const top = page.locator('[data-slot="phone-jobs-top"]');
  await expect(top).toBeInViewport();
  expect((await boxOf(top)).y).toBeCloseTo(0, 0);
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeInViewport();
  expect(pageErrors).toEqual([]);
});

/**
 * Screenshots of the list at 390×844, the size of the design boards, attached to the report and,
 * with PHONE_SHOTS_DIR set, written there. Each is taken in a context of its own at that size:
 * resizing the page's own window under mobile emulation makes Chrome tile the picture.
 */
async function shoot(
  browser: Browser,
  testInfo: TestInfo,
  name: string,
  {
    storage = {},
    setup,
  }: { storage?: Record<string, string>; setup?: (page: Page) => Promise<void> },
): Promise<void> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: devices['iPhone 15'].userAgent,
  });
  try {
    const page = await context.newPage();
    await open(page, '/jobs', storage);
    await setup?.(page);
    // Let the list settle (tooltips closed, sheet animation done).
    await page.waitForTimeout(700);
    const body = await page.screenshot();
    await testInfo.attach(`${name}-390x844.png`, { body, contentType: 'image/png' });
    const dir = process.env.PHONE_SHOTS_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}-390x844.png`), body);
    }
  } finally {
    await context.close();
  }
}

test('the phone jobs list at 390×844, for the design check', async ({ browser }, testInfo) => {
  const flat = { [BY_CLIENT_KEY]: JSON.stringify({ state: { byClient: false }, version: 1 }) };
  await shoot(browser, testInfo, 'phone-jobs-grouped', {});
  await shoot(browser, testInfo, 'phone-jobs-flat', { storage: flat });
  await shoot(browser, testInfo, 'phone-jobs-view', {
    setup: async (page) => {
      await viewButton(page).tap();
      await expect(viewSheet(page)).toBeVisible();
    },
  });
  await shoot(browser, testInfo, 'phone-jobs-search', {
    setup: async (page) => {
      await searchButton(page).tap();
      await page.getByRole('searchbox', { name: 'Search jobs and clients' }).fill('Myth');
      await expect(page.getByText('1 more archived ·')).toBeVisible();
    },
  });
  await shoot(browser, testInfo, 'phone-jobs-archived', {
    storage: {
      'studio.jobs.showArchived.v1': JSON.stringify({ state: { showArchived: true }, version: 1 }),
    },
  });
});
