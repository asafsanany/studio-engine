// CVP-343: Fonts. The whole of build 1 together, through the built engine with the fake runner, the
// real routes, the real index and watcher on the real `_Fonts` folder, and a real browser. One engine
// with both Fonts switches at their defaults (Fonts on since FN11, Fonts in notes on since FN23), one HOME of its own (a deleted
// family lands in <tmp>/home/.Trash, never in the real Trash), and a stand-in `open` first on the
// engine's PATH, so "Show in Finder" is answered and written down instead of opening Finder. The
// specs run in order; each builds on the one before.
//
//   empty        the sidebar item opens the page: the hint, the empty pane; `_Fonts` is made and is no
//                client. Then six font files are moved into the two folders the way Finder would (the
//                watcher and the events): the five families appear without a reload
//   tabs         All · Hebrew + English · English only count 5 · 3 · 2 and filter; the search; no match
//   a family     opens in the pane and the address; a weight row is chosen and the specimen follows;
//                the real file is served and loaded; the try box replaces the lines; On a frame shows
//                the photo, the caption, the chips and the credit; the choice follows to the next row
//   Finder       Show in Finder reaches `open -R <the family's folder>` (the stand-in), and the menu
//   import       Import fonts, two files (a good family the library does not have, and a cut-short
//                file): New and Can't import, Import 1 font copies it into `_Fonts/Hebrew + English/`,
//                the toast, the New tag, the new family opens
//   a drop       files dropped on the page show the veil and open the dialog with the verdicts
//   delete       Delete… asks; the whole family goes to <tmp>/home/.Trash, its folder goes, the row
//                goes, the next one opens; the REAL Trash gained nothing
//   notes off    a second engine with STUDIO_FONTS_IN_NOTES=0 (the switch turned off, FN23): the same
//                page without the used column, "Used in", "To use it", Copy @name and the notes
//                sentence of the delete dialog (the look before FN23)
//   offline      the engine stops: the bar says when the list was last right, Import fonts is off and
//                a drop opens nothing (last, because it stops the engine)
//
// Both switches are left at their defaults: Fonts on (FN11) and Fonts in notes on (FN23), so the
// list has its used column (wide enough), the pane its "Used in" row and "To use it" line, the
// right-click menu Copy @name and the delete dialog its use count and the sentence about notes.
// The `notes off` spec above proves the switch still turns that look off.
// What this does not cover (unit tests, the other fonts-*.spec.ts files and the QA run do): the
// picked-folder path (the OS picker), the real library of 40 families, the @ picker, the chips and
// the live preview in Review (fonts-picker, fonts-notes-boxes and fonts-preview).

import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { renameFontFamily } from '../apps/server/src/fonts/font-test-rename.ts';
import { type Engine, startEngine } from './support/engine.ts';

const WAIT = { timeout: 30_000 };
const DAY_MS = 86_400_000;

/** The six small real font files of the repo (fixtures/fonts/), under their families and folders. */
const FIXTURES = fileURLToPath(new URL('../fixtures/fonts/', import.meta.url));
const LIBRARY = [
  { family: 'Secular One', folder: 'Hebrew + English', file: 'SecularOne-Regular.ttf' },
  { family: 'Bellefair', folder: 'Hebrew + English', file: 'Bellefair-Regular.ttf' },
  { family: 'Varela Round', folder: 'Hebrew + English', file: 'VarelaRound-Regular.ttf' },
  { family: 'Outfit', folder: 'English only', file: 'Outfit-Regular.ttf' },
  { family: 'Outfit', folder: 'English only', file: 'Outfit-Bold.ttf' },
  { family: 'Oswald', folder: 'English only', file: 'Oswald-Regular.ttf' },
] as const;

/** The families the page lists, A to Z, when nothing is new. */
const FAMILIES = ['Bellefair', 'Oswald', 'Outfit', 'Secular One', 'Varela Round'];

/** The family the import brings: a real Hebrew font (Bellefair) under a name the library lacks. */
const NEW_FAMILY = 'Karantina';
const NEW_FILE = 'Karantina-Regular.ttf';
const BROKEN_FILE = 'broken-cut-short.ttf';

let engine: Engine;
/** A folder of the spec's own: the stand-in `open`, its log, and the fonts waiting to be moved in. */
let scratch: string;
let openLog: string;
/** What the real `~/.Trash` held before the run (null when this process may not read it). */
let realTrashBefore: string[] | null;

test.describe.configure({ mode: 'serial' });

async function listOrNull(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch {
    return null;
  }
}

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'studio-e2e-fonts-'));
  // The engine runs `open -R <folder>` for Show in Finder; this one writes its arguments down.
  const fakeBin = join(scratch, 'bin');
  openLog = join(scratch, 'open.log');
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, 'open'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$E2E_OPEN_LOG"\n');
  await chmod(join(fakeBin, 'open'), 0o755);
  // This process has the real HOME; the engine has its own (startEngine), so its Trash is another.
  realTrashBefore = await listOrNull(join(homedir(), '.Trash'));
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 1,
    review: false,
    env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, E2E_OPEN_LOG: openLog },
  });
});

test.afterAll(async () => {
  await engine?.stop();
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

// --- what the specs share -------------------------------------------------------------------------

const onDisk = (...parts: string[]): string => join(engine.inbox, '_Fonts', ...parts);
const inTrash = (...parts: string[]): string => join(engine.home, '.Trash', ...parts);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

interface FamilyOnServer {
  slug: string;
  name: string;
  he: boolean;
  weights: number[];
  weightsLabel: string;
  used: number;
  usedLabel: string;
  isNew: boolean;
}

interface LibraryOnServer {
  families: FamilyOnServer[];
  catalog: { name: string; weight: number; fileId: string; format: string }[];
  requests: unknown[];
}

async function libraryOnServer(): Promise<LibraryOnServer> {
  const response = await fetch(`${engine.baseURL}/api/fonts`);
  expect(response.status).toBe(200);
  return (await response.json()) as LibraryOnServer;
}

/** Every file under `_Fonts`, as paths inside it, sorted. */
async function filesInFonts(): Promise<string[]> {
  const found: string[] = [];
  async function walk(folder: string, prefix: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(folder, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  }
  await walk(onDisk(), '');
  return found.sort();
}

/**
 * Files into the library the way Finder does: a move (the file keeps its modified time), after
 * its time was set two days back, so none of them carries the "New" tag.
 */
async function moveIntoFonts(files: readonly (typeof LIBRARY)[number][]): Promise<void> {
  const waiting = join(scratch, 'waiting');
  await mkdir(waiting, { recursive: true });
  const old = new Date(Date.now() - 2 * DAY_MS);
  for (const spec of files) {
    const from = join(waiting, spec.file);
    await copyFile(join(FIXTURES, spec.file), from);
    await utimes(from, old, old);
    await mkdir(onDisk(spec.folder, spec.family), { recursive: true });
    await rename(from, onDisk(spec.folder, spec.family, spec.file));
  }
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

/** What the page asked of the engine's font routes, and the errors it threw. */
interface Watch {
  pageErrors: string[];
  fontFiles: { url: string; status: number; type: string | null }[];
  reveals: string[];
}

/** Opens a page of the app in a fresh browser, and keeps what it throws and which fonts it fetches. */
async function open(page: Page, path: string): Promise<Watch> {
  const watch: Watch = { pageErrors: [], fontFiles: [], reveals: [] };
  page.on('pageerror', (error) => watch.pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/fonts/file/')) {
      watch.fontFiles.push({
        url: url.pathname + url.search,
        status: response.status(),
        type: response.headers()['content-type'] ?? null,
      });
    }
  });
  page.on('request', (request) => {
    if (/\/api\/fonts\/[^/]+\/reveal$/.test(new URL(request.url()).pathname)) {
      watch.reveals.push(request.url());
    }
  });
  await page.goto(`${engine.baseURL}${path}`);
  await dismissWhatsNew(page);
  return watch;
}

const rowOf = (page: Page, slug: string): Locator => page.locator(`[data-font-slug="${slug}"]`);
const rows = (page: Page): Locator => page.locator('[data-font-slug]');
const pane = (page: Page): Locator => page.locator('[data-slot="font-pane"]');
const paneTitle = (page: Page): Locator => pane(page).getByRole('heading', { level: 2 });
const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Import fonts' });
const toasts = (page: Page): Locator => page.locator('section[aria-label^="Notifications"]');
const scriptTab = (page: Page, name: string): Locator =>
  page.getByRole('tab', { name: new RegExp(`^${name.replace('+', '\\+')}`) });

/** The slugs of the rows, in the order they are on the page. */
const slugsOf = (page: Page): Promise<(string | null)[]> =>
  rows(page).evaluateAll((items) => items.map((item) => item.getAttribute('data-font-slug')));

/** The names of the rows, in the order they are on the page. */
const namesOf = (page: Page): Promise<string[]> =>
  page.locator('[data-slot="font-name"]').allInnerTexts();

/** A file in the form the picker hands to a file input. */
const fontFile = (name: string, buffer: Buffer) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer,
});

/** A drag of files over the window, as the browser sends it: enter and over, or the drop. */
async function dragFiles(page: Page, kind: 'enter' | 'drop', bytes: number[]): Promise<void> {
  await page.evaluate(
    ({ step, content }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(content)], 'cut-short-drop.ttf', { type: '' }));
      for (const type of step === 'enter' ? ['dragenter', 'dragover'] : ['drop']) {
        document.body.dispatchEvent(
          new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      }
    },
    { step: kind, content: bytes },
  );
}

// --- the specs ------------------------------------------------------------------------------------

test('the sidebar item opens an empty page; fonts moved into _Fonts appear by themselves', async ({
  page,
}) => {
  const watch = await open(page, '/jobs');

  await test.step('the engine says the switch is on, and the sidebar has the item', async () => {
    const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
      fonts: boolean;
      fontsInNotes: boolean;
    };
    expect(health).toMatchObject({ fonts: true, fontsInNotes: true });
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Fonts' })
      .click();
    await expect(page).toHaveURL(/\/fonts/);
    await expect(page.getByRole('heading', { name: 'Fonts', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import fonts' }).first()).toBeEnabled();
  });

  await test.step('nothing is there yet: the hint and the empty pane say so', async () => {
    await expect(
      page.getByText('No fonts yet. Drop .ttf or .otf files anywhere on this page'),
    ).toBeVisible(WAIT);
    await expect(rows(page)).toHaveCount(0);
    await expect(pane(page)).toContainText('Pick a font to see it.');
    expect(await libraryOnServer()).toEqual({ families: [], catalog: [], requests: [] });
  });

  await test.step('_Fonts is in the inbox, and is not a client', async () => {
    expect(await exists(onDisk())).toBe(true);
    const clients = (await (await fetch(`${engine.baseURL}/api/clients`)).json()) as {
      client: string;
    }[];
    expect(clients.map((row) => row.client)).not.toContain('_Fonts');
  });

  await test.step('six files are moved into the two folders: the five families appear, no reload', async () => {
    await moveIntoFonts(LIBRARY);
    await expect(rows(page)).toHaveCount(FAMILIES.length, WAIT);
    expect(await namesOf(page)).toEqual(FAMILIES);
    // The first row is open: the address and the pane follow it.
    await expect(page).toHaveURL(/family=bellefair/, WAIT);
    await expect(paneTitle(page)).toHaveText('Bellefair', WAIT);
    // What the list says of each.
    await expect(rowOf(page, 'secular-one')).toContainText('Hebrew + English');
    await expect(rowOf(page, 'secular-one')).toContainText('1 weight');
    await expect(rowOf(page, 'outfit')).toContainText('English only');
    await expect(rowOf(page, 'outfit')).toContainText('2 weights');
    for (const slug of ['bellefair', 'oswald', 'outfit', 'secular-one', 'varela-round']) {
      // Fonts in notes is on: uses are counted, and no job has used these yet.
      await expect(rowOf(page, slug).locator('[data-slot="font-used"]')).toHaveText('Not used yet');
      await expect(rowOf(page, slug).locator('[data-slot="font-new"]')).toHaveCount(0);
      await expect(rowOf(page, slug)).toContainText('2 days ago');
    }
  });

  await test.step('the engine agrees: five families, six faces, three with Hebrew, in the two folders', async () => {
    const library = await libraryOnServer();
    expect(library.families.map((family) => family.name)).toEqual(FAMILIES);
    expect(library.catalog).toHaveLength(6);
    expect(library.families.filter((family) => family.he).map((family) => family.name)).toEqual([
      'Bellefair',
      'Secular One',
      'Varela Round',
    ]);
    expect(library.families.find((family) => family.name === 'Outfit')).toMatchObject({
      weights: [400, 700],
      used: 0,
      usedLabel: 'Not used yet',
      isNew: false,
    });
    expect(await filesInFonts()).toEqual(
      LIBRARY.map((spec) => `${spec.folder}/${spec.family}/${spec.file}`).sort(),
    );
  });

  expect(watch.pageErrors).toEqual([]);
});

test('the tabs count and filter the families; the search narrows them', async ({ page }) => {
  const watch = await open(page, '/fonts');
  await expect(rows(page)).toHaveCount(5, WAIT);

  await test.step('All · Hebrew + English · English only hold 5 · 3 · 2', async () => {
    for (const [name, count] of [
      ['All', '5'],
      ['Hebrew + English', '3'],
      ['English only', '2'],
    ] as const) {
      await expect(scriptTab(page, name).locator('[data-slot="font-tab-count"]')).toHaveText(count);
    }
  });

  await test.step('Hebrew + English shows its three, English only its two, All all five', async () => {
    await scriptTab(page, 'Hebrew + English').click();
    await expect(rows(page)).toHaveCount(3);
    expect(await namesOf(page)).toEqual(['Bellefair', 'Secular One', 'Varela Round']);
    await scriptTab(page, 'English only').click();
    await expect(rows(page)).toHaveCount(2);
    expect(await namesOf(page)).toEqual(['Oswald', 'Outfit']);
    // the open family is one of the two shown (the tab hid the one that was open)
    await expect(rowOf(page, 'oswald')).toHaveAttribute('data-selected', 'true');
    await scriptTab(page, 'All').click();
    await expect(rows(page)).toHaveCount(5);
  });

  await test.step('the search matches names; the counts stay; no match says so', async () => {
    const search = page.getByRole('searchbox', { name: 'Search fonts' });
    await search.fill('vare');
    await expect(rows(page)).toHaveCount(1);
    await expect(rowOf(page, 'varela-round')).toBeVisible();
    await expect(scriptTab(page, 'All').locator('[data-slot="font-tab-count"]')).toHaveText('5');
    await search.fill('Gotham');
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText('No font matches “Gotham”.')).toBeVisible();
    await search.fill('');
    await expect(rows(page)).toHaveCount(5);
  });

  expect(watch.pageErrors).toEqual([]);
});

// CVP-366 (C48): the open pane takes 440 px of the window, so in a 1024 px window the list is about
// 296 px wide and the name column used to get 0 px. The columns now leave by the list's own width.
// CVP-367 (C49): the search box takes the width the tabs leave (at 1280 it used to run 11 px, and 36
// px with the real library's two-digit counts, under the pane's border), and in a narrow window the
// pane is the one that gives way, from 440 px down to 320 px, so the tabs never run behind it.
test('the list keeps every name from 800 to 1440 px with the pane open, and nothing runs under the pane', async ({
  page,
}) => {
  const watch = await open(page, '/fonts');
  await expect(rows(page)).toHaveCount(5, WAIT);

  /** What the page looks like now: widths and edges of the list, the tabs, the search and the pane. */
  const look = () =>
    page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('[data-slot="font-list"]');
      const search = document.querySelector<HTMLElement>('input[type="search"]');
      const aside = document.querySelector<HTMLElement>('aside[aria-label="Preview"]');
      const section = document.querySelector<HTMLElement>('[data-slot="fonts-page"] section');
      const tabsList = document.querySelector<HTMLElement>('[data-slot="tabs-list"]');
      const items = [...document.querySelectorAll<HTMLElement>('[data-font-slug]')];
      if (
        list === null ||
        search === null ||
        aside === null ||
        section === null ||
        tabsList === null ||
        items.length === 0
      ) {
        return null;
      }
      const shown = (slot: string) => {
        const cell = items[0]?.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
        return cell != null && getComputedStyle(cell).display !== 'none';
      };
      const box = search.parentElement?.getBoundingClientRect();
      const tabs = tabsList.getBoundingClientRect();
      const paneLeft = aside.getBoundingClientRect().left;
      // Everything of the main column (heading, button, tabs, search, rows) that reaches the pane.
      const behindPane = [...section.querySelectorAll<HTMLElement>('*')]
        .filter((el) => {
          const edge = el.getBoundingClientRect();
          return (
            edge.width > 0 &&
            edge.height > 0 &&
            getComputedStyle(el).display !== 'none' &&
            edge.right > paneLeft + 0.5
          );
        })
        .map((el) => el.getAttribute('data-slot') ?? el.tagName.toLowerCase());
      const labels = [...tabsList.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]')].map(
        (tab) => tab.firstElementChild as HTMLElement | null,
      );
      return {
        listWidth: Math.round(list.getBoundingClientRect().width),
        listRight: Math.round(list.getBoundingClientRect().right),
        paneWidth: Math.round(aside.getBoundingClientRect().width),
        paneLeft: Math.round(paneLeft),
        sidewaysScroll: document.documentElement.scrollWidth > window.innerWidth,
        names: items.map((item) => {
          const name = item.querySelector<HTMLElement>('[data-slot="font-name"]');
          return {
            width: Math.round(name?.getBoundingClientRect().width ?? 0),
            cut: name === null || name.scrollWidth > name.clientWidth,
          };
        }),
        script: shown('font-script'),
        weights: shown('font-weights-label'),
        added: shown('font-added'),
        used: shown('font-used'),
        tabsLeft: Math.round(tabs.left),
        tabsRight: Math.round(tabs.right),
        tabsTop: Math.round(tabs.top),
        tabsBottom: Math.round(tabs.bottom),
        // a tab's label is cut when its text is wider than the box it sits in
        tabsCut: labels.map((label) => label === null || label.scrollWidth > label.clientWidth),
        searchLeft: Math.round(box?.left ?? 0),
        searchRight: Math.round(box?.right ?? 0),
        searchTop: Math.round(box?.top ?? 0),
        searchWidth: Math.round(box?.width ?? 0),
        behindPane,
      };
    });

  /** Names whole, no sideways scroll (when the shell's header lets it), nothing under the pane. */
  const expectCalm = (seen: Awaited<ReturnType<typeof look>>, scroll: boolean) => {
    expect(seen?.names).toHaveLength(5);
    for (const name of seen?.names ?? []) {
      expect(name.width).toBeGreaterThanOrEqual(30);
      expect(name.cut).toBe(false);
    }
    // the list, the tabs and the search end where the list ends, short of the pane
    expect(seen?.behindPane).toEqual([]);
    expect(seen?.tabsRight ?? 9999).toBeLessThanOrEqual(seen?.listRight ?? 0);
    expect(seen?.searchRight ?? 9999).toBeLessThanOrEqual(seen?.listRight ?? 0);
    expect(seen?.listRight ?? 9999).toBeLessThan(seen?.paneLeft ?? 0);
    if (scroll) expect(seen?.sidewaysScroll).toBe(false);
  };

  await test.step('800 px: the pane gives way to 320 px, the list is under its tabs, and nothing runs under the pane', async () => {
    await page.setViewportSize({ width: 800, height: 768 });
    await expect.poll(async () => (await look())?.paneWidth ?? 0).toBe(320);
    const seen = await look();
    // The shell's own header is wider than an 800 px window, so the page can scroll sideways
    // there whatever the Fonts page does; what matters here is that the page's own parts fit.
    expectCalm(seen, false);
    // the tabs are cut here (the list is narrower than 288 px), but All stays whole
    expect(seen?.tabsCut[0]).toBe(false);
    // and the search is under them
    expect(seen?.searchTop ?? 0).toBeGreaterThanOrEqual(seen?.tabsBottom ?? 9999);
  });

  await test.step('900 px: the pane gives way to 320 px, so the list keeps its 288 px of whole tabs', async () => {
    await page.setViewportSize({ width: 900, height: 768 });
    await expect.poll(async () => (await look())?.listWidth ?? 0).toBeGreaterThanOrEqual(288);
    const seen = await look();
    expect(seen?.paneWidth).toBe(320);
    expectCalm(seen, true);
    expect(seen?.tabsCut).toEqual([false, false, false]);
    expect(seen).toMatchObject({ script: true, weights: false, added: false, used: false });
    expect(seen?.searchTop ?? 0).toBeGreaterThanOrEqual(seen?.tabsBottom ?? 9999);
  });

  await test.step('1000 px: the pane is 416 px and the list is still 296 px', async () => {
    await page.setViewportSize({ width: 1000, height: 768 });
    await expect.poll(async () => (await look())?.paneWidth ?? 0).toBe(416);
    const seen = await look();
    expect(seen?.listWidth).toBe(296);
    expectCalm(seen, true);
    expect(seen?.tabsCut).toEqual([false, false, false]);
  });

  await test.step('1024 px: the list is about 296 px, the icon, the name and the script stay', async () => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(async () => (await look())?.listWidth ?? 9999).toBeLessThan(400);
    const seen = await look();
    expect(seen?.paneWidth).toBe(440);
    expectCalm(seen, true);
    expect(seen).toMatchObject({ script: true, weights: false, added: false, used: false });
    expect(seen?.tabsCut).toEqual([false, false, false]);
    // The search box is under the tabs, not behind the pane.
    expect(seen?.searchTop ?? 0).toBeGreaterThanOrEqual(seen?.tabsBottom ?? 9999);
  });

  await test.step('1280 px: the list is about 552 px and keeps the script, weights and added columns (the used one waits for 590 px); the search takes what the tabs leave', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await look())?.listWidth ?? 0).toBeGreaterThan(500);
    const seen = await look();
    expect(seen?.listWidth).toBeLessThan(600);
    expect(seen?.paneWidth).toBe(440);
    expectCalm(seen, true);
    expect(seen).toMatchObject({ script: true, weights: true, added: true, used: false });
    // Tabs and search share one row: the box is narrower than its 220 px, never under 144 px, ends
    // with the list (the Import fonts button above it), and leaves the tabs a gap.
    expect(seen?.searchTop ?? 0).toBeLessThan(seen?.tabsBottom ?? 0);
    expect(seen?.searchWidth ?? 0).toBeLessThan(220);
    expect(seen?.searchWidth ?? 0).toBeGreaterThanOrEqual(144);
    expect(seen?.searchRight).toBe(seen?.listRight);
    expect((seen?.searchLeft ?? 0) - (seen?.tabsRight ?? 0)).toBeGreaterThanOrEqual(12);
    // and a full 32 px of the section's padding is left before the pane's border
    expect((seen?.paneLeft ?? 0) - (seen?.searchRight ?? 0)).toBeGreaterThanOrEqual(32);
  });

  await test.step('1440 px: nothing leaves (the used column is back), and the search is the board’s 220 px', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await look())?.listWidth ?? 0).toBeGreaterThan(650);
    const seen = await look();
    expect(seen).toMatchObject({
      script: true,
      weights: true,
      used: true,
      added: true,
      sidewaysScroll: false,
      paneWidth: 440,
      searchWidth: 220,
    });
    expectCalm(seen, true);
    expect(seen?.searchRight).toBe(seen?.listRight);
  });

  expect(watch.pageErrors).toEqual([]);
});

test('a family opens in the pane: weights, the real file, the try box and On a frame', async ({
  page,
}) => {
  const watch = await open(page, '/fonts');
  await expect(rows(page)).toHaveCount(5, WAIT);

  await test.step('clicking Outfit opens it in the pane and the address', async () => {
    await rowOf(page, 'outfit').click();
    await expect(paneTitle(page)).toHaveText('Outfit', WAIT);
    await expect(page).toHaveURL(/family=outfit/);
    await expect(rowOf(page, 'outfit')).toHaveAttribute('data-selected', 'true');
    await expect(pane(page)).toContainText('English only · 2 weights');
    // no Hebrew letters in it: the note says so, and the Hebrew words keep Heebo
    await expect(pane(page).locator('[data-slot="font-no-hebrew"]')).toContainText(
      'No Hebrew letters in this font.',
    );
  });

  await test.step('two weight rows, Regular chosen; Bold sets the specimen in 700', async () => {
    const weights = pane(page).locator('[data-slot="font-weights"] button');
    await expect(weights).toHaveCount(2);
    await expect(pane(page).locator('button[data-weight="400"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(pane(page).locator('[data-slot="font-glyphs"]')).toHaveCSS('font-weight', '400');
    await pane(page).locator('button[data-weight="700"]').click();
    await expect(pane(page).locator('button[data-weight="700"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(pane(page).locator('button[data-weight="400"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(pane(page).locator('[data-slot="font-glyphs"]')).toHaveCSS('font-weight', '700');
    await expect(pane(page).locator('[data-slot="font-lines"]')).toHaveCSS('font-weight', '700');
    await expect(pane(page).locator('button[data-weight="700"]')).toContainText('@Outfit Bold');
  });

  await test.step('the pane draws the real files: served as fonts, cached for good, loaded in the page', async () => {
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.fonts]
            .filter((face) => face.family.includes('fe-'))
            .map((face) => face.status),
        ),
      )
      .toContain('loaded');
    expect(watch.fontFiles.length).toBeGreaterThan(0);
    for (const file of watch.fontFiles) {
      expect(file.status).toBe(200);
      expect(file.type).toBe('font/ttf');
      expect(file.url).toMatch(/^\/api\/fonts\/file\/[0-9a-f]+\?v=\d+$/);
    }
    // and with the version in the address the browser may keep it for good
    const first = watch.fontFiles[0];
    const cached = await fetch(`${engine.baseURL}${first?.url}`);
    expect(cached.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  await test.step('the facts say what the folder holds and that no job used it; "To use it" names the chosen weight', async () => {
    const facts = pane(page).locator('[data-slot="font-facts"]');
    await expect(facts).toContainText('English only');
    await expect(facts).toContainText('2 TTF');
    await expect(facts).toContainText('Used in');
    await expect(facts).toContainText('Not used yet');
    await expect(pane(page).locator('[data-slot="font-use"]')).toHaveText(
      'To use it, write @Outfit Bold in a note on a job.',
    );
  });

  await test.step('the try box replaces the two lines, and emptying it brings them back', async () => {
    const box = pane(page).getByRole('textbox', { name: 'Try your own text' });
    await box.fill('Opening night שלום לכולם');
    await expect(pane(page).locator('[data-slot="font-own-text"]')).toHaveText(
      'Opening night שלום לכולם',
    );
    await expect(pane(page).locator('[data-slot="font-lines"]')).toHaveCount(0);
    await box.fill('');
    await expect(pane(page).locator('[data-slot="font-lines"]')).toBeVisible();
    await expect(pane(page).locator('[data-slot="font-own-text"]')).toHaveCount(0);
  });

  await test.step('On a frame: the photo, the caption in Bold, the tag, the chips and the credit', async () => {
    await page.getByRole('tab', { name: 'On a frame' }).click();
    const view = pane(page).locator('[data-slot="font-frame-view"]');
    await expect(view).toBeVisible();
    const photo = view.locator('img');
    await expect(photo).toHaveAttribute('src', '/api/fonts/frame/person.jpg');
    await expect
      .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth), WAIT)
      .toBeGreaterThan(0);
    await expect(view.locator('[data-slot="font-caption"]')).toHaveCSS('font-weight', '700');
    await expect(view.locator('[data-slot="font-caption"]')).toContainText('ככה הכול התחיל');
    await expect(view.locator('[data-slot="font-caption"]')).toContainText(
      'That’s how it all started',
    );
    await expect(view.locator('[data-slot="font-frame-tag"]')).toHaveText('@Outfit Bold');
    await expect(view.locator('[data-slot="font-frame-no-hebrew"]')).toContainText(
      'No Hebrew letters in this font, so the Hebrew line is in Heebo.',
    );
    await view.getByRole('button', { name: 'Street', exact: true }).click();
    await expect(photo).toHaveAttribute('src', '/api/fonts/frame/street.jpg');
    await expect(view.locator('[data-slot="font-frame-credit"]')).toContainText('Photo:');
    await expect
      .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth), WAIT)
      .toBeGreaterThan(0);
  });

  await test.step('another family keeps the view and the frame; a Hebrew one has no note', async () => {
    await rowOf(page, 'secular-one').click();
    await expect(paneTitle(page)).toHaveText('Secular One', WAIT);
    await expect(pane(page).locator('[data-slot="font-frame-view"] img')).toHaveAttribute(
      'src',
      '/api/fonts/frame/street.jpg',
    );
    await expect(pane(page).locator('[data-slot="font-frame-no-hebrew"]')).toHaveCount(0);
    await expect(pane(page).locator('[data-slot="font-frame-tag"]')).toHaveText('@Secular One');
    await expect(pane(page)).toContainText('Hebrew + English · 1 weight');
    // back to Text: Outfit still remembers its Bold
    await page.getByRole('tab', { name: 'Text', exact: true }).click();
    await expect(pane(page).locator('[data-slot="font-text-view"]')).toBeVisible();
    await rowOf(page, 'outfit').click();
    await expect(paneTitle(page)).toHaveText('Outfit', WAIT);
    await expect(pane(page).locator('button[data-weight="700"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  expect(watch.pageErrors).toEqual([]);
});

test('the right-click menu: Show in Finder reaches open -R on the family’s folder', async ({
  page,
}) => {
  const watch = await open(page, '/fonts?family=secular-one');
  await expect(rowOf(page, 'secular-one')).toBeVisible(WAIT);

  await test.step('the menu offers Show in Finder, Copy @Secular One and Delete…', async () => {
    await rowOf(page, 'secular-one').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for Secular One' });
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Show in Finder',
      'Copy @Secular One',
      'Delete…',
    ]);
  });

  await test.step('Copy @Secular One puts the name on the clipboard and says so', async () => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: engine.baseURL,
    });
    await page.getByRole('menuitem', { name: 'Copy @Secular One' }).click();
    await expect(toasts(page)).toContainText('Copied @Secular One');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('@Secular One');
    // the menu closed with the choice; open it again for the next step
    await rowOf(page, 'secular-one').click({ button: 'right' });
  });

  await test.step('Show in Finder asks the engine; the stand-in open writes down what it was asked', async () => {
    await page.getByRole('menuitem', { name: 'Show in Finder' }).click();
    await expect
      .poll(async () => (await readFile(openLog, 'utf8').catch(() => '')).trim(), WAIT)
      .toBe(`-R ${onDisk('Hebrew + English', 'Secular One')}`);
    expect(watch.reveals).toHaveLength(1);
  });

  expect(watch.pageErrors).toEqual([]);
});

test('import: a font the library lacks and a cut-short file, through the dialog', async ({
  page,
}) => {
  const watch = await open(page, '/fonts');
  await expect(rows(page)).toHaveCount(5, WAIT);
  const before = await filesInFonts();
  const picker = dialog(page).locator('input[type="file"]:not([webkitdirectory])');
  const karantina = renameFontFamily(
    await readFile(join(FIXTURES, 'Bellefair-Regular.ttf')),
    'Bellefair',
    NEW_FAMILY,
  );

  await test.step('Import fonts opens the dialog at its first step', async () => {
    await page.getByRole('button', { name: 'Import fonts' }).first().click();
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).getByText('Drop .ttf, .otf, .woff or .woff2 files here'),
    ).toBeVisible();
    await expect(dialog(page).getByText('Copied into _Fonts in your Studio Inbox')).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Choose files…' })).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Choose a folder…' })).toBeVisible();
  });

  await test.step('two files go up: the family is New, the cut-short file can’t be imported', async () => {
    await picker.setInputFiles([
      fontFile(NEW_FILE, karantina),
      fontFile(BROKEN_FILE, await readFile(join(FIXTURES, BROKEN_FILE))),
    ]);
    const list = dialog(page).getByRole('list', { name: 'Fonts to import' });
    await expect(list.locator('li')).toHaveCount(2, WAIT);
    const good = list.locator('li[data-status="new"]');
    await expect(good).toHaveCount(1);
    await expect(good).toContainText(NEW_FAMILY);
    await expect(good).toContainText('1 file · Hebrew + English');
    await expect(good.locator('[data-slot="font-import-tag"]')).toHaveText('New');
    const bad = list.locator('li[data-status="bad"]');
    await expect(bad).toHaveCount(1);
    await expect(bad).toContainText(BROKEN_FILE);
    await expect(bad).toContainText('Not a font: the file is cut short.');
    await expect(bad.locator('[data-slot="font-import-tag"]')).toHaveText('Can’t import');
    // only the good one counts, and nothing is in _Fonts yet
    await expect(dialog(page).getByRole('button', { name: 'Import 1 font' })).toBeEnabled();
    expect(await filesInFonts()).toEqual(before);
    expect((await libraryOnServer()).families).toHaveLength(5);
  });

  await test.step('Import 1 font copies it, closes the dialog, says so and opens the new family', async () => {
    await dialog(page).getByRole('button', { name: 'Import 1 font' }).click();
    await expect(dialog(page)).toBeHidden(WAIT);
    await expect(toasts(page)).toContainText('Imported 1 font');
    // with notes on the toast also says how to use it
    await expect(toasts(page)).toContainText('Write @Karantina in a note to use one.');
    // filed by what the file says (Hebrew), in a folder of the family's name, under the name it came with
    expect(await filesInFonts()).toEqual(
      [...before, `Hebrew + English/${NEW_FAMILY}/${NEW_FILE}`].sort(),
    );
    expect(await readFile(onDisk('Hebrew + English', NEW_FAMILY, NEW_FILE))).toEqual(karantina);
    // the cut-short file was not copied anywhere
    expect((await filesInFonts()).some((file) => file.includes(BROKEN_FILE))).toBe(false);
    const library = await libraryOnServer();
    expect(library.families).toHaveLength(6);
    expect(library.families.find((family) => family.name === NEW_FAMILY)).toMatchObject({
      slug: 'karantina',
      he: true,
      isNew: true,
      weights: [400],
    });
  });

  await test.step('the list has the New tag on the new family, on top, and it is the open one', async () => {
    await expect(rows(page)).toHaveCount(6, WAIT);
    await expect(rowOf(page, 'karantina').locator('[data-slot="font-new"]')).toHaveText('New');
    expect((await namesOf(page))[0]).toBe(NEW_FAMILY);
    await expect(rowOf(page, 'karantina')).toContainText('Hebrew + English');
    await expect(rowOf(page, 'karantina')).toContainText('1 weight');
    await expect(page.locator('[data-slot="font-new"]')).toHaveCount(1);
    await expect(page).toHaveURL(/family=karantina/, WAIT);
    await expect(paneTitle(page)).toHaveText(NEW_FAMILY, WAIT);
    await expect(
      scriptTab(page, 'Hebrew + English').locator('[data-slot="font-tab-count"]'),
    ).toHaveText('4');
    // and its real file (the copy in _Fonts) is the one the pane drew its specimen with
    const detail = (await (await fetch(`${engine.baseURL}/api/fonts/karantina`)).json()) as {
      faces: { fileId: string }[];
    };
    const fileId = detail.faces[0]?.fileId ?? '';
    expect(fileId).not.toBe('');
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              [...document.fonts].filter((face) => face.family.includes(id)).map((f) => f.status),
            `fe-${fileId}`,
          ),
        WAIT,
      )
      .toEqual(['loaded']);
    await expect(pane(page).locator('[data-slot="font-file-failed"]')).toHaveCount(0);
  });

  expect(watch.pageErrors).toEqual([]);
});

test('files dropped on the page show the veil and open the dialog with the verdicts', async ({
  page,
}) => {
  const watch = await open(page, '/fonts');
  await expect(rows(page)).toHaveCount(6, WAIT);
  const cutShort = [...(await readFile(join(FIXTURES, BROKEN_FILE)))];

  await test.step('a drag of files over the window shows "Drop to import"', async () => {
    await dragFiles(page, 'enter', cutShort);
    await expect(page.locator('[data-slot="font-drop-overlay"]')).toContainText('Drop to import');
  });

  await test.step('the drop opens the dialog with the file already checked', async () => {
    await dragFiles(page, 'drop', cutShort);
    await expect(page.locator('[data-slot="font-drop-overlay"]')).toBeHidden();
    await expect(dialog(page)).toBeVisible();
    const list = dialog(page).getByRole('list', { name: 'Fonts to import' });
    await expect(list.locator('li')).toHaveCount(1, WAIT);
    await expect(list).toContainText('cut-short-drop.ttf');
    await expect(list).toContainText('Not a font: the file is cut short.');
    // nothing can be imported
    await expect(dialog(page).getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  });

  await test.step('Cancel throws the upload away: nothing was added', async () => {
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toBeHidden();
    expect((await libraryOnServer()).families).toHaveLength(6);
    expect((await filesInFonts()).some((file) => file.includes('cut-short-drop'))).toBe(false);
  });

  expect(watch.pageErrors).toEqual([]);
});

test('delete: the whole family goes to the Trash of the run, its folder goes, the next row opens', async ({
  page,
}) => {
  const watch = await open(page, `/fonts?family=${NEW_FAMILY.toLowerCase()}`);
  await expect(paneTitle(page)).toHaveText(NEW_FAMILY, WAIT);
  const before = (await slugsOf(page)).filter((slug) => slug !== null);
  const next = before[before.indexOf('karantina') + 1];
  expect(next).toBeDefined();

  await test.step('Delete… asks, and says what goes', async () => {
    await rowOf(page, 'karantina').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Delete “Karantina”?');
    await expect(ask).toContainText('Not used by any job yet. Its only weight goes.');
    await expect(ask).toContainText('It goes to the Trash');
    await expect(ask).toContainText('notes that name it stop working');
    await ask.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ask).toBeHidden(WAIT);
  });

  await test.step('the row goes and the one after it opens', async () => {
    await expect(rowOf(page, 'karantina')).toHaveCount(0, WAIT);
    await expect(rows(page)).toHaveCount(5);
    expect(await namesOf(page)).toEqual(FAMILIES);
    await expect(rowOf(page, next ?? '')).toHaveAttribute('data-selected', 'true', WAIT);
    await expect(page).toHaveURL(new RegExp(`family=${next}`));
  });

  await test.step('the files are in the Trash of the run, the folder is gone, the others are untouched', async () => {
    expect(await readFile(inTrash(NEW_FAMILY, NEW_FILE))).toBeDefined();
    expect(await exists(onDisk('Hebrew + English', NEW_FAMILY))).toBe(false);
    // the two parent folders stay, and so does every other family
    expect((await readdir(onDisk())).sort()).toEqual(['English only', 'Hebrew + English']);
    expect(await filesInFonts()).toEqual(
      LIBRARY.map((spec) => `${spec.folder}/${spec.family}/${spec.file}`).sort(),
    );
    const library = await libraryOnServer();
    expect(library.families.map((family) => family.name)).toEqual(FAMILIES);
    expect((await fetch(`${engine.baseURL}/api/fonts/karantina`)).status).toBe(404);
  });

  await test.step('the REAL Trash of this Mac gained nothing', async () => {
    // The engine's HOME is the run's own folder; had the family gone to the real ~/.Trash it
    // would be here under its name.
    const after = await listOrNull(join(homedir(), '.Trash'));
    if (realTrashBefore !== null && after !== null) {
      const added = after.filter((name) => !realTrashBefore?.includes(name));
      expect(added.filter((name) => name.startsWith(NEW_FAMILY))).toEqual([]);
    }
    // and the Trash of the run is the one that took it
    expect((await stat(inTrash(NEW_FAMILY))).isDirectory()).toBe(true);
    expect(await exists(join(engine.home, '.Trash', NEW_FAMILY, NEW_FILE))).toBe(true);
  });

  expect(watch.pageErrors).toEqual([]);
  // Show in Finder was asked for once in this run (its own spec), and nothing here opened Finder.
  expect((await readFile(openLog, 'utf8')).trim().split('\n')).toHaveLength(1);
});

// FN23: the notes switch is on by default, and STUDIO_FONTS_IN_NOTES=0 still turns it off. A second
// engine (its own inbox, data and HOME) with the switch off: the page is the one build 1 shipped.
test('with STUDIO_FONTS_IN_NOTES=0 the page has no used column, no Copy @name and no notes sentence', async ({
  page,
}) => {
  const off = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 1,
    review: false,
    env: { STUDIO_FONTS_IN_NOTES: '0' },
  });
  try {
    const target = join(off.inbox, '_Fonts', 'Hebrew + English', 'Secular One');
    await mkdir(target, { recursive: true });
    await copyFile(
      join(FIXTURES, 'SecularOne-Regular.ttf'),
      join(target, 'SecularOne-Regular.ttf'),
    );
    const old = new Date(Date.now() - 2 * DAY_MS);
    await utimes(join(target, 'SecularOne-Regular.ttf'), old, old);

    const health = (await (await fetch(`${off.baseURL}/api/health`)).json()) as {
      fonts: boolean;
      fontsInNotes: boolean;
    };
    expect(health).toMatchObject({ fonts: true, fontsInNotes: false });

    await page.goto(`${off.baseURL}/fonts?family=secular-one`);
    await dismissWhatsNew(page);
    await expect(rowOf(page, 'secular-one')).toBeVisible(WAIT);
    await expect(paneTitle(page)).toHaveText('Secular One', WAIT);

    // the list: no used column, and nothing says "Not used yet"
    await expect(rowOf(page, 'secular-one').locator('[data-slot="font-used"]')).toHaveCount(0);
    await expect(rowOf(page, 'secular-one')).not.toContainText('Not used yet');
    // the pane: no "Used in", no "To use it"
    const facts = pane(page).locator('[data-slot="font-facts"]');
    await expect(facts).toContainText('Hebrew + English');
    await expect(facts).not.toContainText('Used in');
    await expect(pane(page).locator('[data-slot="font-use"]')).toHaveCount(0);
    // the menu: no Copy @name
    await rowOf(page, 'secular-one').click({ button: 'right' });
    await expect(
      page.getByRole('menu', { name: 'Actions for Secular One' }).getByRole('menuitem'),
    ).toHaveText(['Show in Finder', 'Delete…']);
    // the delete dialog: what goes, and no use count or sentence about notes
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const ask = page.getByRole('alertdialog');
    await expect(ask).toContainText('Its only weight goes.');
    await expect(ask).not.toContainText('Not used by any job yet');
    await expect(ask).not.toContainText('notes that name it');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();
  } finally {
    await off.stop();
  }
});

// Last, because it stops the engine: the page keeps what it had and says so.
test('when the engine goes away the page says so and importing waits', async ({ page }) => {
  await open(page, '/fonts');
  await expect(rows(page)).toHaveCount(5, WAIT);
  await expect(page.locator('[data-slot="fonts-offline-banner"]')).toHaveCount(0);

  await engine.stop();

  await test.step('the bar under the header says when the list was last right', async () => {
    const banner = page.locator('[data-slot="fonts-offline-banner"]');
    await expect(banner).toBeVisible({ timeout: 40_000 });
    await expect(banner).toContainText(
      /Can’t reach the engine on your Mac\. This is the list as it was at \d\d:\d\d\. Importing waits until it’s back\./,
    );
  });

  await test.step('the list stays, Import fonts is off and a drop opens nothing', async () => {
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Import fonts' }).first()).toBeDisabled();
    await dragFiles(page, 'enter', [1, 2, 3]);
    await dragFiles(page, 'drop', [1, 2, 3]);
    await page.waitForTimeout(300);
    await expect(dialog(page)).toHaveCount(0);
  });
});
