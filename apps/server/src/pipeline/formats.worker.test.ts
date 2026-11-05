import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Job, jobOutputSchema, SETTLE_MS } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRepository, StepRunRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { BriefStep } from './brief-step.js';
import { FakeBriefWriter } from './fake-brief.js';
import { resolveFfmpeg } from './fake-media.js';
import { FakeRunner } from './fake-runner.js';
import { createFinalize } from './finalize.js';
import { readPreview } from './preview-composition.js';
import { QueueWorker } from './worker.js';

// Formats (GN7), end to end in one process: the real queue worker drives the fake Brief step (a
// note that names two sizes asks for two formats) and the fake runner on a real job folder, with the
// real export, an in-memory database and the Review switch on.
//
//   edit -> Review (two compositions) -> revise (both kept in step) -> approve -> render -> Ready
//   (two videos, two exports)

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;

const temps: string[] = [];
const opened: StudioDb[] = [];
const workers: QueueWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(note: string | null) {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-formats-loop-'));
  temps.push(inbox);
  const jobDir = join(inbox, 'Pinewood', 'Window Ad');
  mkdirSync(jobDir, { recursive: true });
  for (const file of ['clip-01.mp4', 'voice.m4a']) writeFileSync(join(jobDir, file), '');
  const exportsDir = join(inbox, '_Exports');
  const editDir = join(jobDir, 'edit');

  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock, review: true });
  const speed = 100_000;
  const worker = new QueueWorker({
    jobs,
    stepRuns: new StepRunRepository(db, { clock }),
    runner: new FakeRunner({ inboxPath: inbox, speed, clipSeconds: 0.5, review: true }),
    brief: new BriefStep({ inboxPath: inbox, writer: new FakeBriefWriter({ speed }) }),
    finalize: createFinalize({ inboxPath: inbox, exportsDir }),
    review: true,
  });
  workers.push(worker);

  const { job } = jobs.upsertFromScan(makeScan('Pinewood', 'Window Ad'));
  if (note !== null) jobs.setNote(job.id, note);
  clock.tick(SETTLE_MS);
  jobs.applyTransition(job.id, { type: 'SETTLED' });

  const get = (): Job => {
    const current = jobs.get(job.id);
    if (current === null) throw new Error('the job is gone');
    return current;
  };
  const index = (dir: string): string => readFileSync(join(editDir, dir, 'index.html'), 'utf8');

  async function editToReview(): Promise<void> {
    worker.start();
    await worker.idle();
  }
  async function runNext(): Promise<void> {
    worker.notify();
    await worker.idle();
  }
  const writeRound = (round: number): void => {
    mkdirSync(join(editDir, 'review'), { recursive: true });
    writeFileSync(
      join(editDir, 'review', `round-${round}.md`),
      '# Round\n\n- 0:02.4 (text): make the type bigger\n',
    );
  };

  return {
    jobDir,
    editDir,
    exportsDir,
    jobs,
    job,
    get,
    index,
    editToReview,
    runNext,
    writeRound,
    sendNotes: () => jobs.applyTransition(job.id, { type: 'SEND_NOTES' }),
    approve: () => jobs.applyTransition(job.id, { type: 'APPROVE' }),
  };
}

describe.skipIf(!haveTools)('a job whose note asks for 9:16 and 1:1', () => {
  const NOTE = 'deliver 9:16 and 1:1';

  it('keeps both formats from the brief and ends in Review with a composition for each', async () => {
    const t = setup(NOTE);
    await t.editToReview();

    const job = t.get();
    expect(job.state).toBe('review');
    expect(job.formats?.map((format) => [format.id, format.width, format.height])).toEqual([
      ['9x16', 1080, 1920],
      ['1x1', 1080, 1080],
    ]);
    expect(job.preview).toEqual({ durationSec: 6, width: 1080, height: 1920 });
    // The same cut at two sizes, the brief names them, and the real reader accepts both.
    expect(t.index('preview')).toContain('data-height="1920"');
    expect(t.index('preview-1x1')).toContain('data-width="1080" data-height="1080"');
    expect((await readPreview(t.jobDir, job.formats)).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(t.editDir, 'brief.json'), 'utf8')).formats).toEqual([
      '1080x1920',
      '1080x1080',
    ]);
    expect(existsSync(join(t.editDir, 'final.mp4'))).toBe(false);
  });

  it('a revise round rewrites both compositions', async () => {
    const t = setup(NOTE);
    await t.editToReview();
    t.writeRound(1);
    t.sendNotes();
    await t.runNext();

    expect(t.get()).toMatchObject({ state: 'review', round: 1 });
    expect(t.index('preview')).toContain('>Round 1<');
    expect(t.index('preview-1x1')).toContain('>Round 1<');
    expect(t.index('preview-1x1')).toContain('data-height="1080"');
    expect(t.get().formats).toHaveLength(2);
  });

  it('Approve renders both and exports <Job>.mp4 and <Job> (1x1).mp4, still one job', async () => {
    const t = setup(NOTE);
    await t.editToReview();
    t.approve();
    await t.runNext();

    const ready = t.get();
    expect(ready).toMatchObject({ state: 'ready', runKind: 'render' });
    expect(existsSync(join(t.editDir, 'final.mp4'))).toBe(true);
    expect(existsSync(join(t.editDir, 'final-1x1.mp4'))).toBe(true);
    expect(ready.output?.fileName).toBe('Pinewood/Window Ad.mp4');
    expect(ready.output?.outputs).toEqual([
      expect.objectContaining({ format: '9x16', fileName: 'Pinewood/Window Ad.mp4' }),
      expect.objectContaining({ format: '1x1', fileName: 'Pinewood/Window Ad (1x1).mp4' }),
    ]);
    expect(jobOutputSchema.safeParse(ready.output).success).toBe(true);
    for (const file of ['Window Ad.mp4', 'Window Ad (1x1).mp4']) {
      expect(existsSync(join(t.exportsDir, 'Pinewood', file)), file).toBe(true);
    }
    expect(t.jobs.getAll()).toHaveLength(1);
  });
});

describe.skipIf(!haveTools)('a job whose note asks for one format or none', () => {
  it.each([null, 'make it 9:16', 'keep it under 30 seconds'])(
    'behaves as it always did (note %j)',
    async (note) => {
      const t = setup(note);
      await t.editToReview();

      const reviewed = t.get();
      expect(reviewed.state).toBe('review');
      expect(reviewed).not.toHaveProperty('formats');
      expect(existsSync(join(t.editDir, 'preview', 'index.html'))).toBe(true);
      expect(existsSync(join(t.editDir, 'preview-1x1'))).toBe(false);

      t.approve();
      await t.runNext();
      const ready = t.get();
      expect(ready.state).toBe('ready');
      expect(ready.output).not.toHaveProperty('outputs');
      expect(existsSync(join(t.editDir, 'final-1x1.mp4'))).toBe(false);
      expect(existsSync(join(t.exportsDir, 'Pinewood', 'Window Ad (1x1).mp4'))).toBe(false);
      expect(existsSync(join(t.exportsDir, 'Pinewood', 'Window Ad.mp4'))).toBe(true);
    },
  );
});
