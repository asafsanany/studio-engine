// CVP-313 (LU12): the phone has no @ picker. With the LUTs-in-notes switch on, the phone job
// sheet's "Add note…" dialog is the plain box, a note that names a LUT stays plain text in the
// sheet, and nothing asks for the LUT or graphic lists.

import { devices, expect, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({ viewport: { width: 390, height: 844 }, userAgent: devices['iPhone 15'].userAgent });

const SHEET = '[data-slot="phone-job-sheet"]';
const JOB = 'Phone note job';

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 12_000,
    fakeSpeed: 4,
    env: { STUDIO_LUTS_IN_EDITS: '1' },
  });
});

test.afterAll(async () => {
  await engine?.stop();
});

test('the phone’s note dialog has no picker and a LUT token stays plain text', async ({ page }) => {
  await engine.createJob({ client: 'Acme', job: JOB });
  await expect
    .poll(async () => {
      const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as {
        name: string;
      }[];
      return jobs.some((job) => job.name === JOB);
    })
    .toBe(true);
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as {
    id: string;
    name: string;
  }[];
  const id = jobs.find((job) => job.name === JOB)?.id ?? '';

  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  await page.addInitScript(
    ([seen, version, card]) => {
      localStorage.setItem(seen as string, version as string);
      localStorage.setItem(card as string, String(Date.now()));
    },
    ['studio.lastSeenVersion', version, 'studio.installCard.dismissedAt'],
  );
  const asked: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/luts') || path.startsWith('/api/graphics')) asked.push(path);
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}/jobs?job=${id}`);
  await expect(page.locator(SHEET)).toBeVisible();
  await page.waitForTimeout(450);

  await page.locator(`${SHEET} [data-menu-row="note"]`).click();
  const dialog = page.getByRole('dialog', { name: 'Note for the editor' });
  const box = dialog.getByRole('textbox');
  await expect(box).toHaveAttribute(
    'placeholder',
    'e.g. Keep it under 30 seconds. Use the second take of the intro.',
  );
  await box.pressSequentially('Warm it @');
  await expect(dialog.locator('[data-slot="library-picker"]')).toHaveCount(0);
  await expect(dialog.locator('[data-slot="library-picker-none"]')).toHaveCount(0);
  await box.fill('Warm it @luts/film-contrast');
  await expect(dialog.locator('[data-slot="library-uses"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  const noteBox = page.locator(`${SHEET} [data-slot="note-box"]`);
  await expect(noteBox).toContainText('Warm it @luts/film-contrast');
  await expect(noteBox.locator('[data-slot="library-token"]')).toHaveCount(0);
  expect(asked).toEqual([]);
  expect(pageErrors).toEqual([]);
});
