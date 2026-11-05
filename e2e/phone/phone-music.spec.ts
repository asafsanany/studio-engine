// CVP-287: Soundtrack on the phone, on the built server with the fake runner and the music switch on
// (`STUDIO_MUSIC=1`), in Chrome at the design boards' size (390×844, touch, an iPhone user agent; the
// `phone` project). The desktop spec (e2e/music.spec.ts) walks the Mac; this is the same loop with
// fingers, on the boards SDPhone and SDSheet:
//
//   the sheet     a job in Review: the phone job sheet's Details list has the Music row
//                 ("Made for this video · v1" and the version's line)
//   the button    Review's top bar has the Music button before Close ("Music, v1"), 44 px to touch, and
//                 a tap opens the list as a bottom sheet: v1 (picked), No music and Make another
//   Make v2       the words go to the script, v2 is made and picked, the button says "Music, v2" and
//                 the player follows the new music (its address carries the music's rev)
//   pick          v1 again, then No music ("Music, off"), then v2 again
//   Approve       the render run follows and the export has v2's music (the pitch of its decoded
//                 audio: v2's tone, not v1's and not silence)
//   taste         no focus ring after a tap on the button or a row, a pointer cursor on every control,
//                 and nothing in the sheet eases any way but ease-in-out
//
// 390×844 screenshots are attached to the report, and written to $PHONE_SHOTS_DIR when it is set.
// What only an iPhone shows (Safari's player resuming after a swap, the keyboard over the sheet) is
// in the hand-off.

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { approveFromPhoneSheet } from '../support/approve-ui.ts';
import { audioFingerprint, isSilent, sameSound } from '../support/audio.ts';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({ viewport: { width: 390, height: 844 } });

const REVIEW = '[data-slot="phone-review"]';
const PLAYER = `${REVIEW} [data-slot="preview-player"]`;
const MUSIC_BUTTON = `${REVIEW} [data-slot="phone-music-button"]`;
const MUSIC_SHEET = '[data-slot="phone-music-sheet"]';

/** The localStorage keys of the web app: "What's new" seen, the Add to Home Screen card away. */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

const CLIENT = 'Acme';
const JOB = 'Phone soundtrack';
const WORDS = 'calmer, with piano';
const WAIT = { timeout: 90_000 };
const EXPORT_SECONDS = 4;

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 10, music: true });
});

test.afterEach(async ({ browserName: _browser }, testInfo) => {
  // A failed test brings the server's own log along, which says why a job did not move.
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server.log', {
      body: await engine.readLog(),
      contentType: 'text/plain',
    });
  }
});

test.afterAll(async () => {
  await engine?.stop();
});

interface JobOnServer {
  id: string;
  name: string;
  state: string;
}

interface MusicOnServer {
  picked: string | null;
  rev: number;
  making: { id: string } | null;
  versions: { id: string; by: string; ask: string | null }[];
}

async function jobNamed(name: string): Promise<JobOnServer | undefined> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  return jobs.find((candidate) => candidate.name === name);
}

async function musicOf(id: string): Promise<MusicOnServer> {
  const response = await fetch(`${engine.baseURL}/api/jobs/${id}/music`);
  expect(response.status).toBe(200);
  return (await response.json()) as MusicOnServer;
}

const editDir = (): string => join(engine.inbox, CLIENT, JOB, 'edit');

/** Chrome's emulated notch and home indicator: the boards' status bar (47 px) and home indicator (34 px). */
async function emulateSafeAreas(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  });
}

/** Opens `path` on a phone that has seen this version's "What's new"; returns the page's errors. */
async function open(page: Page, path: string): Promise<string[]> {
  await emulateSafeAreas(page);
  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  await page.addInitScript(
    ([seen, current, card]) => {
      localStorage.setItem(seen as string, current as string);
      localStorage.setItem(card as string, String(Date.now()));
    },
    [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
  );
  // The phone asks the engine for the small MP4 of the preview (v0.29.0), which the fake runner
  // makes quickly (a test-pattern clip stands in for the HyperFrames render). This spec follows the
  // music through the live player, so it answers "no video" itself, as a failed render does: the
  // phone plays the live preview then. The MP4 on the phone is the other phone-review specs'.
  await page.route(/\/api\/jobs\/[^/]+\/preview-video$/, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'This preview has no video.' }),
    }),
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  return pageErrors;
}

/** Attaches a screenshot to the report, and writes it to $PHONE_SHOTS_DIR if set. */
async function shoot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  const body = await page.screenshot();
  await testInfo.attach(`${name}-390x844.png`, { body, contentType: 'image/png' });
  const dir = process.env.PHONE_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}-390x844.png`), body);
  }
}

/** The one player left of the open review has this music rev in its address (`&m=<rev>`). */
async function expectPlayerMusic(page: Page, rev: number): Promise<void> {
  const players = page.locator(`${REVIEW} hyperframes-player`);
  await expect(players).toHaveCount(1, { timeout: 30_000 });
  await expect(players).toHaveAttribute('src', new RegExp(`[?&]m=${rev}(&|$)`), {
    timeout: 30_000,
  });
}

const row = (sheet: Locator, id: string): Locator => sheet.locator(`[data-row="${id}"]`);

test('a phone: the Music row, the Music sheet, Make v2 with words, picks, and Approve', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await engine.createJob({ client: CLIENT, job: JOB, asksMusic: true });
  let id = '';
  await expect
    .poll(async () => {
      const job = await jobNamed(JOB);
      id = job?.id ?? '';
      return job?.state;
    }, WAIT)
    .toBe('review');
  const pageErrors = await open(page, `/jobs?job=${id}`);

  await test.step('the phone job sheet has the Music row', async () => {
    const sheet = page.locator('[data-slot="sheet-content"]');
    await expect(sheet).toBeVisible();
    const detail = sheet.locator('[data-detail="Music"]');
    await expect(detail).toContainText('Made for this video · v1');
    await expect(detail.locator('[data-detail-sub="Music"]')).toContainText('fake tone');
    await shoot(page, 'music-job-sheet', testInfo);
  });

  await test.step('Review opens with the Music button in the top bar', async () => {
    await page.locator('[data-sheet-action="review"]').click();
    await expect(page.locator(REVIEW)).toBeVisible();
    await expect(page.locator(PLAYER)).toHaveAttribute('data-status', 'ready', {
      timeout: 30_000,
    });
    const button = page.locator(MUSIC_BUTTON);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-label', 'Music, v1');
    await expect(button).toContainText('v1');
    // The board: 36 px of button in a 44 px target (the hit area reaches past the border).
    const box = await button.boundingBox();
    expect(box?.height).toBe(36);
    const target = await button.evaluate((el) => {
      const { height } = getComputedStyle(el, '::before');
      return Number.parseFloat(height);
    });
    expect(target).toBeGreaterThanOrEqual(44);
    await expectPlayerMusic(page, (await musicOf(id)).rev);
    await shoot(page, 'music-review-button', testInfo);
  });

  await test.step('a tap opens the list as a bottom sheet: v1 picked, No music, Make another', async () => {
    await page.locator(MUSIC_BUTTON).tap();
    const sheet = page.locator(MUSIC_SHEET);
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Made for this video by ElevenLabs');
    await expect(row(sheet, 'v1')).toHaveAttribute('aria-checked', 'true');
    await expect(row(sheet, 'off')).toHaveAttribute('aria-checked', 'false');
    await expect(sheet.getByRole('button', { name: 'Make v2' })).toBeEnabled();
    // Touch targets: every row and the button are at least 44 px tall, the field is 16 px text
    // (iPhone Safari zooms into anything smaller).
    for (const id of ['v1', 'off']) {
      expect((await row(sheet, id).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    expect((await sheet.getByRole('button', { name: 'Make v2' }).boundingBox())?.height).toBe(44);
    await expect(sheet.getByLabel('Make another')).toHaveCSS('font-size', '16px');
    await shoot(page, 'music-sheet-v1', testInfo);
  });

  await test.step('Make v2 with words: v2 is made and picked, and the player follows', async () => {
    const sheet = page.locator(MUSIC_SHEET);
    await sheet.getByLabel('Make another').fill(WORDS);
    await sheet.getByRole('button', { name: 'Make v2' }).tap();
    await expect(row(sheet, 'v2')).toHaveAttribute('aria-checked', 'true', WAIT);
    await expect(row(sheet, 'v2')).toContainText(`You asked: ${WORDS}`);
    await expect(sheet.getByLabel('Make another')).toHaveValue('');

    const music = await musicOf(id);
    expect(music).toMatchObject({ picked: 'v2', making: null });
    expect(music.versions[1]).toMatchObject({ id: 'v2', by: 'you', ask: WORDS });
    await expect(page.locator(MUSIC_BUTTON)).toHaveAttribute('aria-label', 'Music, v2');
    await expectPlayerMusic(page, music.rev);
    await shoot(page, 'music-sheet-v2', testInfo);
  });

  await test.step('pick v1, then No music, then v2 again', async () => {
    const sheet = page.locator(MUSIC_SHEET);
    await row(sheet, 'v1').tap();
    await expect(row(sheet, 'v1')).toHaveAttribute('aria-checked', 'true', WAIT);
    await expect(page.locator(MUSIC_BUTTON)).toHaveAttribute('aria-label', 'Music, v1');
    expect((await musicOf(id)).picked).toBe('v1');

    await row(sheet, 'off').tap();
    await expect(row(sheet, 'off')).toHaveAttribute('aria-checked', 'true', WAIT);
    await expect(sheet).toContainText('The video plays and renders without music.');
    await expect(page.locator(MUSIC_BUTTON)).toHaveAttribute('aria-label', 'Music, off');
    expect((await musicOf(id)).picked).toBe('off');
    expect(isSilent(await audioFingerprint(join(editDir(), 'preview', 'music.mp3')))).toBe(true);
    await shoot(page, 'music-sheet-off', testInfo);

    await row(sheet, 'v2').tap();
    await expect(row(sheet, 'v2')).toHaveAttribute('aria-checked', 'true', WAIT);
    const music = await musicOf(id);
    expect(music.picked).toBe('v2');
    await expectPlayerMusic(page, music.rev);
  });

  await test.step('taste: no focus ring after a tap, pointer cursors, ease-in-out', async () => {
    const sheet = page.locator(MUSIC_SHEET);
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return null;
      const style = getComputedStyle(el);
      return { outline: style.outlineStyle, ring: style.boxShadow };
    });
    // Whatever holds the focus after the taps shows no outline (a tap leaves no ring on a phone).
    if (focus !== null) expect(focus.outline === 'none' || focus.outline === '').toBe(true);

    const cursors = await sheet.evaluate((el) =>
      Array.from(el.querySelectorAll('button, [role="radio"]'))
        .filter((node) => node.getAttribute('aria-disabled') !== 'true')
        .map((node) => getComputedStyle(node).cursor),
    );
    expect(cursors.length).toBeGreaterThan(3);
    expect(cursors.every((cursor) => cursor === 'pointer')).toBe(true);

    // Tailwind's `ease-in-out` is cubic-bezier(0.4, 0, 0.2, 1); `linear` is for the spinner.
    const offenders = await sheet.evaluate((el) => {
      const allowed = new Set(['cubic-bezier(0.4, 0, 0.2, 1)', 'ease-in-out', 'linear']);
      const found: string[] = [];
      for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
        const style = getComputedStyle(node);
        const durations = style.transitionDuration
          .split(',')
          .map((part) => Number.parseFloat(part));
        const easings = style.transitionTimingFunction
          .split(/,(?![^(]*\))/)
          .map((part) => part.trim());
        durations.forEach((duration, index) => {
          const easing = easings[index % easings.length] ?? '';
          if (duration > 0 && !allowed.has(easing)) found.push(`${node.tagName}: ${easing}`);
        });
        if (style.animationName !== 'none' && Number.parseFloat(style.animationDuration) > 0) {
          const easing = style.animationTimingFunction.split(/,(?![^(]*\))/)[0]?.trim() ?? '';
          if (!allowed.has(easing)) found.push(`${node.tagName}: animation ${easing}`);
        }
      }
      return [...new Set(found)];
    });
    expect(offenders, 'every transition eases in and out').toEqual([]);
  });

  await test.step('Approve renders, and the export has v2’s music', async () => {
    // The sheet closes with a drag down on its grabber, or Back; Escape is the keyboard's.
    await page.keyboard.press('Escape');
    await expect(page.locator(MUSIC_SHEET)).toBeHidden();
    // Approve is the job sheet's (the owner, 31 Oct): Close gives the sheet back, the review was opened
    // from it.
    await approveFromPhoneSheet(page, page.locator(`[data-job-id="${id}"]`));
    await expect(page.locator(REVIEW)).toHaveCount(0);

    await expect.poll(async () => (await jobNamed(JOB))?.state, WAIT).toBe('ready');
    const exported = join(engine.exportsDir, CLIENT, `${JOB}.mp4`);
    await expect.poll(() => existsSync(exported), WAIT).toBe(true);
    const v1 = await audioFingerprint(join(editDir(), 'music', 'v1.mp3'));
    const v2 = await audioFingerprint(join(editDir(), 'music', 'v2.mp3'));
    const sound = await audioFingerprint(exported);
    expect(sound.durationSec).toBeGreaterThan(EXPORT_SECONDS - 0.5);
    expect(sound.durationSec).toBeLessThan(EXPORT_SECONDS + 0.5);
    expect(sameSound(v2, sound), `the export (${sound.hz} Hz) has v2 (${v2.hz} Hz)`).toBe(true);
    expect(sameSound(v1, sound)).toBe(false);
  });

  expect(pageErrors).toEqual([]);
});
