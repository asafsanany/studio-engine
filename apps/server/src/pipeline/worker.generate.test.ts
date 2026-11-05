import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type GenerateState, generateErrorMessage, type Job, SETTLE_MS } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GenerateRepository,
  JobRepository,
  StepRunRepository,
  type StudioDb,
} from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { BriefStep } from './brief-step.js';
import { FakeBriefWriter } from './fake-brief.js';
import { FAIL_AT_GENERATE, FAKE_GENERATE_MS, FakeGenerateWriter } from './fake-generate.js';
import { resolveFfmpeg } from './fake-media.js';
import { FakeRunner } from './fake-runner.js';
import { createFinalize } from './finalize.js';
import { GenerateStep } from './generate-step.js';
import { jobLogPath } from './job-log.js';
import type { RunContext, RunMode, Runner, RunOutcome } from './runner.js';
import { GENERATE_TEST_POLL_MS, generatePauses } from './test-utils.js';
import { QueueWorker } from './worker.js';

// Generated videos, GN5, end to end in one process: the real queue worker drives the fake Brief step
// (a folder with a script and no footage is briefed as a generated job), the real Generate step with
// the fake Generate run (the two scripts' fake path, as real processes) and the fake runner on a real
// job folder, with the real export, an in-memory database and the Review switch on.
//
//   Arrived, Brief, Generate, Transcribe ... Review

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;

const PINEWOOD_BRIEF = fileURLToPath(
  new URL('./testdata/pinewood/PINEWOOD brief.txt', import.meta.url),
);

// The pauses the fake Generate run makes before a voice line (the brief has 7) and before a clip (6):
// a test holds the run at one of them to stop it between two steps (see generatePauses).
const VOICE_PAUSE_MS = FAKE_GENERATE_MS.voice / 7;
const CLIP_PAUSE_MS = FAKE_GENERATE_MS.clips / 6;

const temps: string[] = [];
const opened: StudioDb[] = [];
const workers: QueueWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What the runner was told about the run it was given. */
interface Seen {
  mode: RunMode;
  step: number | null;
  transcribeTotal: number | undefined;
}

function spying(inner: Runner, seen: Seen[]): Runner {
  return {
    async start(job: Job, mode: RunMode, context: RunContext): Promise<RunOutcome> {
      seen.push({ mode, step: job.step, transcribeTotal: context.transcribeTotal });
      return inner.start(job, mode, context);
    },
  };
}

function setup(
  options: {
    /** The Generate step is wired (the switch is on). */
    generate?: boolean;
    /** A folder with footage and a note instead of a script. */
    footage?: boolean;
    budgetUsd?: number;
  } = {},
) {
  const { generate = true, footage = false } = options;
  const inbox = mkdtempSync(join(tmpdir(), 'studio-generate-worker-'));
  temps.push(inbox);
  const jobDir = join(inbox, 'Pinewood', 'Window Ad');
  mkdirSync(jobDir, { recursive: true });
  if (footage) {
    writeFileSync(join(jobDir, 'clip-01.mp4'), '');
    writeFileSync(join(jobDir, 'notes.txt'), 'Keep it short.');
  } else {
    copyFileSync(PINEWOOD_BRIEF, join(jobDir, 'PINEWOOD brief.txt'));
    mkdirSync(join(jobDir, 'reference'));
    writeFileSync(join(jobDir, 'reference', 'reference-video-35s.mp4'), '');
  }
  const editDir = join(jobDir, 'edit');
  const exportsDir = join(inbox, '_Exports');
  const logsDir = join(inbox, '_logs');

  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock, review: true, generate: true });
  const generateRepo = new GenerateRepository(db, { clock });
  // The steps are timed on a clock of their own that moves only when the Generate stage tells the page
  // something (a second each time), so how long a step took says whether the stage was inside it,
  // and not how busy the machine was.
  const stepClock = fakeClock();
  const stepRuns = new StepRunRepository(db, { clock: stepClock });
  const pauses = generatePauses();
  const speed = 100_000;
  const seen: Seen[] = [];
  const states: GenerateState[] = [];
  const updates: Job[] = [];

  const step = new GenerateStep({
    inboxPath: inbox,
    repo: generateRepo,
    budgetUsd: options.budgetUsd ?? 3,
    writer: new FakeGenerateWriter({ speed: 1, sleep: pauses.sleep }),
    onChanged: (_id, state) => {
      states.push(state);
      stepClock.tick(1_000);
    },
    pollIntervalMs: GENERATE_TEST_POLL_MS,
  });
  const build = (): QueueWorker => {
    const made = new QueueWorker({
      jobs,
      stepRuns,
      runner: spying(
        new FakeRunner({ inboxPath: inbox, speed, clipSeconds: 0.5, review: true }),
        seen,
      ),
      brief: new BriefStep({
        inboxPath: inbox,
        writer: new FakeBriefWriter({ speed, generate: true }),
        generate: true,
      }),
      ...(generate ? { generate: step } : {}),
      finalize: createFinalize({ inboxPath: inbox, exportsDir }),
      review: true,
      reexport: { inboxPath: inbox, logsDir },
      onJobChanged: (job) => updates.push(job),
    });
    workers.push(made);
    return made;
  };
  const worker = build();

  const { job } = jobs.upsertFromScan(makeScan('Pinewood', 'Window Ad'));
  if (options.budgetUsd !== undefined) jobs.setNote(job.id, `budget $${options.budgetUsd}`);
  clock.tick(SETTLE_MS);
  jobs.applyTransition(job.id, { type: 'SETTLED' });

  const get = (): Job => {
    const current = jobs.get(job.id);
    if (current === null) throw new Error('the job is gone');
    return current;
  };
  return {
    inbox,
    jobDir,
    editDir,
    jobs,
    job,
    get,
    seen,
    states,
    updates,
    stepRuns,
    generateRepo,
    run: async (): Promise<void> => {
      worker.start();
      await worker.idle();
    },
    again: async (): Promise<void> => {
      worker.notify();
      await worker.idle();
    },
    worker,
    build,
    /** Resolves once the fake Generate run waits before its `nth` pause of `ms` (and stays there until aborted). */
    holdAt: pauses.holdAt,
    retry: () => jobs.applyTransition(job.id, { type: 'RETRY' }),
    brokenAt: (marker: string) => writeFileSync(join(jobDir, FAIL_AT_GENERATE), marker),
    fixed: () => rmSync(join(jobDir, FAIL_AT_GENERATE), { force: true }),
    spendEntries: (): number =>
      (
        JSON.parse(readFileSync(join(editDir, 'generate', 'spend.json'), 'utf8')) as {
          entries: unknown[];
        }
      ).entries.length,
    logPath: () => jobLogPath(logsDir, job.id),
  };
}

// The fake run starts the two scripts as real processes: about 1 to 2 s alone, over vitest's 5 s default when a busy full run keeps every core in use (C69).
describe.skipIf(!haveTools)('a generated job through the worker', { timeout: 60_000 }, () => {
  it('goes Arrived, Brief, Generate, Transcribe ... Review, with the row right at each point', async () => {
    const t = setup();

    await t.run();

    const job = t.get();
    expect(job.state).toBe('review');
    expect(job.preview).not.toBeNull();
    // The brief decided it: a script, no footage, both sizes.
    const brief = JSON.parse(readFileSync(join(t.editDir, 'brief.json'), 'utf8'));
    expect(brief).toMatchObject({ production: 'generate', formats: ['1080x1920', '1080x1080'] });
    expect(brief.voiceover.lines).toHaveLength(7);
    // Generate ran between the Brief and the edit, at step 1: the text said so.
    const generateTexts = t.updates
      .filter((update) => update.step === 1 && /^Generate · /.test(update.subProgress ?? ''))
      .map((update) => update.subProgress);
    expect(generateTexts[0]).toBe('Generate · planning the shots');
    expect(generateTexts.some((text) => /^Generate · voice \d\/7$/.test(text ?? ''))).toBe(true);
    expect(generateTexts.some((text) => /^Generate · clips \d\/6 · \$/.test(text ?? ''))).toBe(
      true,
    );
    // ...and then the edit began at step 2 and nothing went back to Generate.
    const firstEdit = t.updates.findIndex((update) => update.step === 2);
    expect(firstEdit).toBeGreaterThan(-1);
    const generateAt = t.updates.flatMap((update, index) =>
      /^Generate · /.test(update.subProgress ?? '') ? [index] : [],
    );
    expect(Math.max(...generateAt)).toBeLessThan(firstEdit);
    // The row: finished, the money from spend.json, below no bar.
    expect(job.generate).toMatchObject({
      phase: 'done',
      counts: {
        voice: { done: 7, total: 7 },
        clips: { done: 6, total: 6 },
        belowBar: 0,
      },
      budgetUsd: 3,
    });
    expect(job.generate?.spendUsd).toBeCloseTo(0.04 + 7 * 0.144, 6);
    expect(t.states.at(-1)).toEqual(job.generate);
    // The edit run read a brief that tells it about the footage.
    expect(readFileSync(join(t.editDir, 'brief.md'), 'utf8')).toContain('## Generated footage');
  });

  it('gives Transcribe one source: the voice', async () => {
    const t = setup();

    await t.run();

    expect(t.seen).toEqual([{ mode: 'start', step: 1, transcribeTotal: 1 }]);
  });

  it('does not time the Generate stage as a step', async () => {
    const t = setup();

    await t.run();

    const runs = t.stepRuns.listForJob(t.job.id);
    const brief = runs.find((run) => run.step === 1);
    expect(brief).toBeDefined();
    // The Brief step's timing ended before Generate began: the clock moves a second each time the stage
    // tells the page something, and none of those seconds is in step 1.
    expect(t.states.length).toBeGreaterThan(1);
    const briefMs = Date.parse(brief?.endedAt ?? '') - Date.parse(brief?.startedAt ?? '');
    expect(briefMs).toBe(0);
    // Step 1 was timed once, and the edit's own steps follow.
    expect(runs.filter((run) => run.step === 1)).toHaveLength(1);
    expect(runs.some((run) => run.step === 2)).toBe(true);
  });

  it('fails at step 1 with the plain sentence when the balance is empty, then carries on after a Retry without charging twice', async () => {
    const t = setup();
    t.brokenAt('balance_empty after=12');

    await t.run();

    let job = t.get();
    expect(job).toMatchObject({
      state: 'failed',
      step: 1,
      error: generateErrorMessage('balance_empty'),
    });
    // The row keeps what was made; the voice is whole, two clips are in.
    expect(job.generate).toMatchObject({
      counts: { voice: { done: 7, total: 7 }, clips: { done: 2, total: 6 } },
    });
    expect(job.generate?.phase).not.toBe('done');
    expect(t.seen).toEqual([]);

    t.fixed();
    t.retry();
    await t.again();

    job = t.get();
    expect(job.state).toBe('review');
    expect(job.error).toBeNull();
    expect(job.generate?.phase).toBe('done');
    // Ten stills, six clips and the retake: each asked for once in all.
    expect(t.spendEntries()).toBe(17);
    // The edit started fresh (the Generate run's files are not the edit's work).
    expect(t.seen).toEqual([{ mode: 'start', step: 1, transcribeTotal: 1 }]);
  });

  it('fails over the budget before any clip, with the dollars', async () => {
    const t = setup({ budgetUsd: 0.5 });

    await t.run();

    const job = t.get();
    expect(job).toMatchObject({ state: 'failed', step: 1 });
    expect(job.error).toBe(generateErrorMessage('over_budget', { needUsd: 0.9, budgetUsd: 0.5 }));
    expect(job.generate).toMatchObject({ budgetUsd: 0.5, spendUsd: 0 });
  });

  it('ends in Review, not failed, when the budget runs out in the middle', async () => {
    const t = setup({ budgetUsd: 0.95 });

    await t.run();

    const job = t.get();
    expect(job.state).toBe('review');
    expect(job.generate).toMatchObject({ phase: 'done', counts: { belowBar: 1 } });
    expect(readFileSync(join(t.editDir, 'brief.md'), 'utf8')).toContain('BELOW THE BAR');
  });

  it('is cancelled in the middle of Generate: the job is cancelled, not failed, and keeps what was made', async () => {
    const t = setup();
    // The run waits before the third voice line, so the first two are made and nothing else is.
    const waiting = t.holdAt(VOICE_PAUSE_MS, 3);
    t.worker.start();
    await waiting;

    const cancelled = await t.worker.cancel(t.job.id);

    expect(cancelled?.state).toBe('cancelled');
    expect(t.get().error).toBeNull();
    expect(t.seen).toEqual([]);
    expect(existsSync(join(t.editDir, 'generate', 'plan.json'))).toBe(true);
    expect(existsSync(join(t.editDir, 'generate', 'shots.json'))).toBe(false);
  });

  it('a Resume after the engine stopped carries on from the clips already made', async () => {
    const t = setup();
    // Stop the engine once two clips are in: the run waits before the third clip, with no script running
    // (a script killed between the clip it made and the line it writes in spend.json would leave a clip
    // that costs nothing in the ledger, which is the script's own business and not what this test is about).
    const waiting = t.holdAt(CLIP_PAUSE_MS, 3);
    t.worker.start();
    await waiting;
    await t.worker.stop();

    expect(t.get().state).toBe('editing');
    const before = t.spendEntries();
    expect(before).toBeLessThan(17);
    expect(t.seen).toEqual([]);

    // The next boot: the job left in editing resumes, its brief is reused, Generate carries on.
    const next = t.build();
    next.start();
    await next.idle();

    const job = t.get();
    expect(job.state).toBe('review');
    expect(job.generate?.phase).toBe('done');
    expect(t.spendEntries()).toBe(17);
    expect(readFileSync(join(t.editDir, 'brief.md'), 'utf8')).toContain('## Generated footage');
    // The edit began as a first edit would have: the Generate run's project notes are not its work.
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0]).toMatchObject({ mode: 'start', transcribeTotal: 1 });
  });
});

/** Every file under `dir` as text (these are all small text files or tiny placeholders). */
function everyFile(dir: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...everyFile(path));
    else found.push({ path, text: readFileSync(path, 'latin1') });
  }
  return found;
}

describe.skipIf(!haveTools)(
  'no key reaches anything a generated job leaves',
  { timeout: 60_000 },
  () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('keeps both keys out of the job, its events, its row, its History and every file of its folder', async () => {
      // Keys in the engine's own environment, as in production; they must stop at the engine.
      const higgsfield = 'hf-test-1111-aaaa:zzzz-never-in-a-file-8888';
      const elevenlabs = 'sk_test_never_in_a_file_0123456789';
      vi.stubEnv('HIGGSFIELD_API_KEY', higgsfield);
      vi.stubEnv('ELEVENLABS_API_KEY', elevenlabs);
      const t = setup();
      t.brokenAt('balance_empty after=12');

      await t.run();
      t.fixed();
      t.retry();
      await t.again();

      expect(t.get().state).toBe('review');
      const everything = [
        JSON.stringify(t.updates),
        JSON.stringify(t.states),
        JSON.stringify(t.get()),
        ...everyFile(t.jobDir).map((file) => file.text),
      ].join('\n');
      for (const secret of [higgsfield, elevenlabs, 'never-in-a-file', 'zzzz']) {
        expect(everything).not.toContain(secret);
      }
      expect(everything).not.toMatch(/authorization/i);
    });
  },
);

describe.skipIf(!haveTools)(
  'with the Generate switch off, or a job with footage',
  { timeout: 60_000 },
  () => {
    it('changes nothing for a job whose brief says generate when no Generate step is wired', async () => {
      const t = setup({ generate: false });

      await t.run();

      const job = t.get();
      expect(job.state).toBe('review');
      expect(existsSync(join(t.editDir, 'generate'))).toBe(false);
      expect(job).not.toHaveProperty('generate');
      expect(t.states).toEqual([]);
      expect(t.updates.some((update) => /^Generate · /.test(update.subProgress ?? ''))).toBe(false);
      // Transcribe counts what the brief calls footage: nothing, and no voice to add.
      expect(t.seen).toEqual([{ mode: 'start', step: 1, transcribeTotal: 0 }]);
    });

    it('leaves a job with footage alone even when the step is wired', async () => {
      const t = setup({ footage: true });

      await t.run();

      const job = t.get();
      expect(job.state).toBe('review');
      expect(existsSync(join(t.editDir, 'generate'))).toBe(false);
      expect(t.generateRepo.get(t.job.id)).toBeNull();
      expect(t.states).toEqual([]);
      expect(t.seen[0]?.transcribeTotal).toBe(1);
    });

    // 31 Oct: a brief that said "generate" was written again as an edit of the client's _Shared clips.
    it('takes the Generate stage off a job whose brief is no longer generated, when nothing was spent', async () => {
      const t = setup({ footage: true });
      t.generateRepo.start(t.job.id, 5);
      expect(t.get()).toHaveProperty('generate');

      await t.run();

      expect(t.generateRepo.get(t.job.id)).toBeNull();
      expect(t.get()).not.toHaveProperty('generate');
      expect(t.get().state).toBe('review');
      expect(t.updates.some((update) => update.generate === undefined)).toBe(true);
    });
  },
);
