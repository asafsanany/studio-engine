// PH19: Money on the phone, on the built server with the fake runner, in Chrome at iPhone size (the
// `phone` project of playwright.config.ts), 390×844 like the design boards, with Chrome's emulated
// notch (47 px) and home indicator (34 px) and the Phone switch on. One engine:
//
//   the tab          Money is the third tab (Jobs, Clients, Money), white on /money and muted
//                    elsewhere; a tap on it opens the phone page, with no Back header
//   the real month   a real engine with three delivered videos (one paid, one archived, one owed):
//                    the three banners on the phone say what the Mac's banners say (same text, line
//                    for line), the Expenses total is the Mac's, the rows say Paid / Not paid yet
//                    (amber) / Archived, and a tap opens one row's details at a time
//   the board month  the answer of /api/money stubbed with the board's October (26 videos at ₪40, 4
//                    not paid yet, Claude Code ₪899.90 and ChatGPT ₪69.90): MMoney. Ten rows and
//                    "Show all 26 videos" (no pager), By client with the first client open and one
//                    open at a time, the footer that adds up to the banners, Items / All charges
//                    with the total, and the month picker asking for the month it was given
//   the warning      MMoneyWarn: a money.json mistake is one line under the title
//
// The screenshots are attached to the report (test-results/, and the HTML report) next to the
// boards MMoney and MMoneyWarn; with PHONE_SHOTS_DIR set they are also written there. Nothing
// leaves the engine's origin.

import { copyFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { stubMoney } from '../support/money-board.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ mode: 'serial' });

const TAVO = 'Levy Law';
const RGM = 'RGM';
const JOB = {
  owed: 'Myth or fact 5',
  paid: 'Myth or fact 4',
  archived: 'ראיון עם השחקן',
} as const;
const WAIT = { timeout: 90_000 };

const NAV = '[data-slot="phone-tab-bar"]';
const PAGE = '[data-slot="phone-money-page"]';
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

/** The muted and the white of the tab labels (zinc-400 and zinc-50). */
const MUTED = 'rgb(161, 161, 170)';
const WHITE = 'rgb(250, 250, 250)';
/** Not paid yet: amber-200 (#FDE68A), as Chrome reports Tailwind's colour. */
const AMBER = 'oklch(0.924 0.12 95.746)';

let engine: Engine;

interface JobOnServer {
  id: string;
  name: string;
  state: string;
}

async function jobsOnServer(): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

async function idOf(name: string): Promise<string> {
  const found = (await jobsOnServer()).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no job named ${name}`);
  return found.id;
}

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${engine.baseURL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status, `POST ${path}: ${await response.clone().text()}`).toBeLessThan(300);
}

/** Today on this machine's clock, the way the engine writes a payment day (`YYYY-MM-DD`). */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 20,
    review: false,
    phone: true,
    jobSheet: true,
  });
  // The engine's data folder sits next to its inbox (support/engine.ts): both clients pay ₪40, and
  // two subscriptions that began on the 1st of this month, so this month has their charges.
  const firstOfMonth = `${today().slice(0, 8)}01`;
  await writeFile(
    join(dirname(engine.inbox), 'data', 'money.json'),
    JSON.stringify({
      pricePerJob: 40,
      clientPrices: { [TAVO]: 40, [RGM]: 40 },
      subscriptions: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          amount: 899.9,
          currency: 'ILS',
          every: 'month',
          day: 1,
          since: firstOfMonth,
        },
        {
          id: 'chatgpt',
          name: 'ChatGPT',
          amount: 69.9,
          currency: 'ILS',
          every: 'month',
          day: 1,
          since: firstOfMonth,
        },
      ],
    }),
  );

  const toMake: ReadonlyArray<readonly [client: string, job: string]> = [
    [TAVO, JOB.owed],
    [TAVO, JOB.paid],
    [RGM, JOB.archived],
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

  // Delivered one after the other (the newest delivery is listed first): the one paid, the one
  // delivered and put away without being paid, the one still owed.
  for (const name of [JOB.paid, JOB.archived, JOB.owed]) {
    await post(`/api/jobs/${await idOf(name)}/deliver`);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
  await post('/api/payments', { jobIds: [await idOf(JOB.paid)], paidOn: today() });
  await post('/api/jobs/archive', { ids: [await idOf(JOB.archived)] });
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
async function open(page: Page, path = '/money'): Promise<string[]> {
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

const tab = (page: Page, id: 'jobs' | 'clients' | 'money') =>
  page.locator(`${NAV} [data-tab="${id}"]`);
const colourOf = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).color);
const banner = (page: Page, kind: 'income' | 'expenses' | 'profit') =>
  page.locator(`${PAGE} [data-banner="${kind}"]`);
const ledger = (page: Page) => page.locator('section[aria-labelledby="phone-ledger-h"]');
const expenses = (page: Page) => page.locator('section[aria-labelledby="phone-exp-h"]');
const rows = (page: Page) => ledger(page).locator('[data-job-id]');
const groups = (page: Page) => ledger(page).locator('[data-client-id]');

/** The text of an element as a person reads it, on one line. */
async function textOf(locator: Locator): Promise<string> {
  return (await locator.innerText()).replace(/\s+/g, ' ').trim();
}

/** The phone says "videos" where the Mac says "jobs"; everything else must be the same text. */
function sameWords(text: string): string {
  return text.replace(/\b(jobs?|videos?)\b/g, 'X');
}

/** Scrolls so the top of `locator` is just under the top of the screen. */
async function scrollTo(page: Page, locator: Locator, offset = 12): Promise<void> {
  await locator.evaluate((element, gap) => {
    const top = element.getBoundingClientRect().top + window.scrollY - gap;
    window.scrollTo(0, Math.max(0, top));
  }, offset);
  await page.waitForTimeout(250);
}

test('Money is the third tab: white on /money, muted elsewhere, and a tap opens the phone page', async ({
  page,
}) => {
  const pageErrors = await open(page, '/jobs');
  await expect(page.locator(`${NAV} a`)).toHaveText([/Jobs/, 'Clients', 'Money']);
  await expect(tab(page, 'money')).not.toHaveAttribute('aria-current', 'page');
  await expect.poll(() => colourOf(tab(page, 'money'))).toBe(MUTED);
  expect((await boxOf(tab(page, 'money'))).height).toBeGreaterThanOrEqual(44);
  // Three equal parts of the 390 px bar (8 px of padding each side).
  const [jobs, clients, money] = await Promise.all(
    (['jobs', 'clients', 'money'] as const).map((id) => boxOf(tab(page, id))),
  );
  expect(Math.round(jobs?.width ?? 0)).toBe(Math.round(money?.width ?? -1));
  expect(Math.round(clients?.width ?? 0)).toBe(Math.round(money?.width ?? -1));

  await tab(page, 'money').tap();
  await expect(page).toHaveURL(/\/money$/);
  await expect(page.locator(PAGE)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Money', level: 1 })).toBeVisible();
  await expect(page.locator('[data-slot="phone-back-header"]')).toHaveCount(0);
  await expect(tab(page, 'money')).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => colourOf(tab(page, 'money'))).toBe(WHITE);
  await expect.poll(() => colourOf(tab(page, 'jobs'))).toBe(MUTED);
  // The bar is still 61 px at the bottom.
  const nav = await boxOf(page.locator(NAV));
  expect(Math.round(nav.height)).toBe(61);
  expect(Math.round(nav.y + nav.height)).toBe(844);

  await tab(page, 'jobs').tap();
  await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('a real month: the phone’s banners and total are the Mac’s, and the rows say who paid', async ({
  page,
  browser,
}) => {
  const pageErrors = await open(page);
  await expect(banner(page, 'income')).toBeVisible();

  // Three banners stacked, each the full width of the page (390 less 16 px of margin each side).
  for (const kind of ['income', 'expenses', 'profit'] as const) {
    const box = await boxOf(banner(page, kind));
    expect(Math.round(box.width), kind).toBe(358);
    expect(Math.round(box.x), kind).toBe(16);
  }
  const income = await boxOf(banner(page, 'income'));
  const expensesBox = await boxOf(banner(page, 'expenses'));
  expect(expensesBox.y).toBeGreaterThan(income.y + income.height);
  // The amount is 36 px.
  const value = banner(page, 'income').locator('span.text-4xl');
  expect(await value.evaluate((element) => getComputedStyle(element).fontSize)).toBe('36px');

  // The month picker is an outlined button 40 px high with the month's name.
  const picker = page.getByRole('combobox', { name: 'Month' });
  expect((await boxOf(picker)).height).toBe(40);
  await expect(picker).toHaveText(/^[A-Z][a-z]+ \d{4}$/);

  // The rows: Paid <day> (muted), Archived, and Not paid yet in amber, newest delivery first.
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toContainText(JOB.owed);
  await expect(rows(page).nth(1)).toContainText(JOB.archived);
  await expect(rows(page).nth(2)).toContainText(JOB.paid);
  await expect(rows(page).nth(0)).toContainText('Not paid yet');
  await expect(rows(page).nth(1)).toContainText('Archived');
  await expect(rows(page).nth(2)).toContainText(/Paid [A-Z][a-z]{2} \d{1,2}/);
  const paidColour = (row: Locator) => colourOf(row.locator('[data-paid]'));
  expect(await paidColour(rows(page).nth(0))).toBe(AMBER);
  expect(await paidColour(rows(page).nth(1))).not.toBe(AMBER);
  expect(await paidColour(rows(page).nth(2))).not.toBe(AMBER);
  // No pager, and nothing to "Show all" with three rows.
  await expect(page.getByText(/Showing \d/)).toHaveCount(0);
  await expect(ledger(page).locator('[data-slot="phone-money-more"]')).toHaveCount(0);

  // One row's details at a time, from a tap on the row.
  const first = rows(page).nth(0);
  const second = rows(page).nth(1);
  expect((await boxOf(first)).height).toBeGreaterThanOrEqual(60);
  await first.getByRole('button').tap();
  await expect(first.locator('[data-job-detail]')).toBeVisible();
  await expect(first.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await second.getByRole('button').tap();
  await expect(second.locator('[data-job-detail]')).toBeVisible();
  await expect(first.locator('[data-job-detail]')).toHaveCount(0);
  await expect(page.locator('[data-job-detail]')).toHaveCount(1);
  await second.getByRole('button').tap();
  await expect(page.locator('[data-job-detail]')).toHaveCount(0);

  // The phone's text, banner by banner, is the Mac's (the phone calls the jobs videos).
  const phoneBanners = await Promise.all(
    (['income', 'expenses', 'profit'] as const).map(async (kind) =>
      sameWords(await textOf(banner(page, kind))),
    ),
  );
  const phoneTotal = await textOf(
    expenses(page).locator('[data-slot="phone-money-expenses-total"]'),
  );
  const phoneProfit = await textOf(ledger(page).locator('[data-footer-profit]'));

  const mac = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const macPage = await mac.newPage();
    const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
      version: string;
    };
    await macPage.addInitScript(
      ([seen, value]) => localStorage.setItem(seen as string, value as string),
      [LAST_SEEN_KEY, version],
    );
    await macPage.goto(`${engine.baseURL}/money`);
    await expect(macPage.locator('[data-slot="sidebar-wrapper"]')).toBeVisible();
    await expect(macPage.locator('[data-banner="income"]')).toBeVisible();
    const macBanners = await Promise.all(
      (['income', 'expenses', 'profit'] as const).map(async (kind) =>
        sameWords(await textOf(macPage.locator(`[data-banner="${kind}"]`))),
      ),
    );
    expect(phoneBanners).toEqual(macBanners);
    // The Expenses total line, and the Profit the Month summary ends on.
    const macTotal = await textOf(
      macPage.getByRole('table', { name: 'Expenses by item' }).locator('tfoot'),
    );
    expect(phoneTotal).toBe(macTotal);
    expect(phoneProfit).toBe(await textOf(macPage.locator('[data-summary-profit]')));
  } finally {
    await mac.close();
  }
  expect(pageErrors).toEqual([]);
});

test('MMoney: ten rows and "Show all 26 videos", By client, the footer, the Expenses', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-10-22T10:00:00.000Z'));
  const asked = await stubMoney(page);
  const pageErrors = await open(page);
  await expect(banner(page, 'income')).toBeVisible();

  // The board's banners: the Mac's whole shekels, the pill, the change line, the unpaid line.
  await expect(page.getByRole('combobox', { name: 'Month' })).toHaveText('October 2026');
  await expect(banner(page, 'income')).toContainText('26 videos at ₪40');
  await expect(banner(page, 'income')).toContainText('+18%');
  await expect(banner(page, 'income')).toContainText('+₪160 vs September (₪880)');
  await expect(banner(page, 'income')).toContainText('₪160 not paid yet · 4 videos');
  await expect(banner(page, 'expenses')).toContainText('Same as September');
  await expect(banner(page, 'profit')).toContainText('+₪160 vs September (−₪90)');
  expect(asked[0]).toBe('2026-10');
  await shoot(page, testInfo, 'money');

  // Ten rows to begin with, and the button under them: no pager on the phone.
  await expect(rows(page)).toHaveCount(10);
  const more = ledger(page).locator('[data-slot="phone-money-more"]');
  await expect(more).toHaveText('Show all 26 videos');
  expect((await boxOf(more)).height).toBe(48);
  await expect(page.getByText(/Showing \d/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /next page/i })).toHaveCount(0);

  // A row opens to the Mac's four lines; the board's first row is open in MMoney.
  const first = rows(page).first();
  await first.getByRole('button').tap();
  const detail = first.locator('[data-job-detail]');
  await expect(detail.locator('[data-detail]')).toHaveText([
    /Income.*Price ₪40 · delivered Oct 22 · Not paid yet.*₪40/s,
    /Expenses.*Nothing paid for this video.*—/s,
    /Profit.*Margin 100%.*₪40$/s,
    /Your time.*Review and notes · 9 min.*₪267\/h/s,
  ]);
  await scrollTo(page, ledger(page).locator('h2'), 12);
  await shoot(page, testInfo, 'money-ledger');

  // "Show all": every row, then "Show fewer".
  await more.tap();
  await expect(rows(page)).toHaveCount(26);
  await expect(more).toHaveText('Show fewer');
  await more.tap();
  await expect(rows(page)).toHaveCount(10);
  await expect(more).toHaveText('Show all 26 videos');

  // By client: three clients, the first one open with its newest videos and "and 9 more".
  await ledger(page).getByRole('button', { name: 'By client' }).tap();
  await expect(groups(page)).toHaveCount(3);
  await expect(groups(page).nth(0)).toContainText('Levy Law');
  await expect(groups(page).nth(0)).toContainText('12 videos');
  await expect(groups(page).nth(0)).toContainText('₪480');
  await expect(groups(page).nth(1)).toContainText('RGM');
  await expect(groups(page).nth(2)).toContainText('LAKESHORE');
  await expect(groups(page).nth(0).getByRole('button').first()).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(groups(page).nth(0)).toContainText('and 9 more');
  await expect(ledger(page).locator('[data-slot="phone-money-more"]')).toHaveCount(0);
  expect(
    await groups(page)
      .nth(0)
      .locator('[data-slot="avatar"]')
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBe(28);
  // Each listed video says where it stands, like the board.
  await expect(groups(page).nth(0).locator('[data-paid]')).toHaveText([
    'Not paid yet',
    'Not paid yet',
    'Not paid yet',
  ]);
  await scrollTo(page, ledger(page).locator('h2'), 12);
  await shoot(page, testInfo, 'money-by-client');
  // One client open at a time.
  await groups(page).nth(1).getByRole('button').first().tap();
  await expect(groups(page).nth(1)).toContainText('and 5 more');
  await expect(groups(page).nth(1).locator('[data-paid]').first()).toHaveText('Paid Oct 20');
  await expect(groups(page).nth(0)).not.toContainText('and 9 more');

  // The footer adds up to the banners: 26 videos ₪1,040, not charged −₪970, Profit ₪70.
  const footer = ledger(page).locator('[data-slot="phone-money-footer"]');
  await expect(footer).toContainText('26 videos delivered');
  await expect(footer).toContainText('₪1,040 income, nothing bought for a video');
  await expect(footer).toContainText('Not charged to a video');
  await expect(footer).toContainText('−₪970');
  await expect(footer).toContainText('Claude Code ₪900 · ChatGPT ₪70');
  await expect(footer.locator('[data-footer-profit]')).toHaveText('₪70');
  expect(await colourOf(footer.locator('[data-footer-profit]'))).toBe('rgb(74, 222, 128)');

  // Expenses: Items, then All charges, with the total in the Mac's agorot.
  await scrollTo(page, expenses(page).locator('h2'), 12);
  await expect(expenses(page).getByRole('button', { name: 'Items' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(expenses(page)).toContainText('Claude Code');
  await expect(expenses(page)).toContainText('₪899.90');
  await expect(expenses(page)).toContainText('2 items · total this month');
  await expect(expenses(page)).toContainText('₪969.80');
  await shoot(page, testInfo, 'money-expenses');
  await expenses(page).getByRole('button', { name: 'All charges' }).tap();
  await expect(expenses(page)).toContainText('Oct 1');
  await expect(expenses(page)).toContainText('2 charges · total this month');
  await expect(expenses(page).locator('[data-slot="phone-money-more"]')).toHaveCount(0);

  // The month picker: a list of months, 44 px rows; another month asks the engine for it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('combobox', { name: 'Month' }).tap();
  const options = page.getByRole('option');
  await expect(options).toHaveText(['October 2026', 'September 2026']);
  // The list zooms in; measure the rows once it has settled.
  await page.waitForTimeout(400);
  expect((await boxOf(options.first())).height).toBeGreaterThanOrEqual(44);
  await options.nth(1).tap();
  await expect.poll(() => asked.at(-1)).toBe('2026-09');
  await expect(page.getByRole('combobox', { name: 'Month' })).toHaveText('September 2026');
  await expect(banner(page, 'income')).toContainText('+₪160 vs August (₪880)');
  expect(pageErrors).toEqual([]);
});

test('MMoneyWarn: a mistake in money.json is one line under the title', async ({
  page,
}, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-10-22T10:00:00.000Z'));
  await stubMoney(page, { status: 'last-good', issue: 'subscriptions[0].day: expected a number' });
  const pageErrors = await open(page);
  const line = page.locator(`${PAGE} [data-money-file]`);
  await expect(line).toBeVisible();
  await expect(line).toHaveText(
    'money.json has a mistake, so this page shows the last good numbers. Run pnpm run doctor on the Mac to see it.',
  );
  // Under the title, above the banners; the triangle is amber.
  const title = await boxOf(page.getByRole('heading', { name: 'Money', level: 1 }));
  const lineBox = await boxOf(line);
  const income = await boxOf(banner(page, 'income'));
  expect(lineBox.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
  expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(income.y);
  expect(await colourOf(line.locator('svg'))).toBe('rgb(251, 191, 36)');
  await expect(page.locator(`${PAGE} [data-banner]`)).toHaveCount(3);
  await shoot(page, testInfo, 'money-warn');
  expect(pageErrors).toEqual([]);
});

test('the Mac page is unchanged in a wide window: the sidebar, the table, the pager', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  await page.addInitScript(
    ([seen, value]) => localStorage.setItem(seen as string, value as string),
    [LAST_SEEN_KEY, version],
  );
  await page.goto(`${engine.baseURL}/money`);
  await expect(page.locator('[data-slot="sidebar-wrapper"]')).toBeVisible();
  await expect(page.locator('[data-slot="phone-shell"]')).toHaveCount(0);
  await expect(page.locator(PAGE)).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Ledger' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Ledger pages' })).toBeVisible();
});
