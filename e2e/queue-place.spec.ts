// U2: writing a note must not cost a queued job its turn. Its own engine (temp inbox, data folder
// and port), like brief.spec.ts, so smoke.spec.ts still starts on an empty one. The fake runner
// edits slowly here (a minute per job), so the job at the front of the queue stays queued while the
// test works on the Jobs page.
//
//   Editing now    edits for the whole test, so the other two wait in the queue
//   Queue first    queued, #1. "Add note…" holds it; Cancel puts it back at #1; Save puts it back
//                  at #1 with its note
//   Queue second   queued, #2. Moves up to #1 while the first one is held, then back to #2
//
// Then a manual Hold and Release from the row's menu and button still goes to the back of the line.

import { expect, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import {
  action,
  badge,
  chooseFromRowMenu,
  noteDialog,
  noteMarker,
  rowOf,
  stepBar,
} from './support/jobs-ui.ts';

const CLIENT = 'Acme';
const JOB = { editing: 'Editing now', first: 'Queue first', second: 'Queue second' } as const;

/** A fake edit takes a minute at speed 1: far longer than this spec. */
const FAKE_SPEED = 1;
const WAIT = { timeout: 30_000 };

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
  placeInLine: number | null;
  note: string | null;
}

async function jobsOnServer(): Promise<JobOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
}

/** Where the engine says each queued job stands: `{ 'Queue first': 1, 'Queue second': 2 }`. */
async function queuePlaces(): Promise<Record<string, number | null>> {
  return Object.fromEntries(
    (await jobsOnServer())
      .filter((job) => job.state === 'queued')
      .map((job) => [job.name, job.placeInLine]),
  );
}

test('a job keeps its place in line after the note dialog, and a manual Hold and Release does not', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await test.step('the page opens', async () => {
    await page.goto(engine.baseURL);
    // A browser that has never seen this version is greeted with "What's new"; it blocks the page.
    const whatsNew = page.getByRole('dialog', { name: /What's new/ });
    await whatsNew.waitFor({ timeout: 5_000 }).then(
      () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
      () => {}, // no dialog: nothing to dismiss
    );
    await expect(whatsNew).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
  });

  const editing = rowOf(page, JOB.editing);
  const first = rowOf(page, JOB.first);
  const second = rowOf(page, JOB.second);

  await test.step('one job edits, and two wait behind it, in the order they arrived', async () => {
    await engine.createJob({ client: CLIENT, job: JOB.editing });
    await expect(stepBar(editing)).toBeVisible(WAIT);

    await engine.createJob({ client: CLIENT, job: JOB.first });
    await expect(badge(first, 'Queued')).toBeVisible(WAIT);
    await engine.createJob({ client: CLIENT, job: JOB.second });
    await expect(badge(second, 'Queued')).toBeVisible(WAIT);

    await expect(first).toContainText('#1 in line');
    await expect(second).toContainText('#2 in line');
    expect(await queuePlaces()).toEqual({ [JOB.first]: 1, [JOB.second]: 2 });
  });

  const dialog = noteDialog(page);

  await test.step('Cancel in the note dialog puts the job back at #1', async () => {
    await chooseFromRowMenu(page, first, 'Add note…');
    await expect(dialog).toBeVisible();
    // While the person writes, the job waits and the one behind it moves up.
    await expect(badge(first, 'Held')).toBeVisible();
    await expect(second).toContainText('#1 in line');

    await dialog.getByRole('textbox', { name: 'Note' }).fill('Thrown away with Cancel');
    // Time passes while the dialog is open: a plain release would send the job to the back.
    await page.waitForTimeout(2_500);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await expect(badge(first, 'Queued')).toBeVisible();
    await expect(first).toContainText('#1 in line');
    await expect(second).toContainText('#2 in line');
    expect(await queuePlaces()).toEqual({ [JOB.first]: 1, [JOB.second]: 2 });
    expect((await jobsOnServer()).find((job) => job.name === JOB.first)?.note).toBeNull();
  });

  await test.step('Save in the note dialog puts the job back at #1 with its note', async () => {
    await chooseFromRowMenu(page, first, 'Add note…');
    await expect(dialog).toBeVisible();
    await expect(badge(first, 'Held')).toBeVisible();
    await expect(second).toContainText('#1 in line');

    await dialog.getByRole('textbox', { name: 'Note' }).fill('Keep it under 30 seconds.');
    await page.waitForTimeout(2_500);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await expect(badge(first, 'Queued')).toBeVisible();
    await expect(first).toContainText('#1 in line');
    await expect(second).toContainText('#2 in line');
    await expect(noteMarker(first)).toBeVisible();
    expect(await queuePlaces()).toEqual({ [JOB.first]: 1, [JOB.second]: 2 });
    expect((await jobsOnServer()).find((job) => job.name === JOB.first)?.note).toBe(
      'Keep it under 30 seconds.',
    );
  });

  await test.step('a manual Hold and Release still goes to the back of the line', async () => {
    await chooseFromRowMenu(page, first, 'Hold');
    await expect(badge(first, 'Held')).toBeVisible();
    await expect(second).toContainText('#1 in line');

    // Its files have been quiet for far longer than the settle delay, so it queues, not arrives.
    await action(first, 'Release').click();
    await expect(badge(first, 'Queued')).toBeVisible();
    await expect(first).toContainText('#2 in line');
    await expect(second).toContainText('#1 in line');
    expect(await queuePlaces()).toEqual({ [JOB.second]: 1, [JOB.first]: 2 });
  });

  await test.step('the engine is left idle', async () => {
    // Nothing may start when the editing job stops: hold the two that wait, then stop the edit.
    for (const job of await jobsOnServer()) {
      if (job.state === 'queued') {
        expect(
          (await fetch(`${engine.baseURL}/api/jobs/${job.id}/hold`, { method: 'POST' })).ok,
        ).toBe(true);
      }
    }
    const running = (await jobsOnServer()).find((job) => job.name === JOB.editing);
    const stopped = await fetch(`${engine.baseURL}/api/jobs/${running?.id}/cancel`, {
      method: 'POST',
    });
    expect(stopped.ok).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
