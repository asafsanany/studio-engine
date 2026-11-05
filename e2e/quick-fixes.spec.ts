// CVP-380 (QF8): Quick fixes, the whole loop on the built server with the fake runner and the switch on
// (`STUDIO_QUICK_FIXES=1`, which is also the default since QF9; the engine here says so anyway, so
// the spec runs with `E2E_QUICK_FIXES=0` too). The fake router sorts a note by its words (apps/server/src/review/
// fake-fix-router.ts) and the fake quick fix changes the sample composition's #title rule and writes
// the two stills (fake-quick-fix.ts), so every button here reaches the real engine, the real routes
// and the real files. The text of each line, the footer and the pill is the design canvas's (page
// "Quick fixes", boards QFReview, QFStates and QFEffort).
//
//   fix one note    "Change the caption font to Heebo Bold" at 0:02 -> "Reading the note…" -> "Fixing it now
//                   · …" (Send and Effort wait, "Approve waits") -> "Fixed in N s. The font is Georgia now." with
//                   Undo; the player reloads, stops at 0:02 and says "Changed at 0:02"; holding Compare
//                   shows the before still
//   Undo            "Undone. It goes to the editor when you send.", the files are back as they were, the
//                   footer offers Send; deleting the undone note gives the line back that says where
//                   Approve is
//   a cut note      "Swap this shot for the drone shot" -> "Goes with Send · it changes the cut", the footer
//                   says "Auto sends 1 note to Sonnet at High, 2 to 10 min.", no fix is made; Send queues
//                   the revise with reviseTier revise
//   all fixed       a fixed note only: the footer says to approve from the row's right-click menu (the
//                   footer has no Approve, the owner 31 Oct), and that Approve renders; the fix files are cleared
//   a level         Effort ▾ Extra high: a new note gets no line, is not read or fixed, and the footer says
//                   "Your notes go to the editor together, at Extra high."
//
// Three jobs, one for each flow, are made at the start: the engine edits them one after another while
// the first flow runs.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { approveFromRowMenu } from './support/approve-ui.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, rowOf } from './support/jobs-ui.ts';
import { playerTime, reviewDialog, seekTo } from './support/review-ui.ts';
import { openApp } from './support/sheet-ui.ts';

const CLIENT = 'Acme';
const JOB_FONT = 'Quick font';
const JOB_ALL = 'Quick approve';
const JOB_LEVEL = 'Quick level';

const FONT = 'Change the caption font to Heebo Bold';
const YELLOW = 'Make the captions yellow';
const SWAP = 'Swap this shot for the drone shot';
const FIXED_FONT = /^Fixed in \d+ s\. The font is Georgia now\.$/;

/** A fake edit takes about 20 s at this speed, a fake fix about a second (four steps of 0.5 s ÷ speed). */
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 3);
const RUN = { timeout: 90_000 };

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({ settleMs: 2_000, fakeSpeed: FAKE_SPEED, quickFixes: true });
  for (const job of [JOB_FONT, JOB_ALL, JOB_LEVEL]) await engine.createJob({ client: CLIENT, job });
});

test.afterEach(async ({ browserName: _browser }, testInfo) => {
  // A failed test brings the server's own log along, which says why a job did not move.
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('server.log', {
      body: await engine.readLog(),
      contentType: 'text/plain',
    });
  }
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
  reviseTier: string | null;
  approvedAt: string | null;
}

interface FixOnServer {
  id: string;
  noteId: string;
  round: number;
  status: string;
  said: string | null;
  hasCompare: boolean;
  endedAt: string | null;
}

interface NoteOnServer {
  id: string;
  atSec: number;
  text: string | null;
  routeStatus: string | null;
  route: { tier: string; kind: string; why: string } | null;
  fixId: string | null;
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === name);
  expect(job, `the server lists "${name}"`).toBeDefined();
  return job as JobOnServer;
}

async function fixesOf(id: string): Promise<FixOnServer[]> {
  const response = await fetch(`${engine.baseURL}/api/jobs/${id}/fixes`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { fixes: FixOnServer[] }).fixes;
}

async function notesOf(id: string): Promise<NoteOnServer[]> {
  return (await (await fetch(`${engine.baseURL}/api/jobs/${id}/notes`)).json()) as NoteOnServer[];
}

const jobDir = (job: string): string => join(engine.inbox, CLIENT, job);
const previewIndex = (job: string): string => join(jobDir(job), 'edit', 'preview', 'index.html');

/** One look at the open dialog: the note's line, the footer's words, and whether its buttons wait. */
interface Frame {
  line: string | null;
  footer: string | null;
  actionLabel: string | null;
  actionDisabled: boolean | null;
  effortDisabled: boolean | null;
}

/**
 * Starts writing down every change of the review dialog's first note line, footer text and the
 * disabled state of its action and Effort button, from now on. A MutationObserver looks after each
 * DOM change, so no step of a fix that lasts under a second is missed between two Playwright polls.
 */
async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    (window as unknown as { __frames: Frame[] }).__frames = frames;
    const text = (el: Element | null | undefined) =>
      el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    const sample = () => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        d.querySelector('[data-slot="preview-player"]'),
      );
      if (dialog === undefined) return;
      const action = dialog.querySelector<HTMLButtonElement>('button[data-action]');
      const effort = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        text(b)?.startsWith('Effort:'),
      );
      const frame: Frame = {
        line: text(dialog.querySelector('[data-slot="note-fix"] [role="status"]')),
        footer: text(dialog.querySelector('[data-slot="review-footer-text"]')),
        actionLabel: text(action),
        actionDisabled: action?.disabled ?? null,
        effortDisabled: effort?.disabled ?? null,
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

/** Opens the review dialog of a job from its row and waits for the player to be ready at this round. */
async function openReview(page: Page, job: string, round: number): Promise<Locator> {
  const row = rowOf(page, job);
  await expect(badge(row, 'Review')).toBeVisible(RUN);
  await action(row, 'Review').click();
  const dialog = reviewDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 30_000 },
  );
  await expect(dialog.locator('hyperframes-player')).toHaveAttribute(
    'src',
    new RegExp(`/api/jobs/[^/]+/preview/index\\.html\\?r=${round}$`),
  );
  return dialog;
}

/** Types a note at the playhead and presses Enter. */
async function writeNote(dialog: Locator, words: string): Promise<void> {
  const box = dialog.getByRole('textbox');
  await box.click();
  await box.fill(words);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

/** The line under the note with these words, and the card itself. */
function cardOf(dialog: Locator, words: string): { card: Locator; line: Locator } {
  const card = dialog.locator('[data-slot="review-note"]').filter({ hasText: words });
  return { card, line: card.locator('[data-slot="note-fix"] [role="status"]') };
}

/** The Effort menu in the footer ("Effort for the fixes"): the one open menu of the page. */
function effortMenu(page: Page): Locator {
  return page.getByRole('menu').filter({ hasText: 'Effort for the fixes' });
}

/** The footer's text, and the action and Effort buttons of the open dialog. */
function footerOf(dialog: Locator) {
  return {
    text: dialog.locator('[data-slot="review-footer-text"]'),
    approve: dialog.getByRole('button', { name: 'Approve', exact: true }),
    send: (count: number) =>
      dialog.getByRole('button', {
        name: `Send ${count} note${count === 1 ? '' : 's'}`,
        exact: true,
      }),
    effort: dialog.getByRole('button', { name: /^Effort:/ }),
  };
}

test('a note is read, fixed in Review, compared and undone; a cut note goes with Send', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const pageErrors = await openApp(page, engine.baseURL);
  const row = rowOf(page, JOB_FONT);
  const dialog = await openReview(page, JOB_FONT, 0);
  const foot = footerOf(dialog);
  const player = dialog.locator('hyperframes-player');
  const pill = dialog.locator('[data-slot="fix-pill"]');
  const original = await readFile(previewIndex(JOB_FONT), 'utf8');
  let id = '';

  await test.step('Review on Auto: Effort says Auto, and with no notes the line says where Approve is', async () => {
    id = (await jobNamed(JOB_FONT)).id;
    expect(await jobNamed(JOB_FONT)).toMatchObject({
      state: 'review',
      round: 0,
      reviewEffort: null,
    });
    await expect(foot.effort).toHaveText('Effort: Auto');
    await expect(foot.effort.locator('svg.lucide-sparkles')).toHaveCount(1);
    await expect(foot.text).toHaveText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video.',
    );
    await expect(foot.approve).toHaveCount(0);
    await expect(pill).toHaveCount(0);
    expect(await fixesOf(id)).toEqual([]);
  });

  await test.step('the note is read, then fixed: Reading the note…, Fixing it now · …, Fixed in … s.', async () => {
    await seekTo(page, dialog, 2);
    await recordFrames(page);
    await writeNote(dialog, FONT);
    const { line } = cardOf(dialog, FONT);
    await expect(line).toHaveText(FIXED_FONT, { timeout: 30_000 });

    const frames = await framesOf(page);
    const lines = frames.flatMap((frame) => (frame.line === null ? [] : [frame.line]));
    expect(lines[0]).toBe('Reading the note…');
    expect(lines).toContain('Fixing it now · Reading the edit');
    expect(lines.some((words) => words === 'Fixing it now · Changing the caption font')).toBe(true);
    expect(lines.at(-1)).toMatch(FIXED_FONT);
    // Reading comes before fixing, and fixing before fixed.
    const first = (match: (words: string) => boolean) => lines.findIndex(match);
    expect(first((words) => words.startsWith('Reading'))).toBeLessThan(
      first((words) => words.startsWith('Fixing it now')),
    );
    expect(first((words) => words.startsWith('Fixing it now'))).toBeLessThan(
      first((words) => words.startsWith('Fixed in')),
    );

    // While it ran: the footer says so, and Effort waited (no Send yet: no note waits). The footer
    // has no Approve button.
    const reading = frames.filter((frame) => frame.line === 'Reading the note…');
    expect(reading.length).toBeGreaterThan(0);
    for (const frame of reading) {
      expect(frame.footer).toBe('Reading the note. Approve waits for it.');
      expect(frame.actionLabel).toBeNull();
    }
    const fixing = frames.filter((frame) => frame.line?.startsWith('Fixing it now'));
    expect(fixing.length).toBeGreaterThan(0);
    for (const frame of fixing) {
      expect(frame.footer).toBe('Fixing it here. Approve waits for it.');
      expect(frame.actionLabel).toBeNull();
      expect(frame.effortDisabled).toBe(true);
    }

    // After it: the words of the board, with where Approve is.
    await expect(foot.text).toHaveText(
      'Fixed here. Approve it from the job’s right-click menu to render the final video, or keep writing notes.',
    );
    await expect(foot.approve).toHaveCount(0);
    await expect(foot.effort).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  });

  await test.step('the files and the server agree: a fixed fix with its two stills, the font changed', async () => {
    const [fix] = await fixesOf(id);
    expect(await fixesOf(id)).toHaveLength(1);
    expect(fix).toMatchObject({
      status: 'fixed',
      said: 'The font is Georgia now.',
      hasCompare: true,
    });
    const [note] = await notesOf(id);
    expect(note).toMatchObject({
      atSec: 2,
      routeStatus: 'routed',
      route: { tier: 'quick', kind: 'Changing the caption font' },
      fixId: fix?.id,
    });
    const fixDir = join(jobDir(JOB_FONT), 'edit', 'review', 'fixes', fix?.id ?? '');
    for (const file of ['before.png', 'after.png', 'reply.json']) {
      expect(existsSync(join(fixDir, file)), file).toBe(true);
    }
    expect(existsSync(join(fixDir, 'before', 'preview', 'index.html'))).toBe(true);
    const now = await readFile(previewIndex(JOB_FONT), 'utf8');
    expect(now).toContain('Georgia');
    expect(now).not.toBe(original);
  });

  await test.step('the player reloaded, stopped at the note’s moment, and says "Changed at 0:02" with Compare', async () => {
    // The address carries the fix's rev; the new player is loaded and waiting at 0:02, paused.
    await expect(player).toHaveCount(1, { timeout: 20_000 });
    await expect(player).toHaveAttribute('src', /[?&]f=\d+/, { timeout: 20_000 });
    await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 30_000 },
    );
    await expect(pill).toContainText('Changed at 0:02');
    await expect(pill).toHaveAttribute('data-state', 'changed');
    await expect(pill.getByRole('button', { name: 'Compare' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(Math.abs((await playerTime(dialog)) - 2)).toBeLessThan(0.5);
  });

  await test.step('holding Compare shows how it was before the fix, letting go brings the fix back', async () => {
    const compare = pill.getByRole('button', { name: 'Compare' });
    const still = dialog.locator('[data-slot="fix-compare-still"]');
    // The before still is there from the first look at the pill, invisible, so holding Compare shows
    // it at once and nothing moves.
    await expect(still).toHaveCount(1);
    await expect(still).toHaveCSS('opacity', '0');
    await expect(still).not.toHaveAttribute('data-shown');
    await compare.hover();
    await page.mouse.down();
    await expect(pill).toHaveAttribute('data-state', 'comparing');
    await expect(pill).toContainText('Before the fix');
    await expect(still).toHaveAttribute('data-shown', '');
    await expect(still).toHaveCSS('opacity', '1');
    await expect(still).toHaveAttribute('src', /\/fixes\/[^/]+\/compare\/before\.png/);
    await expect
      .poll(() => still.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await page.mouse.up();
    await expect(pill).toHaveAttribute('data-state', 'changed');
    await expect(still).not.toHaveAttribute('data-shown');
    await expect(still).toHaveCSS('opacity', '0');
    // The stills are the engine's own: a PNG each.
    const [fix] = await fixesOf(id);
    for (const file of ['before.png', 'after.png']) {
      const response = await fetch(
        `${engine.baseURL}/api/jobs/${id}/fixes/${fix?.id}/compare/${file}`,
      );
      expect(response.headers.get('content-type')).toBe('image/png');
    }
  });

  await test.step('Undo puts the edit back: "Undone. It goes to the editor when you send." and Send', async () => {
    const [fixed] = await fixesOf(id);
    // A moment between the fix's end and the Undo, so the two ends differ.
    await page.waitForTimeout(50);
    const srcBefore = await player.getAttribute('src');
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    const { line } = cardOf(dialog, FONT);
    await expect(line).toHaveText('Undone. It goes to the editor when you send.');
    await expect(foot.text).toHaveText('Auto sends 1 note to Sonnet at High, 2 to 10 min.');
    await expect(foot.send(1)).toBeEnabled();
    await expect(foot.approve).toHaveCount(0);
    await expect(pill).toHaveCount(0);
    // The player reloads at the undone note's moment too (the address has a new rev), and is left
    // paused there: wait for it before the next seek, which the landing would otherwise overrule.
    // (A new rev loads in a second player behind the one on show and replaces it once it is ready.)
    await expect(player).toHaveCount(1, { timeout: 20_000 });
    await expect(player).not.toHaveAttribute('src', srcBefore ?? '', { timeout: 20_000 });
    await expect(dialog.locator('[data-slot="preview-player"]')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 30_000 },
    );
    await expect.poll(async () => Math.abs((await playerTime(dialog)) - 2)).toBeLessThan(0.5);

    await expect.poll(async () => (await fixesOf(id))[0]?.status).toBe('undone');
    const [undone] = await fixesOf(id);
    // The server moved the fix's end to the Undo, so the page's rev moves too.
    expect(Date.parse(undone?.endedAt ?? '')).toBeGreaterThan(Date.parse(fixed?.endedAt ?? ''));
    expect((await notesOf(id))[0]).toMatchObject({ fixId: null });
    expect(await readFile(previewIndex(JOB_FONT), 'utf8')).toBe(original);
    // The copy is dropped with the Undo.
    expect(
      existsSync(join(jobDir(JOB_FONT), 'edit', 'review', 'fixes', undone?.id ?? '', 'before')),
    ).toBe(false);
  });

  await test.step('deleting the undone note gives the line back that says where Approve is', async () => {
    const { card } = cardOf(dialog, FONT);
    await card.getByRole('button', { name: 'Delete note' }).click();
    await expect(card).toHaveCount(0);
    await expect(foot.text).toHaveText(
      'Happy with it? Approve it from the job’s right-click menu to render the final video.',
    );
    await expect(foot.approve).toHaveCount(0);
    await expect.poll(async () => (await notesOf(id)).length).toBe(0);
  });

  await test.step('a note about the cut goes with Send: no fix, and the footer says what Auto sends', async () => {
    await seekTo(page, dialog, 4);
    await writeNote(dialog, SWAP);
    const { line } = cardOf(dialog, SWAP);
    await expect(line).toHaveText('Goes with Send · it changes the cut', { timeout: 20_000 });
    await expect(foot.text).toHaveText('Auto sends 1 note to Sonnet at High, 2 to 10 min.');
    await expect(foot.send(1)).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    expect(await notesOf(id)).toMatchObject([
      { atSec: 4, route: { tier: 'revise', kind: 'Changing the cut', why: 'it changes the cut' } },
    ]);
    // The undone fix is the only one: a cut note is never fixed here.
    expect((await fixesOf(id)).map((fix) => fix.status)).toEqual(['undone']);
  });

  await test.step('Send queues the revise with reviseTier revise', async () => {
    await foot.send(1).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'Sent 1 note' }),
    ).toBeVisible();
    await expect
      .poll(async () => (await jobNamed(JOB_FONT)).reviseTier, { timeout: 10_000 })
      .toBe('revise');
    expect(await jobNamed(JOB_FONT)).toMatchObject({
      runKind: 'revise',
      round: 1,
      reviewEffort: null,
      effort: null,
    });
    expect(existsSync(join(jobDir(JOB_FONT), 'edit', 'review', 'round-1.md'))).toBe(true);
    // The round's fix files are cleared once the notes are sent.
    await expect
      .poll(() => existsSync(join(jobDir(JOB_FONT), 'edit', 'review', 'fixes')), {
        timeout: 10_000,
      })
      .toBe(false);
    await expect(badge(row, 'Review')).toBeVisible(RUN);
  });

  expect(pageErrors).toEqual([]);
});

test('a job whose notes are all fixed here is approved, and the render runs', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors = await openApp(page, engine.baseURL);
  const row = rowOf(page, JOB_ALL);
  const dialog = await openReview(page, JOB_ALL, 0);
  const foot = footerOf(dialog);
  const id = (await jobNamed(JOB_ALL)).id;

  await test.step('a quick note is fixed, and only fixed notes leave nothing to send', async () => {
    await seekTo(page, dialog, 1);
    await writeNote(dialog, YELLOW);
    const { line } = cardOf(dialog, YELLOW);
    await expect(line).toHaveText(/^Fixed in \d+ s\. The title is yellow now\.$/, {
      timeout: 30_000,
    });
    await expect(foot.text).toHaveText(
      'Fixed here. Approve it from the job’s right-click menu to render the final video, or keep writing notes.',
    );
    await expect(foot.approve).toHaveCount(0);
    await expect(foot.send(1)).toHaveCount(0);
    expect((await fixesOf(id)).map((fix) => fix.status)).toEqual(['fixed']);
    expect(await readFile(previewIndex(JOB_ALL), 'utf8')).toContain('#ffd60a');
  });

  await test.step('Approve from the row’s right-click menu: a render run follows', async () => {
    await approveFromRowMenu(page, row);
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'the final video is rendering' }),
    ).toBeVisible();
    await expect(badge(row, 'Approved')).toBeVisible(RUN);
    const job = await jobNamed(JOB_ALL);
    expect(job).toMatchObject({ state: 'ready', runKind: 'render', round: 0 });
    expect(job.approvedAt).not.toBeNull();
    expect(existsSync(join(engine.exportsDir, CLIENT, `${JOB_ALL}.mp4`))).toBe(true);
    // The fixed note went along with the approval, and the round's fix files are gone.
    expect(existsSync(join(jobDir(JOB_ALL), 'edit', 'review', 'fixes'))).toBe(false);
  });

  expect(pageErrors).toEqual([]);
});

test('Effort Extra high turns Auto off: a new note gets no line and goes with Send', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const pageErrors = await openApp(page, engine.baseURL);
  const dialog = await openReview(page, JOB_LEVEL, 0);
  const foot = footerOf(dialog);
  const id = (await jobNamed(JOB_LEVEL)).id;

  await test.step('Effort ▾ lists Auto first, then the three levels', async () => {
    await expect(foot.effort).toHaveText('Effort: Auto');
    await foot.effort.click();
    const menu = effortMenu(page);
    await expect(menu).toBeVisible();
    const items = menu.getByRole('menuitemradio');
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toHaveAttribute('aria-checked', 'true');
    await expect(items.nth(0)).toContainText('Auto');
    await expect(items.nth(0)).toContainText('Default');
    await expect(items.nth(0)).toContainText('Text, font and title notes are fixed here at once.');
    for (const [index, level] of ['Medium', 'High', 'Extra high'].entries()) {
      await expect(items.nth(index + 1)).toContainText(level);
      await expect(items.nth(index + 1)).toContainText('waits for Send');
    }
    await menu.getByRole('menuitemradio', { name: /^Extra high/ }).click();
    await expect(foot.effort).toHaveText('Effort: Extra high');
    await expect(foot.effort.locator('svg.lucide-sparkles')).toHaveCount(0);
    await expect.poll(async () => (await jobNamed(JOB_LEVEL)).reviewEffort).toBe('xhigh');
    // The edit's own level is not touched.
    expect((await jobNamed(JOB_LEVEL)).effort).toBeNull();
  });

  await test.step('a note now is not read or fixed: no line, today’s footer with the level named', async () => {
    await writeNote(dialog, FONT);
    const { card, line } = cardOf(dialog, FONT);
    await expect(card).toBeVisible();
    await expect(foot.text).toHaveText('Your notes go to the editor together, at Extra high.');
    await expect(foot.send(1)).toBeEnabled();
    // Nothing is read or fixed: give the router and a fix longer than the fake ones take.
    await page.waitForTimeout(1_500);
    await expect(line).toHaveCount(0);
    await expect(card.locator('[data-slot="note-fix"]')).toHaveCount(0);
    expect(await notesOf(id)).toMatchObject([{ routeStatus: null, route: null, fixId: null }]);
    expect(await fixesOf(id)).toEqual([]);
    expect(await readFile(previewIndex(JOB_LEVEL), 'utf8')).not.toContain('Georgia');
  });

  await test.step('Auto again: the note waits as one Auto never read, and the footer says what Auto sends', async () => {
    await foot.effort.click();
    await effortMenu(page).getByRole('menuitemradio', { name: /^Auto/ }).click();
    await expect(foot.effort).toHaveText('Effort: Auto');
    await expect.poll(async () => (await jobNamed(JOB_LEVEL)).reviewEffort).toBeNull();
    // A note Auto never read counts as a whole-video note: the full run.
    await expect(foot.text).toHaveText(
      'Auto sends 1 note to the editor at Extra high (one changes the whole video), 4 to 40 min.',
    );
  });

  expect(pageErrors).toEqual([]);
});
