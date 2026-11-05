// CVP-307: LUTs. The page and its import, through the built engine with the fake runner (the preview
// stills are the plain test frame twice and an import is proved by the static check alone, so no
// ffmpeg is needed), the real routes and the real _LUTs folder. One engine with the LUTs switch at
// its default (on), a stand-in colour-grade skill of its own for the Built in rows (so this Mac's
// installed skill never decides what the list shows), and one HOME (a deleted LUT's file lands in
// <tmp>/home/.Trash, never in the real Trash). The specs run in order; each builds on the one before.
//
//   empty          the sidebar item opens the page: Yours has its hint, Built in has 19 rows, the pane shows
//                  the first LUT's before/after, and _LUTs is made and is no client
//   a built-in     a Built in row opens in the pane (and in the address), the slider moves the divider,
//                  and a frame chip changes the stills
//   import         Import LUTs, three files (two good, one with no LUT_3D_SIZE line): the dialog says
//                  why the bad one cannot go in, Camera is marked for one, Import 2 LUTs copies them into
//                  _LUTs, the dialog closes, the toast says so, the new rows carry New and the first opens
//   a drop         files dropped anywhere on the page show the veil and open the dialog at step 2
//   rename, delete rename (the file and the address follow), Delete… (the file goes to the Trash and the
//                  pane moves to the next row)
//   offline        the engine stops: the bar under the header says when the list was last right, Import
//                  LUTs is off and a drop opens nothing (last, because it stops the engine)
//
// What this does not cover (unit tests and the QA run do): the picked-folder path (the OS picker),
// the real ffmpeg proof and the real Cinematic bake.

import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { BUILTIN_LUTS } from '../packages/shared/src/domain/luts.ts';
import { type Engine, startEngine } from './support/engine.ts';

const WAIT = { timeout: 30_000 };

let engine: Engine;
let skillDir: string;

test.describe.configure({ mode: 'serial' });

/** The text of a small .cube: the identity with a tint, so two files are different files. */
function cube(n: number, tint: number): string {
  const lines = [`TITLE "e2e"`, `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const rgb = [r, g, b].map((v) => v / (n - 1));
        lines.push(rgb.map((v, i) => Math.min(1, v + (i === 0 ? tint : 0)).toFixed(6)).join(' '));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

test.beforeAll(async () => {
  // A stand-in for ~/.claude/skills/color-grade-ai: the 18 files the 19 built-in rows name.
  skillDir = await mkdtemp(join(tmpdir(), 'studio-e2e-skill-'));
  const dir = join(skillDir, 'correction_luts');
  await mkdir(dir, { recursive: true });
  for (const file of new Set(BUILTIN_LUTS.flatMap((row) => row.files))) {
    await writeFile(join(dir, file), cube(5, 0.1));
  }
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 1,
    review: false,
    env: { STUDIO_COLOR_GRADE_DIR: skillDir },
  });
});

test.afterAll(async () => {
  await engine?.stop();
  if (skillDir !== undefined) await rm(skillDir, { recursive: true, force: true });
});

// --- what the specs share -------------------------------------------------------------------------

const onDisk = (...parts: string[]): string => join(engine.inbox, '_LUTs', ...parts);
const inTrash = (...parts: string[]): string => join(engine.home, '.Trash', ...parts);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

interface LutOnServer {
  slug: string;
  name: string;
  kind: 'look' | 'camera' | 'fix';
  size: number;
  owner: 'yours' | 'builtIn';
  isNew: boolean;
}

async function libraryOnServer(): Promise<{
  yours: LutOnServer[];
  builtIn: LutOnServer[];
  builtInAvailable: boolean;
}> {
  const response = await fetch(`${engine.baseURL}/api/luts`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    yours: LutOnServer[];
    builtIn: LutOnServer[];
    builtInAvailable: boolean;
  };
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

const rowOf = (page: Page, slug: string): Locator => page.locator(`[data-lut-slug="${slug}"]`);
const pane = (page: Page): Locator => page.locator('[data-slot="lut-pane"]');
const paneTitle = (page: Page): Locator => pane(page).getByRole('heading', { level: 2 });
const slider = (page: Page): Locator =>
  pane(page).getByRole('slider', { name: 'Before and after' });
const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Import LUTs' });
const toasts = (page: Page): Locator => page.locator('section[aria-label^="Notifications"]');

/** Where the divider stands, from the after still's clip: `inset(0 0 0 N%)`. */
async function dividerAt(page: Page): Promise<number> {
  const clip = await pane(page)
    .locator('img[data-side="after"]')
    .evaluate((img) => getComputedStyle(img).clipPath);
  const match = /(\d+(?:\.\d+)?)%\)$/.exec(clip);
  if (match?.[1] === undefined) throw new Error(`No divider in the clip "${clip}".`);
  return Number(match[1]);
}

/** A file in the form the picker hands to a file input. */
const lutFile = (name: string, text: string) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(text),
});

const BAD_FILE = 'Not a LUT.cube';
const BAD_TEXT = '# a text file with no grid line\nTITLE "Not a LUT"\n';

// --- the specs ------------------------------------------------------------------------------------

test('the sidebar item opens the page: nothing of Yours, 19 built in, the first one in the pane', async ({
  page,
}) => {
  const pageErrors = await open(page, '/jobs');

  await test.step('the engine says the switch is on, and the sidebar has the item', async () => {
    const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
      luts: boolean;
    };
    expect(health.luts).toBe(true);
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'LUTs' })
      .click();
    await expect(page).toHaveURL(/\/luts/);
    await expect(page.getByRole('heading', { name: 'LUTs', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import LUTs' }).first()).toBeEnabled();
  });

  await test.step('Yours has its hint, Built in has the 19 rows, and the tabs count them', async () => {
    await expect(page.locator('[data-lut-slug]')).toHaveCount(BUILTIN_LUTS.length, WAIT);
    await expect(page.locator('[data-owner="yours"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Yours/, level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Built in\s*19$/, level: 2 })).toBeVisible();
    await expect(
      page.getByText('Nothing imported yet. Drop .cube files anywhere on this page'),
    ).toBeVisible();
    const library = await libraryOnServer();
    expect(library.builtInAvailable).toBe(true);
    expect(library.yours).toEqual([]);
    expect(library.builtIn).toHaveLength(BUILTIN_LUTS.length);
  });

  await test.step('the first row is open: its name, its stills and its facts are in the pane', async () => {
    const first = BUILTIN_LUTS[0];
    expect(first).toBeDefined();
    await expect(paneTitle(page)).toHaveText(first?.name ?? '', WAIT);
    await expect(page).toHaveURL(new RegExp(`lut=${first?.slug}`));
    for (const side of ['before', 'after']) {
      const still = pane(page).locator(`img[data-side="${side}"]`);
      await expect(still).toBeVisible();
      await expect
        .poll(() => still.evaluate((img: HTMLImageElement) => img.naturalWidth), WAIT)
        .toBeGreaterThan(0);
    }
    await expect(pane(page).getByText('Comes with the grade')).toBeVisible();
  });

  await test.step('_LUTs is in the inbox, and is not a client', async () => {
    expect(await exists(onDisk())).toBe(true);
    const clients = (await (await fetch(`${engine.baseURL}/api/clients`)).json()) as {
      client: string;
    }[];
    expect(clients.map((row) => row.client)).not.toContain('_LUTs');
  });

  expect(pageErrors).toEqual([]);
});

test('a built-in row opens in the pane, the slider moves the divider and a chip changes the stills', async ({
  page,
}) => {
  const pageErrors = await open(page, '/luts');

  await test.step('clicking Film contrast opens it, in the pane and the address', async () => {
    await rowOf(page, 'film-contrast').click();
    await expect(paneTitle(page)).toHaveText('Film contrast', WAIT);
    await expect(page).toHaveURL(/lut=film-contrast/);
    await expect(rowOf(page, 'film-contrast')).toHaveAttribute('data-selected', 'true');
  });

  await test.step('dragging the slider moves the divider; the stills stay', async () => {
    await expect(slider(page)).toBeVisible();
    expect(await dividerAt(page)).toBe(50);
    const box = await slider(page).boundingBox();
    if (box === null) throw new Error('The slider has no box.');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => dividerAt(page)).toBeLessThan(30);
    expect(Number(await slider(page).inputValue())).toBeLessThan(30);
  });

  await test.step('the Street chip shows the street frame and its credit, and the choice is kept', async () => {
    await pane(page).getByRole('button', { name: 'Street', exact: true }).click();
    await expect(pane(page).locator('img[data-side="after"]')).toHaveAttribute(
      'src',
      /\/api\/luts\/film-contrast\/preview\/street\/after\.jpg\?v=/,
    );
    await expect(pane(page).getByText('Photo: Nicholas Swanson, Unsplash')).toBeVisible();
    // another LUT opens on the same frame, so two LUTs compare
    await rowOf(page, 'warm-shift').click();
    await expect(paneTitle(page)).toHaveText('Warm shift', WAIT);
    await expect(pane(page).locator('img[data-side="after"]')).toHaveAttribute(
      'src',
      /\/api\/luts\/warm-shift\/preview\/street\/after\.jpg/,
    );
  });

  await test.step('a built-in LUT has no way to be renamed or deleted in its menu', async () => {
    await rowOf(page, 'warm-shift').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Duplicate to Yours' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /^Delete/ })).toHaveCount(0);
    // the Cinematic look has no file to show
    await page.keyboard.press('Escape');
    await rowOf(page, 'cinematic').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Show in Finder' })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  expect(pageErrors).toEqual([]);
});

test('import: two good files and one that is no LUT, through the dialog', async ({ page }) => {
  const pageErrors = await open(page, '/luts');
  const picker = dialog(page).locator('input[type="file"]:not([webkitdirectory])');

  await test.step('Import LUTs opens the dialog at its first step (the Looks tab is on show)', async () => {
    await page.getByRole('tab', { name: /^Looks/ }).click();
    await expect(page).toHaveURL(/tab=look/);
    await page.getByRole('button', { name: 'Import LUTs' }).first().click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByText('Drop .cube or .3dl files here')).toBeVisible();
    await expect(dialog(page).getByText('Copied into _LUTs in your Studio Inbox')).toBeVisible();
  });

  await test.step('three files go up: each has a verdict, and the bad one says why', async () => {
    await picker.setInputFiles([
      lutFile('S-Log3 to Rec709.cube', cube(7, 0.2)),
      lutFile('Moody Teal.cube', cube(9, 0.05)),
      lutFile(BAD_FILE, BAD_TEXT),
    ]);
    const files = dialog(page).getByRole('list', { name: 'Files to import' });
    await expect(files.locator('li')).toHaveCount(3, WAIT);
    const bad = files.locator('li[data-ok="false"]');
    await expect(bad).toHaveCount(1);
    await expect(bad).toContainText(BAD_FILE);
    await expect(bad).toContainText('Not a LUT: there is no LUT_3D_SIZE line.');
    // the bad one has no kind to choose and the button counts the two that can go
    await expect(bad.getByRole('button', { name: 'Look' })).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Import 2 LUTs' })).toBeEnabled();
    // the first guess: a name that says "S-Log3 to Rec709" is a camera LUT
    const camera = files.locator('li', { hasText: 'S-Log3 to Rec709.cube' });
    await expect(camera.getByRole('button', { name: 'Camera' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      files.locator('li', { hasText: 'Moody Teal.cube' }).getByRole('button', { name: 'Look' }),
    ).toHaveAttribute('aria-pressed', 'true');
    // nothing is in _LUTs yet
    expect(await readdir(onDisk())).toEqual([]);
  });

  await test.step('the bad file can be taken out of the list, and a kind can be changed', async () => {
    await dialog(page)
      .getByRole('button', { name: `Remove ${BAD_FILE} from the list` })
      .click();
    await expect(
      dialog(page).getByRole('list', { name: 'Files to import' }).locator('li'),
    ).toHaveCount(2);
    const teal = dialog(page).locator('li', { hasText: 'Moody Teal.cube' });
    await teal.getByRole('button', { name: 'Fix' }).click();
    await expect(teal.getByRole('button', { name: 'Fix' })).toHaveAttribute('aria-pressed', 'true');
    await teal.getByRole('button', { name: 'Look' }).click();
  });

  await test.step('Import 2 LUTs copies them into _LUTs, closes the dialog and says so', async () => {
    await dialog(page).getByRole('button', { name: 'Import 2 LUTs' }).click();
    await expect(dialog(page)).toBeHidden(WAIT);
    await expect(toasts(page)).toContainText('Imported 2 LUTs');
    expect((await readdir(onDisk())).sort()).toEqual(['Moody Teal.cube', 'S-Log3 to Rec709.cube']);
    expect(await readFile(onDisk('Moody Teal.cube'), 'utf8')).toBe(cube(9, 0.05));
    const library = await libraryOnServer();
    expect(library.yours.map((l) => [l.slug, l.kind, l.size, l.isNew])).toEqual(
      expect.arrayContaining([
        ['moody-teal', 'look', 9, true],
        ['s-log3-to-rec709', 'camera', 7, true],
      ]),
    );
    expect(library.yours).toHaveLength(2);
  });

  await test.step('Yours has the two rows with the New tag, and the first one imported is open', async () => {
    await expect(page.locator('[data-owner="yours"]')).toHaveCount(2);
    for (const slug of ['moody-teal', 's-log3-to-rec709']) {
      await expect(rowOf(page, slug).locator('[data-slot="lut-new"]')).toHaveText('New');
    }
    await expect(page.getByRole('tab', { name: /^Camera/ })).toContainText('2');
    // the first file imported opens, and the page goes back to All: a Camera LUT would be hidden by Looks
    await expect(page).toHaveURL(/lut=s-log3-to-rec709/);
    expect(page.url()).not.toContain('tab=');
    await expect(paneTitle(page)).toHaveText('S-Log3 to Rec709', WAIT);
    await expect(rowOf(page, 's-log3-to-rec709')).toHaveAttribute('data-selected', 'true');
  });

  expect(pageErrors).toEqual([]);
});

test('files dropped on the page show the veil and open the dialog at the list', async ({
  page,
}) => {
  const pageErrors = await open(page, '/luts');
  await expect(page.locator('[data-lut-slug]').first()).toBeVisible(WAIT);

  /** A drag of files over the window, as the browser sends it: enter, over, then (optionally) drop. */
  async function dragFiles(kind: 'enter' | 'drop'): Promise<void> {
    await page.evaluate(
      ({ kind: step, text }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], 'Dropped Glow.cube', { type: '' }));
        for (const type of step === 'enter' ? ['dragenter', 'dragover'] : ['drop']) {
          document.body.dispatchEvent(
            new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
          );
        }
      },
      { kind, text: cube(5, 0.3) },
    );
  }

  await test.step('a drag of files over the window shows "Drop to import"', async () => {
    await dragFiles('enter');
    await expect(page.locator('[data-slot="lut-drop-overlay"]')).toContainText('Drop to import');
  });

  await test.step('the drop opens the dialog with the file already checked', async () => {
    await dragFiles('drop');
    await expect(page.locator('[data-slot="lut-drop-overlay"]')).toBeHidden();
    await expect(dialog(page)).toBeVisible();
    const files = dialog(page).getByRole('list', { name: 'Files to import' });
    await expect(files.locator('li')).toHaveCount(1, WAIT);
    await expect(files).toContainText('Dropped Glow.cube');
  });

  await test.step('Cancel throws the upload away: nothing was added', async () => {
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toBeHidden();
    expect((await libraryOnServer()).yours).toHaveLength(2);
    expect(await exists(onDisk('Dropped Glow.cube'))).toBe(false);
  });

  expect(pageErrors).toEqual([]);
});

test('rename follows into the file and the address; delete goes to the Trash and the pane moves on', async ({
  page,
}) => {
  const pageErrors = await open(page, '/luts?lut=moody-teal');
  await expect(paneTitle(page)).toHaveText('Moody Teal', WAIT);

  await test.step('Rename… turns the name into a field; Enter renames the LUT, its file and its address', async () => {
    await rowOf(page, 'moody-teal').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const field = rowOf(page, 'moody-teal').getByRole('textbox');
    await expect(field).toBeFocused();
    await field.fill('Deep Teal');
    await field.press('Enter');
    await expect(page).toHaveURL(/lut=deep-teal/, WAIT);
    await expect(paneTitle(page)).toHaveText('Deep Teal', WAIT);
    await expect(rowOf(page, 'deep-teal')).toHaveCount(1);
    expect((await readdir(onDisk())).sort()).toEqual(['Deep Teal.cube', 'S-Log3 to Rec709.cube']);
    expect((await libraryOnServer()).yours.map((l) => l.slug).sort()).toEqual([
      'deep-teal',
      's-log3-to-rec709',
    ]);
  });

  await test.step('a name that is taken is refused and the LUT stays as it was', async () => {
    await rowOf(page, 'deep-teal').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const field = rowOf(page, 'deep-teal').getByRole('textbox');
    await field.fill('Film contrast');
    await field.press('Enter');
    await expect(toasts(page)).toContainText('Another LUT already has this name.');
    // Enter keeps the field so the name can be fixed; Esc puts the old name back
    await expect(field).toBeFocused();
    await field.press('Escape');
    await expect(rowOf(page, 'deep-teal').getByRole('button', { name: 'Deep Teal' })).toBeVisible();
    expect((await libraryOnServer()).yours.map((l) => l.name)).toContain('Deep Teal');
  });

  await test.step('Delete… asks, then the file goes to the Trash and the pane opens the next row', async () => {
    const slugsOf = (): Promise<(string | null)[]> =>
      page
        .locator('[data-lut-slug]')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-lut-slug')));
    const before = await slugsOf();
    const at = before.indexOf('deep-teal');
    const next = before[at + 1] ?? before[at - 1];
    await rowOf(page, 'deep-teal').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Delete “Deep Teal”?');
    await ask.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ask).toBeHidden(WAIT);
    await expect(rowOf(page, 'deep-teal')).toHaveCount(0, WAIT);
    expect(await exists(onDisk('Deep Teal.cube'))).toBe(false);
    expect(await exists(inTrash('Deep Teal.cube'))).toBe(true);
    // the row that followed it is the open one now, not the first of the list
    expect(next).toBeDefined();
    await expect(rowOf(page, next ?? '')).toHaveAttribute('data-selected', 'true', WAIT);
    await expect(page).toHaveURL(new RegExp(`lut=${next}`));
  });

  await test.step('what is left is the one LUT, and the library agrees', async () => {
    expect((await libraryOnServer()).yours.map((l) => l.slug)).toEqual(['s-log3-to-rec709']);
  });

  expect(pageErrors).toEqual([]);
});

// Last, because it stops the engine: the page keeps what it had and says so.
test('when the engine goes away the page says so and importing waits', async ({ page }) => {
  await open(page, '/luts');
  await expect(page.locator('[data-lut-slug]').first()).toBeVisible(WAIT);
  await expect(page.locator('[data-slot="luts-offline-banner"]')).toHaveCount(0);

  await engine.stop();

  await test.step('the bar under the header says when the list was last right', async () => {
    const banner = page.locator('[data-slot="luts-offline-banner"]');
    await expect(banner).toBeVisible({ timeout: 40_000 });
    await expect(banner).toContainText(
      /Can’t reach the engine on your Mac\. This is the list as it was at \d\d:\d\d\. Importing waits until it’s back\./,
    );
  });

  await test.step('the list stays, Import LUTs is off and a drop opens nothing', async () => {
    await expect(page.locator('[data-lut-slug]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import LUTs' }).first()).toBeDisabled();
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'x.cube'));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.body.dispatchEvent(
          new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      }
    });
    await page.waitForTimeout(300);
    await expect(dialog(page)).toHaveCount(0);
  });
});
