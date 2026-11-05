// W12: the whole review loop on the built server, with the fake runner, the fake voice-note
// transcriber and Chrome's fake microphone. Its own engine (temp inbox, data folder and port), like
// brief.spec.ts, so smoke.spec.ts still starts on an empty one. Runs with the engine's default,
// Review on; smoke.spec.ts keeps covering the old flow with the switch off.
//
//   Review loop   arrives -> edits -> Review (a live preview, no final video) -> the dialog plays
//                 it -> a typed note at 0:02 -> a 2 s voice note at 0:04 (the fake transcript comes
//                 back) -> Add to style on the typed note -> Send -> a revise run (round 1: the
//                 title says "Round 1", project.md has "## Round 1", edit/review/round-1.md holds
//                 the notes) -> Review again (the dialog from the right-click menu: round-1
//                 preview, no notes; the footer has no Approve, its line says where it is) ->
//                 Approve from the row's right-click menu -> a render run -> Approved -> Download
//                 is the export
//
// The rows are followed from start to finish by the recorder in support/jobs-ui.ts: the job goes
// arriving -> editing -> review -> editing -> review -> editing -> ready. The revise run starts at
// Plan and the render run at Render. Nothing leaves the engine's origin: the player's runtime comes
// from the app, not from a CDN.

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { renderRoundFile } from '../packages/shared/src/review/notes-files.ts';
import { approveFromRowMenu } from './support/approve-ui.ts';
import { expectDownloadServesMp4 } from './support/download.ts';
import { type Engine, startEngine } from './support/engine.ts';
import {
  action,
  badge,
  editingRuns,
  expectStates,
  menuItem,
  openRowMenu,
  recordRows,
  rowMenu,
  rowOf,
  stepBar,
  trailOf,
} from './support/jobs-ui.ts';
import {
  EFFORT_BUTTON_DEFAULT,
  QUICK_FIXES_ON,
  REVIEW_EFFORT_FIELD,
} from './support/quick-fixes-switch.ts';
import { playerTime, reviewDialog, seekTo } from './support/review-ui.ts';

const CLIENT = 'Acme';
const JOB = 'Review loop';
const TEXT_NOTE = 'Keep the title on screen one second longer.';
const FAKE_TRANSCRIPT = '[voice note, fake transcript]';

/** As in the other specs: a whole fake edit takes about 15 s at this speed. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 4);
const RUN = { timeout: 60_000 };

// A fake microphone (a beeping tone), no permission prompt, and media that may play without a
// click. This file gets a browser of its own; the other specs keep theirs.
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  permissions: ['microphone'],
});

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED });
});

test.afterAll(async () => {
  await engine?.stop();
});

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  runKind: string;
  round: number;
  effort: string | null;
  reviewEffort: string | null;
  preview: { durationSec: number; width: number; height: number } | null;
  approvedAt: string | null;
}

interface NoteOnServer {
  id: string;
  atSec: number;
  kind: 'text' | 'voice';
  text: string | null;
  audioFile: string | null;
  transcriptStatus: 'pending' | 'done' | 'failed' | null;
  addToStyle: boolean;
}

async function jobs(): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const job = (await jobs()).find((candidate) => candidate.name === name);
  expect(job, `the server lists "${name}"`).toBeDefined();
  return job as JobOnServer;
}

/** The job's unsent notes, by time. Once Send has sent them the list is empty. */
async function notesOf(id: string): Promise<NoteOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs/${id}/notes`)).json()) as NoteOnServer[];
}

/** A POST to the API: what it answered, and the JSON it sent. */
async function post(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${engine.baseURL}/api${path}`, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

const jobDir = (): string => join(engine.inbox, CLIENT, JOB);

test('a job goes through Review: notes, a voice note, Send, round 1, Approve, Approved', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // Every request of the page and of the player's iframe must stay on the engine's origin.
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(engine.baseURL) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      offOrigin.push(url);
    }
  });

  await test.step('the page opens on an empty engine', async () => {
    await page.goto(engine.baseURL);
    // A browser that has never seen this version is greeted with "What's new"; it blocks the page.
    const whatsNew = page.getByRole('dialog', { name: /What's new/ });
    await whatsNew.waitFor({ timeout: 5_000 }).then(
      () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
      () => {}, // no dialog: nothing to dismiss
    );
    await expect(whatsNew).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    await recordRows(page);
  });

  const row = rowOf(page, JOB);
  const dialog = reviewDialog(page);
  const player = dialog.locator('[data-slot="preview-player"]');
  // Approve is never in the dialog (the owner, 31 Oct): its line says it is in the row's menu.
  const approve = dialog.getByRole('button', { name: 'Approve', exact: true });
  const footer = dialog.locator('[data-slot="review-footer"]');
  const sendButton = dialog.getByRole('button', { name: /^Send/ });
  let id = '';

  /** The player of the open dialog is ready and loaded this round's preview. */
  async function expectPlayerReady(round: number): Promise<void> {
    await expect(player).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    await expect(dialog.locator('hyperframes-player')).toHaveAttribute(
      'src',
      new RegExp(`/api/jobs/[^/]+/preview/index\\.html\\?r=${round}$`),
    );
  }

  await test.step('a new job ends in Review, with a live preview and no final video', async () => {
    await engine.createJob({ client: CLIENT, job: JOB });
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    await expect(row).toContainText('Ready to review · 0:06');
    await expect(page.getByRole('tab', { name: /^Review/ })).toContainText('1');
    await expect(
      page
        .getByRole('group', { name: 'Engine summary' })
        .getByRole('button', { name: /in review$/ }),
    ).toContainText('1');

    const job = await jobNamed(JOB);
    id = job.id;
    expect(job).toMatchObject({
      state: 'review',
      runKind: 'edit',
      round: 0,
      preview: { durationSec: 6, width: 1080, height: 1920 },
      approvedAt: null,
    });
    expect(existsSync(join(jobDir(), 'edit', 'preview', 'index.html'))).toBe(true);
    expect(existsSync(join(jobDir(), 'edit', 'final.mp4'))).toBe(false);
  });

  await test.step('the dialog plays the composition', async () => {
    await action(row, 'Review').click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(JOB);
    await expect(dialog).toContainText(CLIENT);
    await expect(dialog).toContainText('Live preview');
    await expectPlayerReady(0);

    await dialog.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => playerTime(dialog), { timeout: 10_000 }).toBeGreaterThan(1);
    await dialog.getByRole('button', { name: 'Pause', exact: true }).click();

    // No notes: no action, and the line says where Approve is.
    await expect(approve).toHaveCount(0);
    await expect(footer).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video.',
    );
    await expect(sendButton).toHaveCount(0);
    // The level is for the fixes round: Approve renders on its own and has no Effort button. With
    // Quick fixes on the button is there with no notes too, since Auto decides what a new note does.
    if (QUICK_FIXES_ON) {
      await expect(dialog.getByRole('button', { name: /^Effort:/ })).toHaveText('Effort: Auto');
    } else {
      await expect(dialog.getByRole('button', { name: /^Effort:/ })).toHaveCount(0);
    }
  });

  await test.step('a typed note at 0:02: Send takes the footer, and the engine refuses Approve', async () => {
    await seekTo(page, dialog, 2);
    const box = dialog.getByRole('textbox');
    await box.click();
    await box.fill(TEXT_NOTE);

    await box.press('Enter');
    await expect(box).toHaveValue('');
    await expect(dialog).toContainText(TEXT_NOTE);
    await expect(dialog.getByRole('button', { name: 'Note at 0:02', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send 1 note', exact: true })).toBeVisible();
    await expect(approve).toHaveCount(0);

    expect(await post(`/jobs/${id}/approve`)).toEqual({
      status: 409,
      json: { error: 'Send or delete your notes first.' },
    });
  });

  await test.step('a 2 s voice note at 0:04 comes back with the fake transcript', async () => {
    await seekTo(page, dialog, 4);
    await dialog.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(dialog).toContainText('pinned at 0:04');
    await page.waitForTimeout(2_200);
    await dialog.getByRole('button', { name: 'Stop and add', exact: true }).click();

    await expect(dialog.getByText(FAKE_TRANSCRIPT)).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('Voice note', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send 2 notes', exact: true })).toBeEnabled();

    const notes = await notesOf(id);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ kind: 'text', atSec: 2, text: TEXT_NOTE });
    expect(notes[1]).toMatchObject({
      kind: 'voice',
      atSec: 4,
      transcriptStatus: 'done',
      text: FAKE_TRANSCRIPT,
    });
    expect(notes[1]?.audioFile).toMatch(/^edit\/review\/voice\/[^/]+\.webm$/);
    const audio = await stat(join(jobDir(), notes[1]?.audioFile ?? ''));
    expect(audio.size).toBeGreaterThan(0);
  });

  await test.step('Add to style on the typed note', async () => {
    const card = dialog.locator('[data-slot="review-note"]').filter({ hasText: TEXT_NOTE });
    await card.getByRole('button', { name: 'Add to style', exact: true }).click();
    await expect(card.getByRole('button', { name: 'In style', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(card).toContainText(`When you send, this also goes into the style of ${CLIENT}`);
    await expect
      .poll(async () => (await notesOf(id)).find((note) => note.kind === 'text')?.addToStyle)
      .toBe(true);
  });

  await test.step('Effort: High is chosen in the footer for the fixes, and the job keeps it', async () => {
    const effort = dialog.getByRole('button', { name: /^Effort:/ });
    await expect(effort).toHaveText(EFFORT_BUTTON_DEFAULT);
    expect((await jobNamed(JOB)).effort).toBeNull();

    await effort.click();
    await page.getByRole('menuitemradio', { name: /^High/ }).click();
    await expect(effort).toHaveText('Effort: High');
    // Without Quick fixes the level is the job's own; with them it is the level of its review rounds
    // and the edit's stays as it was.
    await expect.poll(async () => (await jobNamed(JOB))[REVIEW_EFFORT_FIELD]).toBe('high');
    if (QUICK_FIXES_ON) expect((await jobNamed(JOB)).effort).toBeNull();
    // It is in Review that the level is asked for: the job is still there, with its notes.
    expect(await jobNamed(JOB)).toMatchObject({ state: 'review', round: 0 });
    await expect(dialog.getByRole('button', { name: 'Send 2 notes', exact: true })).toBeEnabled();
  });

  await test.step('Send: the dialog closes and a revise run starts at round 1', async () => {
    // Read before Send: the API stops listing the notes once they are sent.
    const sent = await notesOf(id);
    expect(sent).toHaveLength(2);

    await dialog.getByRole('button', { name: 'Send 2 notes', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Sent 2 notes' }),
    ).toBeVisible();

    await expect(stepBar(row)).toBeVisible(RUN);
    // One round of notes was sent, so the revise run makes the second cut: the row says round 2.
    await expect(row).toContainText('round 2');
    // The fixes round is the job's own: it keeps the level that was chosen in Review.
    expect(await jobNamed(JOB)).toMatchObject({
      runKind: 'revise',
      round: 1,
      [REVIEW_EFFORT_FIELD]: 'high',
    });

    // The notes are closed while the job edits.
    expect(await post(`/jobs/${id}/notes`, { atSec: 1, text: 'Too late' })).toEqual({
      status: 409,
      json: { error: 'Notes can only be changed while the job is in Review.' },
    });

    const roundFile = await readFile(join(jobDir(), 'edit', 'review', 'round-1.md'), 'utf8');
    expect(roundFile).toBe(renderRoundFile({ job: JOB, client: CLIENT, round: 1, notes: sent }));
    expect(roundFile.split('\n')[0]).toBe('# Review notes, round 1: Review loop (Acme)');
    expect(roundFile).toContain(`- 0:02.0 — ${TEXT_NOTE}`);
    expect(roundFile).toMatch(
      /^- 0:04\.0 — voice note \(edit\/review\/voice\/[^)]+\.webm\): "\[voice note, fake transcript\]"$/m,
    );
  });

  await test.step('back in Review at round 1: the new preview, no notes, nothing to send', async () => {
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    await expect(row).toContainText('Ready to review · 0:06 · round 2');

    const preview = await fetch(`${engine.baseURL}/api/jobs/${id}/preview/index.html`);
    expect(await preview.text()).toContain('Round 1');
    expect(await readFile(join(jobDir(), 'edit', 'project.md'), 'utf8')).toContain('## Round 1');

    await openRowMenu(page, row);
    await expect(rowMenu(page).getByRole('menuitem').first()).toHaveText('Review…');
    await menuItem(page, 'Review…').click();
    await expect(dialog).toBeVisible();
    await expectPlayerReady(1);

    await expect(dialog).toContainText(
      'No notes yet. Pause where something should change, then write or record a note below.',
    );
    await expect(approve).toHaveCount(0);
    await expect(footer).toContainText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video.',
    );
    await expect(sendButton).toHaveCount(0);
    expect((await post(`/jobs/${id}/send-notes`)).status).toBe(409);
  });

  await test.step('Approve from the row’s right-click menu, after Review…: a render run follows, and the job is Approved', async () => {
    await approveFromRowMenu(page, row);
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'the final video is rendering' }),
    ).toBeVisible();

    await expect(badge(row, 'Approved')).toBeVisible(RUN);
    const job = await jobNamed(JOB);
    expect(job).toMatchObject({ state: 'ready', runKind: 'render', round: 1 });
    expect(job.approvedAt).not.toBeNull();
    expect(existsSync(join(jobDir(), 'edit', 'final.mp4'))).toBe(true);

    const served = await expectDownloadServesMp4(page, row, JOB);
    const exported = await readFile(join(engine.exportsDir, CLIENT, `${JOB}.mp4`));
    expect(served.equals(exported), 'the download is the export').toBe(true);
  });

  await test.step('the row went arriving, editing, review, editing, review, editing, ready', async () => {
    const trail = await trailOf(page, row);
    expectStates(trail, ['arriving', 'editing', 'review', 'editing', 'review', 'editing', 'ready']);

    // Three runs: the edit, the revise run (from Plan: three steps are done when it starts) and
    // the render run (from Render: seven are done).
    const runs = editingRuns(trail);
    expect(runs).toHaveLength(3);
    expect(runs[1]?.[0]?.done).toBe(3);
    expect(runs[2]?.[0]?.done).toBe(7);

    expect(pageErrors).toEqual([]);
    expect(offOrigin).toEqual([]);

    const trails = await page.evaluate(() => (window as unknown as { __trails: unknown }).__trails);
    await test.info().attach('row-trails.json', {
      body: JSON.stringify(trails, null, 2),
      contentType: 'application/json',
    });
  });

  await test.step('Unapprove: the approved job is back in Review with its composition, and the export file stays', async () => {
    await openRowMenu(page, row);
    await menuItem(page, 'Unapprove').click();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Back in Review' }),
    ).toBeVisible();

    await expect(badge(row, 'Review')).toBeVisible(RUN);
    const job = await jobNamed(JOB);
    expect(job).toMatchObject({ state: 'review', runKind: 'revise', round: 1, approvedAt: null });
    expect(existsSync(join(jobDir(), 'edit', 'preview', 'index.html'))).toBe(true);
    // The file in the exports folder is left alone until the next render replaces it.
    expect(existsSync(join(engine.exportsDir, CLIENT, `${JOB}.mp4`))).toBe(true);

    // Approve can be asked for again: Unapprove is not offered in Review.
    await openRowMenu(page, row);
    await expect(menuItem(page, 'Unapprove')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
