import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Brief,
  type GenerateHistoryEvent,
  type GenerateState,
  generateErrorMessage,
  generateShotsSchema,
  type Job,
  parseGenerateErrorMessage,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { GenerateRepository, JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { readGenerateHistory } from '../generate/generate-history.js';
import { fakeBriefDraft } from './fake-brief.js';
import { FAIL_AT_GENERATE, FakeGenerateWriter } from './fake-generate.js';
import {
  GENERATE_STOPPED,
  type GenerateContext,
  GenerateStep,
  type GenerateWrite,
  type GenerateWriteOutcome,
  type GenerateWriter,
  generateFailure,
} from './generate-step.js';
import { GENERATE_TEST_POLL_MS, generatePauses } from './test-utils.js';

// The Generate stage (Generated videos, GN5) with the FAKE writer: the real step, the real
// progress reader, History and hand-off check, and the two scripts' fake path run as real
// processes. No model, no service, no key, no cent.

const temps: string[] = [];
const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LINES = ['Do you know what is in your windows?', 'But it gets worse.', 'Call us today.'];

/** A writer that counts its runs and forwards them to the fake one. */
class CountingWriter implements GenerateWriter {
  runs = 0;
  readonly inner = new FakeGenerateWriter({
    speed: 1,
    // A short real pause, longer than the poll, so the polling sees the folder change between the steps.
    sleep: generatePauses().sleep,
  });
  lastWrite: GenerateWrite | null = null;

  write(job: Job, run: GenerateWrite): Promise<GenerateWriteOutcome> {
    this.runs += 1;
    this.lastWrite = run;
    return this.inner.write(job, run);
  }
}

function setup(options: { budgetUsd?: number | null; lines?: string[] } = {}) {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-generate-step-'));
  temps.push(inbox);
  const jobDir = join(inbox, 'Pinewood', 'Window Ad');
  const editDir = join(jobDir, 'edit');
  mkdirSync(editDir, { recursive: true });

  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { generate: true });
  const repo = new GenerateRepository(db);
  const job = jobs.upsertFromScan(makeScan('Pinewood', 'Window Ad')).job;

  const lines = options.lines ?? LINES;
  const brief: Brief = {
    schema: 1,
    fingerprint: 'f',
    ...fakeBriefDraft(job, [], null),
    production: 'generate',
    voiceover: {
      lines: lines.map((text, index) => ({ id: `L${index + 1}`, text, direction: null })),
    },
    formats: ['1080x1920', '1080x1080'],
    budgetUsd: options.budgetUsd ?? null,
  };
  const writeBriefMd = (): void =>
    writeFileSync(join(editDir, 'brief.md'), '# Brief\n\nThe summary.\n\n## Decisions\n- none\n');
  writeBriefMd();

  const writer = new CountingWriter();
  const changes: GenerateState[] = [];
  const progress: string[] = [];
  const step = new GenerateStep({
    inboxPath: inbox,
    repo,
    budgetUsd: 3,
    writer,
    onChanged: (_id, state) => changes.push(state),
    pollIntervalMs: GENERATE_TEST_POLL_MS,
  });
  const context = (signal = new AbortController().signal): GenerateContext => ({
    signal,
    progress: (sub) => progress.push(sub),
  });

  return {
    inbox,
    jobDir,
    editDir,
    job,
    brief,
    repo,
    writer,
    step,
    changes,
    progress,
    context,
    writeBriefMd,
    run: (signal?: AbortSignal, withBrief: Brief = brief) =>
      step.prepare(job, withBrief, context(signal)),
    rowOf: () => repo.get(job.id),
    brokenAt: (marker: string) => writeFileSync(join(jobDir, FAIL_AT_GENERATE), marker),
    fixed: () => rmSync(join(jobDir, FAIL_AT_GENERATE), { force: true }),
    history: (): Promise<GenerateHistoryEvent[]> => readGenerateHistory(editDir),
    spend: () =>
      JSON.parse(readFileSync(join(editDir, 'generate', 'spend.json'), 'utf8')) as {
        entries: { kind: string; usd: number; refunded: boolean }[];
        total: number;
      },
  };
}

// The fake run starts the two scripts as real processes: about 1 to 2 s alone, over vitest's 5 s default when a busy full run keeps every core in use (C69).
describe('a Generate stage that works (with the fake run)', { timeout: 60_000 }, () => {
  it('makes the voice, the looks, the keyframes and the clips, and hands off for the edit', async () => {
    const t = setup();

    const outcome = await t.run();

    expect(outcome).toEqual({ ok: true, source: 'ran' });
    const dir = join(t.editDir, 'generate');
    for (const file of [
      'plan.json',
      'reference.md',
      'voice.mp3',
      'voice-words.json',
      'shots.json',
    ]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    const shots = generateShotsSchema.parse(
      JSON.parse(readFileSync(join(dir, 'shots.json'), 'utf8')),
    );
    expect(shots.shots.map((shot) => shot.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    // The kept takes are in shots/, the files the edit cuts.
    for (const shot of shots.shots)
      expect(existsSync(join(dir, 'shots', `${shot.id}.mp4`))).toBe(true);
    // Clip B failed its first check and was retaken on the other tier: take 2 is the kept one.
    expect(shots.shots.find((shot) => shot.id === 'B')).toMatchObject({ take: 2, belowBar: false });
    expect(existsSync(join(dir, 'sfx', 'alert.mp3'))).toBe(true);
    // brief.md now tells the edit run about the footage.
    const brief = readFileSync(join(t.editDir, 'brief.md'), 'utf8');
    expect(brief).toContain('## Generated footage');
    expect(brief).toContain('edit/generate/shots/A.mp4');
    expect(brief).toContain('edit/generate/voice.mp3');
  });

  it('keeps the row right at each point and ends it done, with the money from spend.json', async () => {
    const t = setup();

    await t.run();

    const row = t.rowOf();
    expect(row).toMatchObject({
      phase: 'done',
      counts: {
        voice: { done: 3, total: 3 },
        looks: { done: 3, total: 3 },
        keyframes: { done: 7, total: 7 },
        clips: { done: 6, total: 6 },
        belowBar: 0,
      },
      budgetUsd: 3,
    });
    // 10 stills at $0.004, 6 clips and 1 retake at $0.144 (4 s at $0.036).
    const spend = t.spend();
    expect(spend.entries).toHaveLength(17);
    expect(row?.spendUsd).toBeCloseTo(0.04 + 7 * 0.144, 6);
    expect(row?.spendUsd).toBe(spend.total);
    // The page was told, in order, and the last thing it heard is the finished row.
    const phases = t.changes.map((state) => state.phase);
    expect(phases[0]).toBe('plan');
    expect(phases.at(-1)).toBe('done');
    expect(new Set(phases)).toContain('voice');
    expect(new Set(phases)).toContain('clips');
    expect(t.changes.at(-1)?.spendUsd).toBe(spend.total);
    // ...and the job's step text said so under Brief.
    expect(t.progress[0]).toBe('Generate · planning the shots');
    expect(t.progress.some((text) => /^Generate · clips \d\/6 · \$/.test(text))).toBe(true);
    expect(t.progress.some((text) => /^Generate · voice \d\/3$/.test(text))).toBe(true);
  });

  it('counts the ElevenLabs characters the voice used, once each', async () => {
    const t = setup();

    await t.run();

    const row = t.repo.get(t.job.id);
    expect(row?.elevenlabsChars).toBe(LINES.reduce((sum, line) => sum + line.length, 0));
  });

  it('writes the History: what was decided, what was made, and that every clip was kept', async () => {
    const t = setup();

    await t.run();

    const events = await t.history();
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['decided', 'voice', 'looks', 'keyframes', 'clip', 'clips_done']),
    );
    expect(events[0]).toMatchObject({ kind: 'decided', formats: ['9:16', '1:1'] });
    expect(events.find((event) => event.kind === 'voice')).toMatchObject({ lines: 3 });
    expect(events.find((event) => event.kind === 'looks')).toMatchObject({
      names: ['the homeowner', 'the technician with the logo', 'the hero skylight'],
    });
    expect(events.find((event) => event.kind === 'clips_done')).toMatchObject({ count: 6 });
    // A clip is told once per take kept: B's retake is its own line.
    const clipLines = events.filter((event) => event.kind === 'clip');
    expect(clipLines.filter((event) => event.id === 'B').map((event) => event.take)).toContain(2);
    expect(events.some((event) => event.kind === 'stopped')).toBe(false);
  });

  it('uses the budget of the brief when it names one, else the configured one', async () => {
    const t = setup({ budgetUsd: 5 });
    await t.run();
    expect(t.rowOf()?.budgetUsd).toBe(5);
    expect(t.writer.lastWrite?.budgetUsd).toBe(5);
  });
});

describe('a Generate stage that finds its work done', { timeout: 60_000 }, () => {
  it('finishes without a run and puts the footage section back after the Brief wrote brief.md again', async () => {
    const t = setup();
    await t.run();
    const spend = t.spend();
    // The Brief step writes brief.md from scratch on every Retry and Resume.
    t.writeBriefMd();
    expect(readFileSync(join(t.editDir, 'brief.md'), 'utf8')).not.toContain('Generated footage');

    const outcome = await t.run();

    expect(outcome).toEqual({ ok: true, source: 'reused' });
    expect(t.writer.runs).toBe(1);
    expect(readFileSync(join(t.editDir, 'brief.md'), 'utf8')).toContain('## Generated footage');
    expect(t.spend()).toEqual(spend);
    expect(t.rowOf()?.phase).toBe('done');
    // It is told as quiet as it was done: no progress text for work that was not done.
    t.progress.length = 0;
    await t.run();
    expect(t.progress).toEqual([]);
  });

  it('makes only what is missing when the script in the brief changed, and keeps the other takes', async () => {
    const t = setup();
    await t.run();
    const before = t.spend().entries.length;
    const changed: Brief = {
      ...t.brief,
      voiceover: {
        lines:
          t.brief.voiceover?.lines.map((line) =>
            line.id === 'L2' ? { ...line, text: 'But it gets a lot worse.' } : line,
          ) ?? [],
      },
    };

    const outcome = await t.run(undefined, changed);

    expect(outcome).toEqual({ ok: true, source: 'ran' });
    // The new take of L2 only; the clips and the stills were not asked for again.
    expect(t.spend().entries).toHaveLength(before);
    expect(existsSync(join(t.editDir, 'generate', 'voice', 'L2-take2.mp3'))).toBe(true);
    expect(existsSync(join(t.editDir, 'generate', 'voice', 'L1-take2.mp3'))).toBe(false);
    expect(t.writer.lastWrite?.existing).toContain('L2');
  });
});

describe('a Generate stage that stops', { timeout: 60_000 }, () => {
  it('fails on an empty Higgsfield balance with the plain sentence, keeps what was made and says so in the History', async () => {
    const t = setup();
    t.brokenAt('balance_empty after=12');

    const outcome = await t.run();

    expect(outcome).toEqual({ ok: false, error: generateErrorMessage('balance_empty') });
    expect(parseGenerateErrorMessage(outcome.ok ? null : outcome.error)).toMatchObject({
      code: 'balance_empty',
      service: 'higgsfield',
    });
    // The voice, the looks, the keyframes and two clips are kept.
    const row = t.rowOf();
    expect(row).toMatchObject({
      counts: {
        voice: { done: 3, total: 3 },
        looks: { done: 3, total: 3 },
        keyframes: { done: 7, total: 7 },
        clips: { done: 2, total: 6 },
      },
    });
    expect(row?.phase).not.toBe('done');
    const events = await t.history();
    expect(events.at(-1)).toMatchObject({
      kind: 'stopped',
      code: 'balance_empty',
      service: 'higgsfield',
    });
    expect(readFileSync(join(t.editDir, 'brief.md'), 'utf8')).not.toContain('Generated footage');
  });

  it('carries on after a Retry from what was made, and charges nothing twice', async () => {
    const t = setup();
    t.brokenAt('balance_empty after=12');
    await t.run();
    const stopped = t.spend().entries.length;
    expect(stopped).toBe(12);
    t.fixed();

    const outcome = await t.run();

    expect(outcome).toEqual({ ok: true, source: 'ran' });
    // 10 stills + 6 clips + the retake of B, each requested exactly once in all.
    expect(t.spend().entries).toHaveLength(17);
    expect(t.rowOf()?.phase).toBe('done');
    // The run was told what exists, and why the last try stopped.
    expect(t.writer.lastWrite?.existing).toContain('the Higgsfield balance is empty');
    expect(t.writer.lastWrite?.existing).toContain('Clips made: A (take 1), B (take 1)');
    // The earlier lines of the History stay; the stop is there, and the stage is finished.
    const events = await t.history();
    expect(events.filter((event) => event.kind === 'stopped')).toHaveLength(1);
    expect(events.at(-1)?.kind === 'budget' || events.at(-1)?.kind === 'clips_done').toBe(true);
    // The voice was not made twice.
    expect(existsSync(join(t.editDir, 'generate', 'voice', 'L1-take2.mp3'))).toBe(false);
  });

  it('fails on a key that is not accepted', async () => {
    const t = setup();
    t.brokenAt('key_rejected');

    const outcome = await t.run();

    expect(outcome).toEqual({ ok: false, error: generateErrorMessage('key_rejected') });
    expect(outcome.ok ? '' : outcome.error).toContain('HIGGSFIELD_API_KEY');
    // The voice was made first and is kept.
    expect(existsSync(join(t.editDir, 'generate', 'voice.mp3'))).toBe(true);
    expect((await t.history()).at(-1)).toMatchObject({ kind: 'stopped', code: 'key_rejected' });
  });

  it('fails on a voice service that is down, naming ElevenLabs', async () => {
    const t = setup();
    t.brokenAt('unavailable voice');

    const outcome = await t.run();

    expect(outcome).toEqual({
      ok: false,
      error: generateErrorMessage('unavailable', { service: 'elevenlabs' }),
    });
    expect((await t.history()).at(-1)).toMatchObject({
      kind: 'stopped',
      code: 'unavailable',
      service: 'elevenlabs',
    });
  });

  it('fails over the budget before any look, with the dollars, and keeps the voice', async () => {
    const t = setup({ budgetUsd: 0.5 });

    const outcome = await t.run();

    // One take of every clip ($0.864) plus ten stills ($0.04) is $0.90 against $0.50.
    expect(outcome).toEqual({
      ok: false,
      error: generateErrorMessage('over_budget', { needUsd: 0.9, budgetUsd: 0.5 }),
    });
    expect(parseGenerateErrorMessage(outcome.ok ? null : outcome.error)).toEqual({
      code: 'over_budget',
      service: 'higgsfield',
      needUsd: 0.9,
      budgetUsd: 0.5,
    });
    expect(existsSync(join(t.editDir, 'generate', 'voice.mp3'))).toBe(true);
    expect(existsSync(join(t.editDir, 'generate', 'looks'))).toBe(false);
    expect(t.rowOf()?.spendUsd).toBe(0);
    expect((await t.history()).at(-1)).toMatchObject({
      kind: 'stopped',
      code: 'over_budget',
      needUsd: 0.9,
      budgetUsd: 0.5,
    });
  });

  it('finishes with its best takes when the budget runs out in the middle: not a failure', async () => {
    // $0.95 fits one take of everything ($0.904) but not the retake of B ($0.144).
    const t = setup({ budgetUsd: 0.95 });

    const outcome = await t.run();

    expect(outcome).toEqual({ ok: true, source: 'ran' });
    const shots = generateShotsSchema.parse(
      JSON.parse(readFileSync(join(t.editDir, 'generate', 'shots.json'), 'utf8')),
    );
    expect(shots.shots.find((shot) => shot.id === 'B')).toMatchObject({ take: 1, belowBar: true });
    expect(shots.shots.filter((shot) => shot.belowBar)).toHaveLength(1);
    expect(t.rowOf()).toMatchObject({
      phase: 'done',
      counts: { clips: { done: 6, total: 6 }, belowBar: 1 },
    });
    const events = await t.history();
    expect(events.find((event) => event.kind === 'budget')).toMatchObject({ id: 'B' });
    expect(events.some((event) => event.kind === 'stopped')).toBe(false);
    // brief.md tells the edit run which clip is below the bar.
    expect(readFileSync(join(t.editDir, 'brief.md'), 'utf8')).toContain('BELOW THE BAR');
  });

  it('is stopped quietly when the job is cancelled: nothing is recorded as a failure', async () => {
    const t = setup();
    const controller = new AbortController();
    setTimeout(() => controller.abort('cancel'), 120);

    const outcome = await t.run(controller.signal);

    expect(outcome.ok).toBe(false);
    expect((await t.history()).some((event) => event.kind === 'stopped')).toBe(false);
  });
});

// 31 Oct: a brief that said "generate" is written again and no longer does (its clips were in the
// client's _Shared): the job must stop showing as Generated, unless the stage spent something.
describe('a Generate stage the brief no longer asks for', () => {
  it('takes the row off the job when nothing was spent', () => {
    const t = setup();
    t.repo.start(t.job.id, 5);

    expect(t.step.forget(t.job)).toBe(true);
    expect(t.rowOf()).toBeNull();
    expect(t.step.forget(t.job)).toBe(false);
  });

  it('keeps the row of a stage that spent dollars or voice characters', () => {
    const t = setup();
    t.repo.start(t.job.id, 5);
    t.repo.update(t.job.id, { spendUsd: 0.5 });
    expect(t.step.forget(t.job)).toBe(false);
    expect(t.rowOf()?.spendUsd).toBe(0.5);

    const u = setup();
    u.repo.start(u.job.id, 5);
    u.repo.addVoiceChars(u.job.id, 25);
    expect(u.step.forget(u.job)).toBe(false);
    expect(u.rowOf()).not.toBeNull();
  });
});

describe('a run that does not hand off', () => {
  /** A writer with a fixed answer, writing nothing. */
  const answering = (answer: GenerateWriteOutcome): GenerateWriter => ({
    write: async () => answer,
  });

  function bare(writer: GenerateWriter) {
    const t = setup();
    const step = new GenerateStep({
      inboxPath: t.inbox,
      repo: t.repo,
      budgetUsd: 3,
      writer,
      pollIntervalMs: 15,
    });
    return { t, run: () => step.prepare(t.job, t.brief, t.context()) };
  }

  it('turns "Blocked:" into the job’s error as the run wrote it when no refusal explains it', async () => {
    const { run } = bare(
      answering({ ok: false, error: 'ignored', blocked: 'the reference video is unreadable' }),
    );
    expect(await run()).toEqual({
      ok: false,
      error: `${GENERATE_STOPPED} the reference video is unreadable`,
    });
  });

  it('turns a refusal the run saw into the plain sentence, whatever words the run used', async () => {
    const { run } = bare(
      answering({
        ok: false,
        error: 'x',
        blocked: 'I could not make the clips, the account has no money',
        refusal: { code: 'balance_empty', service: 'higgsfield' },
      }),
    );
    expect(await run()).toEqual({ ok: false, error: generateErrorMessage('balance_empty') });
  });

  it('fails an ended run that wrote no shots.json, naming the file', async () => {
    const { run } = bare(answering({ ok: true }));
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.error).toBe(
      `${GENERATE_STOPPED} the run ended and edit/generate/shots.json was not written.`,
    );
  });

  it('fails a hand-off that names a clip that is not there', async () => {
    const t = setup();
    const writer: GenerateWriter = {
      write: async (_job, run) => {
        mkdirSync(join(run.editDir, 'generate'), { recursive: true });
        writeFileSync(join(run.editDir, 'generate', 'voice.mp3'), 'x');
        writeFileSync(join(run.editDir, 'generate', 'voice-words.json'), '{"words":[]}');
        writeFileSync(
          join(run.editDir, 'generate', 'shots.json'),
          JSON.stringify({
            shots: [
              {
                id: 'A',
                file: 'clips/A/take-1.mp4',
                take: 1,
                windows: [{ startSec: 0, endSec: 1 }],
                seconds: 4,
                shows: 'x',
                model: 'm',
                usd: 0,
                belowBar: false,
              },
            ],
          }),
        );
        return { ok: true };
      },
    };
    const step = new GenerateStep({ inboxPath: t.inbox, repo: t.repo, budgetUsd: 3, writer });

    const outcome = await step.prepare(t.job, t.brief, t.context());

    expect(outcome).toEqual({
      ok: false,
      error: `${GENERATE_STOPPED} shots.json names clips/A/take-1.mp4 for clip A, but that file is not there.`,
    });
  });

  it('never throws: a writer that throws is a stopped stage', async () => {
    const { run } = bare({
      write: async () => {
        throw new Error('the disk is full');
      },
    });
    expect(await run()).toEqual({ ok: false, error: `${GENERATE_STOPPED} the disk is full` });
  });
});

describe('generateFailure', () => {
  it('keeps one of the plain sentences as it is', () => {
    const sentence = generateErrorMessage('key_rejected', { service: 'elevenlabs' });
    expect(generateFailure({ blocked: sentence, fallback: 'x' })).toEqual({
      error: sentence,
      refusal: { code: 'key_rejected', service: 'elevenlabs' },
    });
  });

  it('turns "this video needs about $N; the budget is $M" into the budget sentence', () => {
    const failure = generateFailure({
      blocked: 'this video needs about $4.10; the budget is $3',
      fallback: 'x',
    });
    expect(failure.error).toBe(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }));
    expect(failure.refusal).toMatchObject({ code: 'over_budget', needUsd: 4.1, budgetUsd: 3 });
  });

  it('uses a refusal the run saw when there is no Blocked line, else the fallback', () => {
    const refusal = { code: 'unavailable', service: 'higgsfield' } as const;
    expect(generateFailure({ refusal, fallback: 'f' }).error).toBe(
      generateErrorMessage('unavailable'),
    );
    expect(generateFailure({ fallback: 'f' })).toEqual({ error: 'f', refusal: null });
  });
});
