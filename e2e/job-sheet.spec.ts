// JS7, then v0.67.0: a job opens under its row (it was a sheet from the right), on the built server
// with the fake runner, driven through the real UI. The Job sheet switch is left at the engine's
// default (on), so this also says the default is on. Three engines of their own (temp inbox, data
// folder and port), like review.spec.ts, so smoke.spec.ts still starts on an empty one.
//
//   flow     one job from "Ready to review" to Delivered with it open (engine A, Review on)
//            - a click on the row opens it under the row, with its address (?job=<id>)
//            - Review opens over the list, and closing it leaves the job open (whose ⋯ has no
//              Approve: it is the row's right-click menu's own, the owner 31 Oct); Approve from that
//              menu leaves it open, saying Approved, live; Mark delivered from it turns it
//              Delivered, on the row too
//            - a second click on the row closes it, and the focus stays on the row
//   open     every way in and out (engine A, the delivered job)
//            - the client's link, the Action button and the note mark do their own thing, and so
//              does a click inside the open job
//            - Enter on a focused row opens it; Esc closes it and the focus is back on the row
//            - Back closes it, and Back again does not reopen it; a click on another row moves it
//            - a reload with ?job= reopens it; an unknown id opens nothing and is dropped
//            - the ⋯ menu has the row menu's items, item for item (Delete… and Approve are the
//              right-click menu's own)
//   list     thirteen jobs on two pages (engine B, an edit that lasts the whole test)
//            - ?job= of a job on the second page turns the list there and opens it
//            - the arrow keys move between the rows, and Enter opens the one in focus
//            - an open job stays in a tab that leaves it out; it goes when it closes
//            - the same on a client's page
//   off      with STUDIO_JOB_SHEET=0 (engine C) a click opens nothing and ?job= is ignored
//
// The rows' states are told by the icons of support/jobs-ui.ts; nothing leaves the engine's origin.

import { expect, test } from '@playwright/test';
import { approveFromRowMenu } from './support/approve-ui.ts';
import { type Engine, startEngine } from './support/engine.ts';
import {
  action,
  badge,
  menuItem,
  noteDialog,
  noteMarker,
  openRowMenu,
  rowMenu,
  rowOf,
  stepBar,
} from './support/jobs-ui.ts';
import { reviewDialog } from './support/review-ui.ts';
import {
  closeSheetByClick,
  jobParam,
  jobsOf,
  menuItemTexts,
  moreMenu,
  openApp,
  openRow,
  openRowStatus,
  openSheetByClick,
  panelButton,
  ROW_PADDING,
  rangeText,
  recordSheetStatus,
  rowById,
  rowIds,
  sheetAction,
  sheetNow,
  sheetOf,
  sheetStatuses,
} from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Sheet flow';

/** As in the other specs: a whole fake edit takes about 15 s at this speed. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 4);
const RUN = { timeout: 60_000 };

/**
 * The row's right-click menu ends with Delete… (v0.26.0); the open job's ⋯ menu is the same list
 * without it (`withDelete` is the row's only). Answers the row's items without that last one.
 */
function withoutDelete(rowItems: string[]): string[] {
  expect(rowItems.at(-1), 'the right-click menu ends with Delete…').toBe('Delete…');
  return rowItems.slice(0, -1);
}

// --- flow and open: one job, from Review to Delivered, and every way in and out ----------------

test.describe('a job open under its row: from Review to Delivered, and every way in and out', () => {
  // Each test starts where the last one left the job: one failing stops the rest.
  test.describe.configure({ mode: 'serial' });

  let engine: Engine;
  let id = '';

  test.beforeAll(async () => {
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('a click on the row opens it under the row; Review from it, Approve from the row menu, and it says Approved, live', async ({
    page,
  }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    // The switch is on without being asked.
    expect(await (await fetch(`${engine.baseURL}/api/health`)).json()).toMatchObject({
      jobSheet: true,
    });
    // Every request of the page must stay on the engine's origin.
    const offOrigin: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(engine.baseURL) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        offOrigin.push(url);
      }
    });

    const row = rowOf(page, JOB);
    await engine.createJob({ client: CLIENT, job: JOB });
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    await expect(sheetOf(page)).toHaveCount(0);

    await test.step('a click on the row opens it under the row, with the job in the address', async () => {
      id = await openSheetByClick(page, row);
      const sheet = sheetOf(page);
      // A region named by the job, inside its row: no dialog, nothing dimmed.
      await expect(sheet).toHaveAttribute('aria-label', JOB);
      await expect(row.locator('[data-slot="job-row-panel"]')).toHaveCount(1);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(row).toHaveAttribute('data-sheet-open', '');
      expect(await openRowStatus(page)).toBe('review');
      await expect(sheetNow(page)).toContainText('The first cut is ready, 0:06.');
      await expect(sheet.locator('[data-slot="job-sheet-steps"]')).toContainText('Your review');
      // The panel is as wide as the list, under the row.
      const rowBox = await row.boundingBox();
      const panelBox = await sheet.boundingBox();
      expect(panelBox?.y ?? 0).toBeGreaterThan((rowBox?.y ?? 0) + 40);
      expect(panelBox?.width ?? 0).toBeGreaterThan(600);
    });

    await recordSheetStatus(page);
    const dialog = reviewDialog(page);

    await test.step('Review opens over the list', async () => {
      await sheetAction(page, 'review').click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(JOB);
      await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
        'data-status',
        'ready',
        { timeout: 30_000 },
      );
      // The job is still open under its row, behind it.
      await expect(sheetOf(page)).toHaveCount(1);
      expect(jobParam(page)).toBe(id);
    });

    await test.step('closing Review leaves it open, and its ⋯ has no Approve', async () => {
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(sheetOf(page)).toBeVisible();
      expect(jobParam(page)).toBe(id);
      await panelButton(page, 'More actions').click();
      await expect(moreMenu(page)).toBeVisible();
      await expect(moreMenu(page)).toContainText('Review…');
      expect(await menuItemTexts(moreMenu(page))).not.toContain('Approve');
      await page.keyboard.press('Escape');
      await expect(moreMenu(page)).toBeHidden();
      await expect(sheetOf(page)).toBeVisible();
    });

    await test.step('Approve from the row’s right-click menu leaves it open, saying Approved', async () => {
      // The row stays in view above the open job, so its right-click menu is a click away.
      await approveFromRowMenu(page, row);
      expect(jobParam(page)).toBe(id);
      await expect.poll(() => openRowStatus(page), RUN).toBe('approved');

      // The job is Queued for a moment while the worker picks the render up, which is left out
      // of the way the status is told. The render (an editing run on the row) too: it reuses the
      // MP4 Review made, so it can be done before the row hears of it.
      const statuses = (await sheetStatuses(page)).filter(
        (status) => status !== 'queued' && status !== 'editing',
      );
      expect(statuses, `statuses seen: ${statuses.join(' → ')}`).toEqual(['review', 'approved']);
      // Approved: the MP4 is ready, the next step is Mark delivered, and Download is beside it.
      await expect(sheetNow(page)).toContainText(/The MP4 is ready: 0:0\d, /);
      await expect(sheetAction(page, 'deliver')).toHaveText('Mark delivered');
      await expect(sheetNow(page).locator('a[data-sheet-download]')).toHaveAttribute(
        'href',
        `/api/jobs/${id}/download`,
      );
      // A finished job folds its steps into one line.
      await expect(sheetOf(page).locator('[data-slot="job-sheet-steps"]')).toContainText(
        'All 8 steps done',
      );
      await expect(badge(row, 'Approved')).toBeVisible();
    });

    await test.step('Mark delivered from it: it says Delivered, and so does the row', async () => {
      await sheetAction(page, 'deliver').click();
      await expect.poll(() => openRowStatus(page)).toBe('delivered');
      await expect(sheetAction(page, 'pay')).toHaveText('Mark paid…');
      await expect(badge(row, 'Delivered')).toBeVisible();
      expect((await jobsOf(engine.baseURL)).find((job) => job.id === id)?.state).toBe('ready');
    });

    await test.step('a second click on the row closes it, and the focus stays on the row', async () => {
      await closeSheetByClick(page);
      await expect(row).toBeFocused();
      await expect(row).not.toHaveAttribute('data-sheet-open');
    });

    expect(pageErrors).toEqual([]);
    expect(offOrigin).toEqual([]);
  });

  test('the Action button and the client’s link do their own thing, and selecting text is not a click', async ({
    page,
  }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    const row = rowOf(page, JOB);
    await expect(badge(row, 'Delivered')).toBeVisible();

    await test.step('the Action button (Mark paid…) opens its dialog, not the job', async () => {
      await action(row, 'Mark paid…').click();
      const dialog = page.getByRole('dialog').filter({ hasText: /Mark paid/ });
      await expect(dialog).toBeVisible();
      expect(jobParam(page)).toBeNull();
      await expect(sheetOf(page)).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });

    await test.step('a drag that selects the name opens nothing', async () => {
      // Selecting text ends in a click on the row, with some text selected: not a click to open.
      const box = await row.getByText(JOB, { exact: true }).boundingBox();
      expect(box).not.toBeNull();
      const { x, y, width, height } = box as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      await page.mouse.move(x + 1, y + height / 2);
      await page.mouse.down();
      await page.mouse.move(x + width - 1, y + height / 2, { steps: 5 });
      await page.mouse.up();
      expect(await page.evaluate(() => window.getSelection()?.toString())).not.toBe('');
      expect(jobParam(page)).toBeNull();
      await expect(sheetOf(page)).toHaveCount(0);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
    });

    await test.step('a click inside the open job is the job’s: it stays open', async () => {
      await openSheetByClick(page, row);
      await sheetOf(page)
        .locator('[data-slot="job-sheet-now"]')
        .click({ position: { x: 4, y: 4 } });
      await page.waitForTimeout(300);
      expect(jobParam(page)).toBe(id);
      await expect(sheetOf(page)).toBeVisible();
      await closeSheetByClick(page);
    });

    await test.step('the client’s name goes to the client’s page', async () => {
      await row.getByRole('link', { name: CLIENT }).click();
      await expect(page).toHaveURL(/\/clients\/[^/?]+$/);
      expect(jobParam(page)).toBeNull();
      await expect(sheetOf(page)).toHaveCount(0);
    });

    expect(pageErrors).toEqual([]);
  });

  test('Enter on a focused row opens it, Esc closes it, and the focus is back on the row', async ({
    page,
  }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    const row = rowOf(page, JOB);
    await expect(badge(row, 'Delivered')).toBeVisible();

    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sheetOf(page)).toBeVisible();
    expect(jobParam(page)).toBe(id);
    await expect(openRow(page)).toHaveAttribute('data-job-id', id);

    // Enter on the open row closes it too, and opens it again.
    await page.keyboard.press('Enter');
    await expect(sheetOf(page)).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(sheetOf(page)).toBeVisible();

    // Esc from inside it closes it and gives the focus to the row.
    await sheetAction(page, 'pay').focus();
    await page.keyboard.press('Escape');
    await expect(sheetOf(page)).toHaveCount(0);
    await expect.poll(() => jobParam(page)).toBeNull();
    await expect(row).toBeFocused();

    // The keyboard goes on from the row, and its menu is still the keyboard's too.
    await page.keyboard.press('Shift+F10');
    await expect(rowMenu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rowMenu(page)).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('Back closes it, and Back again does not reopen it; a click on another row moves it there', async ({
    page,
  }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    const row = rowOf(page, JOB);
    await expect(badge(row, 'Delivered')).toBeVisible();

    await test.step('Back closes it', async () => {
      // A page before the list, so Back has somewhere to go.
      await page.getByRole('link', { name: 'Clients', exact: true }).click();
      await expect(page).toHaveURL(/\/clients$/);
      await page.getByRole('link', { name: 'Jobs', exact: true }).first().click();
      await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
      const listUrl = page.url();

      await openSheetByClick(page, row);
      await page.goBack();
      await expect(sheetOf(page)).toHaveCount(0);
      expect(page.url()).toBe(listUrl);
      expect(jobParam(page)).toBeNull();

      // Back again goes to the page before, not into the open job.
      await page.goBack();
      await expect(page).toHaveURL(/\/clients$/);
      await expect(sheetOf(page)).toHaveCount(0);
    });

    await test.step('Back after closing it goes to the page before it, not into it', async () => {
      await page.goForward();
      await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
      await openSheetByClick(page, row);
      await closeSheetByClick(page);
      await page.goBack();
      await expect(page).toHaveURL(/\/clients$/);
      await expect(sheetOf(page)).toHaveCount(0);
    });

    await test.step('a click on another row moves the open job there; Back still closes it', async () => {
      await page.goForward();
      await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
      const other = rowOf(page, 'Second job');
      await engine.createJob({ client: CLIENT, job: 'Second job' });
      await expect(other).toBeVisible(RUN);
      const listUrl = page.url();

      await openSheetByClick(page, row);
      const otherId = await openSheetByClick(page, other);
      // One job open at a time.
      await expect(sheetOf(page)).toHaveCount(1);
      await expect(openRow(page)).toHaveAttribute('data-job-id', otherId);
      await expect(row).not.toHaveAttribute('data-sheet-open');
      // The move replaced the entry: Back closes it, not back to the first job.
      await page.goBack();
      await expect(sheetOf(page)).toHaveCount(0);
      expect(page.url()).toBe(listUrl);
    });

    expect(pageErrors).toEqual([]);
  });

  test('a reload with ?job= reopens it; an unknown id opens nothing and is dropped', async ({
    page,
  }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    const row = rowOf(page, JOB);
    await expect(badge(row, 'Delivered')).toBeVisible();

    await test.step('the address opens it straight away, and a reload keeps it open', async () => {
      await page.goto(`${engine.baseURL}/jobs?job=${id}`);
      await expect(sheetOf(page)).toHaveAttribute('aria-label', JOB);
      expect(await openRowStatus(page)).toBe('delivered');

      await page.reload();
      await expect(sheetOf(page)).toHaveAttribute('aria-label', JOB);
      expect(jobParam(page)).toBe(id);
    });

    await test.step('closing a job that was opened by its address cleans the address', async () => {
      await closeSheetByClick(page);
      await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    });

    await test.step('an unknown id opens nothing and the address is cleaned', async () => {
      await page.goto(`${engine.baseURL}/jobs?job=does-not-exist`);
      await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
      await expect(rowById(page, id)).toBeVisible();
      await expect.poll(() => jobParam(page)).toBeNull();
      await expect(sheetOf(page)).toHaveCount(0);
    });

    expect(pageErrors).toEqual([]);
  });

  test('the ⋯ menu has the row menu’s items, item for item', async ({ page }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    const row = rowOf(page, JOB);
    await expect(badge(row, 'Delivered')).toBeVisible();

    const menu = await openRowMenu(page, row);
    const rowItems = await menuItemTexts(menu);
    expect(rowItems.length).toBeGreaterThan(3);
    expect(rowItems).toEqual(
      expect.arrayContaining([
        'Add note…',
        'Rename…',
        'Mark paid…',
        'Download MP4',
        'Not delivered yet',
        'Archive',
        'Delete…',
      ]),
    );
    await page.keyboard.press('Escape');
    await expect(rowMenu(page)).toBeHidden();

    await openSheetByClick(page, row);
    await panelButton(page, 'More actions').click();
    await expect(moreMenu(page)).toBeVisible();
    expect(await menuItemTexts(moreMenu(page))).toEqual(withoutDelete(rowItems));

    // Esc closes the menu first and the job stays open; the next Esc closes it.
    await page.keyboard.press('Escape');
    await expect(moreMenu(page)).toBeHidden();
    await expect(sheetOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheetOf(page)).toHaveCount(0);

    // A right-click inside the open job is the browser's, not the row's menu.
    await openSheetByClick(page, row);
    await sheetNow(page).click({ button: 'right', position: { x: 4, y: 4 } });
    await page.waitForTimeout(300);
    await expect(rowMenu(page)).toHaveCount(0);
    await closeSheetByClick(page);
    expect(pageErrors).toEqual([]);
  });
});

// --- walk: thirteen jobs on two pages, and a client's page --------------------------------------

test.describe('a job open under its row: in a list of two pages, a tab and a client’s page', () => {
  test.describe.configure({ mode: 'serial' });

  let engine: Engine;

  /** The first job edits for the whole spec (an edit lasts a thousand minutes), the rest wait. */
  const EDITING = 'Editing now';
  const ACME = ['Acme 1', 'Acme 2', 'Acme 3', 'Acme 4', 'Acme 5', 'Acme 6'] as const;
  const BETA = ['Beta 1', 'Beta 2', 'Beta 3', 'Beta 4', 'Beta 5', 'Beta 6'] as const;
  const TOTAL = 1 + ACME.length + BETA.length;

  async function createSlowly(client: string, job: string): Promise<void> {
    await engine.createJob({ client, job });
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  test.beforeAll(async () => {
    // So slow that the editing job does not move on while the spec runs: the list is ordered by
    // the last update, and a job that moves on would jump to the top in the middle of a walk.
    // One job at a time (Two jobs at once is on by default since v0.60.1), so exactly one edits.
    engine = await startEngine({
      settleMs: 2_000,
      fakeSpeed: 0.001,
      env: { STUDIO_TWO_JOBS_AT_ONCE: '0' },
    });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('thirteen jobs wait in a list of two pages, the first of them editing', async ({ page }) => {
    await openApp(page, engine.baseURL);
    await engine.createJob({ client: 'Acme', job: EDITING });
    await expect(stepBar(rowOf(page, EDITING))).toBeVisible(RUN);
    // One at a time: the file watcher of macOS can drop folders that appear all at once.
    for (const job of ACME) await createSlowly('Acme', job);
    for (const job of BETA) await createSlowly('Beta', job);

    // Settled: every one of them is in the queue, and the list has its two pages.
    await expect
      .poll(async () => (await jobsOf(engine.baseURL)).map((job) => job.state).sort(), RUN)
      .toEqual(['editing', ...Array(TOTAL - 1).fill('queued')]);
    await expect(rangeText(page)).toHaveText(`1–10 of ${TOTAL}`);
    expect(await rowIds(page)).toHaveLength(10);
  });

  test('?job= of a job on the second page turns the list there and opens it', async ({ page }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    await expect(rangeText(page)).toHaveText(`1–10 of ${TOTAL}`);
    const first = await rowIds(page);
    const all = (await jobsOf(engine.baseURL)).map((job) => job.id);
    const later = all.find((jobId) => !first.includes(jobId));
    expect(later).toBeDefined();

    await page.goto(`${engine.baseURL}/jobs?job=${later}`);
    await expect(rangeText(page)).toHaveText(`11–${TOTAL} of ${TOTAL}`);
    await expect(openRow(page)).toHaveAttribute('data-job-id', later as string);
    await expect(sheetOf(page)).toBeVisible();

    // Esc puts the focus on its row, on the page the list is on now.
    await openRow(page).focus();
    await page.keyboard.press('Escape');
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(rowById(page, later as string)).toBeFocused();
    await expect(rangeText(page)).toHaveText(`11–${TOTAL} of ${TOTAL}`);
    expect(pageErrors).toEqual([]);
  });

  test('an open job stays in a tab that leaves it out, at its place, and goes when it closes', async ({
    page,
  }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    const editing = (await jobsOf(engine.baseURL)).find((job) => job.state === 'editing');
    expect(editing).toBeDefined();
    // The Review tab has none of these jobs: they are queued or editing.
    await page.getByRole('tab', { name: /^Review/ }).click();
    await expect(page.getByText('No matching jobs.')).toBeVisible();

    await page.goto(`${engine.baseURL}/jobs?job=${editing?.id}`);
    await page.getByRole('tab', { name: /^Review/ }).click();
    await expect(openRow(page)).toHaveAttribute('data-job-id', editing?.id as string);
    expect(await rowIds(page)).toEqual([editing?.id]);

    await closeSheetByClick(page);
    await expect(page.getByText('No matching jobs.')).toBeVisible();
    await page.getByRole('tab', { name: /^All/ }).click();
    expect(pageErrors).toEqual([]);
  });

  test('the arrow keys move between the rows, and Enter opens the one in focus', async ({
    page,
  }) => {
    await openApp(page, engine.baseURL);
    const ids = await rowIds(page);
    await rowById(page, ids[0] as string).focus();
    await page.keyboard.press('ArrowDown');
    await expect(rowById(page, ids[1] as string)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rowById(page, ids[2] as string)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(rowById(page, ids[1] as string)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sheetOf(page)).toBeVisible();
    expect(jobParam(page)).toBe(ids[1]);
    // ↓ from the open row moves the focus on; the job stays open.
    await page.keyboard.press('ArrowDown');
    await expect(rowById(page, ids[2] as string)).toBeFocused();
    expect(jobParam(page)).toBe(ids[1]);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Escape');
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(rowById(page, ids[1] as string)).toBeFocused();
  });

  test('a queued job, open: its place in line, no button, and the ⋯ menu equals the row menu', async ({
    page,
  }) => {
    await openApp(page, engine.baseURL);
    const queued = (await jobsOf(engine.baseURL)).find((job) => job.state === 'queued');
    expect(queued).toBeDefined();
    const row = rowById(page, queued?.id as string);

    const menu = await openRowMenu(page, row);
    const rowItems = await menuItemTexts(menu);
    expect(rowItems).toEqual(expect.arrayContaining(['Add note…', 'Hold', 'Delete…']));
    await page.keyboard.press('Escape');
    await expect(rowMenu(page)).toBeHidden();

    await openSheetByClick(page, row);
    expect(await openRowStatus(page)).toBe('queued');
    await expect(sheetNow(page)).toContainText('in line');
    await expect(sheetNow(page).getByRole('button')).toHaveCount(0);
    await panelButton(page, 'More actions').click();
    await expect(moreMenu(page)).toBeVisible();
    expect(await menuItemTexts(moreMenu(page))).toEqual(withoutDelete(rowItems));
    await page.keyboard.press('Escape');
    await expect(moreMenu(page)).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(sheetOf(page)).toHaveCount(0);
  });

  test('the note mark shows its tooltip, not the job; the client’s link is the client’s', async ({
    page,
  }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    const queued = (await jobsOf(engine.baseURL)).find((job) => job.name === 'Acme 4');
    const row = rowById(page, queued?.id as string);

    // Saving a note holds the job while the dialog is open and puts it back in line.
    await openRowMenu(page, row);
    await menuItem(page, 'Add note…').click();
    const note = noteDialog(page);
    await expect(note).toBeVisible();
    await note.getByRole('textbox', { name: 'Note' }).fill('Mind the titles');
    await note.getByRole('button', { name: 'Save' }).click();
    await expect(note).toBeHidden();
    await expect(badge(row, 'Queued')).toBeVisible();

    await noteMarker(row).click();
    expect(jobParam(page)).toBeNull();
    await expect(sheetOf(page)).toHaveCount(0);

    // The open job shows the note, and the marker is not what opens it: the row is.
    await openSheetByClick(page, row);
    await expect(sheetOf(page)).toContainText('Mind the titles');
    await closeSheetByClick(page);

    await row.getByRole('link', { name: 'Acme' }).click();
    await expect(page).toHaveURL(/\/clients\/[^/?]+$/);
    expect(jobParam(page)).toBeNull();
    await expect(sheetOf(page)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('on a client’s page a job opens under its row the same way', async ({ page }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    const jobs = await jobsOf(engine.baseURL);
    const acme = jobs.find((job) => job.client === 'Acme');
    expect(acme).toBeDefined();
    const clientId = acme?.clientId as string;
    const beta = jobs.find((job) => job.client === 'Beta');

    await page.goto(`${engine.baseURL}/clients/${clientId}`);
    await expect(rowById(page, acme?.id as string)).toBeVisible();
    const ids = await rowIds(page);
    expect(ids).toHaveLength(1 + ACME.length);

    await test.step('a click on a row opens it, at the client’s page', async () => {
      await openSheetByClick(page, rowById(page, ids[1] as string));
      expect(new URL(page.url()).pathname).toBe(`/clients/${clientId}`);
      await expect(openRow(page)).toHaveAttribute('data-job-id', ids[1] as string);
    });

    await test.step('Esc closes it and puts the focus on the row', async () => {
      await panelButton(page, 'More actions').focus();
      await page.keyboard.press('Escape');
      await expect(sheetOf(page)).toHaveCount(0);
      expect(jobParam(page)).toBeNull();
      expect(new URL(page.url()).pathname).toBe(`/clients/${clientId}`);
      await expect(rowById(page, ids[1] as string)).toBeFocused();
    });

    await test.step('?job= opens it on the client’s page too; another client’s job is dropped', async () => {
      await page.goto(`${engine.baseURL}/clients/${clientId}?job=${ids[3]}`);
      await expect(openRow(page)).toHaveAttribute('data-job-id', ids[3] as string);
      await page.goto(`${engine.baseURL}/clients/${clientId}?job=${beta?.id}`);
      await expect(rowById(page, ids[0] as string)).toBeVisible();
      await expect.poll(() => jobParam(page)).toBeNull();
      await expect(sheetOf(page)).toHaveCount(0);
    });

    expect(pageErrors).toEqual([]);
  });
});

// --- off: STUDIO_JOB_SHEET=0 --------------------------------------------------------------------

test.describe('the job sheet: switched off', () => {
  let engine: Engine;

  test.beforeAll(async () => {
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: 1, jobSheet: false });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('a click opens nothing and ?job= is ignored', async ({ page }) => {
    const pageErrors = await openApp(page, engine.baseURL);
    expect(await (await fetch(`${engine.baseURL}/api/health`)).json()).toMatchObject({
      jobSheet: false,
    });

    const row = rowOf(page, 'Switched off');
    await engine.createJob({ client: CLIENT, job: 'Switched off' });
    await expect(row).toBeVisible(RUN);
    const id = (await jobsOf(engine.baseURL)).find((job) => job.name === 'Switched off')?.id;

    await row.click(ROW_PADDING);
    await page.waitForTimeout(500);
    expect(jobParam(page)).toBeNull();
    await expect(sheetOf(page)).toHaveCount(0);

    await page.goto(`${engine.baseURL}/jobs?job=${id}`);
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    await expect(row).toBeVisible();
    await page.waitForTimeout(500);
    await expect(sheetOf(page)).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
