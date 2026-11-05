// CVP-396 (SG12): Songs, the whole loop on the built server with the fake runner, the Soundtrack and
// Songs switches on (`STUDIO_MUSIC=1`, `STUDIO_SONGS=1`: both are on in the app, and the engine helper pins them off for
// the specs that do not say). The fake Brief reads the song off the picture attached to the note, the fake edit
// run calls the music script's real `song` command, and the script gets its song from stand-ins
// (apps/server/src/music/testdata/fake-e2e-songs.mjs: a 40 s tone track with a drop at 0:20, a fixed
// trending pick), so nothing touches the network or Apify. See support/engine.ts.
//
//   Note            Add note… on an arriving job: the drop zone, a screenshot chosen (the hidden file
//                   input), its row with the "brief reads the song" line, Save keeps it in
//                   edit/brief/from-you/ (GET /note lists it)
//   the brief       the fake Brief reads "נתתי לך בית" by Ofek Adanek (sped up) off IMG_4412.PNG: brief.json,
//                   brief.md's "Song:" line
//   the edit        the song command ran for real: music.json (source song, picked song, asked from the
//                   screenshot by the brief, the part measured), song.mp3, and preview/music.mp3 is that file
//   Review          the Music button says "Music song", the footer says Approve renders two files (Approve is in the row's right-click menu), the
//                   list has the song with its artist, "in the preview" and the part bar (0:19 to 0:25 of
//                   the 0:40 song)
//   Another song    a name goes to the notes as "Use … instead." (and the line under the list says so);
//                   Pick a trending one adds "Use a trending song that fits the cut." and turns off
//   Approve         the notes are taken off first (a note would make the footer say Send); Approve renders
//                   the export, and the engine makes "[Job] · no song.mp4" next to it
//   the sheet       two Downloads (both hand out an MP4, the second with the song silenced), "To post on
//                   Instagram" with the line, Copy puts the whole text on the clipboard
//   trending        a screenshot that asks for "a trending song": the editor's pick, with Instagram's numbers
//   can't get it    a song the downloader cannot get: ElevenLabs's tone v1 plays, the box says why
//   Original audio  a screenshot whose label says "Original audio · @account": no song is looked up, the
//                   edit makes v1 and notes it (song-note), Review's box and the sheet's Music row ask
//                   for the reel's link (RGM1)
//   Send            the second test (RGM2): Another song with a name, then Send: the fake revise run reads
//                   the round file and calls the song command, and the job comes back to Review with the
//                   song picked (asked from the note, by you); the same for Pick a trending one (asked
//                   from trending, by you); a song that cannot be got leaves the music as it was
//
// Job A walks the Mac; jobs B, C and D are the other Review states; job E takes the notes to Send.
// 1440 x 900.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { approveFromRowMenu } from './support/approve-ui.ts';
import { audioFingerprint, isSilent } from './support/audio.ts';
import { isMp4 } from './support/download.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, chooseFromRowMenu, noteDialog, rowOf } from './support/jobs-ui.ts';
import { openApp, sheetOf } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB_A = 'Song from a screenshot';
const JOB_B = 'Trending song';
const JOB_C = 'Song that fails';
const JOB_D = 'Original audio screenshot';
const JOB_E = 'Song asked for in Review';
const NOTE_TEXT = 'Yael wants this song. Start it where the reel does.';
const SONG = { title: 'נתתי לך בית', artist: 'Ofek Adanek' };
const TRENDING = { title: 'Skyline Run', artist: 'Dana Kahn' };

/** The fake edit's own speed: a whole edit takes a few seconds. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 10);
const RUN = { timeout: 90_000 };

/** A 1 x 1 PNG: the pictures only have to be pictures. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let engine: Engine;

test.beforeAll(async () => {
  // A long settle time: a job stays "Arriving" while its note is written.
  engine = await startEngine({
    settleMs: 20_000,
    fakeSpeed: FAKE_SPEED,
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
  round: number;
}

/** What GET /api/jobs/:id/music answers: the parts these specs read. */
interface MusicOnServer {
  source: string;
  picked: string | null;
  canMake: boolean;
  rev: number;
  versions: { id: string }[];
  song: {
    title: string | null;
    artist: string | null;
    version: string | null;
    asked: { from: string; by: string; file: string | null };
    source: { site: string; via: string };
    fullMs: number;
    part: { startMs: number; endMs: number; how: string };
    trending: {
      reels: number | null;
      isTrending: boolean | null;
      nicheTop20: number | null;
      niche: string;
    } | null;
    instagramLine: string;
  } | null;
  songFailure: { code: string; message: string; asked: string } | null;
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === name);
  expect(job, `the server lists "${name}"`).toBeDefined();
  return job as JobOnServer;
}

async function musicOf(id: string): Promise<MusicOnServer> {
  const response = await fetch(`${engine.baseURL}/api/jobs/${id}/music`);
  expect(response.status).toBe(200);
  return (await response.json()) as MusicOnServer;
}

const editDir = (job: string): string => join(engine.inbox, CLIENT, job, 'edit');
const exportOf = (job: string, suffix = ''): string =>
  join(engine.exportsDir, CLIENT, `${job}${suffix}.mp4`);

/** Writes a screenshot to $SONGS_SHOTS_DIR when it is set, and to the report always. */
async function shoot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  const body = await page.screenshot();
  await testInfo.attach(`${name}.png`, { body, contentType: 'image/png' });
  const dir = process.env.SONGS_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), body);
  }
}

/** The job is in Review with its music made: waits for it. */
async function inReview(name: string): Promise<JobOnServer> {
  let job: JobOnServer | undefined;
  await expect
    .poll(async () => {
      job = await jobNamed(name).catch(() => undefined);
      return job?.state;
    }, RUN)
    .toBe('review');
  return job as JobOnServer;
}

/** The revise run of `round` is over and the job is in Review again. */
async function backInReview(name: string, round: number): Promise<JobOnServer> {
  let job: JobOnServer | undefined;
  await expect
    .poll(async () => {
      job = await jobNamed(name).catch(() => undefined);
      return job === undefined ? undefined : `${job.state} ${job.round}`;
    }, RUN)
    .toBe(`review ${round}`);
  return job as JobOnServer;
}

/**
 * A job arrives, Add note… attaches `picture` and a note to it, Save keeps both, and Start now sends it
 * through the Brief (which reads the picture) and the edit. Returns when it is in Review.
 */
async function sendWithPicture(page: Page, job: string, picture: string): Promise<JobOnServer> {
  await engine.createJob({ client: CLIENT, job, asksMusic: true });
  const row = rowOf(page, job);
  await expect(badge(row, 'Arriving')).toBeVisible(RUN);
  await chooseFromRowMenu(page, row, 'Add note…');
  const dialog = noteDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: picture,
    mimeType: 'image/png',
    buffer: PNG,
  });
  const attached = dialog.locator('li[data-status="ready"]');
  await expect(attached).toHaveCount(1, RUN);
  await expect(attached).toContainText(picture);
  await dialog.getByRole('textbox', { name: 'Note' }).fill(NOTE_TEXT);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await action(row, 'Start now').click();
  return inReview(job);
}

/**
 * The open Review dialog. Found by its role attribute and not by `getByRole`: while the Music list
 * is open (a modal popover) the dialog under it is `aria-hidden`, and a role query would not see it.
 */
const reviewDialog = (page: Page): Locator =>
  page.locator('[role="dialog"]').filter({ has: page.locator('[data-slot="preview-player"]') });
const musicButton = (dialog: Locator): Locator => dialog.locator('[data-slot="music-button"]');
const musicList = (page: Page): Locator => page.locator('[data-slot="music-list"]');
const musicRow = (list: Locator, id: string): Locator => list.locator(`[data-row="${id}"]`);

/** Opens a job's Review from its row and waits for the player. */
async function openReview(page: Page, name: string): Promise<Locator> {
  await action(rowOf(page, name), 'Review').click();
  const dialog = reviewDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 30_000 },
  );
  return dialog;
}

async function openList(page: Page, dialog: Locator): Promise<Locator> {
  await musicButton(dialog).click();
  const list = musicList(page);
  await expect(list).toBeVisible();
  return list;
}

test('Yael’s screenshot gets its song into the edit, Review shows it, and Approve gives both files', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: engine.baseURL,
  });
  const pageErrors = await openApp(page, engine.baseURL);
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();

  let a: JobOnServer = { id: '', name: JOB_A, state: '', round: 0 };

  await test.step('Note for the editor: the drop zone, a screenshot chosen, Save keeps it', async () => {
    await engine.createJob({ client: CLIENT, job: JOB_A, asksMusic: true });
    const row = rowOf(page, JOB_A);
    await expect(badge(row, 'Arriving')).toBeVisible(RUN);
    await chooseFromRowMenu(page, row, 'Add note…');
    const dialog = noteDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'Drop a screenshot here or paste one (⌘V). Links go in the note.',
    );
    await expect(dialog.getByRole('button', { name: 'Choose a file' })).toBeVisible();
    await shoot(page, 'mac-note-empty', testInfo);

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'IMG_4412.PNG',
      mimeType: 'image/png',
      buffer: PNG,
    });
    const attached = dialog.locator('li[data-status="ready"]');
    await expect(attached).toHaveCount(1, RUN);
    await expect(attached).toContainText('IMG_4412.PNG');
    await expect(attached).toContainText('The brief reads the song off it');
    // The drop zone gives way to the list, which offers one more.
    await expect(dialog.getByRole('button', { name: 'Choose a file' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Add another' })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Note' }).fill(NOTE_TEXT);
    await shoot(page, 'mac-note-shot', testInfo);

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();

    a = await jobNamed(JOB_A);
    const view = (await (await fetch(`${engine.baseURL}/api/jobs/${a.id}/note`)).json()) as {
      note: string;
      attachments: { name: string; bytes: number }[];
    };
    expect(view.note).toBe(NOTE_TEXT);
    expect(view.attachments.map((file) => file.name)).toEqual(['IMG_4412.PNG']);
    expect(existsSync(join(editDir(JOB_A), 'brief', 'from-you', 'IMG_4412.PNG'))).toBe(true);
  });

  await test.step('Start now: the Brief reads the song, the edit gets it with the song command', async () => {
    await action(rowOf(page, JOB_A), 'Start now').click();
    a = await inReview(JOB_A);

    const brief = JSON.parse(await readFile(join(editDir(JOB_A), 'brief.json'), 'utf8')) as {
      music: { song: Record<string, unknown>; original: unknown; wantsTrending: boolean };
    };
    expect(brief.music).toMatchObject({
      song: { ...SONG, version: 'sped up', link: null, fromFile: 'IMG_4412.PNG' },
      original: null,
      wantsTrending: false,
    });
    expect(await readFile(join(editDir(JOB_A), 'brief.md'), 'utf8')).toContain(
      '- Song: נתתי לך בית by Ofek Adanek (sped up), from IMG_4412.PNG',
    );

    const music = await musicOf(a.id);
    expect(music).toMatchObject({ source: 'song', picked: 'song', songFailure: null });
    expect(music.song).toMatchObject({
      ...SONG,
      version: 'sped up',
      asked: { from: 'screenshot', by: 'brief', file: 'IMG_4412.PNG' },
      source: { site: 'youtube-music', via: 'yt-dlp' },
      fullMs: 40_000,
      // The drop of the stand-in song is at 0:20, 0.9 s after the bar line the part starts on.
      part: { startMs: 19_100, endMs: 25_100, how: 'measured' },
      trending: null,
    });
    expect(music.song?.instagramLine).toBe(
      'In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:19.',
    );
    // The part is the cut's length, and the composition plays it.
    const song = join(editDir(JOB_A), 'music', 'song.mp3');
    expect(existsSync(song)).toBe(true);
    expect(
      (await readFile(song)).equals(await readFile(join(editDir(JOB_A), 'preview', 'music.mp3'))),
    ).toBe(true);
    expect(isSilent(await audioFingerprint(song))).toBe(false);
    expect(await readFile(join(editDir(JOB_A), 'preview', 'index.html'), 'utf8')).toContain(
      'src="music.mp3"',
    );
    // The edit's tone v1 is not made: the song was got, so no ElevenLabs.
    expect(music.versions).toEqual([]);
  });

  const dialog = reviewDialog(page);

  await test.step('Review: the Music button, the footer, the song with its part', async () => {
    await openReview(page, JOB_A);
    await expect(musicButton(dialog)).toContainText('Music');
    await expect(musicButton(dialog)).toContainText('song');
    await expect(dialog).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render two files: with the song, and without it to post.',
    );

    const list = await openList(page, dialog);
    await expect(list.locator('[data-slot="music-source"]')).toContainText(
      'The song Yael asked for · from her screenshot',
    );
    const row = musicRow(list, 'song');
    await expect(row).toHaveAttribute('aria-checked', 'true');
    await expect(row).toContainText(SONG.title);
    await expect(row.locator('[data-slot="music-artist"]')).toHaveText(SONG.artist);
    await expect(row).toContainText('in the preview');
    await expect(row).toContainText('YouTube Music, sped up. The cuts sit on its beat.');
    await expect(musicRow(list, 'off')).toHaveAttribute('aria-checked', 'false');

    // The part bar: the lit stretch starts at 19.1 / 40 s of the bar and is 6 / 40 s long.
    await expect(row.locator('[data-slot="music-part"]')).toBeVisible();
    await expect(row).toContainText('the part used · 0:19 to 0:25');
    await expect(row).toContainText('0:40');
    const lit = row.locator('[data-slot="music-part-used"]');
    await expect(lit).toHaveAttribute('style', /left: 47\.8%/);
    await expect(lit).toHaveAttribute('style', /width: 15%/);
    await expect(list).toContainText('Approve renders two files');
    await expect(list.getByRole('tab', { name: 'Another song' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(list.getByRole('tab', { name: 'Make music instead' })).toBeVisible();
    await shoot(page, 'mac-review-song', testInfo);
  });

  await test.step('Another song adds a note, Pick a trending one adds another', async () => {
    const list = musicList(page);
    await list.getByLabel('A link or a song name').fill('Blinding Lights');
    await list.getByRole('button', { name: 'Add to notes' }).click();
    await expect(list.locator('[data-slot="music-noted"]')).toContainText(
      '“Use Blinding Lights instead.”',
      RUN,
    );
    await expect(list.getByLabel('A link or a song name')).toHaveValue('');

    const trend = list.locator('[data-slot="music-trend"]');
    await expect(trend).toHaveText('Pick a trending one');
    await trend.click();
    await expect(trend).toHaveText('Added to your notes', RUN);
    await expect(trend).toBeDisabled();

    const notes = (await (await fetch(`${engine.baseURL}/api/jobs/${a.id}/notes`)).json()) as {
      text: string;
      atSec: number;
    }[];
    expect(notes.map((note) => note.text)).toEqual([
      'Use Blinding Lights instead.',
      'Use a trending song that fits the cut.',
    ]);
    // They are notes about the whole video, and the music is as it was until Send.
    expect(notes.every((note) => note.atSec === 0)).toBe(true);
    expect(await musicOf(a.id)).toMatchObject({ picked: 'song' });
    await shoot(page, 'mac-review-noted', testInfo);
  });

  await test.step('the notes are taken off (a note would make the footer say Send), then Approve', async () => {
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
    for (let left = 2; left > 0; left -= 1) {
      await dialog.getByRole('button', { name: 'Delete note' }).first().click();
      await expect(dialog.getByRole('button', { name: 'Delete note' })).toHaveCount(left - 1, RUN);
    }
    await expect(dialog).toContainText('right-click menu to render two files');
    await approveFromRowMenu(page, rowOf(page, JOB_A));
    await expect(dialog).toBeHidden();
    await expect(badge(rowOf(page, JOB_A), 'Approved')).toBeVisible(RUN);
  });

  await test.step('the engine makes the file without the song next to the export', async () => {
    await expect.poll(() => existsSync(exportOf(JOB_A)), RUN).toBe(true);
    await expect.poll(() => existsSync(exportOf(JOB_A, ' · no song')), RUN).toBe(true);
    const status = await (await fetch(`${engine.baseURL}/api/jobs/${a.id}/no-song`)).json();
    expect(status).toMatchObject({ state: 'ready', file: `${JOB_A} · no song.mp4` });
    // With the song the export has its tone; without it the music is silenced.
    expect(isSilent(await audioFingerprint(exportOf(JOB_A)))).toBe(false);
    expect((await audioFingerprint(exportOf(JOB_A, ' · no song'))).durationSec).toBeGreaterThan(3);
  });

  await test.step('the sheet: two files, the line to post, Copy', async () => {
    await rowOf(page, JOB_A).click({ position: { x: 6, y: 22 } });
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(
      'Approved and rendered. Two files: one with the song, to show the client, and one without it, to post.',
      RUN,
    );
    const files = sheet.locator('[data-slot="song-files"]');
    await expect(files.locator('[data-song-file], [data-sheet-download]')).not.toHaveCount(0);
    const withSong = files.locator('[data-sheet-download="with-song"]');
    const withoutSong = files.locator('[data-sheet-download="no-song"]');
    await expect(withSong).toBeVisible();
    await expect(withoutSong).toBeVisible();
    await expect(files).toContainText(`${JOB_A}.mp4`);
    await expect(files).toContainText('With the song · to show the client');
    await expect(files).toContainText(`${JOB_A} · no song.mp4`);
    await expect(files).toContainText('Without it · to post');

    // Both Downloads hand out an MP4 under the right name.
    for (const [link, name] of [
      [withSong, `${JOB_A}.mp4`],
      [withoutSong, `${JOB_A} · no song.mp4`],
    ] as const) {
      const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
      expect(download.suggestedFilename()).toBe(name);
      const path = await download.path();
      expect(isMp4(await readFile(path))).toBe(true);
    }

    const post = sheet.locator('[data-slot="song-post"]');
    const line = `Post “${JOB_A} · no song.mp4”. In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:19. That way the reel counts toward the song’s trend.`;
    await expect(post.locator('[data-slot="song-post-text"]')).toHaveText(line);
    await expect(post).toContainText('Copy it and send it to Yael with the file.');
    const copy = post.locator('[data-sheet-copy-line]');
    await expect(copy).toHaveText('Copy');
    await copy.click();
    await expect(copy).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);

    // Details and History say where the song came from.
    const music = sheet.locator('[data-detail="Music"]');
    await expect(music).toContainText('נתתי לך בית · Ofek Adanek');
    await expect(music).toContainText('From Yael’s screenshot (IMG_4412.PNG)');
    await expect(music).toContainText('the part used, 0:19 to 0:25');
    await shoot(page, 'mac-sheet-two-files', testInfo);
    await sheet.getByRole('button', { name: /^History/ }).click();
    await expect(sheet.getByText(/^The brief found the song on Yael’s screenshot/)).toBeVisible();
    await expect(sheet.getByText(/^Got the song from YouTube Music/)).toBeVisible();
    await expect(sheet.getByText('Rendered with the song, and without it')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('a screenshot that asks for a trending song: the editor’s pick and its numbers', async () => {
    const b = await sendWithPicture(page, JOB_B, 'trending-request.png');
    const music = await musicOf(b.id);
    expect(music).toMatchObject({ picked: 'song', songFailure: null });
    expect(music.song).toMatchObject({
      ...TRENDING,
      asked: { from: 'trending', by: 'editor', file: null },
      trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
    });

    await openReview(page, JOB_B);
    const list = await openList(page, dialog);
    await expect(list.locator('[data-slot="music-source"]')).toContainText(
      'Picked by the editor · rising on Reels in #fpv',
    );
    const row = musicRow(list, 'song');
    await expect(row).toContainText(TRENDING.title);
    await expect(row.locator('[data-slot="music-artist"]')).toHaveText(TRENDING.artist);
    await expect(row).toContainText(
      'In 18.4K reels. 3 of the top 20 #fpv reels this month use it. The cuts sit on its beat.',
    );
    await shoot(page, 'mac-review-trending', testInfo);
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step('a song the downloader cannot get: ElevenLabs’s tone plays and the box says why', async () => {
    const c = await sendWithPicture(page, JOB_C, 'fail-request.png');
    const music = await musicOf(c.id);
    expect(music.song).toBeNull();
    expect(music.songFailure).toMatchObject({ code: 'unavailable' });
    // The edit made v1 instead, as the prompt says.
    expect(music).toMatchObject({ source: 'made', picked: 'v1' });
    expect(music.versions.map((version) => version.id)).toEqual(['v1']);

    await openReview(page, JOB_C);
    const list = await openList(page, dialog);
    const alert = list.locator('[data-slot="music-alert"]');
    await expect(alert).toContainText('Couldn’t get the song');
    await expect(alert).toContainText('The downloader didn’t answer');
    await expect(alert).toContainText('Paste a YouTube link or type the song’s name');
    await expect(musicRow(list, 'v1')).toHaveAttribute('aria-checked', 'true');
    await expect(list.getByRole('tab', { name: 'Use a song' })).toBeVisible();
    await shoot(page, 'mac-review-fallback', testInfo);
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step('a screenshot that says “Original audio”: v1 plays, and Review and the sheet ask for the reel’s link', async () => {
    const d = await sendWithPicture(page, JOB_D, 'original-audio.png');
    const brief = JSON.parse(await readFile(join(editDir(JOB_D), 'brief.json'), 'utf8')) as {
      music: { song: unknown; original: unknown; wantsTrending: boolean };
    };
    expect(brief.music).toMatchObject({
      song: null,
      original: { by: '@reels.creator' },
      wantsTrending: false,
    });

    // No song is looked up. The edit made v1 and noted why with the song-note command.
    const music = await musicOf(d.id);
    expect(music.song).toBeNull();
    expect(music.songFailure).toMatchObject({
      code: 'original_audio',
      asked: 'Original audio · @reels.creator',
    });
    expect(music).toMatchObject({ source: 'made', picked: 'v1' });
    expect(music.versions.map((version) => version.id)).toEqual(['v1']);

    await openReview(page, JOB_D);
    const list = await openList(page, dialog);
    const alert = list.locator('[data-slot="music-alert"]');
    await expect(alert).toHaveAttribute('data-tone', 'plain');
    await expect(alert).toContainText('No song name on the screenshot');
    await expect(alert).toContainText(
      'It says “Original audio · @reels.creator”, so there’s nothing to look up.',
    );
    await expect(alert).toContainText(
      'Paste that reel’s link and the editor takes the song from it.',
    );
    await expect(musicRow(list, 'v1')).toHaveAttribute('aria-checked', 'true');
    await shoot(page, 'mac-review-original-audio', testInfo);
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();

    // The sheet's Music row says it plainly too, with the version ElevenLabs made.
    await rowOf(page, JOB_D).click({ position: { x: 6, y: 22 } });
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    const row = sheet.locator('[data-detail="Music"]');
    await expect(row).toContainText('Original audio');
    await expect(row).toContainText(
      'The screenshot says “Original audio · @reels.creator”, so there’s nothing to look up. ElevenLabs made v1 instead.',
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  expect(pageErrors).toEqual([]);
});

test('Another song and Pick a trending one go to the editor on Send: the new song is picked, asked for by you', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await openApp(page, engine.baseURL);
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();

  const dialog = reviewDialog(page);
  const roundFile = (round: number): Promise<string> =>
    readFile(join(editDir(JOB_E), 'review', `round-${round}.md`), 'utf8');

  /** With a note added in the open Music list: closes the list and sends it; the dialog goes. */
  async function sendNote(): Promise<void> {
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Send 1 note', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Send 1 note', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Sent 1 note' }),
    ).toBeVisible();
  }

  let e = await sendWithPicture(page, JOB_E, 'IMG_4412.PNG');

  await test.step('the edit starts on Yael’s song, from her screenshot', async () => {
    const music = await musicOf(e.id);
    expect(music).toMatchObject({ source: 'song', picked: 'song', songFailure: null });
    expect(music.song).toMatchObject({ ...SONG, asked: { from: 'screenshot', by: 'brief' } });
  });

  await test.step('Another song with a name, then Send: the editor gets that song, asked for by you from your note', async () => {
    await openReview(page, JOB_E);
    const list = await openList(page, dialog);
    await list.getByLabel('A link or a song name').fill('Blinding Lights by The Weeknd');
    await list.getByRole('button', { name: 'Add to notes' }).click();
    await expect(list.locator('[data-slot="music-noted"]')).toContainText(
      '“Use Blinding Lights by The Weeknd instead.”',
      RUN,
    );
    // Nothing changes until Send: the song that plays is still Yael’s.
    expect((await musicOf(e.id)).song).toMatchObject(SONG);
    await sendNote();

    e = await backInReview(JOB_E, 1);
    expect(await roundFile(1)).toContain('- 0:00.0 — Use Blinding Lights by The Weeknd instead.');
    const music = await musicOf(e.id);
    expect(music).toMatchObject({ source: 'song', picked: 'song', songFailure: null });
    expect(music.song).toMatchObject({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      asked: { from: 'note', by: 'you', file: null },
      source: { site: 'youtube-music', via: 'yt-dlp' },
      part: { startMs: 19_100, endMs: 25_100, how: 'measured' },
      trending: null,
    });
    // The part is in place for the round’s cut, and the round’s composition plays it.
    const part = join(editDir(JOB_E), 'music', 'song.mp3');
    expect(
      (await readFile(part)).equals(await readFile(join(editDir(JOB_E), 'preview', 'music.mp3'))),
    ).toBe(true);
    expect(await readFile(join(editDir(JOB_E), 'preview', 'index.html'), 'utf8')).toContain(
      '<title>Round 1</title>',
    );

    await openReview(page, JOB_E);
    const row = musicRow(await openList(page, dialog), 'song');
    await expect(musicList(page).locator('[data-slot="music-source"]')).toContainText(
      'The song you asked for · from your note',
    );
    await expect(row).toContainText('Blinding Lights');
    await expect(row.locator('[data-slot="music-artist"]')).toHaveText('The Weeknd');
    await expect(row).toContainText('in the preview');
    await shoot(page, 'mac-review-note-song', testInfo);
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
  });

  await test.step('Pick a trending one, then Send: the editor’s pick, asked for by you from trending', async () => {
    const list = await openList(page, dialog);
    const trend = list.locator('[data-slot="music-trend"]');
    await expect(trend).toHaveText('Pick a trending one');
    await trend.click();
    await expect(trend).toHaveText('Added to your notes', RUN);
    await sendNote();

    e = await backInReview(JOB_E, 2);
    expect(await roundFile(2)).toContain('- 0:00.0 — Use a trending song that fits the cut.');
    const music = await musicOf(e.id);
    expect(music).toMatchObject({ source: 'song', picked: 'song', songFailure: null });
    expect(music.song).toMatchObject({
      ...TRENDING,
      asked: { from: 'trending', by: 'you', file: null },
      trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
    });

    await openReview(page, JOB_E);
    const row = musicRow(await openList(page, dialog), 'song');
    await expect(musicList(page).locator('[data-slot="music-source"]')).toContainText(
      'Picked by the editor · rising on Reels in #fpv',
    );
    await expect(row).toContainText(TRENDING.title);
    await expect(row.locator('[data-slot="music-artist"]')).toHaveText(TRENDING.artist);
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
  });

  await test.step('a song that cannot be got: the music stays as it was and the box says why', async () => {
    const list = await openList(page, dialog);
    await list.getByLabel('A link or a song name').fill('Fail Song');
    await list.getByRole('button', { name: 'Add to notes' }).click();
    await expect(list.locator('[data-slot="music-noted"]')).toContainText(
      '“Use Fail Song instead.”',
      RUN,
    );
    await sendNote();

    e = await backInReview(JOB_E, 3);
    expect(await roundFile(3)).toContain('- 0:00.0 — Use Fail Song instead.');
    const music = await musicOf(e.id);
    expect(music).toMatchObject({ source: 'song', picked: 'song' });
    expect(music.songFailure).toMatchObject({ code: 'unavailable' });
    // The song that was playing is still the song.
    expect(music.song).toMatchObject({
      ...TRENDING,
      asked: { from: 'trending', by: 'you', file: null },
    });

    await openReview(page, JOB_E);
    const after = await openList(page, dialog);
    const alert = after.locator('[data-slot="music-alert"]');
    await expect(alert).toContainText('Couldn’t get the song');
    await expect(alert).toContainText('The downloader didn’t answer');
    const row = musicRow(after, 'song');
    await expect(row).toHaveAttribute('aria-checked', 'true');
    await expect(row).toContainText(TRENDING.title);
    await shoot(page, 'mac-review-note-song-failed', testInfo);
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  expect(pageErrors).toEqual([]);
});
