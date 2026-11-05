// V2: one test that proves the whole loop works. The built server runs the fake runner against a
// temp inbox; a browser drives the Jobs page. Nothing is mocked: files are written into the inbox,
// the watcher sees them, the queue worker "edits" them, and the page follows over SSE.
//
// Runs with the Review switch off (`STUDIO_REVIEW=0`): the flow every job had before Phase 3.
//
// Four jobs, run through the one serial queue:
//   Spring promo   arrives -> queues -> edits (the editing icon fills up) -> ready -> download is an mp4
//   Broken render  `.fail-at-render` -> Failed at Render -> marker removed -> Retry -> ready
//   Brief fails    `.fail-at-brief` -> Failed at Brief -> "Retry from Brief" is offered
//   Held cut       arrives behind another job -> "Add note…" from the right-click menu (the job is held while
//                  the dialog is open, then back in line with its note and a marker) -> Hold (menu) ->
//                  note saved by the API (refused while editing) -> Release
//   Cancel me      cancelled while editing, from the right-click menu and the confirmation dialog -> Resume -> ready
//
// An approved job's right-click menu has "Use this look for <client>…" (off, and saying so, on
// the job the client's look already comes from) before its last group, Archive (archive.spec.ts
// covers it): the dialog shows the two stills, the message says
// the client now uses the look, and its Undo brings the earlier one back. Every finished job adds
// its look to its client's style (C10), so the look comes from the job that finished last.
//
// The Action column holds only the step that moves a job forward (Start now, Release, Retry, Resume,
// Mark delivered); Add note…, Hold, Cancel…, Download MP4 and Copy error are in the row's right-click
// menu.
//
// When the jobs are done, Clients (sidebar) lists the client with its job count; its row opens the
// client's page, which is the Jobs list with this client's five jobs and no client names. A 1280 px
// window shows the whole list without scrolling sideways.

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expectDownloadServesMp4, isMp4 } from './support/download.ts';
import { expect, test } from './support/fixtures.ts';
import {
  action,
  badge,
  chooseFromRowMenu,
  doneSegments,
  editingRuns,
  expectNoTooltipAfterDialogClosed,
  expectStates,
  jobOnServer,
  menuItem,
  noteDialog,
  noteMarker,
  openRowMenu,
  recordRows,
  rowMenu,
  rowOf,
  stepBar,
  trailOf,
} from './support/jobs-ui.ts';

const CLIENT = 'Acme';
const JOB = {
  happy: 'Spring promo',
  broken: 'Broken render',
  held: 'Held cut',
  cancel: 'Cancel me',
} as const;
/** Fails at Brief, the first step, and stays failed: it is not one of the jobs that finish. */
const BRIEF_JOB = 'Brief fails';

/** A whole fake edit takes about 15 s at the test speed; a job may also wait behind another one. */
const RUN = { timeout: 60_000 };

/** The menu of a finished job whose look is the client's: the look item says so and is off. */
const LOOK_SOURCE_MENU = [
  'Add note…',
  'Rename…',
  'Effort',
  'Mark delivered',
  'Download MP4',
  `${CLIENT}’s look comes from this job`,
  // Series are on by default (K12): an approved video can start one.
  'Start a series from this…',
  'Archive',
  // Every state's menu ends with Delete… (v0.26.0).
  'Delete…',
];

interface JobOnList {
  id: string;
  name: string;
  clientId: string;
}

/**
 * The jobs, and the name of the job the client's look comes from once its style runs are over:
 * every finished job queues a Learn pass that adds its look (C10), and Use this look is refused
 * while one runs.
 */
async function settledLook(page: Page): Promise<{ jobs: JobOnList[]; source: string }> {
  const jobs = (await (await page.request.get('/api/jobs')).json()) as JobOnList[];
  const clientId = jobs[0]?.clientId;
  let sourceJobId = null as string | null;
  await expect
    .poll(async () => {
      const style = (await (await page.request.get(`/api/clients/${clientId}/style`)).json()) as {
        state: string;
        pass?: unknown;
        sourceJobId: string | null;
      };
      sourceJobId = style.sourceJobId;
      return style.state === 'ready' && (style.pass ?? null) === null;
    }, RUN)
    .toBe(true);
  const source = jobs.find((job) => job.id === sourceJobId)?.name;
  expect(source, 'the client’s look comes from one of its jobs').toBeDefined();
  return { jobs, source: source as string };
}

const STEP_NAMES = ['Brief', 'Transcribe', 'Scan', 'Plan', 'Cut', 'Preview', 'Check', 'Render'];

test('a job goes from the inbox to a downloadable mp4, and every action works', async ({
  page,
  engine,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await test.step('the page opens on an empty, isolated engine', async () => {
    await page.goto('/');
    // A browser that has never seen this version is greeted with "What's new"; it blocks the page.
    const whatsNew = page.getByRole('dialog', { name: /What's new/ });
    await whatsNew.waitFor({ timeout: 5_000 }).then(
      () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
      () => {}, // no dialog: nothing to dismiss
    );
    await expect(whatsNew).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    // A fresh database: the real ~/.studio-engine has not been read.
    const jobs = await (await page.request.get('/api/jobs')).json();
    expect(jobs).toEqual([]);
    await recordRows(page);
  });

  const happy = rowOf(page, JOB.happy);
  const broken = rowOf(page, JOB.broken);
  const held = rowOf(page, JOB.held);
  const cancel = rowOf(page, JOB.cancel);

  await test.step('a new job arrives, then edits with an icon that fills up step by step', async () => {
    await engine.createJob({ client: CLIENT, job: JOB.happy });
    await expect(badge(happy, 'Arriving')).toBeVisible();
    await expect(happy).toContainText(CLIENT);
    await expect(happy).toContainText(/Arriving · settles in \d:\d\d/);
    // An arriving job can be started at once: Start now is its one button, a plain icon button
    // (no fill, outline or shadow, a pointer cursor) that gets a background on hover. Hold is in
    // the row's menu, not a button.
    const start = action(happy, 'Start now');
    await expect(start).toBeVisible();
    await expect(action(happy, 'Hold')).toHaveCount(0);
    await expect(start).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(start).toHaveCSS('box-shadow', 'none');
    await expect(start).toHaveCSS('border-top-width', '0px');
    await expect(start).toHaveCSS('cursor', 'pointer');
    await start.hover();
    await expect(start).toHaveCSS('background-color', 'rgb(39, 39, 42)');

    await expect(stepBar(happy)).toBeVisible(RUN);
    // An editing job has no button at all: its Cancel… is in the menu.
    await expect(happy.getByRole('button')).toHaveCount(0);
    await expect(action(happy, 'Cancel')).toHaveCount(0);
  });

  await test.step('a second job queues behind the one that is editing', async () => {
    await engine.createJob({ client: CLIENT, job: JOB.broken, failAt: 'render' });
    await expect(badge(broken, 'Arriving')).toBeVisible();
    await expect(badge(broken, 'Queued')).toBeVisible(RUN);
    await expect(broken).toContainText('#1 in line');
    // The first job is still going: that is why the second one waits.
    await expect(stepBar(happy)).toBeVisible();
  });

  await test.step('the first job becomes ready and its download is an mp4', async () => {
    await expect(badge(happy, 'Approved')).toBeVisible(RUN);
    // The length and the size of the export, and no frame size.
    await expect(happy).toContainText(/\d:\d\d · (< 1|\d+(\.\d)?) (MB|GB)/);
    await expect(happy).not.toContainText('×');

    const trail = await trailOf(page, happy);
    expectStates(trail, ['arriving', 'editing', 'ready']);

    // The editing icon advanced through the eight steps, never backwards, and ended on Render.
    const [firstRun] = editingRuns(trail);
    const done = (firstRun ?? []).map((snapshot) => snapshot.done);
    expect(done, `done segments over time: ${done.join(' ')}`).toEqual(
      [...done].sort((a, b) => a - b),
    );
    expect(new Set(done).size, `done segments over time: ${done.join(' ')}`).toBeGreaterThanOrEqual(
      4,
    );
    expect(Math.max(...done)).toBe(7);
    const stepsSeen = new Set((firstRun ?? []).map((snapshot) => snapshot.step.split(' · ')[0]));
    expect(stepsSeen.has('Brief')).toBe(true);
    expect(stepsSeen.has('Transcribe')).toBe(true);
    expect(stepsSeen.has('Render')).toBe(true);
    for (const name of stepsSeen) expect(STEP_NAMES, `step "${name}"`).toContain(name);

    // The same file arrives three ways: the menu link's response, the browser's download and the export.
    const served = await expectDownloadServesMp4(page, happy, JOB.happy);
    await openRowMenu(page, happy);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      menuItem(page, 'Download MP4').click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${JOB.happy}.mp4`);
    const saved = await readFile(await download.path());
    expect(isMp4(saved)).toBe(true);
    expect(saved.equals(served)).toBe(true);

    const exported = await readFile(join(engine.exportsDir, CLIENT, `${JOB.happy}.mp4`));
    expect(exported.equals(served)).toBe(true);
  });

  await test.step('a job with .fail-at-render fails at Render, and Retry finishes it', async () => {
    await expect(stepBar(broken)).toBeVisible(RUN);
    const failed = broken.getByRole('button', { name: 'Failed at Render' });
    await expect(failed).toBeVisible(RUN);
    await expect(broken).toContainText('at Render');
    await expect(action(broken, 'Retry from Render')).toBeVisible();
    await expect(action(broken, 'Copy error')).toHaveCount(0);
    await failed.hover();
    await expect(page.getByRole('tooltip')).toContainText('injected failure (.fail-at-render)');

    // Copy error is in the row's menu: it copies the error, closes the menu and says so in a toast.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: engine.baseURL,
    });
    const menu = await openRowMenu(page, broken);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Add note…',
      'Rename…',
      'Effort',
      'Retry from Render',
      'Copy error',
      'Archive',
      'Delete…',
    ]);
    await menuItem(page, 'Copy error').click();
    await expect(menu).toBeHidden();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Error copied' }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      'injected failure (.fail-at-render)',
    );

    // The marker is removed first, then the job is retried from the step it failed at.
    await rm(join(engine.inbox, CLIENT, JOB.broken, '.fail-at-render'));
    await action(broken, 'Retry from Render').click();
    await expect(badge(broken, 'Approved')).toBeVisible(RUN);

    const trail = await trailOf(page, broken);
    expectStates(trail, ['arriving', 'queued', 'editing', 'failed', 'editing', 'ready']);
    // Retry carries on at Render (seven steps done), it does not start over.
    expect(editingRuns(trail).at(-1)?.[0]?.done).toBe(7);

    await expectDownloadServesMp4(page, broken, JOB.broken);
  });

  await test.step('a job with .fail-at-brief fails at Brief, with "Retry from Brief" offered', async () => {
    await engine.createJob({ client: CLIENT, job: BRIEF_JOB, failAt: 'brief' });
    const row = rowOf(page, BRIEF_JOB);
    // While it still arrives, the row's menu offers the note, Start now and Hold; the button
    // starts it at once, without waiting for its files to settle.
    await expect(badge(row, 'Arriving')).toBeVisible();
    const arrivingMenu = await openRowMenu(page, row);
    await expect(arrivingMenu.getByRole('menuitem')).toHaveText([
      'Add note…',
      'Rename…',
      'Effort',
      'Start now',
      'Hold',
      'Delete…',
    ]);
    await page.keyboard.press('Escape');
    await expect(arrivingMenu).toBeHidden();
    await action(row, 'Start now').click();
    const failed = row.getByRole('button', { name: 'Failed at Brief' });
    await expect(failed).toBeVisible(RUN);
    await expect(row).toContainText('at Brief');
    await expect(action(row, 'Retry from Brief')).toBeVisible();
    await failed.hover();
    await expect(page.getByRole('tooltip')).toContainText('injected failure (.fail-at-brief)');

    // It stopped at the very first step, so no segment was ever finished. (It fails within a
    // fraction of a second of starting, so the page may never have drawn the editing row at all.)
    const trail = await trailOf(page, row);
    expectStates(trail, ['arriving', 'failed']);
    for (const snapshot of editingRuns(trail).flat()) expect(snapshot.done).toBe(0);
  });

  await test.step('a queued job can be held and released', async () => {
    // "Cancel me" edits, and "Held cut" arrives right behind it, so it has to wait in the queue.
    await engine.createJob({ client: CLIENT, job: JOB.cancel });
    await expect(badge(cancel, 'Arriving')).toBeVisible();
    await engine.createJob({ client: CLIENT, job: JOB.held });
    await expect(badge(held, 'Arriving')).toBeVisible();

    await test.step('a refused Hold opens no dialog and says why', async () => {
      // The job has "just started editing" as far as the server is concerned: it refuses the Hold.
      const reason = 'Only an arriving or queued job can be held.';
      await page.route('**/api/jobs/*/hold', (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: reason }),
        }),
      );
      await chooseFromRowMenu(page, held, 'Add note…');

      const toast = page.locator('[data-sonner-toast]').filter({ hasText: reason });
      await expect(toast).toBeVisible();
      await expect(toast).toContainText("Couldn't hold");
      await expect(toast).toContainText(JOB.held);
      await expect(noteDialog(page)).toBeHidden();
      // The page put the job back where it was, and nothing was held on the server.
      await expect(badge(held, 'Held')).toHaveCount(0);
      expect((await jobOnServer(page, JOB.held)).state).not.toBe('held');
      await page.unroute('**/api/jobs/*/hold');
      // Messages have no close × (CVP-208): this one goes away on its own.
    });

    await test.step('a note is added from the row menu: the job waits while the dialog is open', async () => {
      const note = 'Keep it under 30 seconds.\nOpen on the team, not the building.';
      const dialog = noteDialog(page);

      // The menu leads with the note, then a line, then the actions of the state.
      const menu = await openRowMenu(page, held);
      await expect(menu.getByRole('menuitem').first()).toHaveText('Add note…');
      // One line in the menu's own list, and the one above Delete… (v0.26.0).
      await expect(menu.getByRole('separator')).toHaveCount(2);
      await menuItem(page, 'Add note…').click();
      await expect(menu).toBeHidden();

      // The dialog says whose job it is and what the note is for, and has the focus in its box.
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(JOB.held);
      await expect(dialog).toContainText(CLIENT);
      await expect(dialog).toContainText('your note wins over everything the client sent');
      const box = dialog.getByRole('textbox', { name: 'Note' });
      await expect(box).toBeFocused();
      await expect(box).toHaveValue('');
      await expect(box).toHaveAttribute('dir', 'auto');
      await expect(box).toHaveAttribute('maxlength', '4000');
      // Fonts in notes (FN23), LUTs in edits (LU14) and graphics in edits (GR11) are all on by
      // default: the box has the @ picker, and the placeholder says what it points at.
      await expect(box).toHaveAttribute(
        'placeholder',
        'e.g. Keep it under 30 seconds. Type @ to point at a font, a LUT or a graphic.',
      );

      // Opening it held the job, and the dialog says so; so does the row.
      await expect(dialog).toContainText(
        'This job waits while you write. Saving puts it back in line.',
      );
      await expect(badge(held, 'Held')).toBeVisible();
      await expect(held).toContainText('while you write a note');
      expect((await jobOnServer(page, JOB.held)).state).toBe('held');
      await expect(noteMarker(held)).toHaveCount(0);

      // It does not move on while the person writes, even past the settle delay (2 s here).
      await box.fill(note);
      await page.waitForTimeout(2_500);
      await expect(badge(held, 'Held')).toBeVisible();
      expect((await jobOnServer(page, JOB.held)).state).toBe('held');

      // Save puts the note on the server and the job back in line, behind the one that is editing.
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      await expect(badge(held, 'Held')).toHaveCount(0);
      await expect(badge(held, 'Queued')).toBeVisible(RUN);
      expect(await jobOnServer(page, JOB.held)).toMatchObject({ note });

      // The job's name now has a marker after it, and hovering it shows the note, line break kept.
      const marker = noteMarker(held);
      await expect(marker).toBeVisible();
      await expect(marker).toHaveAttribute('tabindex', '0');
      await marker.hover();
      const tip = page.getByRole('tooltip');
      await expect(tip).toContainText('Keep it under 30 seconds.');
      await expect(tip).toContainText('Open on the team, not the building.');
      await expect(tip).toHaveCSS('white-space', 'pre-line');
      await expect(tip).toHaveCSS('max-width', '280px');
      await expect(tip).toHaveAttribute('dir', 'auto');

      // The list re-sorts by "Last updated" while the pointer rests on the marker (the job that is
      // editing keeps updating), and React then moves the row's DOM node. Chrome sends no
      // pointerleave to a node that was moved, so a tooltip that waits for one never closes. That
      // happened in about half the runs, whenever the move landed between the hover and the
      // pointer leaving. Do the same move here on purpose (out and back in at the same place, as
      // React's own insertBefore does) so every run covers it.
      await held.evaluate((row) => {
        const parent = row.parentElement;
        const next = row.nextSibling;
        row.remove();
        parent?.insertBefore(row, next);
      });

      // Moving the pointer away closes it (a few moves, as a hand makes).
      await page.mouse.move(700, 800, { steps: 10 });
      await expect(tip).toBeHidden();

      // And hovering the marker again shows the note again, once the row has been moved.
      await marker.hover();
      await expect(tip).toContainText('Keep it under 30 seconds.');
      await page.mouse.move(700, 800, { steps: 10 });
      await expect(tip).toBeHidden();
    });

    await test.step('Cancel and Escape put the job back without a note, and Edit note… shows the old one', async () => {
      const dialog = noteDialog(page);
      const box = dialog.getByRole('textbox', { name: 'Note' });
      const saved = (await jobOnServer(page, JOB.held)).note;
      expect(saved).toContain('Keep it under 30 seconds.');

      // Cancel.
      await chooseFromRowMenu(page, held, 'Edit note…');
      await expect(dialog).toBeVisible();
      await expect(box).toHaveValue(saved ?? '');
      await expect(badge(held, 'Held')).toBeVisible();
      await box.fill('Thrown away with Cancel');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(badge(held, 'Held')).toHaveCount(0);
      await expect(badge(held, 'Queued')).toBeVisible();

      // Escape.
      await chooseFromRowMenu(page, held, 'Edit note…');
      await expect(dialog).toBeVisible();
      await expect(box).toHaveValue(saved ?? '');
      await expect(badge(held, 'Held')).toBeVisible();
      await box.fill('Thrown away with Escape');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(badge(held, 'Held')).toHaveCount(0);
      await expect(badge(held, 'Queued')).toBeVisible();

      // Neither changed the note.
      expect(await jobOnServer(page, JOB.held)).toMatchObject({ note: saved, state: 'queued' });
    });

    await expect(stepBar(cancel)).toBeVisible(RUN);
    await expect(badge(held, 'Queued')).toBeVisible(RUN);
    await expect(held).toContainText('#1 in line');

    // A queued job has no button; its menu holds the note and Hold, and ends with Delete… (v0.26.0).
    await expect(held.getByRole('button')).toHaveCount(0);
    const queuedMenu = await openRowMenu(page, held);
    await expect(queuedMenu.getByRole('menuitem')).toHaveText([
      'Edit note…',
      'Rename…',
      'Effort',
      'Hold',
      'Delete…',
    ]);
    await menuItem(page, 'Hold').click();
    await expect(queuedMenu).toBeHidden();
    await expect(badge(held, 'Held')).toBeVisible();
    await expect(action(held, 'Release')).toBeVisible();
    await expect(action(held, 'Hold')).toHaveCount(0);

    // Note for the editor on a held job: Cancel leaves it held, and focus goes back to its Release
    // button with no tooltip.
    await chooseFromRowMenu(page, held, 'Edit note…');
    await expect(noteDialog(page)).toBeVisible();
    await noteDialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(noteDialog(page)).toBeHidden();
    await expect(badge(held, 'Held')).toBeVisible();
    await expectNoTooltipAfterDialogClosed(page, held, 'Release');

    // The engine saves the note of a held job, and refuses it for the job that is editing.
    const listed = (await (await page.request.get('/api/jobs')).json()) as {
      id: string;
      name: string;
    }[];
    const heldId = listed.find((job) => job.name === JOB.held)?.id;
    const editingId = listed.find((job) => job.name === JOB.cancel)?.id;
    const saved = await page.request.put(`/api/jobs/${heldId}/note`, {
      data: { note: '  Keep it under 30 seconds.  ' },
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).note).toBe('Keep it under 30 seconds.');
    const refused = await page.request.put(`/api/jobs/${editingId}/note`, {
      data: { note: 'Too late' },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toBe('Cannot edit the note of a job that is editing.');

    await action(held, 'Release').click();
    await expect(badge(held, 'Queued')).toBeVisible();
    await expect(action(held, 'Release')).toHaveCount(0);
    await expect(held).toContainText('#1 in line');

    expectStates(await trailOf(page, held), ['arriving', 'queued', 'held', 'queued']);
  });

  await test.step('an editing job is cancelled through the dialog, then resumed', async () => {
    // Let it get past a few steps, so that Resume has something to carry on from.
    await expect.poll(() => doneSegments(cancel)).toBeGreaterThanOrEqual(3);

    // Cancel… is in the menu of the editing row (red); it opens the confirmation dialog.
    const dialog = page.getByRole('alertdialog', { name: 'Stop this edit?' });
    const editingMenu = await openRowMenu(page, cancel);
    // The note cannot change any more (the edit has read it): its item is there but off.
    await expect(editingMenu.getByRole('menuitem')).toHaveText([
      'Add note…',
      'Rename…',
      'Effort',
      'Cancel…',
      'Delete…',
    ]);
    await expect(menuItem(page, 'Add note…')).toHaveAttribute('data-disabled');
    await expect(menuItem(page, 'Cancel…')).toHaveAttribute('data-variant', 'destructive');
    await menuItem(page, 'Cancel…').click();
    await expect(editingMenu).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Finished steps are kept');
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog).toBeHidden();
    await expect(stepBar(cancel)).toBeVisible();

    await chooseFromRowMenu(page, cancel, 'Cancel…');
    await dialog.getByRole('button', { name: 'Stop edit' }).click();
    await expect(dialog).toBeHidden(RUN);
    await expect(badge(cancel, 'Cancelled')).toBeVisible();
    await expect(cancel).toContainText(new RegExp(`at (${STEP_NAMES.join('|')})`));
    await expect(action(cancel, 'Resume')).toBeVisible();

    // The queue moves on: the held-and-released job gets the worker.
    await expect(stepBar(held)).toBeVisible(RUN);

    // Resume puts the job back in line, behind the one that is editing.
    await action(cancel, 'Resume').click();
    await expect(badge(cancel, 'Queued')).toBeVisible();
    await expect(cancel).toContainText('#1 in line');

    await expect(badge(held, 'Approved')).toBeVisible(RUN);
    await expect(stepBar(cancel)).toBeVisible(RUN);
    await expect(badge(cancel, 'Approved')).toBeVisible(RUN);

    const trail = await trailOf(page, cancel);
    expectStates(trail, ['arriving', 'editing', 'cancelled', 'queued', 'editing', 'ready']);
    // Resume carries on from the step it stopped at: the bar does not start from zero.
    expect(editingRuns(trail).at(-1)?.[0]?.done).toBeGreaterThanOrEqual(3);
    expectStates(await trailOf(page, held), [
      'arriving',
      'queued',
      'held',
      'queued',
      'editing',
      'ready',
    ]);
  });

  await test.step('the row menu opens from the keyboard', async () => {
    const { source } = await settledLook(page);
    const row = rowOf(page, source);

    // Shift+F10 and the menu key open the menu of the focused row.
    await row.focus();
    await page.keyboard.press('Shift+F10');
    // A finished job's note cannot change any more: the item is there but off. This job finished
    // last, so the client's look comes from it: Use this look is off too.
    await expect(rowMenu(page).getByRole('menuitem')).toHaveText(LOOK_SOURCE_MENU);
    await expect(menuItem(page, 'Add note…')).toHaveAttribute('data-disabled');
    await page.keyboard.press('Escape');
    await expect(rowMenu(page)).toBeHidden();
    await row.focus();
    await page.keyboard.press('ContextMenu');
    await expect(rowMenu(page).getByRole('menuitem')).toHaveText(LOOK_SOURCE_MENU);

    // Download MP4 in the menu is a link to the finished video.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      menuItem(page, 'Download MP4').click(),
    ]);
    expect(download.suggestedFilename()).toBe(`${source}.mp4`);
    await expect(rowMenu(page)).toBeHidden();

    // The list has no header row and no Columns menu.
    await expect(page.getByRole('columnheader')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Columns' })).toHaveCount(0);
  });

  await test.step('Use this look: a finished job becomes its client’s look, and Undo brings the old one back', async () => {
    const { jobs, source } = await settledLook(page);
    const idOf = (name: string) => jobs.find((job) => job.name === name)?.id;
    const clientId = jobs.find((job) => job.name === JOB.happy)?.clientId;
    // A finished job whose look is not the client's.
    const other = source === JOB.broken ? JOB.happy : JOB.broken;
    const lookSource = async () => {
      const style = (await (await page.request.get(`/api/clients/${clientId}/style`)).json()) as {
        state: string;
        sourceJobId: string | null;
      };
      return [style.state, style.sourceJobId];
    };
    // The client's finished jobs set its look by themselves, the last one to finish last.
    expect(await lookSource()).toEqual(['ready', idOf(source)]);

    // Another approved job offers its look: the item follows Download MP4 and a line, and the
    // archive group ends the menu.
    const row = rowOf(page, other);
    const menu = await openRowMenu(page, row);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Add note…',
      'Rename…',
      'Effort',
      'Mark delivered',
      'Download MP4',
      `Use this look for ${CLIENT}…`,
      'Start a series from this…',
      'Archive',
      'Delete…',
    ]);
    await expect(menuItem(page, `Use this look for ${CLIENT}…`)).not.toHaveAttribute(
      'data-disabled',
    );
    await menuItem(page, `Use this look for ${CLIENT}…`).click();
    await expect(menu).toBeHidden();

    // The dialog shows the look now (the source job's still) next to the new one (this job's).
    const dialog = page.getByRole('alertdialog', { name: `Use this look for ${CLIENT}?` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('is kept in history, and finished jobs don’t change');
    await expect(dialog.getByRole('img', { name: `Now look, from ${source}` })).toBeVisible();
    await expect(dialog.getByRole('img', { name: `New look, from ${other}` })).toBeVisible();
    const stills = dialog.locator('img');
    await expect(stills).toHaveCount(2);
    await expect(stills.nth(0)).toHaveAttribute('src', `/api/jobs/${idOf(source)}/still`);
    await expect(stills.nth(1)).toHaveAttribute('src', `/api/jobs/${idOf(other)}/still`);
    await expect
      .poll(() =>
        stills.evaluateAll((images) =>
          images.map((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toEqual([true, true]);

    // Cancel changes nothing. Focus goes back to the row's Mark delivered button, with no tooltip.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await lookSource()).toEqual(['ready', idOf(source)]);
    await expectNoTooltipAfterDialogClosed(page, row, 'Mark delivered');

    // Use this look: the message says so, with Undo, and the server learns the look from this job.
    await chooseFromRowMenu(page, row, `Use this look for ${CLIENT}…`);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Use this look' }).click();
    await expect(dialog).toBeHidden();
    const message = page.locator('[data-sonner-toast]').filter({
      hasText: `${CLIENT} now uses the look from ${other}.`,
    });
    await expect(message).toBeVisible();
    await expect.poll(lookSource).toEqual(['ready', idOf(other)]);

    // The look now comes from this job: its item says so and is off, and the earlier one's is on.
    const current = await openRowMenu(page, row);
    await expect(menuItem(page, `${CLIENT}’s look comes from this job`)).toHaveAttribute(
      'data-disabled',
    );
    await page.keyboard.press('Escape');
    await expect(current).toBeHidden();
    await openRowMenu(page, rowOf(page, source));
    await expect(menuItem(page, `Use this look for ${CLIENT}…`)).toBeVisible();
    await page.keyboard.press('Escape');

    // Undo puts the earlier look back.
    await message.getByRole('button', { name: 'Undo' }).click();
    await expect(
      page
        .locator('[data-sonner-toast]')
        .filter({ hasText: `${CLIENT} is back to its earlier look.` }),
    ).toBeVisible();
    await expect.poll(lookSource).toEqual(['ready', idOf(source)]);
  });

  await test.step('every job is ready, exported and downloadable', async () => {
    for (const name of Object.values(JOB)) {
      const row = rowOf(page, name);
      await expect(badge(row, 'Approved')).toBeVisible();
      const served = await expectDownloadServesMp4(page, row, name);
      const exported = await readFile(join(engine.exportsDir, CLIENT, `${name}.mp4`));
      expect(exported.equals(served), `${name}: the export is what the link serves`).toBe(true);
    }
    expect(pageErrors).toEqual([]);

    // The states every row went through, for whoever has to find out why a run went differently.
    const trails = await page.evaluate(() => (window as unknown as { __trails: unknown }).__trails);
    await test.info().attach('row-trails.json', {
      body: JSON.stringify(trails, null, 2),
      contentType: 'application/json',
    });
  });

  await test.step('Clients lists the client, and its page lists the same jobs', async () => {
    // Five jobs of one client: the four that finished and the one that failed at Brief.
    const jobCount = Object.values(JOB).length + 1;
    const sidebar = page.getByRole('navigation', { name: 'Main' });
    const crumbs = page.getByRole('navigation', { name: 'breadcrumb' });
    const clientsTable = page.getByRole('table', { name: 'Clients' });
    const clientRow = page.locator('tr[data-client-id]').filter({ hasText: CLIENT });

    // Sidebar → Clients: one row, with how many jobs the client has.
    await sidebar.getByRole('link', { name: 'Clients' }).click();
    await expect(page).toHaveURL(/\/clients$/);
    await expect(sidebar.getByRole('link', { name: 'Clients' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { name: 'Clients', level: 1 })).toBeVisible();
    // "Assigned to" (TM5) is the admin's too, but only once there is an editor on the team or a
    // client assigned: this engine has neither, so the table has the board's three columns (C98).
    await expect(clientsTable.getByRole('columnheader')).toHaveText(['Client', 'Jobs', 'Last job']);
    await expect(page.locator('tr[data-client-id]')).toHaveCount(1);
    await expect(clientRow.getByRole('cell').nth(1)).toHaveText(String(jobCount));
    await expect(page.getByText('1 client', { exact: true })).toBeVisible();

    // The search narrows the list by name.
    const search = page.getByRole('searchbox', { name: 'Search clients' });
    await search.fill('zzz');
    await expect(page.getByText('No matching clients.')).toBeVisible();
    await expect(page.getByText('0 of 1 client', { exact: true })).toBeVisible();
    await search.fill(CLIENT.toLowerCase());
    await expect(clientRow).toBeVisible();
    await search.fill('');

    // The row's menu: Open, View style, Assign to… (the admin's), a line, Show in Finder (not
    // chosen: it would open Finder).
    await clientRow.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: `Actions for ${CLIENT}` });
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Open',
      'View style',
      'Assign to…',
      'Show in Finder',
    ]);
    await expect(menu.getByRole('separator')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // The name is the row's link: it opens with Enter, and a click anywhere on the row follows it.
    await clientRow.getByRole('link', { name: CLIENT }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}$/);
    await crumbs.getByRole('link', { name: 'Clients' }).click();
    await expect(page).toHaveURL(/\/clients$/);
    await clientRow.click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f]{12}$/);

    // The client's page: who it is, and the Jobs list with this client's jobs only.
    const clientUrl = page.url();
    await expect(page.getByRole('heading', { name: CLIENT, level: 1 })).toBeVisible();
    await expect(page.getByText(`${jobCount} jobs · last job`)).toBeVisible();
    await expect(crumbs).toContainText(`Clients${CLIENT}`);
    await expect(sidebar.getByRole('link', { name: 'Clients' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('[data-job-id]')).toHaveCount(jobCount);
    for (const name of [...Object.values(JOB), BRIEF_JOB]) {
      await expect(rowOf(page, name)).toBeVisible();
      // Every row is this client's, so none says so: the Jobs page does (see the first job).
      await expect(rowOf(page, name)).not.toContainText(CLIENT);
    }
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);

    // It is the Jobs list's own: the row actions and the right-click menu work here too.
    await expectDownloadServesMp4(page, rowOf(page, JOB.happy), JOB.happy);
    const jobMenu = await openRowMenu(page, rowOf(page, BRIEF_JOB));
    await expect(jobMenu.getByRole('menuitem')).toHaveText([
      'Add note…',
      'Rename…',
      'Effort',
      'Retry from Brief',
      'Copy error',
      'Archive',
      'Delete…',
    ]);
    await page.keyboard.press('Escape');
    await expect(jobMenu).toBeHidden();
    // There is no Columns menu on this page either.
    await expect(page.getByRole('button', { name: 'Columns' })).toHaveCount(0);

    // A reload on the client's address lands on the same page (the server's SPA fallback).
    await page.reload();
    await expect(page).toHaveURL(clientUrl);
    await expect(page.getByRole('heading', { name: CLIENT, level: 1 })).toBeVisible();
    await expect(page.locator('[data-job-id]')).toHaveCount(jobCount);

    // An address with no client behind it says so, and links back.
    await page.goto('/clients/000000000000');
    await expect(page.getByText('No such client.')).toBeVisible();
    await page.getByRole('link', { name: 'Back to Clients' }).click();
    await expect(page).toHaveURL(/\/clients$/);

    // Back to Jobs through the sidebar.
    await sidebar.getByRole('link', { name: 'Jobs' }).click();
    await expect(page).toHaveURL(/\/jobs$/);
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
    await expect(page.locator('[data-job-id]')).toHaveCount(jobCount);
    expect(pageErrors).toEqual([]);
  });

  await test.step('a 1280 px window fits the list without scrolling: every row’s time and next step are in view', async () => {
    const jobCount = Object.values(JOB).length + 1;
    const rows = page.locator('[data-job-id]');
    const scrollsSideways = () =>
      page.evaluate(() => {
        const page = document.scrollingElement ?? document.documentElement;
        const list = document.querySelector('ul[aria-label="Jobs"]');
        const cut = (element: Element) => element.scrollWidth > element.clientWidth;
        // The page, the list and each row (a grid that is too narrow would spill out of its row).
        return cut(page) || (list !== null && [list, ...list.children].some(cut));
      });

    // At the 1440 px of the other steps the list fits.
    await expect(rows).toHaveCount(jobCount);
    expect(await scrollsSideways()).toBe(false);

    // At 1280 px it still does: every row's time and its one button (Mark delivered on a finished
    // job, Retry on the one that failed at Brief) are fully in view without scrolling.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(rows).toHaveCount(jobCount);
    for (let i = 0; i < jobCount; i += 1) {
      const row = rows.nth(i);
      await expect(row.locator('time')).toBeInViewport({ ratio: 1 });
      await expect(row.locator('[data-row-actions] a, [data-row-actions] button')).toBeInViewport({
        ratio: 1,
      });
    }
    expect(await scrollsSideways()).toBe(false);

    await page.setViewportSize({ width: 1440, height: 900 });
    expect(pageErrors).toEqual([]);
  });
});
