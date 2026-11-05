// PH4: the job sheet on the phone, on the built server with the fake runner, in Chrome at iPhone
// size (the `phone` project of playwright.config.ts), 390×844 like the design boards, with the
// Phone switch on:
//
//   a queue that waits   Editing now (editing for the whole run), Queue first and Queue second
//                        (queued behind it): the Editing, Queued, Held and Effort boards; Hold,
//                        Effort and Release from the sheet; Add note… opens the note dialog once;
//                        the address keeps the sheet (reload) and Back or × closes it
//   a failed render      `.fail-at-render` → Failed at Render: the Failed board, Copy error, Retry
//                        from Render, then Share video on the approved one (PH15) and Mark
//                        delivered from its list; and the Mac page
//                        shown inside the phone shell (a client's page) draws one sheet, not two,
//                        while a wide window of the same engine still gets the Mac's sheet
//
// The screenshots are attached to the report (test-results/, and the HTML report) next to the
// boards MJobSheetEditing / Queued / Held / Effort / Failed. Nothing leaves the engine's origin.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { devices, expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { stubShare } from '../support/share-stub.ts';

test.use({ viewport: { width: 390, height: 844 } });

const SHEET = '[data-slot="phone-job-sheet"]';
const MAC_SHEET_HEADER = '[data-slot="job-sheet-header"]';

/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
/** The localStorage key of the time the "Add to Home Screen" card was put away (install-card.ts). */
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

interface JobOnServer {
  id: string;
  clientId: string;
  name: string;
  state: string;
  effort: string | null;
  note: string | null;
  error: string | null;
}

async function jobsOf(engine: Engine): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

async function jobNamed(engine: Engine, name: string): Promise<JobOnServer> {
  const job = (await jobsOf(engine)).find((candidate) => candidate.name === name);
  if (job === undefined) throw new Error(`no job named ${name}`);
  return job;
}

/** Waits until the job named `name` is in a state `until` accepts, and returns it. */
async function follow(
  engine: Engine,
  name: string,
  until: (job: JobOnServer) => boolean,
  timeout = 60_000,
): Promise<JobOnServer> {
  let last: JobOnServer | undefined;
  await expect
    .poll(
      async () => {
        last = (await jobsOf(engine)).find((candidate) => candidate.name === name);
        return last !== undefined && until(last);
      },
      { timeout },
    )
    .toBe(true);
  if (last === undefined) throw new Error(`no job named ${name}`);
  return last;
}

/**
 * Opens `path` in a browser that has already seen this version's "What's new" (a new browser is
 * greeted with it, and it blocks the page); returns the page's errors so far, which every test
 * expects to be none.
 */
async function open(page: Page, engine: Engine, path: string): Promise<string[]> {
  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  // The install card is away too: the screenshots are of the sheet, not of what is behind it.
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

/** Opens the sheet of a job by its address and waits for it to have slid in. */
async function openSheet(page: Page, engine: Engine, job: JobOnServer, path = '/jobs') {
  const pageErrors = await open(page, engine, `${path}?job=${job.id}`);
  await settled(page);
  return pageErrors;
}

/** The sheet is open and has stopped moving (it slides in over 200 ms). */
async function settled(page: Page): Promise<void> {
  await expect(page.locator(SHEET)).toBeVisible();
  await page.waitForTimeout(450);
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}-390x844.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}-390x844.png`, { path, contentType: 'image/png' });
}

const pillOf = (page: Page): Locator => page.locator(`${SHEET} [data-slot="job-sheet-status"]`);
const menuRow = (page: Page, id: string): Locator =>
  page.locator(`${SHEET} [data-menu-row="${id}"]`);
const bigButton = (page: Page): Locator => page.locator(`${SHEET} [data-sheet-action]`);

async function menuRowIds(page: Page): Promise<string[]> {
  return page
    .locator(`${SHEET} [data-menu-row]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-row') ?? ''));
}

/** A control is at least `min` px tall. */
async function expectTall(locator: Locator, min: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(min);
}

test.describe('a queue that waits', () => {
  let engine: Engine;
  const CLIENT = 'Acme';
  const EDITING = 'Editing now';
  const FIRST = 'Queue first';
  const SECOND = 'Queue second';

  test.beforeAll(async () => {
    // A fake edit takes a minute at speed 1: far longer than this describe.
    engine = await startEngine({
      settleMs: 2_000,
      fakeSpeed: 1,
      review: false,
      phone: true,
      jobSheet: true,
    });
    for (const name of [EDITING, FIRST, SECOND]) {
      await engine.createJob({ client: CLIENT, job: name });
      await follow(engine, name, (job) => job.state === 'editing' || job.state === 'queued');
    }
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('Editing: eight segments and the step, only Cancel… in the list, the level in Details', async ({
    page,
  }, testInfo) => {
    const job = await jobNamed(engine, EDITING);
    const pageErrors = await openSheet(page, engine, job);
    const sheet = page.locator(SHEET);

    await expect(page.locator('[data-slot="phone-shell"]')).toBeVisible();
    await expect(sheet.getByRole('heading', { name: EDITING })).toBeVisible();
    await expect(sheet.getByRole('link', { name: CLIENT })).toBeVisible();
    await expect(pillOf(page)).toHaveText('Editing');
    await expect(
      sheet.locator('[data-slot="phone-sheet-steps"] > span').first().locator('span'),
    ).toHaveCount(8);
    await expect(sheet.locator('[data-slot="phone-sheet-steps"]')).toContainText(/step \d of 8/);
    expect(await menuRowIds(page)).toEqual(['cancel']);
    await expect(bigButton(page)).toHaveCount(0);
    await expect(sheet.getByText('Default · Extra high')).toBeVisible();
    // The phone has no History (the owner, CVP-277); the Mac's sheet keeps it.
    await expect(sheet.getByRole('button', { name: 'History' })).toHaveCount(0);
    await expectTall(menuRow(page, 'cancel'), 48);

    await shoot(page, testInfo, 'job-sheet-editing');
    expect(pageErrors).toEqual([]);
  });

  test('Queued, Hold, Effort and Release from the sheet', async ({ page }, testInfo) => {
    const job = await jobNamed(engine, FIRST);
    const pageErrors = await openSheet(page, engine, job);
    const sheet = page.locator(SHEET);

    await test.step('Queued: the place in line, who it waits for, no button, three rows', async () => {
      await expect(pillOf(page)).toHaveText(/^Queued · #\d in line$/);
      await expect(sheet.locator('[data-slot="phone-sheet-meta"]')).toContainText('Starts after');
      await expect(bigButton(page)).toHaveCount(0);
      expect(await menuRowIds(page)).toEqual(['note', 'effort', 'hold']);
      await shoot(page, testInfo, 'job-sheet-queued');
    });

    await test.step('Hold: the job is held, and the big button is Release', async () => {
      await menuRow(page, 'hold').click();
      await expect(pillOf(page)).toHaveText('Held');
      await expect(pillOf(page)).toHaveAttribute('data-tone', 'amber');
      await expect(bigButton(page)).toHaveText('Release');
      expect((await jobNamed(engine, FIRST)).state).toBe('held');
      expect(await menuRowIds(page)).toEqual(['note', 'effort', 'archive']);
      const box = await bigButton(page).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
      expect(box?.width ?? 0).toBeGreaterThan(390 - 40);
    });

    await test.step('Effort opens inside the sheet; picking High goes back and saves it', async () => {
      await expect(menuRow(page, 'effort')).toContainText('Default · Extra high');
      await menuRow(page, 'effort').click();
      const group = sheet.getByRole('radiogroup', { name: 'Effort' });
      await expect(group).toBeVisible();
      await expect(
        sheet.getByText('How hard the editor works on this video. Higher takes longer.'),
      ).toBeVisible();
      await expect(group.getByRole('radio')).toHaveCount(4);
      await expect(group.getByRole('radio', { name: /^Default/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await group.getByRole('radio', { name: /^High/ }).click();

      // Back on the list, with the level at the end of the row.
      await expect(group).toHaveCount(0);
      await expect(menuRow(page, 'effort')).toContainText('High');
      await expect.poll(async () => (await jobNamed(engine, FIRST)).effort).toBe('high');
    });

    await test.step('the Effort board: High checked, a check and the hints', async () => {
      await menuRow(page, 'effort').click();
      const group = sheet.getByRole('radiogroup', { name: 'Effort' });
      await expect(group.getByRole('radio', { name: /^High/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(group.getByRole('radio', { name: /^Medium/ })).toContainText('quickest');
      await expect(group.getByRole('radio', { name: /^Extra high/ })).toContainText('slowest');
      await expectTall(group.getByRole('radio').first(), 48);
      await page.waitForTimeout(150);
      await shoot(page, testInfo, 'job-sheet-effort');
      // “‹ Effort” goes back without changing anything.
      await sheet.getByRole('button', { name: 'Effort' }).first().click();
      await expect(group).toHaveCount(0);
      await expect(menuRow(page, 'effort')).toContainText('High');
    });

    await test.step('the Held board', async () => {
      await shoot(page, testInfo, 'job-sheet-held');
    });

    await test.step('Release: the big button puts it back in line', async () => {
      await bigButton(page).click();
      await expect(pillOf(page)).toHaveText(/^Queued/);
      await expect(bigButton(page)).toHaveCount(0);
      await follow(engine, FIRST, (candidate) => candidate.state === 'queued');
    });

    expect(pageErrors).toEqual([]);
  });

  test('Add note… opens the note dialog once, and the note shows in the sheet', async ({
    page,
  }) => {
    const job = await jobNamed(engine, SECOND);
    const pageErrors = await openSheet(page, engine, job);
    const sheet = page.locator(SHEET);

    await menuRow(page, 'note').click();
    // One dialog, not two: the phone sheet’s host is the only one that holds it.
    const dialog = page.getByRole('dialog', { name: 'Note for the editor' });
    await expect(dialog).toHaveCount(1);
    await dialog.getByRole('textbox').fill('Open on the logo, no music at first');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    await expect(sheet.locator('[data-slot="note-box"]')).toContainText(
      'Open on the logo, no music at first',
    );
    await expect(menuRow(page, 'note')).toContainText('Edit note…');
    await expect
      .poll(async () => (await jobNamed(engine, SECOND)).note)
      .toBe('Open on the logo, no music at first');
    expect(pageErrors).toEqual([]);
  });

  test('the address keeps the sheet: a reload keeps it open, Back and × close it', async ({
    page,
  }) => {
    const job = await jobNamed(engine, FIRST);
    const pageErrors = await open(page, engine, '/jobs');
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();

    // Open the sheet the way the Jobs list does: a new history entry marked as the sheet’s.
    await page.evaluate((id) => {
      history.pushState({ jobSheet: true }, '', `/jobs?job=${id}`);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, job.id);
    await settled(page);
    await expect(page.locator(SHEET).getByRole('heading', { name: FIRST })).toBeVisible();

    await page.reload();
    await settled(page);
    await expect(page.locator(SHEET).getByRole('heading', { name: FIRST })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('job')).toBe(job.id);

    // × closes it and takes `job` out of the address.
    await page.locator(SHEET).getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(SHEET)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('job')).toBeNull();

    // Back from a sheet the page opened closes it too.
    await page.evaluate((id) => {
      history.pushState({ jobSheet: true }, '', `/jobs?job=${id}`);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, job.id);
    await settled(page);
    await page.goBack();
    await expect(page.locator(SHEET)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('job')).toBeNull();

    expect(pageErrors).toEqual([]);
  });

  test('an address that names no job opens nothing and is cleaned', async ({ page }) => {
    const pageErrors = await open(page, engine, '/jobs?job=0000deadbeef');
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('job')).toBeNull();
    await expect(page.locator(SHEET)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('a failed render', () => {
  let engine: Engine;
  let jobDir: string;
  const CLIENT = 'Acme';
  const BROKEN = 'Broken render';

  test.beforeAll(async () => {
    engine = await startEngine({
      settleMs: 2_000,
      fakeSpeed: 8,
      review: false,
      phone: true,
      jobSheet: true,
    });
    jobDir = await engine.createJob({ client: CLIENT, job: BROKEN, failAt: 'render' });
    await follow(engine, BROKEN, (job) => job.state === 'failed');
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('Failed: the error with Copy error, Retry from Render, and Add note…, Effort, Archive', async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const job = await follow(engine, BROKEN, (candidate) => candidate.state === 'failed');
    const pageErrors = await openSheet(page, engine, job);
    const sheet = page.locator(SHEET);

    await expect(pillOf(page)).toHaveText('Failed at Render');
    await expect(pillOf(page)).toHaveAttribute('data-tone', 'red');
    await expect(sheet.locator('[data-slot="phone-sheet-steps"]')).toContainText(
      '7 of 8 done, stopped at Render',
    );
    const error = sheet.locator('[data-slot="job-sheet-error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText((job.error ?? '').split('\n')[0] ?? '');
    await expect(bigButton(page)).toHaveText('Retry from Render');
    expect(await menuRowIds(page)).toEqual(['note', 'effort', 'archive']);
    await expectTall(error.getByRole('button', { name: 'Copy error' }), 44);
    await shoot(page, testInfo, 'job-sheet-failed');

    // Copy error puts the whole text on the clipboard and says Copied for a moment.
    await error.getByRole('button', { name: 'Copy error' }).click();
    await expect(error.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(job.error);
    await expect(error.getByRole('button', { name: 'Copy error' })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('Retry from Render, then Share video, and Mark delivered from the list', async ({
    page,
  }) => {
    // The marker goes, so the render works the second time.
    await rm(join(jobDir, '.fail-at-render'), { force: true });
    const job = await jobNamed(engine, BROKEN);
    // Chrome has no iPhone share sheet: a stand-in that can share files (support/share-stub.ts).
    await stubShare(page);
    const pageErrors = await openSheet(page, engine, job);
    const sheet = page.locator(SHEET);

    await bigButton(page).click();
    await expect(pillOf(page)).not.toHaveText(/^Failed/);
    await follow(engine, BROKEN, (candidate) => candidate.state === 'ready');

    // Approved (PH15): the sheet gets the MP4, then its button is Share video; Mark delivered
    // stays in the list for a video sent another way.
    await expect(pillOf(page)).toHaveText('Approved');
    await expect(bigButton(page)).toHaveText('Share video', { timeout: 30_000 });
    expect(await menuRowIds(page)).toEqual(['deliver', 'download', 'use-look', 'archive']);
    await expect(menuRow(page, 'download')).toHaveAttribute('href', /\/api\/jobs\/.+\/download/);

    await menuRow(page, 'deliver').click();
    await expect(pillOf(page)).toHaveText('Delivered');
    await expect(bigButton(page)).toContainText('Mark paid');
    expect(await menuRowIds(page)).toEqual(['download', 'undeliver', 'archive']);
    await expect(sheet.locator('[data-slot="phone-sheet-meta"]')).toContainText('not paid');
    expect(pageErrors).toEqual([]);
  });

  test('a client’s page inside the phone shell draws one sheet, the phone’s; the Mac layout keeps the Mac’s', async ({
    page,
    browser,
  }) => {
    const job = await jobNamed(engine, BROKEN);
    const pageErrors = await openSheet(page, engine, job, `/clients/${job.clientId}`);

    await expect(page.locator(SHEET)).toHaveCount(1);
    await expect(page.locator(MAC_SHEET_HEADER)).toHaveCount(0);
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(1);
    expect(pageErrors).toEqual([]);

    // The same engine at the Mac’s width: the Mac’s sheet, from the right, and no phone sheet.
    const wide = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: devices['Desktop Chrome'].userAgent,
    });
    try {
      const desktop = await wide.newPage();
      await open(desktop, engine, `/jobs?job=${job.id}`);
      await expect(desktop.locator(MAC_SHEET_HEADER)).toBeVisible();
      await expect(desktop.locator(SHEET)).toHaveCount(0);
    } finally {
      await wide.close();
    }
  });
});
