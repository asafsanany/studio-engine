// PH8: Review on the phone, on the built server with the fake runner (a real, playable 6 s
// composition, and the small MP4 the engine makes of it: since v0.29.0 the phone plays that, and
// under the fake runner the render step is a 6 s test-pattern clip), in Chrome at the design
// boards' size (390×844, touch, an iPhone user agent; the `phone` project of
// playwright.config.ts), with the Phone switch left at its default:
//
//   the walk       a Review row's Play icon opens the review full screen (board MReview): the 9:16
//                  preview plays, a finger scrubs the timeline, nothing is drawn over the video, no
//                  full screen control; with no notes a line where Approve was says to press and hold the job; two notes (added through the
//                  API, as the Mac's spec does) put two blue dots on the timeline and turn the
//                  footer into Effort ▾ and Send 2 notes; Notes slides the list up and shrinks the
//                  video to 260 px (MReviewNotes); a time chip seeks, Add to style toggles; a tap on
//                  a dot opens the notes at it; Effort opens its bottom sheet (MReviewEffort) and
//                  saves the level; Send goes through and the footer says so (MReviewDone)
//   from the sheet the job sheet's Review button opens it, with no Approve in it; Close gives back
//                  the sheet, whose list has Approve (the owner, 31 Oct), which renders
//   safe areas     Chrome's emulated notch and home indicator (47 px and 34 px): the header stays
//                  under the notch, the footer above the home indicator, and the page behind does
//                  not scroll
//
// 390×844 screenshots are attached to the report, and written to $PHONE_SHOTS_DIR when it is set.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import {
  approveFromPhoneSheet,
  PHONE_APPROVE_LINE,
  PHONE_APPROVE_TEXT,
} from '../support/approve-ui.ts';
import { type Engine, startEngine } from '../support/engine.ts';
import {
  EFFORT_BUTTON_DEFAULT,
  QUICK_FIXES_ON,
  REVIEW_EFFORT_FIELD,
} from '../support/quick-fixes-switch.ts';
import { sharesOf, stubShare } from '../support/share-stub.ts';

test.use({ viewport: { width: 390, height: 844 } });

const REVIEW = '[data-slot="phone-review"]';
const STAGE = `${REVIEW} [data-slot="preview-stage"]`;
const PLAYER = `${REVIEW} [data-slot="preview-player"]`;
const NOTES = `${REVIEW} [data-slot="phone-review-notes"]`;
const FOOTER = `${REVIEW} [data-slot="phone-review-footer"]`;

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
  effort: string | null;
  reviewEffort: string | null;
}

interface NoteOnServer {
  id: string;
  atSec: number;
  text: string | null;
  addToStyle: boolean;
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

async function addNote(jobId: string, atSec: number, text: string): Promise<void> {
  const response = await fetch(`${engine.baseURL}/api/jobs/${jobId}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ atSec, text }),
  });
  expect(response.status).toBe(201);
}

async function notesOf(jobId: string): Promise<NoteOnServer[]> {
  return (await (
    await fetch(`${engine.baseURL}/api/jobs/${jobId}/notes`)
  ).json()) as NoteOnServer[];
}

/** Chrome's emulated notch and home indicator: the boards' status bar (47 px) and home indicator (34 px). */
async function emulateSafeAreas(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  });
}

/**
 * Opens `path` in a browser that has seen this version's "What's new", on a phone with a notch and a
 * home indicator (the boards have them); returns the page's errors.
 */
async function open(page: Page, path: string): Promise<string[]> {
  await emulateSafeAreas(page);
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
  // Chrome has no iPhone share sheet: a stand-in that can share files (support/share-stub.ts).
  await stubShare(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element has no box');
  return box;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The playhead of the preview video (the phone plays the engine's small MP4), in seconds. */
function playerTime(page: Page): Promise<number> {
  return page.locator(`${PLAYER} video`).evaluate((el) => (el as HTMLVideoElement).currentTime);
}

/** One finger down at `from`, dragged to `to` along the line, and lifted: real touch events. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: point(from.x, from.y),
  });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: point(
        from.x + ((to.x - from.x) * step) / 8,
        from.y + ((to.y - from.y) * step) / 8,
      ),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** The player is ready and has loaded this round's preview. */
async function expectPlayerReady(page: Page): Promise<void> {
  await expect(page.locator(PLAYER)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
}

test.beforeAll(async () => {
  // The Review switch is left at its default (on): an edit ends in Review with a live preview.
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 20 });
});

test.afterAll(async () => {
  await engine?.stop();
});

test('Review: watch, scrub, notes, Effort, Send', async ({ page }, testInfo) => {
  const JOB = 'Phone review loop';
  await engine.createJob({ client: CLIENT, job: JOB });
  const job = await follow(JOB, (candidate) => candidate.state === 'review');
  const pageErrors = await open(page, '/jobs');

  const row = page.locator(`[data-job-id="${job.id}"]`);
  const review = page.locator(REVIEW);
  const timelineThumb = review.getByRole('slider', { name: 'Position in the video' });

  await test.step('the Play icon on the Review row opens the review full screen', async () => {
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(review).toBeVisible();
    await expectPlayerReady(page);
    await expect(review.getByRole('heading', { name: JOB })).toBeVisible();
    await expect(review).toContainText(`${CLIENT}`);
    // The phone plays the engine's small MP4 in a plain <video>, not the live composition, and
    // offers it to share.
    await expect(review).toContainText('Preview video');
    await expect(review).not.toContainText('Live preview');
    await expect(page.locator(`${PLAYER} video`)).toHaveAttribute(
      'src',
      new RegExp(`/api/jobs/${job.id}/preview-video\\.mp4\\?r=`),
    );
    await expect(review.locator('hyperframes-player')).toHaveCount(0);
    // Share replaces Download on the phone (U16): the header's icon shares the preview MP4 (named
    // "<job> (preview).mp4") from the tap itself, and no download link is reachable.
    const sharePreview = review.getByRole('button', { name: 'Share the preview video' });
    await expect(sharePreview).toBeVisible();
    await expect(sharePreview.locator('svg.lucide-share')).toHaveCount(1);
    await expect(review.locator('a[download]')).toHaveCount(0);
    expect(await sharesOf(page)).toEqual([]);
    await sharePreview.click();
    await expect
      .poll(() => sharesOf(page))
      .toMatchObject([{ name: `${JOB} (preview).mp4`, type: 'video/mp4', files: 1, inTap: true }]);
    expect((await sharesOf(page))[0]?.size).toBeGreaterThan(0);
    // An iPhone loads no video before a tap, so the first frame is drawn over it as a still until
    // Play (v0.22.2). It is the composition's first frame, and it has to have loaded.
    const poster = page.locator(`${PLAYER} [data-slot="preview-poster"]`);
    await expect(poster).toBeVisible();
    await expect
      .poll(() => poster.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    // Full screen: the dialog is the page (390×844), and the page behind it does not scroll.
    const box = await boxOf(review);
    expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    await expect(page.locator('body')).toHaveAttribute('data-scroll-locked', /.+/);
    // iPhone Safari has no element full screen: there is no control for it.
    await expect(review.getByRole('button', { name: /full screen/i })).toHaveCount(0);
  });

  await test.step('the 9:16 video fills the stage, and nothing is drawn over it', async () => {
    const stage = await boxOf(page.locator(STAGE));
    const video = await boxOf(page.locator(`${PLAYER} video`));
    // 9:16 and as tall as the stage.
    expect(Math.abs(video.height - stage.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(video.width / video.height - 9 / 16)).toBeLessThan(0.01);
    // Header, timeline, controls and footer sit around it, never over it.
    for (const selector of [
      '[data-slot="phone-review-header"]',
      '[data-slot="phone-timeline"]',
      '[data-slot="phone-review-controls"]',
      '[data-slot="phone-review-footer"]',
    ]) {
      expect(overlaps(await boxOf(review.locator(selector)), video), selector).toBe(false);
    }
    // The controls are the board's: 32 px timeline, 52 px row, and the 48 px of Approve's place.
    expect((await boxOf(review.locator('[data-slot="phone-timeline"]'))).height).toBe(32);
    expect((await boxOf(review.locator('[data-slot="phone-review-controls"]'))).height).toBe(52);
    expect((await boxOf(page.locator(PHONE_APPROVE_LINE))).height).toBe(48);
  });

  await test.step('Play plays, and a finger scrubs the timeline', async () => {
    // iPhone Safari lets a video play only when play() is called during the tap (v0.18.10: the
    // live player needed `unlockMedia` for it). The MP4 is a plain <video> played inline, so the
    // tap itself must call its play(): record, for each play() of a media element, whether it
    // came in the click's own task.
    await expect(page.locator(`${PLAYER} video`)).toHaveJSProperty('playsInline', true);
    await page.evaluate(() => {
      const mark = window as unknown as { tapPlays: boolean[]; inTap: boolean };
      mark.tapPlays = [];
      mark.inTap = false;
      window.addEventListener(
        'click',
        () => {
          mark.inTap = true;
          setTimeout(() => {
            mark.inTap = false;
          }, 0);
        },
        true,
      );
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        mark.tapPlays.push(mark.inTap);
        return play.call(this);
      };
    });
    await review.getByRole('button', { name: 'Play', exact: true }).click();
    const plays = await page.evaluate(
      () => (window as unknown as { tapPlays: boolean[] }).tapPlays,
    );
    expect(plays.length).toBeGreaterThan(0);
    expect(plays).not.toContain(false);
    // Played: the still is gone.
    await expect(page.locator(`${PLAYER} [data-slot="preview-poster"]`)).toHaveCount(0);
    await expect.poll(() => playerTime(page), { timeout: 10_000 }).toBeGreaterThan(0.8);
    await review.getByRole('button', { name: 'Pause', exact: true }).click();

    const track = await boxOf(review.locator('[data-slot="phone-timeline"] [data-slot="slider"]'));
    const y = track.y + track.height / 2;
    await drag(page, { x: track.x + track.width * 0.1, y }, { x: track.x + track.width * 0.7, y });
    // About 70 % of 6 s.
    await expect
      .poll(async () => Math.abs((await playerTime(page)) - 4.2), { timeout: 5_000 })
      .toBeLessThan(0.6);
    await expect(timelineThumb).toHaveAttribute('aria-valuenow', /^[34]\.\d+/);
  });

  await test.step('no notes: no button, the line that says where Approve is (board MReview)', async () => {
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveText(PHONE_APPROVE_TEXT);
    await expect(review.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(review.getByRole('button', { name: /^Effort:/ })).toHaveCount(0);
    await expect(review.getByRole('button', { name: /^Send/ })).toHaveCount(0);
    await expect(review.locator('[data-slot="note-dot"]')).toHaveCount(0);
    await shoot(page, 'review-watch', testInfo);
  });

  await test.step('two notes: two dots, and Effort ▾ with Send 2 notes in place of the Approve line', async () => {
    await addNote(job.id, 1, 'Keep the title on screen one second longer.');
    await addNote(job.id, 3.5, 'הכתוביות מכסות את החלון. להעלות אותן קצת.');
    await expect(review.locator('[data-slot="note-dot"]')).toHaveCount(2);
    await expect(review.locator('[data-slot="phone-note-count"]')).toHaveText('2');
    await expect(review.getByRole('button', { name: 'Send 2 notes', exact: true })).toBeEnabled();
    await expect(review.getByRole('button', { name: EFFORT_BUTTON_DEFAULT })).toBeVisible();
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveCount(0);
    expect((await boxOf(review.getByRole('button', { name: /^Send/ }))).height).toBe(48);
  });

  await test.step('Notes slides the list up and the video shrinks to 260 px (MReviewNotes)', async () => {
    const before = await boxOf(page.locator(STAGE));
    expect(before.height).toBeGreaterThan(400);
    await review.getByRole('button', { name: /^Notes/ }).click();
    await expect(page.locator(NOTES)).toBeVisible();
    await expect.poll(async () => (await boxOf(page.locator(STAGE))).height).toBe(260);
    // The player fits itself to its stage a moment after the stage has moved (a resize observer).
    await expect.poll(async () => (await boxOf(page.locator(`${PLAYER} video`))).height).toBe(260);
    const video = await boxOf(page.locator(`${PLAYER} video`));
    await expect(page.locator(NOTES).locator('[data-slot="review-note"]')).toHaveCount(2);
    // The list is below the controls; the video is not covered.
    const list = await boxOf(page.locator(NOTES));
    expect(overlaps(list, video)).toBe(false);
    expect(list.y).toBeGreaterThan(video.y + video.height);
    await page.waitForTimeout(300);
    await shoot(page, 'review-notes', testInfo);
  });

  await test.step('a time chip seeks, and Add to style toggles on the card', async () => {
    const second = page.locator(NOTES).locator('[data-slot="review-note"]').nth(1);
    await second.getByRole('button', { name: 'Go to 0:03' }).click();
    await expect.poll(() => playerTime(page), { timeout: 5_000 }).toBeGreaterThan(3.2);
    await expect(second).toHaveAttribute('data-state', 'active');

    const first = page.locator(NOTES).locator('[data-slot="review-note"]').first();
    await first.getByRole('button', { name: 'Add to style' }).click();
    await expect(first.getByRole('button', { name: 'In style' })).toBeVisible();
    await expect.poll(async () => (await notesOf(job.id))[0]?.addToStyle).toBe(true);
    // The card's buttons are made for a finger.
    expect(
      (await boxOf(first.getByRole('button', { name: 'Go to 0:01' }))).height,
    ).toBeGreaterThanOrEqual(32);
    expect(
      (await boxOf(first.getByRole('button', { name: 'Delete note' }))).width,
    ).toBeGreaterThanOrEqual(36);
  });

  await test.step('a tap on a dot opens the notes at that note', async () => {
    await review.getByRole('button', { name: /^Notes/ }).click();
    await expect(page.locator(NOTES)).toHaveCount(0);
    await expect.poll(async () => (await boxOf(page.locator(STAGE))).height).toBeGreaterThan(400);
    await review.getByRole('button', { name: 'Note at 0:01' }).click();
    await expect(page.locator(NOTES)).toBeVisible();
    await expect(page.locator(NOTES).locator('[data-slot="review-note"]').first()).toHaveAttribute(
      'data-state',
      'active',
    );
    await expect.poll(() => playerTime(page), { timeout: 5_000 }).toBeLessThan(1.5);
  });

  await test.step('Effort opens a bottom sheet with the four choices, and saves the level (MReviewEffort)', async () => {
    await review.getByRole('button', { name: EFFORT_BUTTON_DEFAULT }).click();
    const sheet = page.locator('[data-slot="phone-effort-sheet"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Effort for the fixes' })).toBeVisible();
    const choices = sheet.getByRole('radio');
    await expect(choices).toHaveCount(4);
    await expect(choices.nth(0)).toHaveAttribute('aria-checked', 'true');
    if (QUICK_FIXES_ON) {
      // Auto (the default, with its line of help), then the three levels, each waiting for Send.
      await expect(choices.nth(0)).toContainText('Auto');
      await expect(choices.nth(0)).toContainText('Default');
      await expect(choices.nth(3)).toContainText('waits for Send');
    } else {
      await expect(choices.nth(0)).toContainText('Default');
      await expect(choices.nth(0)).toContainText('Extra high');
      await expect(choices.nth(3)).toContainText('slowest');
    }
    await expect(choices.nth(1)).toContainText('Medium');
    await expect(choices.nth(2)).toContainText('High');
    expect((await boxOf(choices.nth(1))).height).toBe(52);
    await page.waitForTimeout(300);
    await shoot(page, 'review-effort', testInfo);

    await choices.nth(2).click();
    await expect(sheet).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Effort: High' })).toBeVisible();
    await expect.poll(async () => (await jobNamed(JOB))[REVIEW_EFFORT_FIELD]).toBe('high');
  });

  await test.step('Send goes through and the footer says so, with Close (MReviewDone)', async () => {
    await review.getByRole('button', { name: 'Send 2 notes', exact: true }).click();
    const footer = page.locator(FOOTER);
    await expect(footer).toHaveAttribute('data-kind', 'done');
    await expect(footer).toContainText(
      'Sent 2 notes (1 saved to the client style). The fixes run at High; the job comes back to Review when they’re done.',
    );
    // The job has left Review: the list closes and the row of buttons goes (board MReviewDone), and
    // the video takes the room again; the timeline stays.
    await expect.poll(async () => (await jobNamed(JOB)).state).not.toBe('review');
    await expect(page.locator(NOTES)).toHaveCount(0);
    await expect(review.locator('[data-slot="phone-review-controls"]')).toHaveCount(0);
    await expect(review.locator('[data-slot="phone-timeline"]')).toBeVisible();
    await expect.poll(async () => (await boxOf(page.locator(STAGE))).height).toBeGreaterThan(400);
    await page.waitForTimeout(300);
    await shoot(page, 'review-done-sent', testInfo);

    await footer.getByRole('button', { name: 'Close' }).click();
    await expect(review).toHaveCount(0);
    await expect(page.locator('[data-slot="phone-jobs-page"]')).toBeVisible();
  });

  expect(pageErrors).toEqual([]);
});

test('Review from the job sheet has no Approve; Close gives the sheet back, whose Approve renders', async ({
  page,
}, testInfo) => {
  const JOB = 'Phone approve';
  await engine.createJob({ client: CLIENT, job: JOB });
  const job = await follow(JOB, (candidate) => candidate.state === 'review');
  const pageErrors = await open(page, `/jobs?job=${job.id}`);

  const sheet = page.locator('[data-slot="phone-job-sheet"]');
  const review = page.locator(REVIEW);
  const approveRow = sheet.locator('[data-menu-row="approve"]');

  await test.step('the sheet has a Review button and an Approve row, and no Review… row', async () => {
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-menu-row="review"]')).toHaveCount(0);
    await expect(approveRow).toBeVisible();
    await sheet.locator('[data-sheet-action="review"]').click();
    await expect(review).toBeVisible();
    await expectPlayerReady(page);
    // It stacks over the sheet: the sheet's dim layer is under it, and its buttons are out of reach.
    // Approve is not in it: the line says where it is.
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveText(PHONE_APPROVE_TEXT);
    await expect(review.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  });

  await test.step('× gives the sheet back, and Review opens again; deleting the last note brings the line back', async () => {
    await review.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(review).toHaveCount(0);
    await expect(sheet).toBeVisible();

    await addNote(job.id, 2, 'A note to throw away.');
    await sheet.locator('[data-sheet-action="review"]').click();
    await expect(review).toBeVisible();
    await expectPlayerReady(page);
    await expect(review.getByRole('button', { name: 'Send 1 note', exact: true })).toBeVisible();
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveCount(0);

    await review.getByRole('button', { name: /^Notes/ }).click();
    await review.getByRole('button', { name: 'Delete note' }).click();
    await expect(page.locator(NOTES)).toContainText('No notes yet.');
    await expect(page.locator(NOTES)).not.toContainText('below');
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveText(PHONE_APPROVE_TEXT);
    await expect(review.getByRole('button', { name: /^Effort:/ })).toHaveCount(0);
    expect(await notesOf(job.id)).toHaveLength(0);
    await review.getByRole('button', { name: /^Notes/ }).click();
  });

  await test.step('Close, then Approve in the sheet: the sheet stays, about the rendering job', async () => {
    await approveFromPhoneSheet(page, page.locator(`[data-job-id="${job.id}"]`));
    await expect(review).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(approveRow).toHaveCount(0, WAIT);
    await page.waitForTimeout(300);
    await shoot(page, 'sheet-approved', testInfo);
  });

  await test.step('the render finishes: the job is Approved', async () => {
    await follow(JOB, (candidate) => candidate.state === 'ready');
    await expect(sheet.locator('[data-slot="job-sheet-status"]')).toHaveText('Approved', WAIT);
  });

  expect(pageErrors).toEqual([]);
});

test('the “Ready to review” notification’s address opens the review over the job’s sheet', async ({
  page,
}) => {
  const JOB = 'Phone from a ping';
  await engine.createJob({ client: CLIENT, job: JOB });
  const job = await follow(JOB, (candidate) => candidate.state === 'review');
  // The address PH11 sends with "Ready to review" (PUSH_URLS.review).
  const pageErrors = await open(page, `/jobs?job=${job.id}&review=1`);
  await expect(page.locator(REVIEW)).toBeVisible();
  await expectPlayerReady(page);
  await expect.poll(() => new URL(page.url()).search).toBe(`?job=${job.id}`);
  await page.locator(REVIEW).getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(page.locator(REVIEW)).toHaveCount(0);
  await expect(page.locator('[data-slot="phone-job-sheet"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('the job leaves Review while the review is open: it closes and says so', async ({ page }) => {
  const JOB = 'Phone left review';
  await engine.createJob({ client: CLIENT, job: JOB });
  const job = await follow(JOB, (candidate) => candidate.state === 'review');
  const pageErrors = await open(page, '/jobs');
  await page
    .locator(`[data-job-id="${job.id}"]`)
    .getByRole('button', { name: 'Review', exact: true })
    .click();
  await expect(page.locator(REVIEW)).toBeVisible();
  await expectPlayerReady(page);

  // Approved from somewhere else (the Mac): nothing of ours is in flight.
  const response = await fetch(`${engine.baseURL}/api/jobs/${job.id}/approve`, { method: 'POST' });
  expect(response.status).toBeLessThan(300);
  await expect(page.locator(REVIEW)).toHaveCount(0);
  await expect(page.getByText('This job is no longer in Review.')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test.describe('safe areas (Chrome’s emulated notch: 47 px on top, 34 px at the bottom)', () => {
  test('the header clears the notch, the footer the home indicator', async ({ page }) => {
    const JOB = 'Phone safe areas';
    await engine.createJob({ client: CLIENT, job: JOB });
    const job = await follow(JOB, (candidate) => candidate.state === 'review');
    const pageErrors = await open(page, '/jobs');
    await page
      .locator(`[data-job-id="${job.id}"]`)
      .getByRole('button', { name: 'Review', exact: true })
      .click();
    const review = page.locator(REVIEW);
    await expectPlayerReady(page);

    const header = await boxOf(review.locator('[data-slot="phone-review-header"]'));
    expect(header.y).toBeGreaterThanOrEqual(47);
    const approve = await boxOf(page.locator(PHONE_APPROVE_LINE));
    expect(approve.y + approve.height).toBeLessThanOrEqual(844 - 34);
    expect(pageErrors).toEqual([]);
  });
});
