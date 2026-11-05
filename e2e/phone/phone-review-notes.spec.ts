// PH9: writing and recording notes in the phone's Review, on the built server with the fake runner
// (a real, playable 6 s composition and the small MP4 the engine makes of it, which the phone plays)
// and the fake voice-note transcriber, in Chrome at the boards'
// size (390×844, touch, an iPhone user agent; the `phone` project) with Chrome's fake microphone:
//
//   Write          Write pauses, opens the notes and the note box (board MReviewWrite): the video is
//                  200 px, the box says "New note at 0:0X", its text is 16 px, the video can't
//                  start; with the keyboard up (visualViewport made shorter, as iPhone Safari does)
//                  the review is the visible part, the box sits on the keyboard, the header, the
//                  list and the row step aside and the frame keeps 200 px or more; Comment adds the
//                  note at the playhead; Cancel drops what was typed
//   Record         Record pins the note at the playhead (board MReviewRec): the red bar, the red pin,
//                  no row; Stop and add opens the notes, where the voice note says "Transcribing…"
//                  until the engine's transcript arrives; the screen locking (visibilitychange)
//                  stops a recording and keeps it
//   iPhone Safari  a browser that records only audio/mp4 (Safari before 18.4): the note is kept as
//                  .m4a and transcribed
//   microphone     asked for on the first Record only (never on opening); a refusal is one line
//
// What only an iPhone shows (the real keyboard, Safari's microphone prompt, its mp4) is listed in
// the hand-off. 390×844 screenshots are attached to the report, and written to $PHONE_SHOTS_DIR
// when it is set (with a copy of the mp4 voice note, for a check with video-use's transcriber).

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { PHONE_APPROVE_LINE, PHONE_APPROVE_TEXT } from '../support/approve-ui.ts';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({
  viewport: { width: 390, height: 844 },
  // A fake microphone (a beeping tone) and no permission prompt, as in review.spec.ts. This file
  // gets a browser of its own; the other phone specs keep theirs.
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  permissions: ['microphone'],
});

const REVIEW = '[data-slot="phone-review"]';
const STAGE = `${REVIEW} [data-slot="preview-stage"]`;
const PLAYER = `${REVIEW} [data-slot="preview-player"]`;
const NOTES = `${REVIEW} [data-slot="phone-review-notes"]`;
const COMPOSER = `${REVIEW} [data-slot="phone-composer"]`;
const RECORDING = `${REVIEW} [data-slot="phone-recording-bar"]`;
const FOOTER = `${REVIEW} [data-slot="phone-review-footer"]`;

const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';
const WAIT = { timeout: 90_000 };
const CLIENT = 'Acme';
const FAKE_TRANSCRIPT = '[voice note, fake transcript]';
/** A 390×844 iPhone's keyboard with its predictive bar, in px. */
const KEYBOARD = 336;

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  relPath: string;
}

interface NoteOnServer {
  id: string;
  kind: 'text' | 'voice';
  atSec: number;
  text: string | null;
  audioFile: string | null;
  audioSec: number | null;
  transcriptStatus: string | null;
}

let engine: Engine;

async function jobNamed(name: string): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === name);
  if (job === undefined) throw new Error(`no job named ${name}`);
  return job;
}

async function inReview(name: string): Promise<JobOnServer> {
  await engine.createJob({ client: CLIENT, job: name });
  let last: JobOnServer | undefined;
  await expect
    .poll(async () => {
      last = await jobNamed(name).catch(() => undefined);
      return last?.state;
    }, WAIT)
    .toBe('review');
  return last as JobOnServer;
}

async function notesOf(jobId: string): Promise<NoteOnServer[]> {
  return (await (
    await fetch(`${engine.baseURL}/api/jobs/${jobId}/notes`)
  ).json()) as NoteOnServer[];
}

/**
 * Opens the jobs page on a phone with a notch and a home indicator (47 px and 34 px, as on the
 * boards), in a browser that has seen this version's "What's new"; returns the page's errors.
 */
async function open(page: Page): Promise<string[]> {
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
  await page.goto(`${engine.baseURL}/jobs`);
  return pageErrors;
}

/** Opens the review of `job` from its row's Play icon, and waits for the player. */
async function openReview(page: Page, job: JobOnServer): Promise<Locator> {
  await page
    .locator(`[data-job-id="${job.id}"]`)
    .getByRole('button', { name: 'Review', exact: true })
    .click();
  const review = page.locator(REVIEW);
  await expect(review).toBeVisible();
  await expect(page.locator(PLAYER)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
  return review;
}

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

/** The playhead of the preview video (the phone plays the engine's small MP4), in seconds. */
function playerTime(page: Page): Promise<number> {
  return page.locator(`${PLAYER} video`).evaluate((el) => (el as HTMLVideoElement).currentTime);
}

/** "0:04" for 4.7 s, the way the review writes a time. */
const clockOf = (seconds: number) => `0:${String(Math.floor(seconds)).padStart(2, '0')}`;

/** A finger drags the timeline's thumb to `fraction` of the video, and the player is left there. */
async function scrubTo(page: Page, fraction: number): Promise<number> {
  const track = await boxOf(
    page.locator(`${REVIEW} [data-slot="phone-timeline"] [data-slot="slider"]`),
  );
  const y = track.y + track.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(track.x + 4) });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: at(track.x + 4 + ((track.width - 8) * fraction * step) / 8),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  // The player reports late: wait until the playhead holds still.
  let previous = -1;
  await expect
    .poll(
      async () => {
        const now = await playerTime(page);
        const still = Math.abs(now - previous) < 0.001;
        previous = now;
        return still;
      },
      { timeout: 5_000, intervals: [200] },
    )
    .toBe(true);
  return previous;
}

/**
 * What iPhone Safari does when the keyboard comes up: the page keeps its height, and only
 * `visualViewport` gets shorter (and may scroll down to the field). `null` puts it back.
 */
async function keyboard(page: Page, visible: { height: number; offsetTop?: number } | null) {
  await page.evaluate((frame) => {
    const viewport = window.visualViewport as VisualViewport;
    const own = viewport as unknown as Record<string, unknown>;
    if (frame === null) {
      delete own.height;
      delete own.offsetTop;
    } else {
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => frame.height });
      Object.defineProperty(viewport, 'offsetTop', {
        configurable: true,
        get: () => frame.offsetTop ?? 0,
      });
    }
    viewport.dispatchEvent(new Event('resize'));
  }, visible);
}

/** A grey stand-in where the keyboard would be, for the screenshot only. */
async function drawKeyboard(page: Page, on: boolean) {
  await page.evaluate(
    ([show, height]) => {
      document.getElementById('keyboard-stand-in')?.remove();
      if (!show) return;
      const stand = document.createElement('div');
      stand.id = 'keyboard-stand-in';
      stand.textContent = 'keyboard';
      Object.assign(stand.style, {
        position: 'fixed',
        left: '0',
        right: '0',
        bottom: '0',
        height: `${height}px`,
        zIndex: '2147483647',
        background: '#2c2c2e',
        color: '#8e8e93',
        font: '15px system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      });
      document.body.append(stand);
    },
    [on, KEYBOARD] as const,
  );
}

/** Pretends the screen locked (or another app came up), then that the page came back. */
async function lockScreen(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function unlockScreen(page: Page) {
  await page.evaluate(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Counts the microphone requests the page makes, from the first script on. */
async function countMicrophoneRequests(page: Page) {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const ask = devices.getUserMedia.bind(devices);
    (window as unknown as { micAsks: number }).micAsks = 0;
    devices.getUserMedia = (constraints) => {
      (window as unknown as { micAsks: number }).micAsks += 1;
      return ask(constraints);
    };
  });
}

const micAsks = (page: Page) =>
  page.evaluate(() => (window as unknown as { micAsks: number }).micAsks);

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 20 });
});

test.afterAll(async () => {
  await engine?.stop();
});

test('Write: a typed note at the paused moment, on top of the keyboard', async ({
  page,
}, testInfo) => {
  const JOB = 'Phone write';
  const job = await inReview(JOB);
  const pageErrors = await open(page);
  const review = await openReview(page, job);
  const NOTE = 'לחתוך את השוט של המדרגות, הוא ארוך מדי.';
  let at = 0;

  await test.step('Write pauses, opens the notes and the note box, with the keyboard’s focus (MReviewWrite)', async () => {
    await review.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => playerTime(page), { timeout: 10_000 }).toBeGreaterThan(0.6);
    await review.getByRole('button', { name: 'Write', exact: true }).click();
    at = await playerTime(page);
    await expect(review).toHaveAttribute('data-bottom', 'write');
    await expect(page.locator(COMPOSER)).toBeVisible();
    await expect(page.locator(NOTES)).toBeVisible();
    await expect(page.locator(FOOTER)).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Write', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Pressed like Notes (the list is open), not like Record. The pointer leaves the button first:
    // Chrome keeps a hover after the click, which an iPhone (no hover) never shows.
    await page.mouse.move(195, 20);
    const background = (button: Locator) =>
      button.evaluate((el) => getComputedStyle(el).backgroundColor);
    const writeButton = review.getByRole('button', { name: 'Write', exact: true });
    const notesButton = review.getByRole('button', { name: /^Notes/ });
    await expect
      .poll(async () => (await background(writeButton)) === (await background(notesButton)))
      .toBe(true);
    expect(await background(writeButton)).not.toBe(
      await background(review.getByRole('button', { name: 'Record', exact: true })),
    );
    await expect.poll(async () => (await boxOf(page.locator(STAGE))).height).toBe(200);
    const box = page.locator(COMPOSER).getByRole('textbox');
    await expect(box).toBeFocused();
    expect(await box.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    await expect(page.locator(COMPOSER)).toContainText(`New note at ${clockOf(at)}`);
    // Paused, and it stays paused: a tap on the video does not start it, and Play is off.
    await page.waitForTimeout(400);
    expect(Math.abs((await playerTime(page)) - at)).toBeLessThan(0.05);
    await page.locator(STAGE).click();
    await page.waitForTimeout(600);
    expect(Math.abs((await playerTime(page)) - at)).toBeLessThan(0.05);
    await expect(review.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
    await expect(page.locator(COMPOSER).getByRole('button', { name: 'Comment' })).toBeDisabled();
    for (const name of ['Cancel', 'Comment']) {
      expect((await boxOf(page.locator(COMPOSER).getByRole('button', { name }))).height).toBe(44);
    }
  });

  await test.step('typing: Comment comes on', async () => {
    // The tap on the video took the focus (on an iPhone the keyboard went down): a tap on the box.
    await page.locator(COMPOSER).getByRole('textbox').click();
    await page.keyboard.type(NOTE);
    await expect(page.locator(COMPOSER).getByRole('button', { name: 'Comment' })).toBeEnabled();
    await page.waitForTimeout(300);
    await shoot(page, 'review-write', testInfo);
  });

  await test.step('the keyboard comes up: the box sits on it, and the frame keeps 200 px or more', async () => {
    await keyboard(page, { height: 844 - KEYBOARD });
    await expect(review).toHaveAttribute('data-keyboard', 'up');
    expect(await boxOf(review)).toMatchObject({ y: 0, height: 844 - KEYBOARD });
    const composer = await boxOf(page.locator(COMPOSER));
    expect(Math.abs(composer.y + composer.height - (844 - KEYBOARD))).toBeLessThanOrEqual(1);
    await expect(review.locator('[data-slot="phone-review-header"]')).toBeHidden();
    await expect(review.locator('[data-slot="phone-review-controls"]')).toHaveCount(0);
    await expect(page.locator(NOTES)).toHaveCount(0);
    // Everything between the notch and the timeline: 508 − 47 − 32 − 188.
    const stage = await boxOf(page.locator(STAGE));
    expect(stage.y).toBe(47);
    expect(stage.height).toBe(241);
    const timeline = await boxOf(review.locator('[data-slot="phone-timeline"]'));
    expect(timeline.y + timeline.height).toBe(composer.y);
    expect(composer.height).toBe(188);
    await drawKeyboard(page, true);
    await page.waitForTimeout(300);
    await shoot(page, 'review-write-keyboard', testInfo);
    await drawKeyboard(page, false);
  });

  await test.step('a shorter phone, and Safari scrolled down to the field: the review follows, the frame gives some', async () => {
    await keyboard(page, { height: 400, offsetTop: 60 });
    await expect.poll(async () => (await boxOf(review)).y).toBe(60);
    expect((await boxOf(review)).height).toBe(400);
    const composer = await boxOf(page.locator(COMPOSER));
    expect(composer.y + composer.height).toBeLessThanOrEqual(460 + 1);
    const stage = await boxOf(page.locator(STAGE));
    expect(stage.height).toBeLessThan(200);
    expect(stage.height).toBeGreaterThanOrEqual(120);
  });

  await test.step('the keyboard goes down: the header and the row come back, the box keeps the text', async () => {
    await keyboard(page, null);
    await expect(review).toHaveAttribute('data-keyboard', 'down');
    expect(await boxOf(review)).toMatchObject({ y: 0, height: 844 });
    await expect(review.locator('[data-slot="phone-review-header"]')).toBeVisible();
    await expect(review.locator('[data-slot="phone-review-controls"]')).toBeVisible();
    await expect(page.locator(NOTES)).toBeVisible();
    await expect.poll(async () => (await boxOf(page.locator(STAGE))).height).toBe(200);
    await expect(page.locator(COMPOSER).getByRole('textbox')).toHaveValue(NOTE);
    // The box keeps clear of the home indicator.
    const composer = await boxOf(page.locator(COMPOSER).getByRole('button', { name: 'Comment' }));
    expect(composer.y + composer.height).toBeLessThanOrEqual(844 - 34);
  });

  await test.step('Comment adds the note where the video paused, and the footer comes back', async () => {
    await page.locator(COMPOSER).getByRole('button', { name: 'Comment' }).click();
    await expect(page.locator(COMPOSER)).toHaveCount(0);
    await expect(review).toHaveAttribute('data-bottom', 'footer');
    await expect(page.locator(NOTES).locator('[data-slot="review-note"]')).toHaveCount(1);
    await expect(page.locator(NOTES)).toContainText(NOTE);
    await expect(review.getByRole('button', { name: 'Send 1 note', exact: true })).toBeVisible();
    const [note] = await notesOf(job.id);
    expect(note).toMatchObject({ kind: 'text', text: NOTE });
    expect(Math.abs((note?.atSec ?? -1) - at)).toBeLessThan(0.05);
    await expect(review.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  });

  await test.step('Cancel drops what was typed, and adds nothing', async () => {
    await review.getByRole('button', { name: 'Write', exact: true }).click();
    await page.keyboard.type('Not this one');
    await page.locator(COMPOSER).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator(COMPOSER)).toHaveCount(0);
    expect(await notesOf(job.id)).toHaveLength(1);
    await review.getByRole('button', { name: 'Write', exact: true }).click();
    await expect(page.locator(COMPOSER).getByRole('textbox')).toHaveValue('');
    await page.locator(COMPOSER).getByRole('button', { name: 'Cancel' }).click();
  });

  expect(pageErrors).toEqual([]);
});

test('Record: a voice note pinned where the video paused, transcribed by the engine', async ({
  page,
}, testInfo) => {
  const JOB = 'Phone record';
  const job = await inReview(JOB);
  await countMicrophoneRequests(page);
  const pageErrors = await open(page);
  const review = await openReview(page, job);
  let pin = 0;

  await test.step('opening the review does not ask for the microphone', async () => {
    expect(await micAsks(page)).toBe(0);
  });

  await test.step('Record pins the note at the playhead: the red bar and the red pin (MReviewRec)', async () => {
    pin = await scrubTo(page, 0.6);
    expect(pin).toBeGreaterThan(2.5);
    await review.getByRole('button', { name: 'Record', exact: true }).click();
    const bar = page.locator(RECORDING);
    await expect(bar).toHaveAttribute('data-phase', 'recording');
    expect(await micAsks(page)).toBe(1);
    await expect(bar).toContainText(`pinned at ${clockOf(pin)}`);
    await expect(review).toHaveAttribute('data-bottom', 'record');
    await expect(review.locator('[data-slot="recording-pin"]')).toHaveAttribute(
      'aria-label',
      `Recording at ${clockOf(pin)}`,
    );
    await expect(review.locator('[data-slot="phone-review-controls"]')).toHaveCount(0);
    await expect(page.locator(FOOTER)).toHaveCount(0);
    // The video takes the room, and holds still: a tap on it does not start it.
    expect((await boxOf(page.locator(STAGE))).height).toBeGreaterThan(400);
    await page.locator(STAGE).click();
    await page.waitForTimeout(500);
    expect(Math.abs((await playerTime(page)) - pin)).toBeLessThan(0.05);
    await expect(bar).toContainText('Recording 0:02', { timeout: 5_000 });
    for (const name of ['Cancel', 'Stop and add']) {
      expect((await boxOf(bar.getByRole('button', { name }))).height).toBe(44);
    }
    // The board's box: 124 px (+ the home indicator's 34) from y 686, so the video is 559 px; the red
    // bar and the two buttons at 699 and 753, the buttons 176 and 174 px wide (an equal share).
    expect(await boxOf(bar)).toMatchObject({ y: 686, height: 158 });
    expect(await boxOf(bar.getByRole('status'))).toMatchObject({ y: 699, height: 44 });
    expect(await boxOf(bar.getByRole('button', { name: 'Cancel' }))).toMatchObject({
      y: 753,
      width: 176,
    });
    expect((await boxOf(bar.getByRole('button', { name: 'Stop and add' }))).width).toBe(174);
    const stop = await boxOf(bar.getByRole('button', { name: 'Stop and add' }));
    expect(stop.y + stop.height).toBeLessThanOrEqual(844 - 34);
    await shoot(page, 'review-rec', testInfo);
  });

  await test.step('Stop and add: the notes open, "Transcribing…", then the engine’s transcript', async () => {
    await page.evaluate(() => {
      const seen = { transcribing: false };
      (window as unknown as { seen: typeof seen }).seen = seen;
      new MutationObserver(() => {
        if (document.body.textContent?.includes('Transcribing…')) seen.transcribing = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.locator(RECORDING).getByRole('button', { name: 'Stop and add' }).click();
    await expect(page.locator(NOTES)).toBeVisible();
    await expect(page.locator(NOTES).getByText(FAKE_TRANSCRIPT)).toBeVisible({ timeout: 15_000 });
    expect(
      await page.evaluate(() => (window as unknown as { seen: { transcribing: boolean } }).seen),
    ).toEqual({ transcribing: true });
    await expect(page.locator(RECORDING)).toHaveCount(0);
    await expect(review.locator('[data-slot="recording-pin"]')).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Send 1 note', exact: true })).toBeEnabled();
    const [note] = await notesOf(job.id);
    expect(note).toMatchObject({ kind: 'voice', transcriptStatus: 'done', text: FAKE_TRANSCRIPT });
    expect(Math.abs((note?.atSec ?? -1) - pin)).toBeLessThan(0.05);
    expect(note?.audioFile).toMatch(/^edit\/review\/voice\/[^/]+\.webm$/);
    expect(note?.audioSec).toBeGreaterThan(1.5);
    await page.waitForTimeout(300);
    await shoot(page, 'review-rec-added', testInfo);
  });

  await test.step('the screen locks while recording: the recording stops, and what was said is kept', async () => {
    await review.getByRole('button', { name: /^Notes/ }).click();
    const second = await scrubTo(page, 0.2);
    await review.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.locator(RECORDING)).toHaveAttribute('data-phase', 'recording');
    await page.waitForTimeout(1_200);
    await lockScreen(page);
    await expect(page.locator(RECORDING)).toHaveCount(0, { timeout: 10_000 });
    await unlockScreen(page);
    await expect(page.locator(NOTES).locator('[data-slot="review-note"]')).toHaveCount(2);
    await expect.poll(async () => (await notesOf(job.id)).length).toBe(2);
    const kept = (await notesOf(job.id)).find((note) => Math.abs(note.atSec - second) < 0.05);
    expect(kept).toMatchObject({ kind: 'voice' });
    expect(kept?.audioSec).toBeGreaterThan(0.8);
    // The microphone was asked for once per recording, never on its own.
    expect(await micAsks(page)).toBe(2);
  });

  expect(pageErrors).toEqual([]);
});

test('iPhone Safari records audio/mp4: the note is kept as .m4a and transcribed', async ({
  page,
}) => {
  const JOB = 'Phone mp4';
  const job = await inReview(JOB);
  // Safari before 18.4 records only mp4 (the recorder asks for webm/opus first).
  await page.addInitScript(() => {
    const can = MediaRecorder.isTypeSupported.bind(MediaRecorder);
    MediaRecorder.isTypeSupported = (type: string) => !type.includes('webm') && can(type);
  });
  const pageErrors = await open(page);
  const review = await openReview(page, job);

  await review.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.locator(RECORDING)).toHaveAttribute('data-phase', 'recording');
  await page.waitForTimeout(1_600);
  await page.locator(RECORDING).getByRole('button', { name: 'Stop and add' }).click();
  await expect(page.locator(NOTES).getByText(FAKE_TRANSCRIPT)).toBeVisible({ timeout: 15_000 });

  const [note] = await notesOf(job.id);
  expect(note).toMatchObject({ kind: 'voice', transcriptStatus: 'done', text: FAKE_TRANSCRIPT });
  expect(note?.audioFile).toMatch(/^edit\/review\/voice\/[^/]+\.m4a$/);
  // The engine serves it back as audio/mp4, so the card plays it.
  const audio = await fetch(`${engine.baseURL}/api/jobs/${job.id}/notes/${note?.id}/audio`);
  expect(audio.status).toBe(200);
  expect(audio.headers.get('content-type')).toBe('audio/mp4');
  expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
  const dir = process.env.PHONE_SHOTS_DIR;
  if (dir && note?.audioFile) {
    await copyFile(join(engine.inbox, job.relPath, note.audioFile), join(dir, 'voice-note.m4a'));
  }
  expect(pageErrors).toEqual([]);
});

test('the microphone is refused: one line says so, and the review goes on', async ({ page }) => {
  const JOB = 'Phone mic refused';
  const job = await inReview(JOB);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  const pageErrors = await open(page);
  const review = await openReview(page, job);

  await review.getByRole('button', { name: 'Record', exact: true }).click();
  const line = review.locator('[data-slot="phone-review-mic-error"]');
  await expect(line).toHaveText(
    'Microphone access is off. Allow it in the browser to record voice notes.',
  );
  await expect(review).toHaveAttribute('data-bottom', 'footer');
  await expect(review.locator('[data-slot="phone-review-controls"]')).toBeVisible();
  await expect(page.locator(PHONE_APPROVE_LINE)).toHaveText(PHONE_APPROVE_TEXT);
  // The next Write (or Record) puts it away.
  await review.getByRole('button', { name: 'Write', exact: true }).click();
  await expect(line).toHaveCount(0);
  expect(await notesOf(job.id)).toEqual([]);
  expect(pageErrors).toEqual([]);
});
