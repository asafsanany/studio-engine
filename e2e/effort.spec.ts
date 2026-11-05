// CVP-192: the effort level of a job's edit, chosen from the row's right-click menu while it waits.
// Its own engine (temp inbox, data folder and port), like queue-place.spec.ts. The settle time is
// long, so the job stays "arriving" for the whole test until Start now sends it to the editor; the
// fake runner takes a minute per edit here.
//
//   Arriving     right-click -> Effort ▸ -> High: the gauge appears after the job's name and says
//                "Effort: High", the server has { effort: "high" }, and the menu says High at the end
//   Back         Effort ▸ -> Default: the gauge is gone and the server has null
//   Editing      Start now -> the edit runs, and Effort is locked in the menu, still saying High

import { expect, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import { action, openRowMenu, rowMenu, rowOf, stepBar } from './support/jobs-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Spring menu';

const WAIT = { timeout: 30_000 };

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 60_000, fakeSpeed: 1 });
});

test.afterAll(async () => {
  await engine?.stop();
});

async function effortOnServer(name: string): Promise<string | null | undefined> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as {
    name: string;
    effort: string | null;
  }[];
  return jobs.find((job) => job.name === name)?.effort;
}

test('the effort of a waiting job is set from its right-click menu and locked once it edits', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await test.step('the page opens, with the job arriving', async () => {
    await page.goto(engine.baseURL);
    const whatsNew = page.getByRole('dialog', { name: /What's new/ });
    await whatsNew.waitFor({ timeout: 5_000 }).then(
      () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
      () => {},
    );
    await expect(whatsNew).toBeHidden();
    await engine.createJob({ client: CLIENT, job: JOB });
    await expect(rowOf(page, JOB)).toContainText('Arriving', WAIT);
  });

  const row = rowOf(page, JOB);
  const effortItem = () => rowMenu(page).getByRole('menuitem', { name: /^Effort/ });
  const marker = (label: string) => row.locator(`[aria-label="${label}"]`);

  await test.step('a job on Default has no gauge, and High is chosen from Effort ▸', async () => {
    await expect(row.locator('[aria-label^="Effort:"]')).toHaveCount(0);
    expect(await effortOnServer(JOB)).toBeNull();

    await openRowMenu(page, row);
    await effortItem().hover();
    const levels = page.getByRole('menu', { name: 'Effort' });
    await expect(levels).toBeVisible();
    // Default (which says Extra high) is checked, and the three levels come in order after it.
    await expect(levels.getByRole('menuitemradio', { name: /^Default/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(levels.getByRole('menuitemradio', { name: /^Default/ })).toContainText(
      'Extra high',
    );
    await expect(levels.getByRole('menuitemradio')).toHaveText([
      /^Default/,
      /^Medium/,
      /^High/,
      /^Extra high/,
    ]);
    // Low and Max are not offered.
    await expect(levels.getByRole('menuitemradio', { name: /^(Low|Max)/ })).toHaveCount(0);
    await levels.getByRole('menuitemradio', { name: /^High/ }).click();
    await expect(rowMenu(page)).toBeHidden();
  });

  await test.step('the gauge shows the level, and the server has it', async () => {
    await expect(marker('Effort: High')).toBeVisible();
    await expect.poll(() => effortOnServer(JOB)).toBe('high');

    // The menu says what is chosen, and the level is checked in the list.
    await openRowMenu(page, row);
    await expect(effortItem()).toContainText('High');
    await effortItem().hover();
    await expect(
      page.getByRole('menu', { name: 'Effort' }).getByRole('menuitemradio', { name: /^High/ }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(rowMenu(page)).toBeHidden();
  });

  await test.step('Default takes the gauge away again', async () => {
    await openRowMenu(page, row);
    await effortItem().hover();
    await page
      .getByRole('menu', { name: 'Effort' })
      .getByRole('menuitemradio', { name: /^Default/ })
      .click();
    await expect(row.locator('[aria-label^="Effort:"]')).toHaveCount(0);
    await expect.poll(() => effortOnServer(JOB)).toBeNull();
  });

  await test.step('High again, then Start now: the edit runs and Effort is locked', async () => {
    await openRowMenu(page, row);
    await effortItem().hover();
    await page
      .getByRole('menu', { name: 'Effort' })
      .getByRole('menuitemradio', { name: /^High/ })
      .click();
    await expect(marker('Effort: High')).toBeVisible();

    await action(row, 'Start now').click();
    await expect(stepBar(row)).toBeVisible(WAIT);

    await openRowMenu(page, row);
    await expect(effortItem()).toHaveAttribute('data-disabled', '');
    await expect(effortItem()).toContainText('High');
    // The server refuses a change too, in its own words.
    const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as {
      id: string;
      name: string;
    }[];
    const id = jobs.find((job) => job.name === JOB)?.id;
    const refused = await fetch(`${engine.baseURL}/api/jobs/${id}/effort`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'medium' }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      'Cannot change the effort of a job that is editing.',
    );
    expect(await effortOnServer(JOB)).toBe('high');
    await page.keyboard.press('Escape');
  });

  expect(pageErrors).toEqual([]);
});
