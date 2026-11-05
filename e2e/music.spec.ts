// CVP-287: Soundtrack, the whole music loop on the built server with the fake runner and the music
// switch on (`STUDIO_MUSIC=1`: it is on in the app, and the engine helper pins it off for the specs that do not say). The fake run
// makes music v1 through the music script's fake path (an ffmpeg tone, a different note for every
// version, silence for No music; no network, no ElevenLabs key), and Make another and Pick run the
// same script, so every button here reaches the real engine, the real routes and the real files.
//
//   a job edits       arrives -> edits -> Review with music v1: music.json, v1.mp3 and the copy the
//                     composition plays (edit/preview/music.mp3); the job sheet says "Made for this
//                     video · v1" and its History "Music v1 made"
//   Review            the Music button says "Music v1", its list has v1 (picked, "in the preview") and
//                     No music, and the footer says what Approve will render: "…with music v1."
//   Make v2 with      the words go to the script ("You asked: …"), v2 is made and picked, the button
//   words             and the footer follow ("…with music v2."), and the player loads the new music
//                     (the address carries the music's rev)
//   pick v1           the pick is v1 again, the player follows
//   No music          the pick is off, the footer says "…without music.", the preview plays silence
//   Approve           a render run follows and the export's sound is the pick: silence for No music, v2's
//                     note for a job that made v2, v1's note for one that kept v1 (read from the
//                     decoded audio of the export, compared with the version's own mp3)
//   refused           Make another and Pick are refused with the engine's words (409) while a job has
//                     only just arrived and is being edited, and after one was approved
//
// Job A walks the buttons; jobs B and C make the other two exports. The pitch of each version's
// tone is what tells them apart (support/audio.ts), so "the export has the pick" does not rest on
// a byte comparison that an AAC export could never pass.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { approveFromRowMenu } from './support/approve-ui.ts';
import { type AudioFingerprint, audioFingerprint, isSilent, sameSound } from './support/audio.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, rowOf } from './support/jobs-ui.ts';
import { openApp, sheetOf } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB_A = 'Soundtrack walk';
const JOB_B = 'Soundtrack v2';
const JOB_C = 'Soundtrack v1';
const WORDS = 'darker, more drums';

/** The fake edit's own speed: a whole edit takes a few seconds, so three of them queue quickly. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 10);
const RUN = { timeout: 90_000 };
/**
 * The export's length, in seconds: the fake render's clip (FakeRunner's default), or the 6 s
 * composition's when Approve used the Export MP4 the engine was already making in Review
 * (`ReviewExports.useFor`), which a few seconds in Review are enough for.
 */
const EXPORT_SECONDS = [4, 6];

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED, music: true });
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

/** What GET /api/jobs/:id/music answers: the parts these specs read. */
interface MusicOnServer {
  source: string;
  picked: string | null;
  canMake: boolean;
  whyNot: string | null;
  rev: number;
  making: { id: string } | null;
  plan: { lengthMs: number } | null;
  versions: { id: string; by: string; ask: string | null; describe: string; model: string }[];
  picks: { id: string }[];
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

async function call(
  method: 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: { error?: string } }> {
  const response = await fetch(`${engine.baseURL}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as { error?: string } };
}

const editDir = (job: string): string => join(engine.inbox, CLIENT, job, 'edit');
const musicFile = (job: string, name: string): string => join(editDir(job), 'music', name);
const previewMusic = (job: string): string => join(editDir(job), 'preview', 'music.mp3');
const exportOf = (job: string): string => join(engine.exportsDir, CLIENT, `${job}.mp4`);

/** The bytes of two files are the same. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  return (await readFile(a)).equals(await readFile(b));
}

/** The job is in Review with its music made: waits for it and returns the job. */
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

/**
 * The player of the open dialog is loaded with this music rev in its address (`&m=<rev>`). A new rev
 * loads in a second player behind the one on show and replaces it once it is ready, so the wait is
 * for the one player that is left.
 */
async function expectPlayerMusic(dialog: Locator, rev: number): Promise<void> {
  const players = dialog.locator('hyperframes-player');
  await expect(players).toHaveCount(1, { timeout: 30_000 });
  await expect(players).toHaveAttribute('src', new RegExp(`[?&]m=${rev}(&|$)`), {
    timeout: 30_000,
  });
}

/** Opens a job's Review from its row and waits for the player. */
async function openReview(page: Page, name: string): Promise<Locator> {
  const row = rowOf(page, name);
  await action(row, 'Review').click();
  const dialog = reviewDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 30_000 },
  );
  return dialog;
}

/**
 * The open Review dialog. Found by its role attribute and not by `getByRole`: while the Music list
 * is open (a modal popover) the dialog under it is `aria-hidden`, and a role query would not see it.
 */
const reviewDialog = (page: Page): Locator =>
  page.locator('[role="dialog"]').filter({ has: page.locator('[data-slot="preview-player"]') });

const musicButton = (dialog: Locator): Locator => dialog.locator('[data-slot="music-button"]');
const musicList = (page: Page): Locator => page.locator('[data-slot="music-list"]');

async function openList(page: Page, dialog: Locator): Promise<Locator> {
  await musicButton(dialog).click();
  const list = musicList(page);
  await expect(list).toBeVisible();
  return list;
}

/** A row of the open list ("v1", "v2", "off"), as the radio it is. */
const musicRow = (list: Locator, id: string): Locator => list.locator(`[data-row="${id}"]`);

/** Reads what a job's export sounds like and checks it was cut to the video's length. */
async function exportSound(job: string): Promise<AudioFingerprint> {
  expect(existsSync(exportOf(job)), 'the export is there').toBe(true);
  const sound = await audioFingerprint(exportOf(job));
  expect(
    EXPORT_SECONDS.some((seconds) => Math.abs(sound.durationSec - seconds) < 0.5),
    `the export is ${sound.durationSec} s`,
  ).toBe(true);
  return sound;
}

test('a job gets music, Review makes another and picks, and Approve renders with the pick', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const pageErrors = await openApp(page, engine.baseURL);
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();

  // Two jobs queue up; the engine edits them one after the other. Job C comes later.
  await engine.createJob({ client: CLIENT, job: JOB_A, asksMusic: true });
  await engine.createJob({ client: CLIENT, job: JOB_B, asksMusic: true });

  let a = { id: '' };
  let aV1 = '';

  await test.step('the job edits and comes back with music v1', async () => {
    a = await inReview(JOB_A);
    await expect(badge(rowOf(page, JOB_A), 'Review')).toBeVisible(RUN);

    const music = await musicOf(a.id);
    expect(music).toMatchObject({
      source: 'made',
      picked: 'v1',
      canMake: true,
      whyNot: null,
      making: null,
    });
    expect(music.versions).toHaveLength(1);
    expect(music.versions[0]).toMatchObject({ id: 'v1', by: 'edit', ask: null, model: 'fake' });
    expect(music.rev).toBeGreaterThan(0);
    // The record's plan is the cut's length (the fake cut is 6 s).
    expect(music.plan?.lengthMs).toBe(6_000);

    // The files: the version, and the copy the composition plays, which is the pick.
    aV1 = musicFile(JOB_A, 'v1.mp3');
    expect(existsSync(musicFile(JOB_A, 'music.json'))).toBe(true);
    expect(existsSync(musicFile(JOB_A, 'plan.json'))).toBe(true);
    expect(existsSync(aV1)).toBe(true);
    expect(await sameBytes(aV1, previewMusic(JOB_A))).toBe(true);
    const composition = await readFile(join(editDir(JOB_A), 'preview', 'index.html'), 'utf8');
    expect(composition).toContain('src="music.mp3"');
  });

  await test.step('the job sheet says where the music came from', async () => {
    const row = rowOf(page, JOB_A);
    await row.click({ position: { x: 6, y: 22 } });
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    const detail = sheet.locator('[data-detail="Music"]');
    await expect(detail).toContainText('Made for this video · v1');
    await expect(detail.locator('[data-detail-sub="Music"]')).toContainText('fake tone');

    await sheet.getByRole('button', { name: /^History/ }).click();
    await expect(sheet.getByText(/^Music v1 made/)).toBeVisible();
    // The make recorded its own pick; nobody chose it, so History does not say "You picked".
    await expect(sheet.getByText('You picked music v1')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  const dialog = reviewDialog(page);
  let rev1 = 0;

  await test.step('Review: the Music button, the list and the footer say v1', async () => {
    await openReview(page, JOB_A);
    await expect(musicButton(dialog)).toContainText('Music');
    await expect(musicButton(dialog)).toContainText('v1');
    await expect(dialog).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v1.',
    );
    await expect(dialog).toContainText('Music v1');
    rev1 = (await musicOf(a.id)).rev;
    await expectPlayerMusic(dialog, rev1);

    const list = await openList(page, dialog);
    await expect(list).toContainText('Made for this video by ElevenLabs');
    await expect(musicRow(list, 'v1')).toHaveAttribute('aria-checked', 'true');
    await expect(musicRow(list, 'v1')).toContainText('in the preview');
    await expect(musicRow(list, 'off')).toHaveAttribute('aria-checked', 'false');
    await expect(list.getByRole('button', { name: 'Make v2' })).toBeEnabled();
  });

  await test.step('Make v2 with words: v2 is made and picked, and the player loads it', async () => {
    const list = musicList(page);
    await list.getByLabel('Make another').fill(WORDS);
    await list.getByRole('button', { name: 'Make v2' }).click();

    await expect(musicRow(list, 'v2')).toHaveAttribute('aria-checked', 'true', RUN);
    await expect(musicRow(list, 'v1')).toHaveAttribute('aria-checked', 'false');
    await expect(musicRow(list, 'v2')).toContainText(`You asked: ${WORDS}`);
    // The words box is emptied for the next one, and the next one is v3.
    await expect(list.getByLabel('Make another')).toHaveValue('');
    await expect(list.getByRole('button', { name: 'Make v3' })).toBeEnabled();

    const music = await musicOf(a.id);
    expect(music).toMatchObject({ picked: 'v2', making: null });
    expect(music.versions.map((version) => version.id)).toEqual(['v1', 'v2']);
    expect(music.versions[1]).toMatchObject({ by: 'you', ask: WORDS, model: 'fake' });
    expect(music.versions[1]?.describe).toContain(`You asked: ${WORDS}`);
    expect(music.rev).not.toBe(rev1);
    expect(await sameBytes(musicFile(JOB_A, 'v2.mp3'), previewMusic(JOB_A))).toBe(true);
    // v1 is kept as it was made.
    expect(await sameBytes(aV1, musicFile(JOB_A, 'v1.mp3'))).toBe(true);

    // What the dialog says follows: the button, the footer, the controls' bar, and the player's
    // address, which now carries the new rev so the player loaded the new music.
    await expect(musicButton(dialog)).toContainText('v2');
    await expect(dialog).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v2.',
    );
    await expectPlayerMusic(dialog, music.rev);
  });

  await test.step('pick v1 again', async () => {
    const list = musicList(page);
    await musicRow(list, 'v1').click();
    await expect(musicRow(list, 'v1')).toHaveAttribute('aria-checked', 'true', RUN);
    await expect(dialog).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v1.',
    );

    const music = await musicOf(a.id);
    expect(music.picked).toBe('v1');
    expect(await sameBytes(aV1, previewMusic(JOB_A))).toBe(true);
    await expectPlayerMusic(dialog, music.rev);
  });

  await test.step('No music: the pick is off and the preview plays silence', async () => {
    const list = musicList(page);
    await musicRow(list, 'off').click();
    await expect(musicRow(list, 'off')).toHaveAttribute('aria-checked', 'true', RUN);
    await expect(list).toContainText('The video plays and renders without music.');
    await expect(dialog).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, without music.',
    );
    await expect(musicButton(dialog)).toContainText('off');

    const music = await musicOf(a.id);
    expect(music.picked).toBe('off');
    expect(music.picks.map((pick) => pick.id)).toEqual(['v1', 'v2', 'v1', 'off']);
    // The composition keeps its music lane: the file is there, and it is silence.
    const silence = await audioFingerprint(previewMusic(JOB_A));
    expect(isSilent(silence)).toBe(true);
    expect(silence.durationSec).toBeGreaterThan(5.5);
    // The versions are still what they were.
    expect(isSilent(await audioFingerprint(aV1))).toBe(false);
    await expectPlayerMusic(dialog, music.rev);
  });

  await test.step('the engine refuses a change while a job is still being edited', async () => {
    // Job C has only just arrived (then it waits in the queue, then it edits): its music is not
    // Review's to change until it comes back.
    await engine.createJob({ client: CLIENT, job: JOB_C, asksMusic: true });
    await expect
      .poll(() =>
        jobNamed(JOB_C).then(
          (job) => job.state,
          () => null,
        ),
      )
      .not.toBeNull();
    const c = await jobNamed(JOB_C);
    expect(c.state).not.toBe('review');
    expect(await call('POST', `/jobs/${c.id}/music`, {})).toEqual({
      status: 409,
      json: { error: 'Music can be changed while the video waits for your review.' },
    });
    expect(await call('PUT', `/jobs/${c.id}/music/pick`, { id: 'off' })).toEqual({
      status: 409,
      json: { error: 'Music can be changed while the video waits for your review.' },
    });
  });

  await test.step('Approve renders, and the export is silent: No music was the pick', async () => {
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
    await approveFromRowMenu(page, rowOf(page, JOB_A));
    await expect(dialog).toBeHidden();
    await expect(badge(rowOf(page, JOB_A), 'Approved')).toBeVisible(RUN);

    const sound = await exportSound(JOB_A);
    expect(isSilent(sound), `the export of ${JOB_A} is silent (rms ${sound.rms})`).toBe(true);
    // The pick stays in the record, and the sheet says so.
    expect((await musicOf(a.id)).picked).toBe('off');
  });

  await test.step('refused after the approval too, in the engine’s words', async () => {
    const approved = await musicOf(a.id);
    expect(approved).toMatchObject({
      canMake: false,
      whyNot: 'Music can be changed while the video waits for your review.',
    });
    expect(await call('POST', `/jobs/${a.id}/music`, { ask: 'louder' })).toEqual({
      status: 409,
      json: { error: 'Music can be changed while the video waits for your review.' },
    });
    expect(await call('PUT', `/jobs/${a.id}/music/pick`, { id: 'v1' })).toEqual({
      status: 409,
      json: { error: 'Music can be changed while the video waits for your review.' },
    });
    // Nothing moved.
    expect((await musicOf(a.id)).picked).toBe('off');

    const row = rowOf(page, JOB_A);
    await row.click({ position: { x: 6, y: 22 } });
    const sheet = sheetOf(page);
    await expect(sheet.locator('[data-detail="Music"]')).toContainText('None · you turned it off');
    await sheet.getByRole('button', { name: /^History/ }).click();
    await expect(sheet.getByText(`Music v2 made · you asked: ${WORDS}`)).toBeVisible();
    await expect(sheet.getByText('You turned the music off')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('job B makes v2 (no words) and the export has v2’s music', async () => {
    const b = await inReview(JOB_B);
    await openReview(page, JOB_B);
    const list = await openList(page, dialog);
    await list.getByRole('button', { name: 'Make v2' }).click();
    await expect(musicRow(list, 'v2')).toHaveAttribute('aria-checked', 'true', RUN);
    await expect(dialog).toContainText('with music v2.');
    const music = await musicOf(b.id);
    expect(music.versions[1]).toMatchObject({ id: 'v2', by: 'you', ask: null });

    await page.keyboard.press('Escape');
    await approveFromRowMenu(page, rowOf(page, JOB_B));
    await expect(dialog).toBeHidden();
    await expect(badge(rowOf(page, JOB_B), 'Approved')).toBeVisible(RUN);

    const v1 = await audioFingerprint(musicFile(JOB_B, 'v1.mp3'));
    const v2 = await audioFingerprint(musicFile(JOB_B, 'v2.mp3'));
    expect(sameSound(v1, v2), 'the two versions sound different').toBe(false);
    const sound = await exportSound(JOB_B);
    expect(sameSound(v2, sound), `the export (${sound.hz} Hz) has v2 (${v2.hz} Hz)`).toBe(true);
    expect(sameSound(v1, sound)).toBe(false);
  });

  await test.step('job C keeps v1 and the export has v1’s music', async () => {
    const c = await inReview(JOB_C);
    expect((await musicOf(c.id)).picked).toBe('v1');
    await openReview(page, JOB_C);
    await expect(dialog).toContainText('with music v1.');
    await approveFromRowMenu(page, rowOf(page, JOB_C));
    await expect(dialog).toBeHidden();
    await expect(badge(rowOf(page, JOB_C), 'Approved')).toBeVisible(RUN);

    const v1 = await audioFingerprint(musicFile(JOB_C, 'v1.mp3'));
    const sound = await exportSound(JOB_C);
    expect(isSilent(v1)).toBe(false);
    expect(sameSound(v1, sound), `the export (${sound.hz} Hz) has v1 (${v1.hz} Hz)`).toBe(true);
  });

  expect(pageErrors).toEqual([]);
});
