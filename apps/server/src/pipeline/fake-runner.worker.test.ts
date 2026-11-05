import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefSchema, type Job, type JobOutput, SETTLE_MS, type StepId } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRepository, StepRunRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { BriefStep } from './brief-step.js';
import { FakeBriefWriter } from './fake-brief.js';
import { FakeRunner } from './fake-runner.js';
import { QueueWorker } from './worker.js';

// The in-process half of E7's acceptance: the real queue worker (E2) drives the fake Brief step
// (B4) and the fake runner on a real job folder, with an in-memory database and a stub export.
// Dropping a folder into the inbox is the watcher's job (W2/W3) and the boot wiring's (A1); from
// "queued" on, it is this.

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

interface SetupOptions {
  speed?: number;
  /** The Review switch, handed to the repository, the worker and the fake runner. */
  review?: boolean;
}

function setup({ speed = 100_000, review }: SetupOptions = {}) {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-fake-worker-'));
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

  // The export stub checks what E6 relies on: the runner said "ok", so final.mp4 is there.
  const finalize = vi.fn(async (job: Job): Promise<JobOutput> => {
    expect(existsSync(join(jobDir, 'edit', 'final.mp4')), `final.mp4 of ${job.relPath}`).toBe(true);
    return OUTPUT;
  });

  const seen: Job[] = [];
  const worker = new QueueWorker({
    jobs,
    stepRuns,
    runner: new FakeRunner({ inboxPath: inbox, speed, clipSeconds: 0.5, review }),
    brief: new BriefStep({ inboxPath: inbox, writer: new FakeBriefWriter({ speed }) }),
    finalize,
    review,
    onJobChanged: (job) => seen.push(job),
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
  const stepsSeen = (): StepId[] => [
    ...new Set(seen.map((j) => j.step).filter((s): s is StepId => s !== null)),
  ];

  return { jobDir, jobs, worker, finalize, seen, job, get, stepsSeen };
}

// W2 (CVP-108): the repository, the worker and the fake runner with the Review switch on.
describe('QueueWorker with the FakeRunner and the Review switch on', () => {
  const SAMPLE = { durationSec: 6, width: 1080, height: 1920 };

  it('takes a queued job through steps 1 to 7 to Review with the sample preview, and exports nothing', async () => {
    const { worker, get, finalize, seen, stepsSeen, jobDir } = setup({ review: true });
    expect(get().state).toBe('queued');

    worker.start();
    await worker.idle();

    expect(get()).toMatchObject({
      state: 'review',
      step: 7,
      runKind: 'edit',
      preview: SAMPLE,
      output: null,
      error: null,
      subProgress: null,
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(stepsSeen()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(seen.at(-1)?.state).toBe('review');
    expect(existsSync(join(jobDir, 'edit', 'preview', 'index.html'))).toBe(true);
    expect(existsSync(join(jobDir, 'edit', 'final.mp4'))).toBe(false);
    expect(existsSync(join(jobDir, 'edit', 'preview.mp4'))).toBe(false);
  });

  it('fails at Preview with .fail-at-preview, and reaches Review after the marker is removed and Retry', async () => {
    const { worker, get, jobs, jobDir, job, finalize } = setup({ review: true });
    const marker = join(jobDir, '.fail-at-preview');
    writeFileSync(marker, '');

    worker.start();
    await worker.idle();
    expect(get()).toMatchObject({
      state: 'failed',
      failedAt: 6,
      error: 'Preview failed: injected failure (.fail-at-preview)',
    });

    rmSync(marker);
    jobs.applyTransition(job.id, { type: 'RETRY' });
    worker.notify();
    await worker.idle();

    expect(get()).toMatchObject({ state: 'review', step: 7, preview: SAMPLE, error: null });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('does nothing at .fail-at-render: an edit run has no Render', async () => {
    const { worker, get, jobDir } = setup({ review: true });
    writeFileSync(join(jobDir, '.fail-at-render'), '');

    worker.start();
    await worker.idle();

    expect(get().state).toBe('review');
  });
});

describe('QueueWorker with the FakeRunner', () => {
  it('takes a queued job through all 8 steps to ready', async () => {
    const { worker, get, finalize, seen, stepsSeen } = setup();
    expect(get().state).toBe('queued');

    worker.start();
    await worker.idle();

    expect(get()).toMatchObject({ state: 'ready', output: OUTPUT, error: null });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(stepsSeen()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seen.map((job) => job.state)).toContain('editing');
    expect(seen.at(-1)?.state).toBe('ready');
    // The sub-progress text reached the job too, the Brief run's first.
    const subs = seen.map((job) => job.subProgress).filter((sub) => sub !== null);
    expect(subs[0]).toBe('reading 1 file');
    expect(subs).toEqual(
      expect.arrayContaining(['1/3', '3/3', 'graphics 2/3', 'pass 1/3', 'pass 3/3']),
    );
  });

  it('writes edit/brief.json and edit/brief.md before the edit, and reuses them on a retry', async () => {
    const { worker, get, jobs, jobDir, job } = setup();
    writeFileSync(join(jobDir, '.fail-at-plan'), '');
    worker.start();
    await worker.idle();
    expect(get()).toMatchObject({ state: 'failed', failedAt: 4 });

    const brief = briefSchema.parse(
      JSON.parse(readFileSync(join(jobDir, 'edit', 'brief.json'), 'utf8')),
    );
    expect(brief.files.map((file) => file.path)).toEqual([
      'clip-01.mp4',
      'clip-02.mp4',
      'voice.m4a',
    ]);
    expect(readFileSync(join(jobDir, 'edit', 'brief.md'), 'utf8')).toMatch(
      /^# Brief: Teaser \(Acme\)\n/,
    );
    expect(existsSync(join(jobDir, 'edit', 'brief', 'transcripts', 'voice.json'))).toBe(true);
    const written = readFileSync(join(jobDir, 'edit', 'brief.json'), 'utf8');

    rmSync(join(jobDir, '.fail-at-plan'));
    jobs.applyTransition(job.id, { type: 'RETRY' });
    worker.notify();
    await worker.idle();

    expect(get()).toMatchObject({ state: 'ready' });
    // Nothing the brief is about changed (the marker is a dotfile): the same brief.
    expect(readFileSync(join(jobDir, 'edit', 'brief.json'), 'utf8')).toBe(written);
  });

  it('fails at Brief with .fail-at-brief, and finishes after the marker is removed and Retry', async () => {
    const { worker, get, jobs, jobDir, job, finalize, stepsSeen } = setup();
    const marker = join(jobDir, '.fail-at-brief');
    writeFileSync(marker, '');

    worker.start();
    await worker.idle();

    expect(get()).toMatchObject({
      state: 'failed',
      failedAt: 1,
      error: 'Brief failed: injected failure (.fail-at-brief)',
    });
    expect(stepsSeen()).toEqual([1]);
    expect(existsSync(join(jobDir, 'edit', 'brief.json'))).toBe(false);

    rmSync(marker);
    jobs.applyTransition(job.id, { type: 'RETRY' });
    worker.notify();
    await worker.idle();

    expect(get()).toMatchObject({ state: 'ready', output: OUTPUT, error: null });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(existsSync(join(jobDir, 'edit', 'brief.md'))).toBe(true);
  });

  it('fails at Render with .fail-at-render, and finishes after the marker is removed and Retry', async () => {
    const { worker, get, jobs, jobDir, job, finalize, stepsSeen } = setup();
    const marker = join(jobDir, '.fail-at-render');
    writeFileSync(marker, '');

    worker.start();
    await worker.idle();

    expect(get()).toMatchObject({
      state: 'failed',
      failedAt: 8,
      error: 'Render failed: injected failure (.fail-at-render)',
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(existsSync(join(jobDir, 'edit', 'final.mp4'))).toBe(false);
    expect(stepsSeen()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Retry with the marker still there fails again, at Render.
    jobs.applyTransition(job.id, { type: 'RETRY' });
    worker.notify();
    await worker.idle();
    expect(get()).toMatchObject({ state: 'failed', failedAt: 8 });

    rmSync(marker);
    jobs.applyTransition(job.id, { type: 'RETRY' });
    worker.notify();
    await worker.idle();

    expect(get()).toMatchObject({ state: 'ready', output: OUTPUT, error: null });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('is cancelled quickly at the real pace during the Brief run, at step 1', async () => {
    const { worker, get, job, finalize } = setup({ speed: 1 });

    worker.start();
    await vi.waitFor(
      () =>
        expect(get()).toMatchObject({ state: 'editing', step: 1, subProgress: 'reading 1 file' }),
      { timeout: 5_000 },
    );

    const startedAt = Date.now();
    const cancelled = await worker.cancel(job.id);

    expect(cancelled?.state).toBe('cancelled');
    expect(get()).toMatchObject({ state: 'cancelled', stoppedAt: 1 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(worker.activeJobId).toBeNull();
    expect(finalize).not.toHaveBeenCalled();
  });
});
