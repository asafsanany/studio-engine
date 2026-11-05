// CVP-353 (FN20): the @ picker with fonts in the other note boxes, on the built server with the fake
// runner, the real Fonts routes over six small real font files (fixtures/fonts/), the real LUTs
// routes (a stand-in colour-grade skill) and a real browser. One engine with both notes switches on:
// fonts in notes on by default since FN23 (nothing is set for it here), `STUDIO_LUTS_IN_EDITS=1`
// for the LUTs. The picker and the chips are FN13's and
// FN14's (e2e/fonts-picker.spec.ts, in Review); this spec is the wiring in the "Note for the
// editor" dialog (the Brief's notes box) and where that note is shown.
//
//   the box     the placeholder says "@" points at a font, a LUT or a graphic; the dialog sits 288 px
//               from the top and the popover stays on the screen; "@" opens Fonts, LUTs, Graphics
//   keys        Esc closes only the picker (the dialog and the focus stay), the next Esc closes the
//               dialog; Enter inserts the highlighted font while the picker is open and is a new
//               line in the box once it is closed; ↓ Enter, Tab and a click insert "@Outfit Bold "
//   chips       a chip per font under the box, the font line, the card on hover kept inside the
//               dialog, × takes the token out and gives the focus back to the box
//   the note    Save keeps the note as typed; the row's note marker shows the fonts as pills; the
//               job sheet's note shows them as pills; the first edit run is told about both fonts
//               (the fake runner writes edit/library-refs.json) and brief.md holds the note word for
//               word
//
// Shots go to $E2E_SHOTS when it is set (the work item's hand-off); nothing is written otherwise.

import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { BUILTIN_LUTS } from '../packages/shared/src/domain/luts.ts';
import { type Engine, startEngine } from './support/engine.ts';
import {
  badge,
  chooseFromRowMenu,
  noteDialog,
  noteMarker,
  openTooltip,
  rowOf,
} from './support/jobs-ui.ts';
import { openApp, openSheetByClick, sheetOf } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Fonts notes job';
const RUN = { timeout: 60_000 };
const DAY_MS = 86_400_000;
const SHOTS = process.env.E2E_SHOTS;

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

const NOTE = 'Make the captions @Outfit Bold and the titles @Secular One';

let engine: Engine;
let skillDir: string;

test.describe.configure({ mode: 'serial' });

/** The text of a small .cube: the identity with a tint. */
function cube(n: number): string {
  const lines = [`TITLE "e2e"`, `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const rgb = [r, g, b].map((v) => Math.min(1, v / (n - 1) + (v === r ? 0.1 : 0)));
        lines.push(rgb.map((v) => v.toFixed(6)).join(' '));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

test.beforeAll(async () => {
  skillDir = await mkdtemp(join(tmpdir(), 'studio-e2e-skill-'));
  const dir = join(skillDir, 'correction_luts');
  await mkdir(dir, { recursive: true });
  for (const file of new Set(BUILTIN_LUTS.flatMap((row) => row.files))) {
    await writeFile(join(dir, file), cube(5));
  }
  if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  // A long settle time: the job stays "Arriving" while the note is written (also after the dialog
  // is cancelled once, for the Esc order below).
  engine = await startEngine({
    settleMs: 30_000,
    fakeSpeed: 4,
    env: {
      STUDIO_COLOR_GRADE_DIR: skillDir,
      STUDIO_LUTS_IN_EDITS: '1',
    },
  });
});

test.afterAll(async () => {
  await engine?.stop();
  if (skillDir !== undefined) await rm(skillDir, { recursive: true, force: true });
});

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('the @ picker with fonts in the note dialog, the pills where the note shows, the font in the first edit', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await openApp(page, engine.baseURL);

  await test.step('the library has its fonts', async () => {
    // Into the library the way Finder does: files that are two days old, so none is "New".
    const old = new Date(Date.now() - 2 * DAY_MS);
    for (const spec of LIBRARY) {
      const folder = join(engine.inbox, '_Fonts', spec.folder, spec.family);
      await mkdir(folder, { recursive: true });
      const to = join(folder, spec.file);
      await copyFile(join(FIXTURES, spec.file), to);
      await utimes(to, old, old);
    }
    await expect
      .poll(async () => {
        const list = (await (await fetch(`${engine.baseURL}/api/fonts`)).json()) as {
          families: unknown[];
          catalog: unknown[];
        };
        return `${list.families.length} ${list.catalog.length}`;
      }, RUN)
      .toBe('5 6');
    // The page asks for the list when it opens: reload so it has them.
    await page.reload();
  });

  const row = rowOf(page, JOB);
  const dialog = noteDialog(page);
  const box = dialog.getByRole('textbox', { name: 'Note' });
  const popover = dialog.locator('[data-slot="library-picker"]');
  const options = dialog.getByRole('option');
  const chips = dialog.locator('[data-slot="library-chip"]');

  await test.step('a job arrives and Add note… opens the dialog with the picker on', async () => {
    await engine.createJob({ client: CLIENT, job: JOB });
    await expect(badge(row, 'Arriving')).toBeVisible(RUN);
    await chooseFromRowMenu(page, row, 'Add note…');
    await expect(dialog).toBeVisible();
    await expect(box).toBeFocused();
    await expect(box).toHaveAttribute(
      'placeholder',
      'e.g. Keep it under 30 seconds. Type @ to point at a font, a LUT or a graphic.',
    );
    await expect(box).toHaveAttribute('dir', 'auto');
    await expect(popover).toHaveCount(0);
    await expect(chips).toHaveCount(0);
    // Sits 288 px from the top, as with LUTs, so the popover above the box clears the window.
    await expect.poll(async () => (await dialog.boundingBox())?.y).toBeCloseTo(288, 0);
    await shot(page, '01-dialog');
  });

  await test.step('"@" opens Fonts, LUTs and Graphics above the box, inside the window', async () => {
    await box.pressSequentially('Warm and calm. @');
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('listbox', { name: 'Library' })).toBeVisible();
    await expect(popover).toContainText('Fonts');
    await expect(popover).toContainText('LUTs');
    await expect(box).toHaveAttribute('data-picker', 'open');
    // Nothing is used yet, so the first five fonts A to Z lead.
    await expect(options.first()).toContainText('Bellefair');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    const where = await popover.boundingBox();
    const textBox = await box.boundingBox();
    expect(where?.width).toBeCloseTo(574, 0);
    expect(where?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect(where?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((where?.x ?? 0) + (where?.width ?? 0)).toBeLessThanOrEqual(1440);
    expect((where?.y ?? 0) + (where?.height ?? 0)).toBeLessThanOrEqual((textBox?.y ?? 0) + 1);
    await shot(page, '02-at');
  });

  await test.step('Esc closes only the picker; the dialog and the focus stay; the next Esc closes the dialog', async () => {
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(box).not.toHaveAttribute('data-picker', 'open');
    await expect(dialog).toBeVisible();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('Warm and calm. @');
    // The picker stays closed until the text changes.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Closing with Esc is Cancel: the note is not kept, and the job is let go.
    await chooseFromRowMenu(page, row, 'Add note…');
    await expect(dialog).toBeVisible();
    await expect(box).toHaveValue('');
  });

  await test.step('Enter is a new line once the picker is closed, and inserts while it is open', async () => {
    await box.pressSequentially('Intro first.');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('Intro first.\n');
    await expect(dialog).toBeVisible();
    await expect(popover).toHaveCount(0);
    // "@outf" is Outfit's two faces: Regular, then Bold; ↓ Enter inserts the Bold one.
    await box.fill('Make the captions ');
    await box.pressSequentially('@outf');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText('Outfit');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('Make the captions @Outfit Bold ');
    await expect(popover).toHaveCount(0);
    await expect(box).toBeFocused();
    // The Enter inserted; it did not save or close.
    await expect(dialog).toBeVisible();
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('@Outfit Bold');
    await expect(chips.first()).toHaveAttribute('dir', 'ltr');
    await expect(dialog.locator('[data-slot="library-uses"]')).toContainText(
      'A font is used for the text the note names, like the captions or the titles. If it names none, for all the text the edit adds.',
    );
  });

  await test.step('a click on a row inserts a second font, and Tab a third', async () => {
    await box.pressSequentially('and the titles @sec');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('Secular One');
    await options.first().click();
    await expect(box).toHaveValue('Make the captions @Outfit Bold and the titles @Secular One ');
    await expect(box).toBeFocused();
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText('@Outfit Bold');
    await expect(chips.nth(1)).toContainText('@Secular One');
    await box.pressSequentially('@bel');
    await expect(options).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(box).toHaveValue(
      'Make the captions @Outfit Bold and the titles @Secular One @Bellefair ',
    );
    await expect(chips).toHaveCount(3);
    await expect(dialog).toBeVisible();
    await shot(page, '03-three-chips');
  });

  await test.step('a chip’s card opens above it, set in the font, inside the dialog', async () => {
    const tip = dialog.getByRole('tooltip');
    await page.mouse.move(5, 5);
    await chips.nth(2).hover();
    await expect(tip).toBeVisible();
    await expect(tip.locator('[data-slot="font-card-name"]')).toHaveText('Bellefair');
    const shell = await dialog.boundingBox();
    await expect
      .poll(async () => {
        const card = await tip.boundingBox();
        return (card?.x ?? 0) + (card?.width ?? 0) <= (shell?.x ?? 0) + (shell?.width ?? 0) + 0.5;
      })
      .toBe(true);
    await chips.nth(0).hover();
    await expect(tip.locator('[data-slot="font-card-name"]')).toHaveText('Outfit Bold');
    await expect(tip).toContainText('No Hebrew letters');
    await shot(page, '04-chip-card');
    await page.mouse.move(5, 5);
  });

  await test.step('× takes the font out of the note and gives the focus back to the box', async () => {
    await dialog.getByRole('button', { name: 'Remove @Bellefair from the note' }).click();
    // The token and the one space after it go.
    await expect(box).toHaveValue('Make the captions @Outfit Bold and the titles @Secular One ');
    await expect(box).toBeFocused();
    await expect(chips).toHaveCount(2);
  });

  await test.step('Save keeps the note as typed (trimmed, as it always was)', async () => {
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(async () => {
        const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as {
          name: string;
          note: string | null;
        }[];
        return jobs.find((job) => job.name === JOB)?.note;
      })
      .toBe(NOTE);
  });

  await test.step('the row’s note marker shows both fonts as pills', async () => {
    await noteMarker(row).hover();
    const tip = openTooltip(page);
    await expect(tip).toBeVisible();
    const pills = tip.locator('[data-slot="library-token"]');
    await expect(pills).toHaveCount(2);
    await expect(pills.nth(0)).toHaveText('@Outfit Bold');
    await expect(pills.nth(1)).toHaveText('@Secular One');
    await expect(tip).toContainText('Make the captions');
    await expect(tip).toContainText('and the titles');
    await shot(page, '05-row-tooltip');
    // Moving the pointer away closes it (a few moves, as a hand makes).
    await page.mouse.move(700, 800, { steps: 10 });
    await expect(openTooltip(page)).toHaveCount(0);
  });

  await test.step('the job sheet’s note shows both fonts as pills', async () => {
    await openSheetByClick(page, row);
    const noteRow = sheetOf(page).locator('[data-slot="note-row"]');
    await expect(noteRow).toContainText('Make the captions');
    const pills = noteRow.locator('[data-slot="library-token"]');
    await expect(pills).toHaveCount(2);
    await expect(pills.nth(0)).toHaveText('@Outfit Bold');
    await expect(pills.nth(1)).toHaveText('@Secular One');
    await page.waitForTimeout(450); // the sheet slides in over 200 ms
    await shot(page, '06-sheet');
  });

  await test.step('the first edit is told about both fonts, and brief.md holds the note word for word', async () => {
    await expect(badge(row, 'Review')).toBeVisible({ timeout: 120_000 });
    const editDir = join(engine.inbox, CLIENT, JOB, 'edit');
    const refs = JSON.parse(await readFile(join(editDir, 'library-refs.json'), 'utf8')) as {
      fonts: { face: string; family: string; weight: number; path: string; he: boolean }[];
    };
    expect(refs.fonts.map((font) => font.face)).toEqual(['Outfit Bold', 'Secular One']);
    expect(refs.fonts.map((font) => font.he)).toEqual([false, true]);
    for (const font of refs.fonts) {
      expect(font.path).toMatch(/^edit\/fonts\//);
      expect(
        (await readFile(join(engine.inbox, CLIENT, JOB, font.path))).byteLength,
      ).toBeGreaterThan(1000);
    }
    const brief = await readFile(join(editDir, 'brief.md'), 'utf8');
    expect(brief).toContain(`## the owner’s note (word for word; it wins)\n${NOTE}\n`);
  });

  expect(pageErrors).toEqual([]);
});
