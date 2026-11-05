// PH21: a series on the phone, on the built server with the fake runner and the fake style runner,
// with the Series and Phone switches left at their defaults (on), in Chrome at the design boards'
// size (390×844, touch, an iPhone user agent; the `phone` project). The series is made through the
// API (Start a series stays on the Mac): "Weekly Tips 1" is approved and becomes the format, and
// the folder "Weekly Tips 2" joins it as episode 2. The tests run in order and share the engine.
//
//   list      the format job's row has the Layers2 mark "The format of the series Weekly Tips", the
//             episode's "Episode 2 of Weekly Tips", and while the episode edits its detail says
//             "follows episode 1" (board MJobsSeries); a job in no series has no mark
//   sheet     the episode's sheet says "Acme · Episode 2 of Weekly Tips" and so does the format's
//             ("The format of the series …"); neither has a series row in its list (Start a series,
//             Use as the series format, the Series submenu and Open the series stay on the Mac)
//   review    a job in no series is the review it was: "Add to style" alone, and no episode in the
//             header. The episode's header says "Acme · Episode 2 of Weekly Tips · Preview video"
//             and each note has Series and Style (short labels, aria-pressed, filled when on);
//             each adds its line under the note, the server has the flags, and Send writes the
//             Series note into the series folder (K8's payload) and not the other (board MReviewSeries)
//
// 390×844 screenshots are attached to the report, and written to $PHONE_SHOTS_DIR when it is set.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { badge, rowOf } from '../support/jobs-ui.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ mode: 'serial' });

const REVIEW = '[data-slot="phone-review"]';
const PLAYER = `${REVIEW} [data-slot="preview-player"]`;
const NOTES = `${REVIEW} [data-slot="phone-review-notes"]`;
const SHEET = '[data-slot="phone-job-sheet"]';

/** The localStorage keys of the web app: "What's new" seen, the Add to Home Screen card away. */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

const WAIT = { timeout: 90_000 };
const RUN = { timeout: 60_000 };
const CLIENT = 'Acme';
const SERIES = 'Weekly Tips';
const FORMAT_JOB = `${SERIES} 1`;
const EPISODE_JOB = `${SERIES} 2`;
const PLAIN_JOB = 'Pilot cut';

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  clientId: string;
  seriesId: string | null;
  episode: number | null;
}

interface SeriesOnServer {
  id: string;
  name: string;
  state: 'learning' | 'ready' | 'failed';
  formatJob: string;
}

interface NoteOnServer {
  id: string;
  atSec: number;
  text: string | null;
  addToStyle: boolean;
  addToSeries: boolean;
}

let engine: Engine;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${engine.baseURL}/api${path}`, init);
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const jobs = (await (await api('/jobs')).json()) as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === name);
  if (job === undefined) throw new Error(`no job named ${name}`);
  return job;
}

/** Waits until the job named `name` is in a state `until` accepts, and returns it. */
async function follow(name: string, until: (job: JobOnServer) => boolean): Promise<JobOnServer> {
  let last: JobOnServer | undefined;
  await expect
    .poll(async () => {
      last = await jobNamed(name).catch(() => undefined);
      return last !== undefined && until(last);
    }, WAIT)
    .toBe(true);
  return last as JobOnServer;
}

async function seriesOf(clientId: string): Promise<SeriesOnServer[]> {
  const answer = (await (await api(`/clients/${clientId}/series`)).json()) as {
    series: SeriesOnServer[];
  };
  return answer.series;
}

/** Waits until the client's style has been written and none of its series is learning. */
async function waitForPasses(clientId: string): Promise<void> {
  await expect
    .poll(async () => {
      const style = (await (await api(`/clients/${clientId}/style`)).json()) as {
        state: string;
        markdown: string | null;
      };
      const learning = (await seriesOf(clientId)).some((series) => series.state === 'learning');
      return style.state === 'ready' && style.markdown !== null && !learning;
    }, RUN)
    .toBe(true);
}

async function notesOf(jobId: string): Promise<NoteOnServer[]> {
  return (await (await api(`/jobs/${jobId}/notes`)).json()) as NoteOnServer[];
}

async function addNote(jobId: string, atSec: number, text: string): Promise<void> {
  const response = await api(`/jobs/${jobId}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ atSec, text }),
  });
  expect(response.status).toBe(201);
}

/**
 * Opens the app on a phone with a notch and a home indicator (47 px and 34 px, as on the boards),
 * in a browser that has seen this version's "What's new"; returns the page's errors.
 */
async function open(page: Page, path = '/jobs'): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  });
  const { version } = (await (await api('/health')).json()) as { version: string };
  await page.addInitScript(
    ([seen, current, card]) => {
      localStorage.setItem(seen as string, current as string);
      localStorage.setItem(card as string, String(Date.now()));
    },
    [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  return pageErrors;
}

/** Opens the review of the job in the row, from its Play icon, and waits for the player. */
async function openReview(page: Page, name: string): Promise<Locator> {
  const row = rowOf(page, name);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.locator(REVIEW);
  await expect(review).toBeVisible();
  await expect(page.locator(PLAYER)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
  return review;
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

/** The ids of the sheet's list of rows, top to bottom. */
function menuRowIds(page: Page): Promise<string[]> {
  return page
    .locator(`${SHEET} [data-menu-row]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-row') ?? ''));
}

const seriesMark = (row: Locator, label: string): Locator =>
  row.getByRole('img', { name: label, exact: true });

/** The text of one line of the notes' cards: the toggles' button, found by its short label. */
const toggle = (card: Locator, label: 'Series' | 'Style'): Locator =>
  card.getByRole('button', { name: label, exact: true });

test.beforeAll(async () => {
  // A bit slower than the other specs, so an editing round stays on the row long enough to be seen.
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 6 });
});

test.afterAll(async () => {
  await engine?.stop();
});

test('a series is made from the first video, and the next folder joins it as episode 2', async () => {
  await engine.createJob({ client: CLIENT, job: FORMAT_JOB });
  const format = await follow(FORMAT_JOB, (job) => job.state === 'review');
  expect((await api(`/jobs/${format.id}/approve`, { method: 'POST' })).status).toBe(200);
  await follow(FORMAT_JOB, (job) => job.state === 'ready');
  await waitForPasses(format.clientId);

  const started = await api(`/jobs/${format.id}/series`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: SERIES }),
  });
  expect(started.status).toBe(202);
  await expect
    .poll(async () => (await seriesOf(format.clientId)).map((series) => series.state), RUN)
    .toEqual(['ready']);
  expect(await jobNamed(FORMAT_JOB)).toMatchObject({ episode: 1 });
});

test('the list: the series mark on each episode, and "follows episode 1" while one edits', async ({
  page,
}, testInfo) => {
  const pageErrors = await open(page);
  const format = rowOf(page, FORMAT_JOB);
  await expect(format).toBeVisible();
  await expect(seriesMark(format, `The format of the series ${SERIES}`)).toBeVisible();

  await test.step('a folder named after the series joins it: the mark and the episode number', async () => {
    await engine.createJob({ client: CLIENT, job: EPISODE_JOB });
    const episode = rowOf(page, EPISODE_JOB);
    await expect(seriesMark(episode, `Episode 2 of ${SERIES}`)).toBeVisible();
    expect(await jobNamed(EPISODE_JOB)).toMatchObject({ episode: 2 });
    // The mark is the Layers2 icon, drawn after the name (14 px, as on the Mac's row).
    const icon = seriesMark(episode, `Episode 2 of ${SERIES}`).locator('svg');
    await expect(icon).toHaveClass(/lucide-layers-2/);
    const box = await icon.boundingBox();
    expect(box?.width).toBe(14);
  });

  await test.step('while it edits, its detail says which episode it follows', async () => {
    const episode = rowOf(page, EPISODE_JOB);
    await expect(badge(episode, 'Editing')).toBeVisible(RUN);
    await expect(episode.locator('[data-slot="job-detail"]')).toContainText('follows episode 1');
    await shoot(page, 'series-jobs', testInfo);
  });

  await test.step('a job in no series has no mark', async () => {
    await engine.createJob({ client: CLIENT, job: PLAIN_JOB });
    const plain = rowOf(page, PLAIN_JOB);
    await expect(plain).toBeVisible();
    await expect(plain.getByRole('img', { name: /series/i })).toHaveCount(0);
    await expect(plain.locator('.lucide-layers-2')).toHaveCount(0);
  });

  expect(pageErrors).toEqual([]);
});

test('the sheet: "Episode 2 of …" under the name, and no series row in its list', async ({
  page,
}, testInfo) => {
  const episode = await follow(EPISODE_JOB, (job) => job.state === 'review');
  const format = await jobNamed(FORMAT_JOB);

  await test.step('the episode', async () => {
    const pageErrors = await open(page, `/jobs?job=${episode.id}`);
    const sheet = page.locator(SHEET);
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(450);
    await expect(sheet.getByRole('heading', { name: EPISODE_JOB })).toBeVisible();
    const subtitle = sheet.locator('[data-slot="job-sheet-series"]');
    await expect(subtitle).toHaveText(`Episode 2 of ${SERIES}`);
    // Plain text, after the client's link and a dot: the series' page stays on the Mac.
    await expect(sheet.locator('a[data-slot="job-sheet-series"]')).toHaveCount(0);
    await expect(sheet.locator('[data-slot="job-sheet-client"]')).toHaveText(CLIENT);
    expect(await menuRowIds(page)).not.toContain('series');
    expect((await menuRowIds(page)).filter((id) => id.startsWith('series'))).toEqual([]);
    await shoot(page, 'series-sheet', testInfo);
    expect(pageErrors).toEqual([]);
  });

  await test.step('the format job', async () => {
    const pageErrors = await open(page, `/jobs?job=${format.id}`);
    const sheet = page.locator(SHEET);
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(450);
    await expect(sheet.locator('[data-slot="job-sheet-series"]')).toHaveText(
      `The format of the series ${SERIES}`,
    );
    // The Mac's menu has Open the series and "This episode is the format" for it.
    expect((await menuRowIds(page)).filter((id) => id.startsWith('series'))).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test('a job in no series reviews as before: Add to style alone, and no episode in the header', async ({
  page,
}) => {
  const job = await follow(PLAIN_JOB, (candidate) => candidate.state === 'review');
  const pageErrors = await open(page);
  const review = await openReview(page, PLAIN_JOB);
  await expect(review.locator('[data-slot="phone-review-header"]')).toContainText(CLIENT);
  await expect(review.locator('[data-slot="phone-review-series"]')).toHaveCount(0);

  await addNote(job.id, 1, 'Keep the title on screen one second longer.');
  await review.getByRole('button', { name: /^Notes/ }).click();
  const card = page.locator(NOTES).locator('[data-slot="review-note"]').first();
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Add to style', exact: true })).toBeVisible();
  await expect(toggle(card, 'Series')).toHaveCount(0);
  await expect(card.locator('button[aria-pressed]')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('an episode’s review: Series and Style on each note, and Send puts the Series one in the series', async ({
  page,
}, testInfo) => {
  const SERIES_NOTE = 'Keep the title card on screen a second longer in every episode.';
  const EPISODE_NOTE = 'הכתוביות מכסות את החלון. להעלות אותן קצת.';
  const notesFile = join(
    engine.inbox,
    CLIENT,
    '_Series',
    SERIES,
    `Review notes – ${EPISODE_JOB} – round 1.md`,
  );
  const job = await follow(EPISODE_JOB, (candidate) => candidate.state === 'review');
  const pageErrors = await open(page);
  const review = await openReview(page, EPISODE_JOB);

  await test.step('the header says "Acme · Episode 2 of Weekly Tips · Preview video"', async () => {
    const header = review.locator('[data-slot="phone-review-header"]');
    await expect(header.locator('[data-slot="phone-review-series"]')).toHaveText(
      `Episode 2 of ${SERIES}`,
    );
    // One 16 px line, in this order: the client, the episode, the preview video.
    const line = header.locator('[data-slot="phone-review-series"]').locator('..');
    await expect(line).toHaveText(`${CLIENT}·Episode 2 of ${SERIES}·Preview video`);
    expect((await line.boundingBox())?.height).toBe(16);
  });

  await test.step('two notes: Series then Style, both off, short labels, 32 px (board MReviewSeries)', async () => {
    await addNote(job.id, 1, SERIES_NOTE);
    await addNote(job.id, 3.5, EPISODE_NOTE);
    await review.getByRole('button', { name: /^Notes/ }).click();
    const cards = page.locator(NOTES).locator('[data-slot="review-note"]');
    await expect(cards).toHaveCount(2);
    for (const index of [0, 1]) {
      const card = cards.nth(index);
      for (const label of ['Series', 'Style'] as const) {
        await expect(toggle(card, label)).toHaveAttribute('aria-pressed', 'false');
        expect((await toggle(card, label).boundingBox())?.height).toBe(32);
      }
      await expect(card.getByRole('button', { name: 'Add to style' })).toHaveCount(0);
      await expect(card).not.toContainText('When you send');
      const series = await toggle(card, 'Series').boundingBox();
      const style = await toggle(card, 'Style').boundingBox();
      expect((series?.x ?? 0) + (series?.width ?? 0)).toBeLessThan(style?.x ?? 0);
    }
  });

  await test.step('Series on: filled, the same short label, its line, and the server has it', async () => {
    const card = page.locator(NOTES).locator('[data-slot="review-note"]').first();
    await toggle(card, 'Series').click();
    await expect(toggle(card, 'Series')).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(card, 'Series')).toHaveClass(/bg-foreground/);
    await expect(toggle(card, 'Style')).toHaveAttribute('aria-pressed', 'false');
    await expect(card).toContainText(`When you send, this also goes into the series ${SERIES}`);
    await expect(card).not.toContainText('every later episode');
    await expect(card).not.toContainText('the style of');
    await expect
      .poll(async () =>
        (await notesOf(job.id)).map((note) => [note.text, note.addToSeries, note.addToStyle]),
      )
      .toEqual([
        [SERIES_NOTE, true, false],
        [EPISODE_NOTE, false, false],
      ]);
  });

  await test.step('Style on as well: both lines, the series first', async () => {
    const card = page.locator(NOTES).locator('[data-slot="review-note"]').first();
    await toggle(card, 'Style').click();
    await expect(toggle(card, 'Style')).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle(card, 'Style')).toHaveText('Style');
    await expect(card).toContainText(`When you send, this also goes into the style of ${CLIENT}`);
    const text = (await card.textContent()) ?? '';
    expect(text.indexOf('into the series')).toBeLessThan(text.indexOf('into the style of'));
    await expect
      .poll(async () => (await notesOf(job.id)).map((note) => [note.addToSeries, note.addToStyle]))
      .toEqual([
        [true, true],
        [false, false],
      ]);
    await page.waitForTimeout(300);
    await shoot(page, 'series-review-notes-on', testInfo);
  });

  await test.step('Series off again: the line goes, Style stays', async () => {
    const card = page.locator(NOTES).locator('[data-slot="review-note"]').first();
    await toggle(card, 'Series').click();
    await expect(toggle(card, 'Series')).toHaveAttribute('aria-pressed', 'false');
    await expect(card).not.toContainText('into the series');
    await expect(card).toContainText('into the style of');
    await expect
      .poll(async () => (await notesOf(job.id)).map((note) => [note.addToSeries, note.addToStyle]))
      .toEqual([
        [false, true],
        [false, false],
      ]);
    // Back to the first note being the Series one, and the second one for Style, as the board has it.
    await toggle(card, 'Series').click();
    await expect(toggle(card, 'Series')).toHaveAttribute('aria-pressed', 'true');
    await toggle(card, 'Style').click();
    await expect(toggle(card, 'Style')).toHaveAttribute('aria-pressed', 'false');
    const second = page.locator(NOTES).locator('[data-slot="review-note"]').nth(1);
    await toggle(second, 'Style').click();
    await expect(toggle(second, 'Style')).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => (await notesOf(job.id)).map((note) => [note.addToSeries, note.addToStyle]))
      .toEqual([
        [true, false],
        [false, true],
      ]);
    await page.waitForTimeout(300);
    await shoot(page, 'series-review-notes', testInfo);
  });

  await test.step('Send: the Series note is a file in the series folder, the other is not', async () => {
    await review.getByRole('button', { name: 'Send 2 notes', exact: true }).click();
    await expect(page.locator('[data-slot="phone-review-footer"]')).toHaveAttribute(
      'data-kind',
      'done',
    );
    await expect.poll(() => existsSync(notesFile), RUN).toBe(true);
    const file = await readFile(notesFile, 'utf8');
    expect(file).toContain(SERIES_NOTE);
    expect(file).not.toContain(EPISODE_NOTE);
    // The edit itself gets both notes, as ever.
    const round = join(engine.inbox, CLIENT, EPISODE_JOB, 'edit', 'review', 'round-1.md');
    await expect.poll(() => existsSync(round), RUN).toBe(true);
    const sent = await readFile(round, 'utf8');
    expect(sent).toContain(SERIES_NOTE);
    expect(sent).toContain(EPISODE_NOTE);
  });

  expect(pageErrors).toEqual([]);
});
