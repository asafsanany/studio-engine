// CVP-352 (FN19): the live font preview in Review's player, on the built server with the fake
// runner, the real Fonts routes over six small real font files (fixtures/fonts/) and a real browser.
// One engine with the fonts-in-notes switch at its default (on since FN23), one with it turned off
// (`STUDIO_FONTS_IN_NOTES=0`).
//
// The fake runner's sample composition has a root-level #title and no captions, so the spec
// writes its own into a job's edit/preview/ before the dialog opens (what a new edit makes, with
// the marks preview-finish.md asks for) and leaves the other job as an older one:
//
//   marked job   a captions sub-composition (data-track-kind="captions") and a title that has
//                data-timeline-role="title" and a name nobody could guess
//   older job    the sample as it is: a #title with no mark, no captions at all
//
//   one font     "Make the captions @Secular One": the captions are set in the font's own file
//                (family `__studio_font_captions_…` first, the video's own stack after it), the
//                titles are not, and the pill says "Previewing @Secular One". The text keeps the
//                weight the video gave it (C51): the font's own weight is held by its @font-face
//   Compare      held with the mouse (the note box keeps the focus) or with Space (the video does
//                not play or pause), it shows the video as it is; let go, the font is back
//   two fonts    the titles in another font: "Previewing 2 fonts", each text in its own
//   playing      the video plays on in the font; taking a chip's token out ends that preview at once
//   Hebrew       "ל-@Outfit Bold": the English words are in Outfit, the Hebrew stays in the video's font
//                and in the weight the video gave it (C51: it is measured, with and without Compare)
//   older job    its title is found by its name; captions it has none of show nothing, with no error
//   switch off   with fontsInNotes off the same note changes nothing in the player's page
//
// A job's own files are never written by the preview: the spec reads edit/preview/index.html back.
// Shots go to $E2E_SHOTS when it is set (the work item's hand-off); nothing is written otherwise.

import { copyFile, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, recordRows, rowOf } from './support/jobs-ui.ts';
import { reviewDialog } from './support/review-ui.ts';

const CLIENT = 'Acme';
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
let engineOff: Engine;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 4,
  });
  engineOff = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 4,
    env: { STUDIO_FONTS_IN_NOTES: '0' },
  });
});

test.afterAll(async () => {
  await engine?.stop();
  await engineOff?.stop();
});

/** Into the library the way Finder does: files that are two days old, so none is "New". */
async function fillLibrary(target: Engine): Promise<void> {
  const old = new Date(Date.now() - 2 * DAY_MS);
  for (const spec of LIBRARY) {
    const folder = join(target.inbox, '_Fonts', spec.folder, spec.family);
    await mkdir(folder, { recursive: true });
    const to = join(folder, spec.file);
    await copyFile(join(FIXTURES, spec.file), to);
    await utimes(to, old, old);
  }
  await expect
    .poll(async () => {
      const list = (await (await fetch(`${target.baseURL}/api/fonts`)).json()) as {
        catalog: unknown[];
      };
      return list.catalog.length;
    }, RUN)
    .toBe(6);
}

/** The captions of a job made as the prompt asks: a sub-composition whose host says what it is. */
const CAPTIONS = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /></head>
  <body>
    <template>
      <style>
        #captions-root { position: absolute; inset: 0; }
        #captions-root .cap {
          position: absolute; left: 80px; right: 80px; bottom: 420px; opacity: 1; text-align: center;
          font: 300 64px/1.2 "Noto Sans Hebrew", sans-serif; color: #fff; unicode-bidi: plaintext;
        }
      </style>
      <div id="captions-root" data-composition-id="captions" data-width="1080" data-height="1920">
        <div class="cap" id="cap1" dir="auto">עריכה Smart Edit וגם מצוין</div>
      </div>
      <script>
        (() => {
          const tl = gsap.timeline({ paused: true });
          tl.to("#cap1", { opacity: 1, duration: 0.1 }, 0);
          window.__timelines["captions"] = tl;
        })();
      </script>
    </template>
  </body>
</html>
`;

/** Makes a job's preview what a new edit makes: captions, and a title with the mark. */
async function markPreview(jobDir: string): Promise<string> {
  const dir = join(jobDir, 'edit', 'preview');
  const file = join(dir, 'index.html');
  const html = await readFile(file, 'utf8');
  const marked = html
    .replace('<div id="title" dir="auto">', '<div id="hero" dir="auto" data-timeline-role="title">')
    .replace('#title {', '#hero {')
    .replaceAll('"#title"', '"#hero"')
    .replace(
      '<div id="progress"></div>',
      '<div id="captions-host" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="6" data-track-index="3" data-width="1080" data-height="1920" data-track-kind="captions"></div>\n      <div id="progress"></div>',
    );
  expect(marked).toContain('data-timeline-role="title"');
  expect(marked).toContain('data-track-kind="captions"');
  // The video's own Hebrew font, in two weights that are two different files (C51: with the
  // system's one, a weight that moved to the Hebrew letters could not be told from one that did
  // not): Light is Varela Round, Bold is Secular One, both with the Hebrew letters.
  await mkdir(join(dir, 'fonts'), { recursive: true });
  await copyFile(join(FIXTURES, 'VarelaRound-Regular.ttf'), join(dir, 'fonts', 'own-light.ttf'));
  await copyFile(join(FIXTURES, 'SecularOne-Regular.ttf'), join(dir, 'fonts', 'own-bold.ttf'));
  const withFonts = marked.replace(
    '</head>',
    '<style>@font-face{font-family:"Noto Sans Hebrew";src:url("fonts/own-light.ttf");font-weight:300}@font-face{font-family:"Noto Sans Hebrew";src:url("fonts/own-bold.ttf");font-weight:700}</style></head>',
  );
  expect(withFonts).not.toBe(marked);
  await writeFile(file, withFonts);
  await writeFile(join(dir, 'compositions', 'captions.html'), CAPTIONS);
  return html;
}

async function start(page: Page, target: Engine): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(target.baseURL);
  const whatsNew = page.getByRole('dialog', { name: /What's new/ });
  await whatsNew.waitFor({ timeout: 5_000 }).then(
    () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
    () => {},
  );
  await recordRows(page);
}

async function showDialog(page: Page, job: string): Promise<Locator> {
  await action(rowOf(page, job), 'Review').click();
  const dialog = reviewDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 30_000 },
  );
  return dialog;
}

const boxOf = (dialog: Locator): Locator => dialog.getByRole('textbox');
const pillOf = (dialog: Locator): Locator => dialog.locator('[data-slot="font-preview-pill"]');
const compareOf = (dialog: Locator): Locator =>
  pillOf(dialog).getByRole('button', { name: 'Compare' });

interface Look {
  /** The computed font-family up to its first comma, and the weight. */
  family: string;
  stack: string;
  weight: string;
}

/** What a text of the composition is set in right now, read in the player's own page. */
function lookOf(dialog: Locator, selector: string): Promise<Look | null> {
  return dialog.locator('hyperframes-player').evaluate((player, css) => {
    const frame = (player as HTMLElement & { iframeElement: HTMLIFrameElement | null })
      .iframeElement;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    const element = doc?.querySelector(css);
    if (!doc || !win || !element) return null;
    const style = win.getComputedStyle(element);
    return {
      family: style.fontFamily.split(',')[0]?.trim().replaceAll('"', '') ?? '',
      stack: style.fontFamily,
      weight: style.fontWeight,
    };
  }, selector);
}

/**
 * How wide the Hebrew word and the English words of the captions are drawn right now (the sample
 * line is "עריכה Smart Edit וגם מצוין"), read from the text itself with a range, so it is what is
 * on the picture, whatever the computed style says.
 */
function runWidths(dialog: Locator): Promise<{ hebrew: number; latin: number } | null> {
  return dialog.locator('hyperframes-player').evaluate((player) => {
    const frame = (player as HTMLElement & { iframeElement: HTMLIFrameElement | null })
      .iframeElement;
    const doc = frame?.contentDocument;
    const node = doc?.querySelector('#cap1')?.firstChild;
    if (!doc || !node || node.nodeType !== 3) return null;
    const text = node.textContent ?? '';
    const width = (from: number, to: number): number => {
      const range = doc.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      return range.getBoundingClientRect().width;
    };
    const latin = text.indexOf('Smart Edit');
    return {
      hebrew: width(0, text.indexOf(' ')),
      latin: width(latin, latin + 'Smart Edit'.length),
    };
  });
}

/** The preview's two styles in the player's page: both, or none. */
function previewStyles(dialog: Locator): Promise<string[]> {
  return dialog.locator('hyperframes-player').evaluate((player) => {
    const frame = (player as HTMLElement & { iframeElement: HTMLIFrameElement | null })
      .iframeElement;
    const doc = frame?.contentDocument;
    return ['__studio-font-preview-faces', '__studio-font-preview-rules'].filter(
      (id) => doc?.getElementById(id) != null,
    );
  });
}

/** The player's own playhead, to a second where the titles and captions are all on. */
function seekPlayer(dialog: Locator, seconds: number): Promise<void> {
  return dialog
    .locator('hyperframes-player')
    .evaluate((el, at) => (el as HTMLElement & { seek(s: number): void }).seek(at), seconds);
}

async function shot(locator: Locator, name: string): Promise<void> {
  if (SHOTS !== undefined) await locator.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const playing = (dialog: Locator): Promise<boolean> =>
  dialog
    .locator('hyperframes-player')
    .evaluate((el) => !(el as HTMLElement & { paused: boolean }).paused);

test('a font in the note box shows on the captions and the titles of the preview', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await start(page, engine);
  await fillLibrary(engine);
  await page.reload();
  await recordRows(page);

  const jobDir = await engine.createJob({ client: CLIENT, job: 'Marked' });
  await expect(badge(rowOf(page, 'Marked'), 'Review')).toBeVisible(RUN);
  const original = await markPreview(jobDir);
  const dialog = await showDialog(page, 'Marked');
  const box = boxOf(dialog);
  const stage = dialog.locator('[data-slot="preview-player"]');
  const own = { caption: '', title: '' };

  await test.step('with no font in the note the player is as it was', async () => {
    await expect(pillOf(dialog)).toHaveCount(0);
    expect(await previewStyles(dialog)).toEqual([]);
    expect((await lookOf(dialog, '#cap1'))?.family).toBe('Noto Sans Hebrew');
    expect((await lookOf(dialog, '#hero'))?.family).toBe('Noto Sans Hebrew');
    // The weights the video gives its own text: a font in a note must not change them (C51).
    own.caption = (await lookOf(dialog, '#cap1'))?.weight ?? '';
    own.title = (await lookOf(dialog, '#hero'))?.weight ?? '';
    expect(own.caption).toBe('300');
  });

  await test.step('one font for the captions: set in its own file, the pill names it', async () => {
    await seekPlayer(dialog, 1.2);
    await box.click();
    await box.fill('Make the captions @Secular One ');
    await expect(pillOf(dialog)).toContainText('Previewing @Secular One');
    await expect(compareOf(dialog)).toBeVisible();
    await expect
      .poll(async () => (await lookOf(dialog, '#cap1'))?.family)
      .toMatch(/^__studio_font_captions_/);
    const caption = await lookOf(dialog, '#cap1');
    // "Chosen, then current": the video's own font follows, for the letters the font lacks.
    expect(caption?.stack).toContain('"Noto Sans Hebrew"');
    // The text keeps the weight the video gave it; the font's own 400 is held by its @font-face.
    expect(caption?.weight).toBe(own.caption);
    const face = await dialog.locator('hyperframes-player').evaluate((player) => {
      const doc = (player as HTMLElement & { iframeElement: HTMLIFrameElement }).iframeElement
        .contentDocument;
      return [...(doc?.fonts ?? [])]
        .filter((font) => font.family.includes('__studio_font_captions_'))
        .map((font) => font.weight);
    });
    expect(face).toEqual(['400']);
    // The titles were not asked for.
    expect((await lookOf(dialog, '#hero'))?.family).toBe('Noto Sans Hebrew');
    // The font file is the engine's, in the player's page.
    const loaded = await dialog.locator('hyperframes-player').evaluate((player) => {
      const doc = (player as HTMLElement & { iframeElement: HTMLIFrameElement }).iframeElement
        .contentDocument;
      return [...(doc?.fonts ?? [])]
        .filter((face) => face.family.includes('__studio_font_captions_'))
        .map((face) => face.status);
    });
    expect(loaded).toEqual(['loaded']);
    await shot(stage, '01-one-font');
  });

  await test.step('the pill is the board’s: 34 px high, 10 px from the video’s bottom left, 12 px text, Compare 26 px', async () => {
    const video = await dialog.locator('hyperframes-player').boundingBox();
    const pill = await pillOf(dialog).boundingBox();
    const compare = await compareOf(dialog).boundingBox();
    expect(video && pill && compare).toBeTruthy();
    if (!(video && pill && compare)) return;
    expect(pill.height).toBeCloseTo(34, 0);
    expect(pill.x - video.x).toBeCloseTo(10, 0);
    expect(video.y + video.height - (pill.y + pill.height)).toBeCloseTo(10, 0);
    expect(compare.height).toBeCloseTo(26, 0);
    expect(await pillOf(dialog).evaluate((el) => getComputedStyle(el).fontSize)).toBe('12px');
    // Over the picture, in front of its click catcher: a click on the pill does not play the video.
    await pillOf(dialog).getByText('Previewing @Secular One').click();
    expect(await playing(dialog)).toBe(false);
    await box.click();
  });

  await test.step('Compare, held with the mouse, shows the video as it is; the box keeps the focus', async () => {
    const compare = compareOf(dialog);
    await compare.hover();
    await page.mouse.down();
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await lookOf(dialog, '#cap1'))?.family).toBe('Noto Sans Hebrew');
    await expect(box).toBeFocused();
    await expect(pillOf(dialog)).toContainText('Previewing @Secular One');
    await shot(stage, '03-compare');
    await page.mouse.up();
    await expect(compare).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(async () => (await lookOf(dialog, '#cap1'))?.family)
      .toMatch(/^__studio_font_captions_/);
  });

  await test.step('Compare, held with Space, does the same, and Space does not play the video', async () => {
    const compare = compareOf(dialog);
    await compare.focus();
    await page.keyboard.down('Space');
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await lookOf(dialog, '#cap1'))?.family).toBe('Noto Sans Hebrew');
    expect(await playing(dialog)).toBe(false);
    await page.keyboard.up('Space');
    await expect(compare).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(async () => (await lookOf(dialog, '#cap1'))?.family)
      .toMatch(/^__studio_font_captions_/);
    expect(await playing(dialog)).toBe(false);
  });

  await test.step('two fonts: each text in its own, the pill counts them', async () => {
    await box.click();
    await box.fill('Make the captions @Secular One and the titles in @Outfit Bold ');
    await expect(pillOf(dialog)).toContainText('Previewing 2 fonts');
    await expect
      .poll(async () => (await lookOf(dialog, '#hero'))?.family)
      .toMatch(/^__studio_font_titles_/);
    expect((await lookOf(dialog, '#hero'))?.weight).toBe(own.title);
    expect((await lookOf(dialog, '#cap1'))?.family).toMatch(/^__studio_font_captions_/);
    await shot(stage, '02-two-fonts');
  });

  await test.step('it plays on in the fonts, and a chip’s × ends that font at once', async () => {
    await dialog.getByRole('button', { name: 'Play' }).click();
    await expect.poll(() => playing(dialog)).toBe(true);
    await page.waitForTimeout(900);
    expect((await lookOf(dialog, '#hero'))?.family).toMatch(/^__studio_font_titles_/);
    expect((await lookOf(dialog, '#cap1'))?.family).toMatch(/^__studio_font_captions_/);
    await dialog.getByRole('button', { name: 'Remove @Outfit Bold from the note' }).click();
    await expect.poll(async () => (await lookOf(dialog, '#hero'))?.family).toBe('Noto Sans Hebrew');
    expect((await lookOf(dialog, '#cap1'))?.family).toMatch(/^__studio_font_captions_/);
    await expect(pillOf(dialog)).toContainText('Previewing @Secular One');
    // (The × gives the note box the focus, which pauses the video, as writing always does.)
    await dialog.getByRole('button', { name: 'Remove @Secular One from the note' }).click();
    await expect(pillOf(dialog)).toHaveCount(0);
    await expect.poll(() => previewStyles(dialog)).toEqual([]);
    expect((await lookOf(dialog, '#cap1'))?.family).toBe('Noto Sans Hebrew');
  });

  await test.step('a Hebrew note: English words in the font, Hebrew letters stay in the video’s own', async () => {
    await box.click();
    await box.fill('שנה את הכתוביות ל-@Outfit Bold ');
    await expect(pillOf(dialog)).toContainText('Previewing @Outfit Bold');
    await expect
      .poll(async () => (await lookOf(dialog, '#cap1'))?.stack)
      .toContain('"Noto Sans Hebrew"');
    const caption = await lookOf(dialog, '#cap1');
    expect(caption?.family).toMatch(/^__studio_font_captions_/);
    expect(caption?.weight).toBe(own.caption);
  });

  // C51: Outfit has no Hebrew, so the Hebrew word is drawn by the video's own font. A weight set on
  // the text (the font's 700) would have made it heavier than the edit will draw it.
  await test.step('the Hebrew word keeps the video’s own weight; only the English letters take the font', async () => {
    await seekPlayer(dialog, 1.2);
    await expect.poll(async () => (await runWidths(dialog))?.latin).toBeGreaterThan(0);
    const previewed = await runWidths(dialog);
    const compare = compareOf(dialog);
    await compare.hover();
    await page.mouse.down();
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await lookOf(dialog, '#cap1'))?.family).toBe('Noto Sans Hebrew');
    const original = await runWidths(dialog);
    await shot(stage, '05-hebrew-keeps-weight-compare');
    await page.mouse.up();
    await expect(compare).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(async () => (await lookOf(dialog, '#cap1'))?.family)
      .toMatch(/^__studio_font_captions_/);
    expect(previewed && original).toBeTruthy();
    if (!(previewed && original)) return;
    // The Hebrew is the same width with the font on and off ...
    expect(previewed.hebrew).toBeCloseTo(original.hebrew, 1);
    // ... and the English letters are drawn in the font (they are not, without it).
    expect(Math.abs(previewed.latin - original.latin)).toBeGreaterThan(2);
    await shot(stage, '05-hebrew-keeps-weight');
  });

  await test.step('a font the library does not have changes nothing', async () => {
    await box.click();
    await box.fill('the captions in @Gotham Bold ');
    await expect(pillOf(dialog)).toHaveCount(0);
    expect(await previewStyles(dialog)).toEqual([]);
  });

  await test.step('the job’s own files were never written', async () => {
    const now = await readFile(join(jobDir, 'edit', 'preview', 'index.html'), 'utf8');
    expect(now).not.toContain('__studio');
    expect(now).not.toBe(original);
    expect(now).toContain('data-timeline-role="title"');
    expect(
      await readFile(join(jobDir, 'edit', 'preview', 'compositions', 'captions.html'), 'utf8'),
    ).toBe(CAPTIONS);
  });

  expect(pageErrors).toEqual([]);
});

test('an older job: its title is found by its name, captions it has none of show nothing', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await start(page, engine);
  await engine.createJob({ client: CLIENT, job: 'Older' });
  await expect(badge(rowOf(page, 'Older'), 'Review')).toBeVisible(RUN);
  const dialog = await showDialog(page, 'Older');
  const box = boxOf(dialog);
  const stage = dialog.locator('[data-slot="preview-player"]');

  await test.step('the sample’s #title has no mark: it is found by its name', async () => {
    await box.click();
    await box.fill('Make the titles @Secular One ');
    await expect(pillOf(dialog)).toContainText('Previewing @Secular One');
    await expect
      .poll(async () => (await lookOf(dialog, '#title'))?.family)
      .toMatch(/^__studio_font_titles_/);
    await shot(stage, '04-older-job');
  });

  await test.step('captions in a job with none: nothing is shown for them, the pill says only what is', async () => {
    await box.fill('Make the titles @Secular One and the captions @Outfit Bold ');
    await page.waitForTimeout(3_500);
    await expect(pillOf(dialog)).toContainText('Previewing @Secular One');
    expect((await lookOf(dialog, '#title'))?.family).toMatch(/^__studio_font_titles_/);
    // The chip is still there: the note works as ever.
    await expect(
      dialog.getByRole('button', { name: 'Remove @Outfit Bold from the note' }),
    ).toBeVisible();
  });

  await test.step('only captions asked for: nothing to show, no pill, no error', async () => {
    await box.fill('Make the captions @Outfit Bold ');
    await page.waitForTimeout(3_500);
    await expect(pillOf(dialog)).toHaveCount(0);
    expect(await previewStyles(dialog)).toEqual([]);
    expect((await lookOf(dialog, '#title'))?.family).toBe('Noto Sans Hebrew');
  });

  expect(pageErrors).toEqual([]);
});

test('with fontsInNotes off the same note changes nothing in the player', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/fonts')) fontRequests.push(request.url());
  });
  await start(page, engineOff);
  await fillLibrary(engineOff);
  await engineOff.createJob({ client: CLIENT, job: 'Plain' });
  await expect(badge(rowOf(page, 'Plain'), 'Review')).toBeVisible(RUN);
  const dialog = await showDialog(page, 'Plain');
  await boxOf(dialog).click();
  await boxOf(dialog).fill('Make the titles @Secular One ');
  await page.waitForTimeout(1_500);
  await expect(pillOf(dialog)).toHaveCount(0);
  expect(await previewStyles(dialog)).toEqual([]);
  expect((await lookOf(dialog, '#title'))?.family).toBe('Noto Sans Hebrew');
  // No chip either, and Review asked nothing of the fonts' routes.
  await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  expect(fontRequests.filter((url) => url.includes('/api/fonts'))).toEqual([]);
  expect(pageErrors).toEqual([]);
});
