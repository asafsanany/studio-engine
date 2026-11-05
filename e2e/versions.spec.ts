// CVP-331 (VE5): preview versions on the built server with the fake runner (Review and Soundtrack
// on), driven through the real job sheet on the desktop. One job goes through three cuts by real
// captures (the engine keeps a version each time a run ends in Review): Cut 1 from the first edit
// (music v1, a tone), Cut 2 from the revise run a sent note makes (after Review turned the music
// off, so the cuts differ in a way a file can show), Cut 3 from a second revise run. Then:
//
//   list          the job sheet's Versions part opens: Cut 3 (Current), Cut 2, Cut 1, newest first
//   view          View Cut 1 opens the viewer on that cut's own composition (not the live one), with
//                 "Go back to this version" in its footer; its music.mp3 is served from that cut's
//                 own folder (versions/1/preview/music.mp3) and the player asks for it
//   go back       the confirm dialog ("Go back to Cut 1?") from the row's ⋯ menu: the live preview,
//                 the music record and project.md are Cut 1's again (with "## Restored to Cut 1"),
//                 job.preview is Cut 1's, the job is still in Review at the same round, and Cut 2
//                 and Cut 3 are still in Versions. Once more from the viewer's footer, to Cut 2
//   Send notes    refused while a note is unsent (409; the menu item is disabled with a toast too);
//                 after Send notes the revise run makes a NEW cut, Cut 4, that is current, and
//                 Cut 2 and Cut 3 are not overwritten
//
// Screenshots are attached to the report, and written to $VERSIONS_SHOTS_DIR when it is set.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { audioFingerprint, isSilent } from './support/audio.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { rowOf } from './support/jobs-ui.ts';
import { openApp, openSheetByClick, sheetOf } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Versions flow';

/** As in the other specs: a whole fake edit takes about 15 s at this speed. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 4);
const RUN = { timeout: 90_000 };

const VIEWER = '[data-preview-viewer]';

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  round: number;
  preview: { durationSec: number; width: number; height: number } | null;
}

interface VersionOnServer {
  n: number;
  round: number;
  durationSec: number;
  width: number;
  height: number;
  current: boolean;
}

let engine: Engine;

test.beforeAll(async () => {
  // Quick fixes are on by default (QF9); the notes here are posted and sent at once, which Auto
  // refuses while it is still reading the note (409), so this spec turns the switch off.
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: FAKE_SPEED,
    music: true,
    quickFixes: false,
  });
});

test.afterAll(async () => {
  await engine?.stop();
});

async function jobNamed(name: string): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === name);
  if (job === undefined) throw new Error(`no job named ${name}`);
  return job;
}

/** Waits until the job is in a state `until` accepts, and returns it. */
async function follow(until: (job: JobOnServer) => boolean): Promise<JobOnServer> {
  let last: JobOnServer | undefined;
  await expect
    .poll(async () => {
      last = await jobNamed(JOB).catch(() => undefined);
      return last !== undefined && until(last);
    }, RUN)
    .toBe(true);
  return last as JobOnServer;
}

async function versionsOf(jobId: string): Promise<VersionOnServer[]> {
  const body = (await (await fetch(`${engine.baseURL}/api/jobs/${jobId}/versions`)).json()) as {
    versions: VersionOnServer[];
  };
  return body.versions;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
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

const editDir = (): string => join(engine.inbox, CLIENT, JOB, 'edit');
const cutMusicFile = (n: number): Promise<Buffer> =>
  readFile(join(editDir(), 'versions', `v${n}`, 'preview', 'music.mp3'));
const readLive = (name: string): Promise<string> => readFile(join(editDir(), name), 'utf8');
const readCut = (n: number, name: string): Promise<string> =>
  readFile(join(editDir(), 'versions', `v${n}`, name), 'utf8');

/** A note at one second, then Send notes; returns once the revise run has started. */
async function sendNote(jobId: string, text: string): Promise<void> {
  expect((await call('POST', `/jobs/${jobId}/notes`, { atSec: 1, text })).status).toBe(201);
  expect((await call('POST', `/jobs/${jobId}/send-notes`)).status).toBe(200);
}

/** The job is in Review at a round past `round`, with its cut `n` kept and current. */
async function reviewAfter(round: number, n: number): Promise<JobOnServer> {
  const job = await follow((candidate) => candidate.state === 'review' && candidate.round > round);
  await expect.poll(async () => (await versionsOf(job.id)).find((v) => v.current)?.n, RUN).toBe(n);
  return job;
}

/** Attaches a screenshot to the report, and writes it to $VERSIONS_SHOTS_DIR if set. */
async function shoot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  // Dialogs and the sheet fade and slide in over 150-200 ms.
  await page.waitForTimeout(500);
  const body = await page.screenshot();
  await testInfo.attach(`${name}.png`, { body, contentType: 'image/png' });
  const dir = process.env.VERSIONS_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), body);
  }
}

const versionsPart = (page: Page): Locator => sheetOf(page).locator('[data-section="versions"]');
const cutRow = (page: Page, n: number): Locator =>
  versionsPart(page).locator(`li[data-version="${n}"]`);
const goBackDialog = (page: Page): Locator => page.getByRole('alertdialog');

/** Scrolls the sheet to the bottom of the Versions list, for a screenshot. */
async function showCuts(page: Page): Promise<void> {
  await versionsPart(page).locator('li[data-version]').last().scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /^History/ }).scrollIntoViewIfNeeded();
}

/** Opens a cut's ⋯ menu and returns it. */
async function openCutMenu(page: Page, n: number): Promise<Locator> {
  const row = cutRow(page, n);
  await row.hover();
  await row.getByRole('button', { name: `More · Cut ${n}` }).click();
  // The menu is named after the button that opened it.
  const menu = page.getByRole('menu', { name: `More · Cut ${n}` });
  await expect(menu).toBeVisible();
  return menu;
}

test('three cuts, View one, go back to it, then Send notes makes Cut 4', async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  const pageErrors = await openApp(page, engine.baseURL);
  // Every request of the page must stay on the engine's origin.
  const offOrigin: string[] = [];
  const musicResponses: { url: string; status: number }[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(engine.baseURL) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      offOrigin.push(url);
    }
  });
  page.on('response', (response) => {
    if (/\/music\.mp3(\?|$)/.test(response.url())) {
      musicResponses.push({ url: response.url(), status: response.status() });
    }
  });

  let job: JobOnServer;
  let cut1Preview: JobOnServer['preview'];

  await test.step('the first edit is Cut 1, with music v1', async () => {
    await engine.createJob({ client: CLIENT, job: JOB, asksMusic: true });
    job = await reviewAfter(-1, 1);
    expect(job.round).toBe(0);
    cut1Preview = job.preview;
    expect(cut1Preview).toMatchObject({ durationSec: 6, width: 1080, height: 1920 });
    const kept = await versionsOf(job.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ n: 1, round: 0, current: true });
    expect(existsSync(join(editDir(), 'versions', 'v1', 'preview', 'music.mp3'))).toBe(true);
    const tone = await audioFingerprint(join(editDir(), 'preview', 'music.mp3'));
    expect(isSilent(tone), 'Cut 1 plays music v1').toBe(false);
  });

  await test.step('Review turns the music off, a note and Send notes make Cut 2', async () => {
    expect((await call('PUT', `/jobs/${job.id}/music/pick`, { id: 'off' })).status).toBe(200);
    await sendNote(job.id, 'Hold the title a second longer.');
    job = await reviewAfter(0, 2);
    expect(job.round).toBe(1);
    const silence = await audioFingerprint(join(editDir(), 'preview', 'music.mp3'));
    expect(isSilent(silence), 'Cut 2 plays No music').toBe(true);
  });

  await test.step('a second round makes Cut 3', async () => {
    await sendNote(job.id, 'Cut the last second.');
    job = await reviewAfter(1, 3);
    expect(job.round).toBe(2);
  });

  const cut1Music = await readCut(1, 'music.json');
  expect(JSON.parse(cut1Music)).toMatchObject({ picked: 'v1' });
  expect(JSON.parse(await readCut(3, 'music.json'))).toMatchObject({ picked: 'off' });
  expect(await readCut(3, 'project.md')).toContain('## Round 2');
  expect(await readCut(1, 'project.md')).not.toContain('## Round');

  // --- the sheet ---------------------------------------------------------------------------------

  const row = rowOf(page, JOB);
  await expect(row).toBeVisible();
  await openSheetByClick(page, row);

  await test.step('Versions opens to the three cuts, newest first, Cut 3 current', async () => {
    const toggle = versionsPart(page).getByRole('button', { name: 'Versions', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const rows = versionsPart(page).locator('li[data-version]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Cut 3');
    await expect(rows.nth(1)).toContainText('Cut 2');
    await expect(rows.nth(2)).toContainText('Cut 1');
    await expect(rows.nth(0)).toContainText('Current');
    await expect(rows.nth(1)).not.toContainText('Current');
    await expect(rows.nth(2)).not.toContainText('Current');
    // The cuts are 0:06 long, and the row says when it was made.
    await expect(rows.nth(2)).toContainText('0:06');
    await expect(rows.nth(2)).toContainText(/today \d{2}:\d{2}/);
    await showCuts(page);
    await shoot(page, 'versions-1-sheet-three-cuts', testInfo);
  });

  await test.step('View Cut 1 opens the viewer on that cut, which plays its own music', async () => {
    await cutRow(page, 1).getByRole('button', { name: 'View Cut 1' }).click();
    const viewer = page.locator(VIEWER);
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText('Cut 1');
    const player = viewer.locator('[data-slot="preview-player"]');
    await expect(player).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    await expect(viewer.locator('hyperframes-player')).toHaveAttribute(
      'src',
      new RegExp(`/api/jobs/${job.id}/versions/1/preview/index\\.html$`),
    );
    await expect(
      viewer.locator('[data-preview-viewer-footer]').getByRole('button', {
        name: 'Go back to this version',
      }),
    ).toBeVisible();

    // The music: Cut 1's own music.mp3 is served (200 or 206) from the version's folder, and it is
    // the tone of music v1, not the live preview's silence.
    const cutMusic = `/api/jobs/${job.id}/versions/1/preview/music.mp3`;
    await expect
      .poll(
        () =>
          musicResponses
            .filter((r) => r.url.includes(cutMusic))
            .some((r) => r.status === 200 || r.status === 206),
        { timeout: 30_000 },
      )
      .toBe(true);
    testInfo.annotations.push({
      type: 'music requests',
      description: musicResponses
        .filter((r) => r.url.includes(cutMusic))
        .map((r) => r.status)
        .join(', '),
    });

    // Playing it: the composition's audio element holds the cut's tone and runs with the video.
    await viewer.getByRole('button', { name: 'Play', exact: true }).click();
    const composition = page
      .frames()
      .find((frame) => frame.url().includes(`/api/jobs/${job.id}/versions/1/preview/`));
    expect(composition, 'the composition of Cut 1 is loaded in the viewer').toBeDefined();
    await expect
      .poll(
        () =>
          composition?.evaluate(() => {
            const audio = document.querySelector<HTMLAudioElement>('audio#music');
            return audio !== null && audio.readyState >= 2 && audio.currentTime > 0.2;
          }),
        { timeout: 15_000 },
      )
      .toBe(true);
    await viewer.getByRole('button', { name: 'Pause', exact: true }).click();
    const served = await fetch(`${engine.baseURL}${cutMusic}`);
    expect(served.status).toBe(200);
    const bytes = Buffer.from(await served.arrayBuffer());
    expect(bytes.equals(await cutMusicFile(1))).toBe(true);
    await shoot(page, 'versions-3-viewer-on-cut-1', testInfo);
  });

  await test.step('Go back from the viewer footer asks, and Cancel changes nothing', async () => {
    const viewer = page.locator(VIEWER);
    await viewer.getByRole('button', { name: 'Go back to this version' }).click();
    const dialog = goBackDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Go back to Cut 1?');
    await expect(dialog).toContainText('Cut 3 stays in Versions, so you can return to it.');
    await shoot(page, 'versions-4-go-back-from-viewer', testInfo);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await versionsOf(job.id)).find((v) => v.current)?.n).toBe(3);
    await viewer.getByRole('button', { name: 'Close preview' }).click();
    await expect(viewer).toHaveCount(0);
  });

  await test.step('Go back to Cut 1 from the row menu, confirmed in the dialog', async () => {
    const menu = await openCutMenu(page, 1);
    await expect(menu.getByRole('menuitem', { name: 'Go back to this version…' })).toBeEnabled();
    await menu.getByRole('menuitem', { name: 'Go back to this version…' }).click();
    const dialog = goBackDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Go back to Cut 1?');
    await expect(dialog).toContainText('Cut 3 stays in Versions, so you can return to it.');
    await shoot(page, 'versions-2-go-back-dialog', testInfo);
    await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Back on Cut 1')).toBeVisible();
  });

  await test.step('the live edit is Cut 1 again; the job is still in Review at the same round', async () => {
    const after = await jobNamed(JOB);
    expect(after.state).toBe('review');
    expect(after.round).toBe(2);
    expect(after.preview).toEqual(cut1Preview);
    const kept = await versionsOf(job.id);
    expect(kept.map((v) => v.n)).toEqual([3, 2, 1]);
    expect(kept.find((v) => v.current)?.n).toBe(1);
    expect(kept.find((v) => v.n === 1)).toMatchObject({
      durationSec: cut1Preview?.durationSec,
      width: cut1Preview?.width,
      height: cut1Preview?.height,
    });

    // Files: the preview, the music record, the EDL and the notes.
    expect(await readLive('preview/index.html')).toBe(await readCut(1, 'preview/index.html'));
    expect(
      (await readFile(join(editDir(), 'preview', 'music.mp3'))).equals(await cutMusicFile(1)),
    ).toBe(true);
    const tone = await audioFingerprint(join(editDir(), 'preview', 'music.mp3'));
    expect(isSilent(tone), 'the live preview plays music v1 again').toBe(false);
    expect(await readLive('music/music.json')).toBe(cut1Music);
    expect(JSON.parse(await readLive('music/music.json'))).toMatchObject({ picked: 'v1' });
    expect(await readLive('edl.json')).toBe(await readCut(1, 'edl.json'));
    const notes = await readLive('project.md');
    expect(notes).toContain('## Restored to Cut 1');
    expect(notes.startsWith((await readCut(1, 'project.md')).trimEnd())).toBe(true);
    expect(notes).not.toContain('## Round');

    // The server serves the live preview and the music the same as Cut 1's.
    const live = await fetch(`${engine.baseURL}/api/jobs/${job.id}/preview/music.mp3`);
    expect(live.status).toBe(200);
    expect(Buffer.from(await live.arrayBuffer()).equals(await cutMusicFile(1))).toBe(true);
    const music = await call('GET', `/jobs/${job.id}/music`);
    expect(music.json).toMatchObject({ picked: 'v1' });
  });

  await test.step('the sheet says Cut 1 is current now', async () => {
    await expect(cutRow(page, 1)).toContainText('Current');
    await expect(cutRow(page, 3)).not.toContainText('Current');
    await expect(versionsPart(page).locator('li[data-version]')).toHaveCount(3);
    await showCuts(page);
    await shoot(page, 'versions-5-sheet-after-go-back', testInfo);
  });

  await test.step('going back to the cut it is on changes nothing', async () => {
    const menu = await openCutMenu(page, 1);
    await expect(menu.getByRole('menuitem', { name: 'Go back to this version…' })).toBeDisabled();
    await page.keyboard.press('Escape');
    const before = await readLive('project.md');
    expect((await call('POST', `/jobs/${job.id}/versions/1/restore`)).status).toBe(200);
    expect(await readLive('project.md')).toBe(before);
  });

  await test.step('Go back to Cut 2 from the viewer footer: the viewer closes and Cut 2 is current', async () => {
    await cutRow(page, 2).getByRole('button', { name: 'View Cut 2' }).click();
    const viewer = page.locator(VIEWER);
    await expect(viewer).toContainText('Cut 2');
    await expect(viewer.locator('[data-slot="preview-player"]')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 30_000 },
    );
    await viewer.getByRole('button', { name: 'Go back to this version' }).click();
    const dialog = goBackDialog(page);
    await expect(dialog).toContainText('Go back to Cut 2?');
    await expect(dialog).toContainText('Cut 1 stays in Versions, so you can return to it.');
    await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await expect(page.getByText('Back on Cut 2')).toBeVisible();
    expect((await versionsOf(job.id)).find((v) => v.current)?.n).toBe(2);
    expect(JSON.parse(await readLive('music/music.json'))).toMatchObject({ picked: 'off' });
    expect(await readLive('project.md')).toContain('## Restored to Cut 2');
    expect((await jobNamed(JOB)).state).toBe('review');
    // And back to Cut 1 for the rest, through the API.
    expect((await call('POST', `/jobs/${job.id}/versions/1/restore`)).status).toBe(200);
    await expect(cutRow(page, 1)).toContainText('Current');
  });

  await test.step('with a note unsent, going back is refused: 409, and the menu item says so', async () => {
    expect(
      (await call('POST', `/jobs/${job.id}/notes`, { atSec: 2, text: 'Tighten the ending.' }))
        .status,
    ).toBe(201);
    const refused = await call('POST', `/jobs/${job.id}/versions/3/restore`);
    expect(refused).toEqual({ status: 409, json: { error: 'Send or delete your notes first.' } });
    expect((await versionsOf(job.id)).find((v) => v.current)?.n).toBe(1);

    // The sheet offers the item (the server is the one to refuse), and says why in a toast.
    await openCutMenu(page, 3).then((menu) =>
      menu.getByRole('menuitem', { name: 'Go back to this version…' }).click(),
    );
    await goBackDialog(page).getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(page.getByText('Couldn’t go back to Cut 3')).toBeVisible();
    await expect(page.getByText('Send or delete your notes first.')).toBeVisible();
    expect((await versionsOf(job.id)).find((v) => v.current)?.n).toBe(1);
  });

  await test.step('Send notes makes a NEW cut, Cut 4, and keeps Cut 2 and Cut 3 as they were', async () => {
    const cut2 = await readCut(2, 'preview/index.html');
    const cut3Notes = await readCut(3, 'project.md');
    expect((await call('POST', `/jobs/${job.id}/send-notes`)).status).toBe(200);
    job = await reviewAfter(2, 4);
    expect(job.round).toBe(3);
    const kept = await versionsOf(job.id);
    expect(kept.map((v) => v.n)).toEqual([4, 3, 2, 1]);
    expect(kept.find((v) => v.current)?.n).toBe(4);
    expect(kept.find((v) => v.n === 4)).toMatchObject({ round: 3 });
    expect(await readCut(2, 'preview/index.html')).toBe(cut2);
    expect(await readCut(3, 'project.md')).toBe(cut3Notes);
    // The revise run started from Cut 1: music v1 (not Cut 3's silence), the restore note, then its own round (the fake runner does not echo the note's words).
    expect(JSON.parse(await readCut(4, 'music.json'))).toMatchObject({ picked: 'v1' });
    expect(await readCut(4, 'project.md')).toContain('## Restored to Cut 1');
    expect(await readCut(4, 'project.md')).toContain('## Round 3');

    await expect(versionsPart(page).locator('li[data-version]')).toHaveCount(4, RUN);
    await expect(cutRow(page, 4)).toContainText('Current');
    await expect(cutRow(page, 1)).not.toContainText('Current');
    await showCuts(page);
    await shoot(page, 'versions-6-sheet-cut-4', testInfo);
  });

  expect(offOrigin).toEqual([]);
  expect(pageErrors).toEqual([]);
});
