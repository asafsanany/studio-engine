// C11: a client before its first video, on the built server with the fake runner. Its own engine
// (temp inbox, data folder and port), like style.spec.ts, so the other specs still start on an
// empty one. Everything goes through the real UI.
//
//   Clients       an inbox with no client folder: "No clients yet." and a New client button
//   New client    the dialog: Cancel makes nothing; a name the rules refuse says so under the field;
//                 Create makes <inbox>/<client>/ and its _Style, and opens the Style page
//   Style page    the client has no jobs: the drop zone; notes.txt and a PNG go up, style.md appears
//   duplicate     the same name again: "A client with that name already exists."
//   client page   "0 jobs", "No jobs yet." with the Style button; the Clients list shows 0 and "—"
//   first job     a job folder dropped for the client: the page turns into the jobs list by itself,
//                 and the job's edit/brief.md ends with the "Client style" section (C5)
//   Hebrew        a Hebrew name works the same way

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';

const CLIENT = 'Fresh Studio';
const HEBREW_CLIENT = 'מאפיית הים';

/** A fake edit takes about 15 s at this speed; the style run a quarter of a second. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 4);
const WAIT = { timeout: 30_000 };

/** A 1×1 PNG: a real image, so the Read pass sees what a dropped screenshot looks like. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let engine: Engine;

test.beforeAll(async () => {
  // The first job waits until it is ready or failed, so it runs without Review.
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED, review: false });
});

test.afterAll(async () => {
  await engine?.stop();
});

interface ClientRow {
  clientId: string;
  client: string;
  jobs: number;
  lastJobAt: string | null;
  style: { state: string; updatedAt: string | null };
}

async function clientRows(): Promise<ClientRow[]> {
  return (await (await fetch(`${engine.baseURL}/api/clients`)).json()) as ClientRow[];
}

async function jobRows(): Promise<{ id: string; name: string; state: string }[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as {
    id: string;
    name: string;
    state: string;
  }[];
}

/** Opens the Clients page and gets past the "What's new" greeting a browser that is new gets. */
async function openClients(page: Page) {
  await page.goto(`${engine.baseURL}/clients`);
  const whatsNew = page.getByRole('dialog', { name: /What's new/ });
  await whatsNew.waitFor({ timeout: 5_000 }).then(
    () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
    () => {},
  );
  await expect(whatsNew).toBeHidden();
}

test('a client can be made before its first video, given a style, and then gets its first job', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const dialog = page.getByRole('dialog', { name: 'New client' });
  const nameField = dialog.getByRole('textbox', { name: 'Name' });
  const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
  const styleDir = join(engine.inbox, CLIENT, '_Style');
  let clientId = '';

  await test.step('an inbox with no client folder says so, and has a New client button', async () => {
    await openClients(page);
    await expect(page.getByText('No clients yet.')).toBeVisible();
    const button = page.getByRole('button', { name: 'New client' });
    await expect(button).toBeVisible();
    // At the right of the toolbar: the search box is to its left, on the same row.
    const search = await page.getByRole('searchbox', { name: 'Search clients' }).boundingBox();
    const where = await button.boundingBox();
    expect(search && where && search.x + search.width <= where.x).toBe(true);
    expect(Math.abs((search?.y ?? 0) - (where?.y ?? 99))).toBeLessThan(8);
    expect(await clientRows()).toEqual([]);
  });

  await test.step('the dialog: Cancel makes nothing', async () => {
    await page.getByRole('button', { name: 'New client' }).click();
    await expect(dialog).toBeVisible();
    await expect(nameField).toBeFocused();
    await expect(nameField).toHaveAttribute('dir', 'auto');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeVisible();
    await nameField.fill(CLIENT);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await clientRows()).toEqual([]);
    expect(existsSync(join(engine.inbox, CLIENT))).toBe(false);
  });

  await test.step('a name the rules refuse is said under the field, and typing again clears it', async () => {
    await page.getByRole('button', { name: 'New client' }).click();
    // The dialog starts empty again.
    await expect(nameField).toHaveValue('');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Give the client a name.');

    await nameField.fill('a/b');
    await nameField.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('can’t contain / or :');
    await expect(nameField).toHaveAttribute('aria-invalid', 'true');
    // Still open; nothing was made.
    await expect(dialog).toBeVisible();
    expect(await clientRows()).toEqual([]);

    await nameField.fill('_hidden');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toContainText('can’t start with . or _');
    await nameField.fill('x');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });

  await test.step('Create makes the client’s folder and opens its Style page', async () => {
    await nameField.fill(`  ${CLIENT}  `);
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}\/style$/, WAIT);
    clientId = page.url().match(/\/clients\/([0-9a-f]{12})\/style$/)?.[1] ?? '';
    await expect(dialog).toBeHidden();
    await expect(crumbs).toContainText(`Clients${CLIENT}Style`);
    await expect(crumbs.getByRole('link')).toHaveText(['Clients', CLIENT]);

    // The folder and its _Style are there; no job was made.
    expect(existsSync(join(engine.inbox, CLIENT))).toBe(true);
    expect(existsSync(styleDir)).toBe(true);
    expect(await jobRows()).toEqual([]);
    expect(await clientRows()).toMatchObject([
      { clientId, client: CLIENT, jobs: 0, lastJobAt: null, style: { state: 'none' } },
    ]);
  });

  await test.step('the Style page of a client with no jobs takes files like any other', async () => {
    await expect(page.getByRole('heading', { name: 'No style yet' })).toBeVisible();
    await expect(page.getByText('or drop files here')).toBeVisible();
    expect(existsSync(join(styleDir, 'style.md'))).toBe(false);

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText('Browse files', { exact: true }).click(),
    ]);
    await chooser.setFiles([
      {
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Warm colours. Slow pacing.'),
      },
      { name: 'logo.png', mimeType: 'image/png', buffer: PNG },
    ]);

    await expect(
      page.getByRole('status').filter({ hasText: 'Wrote style.md from 2 files.' }),
    ).toBeVisible(WAIT);
    await expect(page.getByRole('heading', { name: `Style: ${CLIENT}`, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Look', level: 2 })).toBeVisible();
    expect(await readFile(join(styleDir, 'notes.txt'), 'utf8')).toBe('Warm colours. Slow pacing.');
    expect(existsSync(join(styleDir, 'logo.png'))).toBe(true);
    expect(await readFile(join(styleDir, 'style.md'), 'utf8')).toContain(`# Style: ${CLIENT}`);
  });

  await test.step('the same name again is refused: it is taken', async () => {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Clients' })
      .click();
    await page.getByRole('button', { name: 'New client' }).click();
    await nameField.fill(CLIENT);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'A client with that name already exists.',
      WAIT,
    );
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await clientRows()).toHaveLength(1);
  });

  await test.step('the Clients list has the client: 0 jobs and a dash for the last job', async () => {
    const row = page.locator('tr[data-client-id]').filter({ hasText: CLIENT });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('cell').nth(1)).toHaveText('0');
    await expect(row.getByRole('cell').nth(2)).toHaveText('—');
    await expect(page.getByText('No clients yet.')).toHaveCount(0);
  });

  await test.step('its page says "0 jobs" and "No jobs yet.", and the Style button works', async () => {
    await page.locator('tr[data-client-id]').filter({ hasText: CLIENT }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${clientId}$`));
    await expect(page.getByRole('heading', { name: CLIENT, level: 1 })).toBeVisible();
    await expect(page.getByText('0 jobs', { exact: true })).toBeVisible();
    await expect(page.getByText('No jobs yet.')).toBeVisible();
    await expect(page.getByText('Drop a job folder into')).toBeVisible();
    await expect(page.getByText('You can set up the style first.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Jobs' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Style' }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/${clientId}/style$`));
    await expect(page.getByRole('heading', { name: `Style: ${CLIENT}`, level: 1 })).toBeVisible();
    await page.goBack();
  });

  const JOB = 'First reel';
  await test.step('a job folder dropped for the client turns the page into the jobs list by itself', async () => {
    await engine.createJob({ client: CLIENT, job: JOB });
    await expect(page.getByText('1 job', { exact: false }).first()).toBeVisible(WAIT);
    await expect(page.getByText('No jobs yet.')).toHaveCount(0, WAIT);
    await expect(page.locator('[data-job-id]').filter({ hasText: JOB })).toBeVisible(WAIT);
    // It did not make a second client.
    expect(await clientRows()).toHaveLength(1);
  });

  await test.step('the job’s brief ends with the client’s style, from before it had a job', async () => {
    const jobDir = join(engine.inbox, CLIENT, JOB);
    const briefPath = join(jobDir, 'edit', 'brief.md');
    await expect.poll(() => existsSync(briefPath), { timeout: 60_000 }).toBe(true);

    const style = await readFile(join(styleDir, 'style.md'), 'utf8');
    const brief = await readFile(briefPath, 'utf8');
    expect(brief).toContain('## Client style\n');
    expect(brief).toContain(`### Style: ${CLIENT}`);
    // The section is the last one of brief.md: style.md, with its headings two levels deeper.
    expect(brief.endsWith(`${style.trimEnd().replace(/^(#+) /gm, '##$1 ')}\n`)).toBe(true);
    // The job took the style as it was: a frozen copy with the logo that was dropped.
    expect(await readFile(join(jobDir, 'edit', 'style', 'style.md'), 'utf8')).toBe(style);
    expect(existsSync(join(jobDir, 'edit', 'style', 'logo.png'))).toBe(true);

    // Let the job finish before the engine is stopped.
    await expect
      .poll(async () => (await jobRows()).find((job) => job.name === JOB)?.state, {
        timeout: 90_000,
      })
      .toMatch(/^(ready|failed)$/);
  });

  await test.step('the Clients list now counts the job', async () => {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Clients' })
      .click();
    const row = page.locator('tr[data-client-id]').filter({ hasText: CLIENT });
    await expect(row.getByRole('cell').nth(1)).toHaveText('1', WAIT);
    await expect(row.getByRole('cell').nth(2)).not.toHaveText('—');
  });

  await test.step('a Hebrew name works the same way, and reads right to left', async () => {
    await page.getByRole('button', { name: 'New client' }).click();
    await nameField.fill(HEBREW_CLIENT);
    await expect(nameField).toHaveAttribute('dir', 'auto');
    await nameField.press('Enter');

    await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}\/style$/, WAIT);
    await expect(crumbs).toContainText(HEBREW_CLIENT);
    await expect(page.getByRole('heading', { name: 'No style yet' })).toBeVisible();
    expect(existsSync(join(engine.inbox, HEBREW_CLIENT, '_Style'))).toBe(true);
    expect((await clientRows()).map((row) => row.client).sort()).toEqual(
      [CLIENT, HEBREW_CLIENT].sort(),
    );
  });

  expect(pageErrors).toEqual([]);
});

test('a client folder made in Finder shows up in the open Clients page by itself', async ({
  page,
}) => {
  await openClients(page);
  const name = 'Made In Finder';
  await expect(page.locator('tr[data-client-id]').filter({ hasText: name })).toHaveCount(0);

  await mkdir(join(engine.inbox, name), { recursive: true });

  const row = page.locator('tr[data-client-id]').filter({ hasText: name });
  await expect(row).toBeVisible(WAIT);
  await expect(row.getByRole('cell').nth(1)).toHaveText('0');
  await expect(row.getByRole('cell').nth(2)).toHaveText('—');

  // It has a Style page like the others.
  await row.click();
  await page.getByRole('link', { name: 'Style' }).click();
  await expect(page.getByRole('heading', { name: 'No style yet' })).toBeVisible();
});
