// VE4: Versions on the phone, on the built server with the fake runner, in Chrome at the design
// boards' size (390×844, touch, an iPhone user agent; the `phone` project) with a notch and a home
// indicator. A job is taken through two cuts by real captures (the engine keeps a version each
// time a run ends in Review): Cut 1 from the first edit, Cut 2 from the revise run a sent note
// makes. Then, from the job sheet:
//
//   open Versions   the part opens under Details: Cut 2 (Current) over Cut 1, 48 px rows, View and
//                   ⋯ as 44 px touch targets
//   view an old cut View Cut 1 opens the viewer full screen on that cut's own composition, with
//                   "Go back to this version" in its footer (the job is in Review)
//   go back         the footer button asks in a bottom sheet (not the Mac's dialog); Go back puts
//                   the job on Cut 1: the viewer closes, the server says Cut 1 is current, and the
//                   job stays in Review
//
// Screenshots are attached to the report, and written to $PHONE_SHOTS_DIR when it is set.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({ viewport: { width: 390, height: 844 } });

const SHEET = '[data-slot="phone-job-sheet"]';
const VERSIONS = `${SHEET} [data-section="versions"]`;
const VIEWER = '[data-preview-viewer]';
const GO_BACK_SHEET = '[data-slot="phone-go-back-sheet"]';

/** The localStorage keys of the web app: "What's new" seen, the Add to Home Screen card away. */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

const WAIT = { timeout: 90_000 };
const CLIENT = 'Acme';

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  round: number;
}

interface VersionOnServer {
  n: number;
  current: boolean;
}

let engine: Engine;

async function jobNamed(name: string): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
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

async function versionsOf(jobId: string): Promise<VersionOnServer[]> {
  const body = (await (await fetch(`${engine.baseURL}/api/jobs/${jobId}/versions`)).json()) as {
    versions: VersionOnServer[];
  };
  return body.versions;
}

/** Cut 1 from the first edit; a note, Send notes, and the revise run's Review is Cut 2. */
async function jobWithTwoCuts(name: string): Promise<JobOnServer> {
  await engine.createJob({ client: CLIENT, job: name });
  const first = await follow(name, (job) => job.state === 'review');
  const note = await fetch(`${engine.baseURL}/api/jobs/${first.id}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ atSec: 1, text: 'Hold the title a second longer.' }),
  });
  expect(note.status).toBe(201);
  const send = await fetch(`${engine.baseURL}/api/jobs/${first.id}/send-notes`, { method: 'POST' });
  expect(send.status).toBe(200);
  const second = await follow(name, (job) => job.state === 'review' && job.round > first.round);
  await expect
    .poll(async () => (await versionsOf(second.id)).map((v) => v.n), WAIT)
    .toEqual([2, 1]);
  return second;
}

/** Opens the job's sheet by its address on a phone with a notch and a home indicator. */
async function openSheet(page: Page, job: JobOnServer): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  });
  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  await page.addInitScript(
    ([seen, current, card]) => {
      localStorage.setItem(seen as string, current as string);
      localStorage.setItem(card as string, String(Date.now()));
    },
    [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}/jobs?job=${job.id}`);
  await expect(page.locator(SHEET)).toBeVisible();
  // The sheet slides in over 200 ms.
  await page.waitForTimeout(450);
  return pageErrors;
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

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element has no box');
  return box;
}

test.beforeAll(async () => {
  // Review is on by default; a fast fake runner keeps the two edits short. Quick fixes are on by
  // default too (QF9), and a note posted and sent at once is refused while Auto reads it (409),
  // so this spec turns the switch off.
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 6, quickFixes: false });
});

test.afterAll(async () => {
  await engine?.stop();
});

test('open Versions, view Cut 1 in the viewer, go back to it from a bottom sheet', async ({
  page,
}, testInfo) => {
  const job = await jobWithTwoCuts('Phone versions');
  const pageErrors = await openSheet(page, job);

  await test.step('Versions is a closed 44 px button under Details; it opens to the cuts, newest first', async () => {
    const toggle = page.locator(VERSIONS).getByRole('button', { name: 'Versions', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect((await boxOf(toggle)).height).toBeGreaterThanOrEqual(44);
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const rows = page.locator(`${VERSIONS} li[data-version]`);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Cut 2');
    await expect(rows.nth(0)).toContainText('Current');
    await expect(rows.nth(1)).toContainText('Cut 1');
    for (const label of ['View Cut 1', 'More · Cut 1']) {
      const box = await boxOf(page.locator(VERSIONS).getByRole('button', { name: label }));
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(rows.nth(0).getByRole('button', { name: 'More · Cut 2' })).toBeVisible();
    await shoot(page, 've4-1-versions', testInfo);
  });

  await test.step('View Cut 1: the viewer opens full screen on that cut, with Go back in its footer', async () => {
    await page.locator(VERSIONS).getByRole('button', { name: 'View Cut 1' }).click();
    const viewer = page.locator(VIEWER);
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText('Cut 1');
    await expect(viewer.locator('[data-slot="preview-player"]')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 30_000 },
    );
    const footer = viewer.locator('[data-preview-viewer-footer]');
    const goBack = footer.getByRole('button', { name: 'Go back to this version' });
    await expect(goBack).toBeVisible();
    expect((await boxOf(goBack)).height).toBeGreaterThanOrEqual(44);
    // The footer clears the home indicator (34 px).
    const bottom = (await boxOf(goBack)).y + (await boxOf(goBack)).height;
    expect(bottom).toBeLessThanOrEqual(844 - 34);
    await shoot(page, 've4-2-old-cut-viewer', testInfo);
  });

  await test.step('Go back to this version asks in a bottom sheet; confirming puts the job on Cut 1', async () => {
    await page.locator(VIEWER).getByRole('button', { name: 'Go back to this version' }).click();
    const sheet = page.locator(GO_BACK_SHEET);
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(450);
    await expect(sheet).toContainText('Go back to Cut 1?');
    await expect(sheet).toContainText('Cut 2 stays in Versions, so you can return to it.');
    // A sheet from the bottom edge, not the Mac's centred dialog.
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    const sheetBox = await boxOf(sheet);
    expect(sheetBox.y + sheetBox.height).toBeCloseTo(844, 0);
    await shoot(page, 've4-3-go-back-sheet', testInfo);

    await sheet.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(page.locator(VIEWER)).toHaveCount(0);
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText('Back on Cut 1')).toBeVisible();
    await expect.poll(async () => (await versionsOf(job.id)).find((v) => v.current)?.n).toBe(1);
    expect((await jobNamed('Phone versions')).state).toBe('review');
  });

  await test.step('the sheet shows Cut 1 as Current now', async () => {
    const rows = page.locator(`${VERSIONS} li[data-version]`);
    await expect(rows.nth(1)).toContainText('Current');
    await expect(rows.nth(0)).not.toContainText('Current');
  });

  expect(pageErrors).toEqual([]);
});
