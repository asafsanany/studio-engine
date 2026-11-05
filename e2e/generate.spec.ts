// GN10: Generated videos on the built server, with the fake Brief, the fake Generate run and the
// fake edit (STUDIO_GENERATE=1, STUDIO_RUNNER=fake). Nothing reaches Higgsfield, ElevenLabs or
// Claude: the Generate run makes its voice, stills and clips with the two scripts' own fake path.
//
//   the happy path   a folder with a script, two sizes and a reference video goes by itself from
//                    Arrived through Brief and Generate and the edit to Review; the row and the
//                    sheet show the stage and the spend; Review has the 9:16 | 1:1 switch, a note
//                    about a clip, one about the voice and one about the layout each show what Send
//                    will do and the footer adds up the new takes; Send runs a revise round that
//                    keeps the format a note was written on; Approve renders both sizes and the sheet
//                    lists two files
//   the failures     balance empty (Retry carries on from the clips already made and charges nothing
//                    twice), the key not accepted and the budget too small each stop the job at
//                    Generate with their plain sentence and "Retry from Generate"
//
// The specs for a footage job with the switch off are the others in this folder (smoke, review).

import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { approveFromRowMenu } from './support/approve-ui.ts';
import { type Engine, startEngine } from './support/engine.ts';
import { action, badge, rowOf } from './support/jobs-ui.ts';
import { reviewDialog, seekTo } from './support/review-ui.ts';
import { closeSheetByClick, openApp, openSheetByClick, sheetOf } from './support/sheet-ui.ts';

const CLIENT = 'Pinewood';
const FAKE_SPEED = Number(process.env.E2E_FAKE_SPEED ?? 4);
const RUN = { timeout: 120_000 };

let engine: Engine;

test.beforeAll(async () => {
  // Quick fixes are off: a note typed and sent at once is refused while Auto still reads it.
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: FAKE_SPEED,
    generate: true,
    quickFixes: false,
  });
});

test.afterAll(async () => {
  await engine?.stop();
});

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  round: number;
  error: string | null;
  output: { outputs?: { format: string; fileName: string }[] } | null;
}

async function api<T>(path: string): Promise<T> {
  return (await (await fetch(`${engine.baseURL}/api${path}`)).json()) as T;
}

async function jobNamed(name: string): Promise<JobOnServer> {
  const job = (await api<JobOnServer[]>('/jobs')).find((candidate) => candidate.name === name);
  expect(job, `the server lists "${name}"`).toBeDefined();
  return job as JobOnServer;
}

interface GenerateOnServer {
  phase: string;
  spendUsd: number;
  budgetUsd: number;
}

const generateOf = (id: string) => api<GenerateOnServer>(`/jobs/${id}/generate`);

test('a generated video goes by itself to Review, shows its stage and sizes, and Approve gives two files', async ({
  page,
}) => {
  test.setTimeout(540_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openApp(page, engine.baseURL);

  const JOB = '97 Window Ad';
  await engine.createJob({ client: CLIENT, job: JOB, generated: true });
  const row = rowOf(page, JOB);

  await test.step('Arrived, Brief, Generate and the edit, with no hands, end in Review', async () => {
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    // The row says what the video is: its length and both sizes.
    await expect(row).toContainText('Ready to review');
    await expect(row).toContainText('9:16 and 1:1');
    const job = await jobNamed(JOB);
    const generate = await generateOf(job.id);
    expect(generate.phase).toBe('done');
    expect(generate.budgetUsd).toBe(3);
    expect(generate.spendUsd).toBeGreaterThan(0);
    expect(generate.spendUsd).toBeLessThanOrEqual(3);
    // The History the stage wrote: what it decided and what it made.
    const history = await api<{ events: { kind: string }[] }>(`/jobs/${job.id}/generate/history`);
    expect(history.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['decided', 'voice', 'looks', 'keyframes', 'clip']),
    );
  });

  await test.step('the sheet has the Generate step and the Generated part, with the spend', async () => {
    await openSheetByClick(page, row);
    const sheet = sheetOf(page);
    await expect(sheet).toContainText('Generate');
    await expect(sheet).toContainText('Generated');
    for (const label of ['Voice', 'Looks', 'Keyframes', 'Clips', 'Spend']) {
      await expect(sheet.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(sheet).toContainText('of $3');
    await closeSheetByClick(page);
  });

  const dialog = reviewDialog(page);
  const job = await jobNamed(JOB);

  await test.step('Review has the 9:16 | 1:1 switch, which swaps what the note box says', async () => {
    await action(row, 'Review').click();
    await expect(dialog).toBeVisible();
    const player = dialog.locator('[data-slot="preview-player"]');
    await expect(player).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
    const nine = dialog.locator('[data-slot="format-switch"] [data-format="9x16"]');
    const one = dialog.locator('[data-slot="format-switch"] [data-format="1x1"]');
    await expect(nine).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog).toContainText('New note at 0:00 on 9:16');
    await one.click();
    await expect(one).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog).toContainText('on 1:1');
    // The engine makes the full video of each size by itself, so the 1:1 one may already be
    // rendering ("Rendering…") or ready ("Save MP4 · 1:1") when the switch is pressed.
    await expect(
      dialog
        .getByRole('button', { name: /Export MP4 · 1:1/ })
        .or(dialog.getByRole('button', { name: 'Rendering…' }))
        .or(dialog.getByRole('link', { name: /Save MP4 · 1:1/ })),
    ).toBeVisible();
    await nine.click();
    await expect(nine).toHaveAttribute('aria-pressed', 'true');
  });

  await test.step('a note about a clip, one about the voice and one about the layout show their hints', async () => {
    const plan = await api<{
      clips: { id: string; windows: { startSec: number; endSec: number }[] }[];
      lines: { id: string; startSec: number; endSec: number }[];
    }>(`/jobs/${job.id}/generate/review-plan`);
    const clip = plan.clips[0];
    expect(clip, 'the plan has a clip').toBeDefined();
    const window = clip?.windows[0];
    const clipAt = Math.floor(((window?.startSec ?? 0) + (window?.endSec ?? 1)) / 2);
    const box = dialog.getByRole('textbox');

    await seekTo(page, dialog, clipAt);
    await box.click();
    await box.fill('His left hand bends oddly while he pours.');
    await box.press('Enter');
    await expect(dialog).toContainText(`New take of clip ${clip?.id}`);

    await seekTo(page, dialog, 1);
    await box.click();
    await box.fill('Stress the BUT more, with a real pause after it.');
    await box.press('Enter');
    await expect(dialog).toContainText('Remakes voice line');
    await expect(dialog).toContainText('nothing spent on Higgsfield');

    // A layout note written on 1:1 is only about that size.
    await dialog.locator('[data-slot="format-switch"] [data-format="1x1"]').click();
    await seekTo(page, dialog, 2);
    await box.click();
    await box.fill('End card: the button lower.');
    await box.press('Enter');
    await expect(dialog).toContainText('Edit change');
    await expect(dialog).toContainText('1:1 only');

    // The footer adds the new takes up against what is left of the $3.
    await expect(dialog).toContainText('New takes use about');
    await expect(dialog).toContainText('left of the $3');
    await expect(dialog.getByRole('button', { name: 'Send 3 notes', exact: true })).toBeVisible();
  });

  await test.step('Send runs a revise round: the notes keep the size they were written on', async () => {
    await dialog.getByRole('button', { name: 'Send 3 notes', exact: true }).click();
    await expect(badge(row, 'Review'))
      .toBeHidden(RUN)
      .catch(() => {});
    await expect.poll(async () => (await jobNamed(JOB)).round, RUN).toBe(1);
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    const round = await readFile(
      join(engine.inbox, CLIENT, JOB, 'edit', 'review', 'round-1.md'),
      'utf8',
    );
    // Two sizes: a note says which one it was written on, the main one too.
    expect(round).toContain('(on 1:1)');
    expect(round).toContain('(on 9:16)');
  });

  await test.step('Approve renders both sizes and the sheet lists two files', async () => {
    await action(row, 'Review').click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('right-click menu to render both formats');
    await approveFromRowMenu(page, row);
    await expect(badge(row, 'Approved')).toBeVisible(RUN);
    const done = await jobNamed(JOB);
    expect(done.state).toBe('ready');
    const outputs = done.output?.outputs ?? [];
    expect(outputs.map((output) => output.format).sort()).toEqual(['1x1', '9x16']);
    for (const output of outputs) {
      expect(existsSync(join(engine.exportsDir, output.fileName))).toBe(true);
    }
    await openSheetByClick(page, row);
    const sheet = sheetOf(page);
    await expect(
      sheet.getByRole('link', { name: /Download/ }).or(sheet.getByText('Download')),
    ).toHaveCount(2);
    await expect(sheet).toContainText('1080 × 1920');
    await expect(sheet).toContainText('1080 × 1080');
  });

  expect(pageErrors, 'no page errors').toEqual([]);
});

const FAILURES = [
  {
    job: 'Balance empty',
    marker: 'balance_empty after=14',
    says: /Higgsfield balance is empty/,
    sheet: /Higgsfield balance is empty/,
  },
  {
    job: 'Key refused',
    marker: 'key_rejected',
    says: /Higgsfield key not accepted/,
    sheet: /Higgsfield key not accepted/,
  },
  {
    job: 'Too dear',
    marker: 'over_budget',
    says: /Needs about \$[\d.]+, the budget is \$3/,
    sheet: /needs about \$[\d.]+, over the budget of \$3/,
  },
] as const;

test('a stop at Generate says why in plain words, and Retry carries on from the clips already made', async ({
  page,
}) => {
  test.setTimeout(540_000);
  await openApp(page, engine.baseURL);
  for (const failure of FAILURES) {
    await engine.createJob({
      client: CLIENT,
      job: failure.job,
      generated: true,
      failGenerate: failure.marker,
    });
  }
  for (const failure of FAILURES) {
    const row = rowOf(page, failure.job);
    await test.step(`${failure.job}: the row and the sheet say it`, async () => {
      await expect(badge(row, 'Failed')).toBeVisible(RUN);
      await expect(row).toContainText(failure.says);
      await openSheetByClick(page, row);
      const sheet = sheetOf(page);
      await expect(sheet).toContainText(failure.sheet);
      await expect(sheet.getByRole('button', { name: 'Retry from Generate' })).toBeVisible();
      await closeSheetByClick(page);
    });
  }

  await test.step('Retry after a balance stop goes on, and nothing is charged twice', async () => {
    const name = 'Balance empty';
    const before = await generateOf((await jobNamed(name)).id);
    // The service is back: the marker that made the scripts fail goes away, then Retry.
    await rm(join(engine.inbox, CLIENT, name, '.fail-at-generate'), { force: true });
    const row = rowOf(page, name);
    await openSheetByClick(page, row);
    await sheetOf(page).getByRole('button', { name: 'Retry from Generate' }).click();
    await closeSheetByClick(page);
    await expect(badge(row, 'Review')).toBeVisible(RUN);
    const after = await generateOf((await jobNamed(name)).id);
    expect(after.phase).toBe('done');
    // What was made before the stop is kept: the whole video costs what one full pass costs.
    expect(after.spendUsd).toBeGreaterThanOrEqual(before.spendUsd);
    const ledger = JSON.parse(
      await readFile(join(engine.inbox, CLIENT, name, 'edit', 'generate', 'spend.json'), 'utf8'),
    ) as { entries: { usd: number; refunded?: boolean; idempotencyKey?: string }[] };
    const keys = ledger.entries.map((entry) => entry.idempotencyKey).filter(Boolean);
    expect(new Set(keys).size, 'no request was booked twice').toBe(keys.length);
  });
});
