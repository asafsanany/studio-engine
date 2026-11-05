import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Job, renderRoundFile, SETTLE_MS, type StepId } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRepository, StepRunRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { BriefStep } from './brief-step.js';
import { FakeBriefWriter } from './fake-brief.js';
import { FakeRunner } from './fake-runner.js';
import { createFinalize } from './finalize.js';
import { QueueWorker } from './worker.js';

// The whole Review loop in one process (W3, CVP-110): the real queue worker drives the fake Brief
// step and the fake runner on a real job folder, with the real export, an in-memory database and
// the Review switch on. Send notes and Approve go straight through the repository, as the routes
// do (W5's guards and round file live in the routes; the tests write the round files themselves).
//
//   edit -> Review -> SEND_NOTES -> revise -> Review (round 1) -> APPROVE -> render -> Ready

const PREVIEW = { durationSec: 6, width: 1080, height: 1920 };

/** W16's golden round file: three notes, at 0:02.4, 0:07.8 and 0:15.6. */
const BAKERY_ROUND_1 = fileURLToPath(
  new URL('../../../../packages/shared/src/review/fixtures/bakery-round-1.md', import.meta.url),
);

const temps: string[] = [];
const opened: StudioDb[] = [];
const workers: QueueWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup({ speed = 100_000 } = {}) {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-review-loop-'));
  temps.push(inbox);
  const jobDir = join(inbox, 'Acme', 'Teaser');
  mkdirSync(jobDir, { recursive: true });
  for (const file of ['clip-01.mp4', 'clip-02.mp4', 'voice.m4a'])
    writeFileSync(join(jobDir, file), '');
  const exportsDir = join(inbox, '_Exports');
  const editDir = join(jobDir, 'edit');

  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock, review: true });
  const stepRuns = new StepRunRepository(db, { clock });

  const seen: Job[] = [];
  const worker = new QueueWorker({
    jobs,
    stepRuns,
    runner: new FakeRunner({ inboxPath: inbox, speed, clipSeconds: 0.5, review: true }),
    brief: new BriefStep({ inboxPath: inbox, writer: new FakeBriefWriter({ speed }) }),
    finalize: createFinalize({ inboxPath: inbox, exportsDir }),
    review: true,
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
  /** The distinct steps the worker published since `mark` (a `seen.length` taken earlier), in order. */
  const stepsSince = (mark: number): StepId[] => [
    ...new Set(
      seen
        .slice(mark)
        .map((j) => j.step)
        .filter((s): s is StepId => s !== null),
    ),
  ];

  const index = (): string => readFileSync(join(editDir, 'preview', 'index.html'), 'utf8');
  const project = (): string => readFileSync(join(editDir, 'project.md'), 'utf8');

  /** The next run: wakes the worker and waits for it to finish. Returns the steps it published. */
  async function runNext(): Promise<StepId[]> {
    const mark = seen.length;
    worker.notify();
    await worker.idle();
    return stepsSince(mark);
  }

  /** Writes edit/review/round-N.md the way Send does (here from a fixture or `text`). */
  function writeRoundFile(round: number, text?: string): void {
    mkdirSync(join(editDir, 'review'), { recursive: true });
    const target = join(editDir, 'review', `round-${round}.md`);
    if (text === undefined) copyFileSync(BAKERY_ROUND_1, target);
    else writeFileSync(target, text, 'utf8');
  }

  const sendNotes = (): Job => jobs.applyTransition(job.id, { type: 'SEND_NOTES' });
  const approve = (): Job => jobs.applyTransition(job.id, { type: 'APPROVE' });

  /** The edit run, to Review. */
  async function editToReview(): Promise<StepId[]> {
    worker.start();
    const mark = seen.length;
    await worker.idle();
    return stepsSince(mark);
  }

  const runs = (kind: string, step: number): number =>
    (
      db.sqlite
        .prepare('select count(*) as n from step_runs where run_kind = ? and step = ?')
        .get(kind, step) as { n: number }
    ).n;

  return {
    inbox,
    jobDir,
    editDir,
    exportsDir,
    db,
    jobs,
    stepRuns,
    worker,
    job,
    get,
    seen,
    index,
    project,
    runNext,
    writeRoundFile,
    sendNotes,
    approve,
    editToReview,
    runs,
  };
}

describe('the Review loop, in process (the Review switch on)', () => {
  it('edit → Review → send notes → revise → Review at round 1 → approve → render → Ready, with the export', async () => {
    const ctx = setup();

    // 1. The edit run ends in Review with the sample composition and no final video.
    const editSteps = await ctx.editToReview();
    expect(ctx.get()).toMatchObject({
      state: 'review',
      runKind: 'edit',
      round: 0,
      step: 7,
      preview: PREVIEW,
      output: null,
    });
    expect(editSteps).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ctx.index()).toContain('>Teaser<');
    expect(existsSync(join(ctx.editDir, 'final.mp4'))).toBe(false);
    const briefJson = readFileSync(join(ctx.editDir, 'brief.json'), 'utf8');

    // 2. Send notes: a revise run applies the round file and the job is back in Review.
    ctx.writeRoundFile(1);
    expect(ctx.sendNotes()).toMatchObject({ state: 'queued', runKind: 'revise', round: 1 });
    const reviseSteps = await ctx.runNext();
    expect(ctx.get()).toMatchObject({
      state: 'review',
      runKind: 'revise',
      round: 1,
      step: 7,
      preview: PREVIEW,
      output: null,
    });
    expect(reviseSteps).toEqual([4, 5, 6, 7]);
    expect(ctx.index().match(/>Round 1</g)).toHaveLength(2);
    expect(ctx.index()).not.toContain('>Teaser<');
    expect(ctx.project()).toContain(
      [
        '## Round 1',
        '',
        '- 0:02.4: done as asked (fake revise).',
        '- 0:07.8: done as asked (fake revise).',
        '- 0:15.6: done as asked (fake revise).',
        '',
      ].join('\n'),
    );
    // The Brief did not run again.
    expect(readFileSync(join(ctx.editDir, 'brief.json'), 'utf8')).toBe(briefJson);
    expect(existsSync(join(ctx.editDir, 'final.mp4'))).toBe(false);

    // 3. Approve: a render run writes final.mp4 and the worker exports it.
    const approved = ctx.approve();
    expect(approved).toMatchObject({ state: 'queued', runKind: 'render', round: 1 });
    const renderSteps = await ctx.runNext();
    const ready = ctx.get();
    expect(ready).toMatchObject({
      state: 'ready',
      runKind: 'render',
      round: 1,
      step: 8,
      output: { fileName: 'Acme/Teaser.mp4' },
    });
    expect(ready.approvedAt).not.toBeNull();
    expect(renderSteps).toEqual([8]);
    expect(existsSync(join(ctx.exportsDir, 'Acme', 'Teaser.mp4'))).toBe(true);
    expect(existsSync(join(ctx.editDir, 'final.mp4'))).toBe(true);

    // 4. The timings are stored under the kind of run that took them.
    expect(ctx.runs('revise', 4)).toBe(1);
    expect(ctx.runs('render', 8)).toBe(1);
    expect(ctx.runs('edit', 8)).toBe(0);
    expect(ctx.runs('revise', 2)).toBe(0);
    expect(ctx.stepRuns.recentFinishedRuns('edit', 10)[0]?.steps).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ctx.stepRuns.recentFinishedRuns('revise', 10)[0]?.steps).toEqual([4, 5, 6, 7]);
    expect(ctx.stepRuns.recentFinishedRuns('render', 10)[0]?.steps).toEqual([8]);
  });

  it('two rounds: each adds its section to project.md and retitles the composition', async () => {
    const ctx = setup();
    await ctx.editToReview();

    ctx.writeRoundFile(1);
    ctx.sendNotes();
    await ctx.runNext();
    expect(ctx.get()).toMatchObject({ state: 'review', round: 1 });

    ctx.writeRoundFile(
      2,
      renderRoundFile({
        job: 'Teaser',
        client: 'Acme',
        round: 2,
        notes: [{ atSec: 3.2, kind: 'text', text: 'עוד שנייה על הלוגו' }],
      }),
    );
    expect(ctx.sendNotes()).toMatchObject({ state: 'queued', runKind: 'revise', round: 2 });
    const steps = await ctx.runNext();

    expect(ctx.get()).toMatchObject({ state: 'review', runKind: 'revise', round: 2, step: 7 });
    expect(steps).toEqual([4, 5, 6, 7]);
    expect(ctx.index().match(/>Round 2</g)).toHaveLength(2);
    expect(ctx.index()).not.toContain('>Round 1<');
    expect(ctx.project()).toContain('## Round 1\n');
    expect(ctx.project()).toContain('## Round 2\n\n- 0:03.2: done as asked (fake revise).\n');
    expect(ctx.project().match(/^## Round \d$/gm)).toEqual(['## Round 1', '## Round 2']);
    // Two revise runs of Plan, one per round.
    expect(ctx.runs('revise', 4)).toBe(2);
  });

  it('send notes without a round file fails at Plan (4); Retry after the file is written reaches Review', async () => {
    const ctx = setup();
    await ctx.editToReview();

    ctx.sendNotes();
    await ctx.runNext();
    expect(ctx.get()).toMatchObject({
      state: 'failed',
      failedAt: 4,
      error: 'Plan failed: edit/review/round-1.md is missing',
      runKind: 'revise',
      round: 1,
    });
    // The composition of the edit is as it was.
    expect(ctx.index()).toContain('>Teaser<');

    ctx.writeRoundFile(1);
    ctx.jobs.applyTransition(ctx.job.id, { type: 'RETRY' });
    const steps = await ctx.runNext();

    expect(ctx.get()).toMatchObject({
      state: 'review',
      runKind: 'revise',
      round: 1,
      step: 7,
      error: null,
    });
    expect(steps[0]).toBe(4);
    expect(ctx.index().match(/>Round 1</g)).toHaveLength(2);
    expect(ctx.project().match(/^## Round 1$/gm)).toHaveLength(1);
  });

  it('.fail-at-render fails the render run at Render (8); Retry after removing it exports', async () => {
    const ctx = setup();
    await ctx.editToReview();
    ctx.writeRoundFile(1);
    ctx.sendNotes();
    await ctx.runNext();

    const marker = join(ctx.jobDir, '.fail-at-render');
    writeFileSync(marker, '');
    ctx.approve();
    await ctx.runNext();
    expect(ctx.get()).toMatchObject({
      state: 'failed',
      failedAt: 8,
      error: 'Render failed: injected failure (.fail-at-render)',
      runKind: 'render',
    });
    expect(existsSync(join(ctx.exportsDir, 'Acme', 'Teaser.mp4'))).toBe(false);

    // The fake writes no job log, so Retry is a full render run, not a re-export.
    rmSync(marker);
    ctx.jobs.applyTransition(ctx.job.id, { type: 'RETRY' });
    const steps = await ctx.runNext();

    expect(ctx.get()).toMatchObject({
      state: 'ready',
      runKind: 'render',
      output: { fileName: 'Acme/Teaser.mp4' },
      error: null,
    });
    expect(steps).toEqual([8]);
    expect(existsSync(join(ctx.exportsDir, 'Acme', 'Teaser.mp4'))).toBe(true);
  });

  it('approving straight away (no notes) renders the edit’s own composition', async () => {
    const ctx = setup();
    await ctx.editToReview();

    ctx.approve();
    const steps = await ctx.runNext();

    expect(ctx.get()).toMatchObject({ state: 'ready', runKind: 'render', round: 0 });
    expect(steps).toEqual([8]);
    expect(existsSync(join(ctx.exportsDir, 'Acme', 'Teaser.mp4'))).toBe(true);
    expect(ctx.runs('revise', 4)).toBe(0);
  });
});
