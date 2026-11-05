// CVP-251: Analytics. A read-only page of numbers about the work and the Claude use: the sidebar item
// opens it, every card of the design shows, and nothing on it can be clicked, typed into or
// changed, bar the Week | Month switch (CVP-276), which only changes how the numbers are counted.
// Its own engines (temp inbox, data folder and port, like archive.spec.ts), one with the
// Analytics switch on and one with it off, and the Review switch off so an edit ends ready.
//
//   switch on   the sidebar item is a link; it opens /analytics (and a reload stays there)
//               the three section headings, the five tiles and the thirteen cards are all there (Services too)
//               nothing in the page is a button, link, field or anything else you can act on,
//               bar the two buttons of the Week | Month switch
//               a new engine has no numbers: dashes in the tiles and an empty line in the cards
//               Week turns the page to the last 7 days by day (the address says ?period=week, a
//               reload keeps it, and so does going to Jobs and back: the choice is remembered) and
//               Month turns it back; the engine refuses another period (400)
//               a job that finishes (the fake runner) moves Jobs finished and Clients, live
//   switch off  the sidebar item is the disabled "coming in a later phase" one, /analytics is Not
//               found, and /api/analytics does not exist
//
// The numbers themselves (the maths, the seeded page, the real data) are covered by the unit tests
// and `pnpm seed:canvas --analytics`; this checks the page and its switch through the built engine.

import { expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import { badge, rowOf } from './support/jobs-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Spring promo';
const WAIT = { timeout: 60_000 };

/** The page's three sections, in order. */
const SECTIONS = ['Jobs', 'Reviews', 'Claude use'] as const;

/** The five tiles of the top row, in order. */
const TILES = [
  'Jobs finished',
  'Clients',
  'Files in → ready',
  'Editing time',
  'Approved first time',
] as const;

/** The cards under them, in order, as the Month period names them. */
const CARDS = [
  'Jobs delivered per day',
  'Footage edited per week',
  'A typical job, step by step',
  'Approved first time, by week',
  'What your notes are about',
  'Re-runs per approved job, by week',
  'API credits',
  'Max plan, this week',
  'What the API credits paid for',
  'What used the plan this week',
  'API credits and plan through the month',
  'Busiest week, last 8 weeks',
  'APIs and subscriptions',
] as const;

/** The same cards in the Week period: what was by week is by day. */
const WEEK_CARDS = [
  'Jobs delivered per day',
  'Footage edited per day',
  'A typical job, step by step',
  'Approved first time, by day',
  'What your notes are about',
  'Re-runs per approved job, by day',
  'API credits',
  'Max plan, this week',
  'What the API credits paid for',
  'What used the plan this week',
  'API credits and plan through the week',
  'Busiest day, last 14 days',
  'APIs and subscriptions',
] as const;

interface AnalyticsOnServer {
  generatedAt: string;
  period: 'week' | 'month';
  jobs: { tiles: { key: string; value: number | null; series: (number | null)[] }[] };
}

/** `/api/analytics` as the engine answers it (the Month period unless `period` says another). */
async function analyticsOnServer(engine: Engine, period?: string): Promise<AnalyticsOnServer> {
  const query = period === undefined ? '' : `?period=${period}`;
  const response = await fetch(`${engine.baseURL}/api/analytics${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as AnalyticsOnServer;
}

/** The Week | Month switch at the right of the title. */
const periodSwitch = (page: Page) => page.locator('main').getByRole('group', { name: 'Period' });

/** The first thing a fresh browser shows is the What's new dialog: put it away. */
async function dismissWhatsNew(page: Page): Promise<void> {
  const whatsNew = page.getByRole('dialog', { name: /What's new/ });
  await whatsNew.waitFor({ timeout: 5_000 }).then(
    () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
    () => {},
  );
  await expect(whatsNew).toBeHidden();
}

/** The sidebar's Main navigation. */
const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** A tile or card of the page, by its title. */
const card = (page: Page, title: string) =>
  page.locator('main').getByRole('region', { name: title, exact: true });

test.describe('Analytics switched on', () => {
  let engine: Engine;

  test.beforeAll(async () => {
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: 20, review: false, analytics: true });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('the sidebar item opens the page, every card shows, and nothing on it has an action', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await test.step('the engine says the switch is on, and the sidebar item is a link', async () => {
      const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
        analytics: boolean;
      };
      expect(health.analytics).toBe(true);

      await page.goto(engine.baseURL);
      await dismissWhatsNew(page);
      const item = mainNav(page).getByRole('link', { name: 'Analytics' });
      await expect(item).toBeVisible();
      await expect(item).toHaveAttribute('href', '/analytics');
      await expect(mainNav(page).getByRole('button', { name: /Analytics/ })).toHaveCount(0);
    });

    await test.step('it opens /analytics, and the item is the current one', async () => {
      await mainNav(page).getByRole('link', { name: 'Analytics' }).click();
      await expect(page).toHaveURL(/\/analytics$/);
      await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
      await expect(mainNav(page).getByRole('link', { name: 'Analytics' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      // The breadcrumb names the page too.
      await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText('Analytics');
    });

    await test.step('the three sections, the five tiles and the thirteen cards are all there', async () => {
      const main = page.locator('main');
      for (const section of SECTIONS) {
        await expect(
          main.getByRole('heading', { name: section, level: 2, exact: true }),
        ).toBeVisible();
      }
      for (const title of [...TILES, ...CARDS]) {
        const region = card(page, title);
        await expect(region, title).toBeVisible();
        await expect(
          region.getByRole('heading', { name: title, level: 3, exact: true }),
        ).toBeVisible();
      }
      expect(await main.getByRole('region').count()).toBe(TILES.length + CARDS.length);
    });

    await test.step('a new engine has no numbers: dashes in the tiles, an empty line in the cards', async () => {
      for (const title of TILES) await expect(card(page, title)).toContainText('—');
      await expect(card(page, 'A typical job, step by step')).toContainText(
        'Not enough finished jobs yet',
      );
      await expect(card(page, 'What your notes are about')).toContainText('No review notes yet');
      await expect(card(page, 'Busiest week, last 8 weeks')).toContainText('No data yet');
      // The two budgets say their own empty words: nothing spent from the credits, no plan reading.
      await expect(card(page, 'API credits')).toContainText('0%');
      await expect(card(page, 'What the API credits paid for')).toContainText(
        'Nothing has been spent from the credits yet.',
      );
      await expect(card(page, 'What used the plan this week')).toContainText(
        'No session use has been logged in this window.',
      );
      // Not the failure state.
      await expect(page.getByText("Can't reach the engine.")).toHaveCount(0);
    });

    await test.step('nothing on the page is a button, a link, a field or anything else to act on, bar the Week | Month switch', async () => {
      const actionable = [
        'a',
        'button',
        'input',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[role="switch"]',
        '[role="checkbox"]',
        // A chart's own wrappers carry tabindex -1: script-focusable, never a stop for the keyboard.
        '[tabindex]:not([tabindex="-1"])',
        '[contenteditable]',
        '[onclick]',
      ].join(',');
      const everything = await page.locator('main').locator(actionable).count();
      const inSwitch = await periodSwitch(page).locator(actionable).count();
      // The switch is two buttons, Week and Month, and nothing else can be acted on.
      expect(inSwitch).toBe(2);
      expect(everything - inSwitch).toBe(0);
    });

    await test.step('the Week | Month switch is at the right of the title, on Month', async () => {
      const group = periodSwitch(page);
      await expect(group.getByRole('button')).toHaveText(['Week', 'Month']);
      await expect(group.getByRole('button', { name: 'Month' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(group.getByRole('button', { name: 'Week' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      const title = await page.getByRole('heading', { name: 'Analytics', level: 1 }).boundingBox();
      const box = await group.boundingBox();
      expect(box?.x ?? 0).toBeGreaterThan((title?.x ?? 0) + (title?.width ?? 0));
    });

    await test.step('Week turns the page to the last 7 days by day, and the address says so', async () => {
      await periodSwitch(page).getByRole('button', { name: 'Week' }).click();

      await expect(page).toHaveURL(/\/analytics\?period=week$/);
      await expect(periodSwitch(page).getByRole('button', { name: 'Week' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      for (const title of WEEK_CARDS) await expect(card(page, title), title).toBeVisible();
      await expect(card(page, 'Footage edited per week')).toHaveCount(0);
      await expect(card(page, 'Busiest week, last 8 weeks')).toHaveCount(0);
      await expect(card(page, 'Jobs finished')).toContainText('Last 7 days');
      await expect(card(page, 'Clients')).toContainText('last 7 days');
      await expect(card(page, 'A typical job, step by step')).toContainText(
        'last 7 days; “vs before” is the 7 days before',
      );
      expect(await page.locator('main').getByRole('region').count()).toBe(
        TILES.length + WEEK_CARDS.length,
      );
    });

    await test.step('a reload keeps the Week, and the engine answers it in days', async () => {
      await page.reload();
      await expect(page).toHaveURL(/\/analytics\?period=week$/);
      await expect(periodSwitch(page).getByRole('button', { name: 'Week' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(card(page, 'Footage edited per day')).toBeVisible();

      const week = await analyticsOnServer(engine, 'week');
      expect(week.period).toBe('week');
      expect(week.jobs.tiles.every((tile) => tile.series.length === 14)).toBe(true);
      const month = await analyticsOnServer(engine, 'month');
      expect(month.period).toBe('month');
      // The Clients tile's line is by day in both periods: 60 days in the month period.
      expect(month.jobs.tiles.map((tile) => tile.series.length)).toEqual([8, 60, 8, 8, 8]);
      expect((await analyticsOnServer(engine)).period).toBe('month');
    });

    await test.step('going to Jobs and back through the sidebar keeps the Week', async () => {
      await mainNav(page).getByRole('link', { name: 'Jobs' }).click();
      await expect(page).toHaveURL(/\/jobs$/);
      await mainNav(page).getByRole('link', { name: 'Analytics' }).click();

      await expect(page).toHaveURL(/\/analytics\?period=week$/);
      await expect(periodSwitch(page).getByRole('button', { name: 'Week' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(card(page, 'Footage edited per day')).toBeVisible();
    });

    await test.step('Month turns it back, and the address is the plain /analytics again', async () => {
      await periodSwitch(page).getByRole('button', { name: 'Month' }).click();

      await expect(page).toHaveURL(/\/analytics$/);
      for (const title of CARDS) await expect(card(page, title), title).toBeVisible();
      await expect(card(page, 'Footage edited per day')).toHaveCount(0);
      await expect(card(page, 'Jobs finished')).toContainText('Last 30 days');
    });

    await test.step('after Month, going away and back through the sidebar stays on Month', async () => {
      await mainNav(page).getByRole('link', { name: 'Jobs' }).click();
      await mainNav(page).getByRole('link', { name: 'Analytics' }).click();
      await expect(page).toHaveURL(/\/analytics$/);
      await expect(card(page, 'Footage edited per week')).toBeVisible();
    });

    await test.step('the engine refuses a period it does not know (400)', async () => {
      for (const period of ['year', 'weeks', 'Week', '']) {
        const response = await fetch(`${engine.baseURL}/api/analytics?period=${period}`);
        expect(response.status, period).toBe(400);
        expect(await response.json()).toEqual({
          error: 'Send the period as week or month, like ?period=week.',
        });
      }
    });

    await test.step('the engine answers /api/analytics, and a reload stays on the page', async () => {
      const answer = await analyticsOnServer(engine);
      expect(answer.jobs.tiles.map((tile) => tile.key)).toEqual([
        'jobs-finished',
        'clients',
        'files-in-ready',
        'editing-time',
        'approved-first-time',
      ]);

      await page.reload();
      await expect(page).toHaveURL(/\/analytics$/);
      await expect(card(page, 'Jobs finished')).toBeVisible();
    });

    expect(pageErrors).toEqual([]);
  });

  test('a job that finishes moves Jobs finished and Clients while the page is open', async ({
    page,
  }) => {
    await page.goto(`${engine.baseURL}/analytics`);
    await dismissWhatsNew(page);
    await expect(card(page, 'Jobs finished')).toContainText('—');

    await engine.createJob({ client: CLIENT, job: JOB });

    // The Jobs page sees it finish (the fake edit is quick), and so does the open Analytics page,
    // which reloads its numbers on the job events.
    await expect
      .poll(async () => (await analyticsOnServer(engine)).jobs.tiles[0]?.value, WAIT)
      .toBe(1);
    await expect(card(page, 'Jobs finished')).toContainText(/Last 30 days1/, WAIT);
    await expect(card(page, 'Clients')).toContainText(/last 30 days1/, WAIT);
    // The typical job still needs more than one finished job.
    await expect(card(page, 'A typical job, step by step')).toContainText(
      'Not enough finished jobs yet',
    );

    // And the Jobs page agrees that it is done.
    await mainNav(page).getByRole('link', { name: 'Jobs' }).click();
    await expect(badge(rowOf(page, JOB), 'Approved')).toBeVisible(WAIT);
  });
});

test.describe('Analytics switched off', () => {
  let engine: Engine;

  test.beforeAll(async () => {
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: 20, review: false, analytics: false });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('the sidebar item is the disabled one, and the page and its numbers do not exist', async ({
    page,
  }) => {
    await test.step('the engine says the switch is off, and the numbers are not served', async () => {
      const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
        analytics: boolean;
      };
      expect(health.analytics).toBe(false);
      expect((await fetch(`${engine.baseURL}/api/analytics`)).status).toBe(404);
    });

    await test.step('the sidebar item is disabled, says why, and goes nowhere', async () => {
      await page.goto(engine.baseURL);
      await dismissWhatsNew(page);
      const item = mainNav(page).getByRole('button', {
        name: 'Analytics (coming in a later phase)',
      });
      await expect(item).toBeVisible();
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(mainNav(page).getByRole('link', { name: 'Analytics' })).toHaveCount(0);

      const before = page.url();
      // aria-disabled, so Playwright would wait for it to be enabled: click it anyway.
      await item.click({ force: true });
      expect(page.url()).toBe(before);
    });

    await test.step('/analytics is Not found', async () => {
      await page.goto(`${engine.baseURL}/analytics`);
      await expect(page.getByText('No such page.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toHaveCount(0);
      await expect(page.locator('main').getByRole('region')).toHaveCount(0);
    });
  });
});
