// PH15: Share video on the phone, on the built server with the fake runner, in Chrome at iPhone
// size (the `phone` project of playwright.config.ts), 390×844 like the design boards, with the
// Phone switch on. Chrome has no iPhone share sheet, so `navigator.share` and `canShare` are a
// stand-in that records the file it is given and whether it came inside the tap
// (support/share-stub.ts). One Approved job, RGM / Backgammon tournament, whose MP4 is made 27 MB
// (the board's), and money.json gives RGM ₪40:
//
//   the row        an Approved row's next step is Share; it opens the job's sheet
//   getting        the sheet fetches the MP4 as it opens: "Getting the video · 12 of 27 MB"
//                  (the download slowed down in Chrome, so the bar is seen moving)
//   ready          Share video; Mark delivered first in the list, and no Download MP4 anywhere (U16)
//   shared         the share gets the one MP4, named as the Mac download, inside the tap; then
//                  "Sent it to RGM?" / "Mark it delivered, and ₪40 counts in <this month>."
//   Not yet        back to Share video; a cancelled share goes back to it too, and asks nothing
//   delivered      Mark delivered: the Mac's message with Undo, and the Delivered sheet; Undo
//                  brings back Share video with the video still in hand (no second download)
//   closed         closing the sheet stops a download on its way; a sheet opened again fetches
//                  the video again (nothing outlived the sheet)
//   Delivered      the list's Share video row (U16) fetches nothing until tapped: "Preparing the
//                  video…", then a second tap shares it inside the tap, and asks nothing
//   can't share    a browser that can't share a file fetches nothing and offers Download MP4,
//                  with the reason (the only place a download link is left on the phone)
//
// The screenshots are attached to the report (test-results/, and the HTML report) next to the
// boards MJobSheet (approved), MJobSheetSent and MJobSheetDelivered; with PHONE_SHOTS_DIR set they
// are also written there. Nothing leaves the engine's origin.

import { copyFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type CDPSession, expect, type Page, type TestInfo, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';
import { action, badge, rowOf } from '../support/jobs-ui.ts';
import { answerShares, sharesOf, stubShare } from '../support/share-stub.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ mode: 'serial' });

const CLIENT = 'RGM';
const JOB = 'Backgammon tournament';
/** The board's file: 27 MB. */
const SIZE = 27_000_000;
const WAIT = { timeout: 90_000 };

const SHEET = '[data-slot="phone-job-sheet"]';
/** The localStorage key of the newest version whose "What's new" notes were shown (web app). */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
/** The localStorage key of the time the "Add to Home Screen" card was put away (install-card.ts). */
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  delivery: { price: number; currency: string } | null;
}

let engine: Engine;
let job: JobOnServer;

async function jobOnServer(): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  const found = jobs.find((candidate) => candidate.name === JOB);
  if (found === undefined) throw new Error(`no job named ${JOB}`);
  return found;
}

/** This month's name, as the app writes it ("October"). */
const thisMonth = () => new Date().toLocaleString('en-US', { month: 'long' });

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 20,
    review: false,
    phone: true,
    jobSheet: true,
  });
  // The engine's data folder sits next to its inbox (support/engine.ts): RGM's price is ₪40.
  await writeFile(
    join(dirname(engine.inbox), 'data', 'money.json'),
    JSON.stringify({ clientPrices: { [CLIENT]: 40 } }),
  );
  await engine.createJob({ client: CLIENT, job: JOB });
  await expect.poll(async () => (await jobOnServer().catch(() => null))?.state, WAIT).toBe('ready');
  job = await jobOnServer();
  // The fake edit's MP4 is tiny: the export becomes the board's 27 MB, so the bar has a way to go.
  await writeFile(join(engine.exportsDir, CLIENT, `${JOB}.mp4`), Buffer.alloc(SIZE, 7));
});

test.afterAll(async () => {
  await engine?.stop();
});

/**
 * Opens the jobs page in a browser that has already seen this version's "What's new" and put the
 * install card away, with the share stand-in; returns the page's errors so far.
 */
async function open(page: Page, { canShare = true } = {}): Promise<string[]> {
  const { version } = (await (await fetch(`${engine.baseURL}/api/health`)).json()) as {
    version: string;
  };
  await page.addInitScript(
    ([seen, value, card]) => {
      localStorage.setItem(seen as string, value as string);
      localStorage.setItem(card as string, String(Date.now()));
    },
    [LAST_SEEN_KEY, version, INSTALL_CARD_KEY],
  );
  await stubShare(page, { canShare });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}/jobs`);
  await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
  return pageErrors;
}

/** The requests for the job's MP4 the page has made so far. */
function downloads(page: Page): { url: string; failed: boolean }[] {
  const seen: { url: string; failed: boolean }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/jobs/${job.id}/download`)) {
      seen.push({ url: request.url(), failed: false });
    }
  });
  page.on('requestfailed', (request) => {
    const entry = seen.find((candidate) => candidate.url === request.url() && !candidate.failed);
    if (entry !== undefined) entry.failed = true;
  });
  return seen;
}

/** Slows the page's downloads to `bytesPerSecond` (-1: no limit). */
async function throttle(cdp: CDPSession, bytesPerSecond: number): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: -1,
  });
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}-390x844.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}-390x844.png`, { path, contentType: 'image/png' });
  const dir = process.env.PHONE_SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(path, join(dir, `${name}-390x844.png`));
  }
}

const sheet = (page: Page) => page.locator(SHEET);
const bigButton = (page: Page) => page.locator(`${SHEET} [data-sheet-action]`);
const getting = (page: Page) => page.locator(`${SHEET} [data-slot="share-getting"]`);
const sentCard = (page: Page) => page.locator(`${SHEET} [data-slot="share-sent"]`);
const pillOf = (page: Page) => page.locator(`${SHEET} [data-slot="job-sheet-status"]`);
const menuRow = (page: Page, id: string) => page.locator(`${SHEET} [data-menu-row="${id}"]`);

async function menuRowIds(page: Page): Promise<string[]> {
  return page
    .locator(`${SHEET} [data-menu-row]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-menu-row') ?? ''));
}

/** The sheet has stopped moving (it slides in over 200 ms). */
async function settled(page: Page): Promise<void> {
  await expect(sheet(page)).toBeVisible();
  await page.waitForTimeout(450);
}

test('Share video: from the row to the share sheet, "Sent it to RGM?", then Mark delivered', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const pageErrors = await open(page);
  const fetched = downloads(page);
  const cdp = await page.context().newCDPSession(page);
  const row = rowOf(page, JOB);

  await test.step('the Approved row’s next step is Share, and it opens the job’s sheet', async () => {
    await expect(badge(row, 'Approved')).toBeVisible();
    const share = action(row, 'Share video');
    await expect(share).toBeVisible();
    await expect(share.locator('svg.lucide-share')).toHaveCount(1);
    await expect(action(row, 'Mark delivered')).toHaveCount(0);
    // Nothing is fetched until the sheet opens.
    expect(fetched).toEqual([]);

    // 4 MB/s: the 27 MB come in over about seven seconds.
    await throttle(cdp, 4_000_000);
    await share.tap();
    await expect.poll(() => new URL(page.url()).searchParams.get('job')).toBe(job.id);
    await settled(page);
  });

  await test.step('getting: the sheet fetches the MP4 as it opens, with how much has come', async () => {
    await expect(pillOf(page)).toHaveText('Approved');
    await expect(getting(page)).toHaveText(/^Getting the video · \d+ of 27 MB$/);
    await expect(getting(page)).toHaveAttribute('role', 'status');
    await expect
      .poll(async () => Number((await getting(page).innerText()).match(/· (\d+) of/)?.[1] ?? 0), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(10);
    await shoot(page, testInfo, 'share-getting');
    expect(fetched).toHaveLength(1);
    // Mark delivered stays in the list, for a video sent another way.
    // No Download MP4: Share video is the button.
    expect(await menuRowIds(page)).toEqual(['deliver', 'use-look', 'archive']);
    await expect(sheet(page).locator('a[download]')).toHaveCount(0);
    await expect(menuRow(page, 'deliver')).toHaveText('Mark delivered');
    await throttle(cdp, -1);
  });

  await test.step('ready: Share video, a 48 px button the whole width', async () => {
    await expect(bigButton(page)).toHaveText('Share video', { timeout: 30_000 });
    await expect(bigButton(page)).toHaveAttribute('data-sheet-action', 'share');
    const box = await bigButton(page).boundingBox();
    expect(box?.height).toBe(48);
    expect(box?.width).toBe(390 - 32);
    await expect(getting(page)).toHaveCount(0);
    await shoot(page, testInfo, 'share-ready');
  });

  await test.step('shared: the one MP4, named as the Mac download, inside the tap; then the question', async () => {
    await bigButton(page).tap();
    expect(await sharesOf(page)).toEqual([
      { name: `${JOB}.mp4`, type: 'video/mp4', size: SIZE, files: 1, inTap: true },
    ]);
    await expect(sentCard(page)).toBeVisible();
    await expect(sentCard(page)).toContainText(`Sent it to ${CLIENT}?`);
    await expect(sentCard(page)).toContainText(
      `Mark it delivered, and ₪40 counts in ${thisMonth()}.`,
    );
    await expect(bigButton(page)).toHaveCount(0);
    for (const name of ['Not yet', 'Mark delivered']) {
      const box = await sentCard(page).getByRole('button', { name }).boundingBox();
      expect(box?.height, name).toBe(44);
    }
    await page.waitForTimeout(250);
    await shoot(page, testInfo, 'share-sent');
  });

  await test.step('Not yet goes back to Share video', async () => {
    await sentCard(page).getByRole('button', { name: 'Not yet' }).tap();
    await expect(sentCard(page)).toHaveCount(0);
    await expect(bigButton(page)).toHaveText('Share video');
  });

  await test.step('a cancelled share goes back to the button, and asks nothing', async () => {
    await answerShares(page, 'cancel');
    await bigButton(page).tap();
    await expect.poll(async () => (await sharesOf(page)).length).toBe(2);
    await page.waitForTimeout(300);
    await expect(sentCard(page)).toHaveCount(0);
    await expect(bigButton(page)).toHaveText('Share video');
    await answerShares(page, 'sent');
  });

  await test.step('Mark delivered: the Mac’s message with Undo, then the Delivered sheet', async () => {
    await bigButton(page).tap();
    await expect(sentCard(page)).toBeVisible();
    await sentCard(page).getByRole('button', { name: 'Mark delivered' }).tap();

    const message = page
      .locator('[data-sonner-toast]')
      .filter({ hasText: `Delivered to ${CLIENT} · ₪40 counts in ${thisMonth()}` });
    await expect(message).toBeVisible();
    await expect(message.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(pillOf(page)).toHaveText('Delivered');
    await expect(bigButton(page)).toHaveText(/Mark paid/);
    await expect(sentCard(page)).toHaveCount(0);
    expect(await menuRowIds(page)).toEqual(['share', 'undeliver', 'archive']);
    await expect(menuRow(page, 'share')).toHaveText('Share video');
    await expect(sheet(page).locator('a[download]')).toHaveCount(0);
    expect((await jobOnServer()).delivery).toMatchObject({ price: 40, currency: 'ILS' });
    await page.waitForTimeout(250);
    await shoot(page, testInfo, 'share-delivered');

    // Undo: back to Approved, Share video at once, with the video still in hand.
    await message.getByRole('button', { name: 'Undo' }).tap();
    await expect(pillOf(page)).toHaveText('Approved');
    await expect(bigButton(page)).toHaveText('Share video');
    await expect.poll(async () => (await jobOnServer()).delivery).toBeNull();
    expect(fetched).toHaveLength(1);
  });

  expect(pageErrors).toEqual([]);
});

test('closing the sheet stops the download; opening it again fetches the video again', async ({
  page,
}) => {
  const pageErrors = await open(page);
  const fetched = downloads(page);
  const cdp = await page.context().newCDPSession(page);

  // 1 MB/s: still coming in when the sheet is closed.
  await throttle(cdp, 1_000_000);
  await action(rowOf(page, JOB), 'Share video').tap();
  await settled(page);
  await expect(getting(page)).toBeVisible();
  expect(fetched).toHaveLength(1);

  await sheet(page).getByRole('button', { name: 'Close' }).first().tap();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(() => fetched[0]?.failed).toBe(true);

  // Opened again, the sheet has nothing in hand: it fetches the video again.
  await throttle(cdp, -1);
  await action(rowOf(page, JOB), 'Share video').tap();
  await expect(bigButton(page)).toHaveText('Share video', { timeout: 30_000 });
  expect(fetched).toHaveLength(2);
  expect(pageErrors).toEqual([]);
});

test('a browser that can’t share a file fetches nothing and offers Download MP4', async ({
  page,
}, testInfo) => {
  const pageErrors = await open(page, { canShare: false });
  const fetched = downloads(page);

  await action(rowOf(page, JOB), 'Share video').tap();
  await settled(page);

  await expect(bigButton(page)).toHaveText('Download MP4');
  await expect(bigButton(page)).toHaveAttribute('href', `/api/jobs/${job.id}/download`);
  await expect(bigButton(page)).toHaveAttribute('download', '');
  // The only download link left on the phone says why it is one.
  await expect(sheet(page).locator('[data-slot="share-unsupported"]')).toHaveText(
    'This browser can’t share files, so it downloads instead.',
  );
  // Download MP4 is the button now, so the list leaves it out; Mark delivered stays.
  expect(await menuRowIds(page)).toEqual(['deliver', 'use-look', 'archive']);
  await page.waitForTimeout(300);
  expect(fetched).toEqual([]);
  await shoot(page, testInfo, 'share-unsupported');
  expect(pageErrors).toEqual([]);
});

test('a Delivered job: the Share video row fetches on its first tap and shares on its second', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  // Delivered from outside the page (the Mac's route), as it would be after a send another way.
  await fetch(`${engine.baseURL}/api/jobs/${job.id}/deliver`, { method: 'POST' });
  const pageErrors = await open(page);
  const fetched = downloads(page);
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`${engine.baseURL}/jobs?job=${job.id}`);
  await settled(page);

  await test.step('opening the sheet fetches nothing: the list has Share video, no download link', async () => {
    await expect(pillOf(page)).toHaveText('Delivered');
    expect(await menuRowIds(page)).toEqual(['share', 'undeliver', 'archive']);
    await expect(menuRow(page, 'share')).toHaveText('Share video');
    await expect(sheet(page).locator('a[download]')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(fetched).toEqual([]);
  });

  await test.step('the first tap prepares the video, with how much has come', async () => {
    await throttle(cdp, 4_000_000);
    await menuRow(page, 'share').tap();
    await expect(menuRow(page, 'share')).toHaveText(/^Preparing the video · \d+ of 27 MB$/);
    expect(await sharesOf(page)).toEqual([]);
    await shoot(page, testInfo, 'share-delivered-preparing');
    await throttle(cdp, -1);
  });

  await test.step('the second tap shares it, inside the tap, and asks nothing', async () => {
    await expect(menuRow(page, 'share')).toHaveText('Share video', { timeout: 30_000 });
    await menuRow(page, 'share').tap();
    expect(await sharesOf(page)).toEqual([
      { name: `${JOB}.mp4`, type: 'video/mp4', size: SIZE, files: 1, inTap: true },
    ]);
    await page.waitForTimeout(300);
    await expect(sentCard(page)).toHaveCount(0);
    await expect(menuRow(page, 'share')).toHaveText('Share video');
    expect(fetched).toHaveLength(1);
  });

  // Back to Approved for whatever runs next.
  await fetch(`${engine.baseURL}/api/jobs/${job.id}/undeliver`, { method: 'POST' });
  expect(pageErrors).toEqual([]);
});
