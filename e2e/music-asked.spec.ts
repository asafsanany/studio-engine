// CVP-444 (U21): music is made only when the job asks for it, on the built server with the fake runner
// and the Soundtrack and Songs switches on (`STUDIO_MUSIC=1`, `STUDIO_SONGS=1`: both are on in the
// app, and the engine helper pins them off for the specs that do not say). The fake Brief reads the owner's note and the folder's text files for
// an ask for music, the way the real Brief fills `music.wanted`, and the fake edit follows music.md:
//
//   no ask            the edit makes no music: music.json says "none" with the reason "Music was not
//                     asked for.", keeps the cut's plan and leaves silence at edit/preview/music.mp3 for
//                     the composition; brief.md says "Music: not asked for". Review's Music list says
//                     "No music asked for" and offers Use a song and Make music (the engine allows it);
//                     the job sheet says "No music asked for". Make music makes v1 from the kept plan
//                     and picks it; Approve of a job that never got music exports in silence
//   a note says       "Add music with a steady beat." in the job's note: the Brief says music.wanted, brief.md
//   "add music"       says "Music: asked for, made by the editor", and the edit makes v1, as it always did
//
// Three jobs share one engine, with a long settle time so each stays "Arriving" while its note is saved.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { approveFromRowMenu } from './support/approve-ui.ts';
import { audioFingerprint, isSilent } from './support/audio.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { badge, rowOf } from './support/jobs-ui.ts';
import { openApp, sheetOf } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const UNASKED = 'Plain cut';
const UNASKED_SILENT = 'Plain export';
const ASKED = 'Note says music';
const NOTE = 'Add music with a steady beat.';

const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 10);
const RUN = { timeout: 90_000 };
const REASON = 'Music was not asked for.';

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 20_000,
    fakeSpeed: FAKE_SPEED,
    music: true,
    songs: true,
  });
});

test.afterEach(async ({ browserName: _browser }, testInfo) => {
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
  source: string;
  reason: string | null;
  picked: string | null;
  canMake: boolean;
  whyNot: string | null;
  making: { id: string } | null;
  plan: { lengthMs: number } | null;
  versions: { id: string; by: string }[];
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

async function send(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<number> {
  const response = await fetch(`${engine.baseURL}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status;
}

const editDir = (job: string): string => join(engine.inbox, CLIENT, job, 'edit');
const musicFile = (job: string, name: string): string => join(editDir(job), 'music', name);
const previewMusic = (job: string): string => join(editDir(job), 'preview', 'music.mp3');
const exportOf = (job: string): string => join(engine.exportsDir, CLIENT, `${job}.mp4`);

/** The job arrives (it stays Arriving: the settle time is long), optionally takes a note, and starts now. */
async function arriveAndStart(page: Page, job: string, note?: string): Promise<JobOnServer> {
  await engine.createJob({ client: CLIENT, job });
  await expect(badge(rowOf(page, job), 'Arriving')).toBeVisible(RUN);
  const arrived = await jobNamed(job);
  if (note !== undefined) expect(await send('PUT', `/jobs/${arrived.id}/note`, { note })).toBe(200);
  expect(await send('POST', `/jobs/${arrived.id}/start`)).toBe(200);
  let found = arrived;
  await expect
    .poll(async () => {
      found = await jobNamed(job);
      return found.state;
    }, RUN)
    .toBe('review');
  return found;
}

const reviewDialog = (page: Page): Locator =>
  page.locator('[role="dialog"]').filter({ has: page.locator('[data-slot="preview-player"]') });
const musicButton = (dialog: Locator): Locator => dialog.locator('[data-slot="music-button"]');
const musicList = (page: Page): Locator => page.locator('[data-slot="music-list"]');
const musicRow = (list: Locator, id: string): Locator => list.locator(`[data-row="${id}"]`);

async function openReview(page: Page, name: string): Promise<Locator> {
  await rowOf(page, name).getByRole('button', { name: 'Review' }).click();
  const dialog = reviewDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 30_000 },
  );
  return dialog;
}

test('a job that asked for no music gets none, Review says so and can still make some; a note that says “add music” gets it', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await openApp(page, engine.baseURL);
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();

  let unasked = { id: '' } as JobOnServer;
  let silent = { id: '' } as JobOnServer;
  let asked = { id: '' } as JobOnServer;

  await test.step('three jobs are edited: two with no ask, one whose note asks for music', async () => {
    unasked = await arriveAndStart(page, UNASKED);
    silent = await arriveAndStart(page, UNASKED_SILENT);
    asked = await arriveAndStart(page, ASKED, NOTE);
  });

  await test.step('the job with no ask: music.json says none, with its plan and silence; nothing was made', async () => {
    const music = await musicOf(unasked.id);
    expect(music).toMatchObject({
      source: 'none',
      reason: REASON,
      picked: null,
      making: null,
      versions: [],
      // Make music is allowed: there is a plan to make from (the fake cut is 6 s).
      canMake: true,
      whyNot: null,
    });
    expect(music.plan?.lengthMs).toBe(6_000);

    expect(existsSync(join(editDir(UNASKED), 'music', 'plan.json'))).toBe(true);
    expect(existsSync(join(editDir(UNASKED), 'music', 'music.json'))).toBe(true);
    expect(existsSync(musicFile(UNASKED, 'v1.mp3'))).toBe(false);
    // The composition keeps its music.mp3 (silence of the cut's length) and plays it.
    const silence = await audioFingerprint(previewMusic(UNASKED));
    expect(isSilent(silence)).toBe(true);
    expect(silence.durationSec).toBeGreaterThan(5.5);
    const composition = await readFile(join(editDir(UNASKED), 'preview', 'index.html'), 'utf8');
    expect(composition).toContain('src="music.mp3"');

    // The brief said so too, in the editor's words.
    const brief = JSON.parse(await readFile(join(editDir(UNASKED), 'brief.json'), 'utf8')) as {
      music: unknown;
    };
    expect(brief.music).toBeNull();
    expect(await readFile(join(editDir(UNASKED), 'brief.md'), 'utf8')).toContain(
      '- Music: not asked for',
    );
  });

  await test.step('the job sheet says “No music asked for”', async () => {
    await rowOf(page, UNASKED).click({ position: { x: 6, y: 22 } });
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();
    const detail = sheet.locator('[data-detail="Music"]');
    await expect(detail).toContainText('No music asked for');
    await expect(detail.locator('[data-detail-sub="Music"]')).toContainText('Nothing was made.');
    await expect(sheet.locator('[data-detail="Music"]')).not.toContainText(REASON);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('Review says it in plain words and offers a song and Make music; Make one makes v1', async () => {
    const dialog = await openReview(page, UNASKED);
    await expect(musicButton(dialog)).toContainText('off');
    await expect(dialog).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, without music.',
    );

    await musicButton(dialog).click();
    const list = musicList(page);
    await expect(list).toBeVisible();
    await expect(list.locator('[data-slot="music-source"]')).toHaveText(
      'No music asked for. Nothing was made.',
    );
    await expect(musicRow(list, 'off')).toHaveAttribute('aria-checked', 'true');
    await expect(list.locator('[data-row]')).toHaveCount(1);
    await expect(list.getByRole('tab', { name: 'Use a song' })).toBeVisible();
    const makeTab = list.getByRole('tab', { name: 'Make music', exact: true });
    await expect(makeTab).toBeVisible();

    await makeTab.click();
    await expect(list.getByRole('button', { name: 'Make one' })).toBeEnabled();
    await list.getByRole('button', { name: 'Make one' }).click();

    await expect(musicRow(list, 'v1')).toHaveAttribute('aria-checked', 'true', RUN);
    await expect(dialog).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v1.',
    );
    const music = await musicOf(unasked.id);
    expect(music).toMatchObject({ source: 'made', reason: null, picked: 'v1', making: null });
    expect(music.versions).toHaveLength(1);
    expect(music.versions[0]).toMatchObject({ id: 'v1', by: 'you' });
    expect(
      (await readFile(musicFile(UNASKED, 'v1.mp3'))).equals(await readFile(previewMusic(UNASKED))),
    ).toBe(true);
    expect(isSilent(await audioFingerprint(previewMusic(UNASKED)))).toBe(false);
    await page.keyboard.press('Escape'); // the list
    await expect(musicList(page)).toBeHidden();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step('the job whose note says “add music” was made music by the edit', async () => {
    const music = await musicOf(asked.id);
    expect(music).toMatchObject({ source: 'made', reason: null, picked: 'v1' });
    expect(music.versions).toHaveLength(1);
    expect(music.versions[0]).toMatchObject({ id: 'v1', by: 'edit' });
    expect(existsSync(musicFile(ASKED, 'v1.mp3'))).toBe(true);

    const brief = JSON.parse(await readFile(join(editDir(ASKED), 'brief.json'), 'utf8')) as {
      music: { wanted: boolean; file: string | null };
    };
    expect(brief.music).toMatchObject({ wanted: true, file: null });
    expect(await readFile(join(editDir(ASKED), 'brief.md'), 'utf8')).toContain(
      '- Music: asked for, made by the editor',
    );
    const row = rowOf(page, ASKED);
    await row.click({ position: { x: 6, y: 22 } });
    const sheet = sheetOf(page);
    await expect(sheet.locator('[data-detail="Music"]')).toContainText('Made for this video · v1');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('a job that never got music exports in silence', async () => {
    expect(await musicOf(silent.id)).toMatchObject({
      source: 'none',
      reason: REASON,
      picked: null,
    });

    const dialog = await openReview(page, UNASKED_SILENT);
    await approveFromRowMenu(page, rowOf(page, UNASKED_SILENT));
    await expect(dialog).toBeHidden();
    await expect(badge(rowOf(page, UNASKED_SILENT), 'Approved')).toBeVisible(RUN);

    expect(existsSync(exportOf(UNASKED_SILENT)), 'the export is there').toBe(true);
    const sound = await audioFingerprint(exportOf(UNASKED_SILENT));
    expect(isSilent(sound), `the export is silent (rms ${sound.rms})`).toBe(true);
  });

  expect(pageErrors).toEqual([]);
});
