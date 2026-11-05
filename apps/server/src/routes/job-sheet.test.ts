import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  INSTAGRAM_MESSAGES,
  JOB_REVEAL_MESSAGES,
  type Job,
  type JobEvent,
  type JobOutput,
  jobReelResponseSchema,
  jobStepsResponseSchema,
  type RunKind,
  revealJobResponseSchema,
  type StepId,
  sentNotesResponseSchema,
  stockResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import {
  InstagramRepository,
  JobRepository,
  NoteRepository,
  StepRunRepository,
  type StudioDb,
} from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The real repositories on an in-memory database, a temp inbox and exports folder, a fake Finder
// (the folder opener and the file revealer record what they were asked and never open anything),
// and `app.request` for the HTTP.

const CLIENT = 'Northwind Bakery';
const PREVIEW: JobEvent = { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW };
const OUTPUT: JobOutput = {
  fileName: `${CLIENT}/Spring menu.mp4`,
  durationSec: 30,
  width: 1080,
  height: 1920,
  sizeBytes: 1_000_000,
};

const dirs: string[] = [];
const opened: StudioDb[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  app: Hono;
  jobs: JobRepository;
  runs: StepRunRepository;
  notes: NoteRepository;
  instagram: InstagramRepository;
  inboxPath: string;
  exportsDir: string;
  clock: ReturnType<typeof fakeClock>;
  /** The folders `openFolder` was asked to open, and the files `revealFile` was asked to show. */
  folders: string[];
  files: string[];
  /** A job with its folder on disk. It is `arriving` until the events move it. */
  addJob(name?: string, events?: JobEvent[]): Job;
  /** Times `steps` for 10 s each. A step in `open` is left open. */
  time(jobId: string, kind: RunKind, steps: readonly StepId[], open?: readonly StepId[]): void;
  /** Writes the job's export file, where `OUTPUT.fileName` says. */
  writeExport(fileName?: string): string;
}

function harness(
  options: {
    jobSheet?: boolean;
    /** Gives the routes the reels, as the engine does while the `instagram` switch is on. */
    instagram?: boolean;
    openFolder?: (path: string) => Promise<void>;
    revealFile?: (path: string) => Promise<void>;
  } = {},
): Harness {
  const base = mkdtempSync(join(tmpdir(), 'studio-job-sheet-routes-'));
  dirs.push(base);
  const inboxPath = join(base, 'inbox');
  const exportsDir = join(base, 'exports');
  mkdirSync(inboxPath, { recursive: true });
  mkdirSync(exportsDir, { recursive: true });
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const runs = new StepRunRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  const instagram = new InstagramRepository(db, { clock });
  const folders: string[] = [];
  const files: string[] = [];
  const app = createApp({
    jobSheet: options.jobSheet,
    jobSheetRoutes: {
      jobs,
      steps: runs,
      notes,
      inboxPath,
      exportsDir,
      openFolder:
        options.openFolder ??
        (async (path) => {
          folders.push(path);
        }),
      revealFile:
        options.revealFile ??
        (async (path) => {
          files.push(path);
        }),
      ...(options.instagram ? { instagram } : {}),
    },
  });

  return {
    app,
    jobs,
    runs,
    notes,
    instagram,
    inboxPath,
    exportsDir,
    clock,
    folders,
    files,
    addJob(name = 'Spring menu', events = []) {
      const { job } = jobs.upsertFromScan(makeScan(CLIENT, name));
      mkdirSync(join(inboxPath, job.relPath), { recursive: true });
      for (const event of events) {
        clock.tick();
        jobs.applyTransition(job.id, event);
      }
      return jobs.get(job.id) as Job;
    },
    time(jobId, kind, steps, open = []) {
      for (const step of steps) {
        runs.start(jobId, step, kind);
        clock.tick(10_000);
        if (!open.includes(step)) runs.end(jobId, step);
      }
    },
    writeExport(fileName = OUTPUT.fileName) {
      const path = join(exportsDir, fileName);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'not really a video');
      return path;
    },
  };
}

async function expectError(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await res.json()).error;
}

const getSteps = (h: Harness, id: string) => h.app.request(`/api/jobs/${id}/steps`);
const getSentNotes = (h: Harness, id: string) => h.app.request(`/api/jobs/${id}/sent-notes`);
const getStock = (h: Harness, id: string) => h.app.request(`/api/jobs/${id}/stock`);
const getReel = (h: Harness, id: string) => h.app.request(`/api/jobs/${id}/reel`);
const reveal = (h: Harness, id: string) =>
  h.app.request(`/api/jobs/${id}/reveal`, { method: 'POST' });

describe('GET /api/jobs/:id/steps', () => {
  it('answers the runs oldest first, with ISO times', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', [{ type: 'SETTLED' }, { type: 'START' }]);
    h.time(job.id, 'edit', [1, 2, 3]);

    const res = await getSteps(h, job.id);

    expect(res.status).toBe(200);
    const body = jobStepsResponseSchema.parse(await res.json());
    expect(body.jobId).toBe(job.id);
    expect(body.runs.map((run) => run.step)).toEqual([1, 2, 3]);
    expect(body.runs[0]).toEqual({
      step: 1,
      runKind: 'edit',
      round: 0,
      startedAt: '2026-10-20T10:00:02.000Z',
      endedAt: '2026-10-20T10:00:12.000Z',
    });
    const starts = body.runs.map((run) => run.startedAt);
    expect(starts).toEqual([...starts].sort());
  });

  it('gives an open run endedAt null', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', [{ type: 'SETTLED' }, { type: 'START' }]);
    h.time(job.id, 'edit', [1, 2], [2]);

    const body = jobStepsResponseSchema.parse(await (await getSteps(h, job.id)).json());

    expect(body.runs.map((run) => run.endedAt === null)).toEqual([false, true]);
  });

  it('answers no runs for a job that has not started', async () => {
    const h = harness();
    const job = h.addJob();

    const res = await getSteps(h, job.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: job.id, runs: [] });
  });

  it('gives every run the round it belongs to: an edit, two revise rounds and a render', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', [{ type: 'SETTLED' }, { type: 'START' }]);
    h.time(job.id, 'edit', [1, 2, 3, 4, 5, 6, 7]);
    for (const events of [
      [PREVIEW, { type: 'SEND_NOTES' }, { type: 'START' }],
      [PREVIEW, { type: 'SEND_NOTES' }, { type: 'START' }],
    ] as JobEvent[][]) {
      for (const event of events) h.jobs.applyTransition(job.id, event);
      h.time(job.id, 'revise', [4, 5, 6, 7]);
    }
    for (const event of [PREVIEW, { type: 'APPROVE' }, { type: 'START' }] as JobEvent[]) {
      h.jobs.applyTransition(job.id, event);
    }
    h.time(job.id, 'render', [8]);

    const body = jobStepsResponseSchema.parse(await (await getSteps(h, job.id)).json());

    expect(body.runs.map((run) => `${run.runKind}:${run.step}:r${run.round}`)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7].map((step) => `edit:${step}:r0`),
      ...[4, 5, 6, 7].map((step) => `revise:${step}:r1`),
      ...[4, 5, 6, 7].map((step) => `revise:${step}:r2`),
      'render:8:r2',
    ]);
    expect(Math.max(...body.runs.map((run) => run.round))).toBe(h.jobs.get(job.id)?.round);
  });

  it("leaves other jobs' runs out", async () => {
    const h = harness();
    const a = h.addJob('A', [{ type: 'SETTLED' }, { type: 'START' }]);
    const b = h.addJob('B', [{ type: 'SETTLED' }, { type: 'START' }]);
    h.time(a.id, 'edit', [1, 2]);
    h.time(b.id, 'edit', [1]);

    const body = jobStepsResponseSchema.parse(await (await getSteps(h, a.id)).json());

    expect(body.runs).toHaveLength(2);
  });

  it('answers 404 "Job <id> not found" for an unknown job', async () => {
    const h = harness();

    expect(await expectError(await getSteps(h, 'nobody'), 404)).toBe('Job nobody not found');
  });
});

describe('POST /api/jobs/:id/reveal', () => {
  const READY: JobEvent[] = [
    { type: 'SETTLED' },
    { type: 'START' },
    { type: 'SUCCEED', output: OUTPUT },
  ];

  it('shows the export selected when the job has one on disk, and opens no folder', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', READY);
    const file = h.writeExport();

    const res = await reveal(h, job.id);

    expect(res.status).toBe(200);
    expect(revealJobResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      revealed: 'file',
    });
    expect(h.files).toEqual([realpathSync(file)]);
    expect(h.folders).toEqual([]);
  });

  it('opens the job folder when the job has no output', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', [{ type: 'SETTLED' }, { type: 'START' }]);
    h.writeExport();

    const res = await reveal(h, job.id);

    expect(res.status).toBe(200);
    expect(revealJobResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      revealed: 'folder',
    });
    expect(h.folders).toEqual([join(h.inboxPath, job.relPath)]);
    expect(h.files).toEqual([]);
  });

  it('opens the job folder when the output is set but the file is gone', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', READY);

    const res = await reveal(h, job.id);

    expect(revealJobResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      revealed: 'folder',
    });
    expect(h.folders).toEqual([join(h.inboxPath, job.relPath)]);
    expect(h.files).toEqual([]);
  });

  it('opens the job folder when the output is a folder, not a file', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', READY);
    mkdirSync(join(h.exportsDir, OUTPUT.fileName), { recursive: true });

    const res = await reveal(h, job.id);

    expect(revealJobResponseSchema.parse(await res.json()).revealed).toBe('folder');
    expect(h.files).toEqual([]);
  });

  it('never shows a file outside the exports folder', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', [
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'SUCCEED', output: { ...OUTPUT, fileName: '../outside.mp4' } },
    ]);
    writeFileSync(join(h.exportsDir, '..', 'outside.mp4'), 'x');

    const res = await reveal(h, job.id);

    expect(revealJobResponseSchema.parse(await res.json()).revealed).toBe('folder');
    expect(h.files).toEqual([]);
  });

  it('opens the folder of a job with a Hebrew name exactly as the job lists it', async () => {
    const h = harness();
    const job = h.addJob('תפריט אביב');

    const res = await reveal(h, job.id);

    expect(res.status).toBe(200);
    expect(h.folders).toEqual([join(h.inboxPath, CLIENT, 'תפריט אביב')]);
  });

  it('answers 404 "Job <id> not found" for an unknown job, and opens nothing', async () => {
    const h = harness();

    expect(await expectError(await reveal(h, 'nobody'), 404)).toBe('Job nobody not found');
    expect(h.folders).toEqual([]);
    expect(h.files).toEqual([]);
  });

  it('answers 404 "The job folder is missing." when there is no export and the folder is gone', async () => {
    const h = harness();
    const job = h.addJob();
    rmSync(join(h.inboxPath, job.relPath), { recursive: true });

    expect(await expectError(await reveal(h, job.id), 404)).toBe(JOB_REVEAL_MESSAGES.folderMissing);
    expect(h.folders).toEqual([]);
    expect(h.files).toEqual([]);
  });

  it('still shows the export when the job folder is gone', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', READY);
    const file = h.writeExport();
    rmSync(join(h.inboxPath, job.relPath), { recursive: true });

    const res = await reveal(h, job.id);

    expect(revealJobResponseSchema.parse(await res.json()).revealed).toBe('file');
    expect(h.files).toEqual([realpathSync(file)]);
  });

  it('answers 500 "Could not open it in Finder." and logs when the file cannot be shown', async () => {
    const h = harness({
      revealFile: async () => {
        throw new Error('spawn open ENOENT');
      },
    });
    const job = h.addJob('Spring menu', READY);
    h.writeExport();

    expect(await expectError(await reveal(h, job.id), 500)).toBe(JOB_REVEAL_MESSAGES.couldNotOpen);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('answers 500 "Could not open it in Finder." and logs when the folder cannot be opened', async () => {
    const h = harness({
      openFolder: async () => {
        throw new Error('spawn open ENOENT');
      },
    });
    const job = h.addJob();

    expect(await expectError(await reveal(h, job.id), 500)).toBe(JOB_REVEAL_MESSAGES.couldNotOpen);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('is a POST only', async () => {
    const h = harness();
    const job = h.addJob();

    const res = await h.app.request(`/api/jobs/${job.id}/reveal`);

    expect(res.status).toBe(404);
    expect(h.folders).toEqual([]);
  });
});

describe('GET /api/jobs/:id/stock', () => {
  const item = {
    id: 'sfx-1',
    kind: 'sfx',
    source: 'openverse',
    sourceId: 'ov-1',
    file: 'sfx-1.mp3',
    title: 'Whoosh',
    creator: 'Jane Doe',
    creatorUrl: null,
    license: 'by',
    licenseUrl: null,
    sourceUrl: 'https://openverse.org/audio/ov-1',
    query: 'whoosh',
    run: '',
    durationMs: 1200,
    width: null,
    height: null,
    fetchedAt: '2026-10-25T10:00:00.000Z',
  };
  const writeRecord = (h: Harness, relPath: string, text: string) => {
    mkdirSync(join(h.inboxPath, relPath, 'edit', 'stock'), { recursive: true });
    writeFileSync(join(h.inboxPath, relPath, 'edit', 'stock', 'stock.json'), text);
  };

  it('answers what the job’s runs took, with their creators and licenses', async () => {
    const h = harness();
    const job = h.addJob('Spring menu');
    writeRecord(h, job.relPath, JSON.stringify({ version: 1, items: [item] }));

    const res = await getStock(h, job.id);

    expect(res.status).toBe(200);
    const body = stockResponseSchema.parse(await res.json());
    expect(body.jobId).toBe(job.id);
    expect(body.items).toEqual([item]);
  });

  it('answers no items for a job that took nothing, and for a record it cannot read', async () => {
    const h = harness();
    const job = h.addJob('Spring menu');
    expect(stockResponseSchema.parse(await (await getStock(h, job.id)).json()).items).toEqual([]);

    writeRecord(h, job.relPath, '{ not json');
    expect(stockResponseSchema.parse(await (await getStock(h, job.id)).json()).items).toEqual([]);

    writeRecord(h, job.relPath, JSON.stringify({ version: 2, items: [item] }));
    expect(stockResponseSchema.parse(await (await getStock(h, job.id)).json()).items).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('answers 404 for a job that does not exist', async () => {
    const h = harness();
    expect(await expectError(await getStock(h, 'nope'), 404)).toBe('Job nope not found');
  });

  it('works with the Job sheet switch off', async () => {
    const h = harness({ jobSheet: false });
    const job = h.addJob('Spring menu');
    expect((await getStock(h, job.id)).status).toBe(200);
  });
});

describe('GET /api/jobs/:id/reel', () => {
  const POSTED = '2026-10-20T09:30:00.000Z';

  /** A reel of the job's client, read by a scan and (when `jobId` is given) linked to the job. */
  function addReel(
    h: Harness,
    job: Job,
    jobId: string | null = job.id,
    shares: number | null = 820,
  ) {
    const scan = h.instagram.startScan({ clientId: job.clientId, handle: 'northwind' });
    h.instagram.upsertReels(scan.id, [
      {
        shortcode: 'C-spring',
        clientId: job.clientId,
        url: 'https://www.instagram.com/reel/C-spring/',
        postedAt: Date.parse(POSTED),
        plays: 27_500,
        likes: 1_640,
        comments: 71,
        shares,
      },
    ]);
    if (jobId !== null) h.instagram.linkReel('C-spring', jobId);
  }

  it('answers the linked reel with the numbers its last scan read', async () => {
    const h = harness({ instagram: true });
    const job = h.addJob('Spring menu');
    addReel(h, job);

    const res = await getReel(h, job.id);

    expect(res.status).toBe(200);
    expect(jobReelResponseSchema.parse(await res.json())).toEqual({
      jobId: job.id,
      reel: {
        shortcode: 'C-spring',
        url: 'https://www.instagram.com/reel/C-spring/',
        postedAt: POSTED,
        plays: 27_500,
        likes: 1_640,
        comments: 71,
        shares: 820,
      },
    });
  });

  it('answers the unread shares as null', async () => {
    const h = harness({ instagram: true });
    const job = h.addJob('Spring menu');
    addReel(h, job, job.id, null);

    const body = jobReelResponseSchema.parse(await (await getReel(h, job.id)).json());

    expect(body.reel?.shares).toBeNull();
    expect(body.reel?.plays).toBe(27_500);
  });

  it('answers reel null for a job no reel links, also when the client has reels of its own', async () => {
    const h = harness({ instagram: true });
    const job = h.addJob('Spring menu');
    expect(await (await getReel(h, job.id)).json()).toEqual({ jobId: job.id, reel: null });

    addReel(h, job, null);

    expect(await (await getReel(h, job.id)).json()).toEqual({ jobId: job.id, reel: null });
  });

  it('answers each job its own reel', async () => {
    const h = harness({ instagram: true });
    const linked = h.addJob('Spring menu');
    const other = h.addJob('Summer menu');
    addReel(h, linked);

    expect(
      jobReelResponseSchema.parse(await (await getReel(h, linked.id)).json()).reel?.shortcode,
    ).toBe('C-spring');
    expect(jobReelResponseSchema.parse(await (await getReel(h, other.id)).json()).reel).toBeNull();
  });

  it('answers 404 for a job that does not exist', async () => {
    const h = harness({ instagram: true });
    expect(await expectError(await getReel(h, 'nope'), 404)).toBe('Job nope not found');
  });

  it('answers 404 "Clients × Instagram is off." while the switch is off, whatever the job', async () => {
    const h = harness({ instagram: false });
    const job = h.addJob('Spring menu');

    expect(await expectError(await getReel(h, job.id), 404)).toBe(INSTAGRAM_MESSAGES.off);
    expect(await expectError(await getReel(h, 'nope'), 404)).toBe(INSTAGRAM_MESSAGES.off);
  });
});

describe('GET /api/jobs/:id/sent-notes', () => {
  function addText(h: Harness, jobId: string, id: string, atSec: number, text = id) {
    h.notes.create({ id, jobId, kind: 'text', atSec, text });
  }

  it('answers the sent notes by round, then by where each is pinned; drafts are left out', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', [{ type: 'SETTLED' }, { type: 'START' }, PREVIEW]);
    addText(h, job.id, 'r1-late', 9);
    addText(h, job.id, 'r1-early', 1);
    h.notes.markSent(job.id, ['r1-late', 'r1-early'], 1, '2026-10-20T11:00:00.000Z');
    addText(h, job.id, 'r2-first', 0.5);
    h.notes.markSent(job.id, ['r2-first'], 2, '2026-10-20T12:00:00.000Z');
    addText(h, job.id, 'draft', 0);

    const res = await getSentNotes(h, job.id);

    expect(res.status).toBe(200);
    const body = sentNotesResponseSchema.parse(await res.json());
    expect(body.jobId).toBe(job.id);
    expect(body.notes.map((note) => [note.round, note.id])).toEqual([
      [1, 'r1-early'],
      [1, 'r1-late'],
      [2, 'r2-first'],
    ]);
  });

  it('answers in states other than Review (queued, editing, approved, ready)', async () => {
    const h = harness();
    const job = h.addJob('Spring menu', [{ type: 'SETTLED' }, { type: 'START' }, PREVIEW]);
    addText(h, job.id, 'n1', 3);
    h.notes.markSent(job.id, ['n1'], 1, '2026-10-20T11:00:00.000Z');
    const states: Job['state'][] = [];
    const sentIds = async () =>
      sentNotesResponseSchema
        .parse(await (await getSentNotes(h, job.id)).json())
        .notes.map((note) => note.id);

    for (const event of [
      { type: 'SEND_NOTES' },
      { type: 'START' },
      PREVIEW,
      { type: 'APPROVE' },
      { type: 'START' },
      { type: 'SUCCEED', output: OUTPUT },
    ] as JobEvent[]) {
      h.jobs.applyTransition(job.id, event);
      states.push((h.jobs.get(job.id) as Job).state);
      expect(await sentIds(), states.at(-1)).toEqual(['n1']);
    }

    expect(states).toEqual(['queued', 'editing', 'review', 'queued', 'editing', 'ready']);
  });

  it('answers no notes for a job that has sent none', async () => {
    const h = harness();
    const job = h.addJob();
    addText(h, job.id, 'draft', 1);

    const res = await getSentNotes(h, job.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: job.id, notes: [] });
  });

  it("leaves other jobs' notes out", async () => {
    const h = harness();
    const a = h.addJob('A');
    const b = h.addJob('B');
    addText(h, a.id, 'a1', 1);
    addText(h, b.id, 'b1', 1);
    h.notes.markSent(a.id, ['a1'], 1, '2026-10-20T11:00:00.000Z');
    h.notes.markSent(b.id, ['b1'], 1, '2026-10-20T11:00:00.000Z');

    const body = sentNotesResponseSchema.parse(await (await getSentNotes(h, a.id)).json());

    expect(body.notes.map((note) => note.id)).toEqual(['a1']);
  });

  it('answers 404 "Job <id> not found" for an unknown job', async () => {
    const h = harness();

    expect(await expectError(await getSentNotes(h, 'nobody'), 404)).toBe('Job nobody not found');
  });
});

describe('the Job sheet switch', () => {
  it.each([true, false])('answers all three routes with the switch %s', async (jobSheet) => {
    const h = harness({ jobSheet });
    const job = h.addJob();

    expect((await getSteps(h, job.id)).status).toBe(200);
    expect((await getSentNotes(h, job.id)).status).toBe(200);
    expect((await reveal(h, job.id)).status).toBe(200);
  });

  it('answers no job-sheet route when the app is built without them', async () => {
    const app = createApp({});

    expect((await app.request('/api/jobs/a1/steps')).status).toBe(404);
    expect((await app.request('/api/jobs/a1/sent-notes')).status).toBe(404);
    expect((await app.request('/api/jobs/a1/stock')).status).toBe(404);
    expect((await app.request('/api/jobs/a1/reel')).status).toBe(404);
    expect((await app.request('/api/jobs/a1/reveal', { method: 'POST' })).status).toBe(404);
  });
});
