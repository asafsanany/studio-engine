// What the job-sheet spec knows about the Jobs page with a job open under its row: finding the open
// job's panel and its parts, rows by id, the address' `job` parameter, and a recorder for the
// status the open row went through (a status can be on screen for less than a polling interval).
//
// The panel and the rows are found by their data attributes, not by their ARIA role: while a modal
// is open (the Review dialog over the list) everything behind it is `aria-hidden`, and a role query
// would not see it then.

import { expect, type Locator, type Page } from '@playwright/test';

/** The open job's panel: under its row, inside the row's item (`JobRowPanel`). */
export function sheetOf(page: Page): Locator {
  return page.locator('[data-slot="job-row-panel"]');
}

/** The row of the open job, whose item holds the panel. */
export function openRow(page: Page): Locator {
  return page.locator('[data-job-id][data-sheet-open]');
}

/**
 * What the open row's status icon says the job is: its stage for a finished job ("approved",
 * "delivered", ...), its state otherwise ("review", "editing", "queued"). A render is "editing".
 */
export async function openRowStatus(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const icon = document.querySelector(
      '[data-sheet-open] > [data-status], [data-sheet-open] > :not([data-slot="job-row-panel"]) [data-status]',
    );
    return icon?.getAttribute('data-stage') ?? icon?.getAttribute('data-status') ?? null;
  });
}

/** The sentence and the buttons under the name ("The first cut is ready, 0:06…"). */
export function sheetNow(page: Page): Locator {
  return sheetOf(page).locator('[data-slot="job-sheet-now"]');
}

/** The panel's next-step button, by its kind (`review`, `deliver`, `pay`, ...). */
export function sheetAction(page: Page, kind: string): Locator {
  return sheetOf(page).locator(`[data-sheet-action="${kind}"]`);
}

/** A button of the panel, by its accessible name ("More actions", "Retry from Generate"). */
export function panelButton(page: Page, name: string): Locator {
  return sheetOf(page).getByRole('button', { name });
}

/** Where a click lands on the row's own padding: no client link, no mark, no button. */
export const ROW_PADDING = { position: { x: 6, y: 22 } } as const;

/** The row of the job with this id. */
export function rowById(page: Page, id: string): Locator {
  return page.locator(`[data-job-id="${id}"]`);
}

/** The ids of the rows on the page now, top to bottom. */
export function rowIds(page: Page): Promise<string[]> {
  return page
    .locator('ul[aria-label="Jobs"] > [data-job-id]')
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.jobId ?? ''));
}

/** The "11–13 of 13" under the list: which rows the page shows. */
export function rangeText(page: Page): Locator {
  return page.locator('[aria-live="polite"]').filter({ hasText: /\d+–\d+ of \d+/ });
}

/** The `job` parameter of the address: the job whose sheet is open, or `null`. */
export function jobParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('job');
}

/** Opens a job under its row with a click on the row, and waits for the panel and the address. */
export async function openSheetByClick(page: Page, row: Locator): Promise<string> {
  const id = await row.getAttribute('data-job-id');
  expect(id, 'the row has a data-job-id').not.toBeNull();
  await row.click(ROW_PADDING);
  await expect(sheetOf(page)).toBeVisible();
  await expect.poll(() => jobParam(page)).toBe(id);
  return id as string;
}

/** Closes the open job with a second click on its row, and waits for the panel to go. */
export async function closeSheetByClick(page: Page): Promise<void> {
  await openRow(page).click(ROW_PADDING);
  await expect(sheetOf(page)).toHaveCount(0);
  await expect.poll(() => jobParam(page)).toBeNull();
}

/**
 * Opens the app at `path` and closes "What's new", which a browser that has not seen this version
 * is greeted with. Resolves to the list that collects the page's errors from now on.
 */
export async function openApp(page: Page, baseURL: string, path = '/'): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseURL}${path}`);
  const whatsNew = page.getByRole('dialog', { name: /What's new/ });
  await whatsNew.waitFor({ timeout: 5_000 }).then(
    () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
    () => {}, // no dialog: nothing to dismiss
  );
  await expect(whatsNew).toBeHidden();
  return pageErrors;
}

/**
 * Starts writing down the status the open row shows (see {@link openRowStatus}), every time it
 * changes, from now on. A MutationObserver looks after each DOM change, so no status is missed
 * between two polls.
 */
export async function recordSheetStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __sheetStatus: string[] }).__sheetStatus = seen;
    const sample = () => {
      const icon = document.querySelector(
        '[data-sheet-open] > [data-status], [data-sheet-open] > :not([data-slot="job-row-panel"]) [data-status]',
      );
      const text = icon?.getAttribute('data-stage') ?? icon?.getAttribute('data-status');
      if (text && seen.at(-1) !== text) seen.push(text);
    };
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    sample();
  });
}

/** The statuses the open row showed since {@link recordSheetStatus}, repeats collapsed. */
export function sheetStatuses(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __sheetStatus: string[] }).__sheetStatus);
}

/**
 * The ⋯ menu of the open job. It is a dropdown named by its button ("More actions"), where the
 * row's right-click menu is named "Actions for <job>" (`rowMenu` in jobs-ui.ts).
 */
export function moreMenu(page: Page): Locator {
  return page.getByRole('menu', { name: 'More actions' });
}

/** The names of the items of an open menu, in order (a submenu's trigger reads with its value). */
export async function menuItemTexts(menu: Locator): Promise<string[]> {
  const texts = await menu.getByRole('menuitem').allInnerTexts();
  return texts.map((text) => text.replace(/\s+/g, ' ').trim());
}

/** The jobs the engine lists, as the Jobs page gets them. */
export async function jobsOf(
  baseURL: string,
): Promise<{ id: string; name: string; client: string; clientId: string; state: string }[]> {
  return (await (await fetch(`${baseURL}/api/jobs`)).json()) as {
    id: string;
    name: string;
    client: string;
    clientId: string;
    state: string;
  }[];
}
