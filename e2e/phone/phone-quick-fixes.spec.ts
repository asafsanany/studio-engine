// CVP-380 (QF8): the quick note flow on the phone, on the built server with the fake runner and the
// Quick fixes switch on (`STUDIO_QUICK_FIXES=1`), in Chrome at the design boards' size (390×844,
// touch, an iPhone user agent; the `phone` project of playwright.config.ts). The same words as the
// Mac's (e2e/quick-fixes.spec.ts), in the phone's own places: the Write box, the notes list under
// the video, the muted line above the footer's buttons, and the pill on the video with a finger on
// Compare.
//
//   Write           a note typed at the paused moment: "Reading the note…" -> "Fixing it now · …" (Effort
//                   waits, the footer says "Fixing it here. Approve waits for it.") -> "Fixed in N s. The
//                   font is Georgia now." with Undo; the footer has no Approve (it is the row's sheet's,
//                   The owner 31 Oct), its line says where it is
//   the pill        "Changed at 0:0x" on the video once it has reloaded and stands at the moment; a finger
//                   held on Compare shows the before still, lifting it brings the fix back. With the notes
//                   list open the video is only 146 px wide: the pill's words are not cut (CVP-404), it
//                   reaches past the video's edge, and Compare is at least 32 px high for a finger
//   Undo            "Undone. It goes to the editor when you send.", and Send 1 note with Auto's plan
//   Effort          the sheet starts with Auto; Extra high is picked: the button names it

import { expect, type Locator, type Page, test } from '@playwright/test';
import { PHONE_APPROVE_LINE, PHONE_APPROVE_TEXT } from '../support/approve-ui.ts';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({ viewport: { width: 390, height: 844 } });

const REVIEW = '[data-slot="phone-review"]';
const PLAYER = `${REVIEW} [data-slot="preview-player"]`;
const NOTES = `${REVIEW} [data-slot="phone-review-notes"]`;
const COMPOSER = `${REVIEW} [data-slot="phone-composer"]`;
const FOOTER = `${REVIEW} [data-slot="phone-review-footer"]`;
const STAGE = `${REVIEW} [data-slot="preview-stage"]`;
const EFFORT_SHEET = '[data-slot="phone-effort-sheet"]';

const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';
const WAIT = { timeout: 90_000 };
const CLIENT = 'Acme';
const JOB = 'Phone quick fix';
const FONT = 'Change the caption font to Heebo Bold';
const FIXED_FONT = /^Fixed in \d+ s\. The font is Georgia now\.$/;

/** A fake edit takes about 20 s at this speed, a fake fix about a second. */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 3);

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  reviewEffort: string | null;
}

interface FixOnServer {
  id: string;
  status: string;
  said: string | null;
}

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED, quickFixes: true });
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

async function fixesOf(jobId: string): Promise<FixOnServer[]> {
  return (
    (await (await fetch(`${engine.baseURL}/api/jobs/${jobId}/fixes`)).json()) as {
      fixes: FixOnServer[];
    }
  ).fixes;
}

/** Opens the jobs page on a phone with a notch and a home indicator, in a browser that has seen this version's "What's new". */
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

/** The playhead of the preview video (the phone plays the engine's small MP4, or the live preview until it is ready). */
function playerTime(page: Page): Promise<number> {
  return page
    .locator(`${PLAYER} video, ${PLAYER} hyperframes-player`)
    .first()
    .evaluate((el) => (el as HTMLMediaElement).currentTime);
}

interface Frame {
  line: string | null;
  footer: string | null;
  approveDisabled: boolean | null;
  effortDisabled: boolean | null;
  /** The pill on the video: its words, and whether any of them is cut at the pill's end. */
  pill: { text: string; cut: boolean } | null;
}

interface PillMetrics {
  text: string;
  cut: boolean;
  pill: { left: number; right: number };
  button: { height: number } | null;
  video: { width: number };
  stage: { height: number };
  viewportWidth: number;
}

/** Writes down every change of the first note's line, the footer's words and whether its buttons wait. */
async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    (window as unknown as { __frames: Frame[] }).__frames = frames;
    const text = (el: Element | null | undefined) =>
      el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    const sample = () => {
      const footer = document.querySelector('[data-slot="phone-review-footer"]');
      const buttons = [...(footer?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      const approve = buttons.find((b) => text(b) === 'Approve' || text(b)?.startsWith('Send'));
      const effort = buttons.find((b) => text(b)?.startsWith('Effort:'));
      const pill = document.querySelector('[data-slot="fix-pill"]');
      const frame: Frame = {
        line: text(
          document.querySelector(
            '[data-slot="phone-review-notes"] [data-slot="note-fix"] [role="status"]',
          ),
        ),
        footer: text(footer),
        approveDisabled: approve?.disabled ?? null,
        effortDisabled: effort?.disabled ?? null,
        pill:
          pill === null
            ? null
            : {
                text: text(pill) ?? '',
                cut: [...pill.querySelectorAll('span')].some(
                  (el) => el.scrollWidth > el.clientWidth,
                ),
              },
      };
      const last = frames.at(-1);
      if (last === undefined || JSON.stringify(last) !== JSON.stringify(frame)) frames.push(frame);
    };
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    sample();
  });
}

function framesOf(page: Page): Promise<Frame[]> {
  return page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
}

/** The fix pill's size against its words, its button, the video it sits on and the stage around it. */
function pillMetrics(page: Page): Promise<PillMetrics> {
  return page.evaluate(
    ([pillSelector, videoSelector, stageSelector]) => {
      const pill = document.querySelector(pillSelector as string) as HTMLElement;
      const button = pill.querySelector('button');
      const video = document.querySelector(videoSelector as string) as HTMLElement;
      const stage = document.querySelector(stageSelector as string) as HTMLElement;
      const pillBox = pill.getBoundingClientRect();
      return {
        text: pill.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        cut: [...pill.querySelectorAll('span')].some((el) => el.scrollWidth > el.clientWidth),
        pill: { left: pillBox.left, right: pillBox.right },
        button: button === null ? null : { height: button.getBoundingClientRect().height },
        video: { width: video.getBoundingClientRect().width },
        stage: { height: stage.getBoundingClientRect().height },
        viewportWidth: document.documentElement.clientWidth,
      };
    },
    [`${REVIEW} [data-slot="fix-pill"]`, `${PLAYER} video, ${PLAYER} hyperframes-player`, STAGE],
  );
}

/** A finger down at the centre of `target`, until the returned function lifts it. */
async function holdFinger(page: Page, target: Locator): Promise<() => Promise<void>> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('the element has no box');
  const touchPoints = [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  return async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };
}

test('Write a quick note: read, fixed with Undo, Changed at with a finger on Compare, Undo, Effort', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await engine.createJob({ client: CLIENT, job: JOB });
  await expect
    .poll(async () => (await jobNamed(JOB).catch(() => null))?.state, WAIT)
    .toBe('review');
  const id = (await jobNamed(JOB)).id;
  const pageErrors = await open(page);

  const review = page.locator(REVIEW);
  const footer = page.locator(FOOTER);
  const pill = review.locator('[data-slot="fix-pill"]');
  const approve = footer.getByRole('button', { name: 'Approve', exact: true });
  const approveLine = page.locator(PHONE_APPROVE_LINE);
  const effort = footer.getByRole('button', { name: /^Effort:/ });

  await test.step('the review opens on Auto: the Approve line alone, and nothing about fixes yet', async () => {
    await page
      .locator(`[data-job-id="${id}"]`)
      .getByRole('button', { name: 'Review', exact: true })
      .click();
    await expect(review).toBeVisible();
    await expect(page.locator(PLAYER).first()).toHaveAttribute('data-status', 'ready', {
      timeout: 30_000,
    });
    await expect(approveLine).toHaveText(PHONE_APPROVE_TEXT);
    await expect(approve).toHaveCount(0);
    await expect(pill).toHaveCount(0);
    expect(await fixesOf(id)).toEqual([]);
  });

  let at = 0;
  await test.step('Write pauses the video and opens the note box at that moment', async () => {
    await review.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => playerTime(page), { timeout: 10_000 }).toBeGreaterThan(0.6);
    await review.getByRole('button', { name: 'Write', exact: true }).click();
    at = await playerTime(page);
    await expect(page.locator(COMPOSER)).toBeVisible();
    await expect(page.locator(COMPOSER).getByRole('textbox')).toBeFocused();
    await page.locator(COMPOSER).getByRole('textbox').fill(FONT);
  });

  const line = page.locator(`${NOTES} [data-slot="note-fix"] [role="status"]`);
  await test.step('Comment adds the note: Reading the note…, Fixing it now · …, Fixed in … s.', async () => {
    await recordFrames(page);
    await page.locator(COMPOSER).getByRole('button', { name: 'Comment' }).click();
    await expect(page.locator(COMPOSER)).toHaveCount(0);
    await expect(page.locator(NOTES)).toContainText(FONT);
    await expect(line).toHaveText(FIXED_FONT, { timeout: 30_000 });

    const frames = await framesOf(page);
    const lines = frames.flatMap((frame) => (frame.line === null ? [] : [frame.line]));
    expect(lines[0]).toBe('Reading the note…');
    expect(lines.some((words) => words.startsWith('Fixing it now · '))).toBe(true);
    expect(lines.at(-1)).toMatch(FIXED_FONT);
    // While it ran the line said so, with no button to wait: Approve is the row's sheet's. (The
    // footer is not there while the note box is open, and it closes a moment after the note is added.)
    const withFooter = frames.filter((frame) => frame.footer !== null);
    const fixing = withFooter.filter((frame) => frame.line?.startsWith('Fixing it now'));
    for (const frame of fixing) {
      expect(frame.footer).toContain('Fixing it here. Approve waits for it.');
      expect(frame.approveDisabled).toBeNull();
    }
    for (const frame of withFooter.filter((candidate) => candidate.line === 'Reading the note…')) {
      expect(frame.footer).toContain('Reading the note. Approve waits for it.');
      expect(frame.approveDisabled).toBeNull();
    }
    expect(
      fixing.length + withFooter.filter((frame) => frame.line === 'Reading the note…').length,
    ).toBeGreaterThan(0);
    // The pill that says "Fixing at 0:0x…" on the 146 px video (notes list open) is whole, not "Fixing at 0:…".
    const fixingPills = frames.flatMap((frame) =>
      frame.pill?.text.startsWith('Fixing at') ? [frame.pill] : [],
    );
    expect(fixingPills.length).toBeGreaterThan(0);
    for (const fixingPill of fixingPills) {
      expect(fixingPill.text).toMatch(/^Fixing at 0:0\d…$/);
      expect(fixingPill.cut).toBe(false);
    }
    await expect(footer).toContainText(
      'Fixed here. Press and hold the job in the list and choose Approve to render the final video, or keep writing notes.',
    );
    await expect(approve).toHaveCount(0);
    // The phone's footer is the line alone while only fixed notes are left (Effort comes with Send).
    await expect(effort).toHaveCount(0);
    await expect(
      page.locator(NOTES).getByRole('button', { name: 'Undo', exact: true }),
    ).toBeVisible();
    expect(await fixesOf(id)).toMatchObject([
      { status: 'fixed', said: 'The font is Georgia now.' },
    ]);
  });

  await test.step('the video reloaded and stands at the note’s moment: "Changed at", and a finger on Compare', async () => {
    await expect(pill).toContainText(/Changed at 0:0\d/, { timeout: 30_000 });
    await expect(pill).toHaveAttribute('data-state', 'changed');
    expect(Math.abs((await playerTime(page)) - at)).toBeLessThan(0.6);
    // With the notes list open the stage is 260 px high and the 9:16 video about 146 px wide: the
    // pill is wider than the video, and still whole, on the screen, with a Compare a finger can hit.
    const metrics = await pillMetrics(page);
    expect(Math.round(metrics.stage.height)).toBe(260);
    expect(metrics.video.width).toBeLessThan(metrics.pill.right - metrics.pill.left);
    expect(metrics.text).toMatch(/^Changed at 0:0\d/);
    expect(metrics.text).toContain('Compare');
    expect(metrics.cut).toBe(false);
    expect(metrics.pill.left).toBeGreaterThanOrEqual(0);
    expect(metrics.pill.right).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.button?.height).toBeGreaterThanOrEqual(32);
    const still = review.locator('[data-slot="fix-compare-still"]');
    await expect(still).toHaveCSS('opacity', '0');

    const lift = await holdFinger(page, pill.getByRole('button', { name: 'Compare' }));
    await expect(pill).toHaveAttribute('data-state', 'comparing');
    await expect(pill).toContainText('Before the fix');
    await expect(still).toHaveCSS('opacity', '1');
    await expect(still).toHaveAttribute('src', /\/fixes\/[^/]+\/compare\/before\.png/);
    await lift();
    await expect(pill).toHaveAttribute('data-state', 'changed');
    await expect(still).toHaveCSS('opacity', '0');
  });

  await test.step('Undo: "Undone. It goes to the editor when you send." and Send 1 note with Auto’s plan', async () => {
    await page.locator(NOTES).getByRole('button', { name: 'Undo', exact: true }).tap();
    await expect(line).toHaveText('Undone. It goes to the editor when you send.');
    await expect(footer).toContainText('Auto sends 1 note to Sonnet at High, 2 to 10 min.');
    await expect(footer.getByRole('button', { name: 'Send 1 note', exact: true })).toBeEnabled();
    await expect(pill).toHaveCount(0);
    await expect.poll(async () => (await fixesOf(id))[0]?.status).toBe('undone');
  });

  await test.step('Effort: the sheet starts with Auto, and Extra high turns Auto off', async () => {
    await expect(effort).toHaveText('Effort: Auto');
    await effort.tap();
    const sheet = page.locator(EFFORT_SHEET);
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Effort for the fixes' })).toBeVisible();
    const choices = sheet.getByRole('radio');
    await expect(choices).toHaveCount(4);
    await expect(choices.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(choices.nth(0)).toContainText('Auto');
    await expect(choices.nth(0)).toContainText('Default');
    await expect(choices.nth(0)).toContainText(
      'Text, font and title notes are fixed here at once.',
    );
    await expect(choices.nth(3)).toContainText('Extra high');
    await expect(choices.nth(3)).toContainText('waits for Send');
    await choices.nth(3).tap();
    await expect(sheet).toHaveCount(0);
    await expect(effort).toHaveText('Effort: Extra high');
    await expect.poll(async () => (await jobNamed(JOB)).reviewEffort).toBe('xhigh');
    // On a level the phone says nothing above the buttons (the line is the Mac's): Effort and Send.
    await expect(footer).toHaveText('Effort: Extra highSend 1 note');
    await expect(footer.getByRole('button', { name: 'Send 1 note', exact: true })).toBeEnabled();
  });

  expect(pageErrors).toEqual([]);
});
