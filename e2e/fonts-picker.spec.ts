// CVP-346 (FN13): the fonts group of the @ picker in Review's note box, on the built server with the
// fake runner, the real Fonts routes over six small real font files (fixtures/fonts/), the real
// LUTs routes (a stand-in colour-grade skill of its own) and a real browser. One engine with both
// notes switches on: fonts in notes on by default since FN23 (nothing is set for it here),
// `STUDIO_LUTS_IN_EDITS=1` for the LUTs. Heebo is not among the
// fixtures, so the board's "@he" (three families) and "@heebo" (nine faces) are the unit tests'
// (font-picker.test.ts, over the real 40 families); this spec types the same shapes over what it
// has: Secular One, Bellefair, Varela Round (with Hebrew), Outfit (Regular and Bold) and Oswald.
//
//   opens        "@" opens the picker above the box: Fonts, then LUTs; the first font highlighted with
//                its card; the rows are set in their own font files (loaded into the page)
//   queries      "@ou" is Outfit's two faces and the card says no Hebrew; "@o" is one row per family
//                with the weights on the right; "@luts/ci" is the LUTs alone, as before
//   keys         ↓ ↑ move and wrap (the box keeps the focus), Enter inserts "@Outfit Bold ", Tab too,
//                Esc closes only the picker, the box says what is highlighted
//   mouse        the pointer moves the highlight, a click inserts, the box keeps the focus
//   closed       "@Outfit Bold and bigger", "Make it @Outfit Bold " and "@xyz abc" show no picker
//   Hebrew       "ל-@sec" opens after the hyphen and inserts after it
//   no match     "@Gotham" says so and offers Open Fonts, which leaves for /fonts
//   a sent note  Enter adds the note as typed
//
// CVP-347 (FN14): the "Uses" row under the box and the posted note, in the same run:
//
//   pills        the posted note shows each font as a pill and says what the next edit does with it
//   chips        a chip per font (and LUT) under the box with the font line; hovering opens the
//                card above it (the name in its own file at 22 px), kept inside the dialog; the ×
//                takes the token and one space out of the box and returns the focus to it
//   Hebrew       "ל-@Secular One" has its chip, left to right, in a box that follows the text
//
// Shots go to $E2E_SHOTS when it is set (the work item's hand-off); nothing is written otherwise.

import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { BUILTIN_LUTS } from '../packages/shared/src/domain/luts.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, recordRows, rowOf } from './support/jobs-ui.ts';
import { reviewDialog } from './support/review-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Fonts picker job';
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
  engine = await startEngine({
    settleMs: 2_000,
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

/** The note box of the Review dialog. */
const boxOf = (dialog: Locator): Locator => dialog.getByRole('textbox');

/** The picker's rows. */
const rowsOf = (dialog: Locator): Locator => dialog.getByRole('option');

/** The popover and the small "no match" panel. */
const popoverOf = (dialog: Locator): Locator => dialog.locator('[data-slot="library-picker"]');

/** The title of the row the box says is highlighted: `@Outfit Bold`, `luts/cinematic`. */
async function activeTitle(dialog: Locator): Promise<string | null> {
  const id = await boxOf(dialog).getAttribute('aria-activedescendant');
  if (id === null) return null;
  return dialog.page().locator(`[id="${id}"]`).getAttribute('title');
}

/** The names of the rows, in order (the first line of each: the second is the script or the slug). */
async function rowNames(dialog: Locator): Promise<string[]> {
  return rowsOf(dialog).evaluateAll((rows) =>
    rows.map((row) => (row.children[1] as HTMLElement).innerText),
  );
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The fonts the page has loaded for its specimens (one `fe-<fileId>` family per file). */
function loadedFontFiles(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.fonts].filter((f) => f.family.startsWith('fe-') && f.status === 'loaded').length,
  );
}

test('the @ picker adds a font to a note in Review', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });

  await test.step('the library has its fonts, and a job reaches Review', async () => {
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

    await page.goto(engine.baseURL);
    const whatsNew = page.getByRole('dialog', { name: /What's new/ });
    await whatsNew.waitFor({ timeout: 5_000 }).then(
      () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
      () => {},
    );
    await recordRows(page);
    await engine.createJob({ client: CLIENT, job: JOB });
    const row = rowOf(page, JOB);
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    await action(row, 'Review').click();
    await expect(reviewDialog(page)).toBeVisible();
    await expect(reviewDialog(page).locator('[data-slot="preview-player"]')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 30_000 },
    );
  });

  const dialog = reviewDialog(page);
  const box = boxOf(dialog);
  const popover = popoverOf(dialog);
  const none = dialog.locator('[data-slot="library-picker-none"]');
  const card = popover.locator('[data-slot="library-preview"]');

  await test.step('the box says "@" points at a font, a LUT or a graphic', async () => {
    await expect(box).toHaveAttribute(
      'placeholder',
      'Write a note… type @ to point at a font, a LUT or a graphic',
    );
    await expect(box).toHaveAttribute('dir', 'auto');
    await expect(popover).toHaveCount(0);
    await shot(page, '01-empty');
  });

  await test.step('"@" opens the picker with Fonts and LUTs, the first font highlighted with its card', async () => {
    await box.click();
    await box.pressSequentially('@');
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('listbox', { name: 'Library' })).toBeVisible();
    // Nothing is used yet, so the heading is "Fonts", not "recent": the first five A to Z.
    await expect(popover).toContainText('Fonts');
    await expect(popover).not.toContainText('Fonts · recent');
    await expect(popover).toContainText('LUTs');
    await expect(popover).toContainText('↑ ↓ to move · Enter to add · Esc to close');
    expect(await rowNames(dialog)).toEqual([
      'Bellefair',
      'Oswald',
      'Outfit Bold',
      'Secular One',
      'Varela Round',
      'Cinematic',
      'Film contrast',
      'Golden warm',
    ]);
    expect(await activeTitle(dialog)).toBe('@Bellefair');
    await expect(rowsOf(dialog).first()).toHaveAttribute('aria-selected', 'true');
    await expect(rowsOf(dialog).first()).toContainText('Hebrew + English');
    // Above the box and 574 px wide, as LU8's.
    const popBox = await popover.boundingBox();
    const textBox = await box.boundingBox();
    expect(popBox?.width).toBeCloseTo(574, 0);
    expect((popBox?.y ?? 0) + (popBox?.height ?? 0)).toBeLessThanOrEqual((textBox?.y ?? 0) + 1);
    // The card: the test frame, the name in its own font, the facts.
    await expect(card.locator('[data-slot="font-card-name"]')).toHaveText('Bellefair');
    await expect(card).toContainText('Serif · Hebrew + English');
    await expect(card).toContainText('1 weight · not used yet');
    await expect(card).not.toContainText('No Hebrew letters');
    await expect
      .poll(() =>
        card
          .locator('img')
          .evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0)),
      )
      .toBe(true);
    await expect(
      card.getByRole('img', { name: /The caption on a test frame in Bellefair/ }),
    ).toBeVisible();
    await shot(page, '02-at');
  });

  await test.step('the rows are set in their own font files, which the page has loaded', async () => {
    // Five font rows: five files (the card's own is one of them).
    await expect.poll(() => loadedFontFiles(page), RUN).toBeGreaterThanOrEqual(5);
    const families = await rowsOf(dialog)
      .nth(0)
      .evaluate((row) => getComputedStyle(row.children[1] as HTMLElement).fontFamily);
    expect(families).toMatch(/^fe-[0-9a-f]+/);
    const bold = await rowsOf(dialog)
      .nth(2)
      .evaluate((row) => {
        const name = row.children[1] as HTMLElement;
        const style = getComputedStyle(name);
        return { weight: style.fontWeight, size: style.fontSize, text: name.innerText };
      });
    expect(bold).toEqual({ weight: '700', size: '16px', text: 'Outfit Bold' });
    const heights = await rowsOf(dialog).evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height),
    );
    expect(new Set(heights)).toEqual(new Set([32]));
  });

  await test.step('"@ou" is the two faces of Outfit, and the card says it has no Hebrew', async () => {
    await box.pressSequentially('ou');
    await expect(rowsOf(dialog)).toHaveCount(2);
    expect(await rowNames(dialog)).toEqual(['Outfit', 'Outfit Bold']);
    await expect(rowsOf(dialog).first()).toContainText('English only');
    await expect(popover).not.toContainText('LUTs');
    await expect(card.locator('[data-slot="font-card-name"]')).toHaveText('Outfit');
    await expect(card).toContainText('Sans · English only');
    await expect(card).toContainText('2 weights · not used yet');
    await expect(card).toContainText(
      'No Hebrew letters. Hebrew words stay in the video’s own font.',
    );
    await shot(page, '03-no-hebrew');
  });

  await test.step('↓ ↑ move and wrap, the box keeps the focus and says what is highlighted', async () => {
    expect(await activeTitle(dialog)).toBe('@Outfit');
    await page.keyboard.press('ArrowDown');
    expect(await activeTitle(dialog)).toBe('@Outfit Bold');
    await expect(card.locator('[data-slot="font-card-name"]')).toHaveText('Outfit Bold');
    await page.keyboard.press('ArrowDown'); // wraps to the first
    expect(await activeTitle(dialog)).toBe('@Outfit');
    await page.keyboard.press('ArrowUp'); // and back to the last
    expect(await activeTitle(dialog)).toBe('@Outfit Bold');
    await expect(box).toBeFocused();
    await expect(dialog.locator('[role="status"].sr-only')).toHaveText(
      '2 results. Outfit Bold selected.',
    );
  });

  await test.step('Enter inserts "@Outfit Bold " in place of the query and closes the picker', async () => {
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('@Outfit Bold ');
    await expect(popover).toHaveCount(0);
    await expect(box).toBeFocused();
    // Nothing was posted by Enter, and the caret is at the end: typing goes on from there.
    await expect(dialog).toContainText('No notes yet');
    await box.pressSequentially('for the titles');
    await expect(box).toHaveValue('@Outfit Bold for the titles');
    await expect(popover).toHaveCount(0);
  });

  await test.step('"@o" is one row per family, with how many weights on the right', async () => {
    await box.fill('Make the captions @o');
    await expect(popover).toBeVisible();
    const names = await rowNames(dialog);
    // Oswald and Outfit start with "o" (the most used first, then A to Z), Secular One has "one".
    expect(names.slice(0, 3)).toEqual(['Oswald', 'Outfit', 'Secular One']);
    await expect(rowsOf(dialog).nth(0)).toContainText('1 weight');
    await expect(rowsOf(dialog).nth(1)).toContainText('2 weights');
    await expect(dialog.locator('[role="status"].sr-only')).toHaveText(
      /^\d+ results\. Oswald selected\.$/,
    );
    await shot(page, '04-families');
  });

  await test.step('Tab inserts the family as its Regular: "@Outfit "', async () => {
    await page.keyboard.press('ArrowDown');
    expect(await activeTitle(dialog)).toBe('@Outfit');
    await page.keyboard.press('Tab');
    await expect(box).toHaveValue('Make the captions @Outfit ');
    await expect(popover).toHaveCount(0);
    await expect(box).toBeFocused();
  });

  await test.step('Esc closes only the picker; typing on opens it again', async () => {
    await box.fill('');
    await box.pressSequentially('@');
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('@');
    await expect(box).not.toHaveAttribute('data-picker', 'open');
    await box.pressSequentially('v');
    await expect(popover).toBeVisible();
    expect(await rowNames(dialog)).toEqual(['Varela Round']);
    // Leaving the box closes it, and coming back opens it again.
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(box).not.toBeFocused();
    await expect(dialog).toBeVisible();
    await box.click();
    await expect(popover).toBeVisible();
  });

  await test.step('the pointer moves the highlight and a click inserts, the box keeps the focus', async () => {
    await box.fill('Make it @');
    await expect(popover).toBeVisible();
    const third = rowsOf(dialog).nth(2);
    await third.hover();
    await expect(third).toHaveAttribute('aria-selected', 'true');
    expect(await activeTitle(dialog)).toBe('@Outfit Bold');
    await expect(card.locator('[data-slot="font-card-name"]')).toHaveText('Outfit Bold');
    await third.click();
    await expect(box).toHaveValue('Make it @Outfit Bold ');
    await expect(popover).toHaveCount(0);
    await expect(box).toBeFocused();
  });

  await test.step('it is closed after a complete name, and for a name nothing matches', async () => {
    for (const text of [
      '@Outfit Bold and bigger',
      'Make it @Outfit Bold ',
      '@Outfit ',
      '@xyz abc',
    ]) {
      await box.fill(text);
      await expect(popover, text).toHaveCount(0);
      await expect(none, text).toHaveCount(0);
      await expect(box, text).not.toHaveAttribute('data-picker', 'open');
    }
    // While the name is not finished it stays open, spaces and capitals included.
    await box.fill('@Outfit B');
    await expect(popover).toBeVisible();
    expect(await rowNames(dialog)).toEqual(['Outfit Bold']);
    await box.fill('@OUTFIT   BOLD');
    expect(await rowNames(dialog)).toEqual(['Outfit Bold']);
  });

  await test.step('a Hebrew note opens it after the hyphen, and the insert keeps the Hebrew', async () => {
    await box.fill('תשנה את הכתוביות ל-@sec');
    await expect(popover).toBeVisible();
    expect(await rowNames(dialog)).toEqual(['Secular One']);
    await shot(page, '05-hebrew');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('תשנה את הכתוביות ל-@Secular One ');
    await expect(popover).toHaveCount(0);
  });

  await test.step('"@luts/ci" is the LUTs alone, as before', async () => {
    await box.fill('Make it @luts/ci');
    await expect(popover).toBeVisible();
    await expect(popover).not.toContainText('Fonts');
    expect(await activeTitle(dialog)).toBe('luts/cinematic');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('Make it @luts/cinematic ');
    await expect(popover).toHaveCount(0);
  });

  await test.step('no match: the small panel says so, with the way to Fonts', async () => {
    await box.fill('Make the captions @Gotham');
    await expect(none).toBeVisible();
    await expect(none).toContainText('Nothing in Fonts, LUTs or Graphics is called “Gotham”.');
    // 320 px wide, as board FOReview draws it.
    expect(await none.evaluate((el) => getComputedStyle(el).width)).toBe('320px');
    await expect(none.getByRole('button', { name: 'Open Fonts to import one' })).toBeVisible();
    await expect(box).not.toHaveAttribute('aria-activedescendant', /.+/);
    await shot(page, '06-no-match');
  });

  await test.step('Enter adds the note as it was typed', async () => {
    await box.fill('Make the captions @Outfit Bold and the titles @Secular One ');
    await expect(popover).toHaveCount(0);
    await box.press('Enter');
    await expect(box).toHaveValue('');
    const note = dialog.locator('[data-slot="review-note"]').first();
    await expect(note).toContainText('Make the captions @Outfit Bold and the titles @Secular One');
  });

  await test.step('the posted note shows its fonts as pills and says what the next edit does with each', async () => {
    const note = dialog.locator('[data-slot="review-note"]').first();
    const pills = note.locator('[data-slot="library-token"]');
    await expect(pills).toHaveText(['@Outfit Bold', '@Secular One']);
    await expect(pills.first()).toHaveAttribute('dir', 'ltr');
    await expect(note.locator('p[dir="auto"]').first()).toContainText(
      'Make the captions @Outfit Bold and the titles @Secular One',
    );
    const lines = note.locator('[data-slot="library-note-lines"] p');
    await expect(lines).toHaveText([
      'Saved. The next edit uses Outfit Bold for the captions.',
      'It also uses Secular One for the titles.',
    ]);
    await shot(page, '07-sent');
  });

  await test.step('Open Fonts leaves for the Fonts page in the same tab, and the note stays in the draft', async () => {
    await box.fill('@Gotham');
    await none.getByRole('button', { name: 'Open Fonts to import one' }).click();
    await expect(page).toHaveURL(/\/fonts/);
    await expect(page.getByRole('heading', { name: 'Fonts', level: 1 })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    await action(rowOf(page, JOB), 'Review').click();
    await expect(boxOf(reviewDialog(page))).toHaveValue('@Gotham');
  });

  await test.step('the "Uses" row has a chip per font, and the line about what a font is for', async () => {
    const chips = dialog.locator('[data-slot="library-chip"]');
    await box.fill('Make the captions @Outfit Bold and the titles @Secular One ');
    await expect(popover).toHaveCount(0);
    await expect(dialog.locator('[data-slot="library-uses"]')).toContainText('Uses');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText('@Outfit Bold');
    await expect(chips.nth(1)).toContainText('@Secular One');
    await expect(chips.nth(0)).toHaveAttribute('dir', 'ltr');
    await expect(
      dialog.getByRole('button', { name: 'Remove @Outfit Bold from the note' }),
    ).toBeVisible();
    await expect(dialog.locator('[data-slot="library-uses"]')).toContainText(
      'A font is used for the text the note names, like the captions or the titles. If it names none, for all the text the edit adds.',
    );
    await expect(dialog.locator('[data-slot="library-uses"]')).not.toContainText('A LUT applies');
    // 24 px high, as the board's (computed: the dialog may still be growing into place).
    const chip = chips.nth(0).locator('span').first();
    expect(await chip.evaluate((el) => getComputedStyle(el).height)).toBe('24px');
    await shot(page, '08-chips');
  });

  await test.step('hovering a chip opens its card above it, set in the font, kept inside the dialog', async () => {
    const chips = dialog.locator('[data-slot="library-chip"]');
    const tip = dialog.getByRole('tooltip');
    await expect(tip).toHaveCount(0);
    // Secular One has Hebrew: its name, the Hebrew sample and the facts, nothing about missing letters.
    await chips.nth(1).hover();
    await expect(tip).toBeVisible();
    const name = tip.locator('[data-slot="font-card-name"]');
    await expect(name).toHaveText('Secular One');
    await expect(tip.locator('[lang="he"]')).toHaveText('ככה הכול התחיל');
    await expect(tip).toContainText('Display · Hebrew + English');
    await expect(tip).toContainText('1 weight · not used yet');
    await expect(tip).not.toContainText('No Hebrew letters');
    const style = await name.evaluate((el) => {
      const css = getComputedStyle(el);
      return { family: css.fontFamily, size: css.fontSize };
    });
    expect(style.size).toBe('22px');
    expect(style.family).toMatch(/^fe-[0-9a-f]+/);
    await expect
      .poll(() =>
        name.evaluate((el) => document.fonts.check(`22px ${getComputedStyle(el).fontFamily}`)),
      )
      .toBe(true);
    await shot(page, '09-chip-card');
    // Outfit has none: the card says so, in the same width.
    await chips.nth(0).hover();
    await expect(tip).toHaveCount(1);
    await expect(tip.locator('[data-slot="font-card-name"]')).toHaveText('Outfit Bold');
    await expect(tip).toContainText(
      'No Hebrew letters. Hebrew words stay in the video’s own font.',
    );
    expect(await tip.evaluate((el) => getComputedStyle(el).width)).toBe('252px');
    /** Whether the card's right edge is inside the dialog's (once the dialog has stopped moving). */
    const insideDialog = async () => {
      const [card, shell] = await Promise.all([tip.boundingBox(), dialog.boundingBox()]);
      return (card?.x ?? 0) + (card?.width ?? 0) <= (shell?.x ?? 0) + (shell?.width ?? 0) + 0.5;
    };
    await expect.poll(insideDialog).toBe(true);
    // The last chip is near the dialog's right edge: its card still fits.
    await chips.nth(1).hover();
    await expect(tip.locator('[data-slot="font-card-name"]')).toHaveText('Secular One');
    await expect.poll(insideDialog).toBe(true);
    // Moving off closes it; the focus opens it too.
    await page.mouse.move(5, 5);
    await expect(tip).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Remove @Secular One from the note' }).focus();
    await expect(tip).toBeVisible();
    await expect(tip.locator('[data-slot="font-card-name"]')).toHaveText('Secular One');
  });

  await test.step('the × takes the token and one space out of the text and gives the focus back to the box', async () => {
    const chips = dialog.locator('[data-slot="library-chip"]');
    await dialog.getByRole('button', { name: 'Remove @Outfit Bold from the note' }).click();
    await expect(box).toHaveValue('Make the captions and the titles @Secular One ');
    await expect(box).toBeFocused();
    await expect(chips).toHaveCount(1);
    // The chip that moved under the pointer opens its own card; the removed chip's is gone.
    await page.mouse.move(5, 5);
    await expect(dialog.getByRole('tooltip')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Remove @Secular One from the note' }).click();
    await expect(box).toHaveValue('Make the captions and the titles ');
    await expect(chips).toHaveCount(0);
    await expect(dialog.locator('[data-slot="library-uses"]')).toHaveCount(0);
    await expect(box).toBeFocused();
  });

  await test.step('a Hebrew note has its chip, left to right, and the box follows the text', async () => {
    await box.fill('תשנה את הכתוביות ל-@Secular One ');
    const chips = dialog.locator('[data-slot="library-chip"]');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('@Secular One');
    await expect(chips.first()).toHaveAttribute('dir', 'ltr');
    await expect(box).toHaveAttribute('dir', 'auto');
    await shot(page, '10-hebrew-chip');
    await box.press('Enter');
    const note = dialog
      .locator('[data-slot="review-note"]')
      .filter({ hasText: 'תשנה את הכתוביות' });
    await expect(note.locator('p[dir="auto"]')).toHaveCount(1);
    await expect(note.locator('[data-slot="library-token"]')).toHaveText(['@Secular One']);
    await expect(note.locator('[data-slot="library-token"]')).toHaveAttribute('dir', 'ltr');
    await expect(note.locator('[data-slot="library-note-lines"] p')).toHaveText([
      'Saved. The next edit uses Secular One for the captions.',
    ]);
  });

  await test.step('a font, a LUT and the lines for each kind', async () => {
    await box.fill('Make the captions @Outfit Bold and grade @luts/cinematic ');
    const chips = dialog.locator('[data-slot="library-chip"]');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toContainText('@luts/cinematic');
    const uses = dialog.locator('[data-slot="library-uses"]');
    await expect(uses).toContainText('A font is used for the text the note names');
    await expect(uses).toContainText('A LUT applies to the whole video.');
    await chips.nth(1).hover();
    await expect(dialog.getByRole('tooltip')).toContainText('Cinematic');
    await page.mouse.move(5, 5);
    await dialog.getByRole('button', { name: 'Remove @luts/cinematic from the note' }).click();
    await expect(box).toHaveValue('Make the captions @Outfit Bold and grade ');
    await expect(chips).toHaveCount(1);
  });

  expect(pageErrors).toEqual([]);
});
