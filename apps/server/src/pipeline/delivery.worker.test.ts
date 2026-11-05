import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Job, type JobOutput, jobStage, SETTLE_MS } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeliveryRepository,
  JobRepository,
  StepRunRepository,
  type StudioDb,
} from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { BriefStep } from './brief-step.js';
import { FakeBriefWriter } from './fake-brief.js';
import { FakeRunner } from './fake-runner.js';
import { QueueWorker } from './worker.js';

// CVP-171: a job that reaches Ready is only Approved. The queue worker writes no delivery then:
// a delivery is recorded when the owner marks the job delivered (the deliver route, M12). The real queue
// worker drives the fake Brief step and the fake runner on a real job folder with an in-memory
// database and a stub export.

const OUTPUT: JobOutput = {
  fileName: 'Acme/Teaser.mp4',
  durationSec: 0.5,
  width: 360,
  height: 640,
  sizeBytes: 1_000,
};

const temps: string[] = [];
const opened: StudioDb[] = [];
const workers: QueueWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup({ review }: { review?: boolean } = {}) {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-delivery-worker-'));
  temps.push(inbox);
  const jobDir = join(inbox, 'Acme', 'Teaser');
  mkdirSync(jobDir, { recursive: true });
  for (const file of ['clip-01.mp4', 'clip-02.mp4', 'voice.m4a'])
    writeFileSync(join(jobDir, file), '');

  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock, review });
  const stepRuns = new StepRunRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const worker = new QueueWorker({
    jobs,
    stepRuns,
    runner: new FakeRunner({ inboxPath: inbox, speed: 100_000, clipSeconds: 0.5, review }),
    brief: new BriefStep({ inboxPath: inbox, writer: new FakeBriefWriter({ speed: 100_000 }) }),
    finalize: async () => OUTPUT,
    review,
    logger,
  });
  workers.push(worker);

  // A folder was dropped in the inbox and has settled: the job is queued.
  const { job } = jobs.upsertFromScan(makeScan('Acme', 'Teaser'));
  clock.tick(SETTLE_MS);
  jobs.applyTransition(job.id, { type: 'SETTLED' });

  const get = (): Job => {
    const current = jobs.get(job.id);
    if (current === null) throw new Error('the job is gone');
    return current;
  };
  /** Wakes the worker and waits for the next run to end. */
  const runNext = async (): Promise<void> => {
    worker.notify();
    await worker.idle();
  };

  return { jobDir, jobs, deliveries, clock, logger, worker, job, get, runNext };
}

describe('a job that reaches Ready is Approved, not delivered', () => {
  it('writes no delivery, and the job carries none: its stage is approved', async () => {
    const { worker, get, deliveries } = setup();

    worker.start();
    await worker.idle();

    expect(get().state).toBe('ready');
    expect(get().delivery).toBeNull();
    expect(jobStage(get())).toBe('approved');
    expect(deliveries.list()).toEqual([]);
  });

  it('writes none when the edit ends in Review, nor when the render is ready after Approve', async () => {
    const { worker, get, jobs, job, deliveries, clock, runNext } = setup({ review: true });

    worker.start();
    await worker.idle();
    expect(get().state).toBe('review');
    expect(deliveries.list()).toEqual([]);

    jobs.addReviewSec(job.id, 15);
    clock.tick(60_000);
    jobs.applyTransition(job.id, { type: 'APPROVE' });
    await runNext();

    expect(get()).toMatchObject({ state: 'ready', runKind: 'render' });
    expect(jobStage(get())).toBe('approved');
    expect(deliveries.list()).toEqual([]);
  });

  it('writes none when a failed job is retried and gets to ready', async () => {
    const { worker, get, jobs, jobDir, job, deliveries, clock, runNext } = setup();
    const marker = join(jobDir, '.fail-at-render');
    writeFileSync(marker, '');

    worker.start();
    await worker.idle();
    expect(get().state).toBe('failed');

    rmSync(marker);
    clock.tick(60_000);
    jobs.applyTransition(job.id, { type: 'RETRY' });
    await runNext();

    expect(get().state).toBe('ready');
    expect(deliveries.list()).toEqual([]);
  });

  it('keeps the delivery the owner recorded when the job leaves ready and gets there again', async () => {
    const { worker, get, jobs, job, deliveries, clock, runNext } = setup();
    worker.start();
    await worker.idle();
    expect(get().state).toBe('ready');

    // The owner marks it delivered (what the deliver route will do), and later the export goes missing.
    deliveries.record({
      jobId: job.id,
      clientId: job.clientId,
      client: 'Acme',
      name: 'Teaser',
      relPath: 'Acme/Teaser',
      deliveredAt: clock().getTime(),
      price: 40,
      currency: 'ILS',
    });
    const first = deliveries.get(job.id);
    expect(jobStage(get())).toBe('delivered');

    clock.tick(3_600_000);
    jobs.applyTransition(job.id, { type: 'EXPORT_MISSING' });
    expect(get().state).toBe('failed');
    expect(jobStage(get())).toBeNull();
    expect(get().delivery).toMatchObject({ price: 40 });

    jobs.applyTransition(job.id, { type: 'RETRY' });
    await runNext();

    expect(get().state).toBe('ready');
    expect(jobStage(get())).toBe('delivered');
    expect(deliveries.list()).toEqual([first]);
  });
});
