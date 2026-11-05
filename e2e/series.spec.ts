// K9: a series from its first episode to the next one, on the built server with the fake runner, the
// fake style runner and the Series switch on (`STUDIO_SERIES=1`). Its own engine (temp inbox, data
// folder and port), like review.spec.ts, so smoke.spec.ts still starts on an empty one. It runs with
// the engine's default, Review on. The tests run in order and share the engine: each one starts
// where the one before it left the client.
//
//   Acme  "Weekly Tips 1" is the format job; "Weekly Tips 2" the next episode; "Pilot cut" a job
//         that is in no series, which goes into the series and out again and then starts a second
//         series that is undone
//
//   format    "Weekly Tips 1" goes through Review and is approved (ready). Its menu's "Start a
//             series from this…" asks for the name (prefilled "Weekly Tips"); the toast says it
//             started, the series is learned (the fake series.md) and the client page and the
//             series page (Episodes 1, the Format tab) show it
//   episode   a folder "Weekly Tips 2" dropped in joins by its name (the series mark, episode 2);
//             its edit/brief.md has "## Series" with series.md in it. A queued job "Pilot cut"
//             goes into the series through the Series submenu and comes out again
//   notes     in Review the "Weekly Tips 2" notes get a Series toggle: of two notes, the one marked
//             Series is written into the series folder at Send, and series.md is left as it is
//             while the revise run decides what the note means (C26). Approving the episode makes
//             it the series' format, with the note under "## Notes"; the other note is not there
//   undo      "Pilot cut" is approved and starts a second series; Undo in the toast takes it back
//   off       with STUDIO_SERIES=0 (an engine of its own) there is no series anywhere
//
// The rows' states are told by the icons of support/jobs-ui.ts; nothing leaves the engine's origin.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { approveFromRowMenu } from './support/approve-ui.ts';
import { type Engine, startEngine } from './support/engine.ts';
import {
  action,
  badge,
  menuItem,
  openRowMenu,
  rowMenu,
  rowOf,
  stepBar,
} from './support/jobs-ui.ts';
import { reviewDialog, seekTo } from './support/review-ui.ts';

const CLIENT = 'Acme';
const SERIES = 'Weekly Tips';
const FORMAT_JOB = `${SERIES} 1`;
const EPISODE_JOB = `${SERIES} 2`;
const OTHER_JOB = 'Pilot cut';
const SECOND_SERIES = OTHER_JOB;

/** As in the other specs: a whole fake edit takes about 15 s at this speed. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 4);
const RUN = { timeout: 60_000 };

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  clientId: string;
  seriesId: string | null;
  episode: number | null;
  approvedAt: string | null;
}

interface SeriesOnServer {
  id: string;
  name: string;
  state: 'learning' | 'ready' | 'failed';
  formatJob: string;
  episodeCount: number;
}

interface NoteOnServer {
  id: string;
  atSec: number;
  text: string | null;
  addToSeries: boolean;
}

/** A GET to the engine: what it answered, and the JSON it sent. */
async function get(engine: Engine, path: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${engine.baseURL}/api${path}`);
  return { status: response.status, json: await response.json() };
}

async function jobNamed(engine: Engine, name: string): Promise<JobOnServer> {
  const jobs = (await get(engine, '/jobs')).json as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === name);
  expect(job, `the server lists "${name}"`).toBeDefined();
  return job as JobOnServer;
}

async function seriesOf(engine: Engine, clientId: string): Promise<SeriesOnServer[]> {
  const answer = await get(engine, `/clients/${clientId}/series`);
  expect(answer.status).toBe(200);
  return (answer.json as { series: SeriesOnServer[] }).series;
}

async function seriesNamed(
  engine: Engine,
  clientId: string,
  name: string,
): Promise<SeriesOnServer> {
  const found = (await seriesOf(engine, clientId)).find((candidate) => candidate.name === name);
  expect(found, `the client has the series "${name}"`).toBeDefined();
  return found as SeriesOnServer;
}

/** The client's style as the server has it. */
async function styleOf(
  engine: Engine,
  clientId: string,
): Promise<{ state: string; markdown: string | null }> {
  return (await get(engine, `/clients/${clientId}/style`)).json as {
    state: string;
    markdown: string | null;
  };
}

/**
 * Waits until nothing is learning for the client: its style has been written (a job that reaches
 * ready queues a Learn pass) and none of its series is. Start a series is turned away while one is.
 */
async function waitForPasses(engine: Engine, clientId: string): Promise<void> {
  await expect
    .poll(async () => {
      const style = await styleOf(engine, clientId);
      const learning = (await seriesOf(engine, clientId)).some((s) => s.state === 'learning');
      return style.state === 'ready' && style.markdown !== null && !learning;
    }, RUN)
    .toBe(true);
}

/** The series folder of the first series: `<inbox>/Acme/_Series/<name>`. */
const seriesDir = (engine: Engine, name: string): string =>
  join(engine.inbox, CLIENT, '_Series', name);

/** A page of the engine; "What's new", which a browser that has not seen this version gets, is closed. */
async function openApp(engine: Engine, page: Page, path = '/'): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  const whatsNew = page.getByRole('dialog', { name: /What's new/ });
  await whatsNew.waitFor({ timeout: 5_000 }).then(
    () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
    () => {}, // no dialog: nothing to dismiss
  );
  await expect(whatsNew).toBeHidden();
  return pageErrors;
}

/** The mark a job in a series has after its name; its label is what the mark's tooltip says. */
function seriesMark(row: Locator, label: string): Locator {
  return row.getByRole('img', { name: label, exact: true });
}

/** Any series mark of the row, whatever it says. */
function anySeriesMark(row: Locator): Locator {
  return row.getByRole('img', { name: /series/i });
}

/** The toast with this text (sonner draws them outside the page's regions). */
function toastWith(page: Page, text: string): Locator {
  return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

/** The "Start a series from <job>?" dialog. */
function startDialog(page: Page): Locator {
  return page.getByRole('alertdialog', { name: /^Start a series from / });
}

/** Opens the row's Series submenu: the menu of the choices. */
async function openSeriesSubmenu(page: Page, row: Locator): Promise<Locator> {
  await openRowMenu(page, row);
  await menuItem(page, 'Series').click();
  const submenu = page.getByRole('menu', { name: 'Series', exact: true });
  await expect(submenu).toBeVisible();
  return submenu;
}

/** Opens the review dialog of the job that is in Review, once its player has loaded the preview. */
async function openReview(page: Page, row: Locator): Promise<Locator> {
  const dialog = reviewDialog(page);
  await expect(badge(row, 'Review')).toBeVisible(RUN);
  await action(row, 'Review').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 30_000 },
  );
  return dialog;
}

/** Approves the job that is in Review from its right-click menu; resolves once the row says Approved. */
async function approve(page: Page, row: Locator): Promise<void> {
  await expect(badge(row, 'Review')).toBeVisible(RUN);
  await approveFromRowMenu(page, row);
  await expect(badge(row, 'Approved')).toBeVisible(RUN);
}

test.describe('a series, with the Series switch on', () => {
  // Each test starts where the last one left the client: one failing stops the rest.
  test.describe.configure({ mode: 'serial' });

  let engine: Engine;
  let clientId = '';
  let seriesId = '';

  test.beforeAll(async () => {
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED, series: true });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('the engine says series are on, and a first job is approved so it is ready', async ({
    page,
  }) => {
    const pageErrors = await openApp(engine, page);
    expect((await get(engine, '/health')).json).toMatchObject({ series: true });

    const row = rowOf(page, FORMAT_JOB);
    await engine.createJob({ client: CLIENT, job: FORMAT_JOB });
    await approve(page, row);

    const job = await jobNamed(engine, FORMAT_JOB);
    clientId = job.clientId;
    expect(job).toMatchObject({ state: 'ready', seriesId: null, episode: null });
    expect(job.approvedAt).not.toBeNull();
    await expect(anySeriesMark(row)).toHaveCount(0);
    expect(await seriesOf(engine, clientId)).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('Start a series from the ready job: the name, the toast, the learned format, the pages', async ({
    page,
  }) => {
    const pageErrors = await openApp(engine, page);
    const row = rowOf(page, FORMAT_JOB);
    await expect(badge(row, 'Approved')).toBeVisible();
    await waitForPasses(engine, clientId);

    await test.step('the row menu offers it, and the dialog prefills the name without the number', async () => {
      await openRowMenu(page, row);
      await menuItem(page, 'Start a series from this…').click();

      const dialog = startDialog(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`Start a series from ${FORMAT_JOB}?`);
      await expect(dialog.getByLabel('Series name')).toHaveValue(SERIES);
      await expect(dialog).toContainText(
        `Folders named ${SERIES} 2, ${SERIES} 3 and so on join it on their own.`,
      );

      await dialog.getByRole('button', { name: 'Start series' }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step('the toast says it started, with Undo; the series is learning at first', async () => {
      const toast = toastWith(
        page,
        `Started the series ${SERIES}. Its format is being learned from ${FORMAT_JOB}.`,
      );
      await expect(toast).toBeVisible();
      await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();

      const series = await seriesNamed(engine, clientId, SERIES);
      seriesId = series.id;
      expect(series).toMatchObject({ formatJob: FORMAT_JOB });
      expect(['learning', 'ready']).toContain(series.state);
      // The job joined at once, as episode 1 and the format.
      expect(await jobNamed(engine, FORMAT_JOB)).toMatchObject({ seriesId, episode: 1 });
      await expect(seriesMark(row, `The format of the series ${SERIES}`)).toBeVisible();
    });

    await test.step('the format is learned: the fake series.md is in the series folder', async () => {
      await expect
        .poll(async () => (await seriesNamed(engine, clientId, SERIES)).state, RUN)
        .toBe('ready');
      const file = join(seriesDir(engine, SERIES), 'series.md');
      expect(await readFile(file, 'utf8')).toContain(`# Series: ${SERIES}`);
      expect(existsSync(join(seriesDir(engine, SERIES), 'kit', 'index.html'))).toBe(true);
    });

    await test.step('the client page lists the series, with its episodes and the format job', async () => {
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Clients' })
        .click();
      await page.locator('tr[data-client-id]').filter({ hasText: CLIENT }).click();
      await expect(page.getByRole('heading', { name: CLIENT, level: 1 })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/clients/${clientId}$`));
      await expect(page.getByText('1 series', { exact: false }).first()).toBeVisible();

      const list = page.getByRole('list', { name: 'Series' });
      await expect(list.getByRole('listitem')).toHaveCount(1);
      const item = list.getByRole('link', { name: new RegExp(SERIES) });
      await expect(item).toContainText('1 episode · format from episode 1');
      // The client's own jobs list sits under its heading.
      await expect(page.getByRole('heading', { name: 'Jobs', level: 2 })).toBeVisible();
      await expect(rowOf(page, FORMAT_JOB)).toHaveCount(1);

      await item.click();
    });

    await test.step('the series page: Episodes 1, and a Format tab with the fake series.md', async () => {
      await expect(page).toHaveURL(new RegExp(`/clients/${clientId}/series/${seriesId}$`));
      await expect(
        page.getByRole('heading', { name: SERIES, level: 1, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(`1 episode · format from ${FORMAT_JOB} · started `),
      ).toBeVisible();

      const episodes = page.getByRole('tab', { name: /^Episodes/ });
      await expect(episodes).toHaveAttribute('aria-selected', 'true');
      await expect(episodes).toContainText('1');
      // The Episodes tab is the Jobs list narrowed to the series.
      await expect(rowOf(page, FORMAT_JOB)).toHaveCount(1);

      await page.getByRole('tab', { name: 'Format' }).click();
      const article = page.getByRole('article');
      await expect(article).toContainText('series.md · learned');
      await expect(article).toContainText(FORMAT_JOB);
      await expect(
        article.getByRole('heading', { name: `Series: ${SERIES}`, level: 1 }),
      ).toBeVisible();
      await expect(
        article.getByRole('heading', { name: 'Same in every episode', level: 2 }),
      ).toBeVisible();
      await expect(article).toContainText(`Format from ${FORMAT_JOB}`);
      // It is the rendered document, not its Markdown.
      await expect(page.getByText('## Flow')).toHaveCount(0);
    });

    expect(pageErrors).toEqual([]);
  });

  // The series page drops the Layers2 mark and says "Format" after the format job's name, and its
  // menu leaves out "Open the series" (SeriesPageScope, series-page-context.ts; wrapped in K10).
  test('on the series page the rows say Format, not the series mark, and the menu does not open the series', async ({
    page,
  }) => {
    const pageErrors = await openApp(engine, page, `/clients/${clientId}/series/${seriesId}`);
    const row = rowOf(page, FORMAT_JOB);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Format');
    await expect(anySeriesMark(row)).toHaveCount(0);

    await openRowMenu(page, row);
    await expect(rowMenu(page).getByRole('menuitem', { name: /^Open the series/ })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('a folder named after the series joins it with its brief, and a queued job goes in and out', async ({
    page,
  }) => {
    const pageErrors = await openApp(engine, page);
    const row = rowOf(page, EPISODE_JOB);
    const queuedRow = rowOf(page, OTHER_JOB);

    await test.step('the dropped folder joins by its name: the mark, the episode number', async () => {
      await engine.createJob({ client: CLIENT, job: EPISODE_JOB });
      // It joins when it is first seen, not once it has settled.
      await expect(seriesMark(row, `Episode 2 of ${SERIES}`)).toBeVisible();
      expect(await jobNamed(engine, EPISODE_JOB)).toMatchObject({ seriesId, episode: 2 });
      await expect(
        seriesMark(rowOf(page, FORMAT_JOB), `The format of the series ${SERIES}`),
      ).toBeVisible();
    });

    await test.step('its brief has the Series section, from the frozen series folder', async () => {
      const editDir = join(engine.inbox, CLIENT, EPISODE_JOB, 'edit');
      await expect(stepBar(row)).toBeVisible(RUN);
      const brief = await readFile(join(editDir, 'brief.md'), 'utf8');
      expect(brief).toContain('## Series');
      expect(brief).toContain(`This job is episode 2 of the series “${SERIES}”.`);
      // The series.md the Series section pastes in is the one the format job made.
      expect(brief).toContain(`# Series: ${SERIES}`);
      // The episode works from a copy of the series made when it started, kit and series.md.
      expect(existsSync(join(editDir, 'series', 'series.md'))).toBe(true);
      expect(existsSync(join(editDir, 'series', 'kit', 'index.html'))).toBe(true);
    });

    // The first episode is editing, so a job that arrives now waits its turn.
    await test.step('a job that arrives now is queued, and joins the series from the Series submenu', async () => {
      await engine.createJob({ client: CLIENT, job: OTHER_JOB });
      await expect(badge(queuedRow, 'Queued')).toBeVisible(RUN);
      await expect(anySeriesMark(queuedRow)).toHaveCount(0);

      const submenu = await openSeriesSubmenu(page, queuedRow);
      await expect(submenu.getByRole('menuitemradio')).toHaveText([SERIES, 'Not in a series']);
      await expect(submenu.getByRole('menuitemradio', { name: 'Not in a series' })).toBeChecked();
      await submenu.getByRole('menuitemradio', { name: SERIES, exact: true }).click();
      await expect(rowMenu(page)).toBeHidden();

      await expect(seriesMark(queuedRow, `In the series ${SERIES}`)).toBeVisible();
      expect(await jobNamed(engine, OTHER_JOB)).toMatchObject({ seriesId, episode: null });
    });

    await test.step('its menu now opens the series, and the Series submenu takes it out again', async () => {
      await openRowMenu(page, queuedRow);
      await expect(menuItem(page, `Open the series ${SERIES}`)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(rowMenu(page)).toBeHidden();

      const submenu = await openSeriesSubmenu(page, queuedRow);
      await expect(submenu.getByRole('menuitemradio', { name: SERIES, exact: true })).toBeChecked();
      await submenu.getByRole('menuitemradio', { name: 'Not in a series' }).click();
      await expect(rowMenu(page)).toBeHidden();

      await expect(anySeriesMark(queuedRow)).toHaveCount(0);
      expect(await jobNamed(engine, OTHER_JOB)).toMatchObject({ seriesId: null, episode: null });
      // Still waiting in line: it was queued the whole time.
      await expect(badge(queuedRow, 'Queued')).toBeVisible();
    });

    expect(pageErrors).toEqual([]);
  });

  test('in Review a note on the episode is marked Series; approving the episode puts it into series.md', async ({
    page,
  }) => {
    const pageErrors = await openApp(engine, page);
    const row = rowOf(page, EPISODE_JOB);
    const dialog = reviewDialog(page);
    const SERIES_NOTE = 'Keep the title card on screen a second longer in every episode.';
    const EPISODE_NOTE = 'Cut the pause before the last sentence in this episode.';
    const notesFile = join(seriesDir(engine, SERIES), `Review notes – ${EPISODE_JOB} – round 1.md`);

    await openReview(page, row);
    await expect(dialog).toContainText(EPISODE_JOB);

    /** Writes a note at this second of the player. */
    async function writeNote(seconds: number, text: string): Promise<Locator> {
      await seekTo(page, dialog, seconds);
      const box = dialog.getByRole('textbox');
      await box.click();
      await box.fill(text);
      await box.press('Enter');
      await expect(box).toHaveValue('');
      return dialog.locator('[data-slot="review-note"]').filter({ hasText: text });
    }

    await test.step('two notes: each card has Series and Style toggles, both off', async () => {
      const seriesCard = await writeNote(2, SERIES_NOTE);
      const episodeCard = await writeNote(4, EPISODE_NOTE);
      for (const card of [seriesCard, episodeCard]) {
        await expect(card.getByRole('button', { name: 'Series', exact: true })).toHaveAttribute(
          'aria-pressed',
          'false',
        );
        await expect(card.getByRole('button', { name: 'Style', exact: true })).toHaveAttribute(
          'aria-pressed',
          'false',
        );
      }
    });

    await test.step('Series on the first note: it says where it goes, and the server has it', async () => {
      const card = dialog.locator('[data-slot="review-note"]').filter({ hasText: SERIES_NOTE });
      await card.getByRole('button', { name: 'Series', exact: true }).click();
      await expect(card.getByRole('button', { name: 'In series', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(card).toContainText(
        `When you send, this also goes into every later episode of ${SERIES}`,
      );

      const id = (await jobNamed(engine, EPISODE_JOB)).id;
      await expect
        .poll(async () => {
          const notes = (await get(engine, `/jobs/${id}/notes`)).json as NoteOnServer[];
          return notes.map((note) => [note.text, note.addToSeries]);
        })
        .toEqual([
          [SERIES_NOTE, true],
          [EPISODE_NOTE, false],
        ]);
    });

    const seriesMd = join(seriesDir(engine, SERIES), 'series.md');
    const formatBefore = await readFile(seriesMd, 'utf8');

    await test.step('Send: the marked note is a file in the series folder, and series.md waits', async () => {
      await dialog.getByRole('button', { name: 'Send 2 notes', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(toastWith(page, 'Sent 2 notes')).toBeVisible();

      // The marked note is a file in the series folder, in the round-1 notes layout.
      await expect.poll(() => existsSync(notesFile), RUN).toBe(true);
      const file = await readFile(notesFile, 'utf8');
      expect(file).toContain(SERIES_NOTE);
      expect(file).not.toContain(EPISODE_NOTE);

      // The revise run applies the notes and the episode is back in Review. Nothing has gone into
      // series.md meanwhile: the revise run decided what the note means only now.
      await expect(badge(row, 'Review')).toBeVisible(RUN);
      expect(await readFile(seriesMd, 'utf8')).toBe(formatBefore);
      expect(await seriesNamed(engine, clientId, SERIES)).toMatchObject({
        state: 'ready',
        formatJob: FORMAT_JOB,
      });
    });

    await test.step('Approve: the episode becomes the format, with the note under ## Notes', async () => {
      await approve(page, row);

      await expect
        .poll(async () => {
          const series = await seriesNamed(engine, clientId, SERIES);
          return series.state === 'ready' && series.formatJob === EPISODE_JOB;
        }, RUN)
        .toBe(true);
      const markdown = await readFile(seriesMd, 'utf8');
      expect(markdown).toMatch(/^Format from Weekly Tips 2 /m);
      // The fake series run had the episode's Round 1 from project.md.
      expect(markdown).toMatch(
        /^## Notes\n- Review notes – Weekly Tips 2 – round 1\.md: a stand-in rule with the episode’s rounds/m,
      );
      expect(markdown).not.toContain(EPISODE_NOTE);
      // The notes file stays in the series folder, for the record.
      expect(existsSync(notesFile)).toBe(true);
    });

    await test.step('the Format tab shows the notes', async () => {
      await page.goto(`${engine.baseURL}/clients/${clientId}/series/${seriesId}`);
      await page.getByRole('tab', { name: 'Format' }).click();
      const article = page.getByRole('article');
      await expect(article.getByRole('heading', { name: 'Notes', level: 2 })).toBeVisible();
      await expect(article).toContainText(`Review notes – ${EPISODE_JOB} – round 1.md`);
    });

    expect(pageErrors).toEqual([]);
  });

  test('a second Start a series is taken back with Undo in its toast', async ({ page }) => {
    const pageErrors = await openApp(engine, page);
    const row = rowOf(page, OTHER_JOB);
    const before = await seriesOf(engine, clientId);
    expect(before.map((series) => series.name)).toEqual([SERIES]);

    // It is a job of the client that is in no series; it ends its edit in Review, and is approved.
    await approve(page, row);
    await waitForPasses(engine, clientId);
    const styleBefore = (await styleOf(engine, clientId)).markdown;

    await openRowMenu(page, row);
    await menuItem(page, 'Start a series from this…').click();
    const dialog = startDialog(page);
    await expect(dialog.getByLabel('Series name')).toHaveValue(SECOND_SERIES);
    await dialog.getByRole('button', { name: 'Start series' }).click();
    await expect(dialog).toBeHidden();

    // Undo is only offered for ten seconds: pressed at once.
    const started = toastWith(
      page,
      `Started the series ${SECOND_SERIES}. Its format is being learned from ${OTHER_JOB}.`,
    );
    await expect(started).toBeVisible();
    await expect(seriesMark(row, `The format of the series ${SECOND_SERIES}`)).toBeVisible();
    expect((await seriesOf(engine, clientId)).map((series) => series.name).sort()).toEqual(
      [SECOND_SERIES, SERIES].sort(),
    );
    await started.getByRole('button', { name: 'Undo' }).click();

    await expect(toastWith(page, `Took back the series ${SECOND_SERIES}.`)).toBeVisible(RUN);
    await expect(anySeriesMark(row)).toHaveCount(0);

    // The series is gone, from the engine and from the disk, and the job is as it was before.
    expect((await seriesOf(engine, clientId)).map((series) => series.name)).toEqual([SERIES]);
    expect((await get(engine, `/series/${seriesId}`)).status).toBe(200);
    expect(existsSync(seriesDir(engine, SECOND_SERIES))).toBe(false);
    expect(await jobNamed(engine, OTHER_JOB)).toMatchObject({
      state: 'ready',
      seriesId: null,
      episode: null,
    });
    // The first series is untouched, and so is the client's style.
    expect(existsSync(join(seriesDir(engine, SERIES), 'series.md'))).toBe(true);
    await expect
      .poll(async () => (await styleOf(engine, clientId)).markdown, RUN)
      .toBe(styleBefore);

    // The client page lists only the first series now.
    await page.goto(`${engine.baseURL}/clients/${clientId}`);
    const list = page.getByRole('list', { name: 'Series' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText(SERIES);
    await expect(list).not.toContainText(SECOND_SERIES);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('with the Series switch off', () => {
  let engine: Engine;

  test.beforeAll(async () => {
    engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED, series: false });
  });

  test.afterAll(async () => {
    await engine?.stop();
  });

  test('none of the series UI shows, and the series routes say they are off', async ({ page }) => {
    const pageErrors = await openApp(engine, page);
    expect((await get(engine, '/health')).json).toMatchObject({ series: false });

    const row = rowOf(page, FORMAT_JOB);
    const dialog = reviewDialog(page);
    await engine.createJob({ client: CLIENT, job: FORMAT_JOB });
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    const job = await jobNamed(engine, FORMAT_JOB);

    await test.step('a note in Review has the one Add to style toggle, no Series', async () => {
      await openReview(page, row);
      await seekTo(page, dialog, 2);
      const box = dialog.getByRole('textbox');
      await box.click();
      await box.fill('Keep the title longer.');
      await box.press('Enter');

      const card = dialog.locator('[data-slot="review-note"]');
      await expect(card.getByRole('button', { name: 'Add to style', exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: /series/i })).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Style', exact: true })).toHaveCount(0);

      await card.getByRole('button', { name: 'Delete note' }).click();
      await expect(card).toHaveCount(0);
      await approveFromRowMenu(page, row);
      await expect(dialog).toBeHidden();
      await expect(badge(row, 'Approved')).toBeVisible(RUN);
    });

    await test.step('the ready job’s menu has no series item', async () => {
      await openRowMenu(page, row);
      await expect(rowMenu(page).getByRole('menuitem', { name: /series/i })).toHaveCount(0);
      // The menu itself is there, with the items of a ready job.
      await expect(rowMenu(page).getByRole('menuitem').first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(rowMenu(page)).toBeHidden();
      await expect(anySeriesMark(row)).toHaveCount(0);
    });

    await test.step('the client page has no Series list and no series count', async () => {
      await page.goto(`${engine.baseURL}/clients/${job.clientId}`);
      await expect(page.getByRole('heading', { name: CLIENT, level: 1 })).toBeVisible();
      await expect(rowOf(page, FORMAT_JOB)).toHaveCount(1);
      await expect(page.getByRole('list', { name: 'Series' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Series', level: 2 })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Jobs', level: 2 })).toHaveCount(0);
      await expect(page.getByText(/\d+ series/)).toHaveCount(0);
    });

    await test.step('a series address says there is no such series; the API says series are off', async () => {
      await page.goto(`${engine.baseURL}/clients/${job.clientId}/series/000000000000`);
      await expect(page.getByText('No such series.')).toBeVisible();

      for (const [path, method] of [
        [`/clients/${job.clientId}/series`, 'GET'],
        ['/series/000000000000', 'GET'],
        [`/jobs/${job.id}/series`, 'POST'],
        [`/jobs/${job.id}/series`, 'PUT'],
      ] as const) {
        const response = await fetch(`${engine.baseURL}/api${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'GET' ? undefined : JSON.stringify({ name: SERIES, seriesId: null }),
        });
        expect([path, method, response.status]).toEqual([path, method, 404]);
        expect(await response.json()).toEqual({ error: 'Series are off.' });
      }
    });

    expect(pageErrors).toEqual([]);
  });
});
