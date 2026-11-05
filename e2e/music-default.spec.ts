// CVP-445 (U22): music and songs are on in the app with nothing set, and still make nothing unasked.
// The one check of the default, on the built server with the fake runner and NO music or songs
// setting (`music: 'default'`, `songs: 'default'`: the helper sends neither STUDIO_MUSIC nor
// STUDIO_SONGS, so the engine's own defaults decide; every other spec pins them off or on):
//
//   /api/health         music and songs are both true
//   the routes          the music route and the song routes (the note's pictures, the second export)
//                       exist for a job
//   a plain job         with no ask for music, the edit makes none: music.json says "none" with the reason
//                       "Music was not asked for.", nothing is made, and Review's Music list says "No music
//                       asked for. Nothing was made."

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import { badge, rowOf } from './support/jobs-ui.ts';
import { openApp } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Plain cut';
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 10);
const RUN = { timeout: 90_000 };

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 20_000,
    fakeSpeed: FAKE_SPEED,
    music: 'default',
    songs: 'default',
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

async function jobNamed(name: string): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === name);
  expect(job, `the server lists "${name}"`).toBeDefined();
  return job as JobOnServer;
}

/** The job arrives (it stays Arriving: the settle time is long) and starts now, with no note. */
async function arriveAndStart(page: Page, job: string): Promise<JobOnServer> {
  await engine.createJob({ client: CLIENT, job });
  await expect(badge(rowOf(page, job), 'Arriving')).toBeVisible(RUN);
  const arrived = await jobNamed(job);
  const started = await fetch(`${engine.baseURL}/api/jobs/${arrived.id}/start`, { method: 'POST' });
  expect(started.status).toBe(200);
  let found = arrived;
  await expect
    .poll(async () => {
      found = await jobNamed(job);
      return found.state;
    }, RUN)
    .toBe('review');
  return found;
}

test('with nothing set, music and songs are on, and a job that asked for no music gets none', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const pageErrors = await openApp(page, engine.baseURL);
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();

  await test.step('/api/health says music and songs', async () => {
    const health = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
      music: boolean;
      songs?: boolean;
    };
    expect(health.music).toBe(true);
    expect(health.songs).toBe(true);
  });

  let job = { id: '' } as JobOnServer;
  await test.step('a plain job is edited and waits in Review', async () => {
    job = await arriveAndStart(page, JOB);
  });

  await test.step('its routes exist: the music record, the note’s pictures and the second export', async () => {
    const music = await fetch(`${engine.baseURL}/api/jobs/${job.id}/music`);
    expect(music.status).toBe(200);
    expect((await fetch(`${engine.baseURL}/api/jobs/${job.id}/note`)).status).toBe(200);
    expect((await fetch(`${engine.baseURL}/api/jobs/${job.id}/no-song`)).status).toBe(200);
  });

  await test.step('nothing was asked for, so nothing was made', async () => {
    const music = (await (await fetch(`${engine.baseURL}/api/jobs/${job.id}/music`)).json()) as {
      source: string;
      reason: string | null;
      picked: string | null;
      versions: unknown[];
    };
    expect(music).toMatchObject({
      source: 'none',
      reason: 'Music was not asked for.',
      picked: null,
      versions: [],
    });
    expect(existsSync(join(engine.inbox, CLIENT, JOB, 'edit', 'music', 'v1.mp3'))).toBe(false);
  });

  await test.step('Review’s Music list says it in plain words', async () => {
    await rowOf(page, JOB).getByRole('button', { name: 'Review' }).click();
    const dialog = page
      .locator('[role="dialog"]')
      .filter({ has: page.locator('[data-slot="preview-player"]') });
    await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 30_000 },
    );
    await dialog.locator('[data-slot="music-button"]').click();
    await expect(page.locator('[data-slot="music-list"] [data-slot="music-source"]')).toHaveText(
      'No music asked for. Nothing was made.',
    );
  });

  expect(pageErrors, 'the page threw no errors').toEqual([]);
});
