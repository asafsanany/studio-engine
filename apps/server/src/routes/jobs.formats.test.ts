import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Job, jobStage } from '@studio/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { createRecordDelivery } from '../deliveries/deliveries.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Formats (GN7): a ready job with two formats has two exports. It is still one job: downloading
// without a choice gives the main file as ever, `?format=<id>` gives that format's file, deleting
// the job deletes every file, and Deliveries count it once.

const MAIN = Buffer.from('the 9:16 video');
const SQUARE = Buffer.from('the 1:1 video, a little shorter');

let base: string;
let exportsDir: string;
let inboxPath: string;
const opened: StudioDb[] = [];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'studio-jobs-formats-'));
  exportsDir = join(base, 'exports');
  inboxPath = join(base, 'inbox');
});

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function put(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function setup() {
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const recordDelivery = createRecordDelivery({
    deliveries,
    jobs,
    priceFor: () => ({ price: 40, currency: 'ILS' }),
    clock,
  });
  const app = createApp({
    jobs: {
      jobs,
      exportsDir,
      inboxPath,
      worker: { cancel: async () => null, notify: () => {} },
    },
  });

  /** A job that went through the whole loop with the formats it was given, and has its files. */
  function ready(name: string, canvases: string[] | null): Job {
    const { job } = jobs.upsertFromScan(makeScan('Pinewood', name));
    if (canvases !== null) jobs.setFormats(job.id, canvases);
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    jobs.applyTransition(job.id, { type: 'START' });
    const main = `Pinewood/${name}.mp4`;
    const square = `Pinewood/${name} (1x1).mp4`;
    put(join(exportsDir, main), MAIN);
    const two = canvases !== null && canvases.length > 1;
    if (two) put(join(exportsDir, square), SQUARE);
    return jobs.applyTransition(job.id, {
      type: 'SUCCEED',
      output: {
        fileName: main,
        durationSec: 35,
        width: 1080,
        height: 1920,
        sizeBytes: MAIN.length,
        ...(two
          ? {
              outputs: [
                { format: '9x16', fileName: main, bytes: MAIN.length },
                { format: '1x1', fileName: square, bytes: SQUARE.length },
              ],
            }
          : {}),
      },
    });
  }

  return { db, jobs, app, deliveries, recordDelivery, ready };
}

const bodyOf = async (res: Response): Promise<string> =>
  Buffer.from(await res.arrayBuffer()).toString();

describe('GET /api/jobs/:id/download', () => {
  it('gives the main file without a choice, as ever, named <Job>.mp4', async () => {
    const t = setup();
    const job = t.ready('97 Window Ad', ['1080x1920', '1080x1080']);
    const res = await t.app.request(`/api/jobs/${job.id}/download`);
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toBe(MAIN.toString());
    expect(res.headers.get('content-disposition')).toContain('97 Window Ad.mp4');
  });

  it('gives a format’s file with ?format=<id>, the extra one named <Job> (1x1).mp4', async () => {
    const t = setup();
    const job = t.ready('Window Ad two', ['1080x1920', '1080x1080']);

    const square = await t.app.request(`/api/jobs/${job.id}/download?format=1x1`);
    expect(square.status).toBe(200);
    expect(await bodyOf(square)).toBe(SQUARE.toString());
    expect(decodeURIComponent(square.headers.get('content-disposition') ?? '')).toContain(
      'Window Ad two (1x1).mp4',
    );

    const main = await t.app.request(`/api/jobs/${job.id}/download?format=9x16`);
    expect(await bodyOf(main)).toBe(MAIN.toString());
    expect(decodeURIComponent(main.headers.get('content-disposition') ?? '')).toContain(
      'Window Ad two.mp4',
    );
  });

  it('supports byte ranges and HEAD on a format’s file', async () => {
    const t = setup();
    const job = t.ready('Window Ad three', ['1080x1920', '1080x1080']);
    const ranged = await t.app.request(`/api/jobs/${job.id}/download?format=1x1`, {
      headers: { Range: 'bytes=0-6' },
    });
    expect(ranged.status).toBe(206);
    expect(await bodyOf(ranged)).toBe('the 1:1');
    const head = await t.app.request(`/api/jobs/${job.id}/download?format=1x1`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(SQUARE.length));
  });

  it('answers 404 for a format the job does not have, and for any format of a job with one', async () => {
    const t = setup();
    const two = t.ready('Window Ad four', ['1080x1920', '1080x1080']);
    const one = t.ready('One format', null);
    for (const [job, format] of [
      [two, '4x5'],
      [one, '1x1'],
      [one, '9x16'],
    ] as const) {
      const res = await t.app.request(`/api/jobs/${job.id}/download?format=${format}`);
      expect(res.status, `${job.name} ${format}`).toBe(404);
      expect(await res.json()).toEqual({ error: 'This job has no export in that format.' });
    }
    // The job with one format still downloads exactly as before.
    expect(await bodyOf(await t.app.request(`/api/jobs/${one.id}/download`))).toBe(MAIN.toString());
  });
});

describe('DELETE /api/jobs/:id', () => {
  it('deletes every export of a job with two formats', async () => {
    const t = setup();
    const job = t.ready('Doomed', ['1080x1920', '1080x1080']);
    const files = [
      join(exportsDir, 'Pinewood', 'Doomed.mp4'),
      join(exportsDir, 'Pinewood', 'Doomed (1x1).mp4'),
    ];
    for (const file of files) expect(existsSync(file)).toBe(true);

    const res = await t.app.request(`/api/jobs/${job.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    for (const file of files) expect(existsSync(file), file).toBe(false);
    expect(t.jobs.get(job.id)).toBeNull();
  });
});

describe('one job, whatever its formats', () => {
  it('is delivered once: one delivery, one stage, the money of one video', () => {
    const t = setup();
    const job = t.ready('Delivered once', ['1080x1920', '1080x1080']);
    expect(jobStage(job)).toBe('approved');

    expect(t.recordDelivery(job)).toBe(true);
    // A second call, even with the extra files, writes nothing new.
    expect(t.recordDelivery(t.jobs.get(job.id) as Job)).toBe(false);

    expect(t.deliveries.list()).toHaveLength(1);
    expect(t.deliveries.get(job.id)).toMatchObject({ price: 40, currency: 'ILS' });
    expect(jobStage(t.jobs.get(job.id) as Job)).toBe('delivered');
  });

  it('keeps the main file as the job’s output: its length and size are the main video’s, not a sum', () => {
    const t = setup();
    const job = t.ready('Not a sum', ['1080x1920', '1080x1080']);
    expect(job.output?.durationSec).toBe(35);
    expect(job.output?.sizeBytes).toBe(MAIN.length);
    expect(job.output?.fileName).toBe(job.output?.outputs?.[0]?.fileName);
    expect(job.output?.outputs).toHaveLength(2);
  });
});
