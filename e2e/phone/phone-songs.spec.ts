// CVP-396 (SG12): Songs on the phone, on the built server with the fake runner and the Soundtrack and
// Songs switches on (`STUDIO_MUSIC=1`, `STUDIO_SONGS=1`), in Chrome at the design boards' size (390×844,
// touch, an iPhone user agent; the `phone` project). The desktop spec (e2e/songs.spec.ts) walks the Mac;
// this is the same loop with fingers, on the boards SGPhone and SGSheet. The song comes from the same
// stand-ins (support/engine.ts), so nothing touches the network or Apify.
//
//   the note sheet   Add note… on an arriving job is a bottom sheet: the grabber and no Cancel, a
//                    full-width Add photo (44 px) and Save (48 px), a 16 px text box; a photo chosen
//                    (the hidden file input, which has no `capture` so iOS offers Photos and Files) gets
//                    its row with the thumbnail, "The brief reads the song off it." and a 44 px ×
//   the edit         Save keeps the picture; the job starts, the Brief reads the song off it, the song
//                    command gets it: the job comes back to Review with the song picked
//   Music sheet      Review's top bar says "Music, song"; a tap opens the list as a bottom sheet: the song
//                    with its artist and the part bar, Another song with its 44 px field and buttons;
//                    Add to notes and Pick a trending one add their notes
//   Approve          the notes are taken off (a note would make the footer say Send), Approve renders
//   the sheet        two file rows (with the song, without it), "To post on Instagram" with a 44 px Copy,
//                    Share video shares the file without the song with the line as its text
//   taste            no focus ring after a tap, a pointer cursor on every control, ease-in-out only
//
// 390×844 screenshots are attached to the report, and written to $PHONE_SHOTS_DIR when it is set.
// What only an iPhone shows (the real Photos and Files pickers, the keyboard over the sheet, what an
// app does with the share's text) is in the hand-off.

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { approveFromPhoneSheet, PHONE_APPROVE_LINE } from '../support/approve-ui.ts';
import { type Engine, startEngine } from '../support/engine.ts';
import { sharesOf, shareTextsOf, stubShare } from '../support/share-stub.ts';

test.use({ viewport: { width: 390, height: 844 } });

const REVIEW = '[data-slot="phone-review"]';
const MUSIC_BUTTON = `${REVIEW} [data-slot="phone-music-button"]`;
const MUSIC_SHEET = '[data-slot="phone-music-sheet"]';
const NOTE_SHEET = '[data-slot="phone-note-sheet"]';
const SHEET = '[data-slot="phone-job-sheet"]';

/** The localStorage keys of the web app: "What's new" seen, the Add to Home Screen card away. */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

const CLIENT = 'Acme';
const JOB = 'Phone song';
const PICTURE = 'IMG_4412.PNG';
const NOTE_TEXT = 'Yael wants this song. Start it where the reel does.';
const WAIT = { timeout: 90_000 };

/** A 1 x 1 PNG: the picture only has to be a picture. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 30_000,
    fakeSpeed: 10,
    music: true,
    songs: true,
  });
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

async function jobNamed(name: string): Promise<JobOnServer | undefined> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  return jobs.find((candidate) => candidate.name === name);
}

interface MusicOnServer {
  picked: string | null;
  song: {
    title: string | null;
    artist: string | null;
    part: { startMs: number; endMs: number };
  } | null;
}

async function musicOf(id: string): Promise<MusicOnServer> {
  const response = await fetch(`${engine.baseURL}/api/jobs/${id}/music`);
  expect(response.status).toBe(200);
  return (await response.json()) as MusicOnServer;
}

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
  // The phone plays the live preview here: the small MP4 of it is the other phone-review specs'.
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

const row = (sheet: Locator, id: string): Locator => sheet.locator(`[data-row="${id}"]`);

/** A control's height in whole px (a sheet that is still sliding in measures a hair off). */
async function heightOf(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())?.height ?? 0);
}

test('a phone: Add photo, the Music sheet with the song, and the sheet’s two files', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: engine.baseURL,
  });
  await stubShare(page);
  await engine.createJob({ client: CLIENT, job: JOB, asksMusic: true });
  let id = '';
  await expect
    .poll(async () => {
      id = (await jobNamed(JOB))?.id ?? '';
      return id;
    }, WAIT)
    .not.toBe('');
  const pageErrors = await open(page, `/jobs?job=${id}`);
  const editDir = join(engine.inbox, CLIENT, JOB, 'edit');

  await test.step('Add note… is a bottom sheet with Add photo', async () => {
    await expect(page.locator(SHEET)).toBeVisible();
    await page.waitForTimeout(450); // the sheet's own slide
    await page.locator(`${SHEET} [data-menu-row="note"]`).tap();
    const note = page.locator(NOTE_SHEET);
    await expect(note).toBeVisible();
    await expect(note).toContainText('Note for the editor');
    await expect(note).toContainText(JOB);
    await page.waitForTimeout(450); // the sheet's own slide
    // The sheet is closed by its grabber, a tap outside or Esc, not by a Cancel.
    await expect(note.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    const addPhoto = note.getByRole('button', { name: 'Add photo' });
    const save = note.getByRole('button', { name: 'Save', exact: true });
    expect(await heightOf(addPhoto)).toBe(44);
    expect(await heightOf(save)).toBe(48);
    await expect(note.getByRole('textbox')).toHaveCSS('font-size', '16px');
    // The picker offers Photos and Files: images, several at a time, no `capture` (that is the camera).
    const input = note.locator('input[type="file"]');
    await expect(input).toHaveAttribute('accept', 'image/*');
    await expect(input).toHaveAttribute('multiple', '');
    await expect(input).not.toHaveAttribute('capture', /.*/);
    await shoot(page, 'songs-note-sheet-empty', testInfo);

    await input.setInputFiles({ name: PICTURE, mimeType: 'image/png', buffer: PNG });
    const attached = note.locator('li[data-status="ready"]');
    await expect(attached).toHaveCount(1, WAIT);
    await expect(attached).toContainText(PICTURE);
    await expect(attached).toContainText('The brief reads the song off it.');
    expect(await heightOf(attached.getByRole('button', { name: `Remove ${PICTURE}` }))).toBe(44);
    await note.getByRole('textbox').fill(NOTE_TEXT);
    await shoot(page, 'songs-note-sheet-photo', testInfo);

    await save.tap();
    await expect(note).toHaveCount(0);
    expect(existsSync(join(editDir, 'brief', 'from-you', PICTURE))).toBe(true);
    await expect(page.locator(`${SHEET} [data-slot="note-box"]`)).toContainText(NOTE_TEXT);
  });

  await test.step('Start now: the Brief reads the song and the edit gets it', async () => {
    await page.locator(`${SHEET} [data-sheet-action]`).tap();
    await expect.poll(async () => (await jobNamed(JOB))?.state, WAIT).toBe('review');
    const music = await musicOf(id);
    expect(music.picked).toBe('song');
    expect(music.song).toMatchObject({
      title: 'A Home for You',
      artist: 'Ofek Adanek',
      part: { startMs: 19_100, endMs: 25_100 },
    });
  });

  await test.step('Review: the Music button says song, and its sheet has the song and its part', async () => {
    await expect(page.locator(SHEET)).toBeVisible();
    await page.locator('[data-sheet-action="review"]').tap();
    await expect(page.locator(REVIEW)).toBeVisible();
    const button = page.locator(MUSIC_BUTTON);
    await expect(button).toHaveAttribute('aria-label', 'Music, song');
    await expect(button).toContainText('song');
    await shoot(page, 'songs-review-button', testInfo);

    await button.tap();
    const sheet = page.locator(MUSIC_SHEET);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-slot="music-source"]')).toContainText(
      'The song Yael asked for · from her screenshot',
    );
    const song = row(sheet, 'song');
    await expect(song).toHaveAttribute('aria-checked', 'true');
    await expect(song).toContainText('A Home for You');
    await expect(song.locator('[data-slot="music-artist"]')).toHaveText('Ofek Adanek');
    await expect(song).toContainText('in the preview');
    await expect(song).toContainText('the part used · 0:19 to 0:25');
    await expect(song).toContainText('0:40');
    await expect(sheet).toContainText('Approve renders two files');
    // Touch targets: the rows, the tabs' hit area, the field's 16 px text and the buttons.
    for (const which of ['song', 'off']) {
      expect(await heightOf(row(sheet, which))).toBeGreaterThanOrEqual(44);
    }
    await expect(sheet.getByLabel('A link or a song name')).toHaveCSS('font-size', '16px');
    expect(await heightOf(sheet.getByLabel('A link or a song name'))).toBe(44);
    expect(await heightOf(sheet.getByRole('button', { name: 'Add to notes' }))).toBe(44);
    expect(await heightOf(sheet.locator('[data-slot="music-trend"]'))).toBe(44);
    await shoot(page, 'songs-music-sheet', testInfo);
  });

  await test.step('Add to notes and Pick a trending one add their notes', async () => {
    const sheet = page.locator(MUSIC_SHEET);
    await sheet.getByLabel('A link or a song name').fill('Blinding Lights');
    await sheet.getByRole('button', { name: 'Add to notes' }).tap();
    await expect(sheet.locator('[data-slot="music-noted"]')).toContainText(
      '“Use Blinding Lights instead.”',
      WAIT,
    );
    await sheet.locator('[data-slot="music-trend"]').tap();
    await expect(sheet.locator('[data-slot="music-trend"]')).toHaveText(
      'Added to your notes',
      WAIT,
    );
    await shoot(page, 'songs-music-sheet-noted', testInfo);
    const notes = (await (await fetch(`${engine.baseURL}/api/jobs/${id}/notes`)).json()) as {
      id: string;
      text: string;
    }[];
    expect(notes.map((note) => note.text)).toEqual([
      'Use Blinding Lights instead.',
      'Use a trending song that fits the cut.',
    ]);
    // The notes are taken off, as they are for the Mac (a note would make the footer say Send).
    for (const note of notes) {
      const gone = await fetch(`${engine.baseURL}/api/jobs/${id}/notes/${note.id}`, {
        method: 'DELETE',
      });
      expect(gone.ok).toBe(true);
    }
  });

  await test.step('taste: no focus ring after a tap, pointer cursors, ease-in-out', async () => {
    const sheet = page.locator(MUSIC_SHEET);
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return null;
      const style = getComputedStyle(el);
      return { outline: style.outlineStyle, ring: style.boxShadow };
    });
    if (focus !== null) expect(focus.outline === 'none' || focus.outline === '').toBe(true);

    const cursors = await sheet.evaluate((el) =>
      Array.from(el.querySelectorAll('button, [role="radio"], [role="tab"]'))
        .filter(
          (node) =>
            node.getAttribute('aria-disabled') !== 'true' && !(node as HTMLButtonElement).disabled,
        )
        .map((node) => getComputedStyle(node).cursor),
    );
    expect(cursors.length).toBeGreaterThan(3);
    expect(cursors.every((cursor) => cursor === 'pointer')).toBe(true);

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
      }
      return [...new Set(found)];
    });
    expect(offenders, 'every transition eases in and out').toEqual([]);
  });

  await test.step('Approve renders, and the engine makes the file without the song', async () => {
    await page.keyboard.press('Escape'); // the sheet
    await expect(page.locator(MUSIC_SHEET)).toBeHidden();
    // No notes: the footer's line says where Approve is (the job's sheet, the owner 31 Oct), and that it
    // renders two files.
    await expect(page.locator(REVIEW)).toContainText('Notes0');
    await expect(page.locator(PHONE_APPROVE_LINE)).toContainText(
      'Press and hold the job in the list and choose Approve to render two files',
    );
    // The review was opened from the sheet: Close gives it back, and Approve is in its list.
    await approveFromPhoneSheet(page, page.locator(`[data-job-id="${id}"]`));
    await expect(page.locator(REVIEW)).toHaveCount(0);
    await expect.poll(async () => (await jobNamed(JOB))?.state, WAIT).toBe('ready');
    await expect
      .poll(() => existsSync(join(engine.exportsDir, CLIENT, `${JOB} · no song.mp4`)), WAIT)
      .toBe(true);
  });

  await test.step('the sheet: two files, the line to post with Copy, Share video shares the second', async () => {
    const sheet = page.locator(SHEET);
    await expect(sheet).toBeVisible();
    const withSong = sheet.locator('[data-menu-row="download"]');
    const withoutSong = sheet.locator('[data-menu-row="download-no-song"]');
    await expect(withSong).toBeVisible(WAIT);
    await expect(withoutSong).toBeVisible(WAIT);
    await expect(withSong).toContainText(`${JOB}.mp4`);
    await expect(withSong).toContainText('With the song · to show the client');
    await expect(withoutSong).toContainText(`${JOB} · no song.mp4`);
    await expect(withoutSong).toContainText('Without it · to post');
    expect(await heightOf(withSong)).toBeGreaterThanOrEqual(44);
    expect(await heightOf(withoutSong)).toBeGreaterThanOrEqual(44);

    const line = `Post “${JOB} · no song.mp4”. In Instagram tap Add audio, pick A Home for You by Ofek Adanek and slide it to start at 0:19. That way the reel counts toward the song’s trend.`;
    const post = sheet.locator('[data-slot="song-post"]');
    await post.scrollIntoViewIfNeeded();
    await expect(post.locator('[data-slot="song-post-text"]')).toHaveText(line);
    const copy = post.locator('[data-sheet-copy-line]');
    expect(await heightOf(copy)).toBe(44);
    await copy.tap();
    await expect(copy).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);
    await shoot(page, 'songs-sheet-two-files', testInfo);

    // Share video sends the file to post, with the line as its text.
    const share = sheet.locator('[data-sheet-action="share"]');
    await share.scrollIntoViewIfNeeded();
    await expect(share).toBeEnabled(WAIT);
    await share.tap();
    await expect.poll(async () => (await sharesOf(page)).length, WAIT).toBe(1);
    const [shared] = await sharesOf(page);
    expect(shared).toMatchObject({
      name: `${JOB} · no song.mp4`,
      type: 'video/mp4',
      files: 1,
      inTap: true,
    });
    expect(await shareTextsOf(page)).toEqual([line]);
    await shoot(page, 'songs-sheet-shared', testInfo);
  });

  expect(pageErrors).toEqual([]);
});
