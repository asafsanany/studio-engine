// C6: a client's Style page on the built server, with the fake runner. Its own engine (temp inbox,
// data folder and port), like brief.spec.ts, so smoke.spec.ts still starts on an empty one. The
// fake style run takes two seconds here, long enough to see "Analysing", short enough for one test.
//
//   Brightside    one job that fails at Brief and stays failed (a client has to have a job to exist,
//                 and a job that finishes would write the style itself): its Style page
//     none        the dashed drop zone: Browse files opens the picker; notes.txt goes up at once,
//                 the zone says it is analysing, then style.md is rendered with "Wrote style.md from
//                 1 file."; the file is in the client's _Style folder
//     add         Add style files opens the picker; the dialog asks (Add chosen); confirming says
//                 "Analysing 1 file…" and then "Added 1 file to the style."
//     drop        files dragged over the page show the dashed overlay; dropped, they open the same
//                 dialog; Replace the style sends mode replace: "Replaced the style with 1 file…"
//     failed      a run that fails shows its error with Retry; Retry (marker gone) finishes it
//     busy        a second upload while the first is analysed is turned away: "Still working on…"
//   The way in: the client page's Style button and the Clients row menu's View style.

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';

const CLIENT = 'Brightside';

/** The fake style run takes two seconds at this speed: time to act on it while it is analysing. */
const FAKE_SPEED = 0.5;
const WAIT = { timeout: 30_000 };

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED });
});

test.afterAll(async () => {
  await engine?.stop();
});

const textFile = (name: string, text = 'Warm colours. Slow pacing.') => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(text),
});

/** Files dragged over the page, dropped on it, or taken away again, as the browser dispatches them. */
async function drag(
  page: Page,
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  names: string[],
) {
  await page.evaluate(
    ([eventType, files]) => {
      const transfer = new DataTransfer();
      for (const name of files) transfer.items.add(new File(['x'], name));
      document.body.dispatchEvent(
        new DragEvent(eventType as string, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [type, names] as const,
  );
}

/** The status line above style.md, or in the drop zone: the one `role=status` with this text. */
const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });

test('a client’s Style page takes files, analyses them into style.md and shows it', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const styleDir = join(engine.inbox, CLIENT, '_Style');
  const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
  const dialog = page.getByRole('dialog', { name: /Add \d+ files? to/ });

  await test.step('a client with a job; its page has a Style button that opens the Style page', async () => {
    await engine.createJob({ client: CLIENT, job: 'Brief fails', failAt: 'brief' });
    await page.goto(`${engine.baseURL}/clients`);
    // A browser that has never seen this version is greeted with "What's new"; it blocks the page.
    const whatsNew = page.getByRole('dialog', { name: /What's new/ });
    await whatsNew.waitFor({ timeout: 5_000 }).then(
      () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
      () => {},
    );
    await expect(whatsNew).toBeHidden();

    await page.locator('tr[data-client-id]').filter({ hasText: CLIENT }).click();
    await expect(page.getByRole('heading', { name: CLIENT, level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Style' }).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}\/style$/);
    await expect(crumbs).toContainText(`Clients${CLIENT}Style`);
    // The first two crumbs are links, the last is the page.
    await expect(crumbs.getByRole('link')).toHaveText(['Clients', CLIENT]);
  });

  await test.step('no style yet: the drop zone, with Browse files', async () => {
    await expect(page.getByRole('heading', { name: 'No style yet' })).toBeVisible();
    await expect(page.getByText('or drop files here')).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(0);
    // The Browse files button is a label around a hidden file input for several files.
    await expect(page.locator('input[type=file][multiple]')).toHaveCount(1);
    expect(existsSync(join(styleDir, 'style.md'))).toBe(false);
  });

  await test.step('Browse files: the picker, and the file goes up at once, no dialog', async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText('Browse files', { exact: true }).click(),
    ]);
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles(textFile('notes.txt'));

    // The drop zone says it is analysing, in place of its invitation.
    await expect(
      page.getByRole('status').getByRole('heading', {
        name: 'Analysing 1 file. style.md updates when it’s done.',
      }),
    ).toBeVisible(WAIT);
    await expect(page.getByText('notes.txt', { exact: true })).toBeVisible();
    await expect(page.getByText('No style yet')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);

    // Then style.md is written and shown, with the news above it.
    await expect(status(page, 'Wrote style.md from 1 file.')).toBeVisible(WAIT);
    await expect(page.getByRole('heading', { name: `Style: ${CLIENT}`, level: 1 })).toBeVisible();
    await expect(page.getByText('From your files: notes.txt.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Look', level: 2 })).toBeVisible();
    await expect(page.getByText('Ink #1A1A1A (text), Paper #F5F1EA (background)')).toBeVisible();
    // It is the rendered document: the Markdown's own marks are not on the page.
    await expect(page.getByText('## Look')).toHaveCount(0);
    await expect(page.getByText('# Style:')).toHaveCount(0);
    await expect(page.getByText(/^style\.md · updated /)).toBeVisible();

    // The document sits in a column of 680 px at most, flush left, under the button's line.
    const column = await page.getByRole('article').boundingBox();
    expect(column?.width).toBeLessThanOrEqual(680);

    // On disk: the file is in the client's _Style folder, next to the style.md that was written.
    expect(await readFile(join(styleDir, 'notes.txt'), 'utf8')).toBe('Warm colours. Slow pacing.');
    expect(await readFile(join(styleDir, 'style.md'), 'utf8')).toContain(`# Style: ${CLIENT}`);
  });

  await test.step('Add style files: the dialog asks, Add is chosen, and the file is added', async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText('Add style files', { exact: true }).click(),
    ]);
    await chooser.setFiles(textFile('logo-notes.txt', 'Logo goes on the end card.'));

    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Add 1 file to ${CLIENT}’s style?`);
    await expect(dialog).toContainText('logo-notes.txt');
    await expect(dialog.getByRole('radio', { name: 'Add to the current style' })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: 'Replace the style' })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Add to style' }).click();
    await expect(dialog).toBeHidden();

    await expect(status(page, 'Analysing 1 file. style.md updates when it’s done.')).toBeVisible(
      WAIT,
    );
    await expect(status(page, 'Added 1 file to the style.')).toBeVisible(WAIT);
    // style.md was added to, not replaced: the first file is still named in it.
    await expect(page.getByText(/Plus logo-notes\.txt/)).toBeVisible();
    await expect(page.getByText(/notes\.txt/).first()).toBeVisible();
    expect(await readFile(join(styleDir, 'logo-notes.txt'), 'utf8')).toBe(
      'Logo goes on the end card.',
    );
  });

  await test.step('Cancel in the dialog sends nothing', async () => {
    await page.locator('input[type=file]').setInputFiles(textFile('never.txt'));
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    // Nothing was sent: the engine would have kept the file.
    expect(existsSync(join(styleDir, 'never.txt'))).toBe(false);
    await expect(page.getByRole('status').filter({ hasText: /Analysing|Uploading/ })).toHaveCount(
      0,
    );
  });

  await test.step('a drop: the dashed overlay while files are over the page, then the same dialog', async () => {
    const overlay = page.getByText('Drop files to add them to the style');
    await expect(overlay).toHaveCount(0);
    await drag(page, 'dragenter', ['dropped.txt']);
    await drag(page, 'dragover', ['dropped.txt']);
    await expect(overlay).toBeVisible();
    await drag(page, 'dragleave', ['dropped.txt']);
    await expect(overlay).toHaveCount(0);

    await drag(page, 'dragenter', ['dropped.txt']);
    await drag(page, 'drop', ['dropped.txt']);
    await expect(overlay).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Add 1 file to ${CLIENT}’s style?`);
    await expect(dialog).toContainText('dropped.txt');

    // Replace the style: the button says so, and so does what comes back.
    await dialog.getByRole('radio', { name: 'Replace the style' }).click();
    await expect(dialog.getByRole('button', { name: 'Replace style' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add to style' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Replace style' }).click();

    await expect(
      status(page, 'Replaced the style with 1 file. The old style.md is in history.'),
    ).toBeVisible(WAIT);
    // A new style.md from the dropped file only.
    await expect(page.getByText('From your files: dropped.txt.')).toBeVisible();
    await expect(page.getByText(/Plus /)).toHaveCount(0);
  });

  await test.step('a style run that fails shows its error with Retry, and Retry finishes it', async () => {
    await writeFile(join(styleDir, '.fail-style'), '');
    await page.locator('input[type=file]').setInputFiles(textFile('doomed.txt'));
    await dialog.getByRole('button', { name: 'Add to style' }).click();

    const failed = page
      .getByRole('alert')
      .filter({ hasText: 'Style stopped: injected failure (.fail-style)' });
    await expect(failed).toBeVisible(WAIT);
    await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
    // The old style.md stays on the page meanwhile.
    await expect(page.getByRole('heading', { name: `Style: ${CLIENT}`, level: 1 })).toBeVisible();

    await rm(join(styleDir, '.fail-style'));
    await failed.getByRole('button', { name: 'Retry' }).click();
    await expect(failed).toHaveCount(0, WAIT);
    // The files were added in the end, so the page says so.
    await expect(status(page, 'Added 1 file to the style.')).toBeVisible(WAIT);
    await expect(page.getByText(/Plus doomed\.txt/)).toBeVisible();
  });

  await test.step('files sent while the last ones are analysed are turned away, calmly', async () => {
    await page.locator('input[type=file]').setInputFiles(textFile('first.txt'));
    await dialog.getByRole('button', { name: 'Add to style' }).click();
    await expect(status(page, /Analysing 1 file/)).toBeVisible(WAIT);
    await page.locator('input[type=file]').setInputFiles(textFile('second.txt'));
    await dialog.getByRole('button', { name: 'Add to style' }).click();

    await expect(status(page, 'Still working on the last files.')).toBeVisible(WAIT);
    // It is not an alert: nothing failed. The first files carry on and are added.
    await expect(page.getByRole('alert').filter({ hasText: 'Still working' })).toHaveCount(0);
    await expect(status(page, 'Added 1 file to the style.')).toBeVisible(WAIT);
    expect(existsSync(join(styleDir, 'second.txt'))).toBe(false);
  });

  await test.step('a reload comes back to the same page, with the style as it is', async () => {
    await page.reload();
    await expect(page.getByRole('heading', { name: `Style: ${CLIENT}`, level: 1 })).toBeVisible();
    await expect(page.getByText(/Plus first\.txt/)).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: /Analysing|Added|Replaced/ }),
    ).toHaveCount(0);
  });

  await test.step('View style, in the Clients row’s menu, opens the same page', async () => {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Clients' })
      .click();
    await page.locator('tr[data-client-id]').filter({ hasText: CLIENT }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: `Actions for ${CLIENT}` });
    // Assign to… is the admin's (TM5), between View style and Show in Finder.
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Open',
      'View style',
      'Assign to…',
      'Show in Finder',
    ]);
    await menu.getByRole('menuitem', { name: 'View style' }).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}\/style$/);
    await expect(page.getByRole('heading', { name: `Style: ${CLIENT}`, level: 1 })).toBeVisible();
  });

  await test.step('an address with no client behind it says so', async () => {
    await page.goto(`${engine.baseURL}/clients/000000000000/style`);
    await expect(page.getByText('No such client.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to Clients' })).toBeVisible();
  });

  expect(pageErrors).toEqual([]);
});
