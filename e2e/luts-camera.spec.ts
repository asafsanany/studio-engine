// CVP-311 (LU10): a job whose footage is log and has no camera LUT says what it waits for, the LUTs
// page offers to import it, and after the import it goes on. Through the built engine with the fake
// runner (it cannot measure frames, so a `.log-footage` file in the job folder stands for footage the
// colour grade would call log), both LUTs switches on, the real routes and the real _LUTs folder.
//
//   waiting   the job fails at Cut with "Waiting for a camera LUT: the clips are Sony S-Log3 (…)."; its
//             row says so in amber, with Import LUT; the LUTs page shows the banner
//   import    Import LUT on the row opens /luts with the dialog "For Ofek · FPV 3: a Sony S-Log3 to
//             Rec709 camera LUT.", the file starts at Camera, the banner turns to "Imported. Resume
//             Ofek · FPV 3 to use it."
//   resume    Resume runs the same job again: it finds the LUT in the library, copies it into the job
//             and finishes; the banner says "Resumed …" and then goes
//
// What this does not cover (unit tests and the QA note do): that the editor really applies the LUT
// (the fake runner only records what it was told) and the grade's own measurement of log.

import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type Engine, startEngine } from './support/engine.ts';
import { rowOf } from './support/jobs-ui.ts';

const WAIT = { timeout: 60_000 };
const CLIENT = 'Ofek';
const JOB = 'FPV 3';
const CLIP = 'FPV 3 S-Log3.mp4';

let engine: Engine;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  engine = await startEngine({
    settleMs: 2_000,
    fakeSpeed: 8,
    review: false,
    env: { STUDIO_LUTS_IN_EDITS: '1' },
  });
});

test.afterAll(async () => {
  await engine?.stop();
});

/** The text of a small .cube. */
function cube(n: number): string {
  const lines = ['TITLE "e2e"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        lines.push([r, g, b].map((v) => (v / (n - 1)).toFixed(6)).join(' '));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

async function dismissWhatsNew(page: Page): Promise<void> {
  const whatsNew = page.getByRole('dialog', { name: /What's new/ });
  await whatsNew.waitFor({ timeout: 5_000 }).then(
    () => whatsNew.getByRole('button', { name: 'Got it' }).click(),
    () => {},
  );
  await expect(whatsNew).toBeHidden();
}

async function open(page: Page, path: string): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${engine.baseURL}${path}`);
  await dismissWhatsNew(page);
  return pageErrors;
}

interface JobOnServer {
  id: string;
  name: string;
  state: string;
  error: string | null;
  failedAt: number | null;
}

async function jobOnServer(): Promise<JobOnServer> {
  const jobs = (await (await fetch(`${engine.baseURL}/api/jobs`)).json()) as JobOnServer[];
  const job = jobs.find((candidate) => candidate.name === JOB);
  if (job === undefined) throw new Error('The job is not on the server yet.');
  return job;
}

/** `LU10_SHOTS=<folder>` keeps a 1440 x 900 screenshot of each state for the design check. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.LU10_SHOTS;
  if (folder === undefined) return;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(folder, `${name}.png`) });
}

const banner = (page: Page) => page.locator('[data-slot="camera-lut-banner"]');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Import LUTs' });

const SENTENCE = `Waiting for a camera LUT: the clips are Sony S-Log3 (${CLIP}).`;

test('a job on log footage with no camera LUT waits, and says what for', async ({ page }) => {
  const jobDir = await engine.createJob({ client: CLIENT, job: JOB });
  // The footage names its curve; the marker says the grade would measure it as log.
  await writeFile(join(jobDir, CLIP), await readFile(join(jobDir, 'clip.mp4')));
  await writeFile(join(jobDir, '.log-footage'), '');

  const pageErrors = await open(page, '/jobs');

  await test.step('the job fails at Cut with the sentence for an error', async () => {
    await expect
      .poll(async () => (await jobOnServer()).state, { ...WAIT, message: 'the job fails' })
      .toBe('failed');
    const job = await jobOnServer();
    expect(job.error).toBe(SENTENCE);
    expect(job.failedAt).toBe(5);
  });

  await test.step('its row says what it waits for in amber, not "Failed at Cut", with Import LUT', async () => {
    const row = rowOf(page, JOB);
    const detail = row.locator('[data-camera-wait]');
    await expect(detail).toBeVisible(WAIT);
    await expect(detail).toContainText('Waiting for a camera LUT');
    await expect(row).not.toContainText('Failed at');
    await expect(row.getByRole('link', { name: 'Import LUT' })).toBeVisible();
    // the next step is still Retry, in the Action column
    await expect(row.getByRole('button', { name: /^Retry/ })).toBeVisible();
    await shot(page, '1-jobs-row');
  });

  await test.step('the sheet shows the sentence in an amber box with Import LUT', async () => {
    await rowOf(page, JOB).getByText(JOB).first().click();
    const box = page.locator('[data-slot="job-sheet-error"]');
    await expect(box).toBeVisible();
    await expect(box).toContainText('Waiting for a camera LUT');
    await expect(box).toContainText(SENTENCE);
    await expect(box.getByRole('link', { name: 'Import LUT' })).toBeVisible();
    await shot(page, '2-job-sheet');
    await page.keyboard.press('Escape');
  });

  expect(pageErrors).toEqual([]);
});

test('Import LUT opens the LUTs page for the job: the banner, and the dialog asking for the LUT', async ({
  page,
}) => {
  const pageErrors = await open(page, '/jobs');
  await rowOf(page, JOB).getByRole('link', { name: 'Import LUT' }).click();
  await expect(page).toHaveURL(/\/luts/);

  await test.step('the banner says which job waits and why, and the dialog is open for it', async () => {
    await expect(banner(page)).toBeVisible(WAIT);
    await expect(banner(page)).toHaveAttribute('data-state', 'waiting');
    await expect(banner(page)).toContainText(
      'Ofek · FPV 3 is waiting for a camera LUT. Its clips are Sony S-Log3 and none of your LUTs match.',
    );
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText(
      'For Ofek · FPV 3: a Sony S-Log3 to Rec709 camera LUT.',
    );
    // ?for= was used once and is gone from the address
    await expect(page).not.toHaveURL(/for=/);
    await shot(page, '3-luts-banner-dialog');
  });

  await test.step('a file with a name that does not say camera still starts at Camera', async () => {
    const picker = dialog(page).locator('input[type="file"]:not([webkitdirectory])');
    await picker.setInputFiles([
      {
        name: 'Sony Cine.cube',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(cube(5)),
      },
    ]);
    const item = dialog(page).getByRole('list', { name: 'Files to import' }).locator('li');
    await expect(item).toHaveCount(1, WAIT);
    await expect(item.getByRole('button', { name: 'Camera' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toBeHidden();
  });

  expect(pageErrors).toEqual([]);
});

test('importing the camera LUT turns the banner to Resume, and Resume runs the same job again', async ({
  page,
}) => {
  const pageErrors = await open(page, '/luts');
  await expect(banner(page)).toHaveAttribute('data-state', 'waiting', WAIT);

  await test.step('Import a camera LUT: the dialog is for the job, the LUT goes in as a Camera LUT', async () => {
    await banner(page).getByRole('button', { name: 'Import a camera LUT' }).click();
    await expect(dialog(page)).toContainText(
      'For Ofek · FPV 3: a Sony S-Log3 to Rec709 camera LUT.',
    );
    const picker = dialog(page).locator('input[type="file"]:not([webkitdirectory])');
    await picker.setInputFiles([
      {
        name: 'Sony S-Log3 to Rec709.cube',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(cube(7)),
      },
    ]);
    await expect(dialog(page).getByRole('button', { name: 'Camera' })).toHaveAttribute(
      'aria-pressed',
      'true',
      WAIT,
    );
    await dialog(page).getByRole('button', { name: 'Import 1 LUT' }).click();
    await expect(dialog(page)).toBeHidden(WAIT);
  });

  await test.step('the banner now says the LUT is in and offers Resume', async () => {
    await expect(banner(page)).toHaveAttribute('data-state', 'ready', WAIT);
    await expect(banner(page)).toContainText('Imported. Resume Ofek · FPV 3 to use it.');
    await expect(banner(page).getByRole('button', { name: 'Resume' })).toBeEnabled();
    await shot(page, '4-luts-imported-resume');
  });

  await test.step('Resume runs the job again; it uses the LUT and finishes', async () => {
    await banner(page).getByRole('button', { name: 'Resume' }).click();
    await expect(banner(page)).toContainText('Resumed Ofek · FPV 3.', WAIT);
    await shot(page, '5-luts-resumed');
    await expect
      .poll(async () => (await jobOnServer()).state, { ...WAIT, message: 'the job finishes' })
      .toBe('ready');
    const told = JSON.parse(
      await readFile(join(engine.inbox, CLIENT, JOB, 'edit', 'library-refs.json'), 'utf8'),
    ) as {
      camera: { curves: { curve: string; match: { kind: string; lut?: { path: string } } }[] };
    };
    expect(told.camera.curves).toHaveLength(1);
    expect(told.camera.curves[0]).toMatchObject({
      curve: 'slog3',
      match: { kind: 'one', lut: { path: 'edit/luts/sony-s-log3-to-rec709.cube' } },
    });
    await access(join(engine.inbox, CLIENT, JOB, 'edit', 'luts', 'sony-s-log3-to-rec709.cube'));
  });

  await test.step('the banner goes by itself once nothing waits', async () => {
    await expect(banner(page)).toHaveCount(0, { timeout: 15_000 });
  });

  expect(pageErrors).toEqual([]);
});
