// CVP-312 (LU11): the look on the paused frame in Review, on the built server with the fake runner
// (its frames are the LUTs page's test photo, so no ffmpeg is needed), the real LUTs routes and
// `STUDIO_LUTS_IN_EDITS=1`, in a real Chrome at 1440×900.
//
//   shows      a note that names a LUT, with the video paused: the frame with the look, the pill
//              "Previewing luts/film-contrast" at the bottom left and a ghost Compare button
//   compare    holding it (mouse or Space) shows the plain frame; letting go brings the look back; the
//              video does not start and the note box keeps its focus
//   hides      playing hides it; seeking hides it and the new pause shows the new frame; taking the
//              token out hides it
//   several    two LUTs named: the pill says "Previewing the last of 2" and previews the last
//   none       a Camera LUT and a token that points at nothing: no still, no pill
//   fails      a frame the server cannot make shows nothing, and the note is still added
//   picker     the @ picker previews its LUTs on the video's own frame, and on the test frame when
//              that frame is not there
//
// The shots go to .local/qa-shots/v0.40.6-lu11/ (not committed) for the work item's hand-off.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, type Route, test } from '@playwright/test';
import { BUILTIN_LUTS } from '../packages/shared/src/domain/luts.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, recordRows, rowOf } from './support/jobs-ui.ts';
import { reviewDialog, seekTo } from './support/review-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Look job';
const RUN = { timeout: 60_000 };
const SHOTS = join(import.meta.dirname, '..', '.local', 'qa-shots', 'v0.40.6-lu11');

/** Every frame request of the paused-frame look. */
const FRAME_ROUTE = (url: URL) => url.pathname.endsWith('/review/frame');

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
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 4,
    env: { STUDIO_COLOR_GRADE_DIR: skillDir, STUDIO_LUTS_IN_EDITS: '1' },
  });
});

test.afterAll(async () => {
  await engine?.stop();
  if (skillDir !== undefined) await rm(skillDir, { recursive: true, force: true });
});

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Whether every picture in `scope` has loaded. */
const loaded = (scope: Locator) =>
  scope
    .locator('img')
    .evaluateAll(
      (imgs) => imgs.length > 0 && imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0),
    );

test('the paused frame shows the look a note names, with Compare', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });

  await test.step('a job reaches Review and its dialog opens', async () => {
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
  const box = dialog.getByRole('textbox');
  const look = dialog.locator('[data-slot="paused-look"]');
  const pill = dialog.locator('[data-slot="paused-look-pill"]');
  const compare = pill.getByRole('button', { name: 'Compare' });
  const lutFrame = look.locator('img').nth(1);
  const playButton = dialog.getByRole('button', { name: 'Play', exact: true });
  const pauseButton = dialog.getByRole('button', { name: 'Pause', exact: true });
  /** A click on the video that is away from the pill. */
  const clickVideo = () =>
    dialog.locator('[data-slot="preview-stage"] > div').click({ position: { x: 150, y: 120 } });
  const opacityOf = (image: Locator) => image.evaluate((img) => getComputedStyle(img).opacity);

  await test.step('without a LUT in the note there is no still', async () => {
    await box.click();
    await box.pressSequentially('Make it warmer');
    await expect(look).toHaveCount(0);
  });

  await test.step('naming a LUT shows the frame with the look, the pill and Compare', async () => {
    await box.fill('Make it @luts/film-contrast ');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Previewing luts/film-contrast');
    await expect(compare).toBeVisible();
    await expect(look.locator('img')).toHaveCount(2);
    await expect.poll(() => loaded(look)).toBe(true);
    await expect(lutFrame).toHaveAttribute('src', /\/review\/frame\?t=0&lut=film-contrast/);
    // The same box and size as the video.
    const stage = await dialog.locator('[data-slot="preview-stage"] > div').boundingBox();
    const still = await look.boundingBox();
    expect(still?.width).toBeCloseTo(stage?.width ?? 0, 0);
    expect(still?.height).toBeCloseTo(stage?.height ?? 0, 0);
    // The pill is at the bottom left, 10 px in.
    const pillBox = await pill.boundingBox();
    expect((pillBox?.x ?? 0) - (still?.x ?? 0)).toBeCloseTo(10, 0);
    expect(
      (still?.y ?? 0) + (still?.height ?? 0) - ((pillBox?.y ?? 0) + (pillBox?.height ?? 0)),
    ).toBeCloseTo(10, 0);
    expect(pillBox?.height).toBeCloseTo(34, 0);
    await expect(box).toBeFocused();
    await shot(page, '01-look-on-the-paused-frame');
  });

  await test.step('holding Compare with the mouse shows the plain frame, letting go brings the look back', async () => {
    await compare.hover();
    await page.mouse.down();
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => opacityOf(lutFrame)).toBe('0');
    // A mouse press on Compare does not take the focus from the note box, nor start the video.
    await expect(box).toBeFocused();
    await expect(playButton).toBeVisible();
    await shot(page, '02-compare-held');
    await page.mouse.up();
    await expect(compare).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => opacityOf(lutFrame)).toBe('1');
    // Leaving the button while it is held lets go too.
    await page.mouse.down();
    await expect.poll(() => opacityOf(lutFrame)).toBe('0');
    await page.mouse.move(5, 5);
    await expect.poll(() => opacityOf(lutFrame)).toBe('1');
    await page.mouse.up();
    await expect(pill).toBeVisible();
  });

  await test.step('Space and Enter hold it too, without playing the video', async () => {
    await compare.focus();
    await page.keyboard.down(' ');
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => opacityOf(lutFrame)).toBe('0');
    await page.keyboard.up(' ');
    await expect(compare).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => opacityOf(lutFrame)).toBe('1');
    await page.keyboard.down('Enter');
    await expect.poll(() => opacityOf(lutFrame)).toBe('0');
    await page.keyboard.up('Enter');
    await expect.poll(() => opacityOf(lutFrame)).toBe('1');
    // Space was Compare's, not play/pause's.
    await expect(playButton).toBeVisible();
    await expect(pauseButton).toHaveCount(0);
  });

  await test.step('playing hides the still; pausing brings it back', async () => {
    await clickVideo();
    await expect(pauseButton).toBeVisible();
    await expect(look).toHaveCount(0);
    await clickVideo();
    await expect(playButton).toBeVisible();
    await expect(pill).toBeVisible();
    await expect.poll(() => loaded(look)).toBe(true);
  });

  await test.step('seeking hides it, and the new pause shows the frame of the new moment', async () => {
    await seekTo(page, dialog, 3);
    await expect(pill).toBeVisible();
    await expect(lutFrame).toHaveAttribute('src', /\/review\/frame\?t=3&lut=film-contrast/);
    await expect.poll(() => loaded(look)).toBe(true);
    await shot(page, '03-paused-at-3s');
    await seekTo(page, dialog, 5);
    await expect(lutFrame).toHaveAttribute('src', /\/review\/frame\?t=5&lut=film-contrast/);
  });

  await test.step('taking the token out hides it', async () => {
    await box.fill('Make it warmer');
    await expect(look).toHaveCount(0);
    await box.fill('Make it @luts/film-contrast ');
    await expect(pill).toBeVisible();
    // Fonts are in the notes by default (FN23), so the chip writes the LUT as `@luts/film-contrast`.
    await dialog.getByRole('button', { name: 'Remove @luts/film-contrast from the note' }).click();
    await expect(box).toHaveValue('Make it ');
    await expect(look).toHaveCount(0);
  });

  await test.step('several LUTs: the pill says so and the last one named is previewed', async () => {
    await box.fill('@luts/film-contrast and @luts/golden-warm ');
    await expect(pill).toContainText('Previewing the last of 2');
    await expect(lutFrame).toHaveAttribute('src', /lut=golden-warm/);
    await shot(page, '04-the-last-of-2');
    // The same LUT named twice is one.
    await box.fill('@luts/golden-warm and @luts/golden-warm ');
    await expect(pill).toContainText('Previewing luts/golden-warm');
  });

  await test.step('a Camera LUT and a token that points at nothing get no still and no pill', async () => {
    await box.fill('Use @luts/s-gamut3-to-cine ');
    await expect(look).toHaveCount(0);
    await box.fill('Use @luts/zzz ');
    await expect(look).toHaveCount(0);
    await box.fill('@luts/golden-warm and @luts/zzz ');
    await expect(pill).toContainText('Previewing luts/golden-warm');
  });

  await test.step('the server answers 422 for a Camera LUT and 404 for a plain frame of nothing', async () => {
    const jobs = (await (await page.request.get(`${engine.baseURL}/api/jobs`)).json()) as {
      id: string;
      name: string;
    }[];
    const id = jobs.find((job) => job.name === JOB)?.id ?? '';
    const camera = await page.request.get(
      `${engine.baseURL}/api/jobs/${id}/review/frame?t=1&lut=s-gamut3-to-cine`,
    );
    expect(camera.status()).toBe(422);
    expect(await camera.json()).toEqual({ error: 'That LUT cannot be previewed.' });
    const unknown = await page.request.get(`${engine.baseURL}/api/jobs/nope/review/frame?t=1`);
    expect(unknown.status()).toBe(404);
    const plain = await page.request.get(`${engine.baseURL}/api/jobs/${id}/review/frame?t=1`);
    expect(plain.status()).toBe(200);
    expect(plain.headers()['content-type']).toBe('image/jpeg');
  });

  await test.step('a frame the server cannot make shows nothing, and the note is still added', async () => {
    const fail = (route: Route) =>
      route.fulfill({ status: 500, json: { error: 'The frame could not be made.' } });
    await page.route(FRAME_ROUTE, fail);
    await seekTo(page, dialog, 4);
    await box.click();
    await box.fill('Make it @luts/film-contrast ');
    // Nothing of the still, not even a pill; the player is as ever.
    await expect(pill).toHaveCount(0);
    await expect(look.locator('img')).toHaveCount(0);
    await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
      'data-status',
      'ready',
    );
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Make it @luts/film-contrast').first()).toBeVisible();
    await expect(box).toHaveValue('');
    await page.unroute(FRAME_ROUTE, fail);
  });

  await test.step('the @ picker previews its LUTs on the video’s own frame', async () => {
    await seekTo(page, dialog, 2);
    await box.click();
    await box.fill('Make it @');
    const popover = dialog.locator('[data-slot="library-picker"]');
    await expect(popover).toBeVisible();
    await page.keyboard.press('ArrowDown'); // Film contrast: a file, not the baked Cinematic look
    const frames = popover.locator('[data-slot="library-split-frame"] img');
    await expect(frames).toHaveCount(2);
    await expect(frames.nth(0)).toHaveAttribute(
      'src',
      /\/api\/jobs\/[^/]+\/review\/frame\?t=2(&|$)/,
    );
    await expect(frames.nth(0)).not.toHaveAttribute('src', /lut=/);
    await expect(frames.nth(1)).toHaveAttribute('src', /review\/frame\?t=2&lut=film-contrast/);
    await expect
      .poll(() => loaded(popover.locator('[data-slot="library-split-frame"]')))
      .toBe(true);
    await shot(page, '05-picker-on-the-video-frame');
    await page.keyboard.press('Escape');
    await box.fill('');
  });

  await test.step('the picker keeps the test frame when the video’s frame is not there', async () => {
    const notYet = (route: Route) =>
      route.fulfill({ status: 404, json: { error: 'The preview video is still being made.' } });
    await page.route(FRAME_ROUTE, notYet);
    await seekTo(page, dialog, 1);
    await box.click();
    await box.fill('Make it @');
    const popover = dialog.locator('[data-slot="library-picker"]');
    await expect(popover).toBeVisible();
    await page.keyboard.press('ArrowDown');
    const frames = popover.locator('[data-slot="library-split-frame"] img');
    await expect(frames).toHaveCount(2);
    await expect(frames.nth(0)).toHaveAttribute(
      'src',
      /\/api\/luts\/[^/]+\/preview\/person\/before\.jpg/,
    );
    await expect(frames.nth(1)).toHaveAttribute(
      'src',
      /\/api\/luts\/film-contrast\/preview\/person\/after\.jpg/,
    );
    await page.keyboard.press('Escape');
    await box.fill('');
    await page.unroute(FRAME_ROUTE, notYet);
  });

  await test.step('the frames came quickly', async () => {
    const times = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/review/frame'))
        .map((entry) => Math.round(entry.duration)),
    );
    expect(times.length).toBeGreaterThan(3);
    // The fake maker copies a file: this is the route and the browser, not ffmpeg.
    expect(Math.max(...times)).toBeLessThan(1500);
  });

  expect(pageErrors).toEqual([]);
});

test('with lutsInEdits off the Review player has no still and asks the server for no frame', async ({
  page,
}) => {
  const off = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 4,
    env: { STUDIO_LUTS_IN_EDITS: '0' },
  });
  try {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/review/frame')) requests.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(off.baseURL);
    const whatsNew = page.getByRole('dialog', { name: /What's new/ });
    await whatsNew.waitFor({ timeout: 5_000 }).then(
      () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
      () => {},
    );
    await recordRows(page);
    await off.createJob({ client: CLIENT, job: 'Plain job' });
    const row = rowOf(page, 'Plain job');
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    await action(row, 'Review').click();
    const dialog = reviewDialog(page);
    await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
      'data-status',
      'ready',
      {
        timeout: 30_000,
      },
    );
    const box = dialog.getByRole('textbox');
    await box.click();
    await box.fill('Make it @luts/cinematic ');
    await page.waitForTimeout(800);
    await expect(dialog.locator('[data-slot="paused-look"]')).toHaveCount(0);
    expect(requests).toEqual([]);
    const jobs = (await (await page.request.get(`${off.baseURL}/api/jobs`)).json()) as {
      id: string;
    }[];
    const res = await page.request.get(`${off.baseURL}/api/jobs/${jobs[0]?.id}/review/frame?t=1`);
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'LUTs are off.' });
  } finally {
    await off.stop();
  }
});
