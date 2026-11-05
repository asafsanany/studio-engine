// CVP-197: Archive. A finished video is put away from its row's right-click menu, and the list is
// without it until View › Show archived is on. Its own engine (temp inbox, data folder and port),
// like effort.spec.ts, with the Review switch off so an edit ends ready. Two jobs go through the
// fake runner, quickly:
//
//   Spring promo   finishes (Approved)
//   Broken render  `.fail-at-render` -> Failed at Render
//
//   Archive        right-click -> Archive (the archive group, above Delete…, which ends every
//                  menu since v0.26.0): it leaves the list and the tab counts; the message has
//                  Undo; the server has `archivedAt`
//   Show archived  View › Show archived (off at first, with the archived count): the row is back,
//                  faded except for its next-step button, with the "Archived" box; the switch is
//                  remembered after a reload
//   Unarchive      right-click -> Unarchive (in Archive's place): "Back in Approved", Undo archives
//                  it again
//   Search         switch off, a search that archived jobs match: "1 archived · Show" turns it on
//   Client page    the same switch: "Hide archived" with it on, "1 archived · Show" with it off
//   Retry          Retry on an archived failed job takes it out of the archive: "Left the archive"

import { expect, type Locator, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, menuItem, openRowMenu, rowMenu, rowOf } from './support/jobs-ui.ts';
import { menuItemTexts } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB = { done: 'Spring promo', broken: 'Broken render' } as const;

const WAIT = { timeout: 60_000 };
const SHOW_ARCHIVED_KEY = 'studio.jobs.showArchived.v1';

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 20, review: false });
});

test.afterAll(async () => {
  await engine?.stop();
});

interface JobOnServer {
  id: string;
  clientId: string;
  name: string;
  state: string;
  archivedAt: string | null;
}

async function jobOnServer(name: string): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === name);
  expect(job, `the server lists "${name}"`).toBeDefined();
  return job as JobOnServer;
}

/** The View button, left of the search, and its menu. */
const viewButton = (page: Page) => page.getByRole('button', { name: 'View', exact: true });
const showArchivedItem = (page: Page) =>
  page.getByRole('menuitemcheckbox', { name: /^Show archived/ });

/** Opens View, and answers the Show archived item. */
async function openViewMenu(page: Page): Promise<Locator> {
  await viewButton(page).click();
  const item = showArchivedItem(page);
  await expect(item).toBeVisible();
  return item;
}

/** Turns Show archived on or off from the View menu, whatever it is now. */
async function setShowArchived(page: Page, on: boolean): Promise<void> {
  const item = await openViewMenu(page);
  if ((await item.getAttribute('aria-checked')) !== String(on)) await item.click();
  else await page.keyboard.press('Escape');
  await expect(item).toBeHidden();
}

/** The message with this text (sonner shows it bottom right for 7 s), or its Undo button. */
const message = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text });

/** The opacity of each cell of a row, left to right: status icon, name, detail, time, next step. */
async function cellOpacities(row: Locator): Promise<string[]> {
  return row.evaluate((li) => [...li.children].map((cell) => getComputedStyle(cell).opacity));
}

/** The number after a tab's name ("All 3"). */
const tabCount = (page: Page, name: string) =>
  page
    .getByRole('tab', { name: new RegExp(`^${name}`) })
    .locator('[data-slot="tabs-trigger-count"]');

test('a finished video is archived, leaves the list, comes back with Show archived, and Unarchive puts it back', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const done = rowOf(page, JOB.done);
  const broken = rowOf(page, JOB.broken);

  await test.step('two jobs finish: one Approved, one Failed', async () => {
    await page.goto(engine.baseURL);
    const whatsNew = page.getByRole('dialog', { name: /What's new/ });
    await whatsNew.waitFor({ timeout: 5_000 }).then(
      () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
      () => {},
    );
    await expect(whatsNew).toBeHidden();

    await engine.createJob({ client: CLIENT, job: JOB.done });
    await engine.createJob({ client: CLIENT, job: JOB.broken, failAt: 'render' });
    await expect(badge(done, 'Approved')).toBeVisible(WAIT);
    await expect(badge(broken, 'Failed')).toBeVisible(WAIT);
    await expect(tabCount(page, 'All')).toHaveText('2');
    expect((await jobOnServer(JOB.done)).archivedAt).toBeNull();
  });

  await test.step('View sits left of the search, and Show archived is off, with 0 archived', async () => {
    const view = viewButton(page);
    const search = page.getByRole('searchbox', { name: 'Search' });
    await expect(view).toBeVisible();
    const viewBox = await view.boundingBox();
    const searchBox = await search.boundingBox();
    expect(viewBox && searchBox && viewBox.x + viewBox.width <= searchBox.x).toBe(true);
    // A ghost button: no fill, no border, a pointer.
    await expect(view).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(view).toHaveCSS('cursor', 'pointer');

    const item = await openViewMenu(page);
    await expect(item).toHaveAttribute('aria-checked', 'false');
    await expect(item).toHaveText('Show archived0');
    // The menu opens from the button's left edge, so it never hangs out to the left of the button
    // (over the sidebar, when a narrow window wraps the toolbar and puts View at the left).
    const menuBox = await page.getByRole('menu', { name: 'View' }).boundingBox();
    expect(menuBox && viewBox && menuBox.x >= viewBox.x - 1).toBe(true);
    await page.keyboard.press('Escape');
    await expect(item).toBeHidden();
  });

  await test.step('Archive ends the archive group of an approved video’s menu, above Delete…; it leaves the list and the counts', async () => {
    await openRowMenu(page, done);
    const items = rowMenu(page).getByRole('menuitem');
    // Delete… ends every menu (v0.26.0), after a line of its own; Archive is the item before it.
    await expect(items.last()).toHaveText('Delete…');
    expect((await menuItemTexts(rowMenu(page))).slice(-2)).toEqual(['Archive', 'Delete…']);
    // A line sets each group apart: the note's, the stage's, the archive group's and Delete….
    await expect(rowMenu(page).getByRole('separator')).toHaveCount(4);
    await menuItem(page, 'Archive').click();
    await expect(rowMenu(page)).toBeHidden();

    await expect(done).toHaveCount(0);
    await expect(message(page, 'Archived “Spring promo” · it still counts on Money')).toBeVisible();
    await expect(
      message(page, 'Archived “Spring promo”').getByRole('button', { name: 'Undo' }),
    ).toBeVisible();
    // Messages have no close ×: they are the text and Undo, as on the boards (CVP-208).
    await expect(
      page.locator('[data-sonner-toast]').getByRole('button', { name: 'Close toast' }),
    ).toHaveCount(0);
    // The other job stays; the counts do not include the archived one.
    await expect(broken).toBeVisible();
    await expect(tabCount(page, 'All')).toHaveText('1');
    await expect(tabCount(page, 'Approved')).toHaveText('0');

    expect((await jobOnServer(JOB.done)).archivedAt).not.toBeNull();
  });

  await test.step('Show archived on: the row is back, faded but for its next step, with the box', async () => {
    await expect(viewButton(page)).toBeVisible();
    const item = await openViewMenu(page);
    await expect(item).toHaveText('Show archived1');
    await item.click();
    await expect(item).toBeHidden();
    // Chosen with the mouse, so no ring is left on the button (a key press would leave the quiet one).
    expect(await viewButton(page).evaluate((el) => el.matches(':focus-visible'))).toBe(false);

    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute('data-archived', '');
    await expect(tabCount(page, 'All')).toHaveText('2');
    await expect(tabCount(page, 'Approved')).toHaveText('1');

    // Status icon, name, detail and time at 55%; the next-step button as it is.
    await expect.poll(() => cellOpacities(done)).toEqual(['0.55', '0.55', '0.55', '0.55', '1']);
    await expect(action(done, 'Mark delivered')).toBeVisible();
    await expect(action(done, 'Mark delivered')).toHaveCSS('opacity', '1');

    // A not archived row is not faded, and has no box.
    await expect.poll(() => cellOpacities(broken)).toEqual(['1', '1', '1', '1', '1']);
    await expect(broken.locator('[aria-label="Archived"]')).toHaveCount(0);

    // The 14 px box after the client's name, named Archived, with the day in its tooltip.
    const box = done.locator('[aria-label="Archived"]');
    await expect(box).toBeVisible();
    const size = await box.locator('svg').boundingBox();
    expect(Math.round(size?.width ?? 0)).toBe(14);
    await box.hover();
    await expect(
      page.locator('[data-slot="tooltip-content"]:not([data-state="closed"])'),
    ).toHaveText(/^Archived \d{1,2} [A-Z][a-z]{2}$/);
    await page.mouse.move(0, 0);
  });

  await test.step('the switch is remembered across a reload', async () => {
    expect(await page.evaluate((key) => localStorage.getItem(key), SHOW_ARCHIVED_KEY)).toContain(
      '"showArchived":true',
    );
    await page.reload();
    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute('data-archived', '');
    const item = await openViewMenu(page);
    await expect(item).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
  });

  await test.step('an archived row’s menu has Unarchive in Archive’s place; it puts the video back, with Undo', async () => {
    await openRowMenu(page, done);
    await expect(rowMenu(page).getByRole('menuitem').last()).toHaveText('Delete…');
    expect((await menuItemTexts(rowMenu(page))).slice(-2)).toEqual(['Unarchive', 'Delete…']);
    await expect(menuItem(page, 'Archive')).toHaveCount(0);
    // The rest of the video’s menu is as before.
    await expect(menuItem(page, 'Mark delivered')).toBeVisible();
    await menuItem(page, 'Unarchive').click();

    await expect(message(page, 'Back in Approved: “Spring promo”')).toBeVisible();
    await expect(done).not.toHaveAttribute('data-archived', '');
    await expect.poll(() => cellOpacities(done)).toEqual(['1', '1', '1', '1', '1']);
    expect((await jobOnServer(JOB.done)).archivedAt).toBeNull();

    // Undo archives it again.
    await message(page, 'Back in Approved').getByRole('button', { name: 'Undo' }).click();
    await expect(done).toHaveAttribute('data-archived', '');
    expect((await jobOnServer(JOB.done)).archivedAt).not.toBeNull();
  });

  await test.step('with the switch off, a search the archive answers offers "1 archived · Show"', async () => {
    await setShowArchived(page, false);
    await expect(done).toHaveCount(0);

    const search = page.getByRole('searchbox', { name: 'Search' });
    // No word, no offer.
    await expect(page.getByRole('button', { name: /archived · Show/ })).toHaveCount(0);
    await search.fill('spring');
    const offer = page.getByRole('button', { name: '1 archived · Show' });
    await expect(offer).toBeVisible();
    await expect(page.getByText('No matching jobs.')).toBeVisible();

    await offer.click();
    await expect(done).toBeVisible();
    await expect(offer).toHaveCount(0);
    const item = await openViewMenu(page);
    await expect(item).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await search.fill('');
  });

  await test.step('a client’s page has the same switch: “Hide archived” on, “1 archived · Show” off', async () => {
    const { clientId } = await jobOnServer(JOB.done);
    await page.goto(`${engine.baseURL}/clients/${clientId}`);
    await expect(page.getByRole('heading', { name: CLIENT, level: 1 })).toBeVisible();
    // The header counts both jobs, archived or not.
    await expect(page.getByText(/^2 jobs/)).toBeVisible();
    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute('data-archived', '');

    await page.getByRole('button', { name: 'Hide archived' }).click();
    await expect(done).toHaveCount(0);
    await expect(page.getByText(/^2 jobs/)).toBeVisible();
    await expect(page.getByRole('button', { name: '1 archived · Show' })).toBeVisible();

    await page.getByRole('button', { name: '1 archived · Show' }).click();
    await expect(done).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide archived' })).toBeVisible();

    // And it is the Jobs page's switch: turn it off here, and the Jobs page has it off.
    await page.getByRole('button', { name: 'Hide archived' }).click();
    await page.goto(engine.baseURL);
    await expect(broken).toBeVisible();
    await expect(done).toHaveCount(0);
  });

  await test.step('Retry on an archived failed video takes it out of the archive', async () => {
    await openRowMenu(page, broken);
    await menuItem(page, 'Archive').click();
    await expect(broken).toHaveCount(0);

    await setShowArchived(page, true);
    await expect(broken).toHaveAttribute('data-archived', '');
    // The next step stays on an archived row: Retry.
    await action(broken, 'Retry from Render').click();

    await expect(
      message(page, /Left the archive: “Broken render” is (queued|editing) again/),
    ).toBeVisible();
    // No Undo: the server took it out by itself.
    await expect(
      message(page, 'Left the archive').getByRole('button', { name: 'Undo' }),
    ).toHaveCount(0);
    await expect(broken).not.toHaveAttribute('data-archived', '');
    expect((await jobOnServer(JOB.broken)).archivedAt).toBeNull();
  });

  expect(pageErrors).toEqual([]);
});
