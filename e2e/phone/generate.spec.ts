// GN10: Generated videos on the phone, on the built server with the fake runner and the fake
// Generate run (STUDIO_GENERATE=1), in Chrome at 390 x 844 with touch and an iPhone user agent (the
// `phone` project). Nothing reaches Higgsfield, ElevenLabs or Claude.
//
//   the row and the sheet   a generated job in Review: the row says "9:16 and 1:1", the sheet has the
//                           Generate step among nine, the Generated part with its spend, no ETA
//   the format switch       Review has the 9:16 | 1:1 switch above the player with 44 px targets; a
//                           note written on 1:1 is stamped 1:1 on the server, and its hint line says
//                           what Send will do
//   a stop                  a job that stops on an empty balance says so in the row and in the sheet,
//                           with "Retry from Generate"

import { expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from '../support/engine.ts';

test.use({ viewport: { width: 390, height: 844 } });

const SHEET = '[data-slot="phone-job-sheet"]';
const REVIEW = '[data-slot="phone-review"]';
const PLAYER = `${REVIEW} [data-slot="preview-player"]`;
const COMPOSER = `${REVIEW} [data-slot="phone-composer"]`;
const SWITCH = `${REVIEW} [data-slot="phone-review-format"] [data-slot="format-switch"]`;

/** The localStorage keys of the web app: "What's new" seen, the Add to Home Screen card away. */
const LAST_SEEN_KEY = 'studio.lastSeenVersion';
const INSTALL_CARD_KEY = 'studio.installCard.dismissedAt';

const WAIT = { timeout: 120_000 };
const CLIENT = 'Pinewood';

interface JobOnServer {
  id: string;
  name: string;
  state: string;
}

interface NoteOnServer {
  id: string;
  text: string | null;
  format?: string | null;
}

let engine: Engine;

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 6,
    generate: true,
    quickFixes: false,
  });
});

test.afterAll(async () => {
  await engine?.stop();
});

async function follow(name: string, until: (job: JobOnServer) => boolean): Promise<JobOnServer> {
  let last: JobOnServer | undefined;
  await expect
    .poll(async () => {
      const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
      last = jobs.find((candidate) => candidate.name === name);
      return last !== undefined && until(last);
    }, WAIT)
    .toBe(true);
  return last as JobOnServer;
}

async function open(page: Page, path: string): Promise<string[]> {
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
  await page.goto(`${engine.baseURL}${path}`);
  return pageErrors;
}

test('a generated job on the phone: the row and the sheet, with the Generate step and the Generated part', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const JOB = 'Phone window ad';
  await engine.createJob({ client: CLIENT, job: JOB, generated: true });
  const job = await follow(JOB, (candidate) => candidate.state === 'review');

  const pageErrors = await open(page, '/jobs');
  await expect(page.locator(`[data-job-id="${job.id}"]`)).toContainText('9:16 and 1:1');

  await page.goto(`${engine.baseURL}/jobs?job=${job.id}`);
  const sheet = page.locator(SHEET);
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Generated');
  await expect(sheet).toContainText('Higgsfield');
  for (const label of ['Voice', 'Looks', 'Keyframes', 'Clips', 'Spend']) {
    await expect(sheet.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(sheet).toContainText('of $3');
  expect(pageErrors).toEqual([]);
});

test('Review on the phone has the format switch above the player, and a note is stamped with the size on show', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const JOB = 'Phone review sizes';
  await engine.createJob({ client: CLIENT, job: JOB, generated: true });
  const job = await follow(JOB, (candidate) => candidate.state === 'review');

  const pageErrors = await open(page, `/jobs?job=${job.id}&review=1`);
  await expect(page.locator(REVIEW)).toBeVisible();
  await expect(page.locator(PLAYER)).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
  const nine = page.locator(`${SWITCH} [data-format="9x16"]`);
  const one = page.locator(`${SWITCH} [data-format="1x1"]`);
  await expect(nine).toHaveAttribute('aria-pressed', 'true');
  // A touch target as tall as the board draws it.
  expect((await one.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(38);
  await one.click();
  await expect(one).toHaveAttribute('aria-pressed', 'true');

  await page.locator(REVIEW).getByRole('button', { name: 'Write', exact: true }).click();
  await expect(page.locator(COMPOSER)).toContainText('on 1:1');
  await page.locator(COMPOSER).getByRole('textbox').fill('End card: the button lower.');
  await page.locator(COMPOSER).getByRole('button', { name: 'Comment' }).click();
  await expect(page.locator(REVIEW)).toContainText('End card: the button lower.');
  // The line under the note says what Send will do with it.
  await expect(page.locator(REVIEW)).toContainText('Edit change');

  const notes = (await (
    await fetch(`${engine.baseURL}/api/jobs/${job.id}/notes`)
  ).json()) as NoteOnServer[];
  expect(notes.map((note) => note.format)).toEqual(['1x1']);
  expect(pageErrors).toEqual([]);
});

test('a job that stops on an empty balance says so on the phone, with Retry from Generate', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const JOB = 'Phone empty balance';
  await engine.createJob({
    client: CLIENT,
    job: JOB,
    generated: true,
    failGenerate: 'balance_empty after=14',
  });
  const job = await follow(JOB, (candidate) => candidate.state === 'failed');

  const pageErrors = await open(page, '/jobs');
  await expect(page.locator(`[data-job-id="${job.id}"]`)).toContainText(
    'Higgsfield balance is empty',
  );
  await page.goto(`${engine.baseURL}/jobs?job=${job.id}`);
  const sheet = page.locator(SHEET);
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Failed at Generate');
  await expect(sheet).toContainText('Higgsfield balance is empty');
  await expect(sheet.getByRole('button', { name: /Retry from Generate/ })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
