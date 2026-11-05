import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GenerateHistoryResponse,
  generateHistoryResponseSchema,
  generateNotePlanSchema,
  type Job,
  jobListDetail,
  jobSchema,
  type ReviewNote,
  reviewNoteSchema,
} from '@studio/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startCanvasServer } from './seed-canvas.js';
import { GENERATE_IDS, GENERATE_JOB_SPECS } from './seed-generate.js';

// `pnpm seed:canvas --generate`: four jobs in Review for Generated videos' Review (GN8): a generated
// job with two formats and the board's three notes, one with a single format, an ordinary one, and
// a footage job with two formats; and (GN9) one job for each state of the boards GNStates and
// GNSheet; with the Generate routes mounted and no key.

const stops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('the Generated videos Review (--generate)', () => {
  let url: string;
  let inboxPath: string;
  const get = async <T>(path: string): Promise<{ status: number; json: T }> => {
    const response = await fetch(`${url}/api${path}`);
    return { status: response.status, json: (await response.json()) as T };
  };

  beforeAll(async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
    await writeFile(join(webDist, 'index.html'), '<!doctype html>');
    stops.push(() => rm(webDist, { recursive: true, force: true }));
    const server = await startCanvasServer({ webDist, generate: true });
    stops.push(server.stop);
    url = server.url;
    inboxPath = server.inboxPath;
  }, 60_000);

  const REVIEW_IDS = [
    GENERATE_IDS.pinewood,
    GENERATE_IDS.single,
    GENERATE_IDS.footage,
    GENERATE_IDS.twoFormats,
  ];

  it('turns the switch on and seeds the jobs: four in Review and one for each state', async () => {
    const health = await get<{ generate?: boolean }>('/health');
    expect(health.json.generate).toBe(true);
    const jobs = (await get<Job[]>('/jobs')).json;
    expect(jobs.map((job) => job.id).sort()).toEqual(
      GENERATE_JOB_SPECS.map((spec) => spec.id).sort(),
    );
    for (const job of jobs) expect(jobSchema.safeParse(job).success).toBe(true);
    for (const job of jobs.filter((one) => REVIEW_IDS.includes(one.id as never))) {
      expect(job.state).toBe('review');
    }
  });

  it('gives the ad and the brand film two formats, and the others none', async () => {
    const jobs = (await get<Job[]>('/jobs')).json;
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const id of [GENERATE_IDS.pinewood, GENERATE_IDS.twoFormats]) {
      expect(byId.get(id)?.formats?.map((format) => format.label)).toEqual(['9:16', '1:1']);
    }
    for (const id of [GENERATE_IDS.single, GENERATE_IDS.footage]) {
      expect(byId.get(id)).not.toHaveProperty('formats');
    }
  });

  it('marks the two generated Review jobs with their Generate state, $2.33 of the $3', async () => {
    const jobs = (await get<Job[]>('/jobs')).json;
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const id of [GENERATE_IDS.single, GENERATE_IDS.pinewood]) {
      expect(byId.get(id)?.generate).toMatchObject({
        phase: 'done',
        spendUsd: 2.33,
        budgetUsd: 3,
      });
    }
    for (const id of [GENERATE_IDS.footage, GENERATE_IDS.twoFormats, GENERATE_IDS.brief]) {
      expect(byId.get(id)).not.toHaveProperty('generate');
    }
  });

  // GN9: the Jobs row says what the boards GNStates say, for every state.
  it('reads the ten rows of the board GNStates from the seeded jobs', async () => {
    const jobs = (await get<Job[]>('/jobs')).json;
    const detail = (id: string): string => {
      const job = jobs.find((one) => one.id === id);
      if (job === undefined) throw new Error(`no job ${id}`);
      return jobListDetail(job, Date.now());
    };
    expect(detail(GENERATE_IDS.brief)).toBe('Brief · reading 9 files');
    expect(detail(GENERATE_IDS.voice)).toBe('Generate · voice 3/7');
    expect(detail(GENERATE_IDS.looks)).toBe('Generate · looks 2/3');
    expect(detail(GENERATE_IDS.keyframes)).toBe('Generate · keyframes 5/7');
    expect(detail(GENERATE_IDS.clips)).toBe('Generate · clips 4/6 · $1.65');
    expect(detail(GENERATE_IDS.balance)).toBe('Higgsfield balance is empty');
    expect(detail(GENERATE_IDS.key)).toBe('Higgsfield key not accepted');
    expect(detail(GENERATE_IDS.over)).toBe('Needs about $4.10, the budget is $3');
    expect(detail(GENERATE_IDS.budget)).toBe('Ready to review · 0:35 · 1 clip below the bar');
    expect(detail(GENERATE_IDS.pinewood)).toBe('Ready to review · 0:06 · 9:16 and 1:1');
    expect(detail(GENERATE_IDS.approved)).toBe('2 files · 9:16 and 1:1 · 0:35');
    // An ordinary job in Review reads as it always did.
    expect(detail(GENERATE_IDS.footage)).toBe('Ready to review · 0:06');
  });

  it('answers the stage’s History for the generated jobs, and 404 for a job without one', async () => {
    const clips = await get<GenerateHistoryResponse>(
      `/jobs/${GENERATE_IDS.clips}/generate/history`,
    );
    expect(clips.status).toBe(200);
    const parsed = generateHistoryResponseSchema.parse(clips.json);
    expect(parsed.events.map((event) => event.kind)).toEqual([
      'decided',
      'unpacked',
      'voice',
      'looks',
      'keyframes',
      'clip',
      'clip',
    ]);
    const balance = generateHistoryResponseSchema.parse(
      (await get(`/jobs/${GENERATE_IDS.balance}/generate/history`)).json,
    );
    expect(balance.events.at(-1)).toMatchObject({ kind: 'stopped', code: 'balance_empty' });
    expect((await get(`/jobs/${GENERATE_IDS.brief}/generate/history`)).status).toBe(404);
    expect((await get(`/jobs/${GENERATE_IDS.footage}/generate`)).status).toBe(404);
  });

  it('gives the failed jobs the engine’s own error sentences, kept at step 1', async () => {
    const jobs = (await get<Job[]>('/jobs')).json;
    const failed = jobs.filter((job) => job.state === 'failed');
    expect(failed.map((job) => [job.id, job.failedAt]).sort()).toEqual(
      [GENERATE_IDS.balance, GENERATE_IDS.key, GENERATE_IDS.over].sort().map((id) => [id, 1]),
    );
    expect(failed.find((job) => job.id === GENERATE_IDS.over)?.error).toBe(
      "This video needs about $4.10, over the budget of $3: add a note like 'budget $5' and Retry.",
    );
  });

  it('gives the budget job a clip below the bar the sheet can name, and the approved job a file for each format', async () => {
    const plan = generateNotePlanSchema.parse(
      (await get(`/jobs/${GENERATE_IDS.budget}/generate/review-plan`)).json,
    );
    expect(plan.clips.filter((clip) => clip.belowBar === true).map((clip) => clip.id)).toEqual([
      'B',
    ]);
    const jobs = (await get<Job[]>('/jobs')).json;
    const approved = jobs.find((job) => job.id === GENERATE_IDS.approved);
    expect(approved?.output?.outputs?.map((file) => file.format)).toEqual(['9x16', '1x1']);
    const main = await fetch(`${url}/api/jobs/${GENERATE_IDS.approved}/download?format=9x16`);
    const square = await fetch(`${url}/api/jobs/${GENERATE_IDS.approved}/download?format=1x1`);
    expect(main.status).toBe(200);
    expect(square.status).toBe(200);
    expect(decodeURIComponent(square.headers.get('content-disposition') ?? '')).toContain(
      '(1x1).mp4',
    );
  });

  it('times the Brief of the generated jobs and leaves the open one open', async () => {
    const steps = async (id: string) =>
      (
        await get<{ runs: { step: number; endedAt: string | null; runKind: string }[] }>(
          `/jobs/${id}/steps`,
        )
      ).json.runs;
    expect(
      (await steps(GENERATE_IDS.brief)).map((run) => [run.step, run.endedAt === null]),
    ).toEqual([[1, true]]);
    expect(
      (await steps(GENERATE_IDS.clips)).map((run) => [run.step, run.endedAt !== null]),
    ).toEqual([[1, true]]);
    const approved = await steps(GENERATE_IDS.approved);
    expect(approved.map((run) => run.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(approved.at(-1)?.runKind).toBe('render');
  });

  it('seeds the board’s notes on the ad, the last one on 1:1', async () => {
    const notes = (await get<ReviewNote[]>(`/jobs/${GENERATE_IDS.pinewood}/notes`)).json.map(
      (note) => reviewNoteSchema.parse(note),
    );
    expect(notes.map((note) => [note.atSec, note.format ?? null])).toEqual([
      [2.4, null],
      [3, null],
      [5.4, '1x1'],
    ]);
    expect((await get<ReviewNote[]>(`/jobs/${GENERATE_IDS.footage}/notes`)).json).toEqual([]);
  });

  it('answers the plan the hints read, for a generated job only', async () => {
    const plan = await get(`/jobs/${GENERATE_IDS.pinewood}/generate/review-plan`);
    expect(plan.status).toBe(200);
    const parsed = generateNotePlanSchema.parse(plan.json);
    expect(parsed.clips.map((clip) => [clip.id, clip.usd])).toEqual([
      ['A', 0.36],
      ['B', 0.51],
      ['C', 0.18],
      ['D', 0.34],
    ]);
    expect(parsed.lines.map((line) => line.id)).toEqual(['L1', 'L2', 'L3']);
    expect((await get(`/jobs/${GENERATE_IDS.footage}/generate/review-plan`)).status).toBe(404);
  });

  it('serves a live composition for each format', async () => {
    const main = await fetch(`${url}/api/jobs/${GENERATE_IDS.pinewood}/preview/index.html`);
    const square = await fetch(`${url}/api/jobs/${GENERATE_IDS.pinewood}/preview/1x1/index.html`);
    expect(main.status).toBe(200);
    expect(square.status).toBe(200);
    expect(await main.text()).toContain('data-height="1920"');
    const html = await square.text();
    expect(html).toContain('data-height="1080"');
    expect(html).toContain('97 Window Ad · 1:1');
    expect(await exists(join(inboxPath, 'Pinewood', '97 Window Ad', 'edit', 'preview-1x1'))).toBe(
      true,
    );
  });

  // C65: Export MP4 in Review makes the format on show, each as a file of its own.
  it('exports each format of the ad on its own, saved under names that cannot be mixed up', async () => {
    const id = GENERATE_IDS.pinewood;
    const statusAt = async (query: string) =>
      (
        (await (await fetch(`${url}/api/jobs/${id}/review-export${query}`)).json()) as {
          state: string;
        }
      ).state;
    const made = async (query: string) => {
      expect(
        (await fetch(`${url}/api/jobs/${id}/review-export${query}`, { method: 'POST' })).status,
      ).toBe(200);
      await vi.waitFor(async () => expect(await statusAt(query)).toBe('ready'), {
        timeout: 30_000,
      });
    };

    await made('?format=1x1');
    expect(await statusAt('')).toBe('idle');
    await made('');

    const square = await fetch(`${url}/api/jobs/${id}/review-export.mp4?r=1&format=1x1`);
    const main = await fetch(`${url}/api/jobs/${id}/review-export.mp4?r=1`);
    expect(square.status).toBe(200);
    expect(main.status).toBe(200);
    expect(decodeURIComponent(square.headers.get('content-disposition') ?? '')).toContain(
      '97 Window Ad (1x1).mp4',
    );
    const mainName = decodeURIComponent(main.headers.get('content-disposition') ?? '');
    expect(mainName).toContain('97 Window Ad.mp4');
    expect(mainName).not.toContain('1x1');
    const jobEdit = join(inboxPath, 'Pinewood', '97 Window Ad', 'edit');
    expect(await exists(join(jobEdit, 'review-export.mp4'))).toBe(true);
    expect(await exists(join(jobEdit, 'review-export-1x1.mp4'))).toBe(true);
    // A size the ad does not have is refused, and so is any size of a job with one format.
    expect((await fetch(`${url}/api/jobs/${id}/review-export?format=4x5`)).status).toBe(404);
    expect(
      (await fetch(`${url}/api/jobs/${GENERATE_IDS.single}/review-export?format=1x1`)).status,
    ).toBe(404);
  }, 60_000);

  it('refuses to be combined with another seed', async () => {
    await expect(startCanvasServer({ generate: true, review: true })).rejects.toThrow(
      /--generate seeds its own rows/,
    );
  });
});
