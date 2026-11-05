// CVP-270: Graphics. The library and a graphic's page, through the built engine with the fake
// runner (a version takes 3 s ÷ the engine's fake speed; a message with "fail" in it fails), the
// real routes and the real folders. One engine with the Graphics switch on, one HOME of its own
// (a deleted graphic's folder lands in <tmp>/home/.Trash, never in the real Trash), and the specs
// run in order because each builds on the graphics the one before made.
//
//   empty           the sidebar item opens an empty library; _Graphics is made and is no client
//   a voice note    the mic records, the engine types it out (the fake transcriber), the text lands in
//                   the composer and Send is ready; Esc while recording throws it away
//   a new graphic   New graphic, a starter fills the composer, a reference is attached, Send:
//                   the page opens, the Making box walks its steps, Send waits, v1 is made and
//                   plays, the graphic is named, its text, "when" and folder come from the run
//                   (the page asks again when the run is done), and _Graphics holds v1 and refs/
//   a change        v2 is made; its chip shows; clicking v1 shows v1 (Showing v1, Edits use v2),
//                   Back to v2 and Use v1 again, which makes v3 as a copy of v1
//   the studio      rename (the folder follows), Duplicate (its own id inside the copy), Turn off
//                   for edits and the switch of the About column
//   the list        rename (a clash is said in the one toaster), Duplicate, Turn on for edits and
//                   Delete… (the folder goes to the Trash), all PUT, POST and DELETE on the real routes
//   a failure       "fail" fails the run: the red box, Retry in the chat and Retry in the list
//   Stop            a run is stopped, Retry makes it, and Send works again
//   delete          Delete… in the studio opens the library; _Graphics holds what is left
//
// The Claude run itself (prompts, the real check) is covered by the unit tests and the acceptance
// runs of GR2; this checks that every button reaches the engine and what it does shows on the page.

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';

const WAIT = { timeout: 60_000 };

/** A graphic on the server, as the list answers it. */
interface GraphicOnServer {
  id: string;
  name: string;
  kind: string | null;
  version: number | null;
  uses: boolean;
  status: 'empty' | 'making' | 'ready' | 'failed';
  makingVersion: number | null;
  failedVersion: number | null;
}

interface MessageOnServer {
  id: string;
  role: 'you' | 'claude';
  text: string;
  refs: string[];
  version: number | null;
  status: string | null;
  error: string | null;
}

interface DetailOnServer extends GraphicOnServer {
  when: string;
  folder: string;
  variables: { id: string; label: string; default: string }[];
  messages: MessageOnServer[];
}

/** A one-pixel PNG: the "reference" The owner attaches. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// A fake microphone (a beeping tone) and no permission prompt, for the voice note. This file gets
// a browser of its own; the other specs keep theirs.
test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
  permissions: ['microphone'],
});

/** What the engine's fake transcriber says every voice note was. */
const FAKE_TRANSCRIPT = '[voice note, fake transcript]';

let engine: Engine;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // Fake speed 1: a version takes 3 s (one second a step), slow enough to click Stop on.
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 1, review: false, graphics: true });
});

test.afterAll(async () => {
  await engine?.stop();
});

// --- what the specs share -------------------------------------------------------------------------

const onDisk = (...parts: string[]): string => join(engine.inbox, '_Graphics', ...parts);
const inTrash = (...parts: string[]): string => join(engine.home, '.Trash', ...parts);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function graphicsOnServer(): Promise<GraphicOnServer[]> {
  const response = await fetch(`${engine.baseURL}/api/graphics`);
  expect(response.status).toBe(200);
  return (await response.json()) as GraphicOnServer[];
}

async function detailOnServer(id: string): Promise<DetailOnServer> {
  const response = await fetch(`${engine.baseURL}/api/graphics/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as DetailOnServer;
}

async function namedOnServer(name: string): Promise<GraphicOnServer> {
  const found = (await graphicsOnServer()).find((graphic) => graphic.name === name);
  if (found === undefined) throw new Error(`The engine has no graphic named "${name}".`);
  return found;
}

/** The first thing a fresh browser shows is the What's new dialog: put it away. */
async function dismissWhatsNew(page: Page): Promise<void> {
  const whatsNew = page.getByRole('dialog', { name: /What's new/ });
  await whatsNew.waitFor({ timeout: 5_000 }).then(
    () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
    () => {},
  );
  await expect(whatsNew).toBeHidden();
}

/** Opens a page of the app in a fresh browser, and keeps the errors the page throws. */
async function open(page: Page, path: string): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  await dismissWhatsNew(page);
  return pageErrors;
}

/** The graphic's id from the address of its page. */
function idOf(page: Page): string {
  const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  expect(id).toMatch(/^[0-9a-f]{12}$/);
  return id;
}

const header = (page: Page): Locator => page.locator('[data-slot="studio-header"]');
const preview = (page: Page): Locator => page.locator('[data-slot="graphic-preview"]');
const makingBox = (page: Page): Locator => page.locator('[data-slot="making-box"]');
const composer = (page: Page): Locator =>
  page.getByRole('textbox', { name: /^(Describe the graphic you need|Ask for a change)$/ });
const sendButton = (page: Page): Locator => page.getByRole('button', { name: 'Send', exact: true });
const rowOf = (page: Page, name: string): Locator =>
  page
    .locator('[data-graphic-id]')
    .filter({ has: page.getByRole('button', { name, exact: true }) });

/** Types a message and sends it. */
async function say(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await sendButton(page).click();
}

/** The playhead of the player on show moves: the graphic plays (and loops) at the given version. */
async function expectPlaying(page: Page, version: number): Promise<void> {
  await expect(preview(page)).toHaveAttribute('data-version', String(version), WAIT);
  const player = preview(page).locator('hyperframes-player').first();
  await expect(player).toHaveAttribute(
    'src',
    new RegExp(`/api/graphics/[0-9a-f]{12}/v/${version}/host\\.html`),
    WAIT,
  );
  await expect
    .poll(
      async () => {
        const before = await player.evaluate(
          (el) => (el as HTMLElement & { currentTime: number }).currentTime,
        );
        await page.waitForTimeout(300);
        const after = await player.evaluate(
          (el) => (el as HTMLElement & { currentTime: number }).currentTime,
        );
        return after !== before;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** The toaster of the page: sonner's own region, which is there whether or not a message shows. */
const toasters = (page: Page): Locator => page.locator('section[aria-label^="Notifications"]');

/** Opens a row's right-click menu and picks an item. */
async function rowMenu(page: Page, name: string, item: string): Promise<void> {
  await rowOf(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** The chat's version chip: "v2", with "· showing" on the one on show. */
const chip = (page: Page, version: number): Locator => page.getByTitle(`Show v${version}`);

// --- the specs ------------------------------------------------------------------------------------

test('the sidebar item opens an empty library, and _Graphics is no client', async ({ page }) => {
  const pageErrors = await open(page, '/jobs');

  await test.step('the engine says the switch is on, and the sidebar has the item', async () => {
    const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
      graphics: boolean;
    };
    expect(health.graphics).toBe(true);
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Graphics' })
      .click();
    await expect(page).toHaveURL(/\/graphics$/);
    await expect(page.getByRole('heading', { name: 'Graphics', level: 1 })).toBeVisible();
  });

  await test.step('nothing is made yet', async () => {
    await expect(page.getByText('No graphics yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New graphic' }).first()).toBeEnabled();
    expect(await graphicsOnServer()).toEqual([]);
  });

  await test.step('_Graphics is in the inbox, and is not a client', async () => {
    expect(await exists(onDisk())).toBe(true);
    const clients = (await (await fetch(`${engine.baseURL}/api/clients`)).json()) as {
      client: string;
    }[];
    expect(clients.map((row) => row.client)).not.toContain('_Graphics');
  });

  expect(pageErrors).toEqual([]);
});

test('a voice note is typed out into the composer', async ({ page }) => {
  const pageErrors = await open(page, '/graphics/new');
  const draft = composer(page);

  await test.step('Record, then Stop: the engine types the note out', async () => {
    await page.getByRole('button', { name: 'Record a voice note' }).click();
    await expect(page.getByText('Recording · press the mic again to stop')).toBeVisible();
    await expect(sendButton(page)).toBeDisabled();
    await page.waitForTimeout(1_500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(draft).toHaveValue(FAKE_TRANSCRIPT, WAIT);
    await expect(page.getByText('Typing out your voice note…')).toBeHidden();
    await expect(sendButton(page)).toBeEnabled();
  });

  await test.step('a second note is added to what is typed, and Esc while recording throws one away', async () => {
    await page.getByRole('button', { name: 'Record a voice note' }).click();
    await expect(page.getByText('Recording · press the mic again to stop')).toBeVisible();
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await expect(page.getByText('Recording · press the mic again to stop')).toBeHidden();
    await expect(draft).toHaveValue(FAKE_TRANSCRIPT);
    await page.getByRole('button', { name: 'Record a voice note' }).click();
    await page.waitForTimeout(1_200);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(draft).toHaveValue(`${FAKE_TRANSCRIPT} ${FAKE_TRANSCRIPT}`, WAIT);
  });

  await test.step('nothing was made: the voice note only fills the draft', async () => {
    expect(await graphicsOnServer()).toEqual([]);
  });

  expect(pageErrors).toEqual([]);
});

test('a new graphic: a starter, a file, Send, the steps, v1 plays and names it', async ({
  page,
}, testInfo) => {
  const pageErrors = await open(page, '/graphics');
  const logo = testInfo.outputPath('logo.png');
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(logo, PIXEL_PNG);

  await test.step('New graphic opens an empty studio with four starters', async () => {
    await page.getByRole('button', { name: 'New graphic' }).first().click();
    await expect(page).toHaveURL(/\/graphics\/new$/);
    await expect(page.getByRole('heading', { name: 'What graphic do you need?' })).toBeVisible();
    await expect(page.locator('[data-starter]')).toHaveCount(4);
    await expect(sendButton(page)).toBeDisabled();
  });

  await test.step('a starter fills the composer; a reference is attached', async () => {
    await page.getByRole('button', { name: 'A lower third for a name' }).click();
    await expect(composer(page)).toHaveValue(/^A lower third: the person’s name on a white pill/);
    await page.locator('[data-slot="attach-input"]').setInputFiles(logo);
    await expect(page.getByRole('button', { name: 'Remove logo.png' })).toBeVisible();
    await expect(sendButton(page)).toBeEnabled();
  });

  await test.step('Send creates the graphic and opens its page, with the Making box', async () => {
    await sendButton(page).click();
    await expect(page).toHaveURL(/\/graphics\/[0-9a-f]{12}$/, WAIT);
    const id = idOf(page);
    await expect(page.locator('[data-slot="your-message"]')).toContainText('A lower third');
    await expect(page.locator('[data-slot="your-message"]')).toContainText('logo.png');
    await expect(makingBox(page)).toContainText('Making v1');
    await expect(header(page)).toContainText('Making v1…');
    // The steps are Claude's words; one is done a second in, the others wait
    await expect(makingBox(page).locator('[data-step="done"]').first()).toHaveText(
      'Reading your request',
      WAIT,
    );
    await expect(makingBox(page)).toContainText('Checking it at 9:16, 16:9 and 1:1');
    // Send waits for the version; the picture says it plays here once it is made
    await expect(sendButton(page)).toBeDisabled();
    await expect(page.locator('[data-slot="preview-placeholder"]')).toContainText(
      'Making v1. It plays here when it’s ready.',
    );
    // The engine has the graphic and its message, and the reference is in refs/
    const detail = await detailOnServer(id);
    expect(detail.messages[0]).toMatchObject({ role: 'you', refs: ['logo.png'] });
    expect(await exists(onDisk('New graphic', 'refs', 'logo.png'))).toBe(true);
  });

  await test.step('v1 is made: the reply, the chip, the name and the player', async () => {
    await expect(makingBox(page)).toBeHidden(WAIT);
    await expect(page.locator('[data-slot="claude-message"]').last()).toContainText('Made v1.');
    await expect(chip(page, 1)).toContainText('showing');
    // The run named it from its about.json (the page was told the new name)
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(
      'Name on a white pill',
    );
    await expect(header(page)).toContainText('v1');
    await expect(header(page)).not.toContainText('Making');
    await expect(sendButton(page)).toBeDisabled(); // nothing typed yet
    await expectPlaying(page, 1);
  });

  await test.step('what only the run knows reaches the page without a reload', async () => {
    // Text fields, "when edits use it" and the folder are not in the event; the page asked again
    const about = page.getByRole('complementary', { name: 'About this graphic' });
    await expect(about.getByLabel('Name', { exact: true })).toHaveValue('דנה לוי');
    await expect(about.getByLabel('Role', { exact: true })).toHaveValue('מייסדת, Kova Coffee');
    await expect(about.getByLabel('When edits use it')).toHaveValue(
      'The first time a person is named on camera.',
    );
    await expect(about).toContainText('_Graphics/Name on a white pill');
    await expect(about.getByRole('switch', { name: 'Edits can use it' })).toBeChecked();
  });

  await test.step('_Graphics holds v1 as a whole project, and the reference', async () => {
    const id = idOf(page);
    const folder = onDisk('Name on a white pill');
    expect(await exists(onDisk('New graphic'))).toBe(false);
    for (const file of [
      'index.html',
      'about.json',
      'vendor/gsap.min.js',
      `compositions/lib-${id}.html`,
    ]) {
      expect(await exists(join(folder, 'versions', 'v1', file)), file).toBe(true);
    }
    expect(await exists(join(folder, 'refs', 'logo.png'))).toBe(true);
    const detail = await detailOnServer(id);
    expect(detail).toMatchObject({
      name: 'Name on a white pill',
      kind: 'lower-third',
      version: 1,
      status: 'ready',
      folder: 'Name on a white pill',
    });
  });

  expect(pageErrors).toEqual([]);
});

test('a change makes v2; clicking v1 shows it; Use v1 again makes v3', async ({ page }) => {
  const pill = await namedOnServer('Name on a white pill');
  const pageErrors = await open(page, `/graphics/${pill.id}`);
  await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Name on a white pill');
  await expectPlaying(page, 1);

  await test.step('a note makes v2', async () => {
    await expect(composer(page)).toHaveAttribute('placeholder', 'Ask for a change…');
    await say(page, 'Make the pill dark with white text.');
    await expect(makingBox(page)).toContainText('Making v2', WAIT);
    // v1 keeps playing until v2 is ready
    await expect(preview(page)).toHaveAttribute('data-version', '1');
    await expect(preview(page)).toContainText('Making v2');
    await expect(makingBox(page)).toBeHidden(WAIT);
    await expect(chip(page, 2)).toContainText('showing');
    await expect(chip(page, 1)).not.toContainText('showing');
    await expect(header(page)).toContainText('v2');
    await expectPlaying(page, 2);
    expect(await exists(onDisk('Name on a white pill', 'versions', 'v2', 'about.json'))).toBe(true);
    expect(await detailOnServer(pill.id)).toMatchObject({ version: 2, status: 'ready' });
  });

  await test.step('clicking v1 shows it, with a bar that says edits use v2', async () => {
    await chip(page, 1).click();
    const bar = page.locator('[data-slot="showing-old"]');
    await expect(bar).toContainText('Showing v1. Edits use v2.');
    await expect(chip(page, 1)).toContainText('showing');
    await expectPlaying(page, 1);
    // Back to v2 only changes what is on show
    await bar.getByRole('button', { name: 'Back to v2' }).click();
    await expect(bar).toBeHidden();
    await expectPlaying(page, 2);
    expect((await detailOnServer(pill.id)).version).toBe(2);
  });

  await test.step('Use v1 again makes it the newest, as v3', async () => {
    await chip(page, 1).click();
    await page
      .locator('[data-slot="showing-old"]')
      .getByRole('button', { name: 'Use v1 again' })
      .click();
    await expect(page.locator('[data-slot="chat-thread"]')).toContainText('v1 is back, as v3.');
    await expect(chip(page, 3)).toContainText('showing');
    await expect(page.locator('[data-slot="showing-old"]')).toBeHidden();
    await expect(header(page)).toContainText('v3');
    await expectPlaying(page, 3);
    const folder = onDisk('Name on a white pill', 'versions');
    expect(await readFile(join(folder, 'v3', 'compositions', `lib-${pill.id}.html`), 'utf8')).toBe(
      await readFile(join(folder, 'v1', 'compositions', `lib-${pill.id}.html`), 'utf8'),
    );
    expect(await detailOnServer(pill.id)).toMatchObject({ version: 3, status: 'ready' });
  });

  expect(pageErrors).toEqual([]);
});

test('the studio: rename, Duplicate and Turn off for edits', async ({ page }) => {
  const pill = await namedOnServer('Name on a white pill');
  const pageErrors = await open(page, `/graphics/${pill.id}`);
  const title = header(page).getByRole('heading', { level: 1 });
  const more = header(page).getByRole('button', { name: 'More' });

  await test.step('clicking the name renames it, and the folder follows', async () => {
    await title.getByRole('button').click();
    const field = header(page).getByRole('textbox', { name: 'Name of the graphic' });
    await field.fill('Pill');
    await field.press('Enter');
    await expect(title).toHaveText('Pill');
    await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText('Pill');
    await expect.poll(() => exists(onDisk('Pill', 'versions', 'v3'))).toBe(true);
    expect(await exists(onDisk('Name on a white pill'))).toBe(false);
    expect((await detailOnServer(pill.id)).name).toBe('Pill');
  });

  await test.step('Escape in the field keeps the name', async () => {
    await title.getByRole('button').click();
    const field = header(page).getByRole('textbox', { name: 'Name of the graphic' });
    await field.fill('Something else');
    await field.press('Escape');
    await expect(title).toHaveText('Pill');
    expect((await detailOnServer(pill.id)).name).toBe('Pill');
  });

  await test.step('Duplicate opens the copy: its own id, v1 from the newest version', async () => {
    await more.click();
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    await expect(title).toHaveText('Pill copy', WAIT);
    const copyId = idOf(page);
    expect(copyId).not.toBe(pill.id);
    await expect(page.locator('[data-slot="chat-thread"]')).toContainText('Copied from Pill v3.');
    await expect(header(page)).toContainText('v1');
    const folder = onDisk('Pill copy', 'versions', 'v1');
    expect(await exists(join(folder, 'compositions', `lib-${copyId}.html`))).toBe(true);
    expect(await exists(join(folder, 'compositions', `lib-${pill.id}.html`))).toBe(false);
    await expectPlaying(page, 1);
  });

  await test.step('Turn off for edits, from the menu and from the switch', async () => {
    const copyId = idOf(page);
    await more.click();
    await page.getByRole('menuitem', { name: 'Turn off for edits' }).click();
    await expect(header(page)).toContainText('off for edits');
    const uses = page.getByRole('switch', { name: 'Edits can use it' });
    await expect(uses).not.toBeChecked();
    expect((await detailOnServer(copyId)).uses).toBe(false);
    await more.click();
    await expect(page.getByRole('menuitem', { name: 'Turn on for edits' })).toBeVisible();
    await page.keyboard.press('Escape');
    // the switch of the About column turns it on again, and off
    await uses.click();
    await expect(uses).toBeChecked();
    await expect(header(page)).not.toContainText('off for edits');
    expect((await detailOnServer(copyId)).uses).toBe(true);
    await uses.click();
    await expect(uses).not.toBeChecked();
    expect((await detailOnServer(copyId)).uses).toBe(false);
  });

  expect(pageErrors).toEqual([]);
});

test('the list: rename, a clash in the one toaster, Duplicate, Turn on for edits, Delete…', async ({
  page,
}) => {
  const pageErrors = await open(page, '/graphics');
  const toasts = toasters(page);

  await test.step('the library lists both, newest change first, with the copy off for edits', async () => {
    await expect(page.getByText('2 graphics', { exact: true })).toBeVisible();
    const rows = page.locator('[data-graphic-id]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Pill copy');
    await expect(rowOf(page, 'Pill')).toContainText('Lower third · 3 s');
    await expect(rowOf(page, 'Pill copy')).toContainText('Lower third · 3 s · off for edits');
    await expect(toasts).toHaveCount(1);
  });

  await test.step('Rename into a name that is taken: the engine says so, the field stays', async () => {
    await rowMenu(page, 'Pill copy', 'Rename');
    const field = page.getByRole('textbox', { name: 'Name of Pill copy' });
    await field.fill('pill');
    await field.press('Enter');
    await expect(page.getByText('Another graphic already has this name.')).toBeVisible();
    await expect(field).toBeVisible();
    await expect(toasts).toHaveCount(1);
    await field.press('Escape');
    await expect(rowOf(page, 'Pill copy')).toBeVisible();
  });

  await test.step('Rename to a free name (PUT), and the folder follows', async () => {
    await rowMenu(page, 'Pill copy', 'Rename');
    const field = page.getByRole('textbox', { name: 'Name of Pill copy' });
    await field.fill('Second');
    await field.press('Enter');
    await expect(rowOf(page, 'Second')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pill copy', exact: true })).toHaveCount(0);
    await expect.poll(() => exists(onDisk('Second', 'versions', 'v1'))).toBe(true);
    expect(await exists(onDisk('Pill copy'))).toBe(false);
    expect((await namedOnServer('Second')).uses).toBe(false);
  });

  await test.step('Duplicate (POST) adds a row', async () => {
    await rowMenu(page, 'Second', 'Duplicate');
    await expect(page.getByText('3 graphics', { exact: true })).toBeVisible();
    await expect(rowOf(page, 'Second copy')).toBeVisible();
    await expect.poll(() => exists(onDisk('Second copy', 'versions', 'v1'))).toBe(true);
  });

  await test.step('Turn on for edits (PUT) takes "off for edits" away', async () => {
    await rowMenu(page, 'Second', 'Turn on for edits');
    await expect(rowOf(page, 'Second')).not.toContainText('off for edits');
    expect((await namedOnServer('Second')).uses).toBe(true);
  });

  await test.step('Delete… asks, then the folder goes to the Trash (DELETE)', async () => {
    await rowMenu(page, 'Second copy', 'Delete…');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Delete “Second copy”?');
    await expect(dialog).toContainText('It goes to the Trash');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(rowOf(page, 'Second copy')).toBeVisible();

    await rowMenu(page, 'Second copy', 'Delete…');
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(rowOf(page, 'Second copy')).toHaveCount(0);
    await expect(page.getByText('2 graphics', { exact: true })).toBeVisible();
    expect(await exists(inTrash('Second copy', 'versions', 'v1', 'about.json'))).toBe(true);
    expect(await exists(onDisk('Second copy'))).toBe(false);
    expect((await graphicsOnServer()).map((graphic) => graphic.name).sort()).toEqual([
      'Pill',
      'Second',
    ]);
    // it went to the Trash, so nothing needs saying
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  });

  expect(pageErrors).toEqual([]);
});

test('a request that fails: the red box, Retry in the chat, Retry in the list', async ({
  page,
}) => {
  const pageErrors = await open(page, '/graphics');

  await test.step('a message with "fail" in it ends in the red box', async () => {
    await page.getByRole('button', { name: 'New graphic' }).first().click();
    await say(page, 'A lower third that will fail.');
    await expect(page).toHaveURL(/\/graphics\/[0-9a-f]{12}$/, WAIT);
    const box = page.locator('[data-slot="failed-box"]');
    await expect(box).toBeVisible(WAIT);
    await expect(box).toContainText('Couldn’t finish v1');
    await expect(box).toContainText('The stand-in run failed, as the message asked');
    await expect(box.getByRole('button', { name: 'Copy error' })).toBeVisible();
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('New graphic');
    await expect(page.locator('[data-slot="preview-placeholder"]')).toBeVisible();
    const detail = await detailOnServer(idOf(page));
    expect(detail).toMatchObject({ status: 'failed', failedVersion: 1, version: null });
    expect(detail.messages.at(-1)?.error).toContain('The stand-in run failed');
  });

  await test.step('Retry in the chat makes the same request again (it fails again, the message still says so)', async () => {
    const box = page.locator('[data-slot="failed-box"]');
    await box.getByRole('button', { name: 'Retry' }).click();
    await expect(makingBox(page)).toContainText('Making v1', WAIT);
    await expect(header(page)).toContainText('Making v1…');
    await expect(box).toBeVisible(WAIT);
    await expect(box).toContainText('Couldn’t finish v1');
    // one failed row, not two: the retry reuses it
    await expect(page.locator('[data-slot="claude-message"]')).toHaveCount(1);
  });

  await test.step('the list shows it in red, with Retry v1 in the next-step column', async () => {
    await header(page).getByRole('link', { name: 'Graphics' }).click();
    await expect(page).toHaveURL(/\/graphics$/);
    const row = rowOf(page, 'New graphic');
    await expect(row).toContainText('Couldn’t finish v1');
    await expect(row).toHaveAttribute('data-status', 'failed');
    await expect(row.getByRole('img', { name: 'A version failed' })).toBeVisible();
  });

  await test.step('Retry v1 in the list runs it again (POST retry)', async () => {
    const row = rowOf(page, 'New graphic');
    await row.getByRole('button', { name: 'Retry v1' }).click();
    await expect(row).toContainText('Making v1…', WAIT);
    await expect(row.getByRole('img', { name: 'Being made' })).toBeVisible();
    await expect(page.getByText('1 being made')).toBeVisible();
    await expect(row).toContainText('Couldn’t finish v1', WAIT);
    await expect(page.getByText('being made')).toHaveCount(0);
  });

  expect(pageErrors).toEqual([]);
});

test('Stop ends a run, Retry makes it, and Send works again', async ({ page }) => {
  const pageErrors = await open(page, '/graphics/new');

  await test.step('Stop while it is making', async () => {
    await say(page, 'A big number that counts up.');
    await expect(page).toHaveURL(/\/graphics\/[0-9a-f]{12}$/, WAIT);
    await expect(makingBox(page)).toContainText('Making v1', WAIT);
    await makingBox(page).getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('[data-slot="claude-message"]')).toContainText('Stopped.', WAIT);
    await expect(makingBox(page)).toBeHidden();
    const detail = await detailOnServer(idOf(page));
    expect(detail.messages.at(-1)).toMatchObject({ role: 'claude', status: 'stopped' });
    expect(detail).toMatchObject({ version: null });
    await expect(header(page)).not.toContainText('Making');
  });

  await test.step('Retry on the stopped row makes the version', async () => {
    await page
      .locator('[data-slot="claude-message"]')
      .getByRole('button', { name: 'Retry' })
      .click();
    await expect(makingBox(page)).toContainText('Making v1', WAIT);
    await expect(makingBox(page)).toBeHidden(WAIT);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(
      'Big number that counts up',
    );
    await expect(chip(page, 1)).toContainText('showing');
    await expectPlaying(page, 1);
    expect(await detailOnServer(idOf(page))).toMatchObject({
      kind: 'callout',
      version: 1,
      status: 'ready',
    });
  });

  await test.step('Send works again once the version is made', async () => {
    await composer(page).fill('Bigger, please.');
    await expect(sendButton(page)).toBeEnabled();
  });

  expect(pageErrors).toEqual([]);
});

test('Delete… in the studio opens the library; _Graphics holds what is left', async ({ page }) => {
  const counter = await namedOnServer('Big number that counts up');
  const pageErrors = await open(page, `/graphics/${counter.id}`);
  await expect(header(page).getByRole('heading', { level: 1 })).toHaveText(
    'Big number that counts up',
  );

  await test.step('the dialog asks, and Delete sends it to the Trash', async () => {
    await header(page).getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Delete “Big number that counts up”?');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).toHaveURL(/\/graphics$/, WAIT);
    await expect(rowOf(page, 'Big number that counts up')).toHaveCount(0);
    expect(await exists(inTrash('Big number that counts up', 'versions', 'v1'))).toBe(true);
  });

  await test.step('the page of a deleted graphic says it is gone', async () => {
    await page.goto(`${engine.baseURL}/graphics/${counter.id}`);
    await expect(page.getByRole('heading', { name: 'This graphic is gone' })).toBeVisible(WAIT);
    await page.getByRole('link', { name: 'Back to Graphics' }).click();
    await expect(page).toHaveURL(/\/graphics$/);
  });

  await test.step('the library and _Graphics agree, and nothing is left half done', async () => {
    const names = (await graphicsOnServer()).map((graphic) => graphic.name).sort();
    expect(names).toEqual(['New graphic', 'Pill', 'Second']);
    const folders = (await readdir(onDisk())).sort();
    expect(folders).toEqual(['New graphic', 'Pill', 'Second']);
    // the uploads' staging folders are gone
    expect(folders.filter((name) => name.startsWith('.'))).toEqual([]);
    for (const name of names) await expect(rowOf(page, name)).toBeVisible();
    await expect(page.getByText('3 graphics', { exact: true })).toBeVisible();
    await expect(toasters(page)).toHaveCount(1);
  });

  await test.step('the server logged no error', async () => {
    const log = await engine.readLog();
    expect(log).not.toMatch(/"level":(50|60)\b/);
  });

  expect(pageErrors).toEqual([]);
});
