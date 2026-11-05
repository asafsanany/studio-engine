// CVP-313 (LU12): the @ picker in the "Note for the editor" dialog (the Brief's notes box), on the
// built server with the fake runner, the real LUTs and Graphics routes and a stand-in colour-grade
// skill, with the LUTs-in-notes switch on (`STUDIO_LUTS_IN_EDITS=1`) and the fonts-in-notes switch
// turned off (`STUDIO_FONTS_IN_NOTES=0`: it is on by default since FN23, and this spec is the
// dialog's picker with LUTs and Graphics alone, as LU12 built it; the same dialog with fonts is
// e2e/fonts-notes-boxes.spec.ts's).
//
//   the box     "@" opens the picker above the box; a graphic says "Placed where it fits." (a note
//               for the editor has no time); Enter inserts, the Uses row shows the chips with
//               "A LUT applies to the whole video." and "A graphic is placed where it fits."; Esc
//               closes only the picker, × removes a chip
//   the run     Save keeps the note as typed; the job sheet's note shows the token as a chip; the
//               first edit run is told about the LUT (the fake runner writes edit/library-refs.json)
//               and brief.md holds the note word for word
//
// The shots go to <repo>/.local/qa-shots/v0.40.6-lu12/ for the work item's hand-off.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { BUILTIN_LUTS } from '../packages/shared/src/domain/luts.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { badge, chooseFromRowMenu, noteDialog, rowOf } from './support/jobs-ui.ts';
import { openApp, openSheetByClick, sheetOf } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Note picker job';
const RUN = { timeout: 60_000 };
const SHOTS = join(import.meta.dirname, '..', '.local', 'qa-shots', 'v0.40.6-lu12');

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
  await mkdir(SHOTS, { recursive: true });
  // A long settle time: the job stays "Arriving" while the note is written.
  engine = await startEngine({
    settleMs: 12_000,
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

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('the @ picker in the note dialog, the chip in the sheet, the LUT in the first edit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await openApp(page, engine.baseURL);

  await test.step('a graphic is made through the real Graphics routes', async () => {
    const form = new FormData();
    form.set('text', 'A white pill with the name');
    const made = await fetch(`${engine.baseURL}/api/graphics`, { method: 'POST', body: form });
    expect(made.status).toBe(201);
    await expect
      .poll(async () => {
        const list = (await (await fetch(`${engine.baseURL}/api/graphics`)).json()) as {
          version: number | null;
        }[];
        return list.some((g) => g.version !== null);
      }, RUN)
      .toBe(true);
  });

  const row = rowOf(page, JOB);
  const dialog = noteDialog(page);
  const box = dialog.getByRole('textbox', { name: 'Note' });
  const popover = dialog.locator('[data-slot="library-picker"]');
  const chips = dialog.locator('[data-slot="library-chip"]');

  await test.step('a job arrives and Add note… opens the dialog with the picker on', async () => {
    await engine.createJob({ client: CLIENT, job: JOB });
    await expect(badge(row, 'Arriving')).toBeVisible(RUN);
    await chooseFromRowMenu(page, row, 'Add note…');
    await expect(dialog).toBeVisible();
    await expect(box).toBeFocused();
    await expect(box).toHaveAttribute(
      'placeholder',
      'e.g. Keep it under 30 seconds. Type @ to point at a LUT or a graphic.',
    );
    await expect(popover).toHaveCount(0);
    await shot(page, '01-dialog');
  });

  await test.step('"@" opens the picker; a graphic is placed where it fits', async () => {
    await box.pressSequentially('Warm and calm. @');
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('listbox', { name: 'Library' })).toBeVisible();
    await expect(popover).toContainText('LUTs');
    await expect(popover).toContainText('Graphics');
    await expect(popover).toContainText('Look · built in');
    await shot(page, '02-at');
    // The popover stays on the screen: not above the top, not past the sides.
    const where = await popover.boundingBox();
    expect(where?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect(where?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((where?.x ?? 0) + (where?.width ?? 0)).toBeLessThanOrEqual(1440);
    expect((where?.y ?? 0) + (where?.height ?? 0)).toBeLessThanOrEqual(900);
    // The last row is the graphic (↑ wraps): its card has no time.
    await page.keyboard.press('ArrowUp');
    await expect(popover).toContainText('Placed where it fits.');
    await expect(popover).not.toContainText('Placed at');
    await shot(page, '03-graphic');
    await page.keyboard.press('ArrowDown');
  });

  await test.step('Esc closes only the picker; the dialog stays', async () => {
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(box).toBeFocused();
    // Typing on opens it again.
    await box.press('Backspace');
    await box.pressSequentially('@');
    await expect(popover).toBeVisible();
  });

  await test.step('typing narrows the list; Enter inserts the LUT and the Uses row shows the chip', async () => {
    await box.pressSequentially('luts/film-con');
    await expect(popover.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('Warm and calm. @luts/film-contrast ');
    await expect(popover).toHaveCount(0);
    await expect(chips).toHaveCount(1);
    await expect(dialog).toContainText('A LUT applies to the whole video.');
    await expect(dialog).not.toContainText('A graphic is placed');
    // Enter did not save or close.
    await expect(dialog).toBeVisible();
  });

  await test.step('Tab inserts a graphic; the Uses row says it is placed where it fits', async () => {
    await box.pressSequentially('and @graphics/');
    await expect(popover).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(box).toHaveValue(
      /^Warm and calm\. @luts\/film-contrast and @graphics\/[a-z0-9-]+ $/,
    );
    await expect(chips).toHaveCount(2);
    await expect(dialog).toContainText('A graphic is placed where it fits.');
    await expect(dialog).not.toContainText('placed at');
    await shot(page, '04-two-chips');
  });

  await test.step('a chip’s card has no time either', async () => {
    await page.mouse.move(5, 5);
    await chips.nth(1).hover();
    const tip = dialog.getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Placed where it fits.');
    await shot(page, '05-chip-tooltip');
    await page.mouse.move(5, 5);
  });

  await test.step('× takes the graphic out of the note', async () => {
    const graphicChip = chips.nth(1);
    const token = (await graphicChip.getAttribute('data-token')) ?? '';
    expect(token).toMatch(/^graphics\//);
    await dialog.getByRole('button', { name: `Remove ${token} from the note` }).click();
    await expect(box).toHaveValue('Warm and calm. @luts/film-contrast and ');
    await expect(chips).toHaveCount(1);
  });

  await test.step('Save keeps the note as typed', async () => {
    await box.fill('Warm and calm. @luts/film-contrast and @luts/zzz-gone');
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
      .toBe('Warm and calm. @luts/film-contrast and @luts/zzz-gone');
  });

  await test.step('the job sheet shows the LUT as a chip, and the unknown token stays text', async () => {
    await openSheetByClick(page, row);
    const noteRow = sheetOf(page).locator('[data-slot="note-row"]');
    await expect(noteRow).toContainText('Warm and calm.');
    const pills = noteRow.locator('[data-slot="library-token"]');
    await expect(pills).toHaveCount(1);
    await expect(pills.first()).toHaveText('luts/film-contrast');
    await expect(noteRow).toContainText('@luts/zzz-gone');
    await page.waitForTimeout(450); // the sheet slides in over 200 ms
    await shot(page, '06-sheet');
  });

  await test.step('the first edit is told about the LUT, and brief.md holds the note word for word', async () => {
    await expect(badge(row, 'Review')).toBeVisible({ timeout: 120_000 });
    const editDir = join(engine.inbox, CLIENT, JOB, 'edit');
    const refs = JSON.parse(await readFile(join(editDir, 'library-refs.json'), 'utf8')) as {
      luts: { slug: string; path: string }[];
      missing: { library: string; slug: string; reason: string }[];
    };
    expect(refs.luts.map((lut) => lut.slug)).toEqual(['film-contrast']);
    expect(refs.missing).toEqual([{ library: 'luts', slug: 'zzz-gone', reason: 'notInLibrary' }]);
    expect(await readFile(join(editDir, 'luts', 'film-contrast.cube'), 'utf8')).toContain(
      'LUT_3D_SIZE 5',
    );
    const brief = await readFile(join(editDir, 'brief.md'), 'utf8');
    expect(brief).toContain(
      '## the owner’s note (word for word; it wins)\nWarm and calm. @luts/film-contrast and @luts/zzz-gone\n',
    );
  });

  expect(pageErrors).toEqual([]);
});
