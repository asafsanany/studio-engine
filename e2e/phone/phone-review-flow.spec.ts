// PH10: Review on the phone from start to finish, on the built server with the fake runner (a real,
// playable 6 s composition and the small MP4 the engine makes of it, which the phone plays), in
// Chrome at the design boards' size (390×844, touch, an iPhone user agent; the `phone` project),
// with the Phone switch left at its default. phone-review.spec.ts
// takes the screen apart (sizes, the list, the sheet, safe areas) with notes added through the API;
// this one is the user's walk, with notes typed on the phone:
//
//   Send at High   a job in Review is opened from its row's Play icon; a typed note at the moment
//                  the video paused, a second one at another moment (a finger scrubbed there);
//                  Effort ▾ opens its bottom sheet and High is chosen; Send. The job goes back to
//                  editing at High (a revise run, round 1, with both notes in round-1.md at their
//                  times), the footer says so, and the row shows it; then it is in Review again,
//                  at round 1, with the new preview and no notes
//   Approve        a second job is approved with no notes: the footer has no button, only a line
//                  that says to press and hold the job (Approve is the row's menu's own, the owner 31 Oct);
//                  held, the row's sheet has Approve, which renders, and the job ends Approved with
//                  its export
//   taste          after a tap no button shows a focus ring or an outline, every button of the
//                  review has the pointer cursor, and nothing in it eases any way but ease-in-out
//                  (the transitions that move: the notes list, the sheet's slide, the buttons)
//
// 390×844 screenshots are attached to the report, and written to $PHONE_SHOTS_DIR when it is set.
// What only an iPhone shows (Safari's keyboard, the system player, haptics) is in the hand-off.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, type TestInfo, test } from '@playwright/test';
import { renderRoundFile } from '../../packages/shared/src/review/notes-files.ts';
import {
  approveFromPhoneSheet,
  holdPhoneRow,
  PHONE_APPROVE_LINE,
  PHONE_APPROVE_TEXT,
} from '../support/approve-ui.ts';
import { type Engine, startEngine } from '../support/engine.ts';
import { badge, rowOf, stepBar } from '../support/jobs-ui.ts';
import {
  EFFORT_BUTTON_DEFAULT,
  EFFORT_DEFAULT,
  QUICK_FIXES_ON,
  REVIEW_EFFORT_FIELD,
} from '../support/quick-fixes-switch.ts';

test.use({ viewport: { width: 390, height: 844 } });

const REVIEW = '[data-slot="phone-review"]';
const STAGE = `${REVIEW} [data-slot="preview-stage"]`;
const PLAYER = `${REVIEW} [data-slot="preview-player"]`;
const NOTES = `${REVIEW} [data-slot="phone-review-notes"]`;
const COMPOSER = `${REVIEW} [data-slot="phone-composer"]`;
const FOOTER = `${REVIEW} [data-slot="phone-review-footer"]`;
const EFFORT_SHEET = '[data-slot="phone-effort-sheet"]';

/** The localStorage keys of the web app: "What's new" seen, the Add to Home Screen card away. */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

const WAIT = { timeout: 90_000 };
/** A revise or render run, from the click to the row saying so (at the speed set below). */
const RUN = { timeout: 60_000 };
const CLIENT = 'Acme';
/** A note lands where the video paused, give or take the two or three frames it takes to stop. */
const FRAMES = 0.15;

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  runKind: string;
  round: number;
  effort: string | null;
  reviewEffort: string | null;
  approvedAt: string | null;
}

interface NoteOnServer {
  id: string;
  kind: 'text' | 'voice';
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

/** Creates a job and waits until its edit has ended in Review. */
async function inReview(name: string): Promise<JobOnServer> {
  await engine.createJob({ client: CLIENT, job: name });
  return follow(name, (job) => job.state === 'review');
}

async function notesOf(jobId: string): Promise<NoteOnServer[]> {
  return (await (
    await fetch(`${engine.baseURL}/api/jobs/${jobId}/notes`)
  ).json()) as NoteOnServer[];
}

/**
 * Writes down every state a job goes through (an editing round can be over in less than a polling
 * interval of the page, but not of this loop): a new line whenever its state, run, round or
 * effort changes.
 */
function trailOf(name: string): { trail: JobOnServer[]; stop: () => Promise<void> } {
  const trail: JobOnServer[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const job = await jobNamed(name).catch(() => undefined);
      const last = trail.at(-1);
      if (
        job !== undefined &&
        (last === undefined ||
          last.state !== job.state ||
          last.runKind !== job.runKind ||
          last.round !== job.round ||
          last.effort !== job.effort ||
          last.reviewEffort !== job.reviewEffort)
      ) {
        trail.push(job);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return {
    trail,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
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
  const row = page.locator(`[data-job-id="${job.id}"]`);
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

async function boxOf(locator: Locator) {
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

/** The playhead once it holds still: the player stops a frame or two after a pause is asked for. */
async function settledTime(page: Page): Promise<number> {
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
  return settledTime(page);
}

/**
 * What a tap leaves on the button it landed on: the focused element's outline, and its ring
 * shadows (a shadow layer that is spread without a blur and not transparent, like Tailwind's
 * `ring`; a soft drop shadow is not a ring), read in one go because the page may re-render a
 * button a moment later. Chrome only draws a focus ring for the keyboard, and an iPhone for
 * nothing; the page must not ask for one on a tap.
 */
function focusedRing(
  page: Page,
): Promise<{ label: string; outline: string; rings: string[] } | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return null;
    const style = getComputedStyle(el);
    const layers = style.boxShadow === 'none' ? [] : style.boxShadow.split(/,(?![^(]*\))/);
    const rings = layers
      .map((layer) => layer.trim())
      .filter((layer) => {
        const lengths =
          layer.match(/-?[\d.]+px/g)?.map((length) => Number.parseFloat(length)) ?? [];
        const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
        const clear = /^(rgba\(0, 0, 0, 0\)|oklab\(0 0 0 \/ 0\))/.test(layer);
        return !clear && x === 0 && y === 0 && blur === 0 && spread > 0;
      });
    return {
      label: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName,
      outline:
        style.outlineStyle === 'none' ? 'none' : `${style.outlineWidth} ${style.outlineStyle}`,
      rings,
    };
  });
}

test.beforeAll(async () => {
  // The Review switch is left at its default (on). A bit slower than the other specs, so the
  // editing rounds stay on the row long enough to be seen: a whole edit takes about 10 s.
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: 6 });
});

test.afterAll(async () => {
  await engine?.stop();
});

test('typed notes at two moments, Effort High, Send: the job goes back to editing at High', async ({
  page,
}, testInfo) => {
  const JOB = 'Phone review flow';
  const FIRST = 'Keep the title on screen one second longer.';
  const SECOND = 'הכתוביות מכסות את החלון. להעלות אותן קצת.';
  const job = await inReview(JOB);
  const pageErrors = await open(page);
  const review = await openReview(page, job);
  let firstAt = 0;
  let secondAt = 0;

  await test.step('opened from the row: the video, no notes, the line that says where Approve is (MReview)', async () => {
    await expect(review.getByRole('heading', { name: JOB })).toBeVisible();
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveText(PHONE_APPROVE_TEXT);
    await expect(review.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(review.getByRole('button', { name: /^Effort:/ })).toHaveCount(0);
    await expect(review.getByRole('button', { name: /^Send/ })).toHaveCount(0);
    await expect(review.locator('[data-slot="note-dot"]')).toHaveCount(0);
    // The board's column: header to 95, the video, a 32 px timeline, 52 px of buttons, and a 60 px
    // footer (1 + 6 + 48 + 5) above the home indicator's 34 px: the video is 571 px tall.
    expect(await boxOf(page.locator(STAGE))).toMatchObject({ y: 95, height: 571 });
    expect(await boxOf(page.locator(FOOTER))).toMatchObject({ y: 750, height: 94 });
    // The line stands where the board's 48 px Approve button was.
    expect(await boxOf(page.locator(PHONE_APPROVE_LINE))).toMatchObject({ y: 757, height: 48 });
    await shoot(page, 'review-watch-no-notes', testInfo);
  });

  await test.step('Write at the moment the video paused: a typed note is added there', async () => {
    await review.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => playerTime(page), { timeout: 10_000 }).toBeGreaterThan(1.1);
    await review.getByRole('button', { name: 'Write', exact: true }).click();
    await expect(page.locator(COMPOSER)).toBeVisible();
    firstAt = await settledTime(page);
    await expect(page.locator(COMPOSER)).toContainText(`New note at ${clockOf(firstAt)}`);
    await page.locator(COMPOSER).getByRole('textbox').fill(FIRST);
    await page.locator(COMPOSER).getByRole('button', { name: 'Comment' }).click();
    await expect(page.locator(COMPOSER)).toHaveCount(0);
    await expect(page.locator(NOTES).locator('[data-slot="review-note"]')).toHaveCount(1);
    await expect(page.locator(NOTES)).toContainText(FIRST);
    const [note] = await notesOf(job.id);
    expect(note).toMatchObject({ kind: 'text', text: FIRST });
    expect(Math.abs((note?.atSec ?? -1) - firstAt)).toBeLessThan(FRAMES);
    // One note: Effort and Send take the line's place.
    await expect(review.getByRole('button', { name: 'Send 1 note', exact: true })).toBeVisible();
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveCount(0);
  });

  await test.step('a finger scrubs to another moment, and a second note is added there', async () => {
    secondAt = await scrubTo(page, 0.7);
    expect(secondAt).toBeGreaterThan(firstAt + 1.5);
    await review.getByRole('button', { name: 'Write', exact: true }).click();
    await expect(page.locator(COMPOSER)).toContainText(`New note at ${clockOf(secondAt)}`);
    await page.locator(COMPOSER).getByRole('textbox').fill(SECOND);
    await page.waitForTimeout(300);
    // Board MReviewWrite: a 188 px box (+ the home indicator's 34) from y 622, the label on the
    // page's 1.43 line, then the 84 px box at 656 and the 44 px buttons at 748, 176 and 174 wide.
    expect(await boxOf(page.locator(COMPOSER))).toMatchObject({ y: 622, height: 222 });
    await expect(page.locator(COMPOSER).getByRole('textbox')).toHaveCSS('border-radius', '8px');
    // The page's 1.43 line is 17.16 px: the layout rounds it to 1/64 of a pixel, so a fraction of a pixel
    // is more than enough (half a pixel).
    const field = await boxOf(page.locator(COMPOSER).getByRole('textbox'));
    expect(field.y).toBeCloseTo(656.2, 0);
    expect(field.height).toBe(84);
    const cancel = await boxOf(page.locator(COMPOSER).getByRole('button', { name: 'Cancel' }));
    expect(cancel.y).toBeCloseTo(748.2, 0);
    expect(cancel.width).toBe(176);
    expect(
      (await boxOf(page.locator(COMPOSER).getByRole('button', { name: 'Comment' }))).width,
    ).toBe(174);
    await shoot(page, 'review-write', testInfo);
    await page.locator(COMPOSER).getByRole('button', { name: 'Comment' }).click();
    await expect(page.locator(COMPOSER)).toHaveCount(0);

    const notes = await notesOf(job.id);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ text: FIRST });
    expect(notes[1]).toMatchObject({ text: SECOND });
    expect(Math.abs((notes[1]?.atSec ?? -1) - secondAt)).toBeLessThan(FRAMES);

    // Two dots on the timeline, two cards in the list, the footer says "Send 2 notes".
    await expect(review.locator('[data-slot="note-dot"]')).toHaveCount(2);
    await expect(page.locator(NOTES).locator('[data-slot="review-note"]')).toHaveCount(2);
    await expect(review.locator('[data-slot="phone-note-count"]')).toHaveText('2');
    await expect(review.getByRole('button', { name: 'Send 2 notes', exact: true })).toBeEnabled();
    await expect(review.getByRole('button', { name: EFFORT_BUTTON_DEFAULT })).toBeVisible();

    // Board MReview: the notes are in the count and on the timeline, the list is shut and the
    // video takes the room (571 px), over Effort ▾ and Send.
    await expect(page.locator(NOTES)).toBeVisible();
    await review.getByRole('button', { name: /^Notes/ }).click();
    await expect(page.locator(NOTES)).toHaveCount(0);
    // With Quick fixes on the footer has a muted line above its buttons ("Auto sends 2 notes to
    // Sonnet at High, 2 to 10 min."), so it is taller and the video has less room.
    if (QUICK_FIXES_ON) {
      await expect.poll(async () => (await boxOf(page.locator(STAGE))).height).toBeLessThan(571);
      expect((await boxOf(page.locator(FOOTER))).height).toBeGreaterThan(94);
      expect(
        (await boxOf(review.getByRole('button', { name: 'Send 2 notes', exact: true }))).height,
      ).toBe(48);
    } else {
      await expect.poll(async () => (await boxOf(page.locator(STAGE))).height).toBe(571);
      expect(await boxOf(page.locator(FOOTER))).toMatchObject({ y: 750, height: 94 });
      expect(
        await boxOf(review.getByRole('button', { name: 'Send 2 notes', exact: true })),
      ).toMatchObject({
        y: 757,
        height: 48,
      });
    }
    await page.waitForTimeout(300);
    await shoot(page, 'review-watch', testInfo);

    // Board MReviewNotes: the list opens under the buttons, with 12 px above its first card and
    // 16 px between the cards, and a rule above the footer.
    await review.getByRole('button', { name: /^Notes/ }).click();
    await expect.poll(async () => (await boxOf(page.locator(STAGE))).height).toBe(260);
    await page.waitForTimeout(300);
    const list = await boxOf(page.locator(NOTES));
    const [first, second] = await page
      .locator(NOTES)
      .locator('[data-slot="review-note"]')
      .evaluateAll((cards) =>
        cards.map((card) => {
          const { y, height } = card.getBoundingClientRect();
          return { y, height };
        }),
      );
    expect(first?.y).toBe(list.y + 1 + 12);
    expect(second?.y).toBe((first?.y ?? 0) + (first?.height ?? 0) + 16);
    if (QUICK_FIXES_ON) expect((await boxOf(page.locator(FOOTER))).height).toBeGreaterThan(94);
    else expect(await boxOf(page.locator(FOOTER))).toMatchObject({ y: 750, height: 94 });
    await expect(page.locator(FOOTER)).toHaveCSS('border-top-color', /\/ 0\.1\)$/);
    // The boards' corners: 8 px on the row of buttons, 6 px on a note's time chip and its toggle.
    await expect(review.getByRole('button', { name: /^Notes/ })).toHaveCSS('border-radius', '8px');
    const card = page.locator(NOTES).locator('[data-slot="review-note"]').first();
    await expect(card).toHaveCSS('border-radius', '8px');
    await expect(card.getByRole('button', { name: 'Go to 0:01' })).toHaveCSS(
      'border-radius',
      '6px',
    );
    await expect(card.getByRole('button', { name: 'Add to style' })).toHaveCSS(
      'border-radius',
      '6px',
    );
    await shoot(page, 'review-notes', testInfo);
  });

  await test.step('Effort ▾ opens a bottom sheet: High is chosen, and the footer and the job keep it (MReviewEffort)', async () => {
    await review.getByRole('button', { name: EFFORT_BUTTON_DEFAULT }).click();
    const sheet = page.locator(EFFORT_SHEET);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Effort for the fixes' })).toBeVisible();
    await page.waitForTimeout(300);
    // The board's sheet: the review dimmed to 60 %, a sheet 328 px tall (grabber, title and hint,
    // four 52 px rows, the home indicator's room), the title on a 1.43 line and the rows' icons 16 px in.
    await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCSS(
      'background-color',
      /\/ 0\.6\)$/,
    );
    const box = await boxOf(sheet);
    // With Quick fixes on the sheet has Auto's line of help, so it is taller than the board's 328 px.
    if (QUICK_FIXES_ON) expect(box.height).toBeGreaterThan(328.3);
    else expect(Math.abs(box.height - 328.3)).toBeLessThan(1);
    expect(box.y + box.height).toBe(844);
    expect(Math.abs((await boxOf(sheet.getByRole('heading'))).height - 25.7)).toBeLessThan(0.5);
    const rows = sheet.getByRole('radio');
    expect((await boxOf(rows.first().locator('svg').first())).x).toBe(16);
    expect((await boxOf(rows.nth(3))).height).toBe(52);
    await shoot(page, 'review-effort', testInfo);
    await sheet.getByRole('radio', { name: /^High/ }).click();
    await expect(sheet).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Effort: High' })).toBeVisible();
    await expect.poll(async () => (await jobNamed(JOB))[REVIEW_EFFORT_FIELD]).toBe('high');
    // It is in Review that the level is asked for: the job is still there, with its notes.
    expect(await jobNamed(JOB)).toMatchObject({ state: 'review', round: 0 });
    await expect(review.getByRole('button', { name: 'Send 2 notes', exact: true })).toBeEnabled();
  });

  const watcher = trailOf(JOB);
  let sent: NoteOnServer[] = [];

  await test.step('Send: the footer says the fixes run at High, and the job goes back to editing', async () => {
    // Read before Send: the API stops listing the notes once they are sent.
    sent = await notesOf(job.id);
    expect(sent).toHaveLength(2);

    await review.getByRole('button', { name: 'Send 2 notes', exact: true }).click();
    const footer = page.locator(FOOTER);
    await expect(footer).toHaveAttribute('data-kind', 'done');
    await expect(footer).toContainText(
      'Sent 2 notes. The fixes run at High; the job comes back to Review when they’re done.',
    );
    await expect(page.locator(NOTES)).toHaveCount(0);
    await expect(review.locator('[data-slot="phone-review-controls"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    await shoot(page, 'review-done-sent', testInfo);

    // Editing at High: a revise run of round 1, with the level the review chose.
    const editing = await follow(
      JOB,
      (candidate) => candidate.state === 'editing' && candidate.runKind === 'revise',
    );
    expect(editing).toMatchObject({ runKind: 'revise', round: 1, [REVIEW_EFFORT_FIELD]: 'high' });
    // The notes are closed while the job edits.
    const late = await fetch(`${engine.baseURL}/api/jobs/${job.id}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ atSec: 1, text: 'Too late' }),
    });
    expect(late.status).toBe(409);
  });

  await test.step('Close: the row shows the job editing, and the notes are in round-1.md at their times', async () => {
    await page.locator(FOOTER).getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(REVIEW)).toHaveCount(0);
    const row = rowOf(page, JOB);
    await expect(stepBar(row)).toBeVisible(RUN);

    const roundFile = await readFile(
      join(engine.inbox, CLIENT, JOB, 'edit', 'review', 'round-1.md'),
      'utf8',
    );
    expect(roundFile).toBe(renderRoundFile({ job: JOB, client: CLIENT, round: 1, notes: sent }));
    expect(roundFile).toContain(`— ${FIRST}`);
    expect(roundFile).toContain(`— ${SECOND}`);
  });

  await test.step('back in Review at round 1: the new preview, no notes, the Approve line', async () => {
    await expect(badge(rowOf(page, JOB), 'Review')).toBeVisible(RUN);
    await watcher.stop();
    // Review, then editing at High (a revise run), then Review again.
    const states = watcher.trail.map(
      (entry) => `${entry.state}/${entry.runKind}/${entry[REVIEW_EFFORT_FIELD]}`,
    );
    expect(states.join(' > ')).toMatch(
      /review\/\w+\/high > editing\/revise\/high > review\/revise\/high$/,
    );
    expect(await jobNamed(JOB)).toMatchObject({ state: 'review', round: 1 });

    const preview = await fetch(`${engine.baseURL}/api/jobs/${job.id}/preview/index.html`);
    expect(await preview.text()).toContain('Round 1');

    const again = await openReview(page, job);
    // The player is the new round's MP4: the engine made it again from the revised composition.
    await expect(page.locator(`${PLAYER} video`)).toHaveAttribute(
      'src',
      new RegExp(`/api/jobs/${job.id}/preview-video\\.mp4\\?r=1`),
    );
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveText(PHONE_APPROVE_TEXT);
    await expect(again.getByRole('button', { name: /^Send/ })).toHaveCount(0);
    await expect(again.locator('[data-slot="note-dot"]')).toHaveCount(0);
    expect(await notesOf(job.id)).toHaveLength(0);
  });

  expect(pageErrors).toEqual([]);
});

test('a second job is approved with no notes: press and hold the row, Approve, then Approved', async ({
  page,
}, testInfo) => {
  const JOB = 'Phone approve plain';
  const job = await inReview(JOB);
  const pageErrors = await open(page);
  const review = await openReview(page, job);
  const row = page.locator(`[data-job-id="${job.id}"]`);
  const sheet = page.locator('[data-slot="phone-job-sheet"]');

  await test.step('no notes: no button in the footer, a 48 px line says where Approve is', async () => {
    await expect(page.locator(PHONE_APPROVE_LINE)).toHaveText(PHONE_APPROVE_TEXT);
    expect((await boxOf(page.locator(PHONE_APPROVE_LINE))).height).toBe(48);
    await expect(page.locator(FOOTER).getByRole('button')).toHaveCount(0);
    expect(await notesOf(job.id)).toHaveLength(0);
  });

  await test.step('closed, a finger held on the row opens its sheet, with Approve in the list', async () => {
    await review.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(review).toHaveCount(0);
    await holdPhoneRow(page, row);
    await expect(sheet).toBeVisible();
    // The hold opened the sheet and nothing else: the click that lifting the finger makes is no tap.
    await expect(review).toHaveCount(0);
    await expect(sheet.locator('[data-menu-row="approve"]')).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, 'sheet-approve', testInfo);
  });

  await test.step('Approve: the sheet stays on the job, which renders and ends Approved with its export', async () => {
    await approveFromPhoneSheet(page, row);
    await expect(sheet.locator('[data-menu-row="approve"]')).toHaveCount(0, RUN);
    await expect(sheet.locator('[data-slot="job-sheet-status"]')).toHaveText('Approved', RUN);
    const done = await jobNamed(JOB);
    expect(done).toMatchObject({ state: 'ready', runKind: 'render', round: 0 });
    expect(done.approvedAt).not.toBeNull();
    expect(existsSync(join(engine.exportsDir, CLIENT, `${JOB}.mp4`))).toBe(true);
    // No notes were sent, so no round of fixes was ever asked for.
    expect(existsSync(join(engine.inbox, CLIENT, JOB, 'edit', 'review', 'round-1.md'))).toBe(false);
  });

  expect(pageErrors).toEqual([]);
});

test('taste: no ring after a tap, the pointer on every button, ease-in-out on what moves', async ({
  page,
}) => {
  const JOB = 'Phone review taste';
  const job = await inReview(JOB);
  const pageErrors = await open(page);
  const review = await openReview(page, job);

  await test.step('a note exists, so the footer is Effort ▾ and Send', async () => {
    const response = await fetch(`${engine.baseURL}/api/jobs/${job.id}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ atSec: 2, text: 'A note to look at the buttons with.' }),
    });
    expect(response.status).toBe(201);
    await expect(review.getByRole('button', { name: 'Send 1 note', exact: true })).toBeVisible();
  });

  await test.step('after a tap, no button of the review is drawn with a focus ring', async () => {
    const taps = [
      review.getByRole('button', { name: 'Play', exact: true }),
      review.getByRole('button', { name: /^Notes/ }),
      review.getByRole('button', { name: 'Write', exact: true }),
      review.getByRole('button', { name: EFFORT_BUTTON_DEFAULT }),
    ];
    const looked: string[] = [];
    for (const button of taps) {
      // A tap as a finger makes it: touch events, then the click they cause.
      await button.tap();
      const ring = await focusedRing(page);
      if (ring !== null) {
        looked.push(ring.label);
        expect(ring.outline, `${ring.label}: outline`).toBe('none');
        expect(ring.rings, `${ring.label}: ring shadow`).toEqual([]);
      }
      // Put the screen back for the next tap: the sheet and the note box close, the video pauses.
      if ((await page.locator(EFFORT_SHEET).count()) > 0) {
        await page
          .locator(EFFORT_SHEET)
          .getByRole('radio', { name: new RegExp(`^${EFFORT_DEFAULT}`) })
          .tap();
        await expect(page.locator(EFFORT_SHEET)).toHaveCount(0);
      }
      if ((await page.locator(COMPOSER).count()) > 0) {
        await page.locator(COMPOSER).getByRole('button', { name: 'Cancel' }).tap();
        await expect(page.locator(COMPOSER)).toHaveCount(0);
      }
    }
    // The taps did land on focusable buttons, so the check above looked at something.
    expect(looked.length).toBeGreaterThanOrEqual(3);
  });

  await test.step('every button and radio of the review has the pointer cursor', async () => {
    const { wrong, inspected } = await page.evaluate((selector) => {
      const wrong: string[] = [];
      let inspected = 0;
      for (const el of document.querySelectorAll(
        `${selector} button, ${selector} [role="radio"]`,
      )) {
        if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;
        inspected += 1;
        const cursor = getComputedStyle(el).cursor;
        if (cursor !== 'pointer') {
          wrong.push(
            `${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName}: ${cursor}`,
          );
        }
      }
      return { wrong, inspected };
    }, REVIEW);
    expect(inspected).toBeGreaterThanOrEqual(6);
    expect(wrong).toEqual([]);
  });

  await test.step('what moves eases in and out, and nothing else', async () => {
    if ((await page.locator(NOTES).count()) === 0) {
      await review.getByRole('button', { name: /^Notes/ }).tap();
    }
    await expect(page.locator(NOTES)).toBeVisible();
    await review.getByRole('button', { name: EFFORT_BUTTON_DEFAULT }).tap();
    await expect(page.locator(EFFORT_SHEET)).toBeVisible();
    // Tailwind's `ease-in-out` is cubic-bezier(0.4, 0, 0.2, 1); the animations of the dialogs and
    // the sheet use it too. `linear` is for the player's own progress and loaders.
    const { offenders, inspected } = await page.evaluate(() => {
      const allowed = new Set(['cubic-bezier(0.4, 0, 0.2, 1)', 'ease-in-out', 'linear']);
      const found: string[] = [];
      let inspected = 0;
      for (const el of document.querySelectorAll(
        '[data-slot="phone-review"], [data-slot="phone-review"] *, [data-slot="phone-effort-sheet"], [data-slot="phone-effort-sheet"] *',
      )) {
        inspected += 1;
        const style = getComputedStyle(el);
        const durations = style.transitionDuration.split(',').map((d) => Number.parseFloat(d));
        const easings = style.transitionTimingFunction.split(/,(?![^(]*\))/).map((e) => e.trim());
        durations.forEach((duration, index) => {
          const easing = easings[index % easings.length] ?? '';
          if (duration > 0 && !allowed.has(easing)) {
            found.push(
              `${el.getAttribute('data-slot') ?? el.tagName.toLowerCase()}: ${easing} ${duration}s`,
            );
          }
        });
        const animation = style.animationName;
        if (animation !== 'none' && Number.parseFloat(style.animationDuration) > 0) {
          const easing = style.animationTimingFunction.split(/,(?![^(]*\))/)[0]?.trim() ?? '';
          if (!allowed.has(easing)) {
            found.push(
              `${el.getAttribute('data-slot') ?? el.tagName.toLowerCase()}: animation ${animation} ${easing}`,
            );
          }
        }
      }
      return { offenders: [...new Set(found)], inspected };
    });
    expect(inspected).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  expect(pageErrors).toEqual([]);
});
