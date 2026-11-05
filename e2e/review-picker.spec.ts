// CVP-309 (LU8): the @ picker in Review's note box, on the built server with the fake runner, the
// real LUTs and Graphics routes and the real preview stills (the fake runner's stills are the plain
// test frame, so no ffmpeg is needed). One engine with the LUTs-in-notes switch on
// (`STUDIO_LUTS_IN_EDITS=1`) and the fonts-in-notes switch turned off (`STUDIO_FONTS_IN_NOTES=0`:
// it is on by default since FN23, and this spec is the picker with LUTs and Graphics alone, as
// LU8 built it; the same box with a Fonts group, and the chips and pills written `@luts/...`
// beside the fonts, are e2e/fonts-picker.spec.ts's), a stand-in colour-grade skill of its own so
// this Mac's installed one never decides what the list shows, and one graphic made through the
// real Graphics routes.
//
//   opens        "@" opens the picker above the box: LUTs and Graphics, 4 each, the first LUT
//                highlighted with its before/after; the footer says the keys
//   keys         ↓ ↑ move (the box keeps the focus), Enter inserts "@luts/slug " and closes it, Tab
//                inserts a graphic, Esc closes only the picker (a second Esc leaves the box)
//   mouse        the pointer moves the highlight, a click inserts, the box keeps the focus
//   chips        a "Uses" row with one chip per token that resolves; × removes it from the end, the
//                middle and the only token; a token that points at nothing has no chip
//   no match     @luts/zzz, @graphics/zzz and a bare query each say so; Open LUTs leaves for /luts
//   a sent note  Enter adds the note: the pill and "Saved. The next edit uses …" under it
//
// The shots go to .claude/qa-shots/v0.40.0-lu8/ for the work item's hand-off.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { BUILTIN_LUTS } from '../packages/shared/src/domain/luts.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, recordRows, rowOf } from './support/jobs-ui.ts';
import { reviewDialog } from './support/review-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Picker job';
const RUN = { timeout: 60_000 };
const SHOTS = join(import.meta.dirname, '..', '.claude', 'qa-shots', 'v0.40.0-lu8');

let engine: Engine;
let skillDir: string;
let graphicName = '';

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
  await mkdir(SHOTS, { recursive: true });
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 4,
    env: {
      STUDIO_COLOR_GRADE_DIR: skillDir,
      STUDIO_LUTS_IN_EDITS: '1',
      STUDIO_FONTS_IN_NOTES: '0',
    },
  });
});

test.afterAll(async () => {
  await engine?.stop();
  if (skillDir !== undefined) await rm(skillDir, { recursive: true, force: true });
});

interface GraphicOnServer {
  id: string;
  name: string;
  version: number | null;
}

async function graphics(): Promise<GraphicOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/graphics`)).json()) as GraphicOnServer[];
}

/** The dialog's note box. */
const boxOf = (dialog: Locator): Locator => dialog.getByRole('textbox');

/** The picker's rows, by their slug. */
const rowsOf = (dialog: Locator): Locator => dialog.getByRole('option');

/** The id of the row the box says is highlighted. */
async function activeSlug(dialog: Locator): Promise<string | null> {
  const id = await boxOf(dialog).getAttribute('aria-activedescendant');
  if (id === null) return null;
  return dialog.page().locator(`[id="${id}"]`).getAttribute('title');
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('the @ picker adds a LUT or a graphic to a note in Review', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });

  await test.step('a graphic is made, and a job reaches Review', async () => {
    const form = new FormData();
    form.set('text', 'A white pill with the name');
    const made = await fetch(`${engine.baseURL}/api/graphics`, { method: 'POST', body: form });
    expect(made.status).toBe(201);
    await expect
      .poll(async () => (await graphics()).find((g) => g.version !== null)?.name ?? '', RUN)
      .not.toBe('');
    graphicName = (await graphics()).find((g) => g.version !== null)?.name ?? '';

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
  const popover = dialog.locator('[data-slot="library-picker"]');
  const none = dialog.locator('[data-slot="library-picker-none"]');
  const chips = dialog.locator('[data-slot="library-chip"]');

  await test.step('the box is the board’s empty state', async () => {
    await expect(box).toHaveAttribute(
      'placeholder',
      'Write a note… type @ to point at a LUT or a graphic',
    );
    await expect(popover).toHaveCount(0);
    await expect(chips).toHaveCount(0);
    await shot(page, '01-empty');
  });

  await test.step('"@" opens the picker with LUTs and Graphics, the first LUT highlighted', async () => {
    await box.click();
    await box.pressSequentially('@');
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('listbox', { name: 'Library' })).toBeVisible();
    await expect(popover).toContainText('LUTs');
    await expect(popover).toContainText('Graphics');
    await expect(popover).toContainText('↑ ↓ to move · Enter to add · Esc to close');
    // 4 LUTs and the graphic made above.
    await expect(rowsOf(dialog)).toHaveCount(5);
    expect(await activeSlug(dialog)).toBe('luts/cinematic');
    await expect(rowsOf(dialog).first()).toHaveAttribute('aria-selected', 'true');
    // The right pane: the frame before and after, the name and the meta line.
    await expect(popover).toContainText('Film contrast plus a light golden warmth.');
    await expect(popover).toContainText('Look · built in');
    // Above the box, and wider than the notes column (574 px against 360).
    const popBox = await popover.boundingBox();
    const textBox = await box.boundingBox();
    expect(popBox?.width).toBeCloseTo(574, 0);
    expect((popBox?.y ?? 0) + (popBox?.height ?? 0)).toBeLessThanOrEqual((textBox?.y ?? 0) + 1);
    expect(popBox?.x ?? 0).toBeLessThan(textBox?.x ?? 0);
    await shot(page, '02-at');
  });

  await test.step('↓ ↑ move the highlight and the box keeps the focus', async () => {
    await page.keyboard.press('ArrowDown');
    expect(await activeSlug(dialog)).toBe('luts/film-contrast');
    await expect(popover).toContainText('Deeper shadows and rolled highlights.');
    // The frame before and after, the real stills of the LUTs page (the Cinematic look's are baked
    // by the real colour grade, which this stand-in skill does not have: its card shows the text only).
    await expect(
      popover.getByRole('img', { name: /Before and after: Film contrast/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        popover
          .locator('[data-slot="library-split-frame"] img')
          .evaluateAll(
            (imgs) =>
              imgs.length === 2 && imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0),
          ),
      )
      .toBe(true);
    await shot(page, '02b-lut-highlighted');
    await page.keyboard.press('ArrowUp');
    expect(await activeSlug(dialog)).toBe('luts/cinematic');
    await page.keyboard.press('ArrowUp'); // wraps to the last row: the graphic
    expect(await activeSlug(dialog)).toMatch(/^graphics\//);
    await expect(popover).toContainText('Placed at 0:00');
    await expect(box).toBeFocused();
    await shot(page, '03-graphic-highlighted');
    await page.keyboard.press('ArrowDown');
    expect(await activeSlug(dialog)).toBe('luts/cinematic');
  });

  await test.step('Enter inserts "@luts/slug " and the Uses row shows the chip', async () => {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('@luts/film-contrast ');
    await expect(popover).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('luts/film-contrast');
    await expect(dialog).toContainText('A LUT applies to the whole video.');
    await expect(
      dialog.getByRole('button', { name: 'Remove luts/film-contrast from the note' }),
    ).toBeVisible();
    // Nothing was posted by Enter.
    await expect(dialog).toContainText('No notes yet');
  });

  await test.step('hovering a chip shows the same card as a tooltip above it', async () => {
    // The chip appeared under a pointer that has not moved: a browser sends no hover for that.
    await page.mouse.move(5, 5);
    await chips.first().hover();
    const tip = dialog.getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Film contrast');
    await expect(tip).toContainText('Look · built in');
    await expect(tip.getByRole('img', { name: /Before and after: Film contrast/ })).toBeVisible();
    await expect
      .poll(() =>
        tip
          .locator('img')
          .evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0)),
      )
      .toBe(true);
    await shot(page, '04-chip-tooltip');
    await page.mouse.move(10, 10);
    await expect(tip).toHaveCount(0);
  });

  await test.step('Tab inserts a graphic, and the Uses row says where it goes', async () => {
    await box.click();
    await box.press('End');
    await box.pressSequentially('and @graphics/');
    await expect(popover).toBeVisible();
    // Only the graphics, no LUT group.
    await expect(popover).not.toContainText('LUTs');
    await expect(rowsOf(dialog)).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(box).toHaveValue(/^@luts\/film-contrast and @graphics\/[a-z0-9-]+ $/);
    await expect(box).toBeFocused();
    await expect(chips).toHaveCount(2);
    await expect(dialog).toContainText('A graphic is placed at 0:00.');
    await shot(page, '05-two-chips');
  });

  await test.step('× removes the LUT from the start, the graphic from the end, then the only one', async () => {
    const value = await box.inputValue();
    const slug = /@graphics\/([a-z0-9-]+)/.exec(value)?.[1] ?? '';
    // From the middle of the note: the LUT is first, followed by text and a graphic.
    await dialog.getByRole('button', { name: 'Remove luts/film-contrast from the note' }).click();
    await expect(box).toHaveValue(`and @graphics/${slug} `);
    await expect(box).toBeFocused();
    await expect(chips).toHaveCount(1);
    // From the end.
    await dialog.getByRole('button', { name: `Remove graphics/${slug} from the note` }).click();
    await expect(box).toHaveValue('and ');
    await expect(chips).toHaveCount(0);
    // The only token.
    await box.fill('@luts/cinematic');
    await expect(chips).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Remove luts/cinematic from the note' }).click();
    await expect(box).toHaveValue('');
    await expect(chips).toHaveCount(0);
  });

  await test.step('Esc closes only the picker; a second Esc leaves the box', async () => {
    await box.fill('');
    await box.pressSequentially('@');
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('@');
    // Typing on re-opens it.
    await box.pressSequentially('c');
    await expect(popover).toBeVisible();
    await expect(rowsOf(dialog).first()).toContainText('Cinematic');
    // Esc, then leaving the box, then coming back: it opens again on focus.
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
    expect(await activeSlug(dialog)).toBe('luts/golden-warm');
    await expect(popover).toContainText('A strong golden-hour warmth.');
    await third.click();
    await expect(box).toHaveValue('Make it @luts/golden-warm ');
    await expect(box).toBeFocused();
    await expect(chips).toHaveCount(1);
  });

  await test.step('a token that points at nothing has no chip', async () => {
    await box.fill('Make it @luts/golden-warm and @luts/zzz and @graphics/nope ');
    await expect(popover).toHaveCount(0);
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('luts/golden-warm');
  });

  await test.step('no match: the small panel says so, with the way to the page', async () => {
    await box.fill('Make it @luts/zzz');
    await expect(none).toBeVisible();
    await expect(none).toContainText('No LUT called “zzz”.');
    await expect(none.getByRole('button', { name: 'Open LUTs to import one' })).toBeVisible();
    await expect(box).not.toHaveAttribute('aria-activedescendant', /.+/);
    await shot(page, '06-no-lut');
    await box.fill('@graphics/zzz');
    await expect(none).toContainText('No graphic called “zzz”.');
    await expect(none.getByRole('button', { name: 'Open Graphics to add one' })).toBeVisible();
    await box.fill('@qqq');
    await expect(none).toContainText('Nothing in LUTs or Graphics is called “qqq”.');
    await expect(none.getByRole('button')).toHaveCount(0);
  });

  await test.step('Enter adds the note; it is shown with pills and what the next edit does', async () => {
    await box.fill(`Make it @luts/cinematic and put @graphics/${graphicSlug()} here `);
    await expect(chips).toHaveCount(2);
    await box.press('Enter');
    await expect(box).toHaveValue('');
    const note = dialog.locator('[data-slot="review-note"]').first();
    await expect(note.locator('[data-slot="library-token"]')).toHaveCount(2);
    await expect(note.locator('[data-slot="library-token"]').first()).toHaveText('luts/cinematic');
    await expect(note).toContainText('Saved. The next edit uses Cinematic on the whole video.');
    await expect(note).toContainText(`It also places ${graphicName} at 0:00.`);
    await shot(page, '07-sent-note');
  });

  await test.step('the no-match button leaves for the LUTs page in the same tab', async () => {
    await box.fill('@luts/zzz');
    await none.getByRole('button', { name: 'Open LUTs to import one' }).click();
    await expect(page).toHaveURL(/\/luts/);
    await expect(page.getByRole('heading', { name: 'LUTs', level: 1 })).toBeVisible();
    // The note is kept in the draft: back on Jobs and into the dialog, it is still there.
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    await action(rowOf(page, JOB), 'Review').click();
    await expect(boxOf(reviewDialog(page))).toHaveValue('@luts/zzz');
  });

  expect(pageErrors).toEqual([]);
});

/** The slug of the graphic made above, as a note writes it. */
function graphicSlug(): string {
  return graphicName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
