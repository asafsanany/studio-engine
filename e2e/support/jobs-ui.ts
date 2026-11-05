// What the smoke test knows about the Jobs page: finding a job's row, and a recorder that writes
// down every state a row went through (a state can be on screen for less than a polling interval).

import { expect, type Locator, type Page } from '@playwright/test';

/** One look at a row: its state, and for an editing row how many of the eight steps are finished. */
export interface RowSnapshot {
  /** `arriving`, `queued`, `held`, `editing`, `review`, `ready`, `failed` or `cancelled`. */
  status: string;
  /** Finished steps of the editing icon (0 to 7); -1 when the row is not editing. */
  done: number;
  /** The step name with its count ("Cut · graphics 2/3"); empty when the row is not editing. */
  step: string;
}

/**
 * The row of the job with this name. Job names in the test never contain one another.
 *
 * Found by its `data-job-id`, not by its ARIA role: while a modal dialog is open (the note
 * dialog) everything behind it is `aria-hidden`, and a role query would not see the rows then.
 */
export function rowOf(page: Page, jobName: string): Locator {
  return page.locator('[data-job-id]').filter({ hasText: jobName });
}

/** The stages of a finished job. Its icon's `data-status` stays `ready` through all four. */
const STAGES = ['approved', 'delivered', 'uploaded', 'paid'];

/**
 * The status icon of a state, found by the state it draws ("Arriving", "Queued", "Held",
 * "Cancelled", "Review": the label in lower case is the icon's `data-status`), or, for a finished
 * job, by its stage ("Approved", "Delivered", "Uploaded", "Paid": the icon's `data-stage`).
 */
export function badge(row: Locator, label: string): Locator {
  const name = label.toLowerCase();
  return inCells(row, STAGES.includes(name) ? `[data-stage="${name}"]` : `[data-status="${name}"]`);
}

/**
 * The row's own cells: everything in it but the open job's panel, which sits inside the row under
 * them and has buttons, links and icons of its own.
 */
export function cellsOf(row: Locator): Locator {
  return row.locator(':scope > :not([data-slot="job-row-panel"])');
}

/** What matches `selector` among the row's own cells (a cell itself, or inside one). */
function inCells(row: Locator, selector: string): Locator {
  return row.locator(
    `:scope > ${selector}, :scope > :not([data-slot="job-row-panel"]) ${selector}`,
  );
}

/** The icon an editing row shows (a ring with a pie of the eight steps). */
export function stepBar(row: Locator): Locator {
  return inCells(row, '[data-status="editing"]');
}

/**
 * How many of the eight steps are finished right now (the editing icon's `data-done`); 0 when the
 * row has no editing icon at the moment, without waiting for one.
 */
export async function doneSegments(row: Locator): Promise<number> {
  const done = await stepBar(row).evaluateAll((icons) => icons[0]?.getAttribute('data-done'));
  return done === undefined || done === null ? 0 : Number(done);
}

/**
 * The icon button in a row's Action column, by its accessible name ("Start now", "Release",
 * "Resume", "Retry from Render"). The column holds only the step that moves the job forward;
 * Hold, Cancel… and Copy error are in the row's right-click menu (`openRowMenu`).
 */
export function action(row: Locator, name: string): Locator {
  return cellsOf(row).getByRole('button', { name, exact: true });
}

/** The right-click menu of a row ("Actions for <job>"). Only one is ever open. */
export function rowMenu(page: Page): Locator {
  return page.getByRole('menu', { name: /^Actions for / });
}

/** One item of the open row menu, by its name ("Hold", "Cancel…", "Copy error", ...). */
export function menuItem(page: Page, name: string): Locator {
  return rowMenu(page).getByRole('menuitem', { name, exact: true });
}

/** The "Note for the editor" dialog. */
export function noteDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Note for the editor' });
}

/**
 * The marker after a job's name that says it has a note; hovering it shows the note. Found by its
 * label, not its role, so that it can also be looked for while the note dialog hides the page.
 */
export function noteMarker(row: Locator): Locator {
  return cellsOf(row).locator('[aria-label="Your note"]');
}

/** What the server says about the job with this name right now (`GET /api/jobs`). */
export async function jobOnServer(
  page: Page,
  jobName: string,
): Promise<{ id: string; state: string; note: string | null }> {
  const jobs = (await (await page.request.get('/api/jobs')).json()) as {
    id: string;
    name: string;
    state: string;
    note: string | null;
  }[];
  const job = jobs.find((candidate) => candidate.name === jobName);
  expect(job, `the server lists "${jobName}"`).toBeDefined();
  return job as { id: string; state: string; note: string | null };
}

/** Right-clicks a row (on its name, halfway down the 44 px row) and waits for its menu. */
export async function openRowMenu(page: Page, row: Locator): Promise<Locator> {
  await row.click({ button: 'right', position: { x: 160, y: 22 } });
  const menu = rowMenu(page);
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * The tooltip that is open on the page, drawn by the shared Tooltip (at most one at a time). One
 * that has closed is still in the page while it fades out, so those are left out.
 */
export function openTooltip(page: Page): Locator {
  return page.locator('[data-slot="tooltip-content"]:not([data-state="closed"])');
}

/**
 * Checks what happens to a row's tooltip after a dialog asked for from its right-click menu is
 * closed with the pointer. Focus goes back to the row's action button, for keyboard users, but the
 * button's tooltip must not open: nobody hovered or tabbed to it. Tabbing to the button after that
 * still shows the tooltip.
 */
export async function expectNoTooltipAfterDialogClosed(
  page: Page,
  row: Locator,
  tip: string,
): Promise<void> {
  const button = row.locator('[data-row-actions]').locator('a, button').first();
  await expect(button).toBeFocused();
  // A tooltip that opens on focus does so at once, within a frame or two; give it far longer.
  await page.waitForTimeout(500);
  await expect(openTooltip(page)).toHaveCount(0);

  // The keyboard still gets it: away from the button and back to it with Shift+Tab and Tab.
  await page.keyboard.press('Shift+Tab');
  await expect(button).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await expect(openTooltip(page)).toHaveText(tip);
  // The page is left as it was found.
  await page.keyboard.press('Escape');
  await expect(openTooltip(page)).toHaveCount(0);
}

/** Right-clicks a row and chooses an item of its menu. The menu closes afterwards. */
export async function chooseFromRowMenu(page: Page, row: Locator, name: string): Promise<void> {
  await openRowMenu(page, row);
  await menuItem(page, name).click();
  await expect(rowMenu(page)).toBeHidden();
}

type Trails = Record<string, RowSnapshot[]>;

/**
 * Starts writing down every state change of every row, from now on. A MutationObserver in the page
 * looks at the rows after each DOM change, so no state is missed between two Playwright polls.
 */
export async function recordRows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const trails: Trails = {};
    (window as unknown as { __trails: Trails }).__trails = trails;

    const sample = () => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-job-id]')) {
        const id = row.dataset.jobId ?? '';
        // The status icon names the state; an editing one also says how many steps are finished
        // (`data-done`) and the row's detail starts with the step (`data-step-label`).
        const icon = row.querySelector<HTMLElement>('[data-status]');
        const status = icon?.dataset.status ?? 'unknown';
        const snapshot: RowSnapshot =
          status === 'editing'
            ? {
                status,
                done: Number(icon?.dataset.done ?? 0),
                step: row.querySelector('[data-step-label]')?.textContent?.trim() ?? '',
              }
            : { status, done: -1, step: '' };
        const trail = trails[id] ?? [];
        trails[id] = trail;
        const last = trail.at(-1);
        if (
          !last ||
          last.status !== snapshot.status ||
          last.done !== snapshot.done ||
          last.step !== snapshot.step
        ) {
          trail.push(snapshot);
        }
      }
    };
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    sample();
  });
}

/** Everything the recorder saw for one job so far, oldest first. */
export async function trailOf(page: Page, row: Locator): Promise<RowSnapshot[]> {
  const id = await row.getAttribute('data-job-id');
  expect(id, 'the row has a data-job-id').not.toBeNull();
  return page.evaluate(
    (jobId) => (window as unknown as { __trails: Trails }).__trails[jobId ?? ''] ?? [],
    id,
  );
}

/** The states in a trail with repeats collapsed: editing, editing, ready -> editing, ready. */
export function statesOf(trail: readonly RowSnapshot[]): string[] {
  return trail.map((s) => s.status).filter((status, i, all) => i === 0 || all[i - 1] !== status);
}

/**
 * Asserts the job went through `expected` in this order. Other states may sit in between (a job
 * that finds the worker idle is `queued` for a few milliseconds, which a screen may never show).
 */
export function expectStates(trail: readonly RowSnapshot[], expected: readonly string[]): void {
  const seen = statesOf(trail);
  let next = 0;
  for (const status of seen) if (status === expected[next]) next += 1;
  expect(next, `states seen: ${seen.join(' → ')}; wanted, in order: ${expected.join(' → ')}`).toBe(
    expected.length,
  );
}

/** The editing snapshots of each stretch the job spent editing: one list per run, oldest first. */
export function editingRuns(trail: readonly RowSnapshot[]): RowSnapshot[][] {
  const runs: RowSnapshot[][] = [];
  let current: RowSnapshot[] | null = null;
  for (const snapshot of trail) {
    if (snapshot.status !== 'editing') {
      current = null;
      continue;
    }
    if (current === null) {
      current = [];
      runs.push(current);
    }
    current.push(snapshot);
  }
  return runs;
}
