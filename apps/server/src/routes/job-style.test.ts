import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apiErrorSchema, clientStyleSchema, type Job, type JobOutput } from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobStills, STILL_PATH } from '../clients/job-still.js';
import type { StyleRunner } from '../clients/style-run.js';
import { StyleWorker } from '../clients/style-worker.js';
import { ClientStyleRepository, JobRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { resolveFfmpeg, runFfmpeg } from '../pipeline/fake-media.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Use this look and the stills, over the real repositories (in memory), a temp inbox and exports
// folder, and a real style worker that is never started, so a queued pass stays queued. The stills
// are made by the real ffmpeg when the machine has it.

const KOVA = 'Kova Coffee';
const ffmpeg = await resolveFfmpeg('ffmpeg');

let root: string;
let inboxPath: string;
let exportsDir: string;
let db: StudioDb;
let jobs: JobRepository;
let clientStyles: ClientStyleRepository;
let app: Hono;

const neverRuns: StyleRunner = {
  run: async () => {
    throw new Error('the worker is not started in these tests');
  },
};

function build(stills = new JobStills({ inboxPath, exportsDir })): Hono {
  const worker = new StyleWorker({
    clientStyles,
    inboxPath,
    dataDir: join(root, 'data'),
    runner: neverRuns,
  });
  return createApp({ jobStyle: { jobs, clientStyles, worker, stills } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-job-style-'));
  inboxPath = join(root, 'inbox');
  exportsDir = join(inboxPath, '_Exports');
  db = memoryDb();
  const clock = fakeClock();
  jobs = new JobRepository(db, { clock });
  clientStyles = new ClientStyleRepository(db);
  app = build();
});

afterEach(() => {
  if (db.sqlite.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

const OUTPUT: JobOutput = {
  fileName: `${KOVA}/Menu.mp4`,
  durationSec: 8,
  width: 720,
  height: 1280,
  sizeBytes: 1,
};

/** A job of Kova Coffee, taken to ready (with OUTPUT) unless told to stay queued. */
function job(name = 'Menu', ready = true): Job {
  const { job: scanned } = jobs.upsertFromScan(makeScan(KOVA, name));
  mkdirSync(join(inboxPath, KOVA, name), { recursive: true });
  jobs.applyTransition(scanned.id, { type: 'SETTLED' });
  if (!ready) return jobs.get(scanned.id) as Job;
  jobs.applyTransition(scanned.id, { type: 'START' });
  return jobs.applyTransition(scanned.id, { type: 'SUCCEED', output: OUTPUT });
}

const exportPath = () => join(exportsDir, OUTPUT.fileName);

const useLook = (id: string) =>
  Promise.resolve(app.request(`/api/jobs/${id}/use-look`, { method: 'POST' }));
const still = (id: string) => Promise.resolve(app.request(`/api/jobs/${id}/still`));

describe('POST /api/jobs/:id/use-look', () => {
  it('queues a Learn pass from the job that replaces the style, and answers the analysing style', async () => {
    const ready = job();

    const res = await useLook(ready.id);

    expect(res.status).toBe(200);
    const body = clientStyleSchema.parse(await res.json());
    expect(body).toMatchObject({
      clientId: ready.clientId,
      client: KOVA,
      state: 'analysing',
      pass: { kind: 'learn', mode: 'replace', fileCount: 0, jobId: ready.id, job: 'Menu' },
    });
    expect(body).not.toHaveProperty('lastPass');
    expect(clientStyles.get(ready.clientId)?.lastPass).toEqual({
      kind: 'learn',
      mode: 'replace',
      jobId: ready.id,
      job: 'Menu',
    });
  });

  it('answers 404 for an unknown job', async () => {
    const res = await useLook('nope');
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toBe('Job nope not found');
  });

  it('answers 409 unless the job is ready', async () => {
    const queued = job('Teaser', false);

    const res = await useLook(queued.id);

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/this one is queued/);
    expect(clientStyles.get(queued.clientId)).toBeNull();
  });

  it('answers 409 while the client is analysing', async () => {
    const ready = job();
    clientStyles.upsert({ clientId: ready.clientId, client: KOVA, state: 'analysing' });

    const res = await useLook(ready.id);

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/being analysed/);
    expect(clientStyles.get(ready.clientId)?.lastPass).toBeNull();
  });
});

describe('GET /api/jobs/:id/still', () => {
  it('answers 404 for an unknown job, a job with no export, and an export that is gone', async () => {
    expect((await still('nope')).status).toBe(404);

    const queued = job('Teaser', false);
    const none = await still(queued.id);
    expect(none.status).toBe(404);
    expect(apiErrorSchema.parse(await none.json()).error).toBe('This job has no export.');

    const ready = job();
    const gone = await still(ready.id);
    expect(gone.status).toBe(404);
    expect(apiErrorSchema.parse(await gone.json()).error).toBe('This job has no export.');
  });

  it('answers 500 when there is no ffmpeg to make it', async () => {
    const ready = job();
    mkdirSync(dirname(exportPath()), { recursive: true });
    writeFileSync(exportPath(), 'video');
    app = build(new JobStills({ inboxPath, exportsDir, ffmpegBin: join(root, 'no-ffmpeg') }));

    const res = await still(ready.id);

    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/ffmpeg was not found/);
  });

  describe.skipIf(ffmpeg === null)('with ffmpeg', () => {
    /** 8 s, 720×1280: red for 1 s, blue from 1 s to 3 s, red after. 25% is 2 s: blue. */
    async function makeExport(): Promise<void> {
      mkdirSync(dirname(exportPath()), { recursive: true });
      const result = await runFfmpeg(
        { bin: ffmpeg as string, signal: new AbortController().signal, killGraceMs: 1_000 },
        [
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=720x1280:r=25:d=1',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=720x1280:r=25:d=2',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=720x1280:r=25:d=5',
          '-filter_complex',
          '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-y',
          exportPath(),
        ],
      );
      expect(result).toEqual({ status: 'ok' });
    }

    /** The width and height of a picture, and the colour of its middle pixel, by ffmpeg. */
    function look(path: string): { width: number; height: number; middle: number[] } {
      const ffprobe = join(dirname(ffmpeg as string), 'ffprobe');
      const [width, height] = execFileSync(ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        path,
      ])
        .toString()
        .trim()
        .split(',')
        .map(Number) as [number, number];
      const pixel = execFileSync(ffmpeg as string, [
        '-v',
        'error',
        '-i',
        path,
        '-vf',
        `crop=16:16:${Math.floor(width / 2) - 8}:${Math.floor(height / 2) - 8},scale=1:1`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ]);
      return { width, height, middle: [...pixel] };
    }

    it('is one JPEG frame at 25% of the export, 360 px wide, kept as edit/still.jpg', async () => {
      const ready = job();
      await makeExport();

      const res = await still(ready.id);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const bytes = Buffer.from(await res.arrayBuffer());
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      const kept = join(inboxPath, ready.relPath, STILL_PATH);
      expect(readFileSync(kept)).toEqual(bytes);
      const { width, height, middle } = look(kept);
      expect([width, height]).toEqual([360, 640]);
      // Blue, the colour at 2 s.
      const [red, , blue] = middle as [number, number, number];
      expect(blue).toBeGreaterThan(200);
      expect(red).toBeLessThan(60);
    });

    it('serves the kept still again, and makes it anew once the export is newer', async () => {
      const ready = job();
      await makeExport();
      expect((await still(ready.id)).status).toBe(200);
      const kept = join(inboxPath, ready.relPath, STILL_PATH);
      writeFileSync(kept, 'kept');
      const later = new Date(statSync(exportPath()).mtimeMs + 60_000);
      utimesSync(kept, later, later);

      expect(await (await still(ready.id)).text()).toBe('kept');

      const newer = new Date(later.getTime() + 60_000);
      utimesSync(exportPath(), newer, newer);
      const again = Buffer.from(await (await still(ready.id)).arrayBuffer());
      expect([...again.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    });

    it('makes one still for requests that come together', async () => {
      const ready = job();
      await makeExport();

      const answers = await Promise.all([still(ready.id), still(ready.id), still(ready.id)]);

      expect(answers.map((res) => res.status)).toEqual([200, 200, 200]);
      const bodies = await Promise.all(
        answers.map(async (res) => Buffer.from(await res.arrayBuffer())),
      );
      expect(new Set(bodies.map((body) => body.toString('base64'))).size).toBe(1);
    });
  });
});
