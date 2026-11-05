import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Job,
  MUSIC_FILES,
  musicPlanSchema,
  musicRecordSchema,
  musicWasNotAsked,
  STEP_IDS,
  STEP_LABELS,
  type StepId,
  stockRecordSchema,
} from '@studio/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clientIdFor } from '../inbox/scan.js';
import { createMusicScriptRunner } from '../music/music-script.js';
import { fakeBriefDraft } from './fake-brief.js';
import { roundSection } from './fake-content.js';
import { resolveFfmpeg } from './fake-media.js';
import { writeFakePreview } from './fake-preview.js';
import {
  CHECK_PASSES,
  EDIT_STEP_IDS,
  FAKE_EDIT_MS,
  FAKE_STEP_MS,
  FakeRunner,
  type FakeRunnerOptions,
  failMarkerName,
  fakeSpeedFromEnv,
} from './fake-runner.js';
import type { RunMode, RunOutcome } from './runner.js';

// Every test runs a real FakeRunner on a temp inbox with a very high speed factor and a half-second
// clip, so a whole run takes a few hundred milliseconds, nearly all of it ffmpeg. Tests that need
// the real pace, or an ffmpeg that misbehaves, say so.

const FAST = 100_000;
const CLIP_SECONDS = 0.5;

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-fake-runner-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let ffmpegPath: string | null = null;
beforeAll(async () => {
  ffmpegPath = await resolveFfmpeg();
});

const NOW = '2026-10-20T10:00:00.000Z';

function makeJob(relPath: string, step: StepId | null = 1, overrides: Partial<Job> = {}): Job {
  const [client = 'Client', name = 'Job'] = relPath.split('/');
  return {
    id: 'a1b2c3d4e5f6',
    clientId: clientIdFor(client),
    client,
    name,
    relPath,
    state: 'editing',
    step,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 2, audio: 1, image: 0, doc: 0 },
    sizeBytes: 0,
    addedAt: NOW,
    lastChangeAt: NOW,
    settledAt: NOW,
    heldSettledAt: null,
    runKind: 'edit',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: null,
    updatedAt: NOW,
    output: null,
    note: null,
    ...overrides,
  };
}

const DEFAULT_FILES = ['clip-01.mp4', 'clip-02.mov', 'voice.m4a', 'brief.txt', 'photo.jpg'];

/** An inbox with one job folder holding `files` (empty files; paths may be nested). */
function makeInbox(files: readonly string[] = DEFAULT_FILES, relPath = 'Acme/Teaser') {
  const inbox = tempDir();
  const jobDir = join(inbox, relPath);
  mkdirSync(jobDir, { recursive: true });
  for (const file of files) {
    mkdirSync(join(jobDir, file, '..'), { recursive: true });
    writeFileSync(join(jobDir, file), '');
  }
  return { inbox, jobDir, editDir: join(jobDir, 'edit'), relPath };
}

/** Every real file under `dir`, relative, sorted. Hidden temporary files are left out. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
    .filter((path) => statSync(join(dir, path)).isFile())
    .sort();
}

function mtimes(dir: string): Record<string, number> {
  return Object.fromEntries(filesUnder(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs]));
}

interface Report {
  step: StepId;
  sub: string | null;
  /** The files in `edit/` at the moment of the report. */
  files: string[];
}

/** Runs the runner once, recording each progress report with a snapshot of `edit/`. */
async function runOnce(
  setup: { inbox: string; relPath: string; editDir: string },
  {
    mode = 'start',
    step = 1,
    controller = new AbortController(),
    onReport,
    job,
    ...options
  }: Partial<Omit<FakeRunnerOptions, 'inboxPath'>> & {
    mode?: RunMode;
    step?: StepId;
    controller?: AbortController;
    onReport?: (report: Report) => void;
    /** Fields of the job to override, e.g. `{ runKind: 'revise', round: 1 }` (W3). */
    job?: Partial<Job>;
  } = {},
) {
  const runner = new FakeRunner({
    inboxPath: setup.inbox,
    speed: FAST,
    clipSeconds: CLIP_SECONDS,
    ...options,
  });
  const reports: Report[] = [];
  const outcome: RunOutcome = await runner.start(makeJob(setup.relPath, step, job), mode, {
    signal: controller.signal,
    progress: (reportedStep, sub = null) => {
      const report = { step: reportedStep, sub, files: filesUnder(setup.editDir) };
      reports.push(report);
      onReport?.(report);
    },
  });
  return { outcome, reports, steps: reports.map((r) => [r.step, r.sub] as const) };
}

/** An executable stand-in for ffmpeg. */
function fakeFfmpeg(dir: string, body: string): string {
  const path = join(dir, 'fake-ffmpeg.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function skipWithoutFfmpeg(): void {
  if (ffmpegPath === null) throw new Error('these tests need ffmpeg on PATH (brew install ffmpeg)');
}

/** Writes a sine tone of `hz` as an mp3: the music.mp3 a pick leaves in edit/preview/. */
function writeTone(path: string, hz: number): void {
  execFileSync(
    ffmpegPath as string,
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${hz}:duration=2`,
      path,
    ],
    { stdio: 'ignore' },
  );
}

/** The pitch of a file's sound (zero crossings of its decoded audio) and how loud it is (RMS, 0 to 1). */
function soundOf(path: string): { hz: number; rms: number } {
  const rate = 8_000;
  const pcm = execFileSync(
    ffmpegPath as string,
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(rate),
      '-f',
      's16le',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const even = pcm.length - (pcm.length % 2);
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + even));
  let crossings = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] as number;
    sum += (value / 32768) ** 2;
    if (i > 0 && (samples[i - 1] as number) < 0 !== value < 0) crossings += 1;
  }
  return { hz: crossings / 2 / (samples.length / rate), rms: Math.sqrt(sum / samples.length) };
}

// The files each step writes, in the order the steps run: index `n` is step `n + 1`. The Brief
// step is not the runner's (fake-brief.ts writes edit/brief.json before it starts).
const FILES_BY_STEP: readonly (readonly string[])[] = [
  [],
  ['transcripts/clip-01.json', 'transcripts/clip-02.json', 'transcripts/voice.json'],
  ['takes_packed.md'],
  ['project.md'],
  [
    'edl.json',
    'animations/slot_1/index.html',
    'animations/slot_1/render.mov',
    'animations/slot_2/index.html',
    'animations/slot_2/render.mov',
    'animations/slot_3/index.html',
    'animations/slot_3/render.mov',
  ],
  ['preview.mp4'],
  ['verify/pass_1.jpg', 'verify/pass_2.jpg', 'verify/pass_3.jpg'],
  ['final.mp4'],
];

describe('a full run', () => {
  it('writes the files of each step, in order, and ends ok with final.mp4', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { outcome, reports } = await runOnce(setup);

    expect(outcome).toEqual({ ok: true });

    // When a step is first reported, everything from the steps before it exists and nothing from
    // its own step or later does yet.
    for (const step of EDIT_STEP_IDS) {
      const first = reports.find((report) => report.step === step);
      expect(first, `step ${step} was reported`).toBeDefined();
      const before = FILES_BY_STEP.slice(0, step - 1).flat();
      const fromHere = FILES_BY_STEP.slice(step - 1).flat();
      expect(first?.files, `files when step ${step} starts`).toEqual(
        expect.arrayContaining(before),
      );
      for (const file of fromHere) {
        expect(first?.files, `${file} must not exist when step ${step} starts`).not.toContain(file);
      }
    }

    expect(filesUnder(setup.editDir)).toEqual(FILES_BY_STEP.flat().sort());
  });

  it('reports progress in order: transcripts n/N, graphics n/M, passes n/3', async () => {
    skipWithoutFfmpeg();
    const { steps } = await runOnce(makeInbox());
    expect(steps).toEqual([
      [2, null],
      [2, '1/3'],
      [2, '2/3'],
      [2, '3/3'],
      [3, null],
      [4, null],
      [5, null],
      [5, 'graphics 1/3'],
      [5, 'graphics 2/3'],
      [5, 'graphics 3/3'],
      [6, null],
      [7, null],
      [7, 'pass 1/3'],
      [7, 'pass 2/3'],
      [7, 'pass 3/3'],
      [8, null],
    ]);
  });

  it("starts at Transcribe: Brief is the Brief step's, and edit/ is empty when Transcribe starts", async () => {
    skipWithoutFfmpeg();
    const { reports } = await runOnce(makeInbox());

    expect(reports[0]).toEqual({ step: 2, sub: null, files: [] });
    expect(reports.some((report) => report.step === 1)).toBe(false);
    expect(STEP_LABELS[reports[0]?.step ?? 1]).toBe('Transcribe');
  });

  it('writes a transcript per video or audio file only, nested ones and duplicates included', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox([
      'a/clip.mp4',
      'b/clip.mp4',
      'voice.WAV',
      'notes.txt',
      'photo.png',
      '.hidden.mp4',
      'movie.mp4.part',
      'edit/old-take.mp4',
      'Deck.key/preview.mov',
      'Hebrew שלום 🎬.mov',
    ]);
    const { outcome } = await runOnce(setup);
    expect(outcome.ok).toBe(true);

    const transcripts = filesUnder(join(setup.editDir, 'transcripts'));
    expect(transcripts).toEqual(['Hebrew שלום 🎬.json', 'clip-2.json', 'clip.json', 'voice.json']);
    const first = JSON.parse(readFileSync(join(setup.editDir, 'transcripts/clip.json'), 'utf8'));
    expect(first).toMatchObject({ source: 'a/clip.mp4', language_code: 'eng' });
    expect(first.words.length).toBeGreaterThan(5);
    expect(first.words[0]).toMatchObject({ type: 'word', speaker_id: 'speaker_0' });
  });

  it('writes plausible takes_packed.md, project.md and edl.json', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup);
    const read = (file: string) => readFileSync(join(setup.editDir, file), 'utf8');

    expect(read('takes_packed.md')).toMatch(/^# Packed transcripts/);
    expect(read('takes_packed.md')).toMatch(/## clip-01 {2}\(duration: \d+\.\d+s, 1 phrases\)/);
    expect(read('project.md')).toMatch(/^# Acme — Teaser/);
    expect(read('project.md')).toContain('**Assumptions:**');

    const edl = JSON.parse(read('edl.json'));
    expect(Object.keys(edl.sources)).toEqual(['clip-01', 'clip-02', 'voice']);
    expect(edl.ranges).toHaveLength(3);
    expect(edl.overlays.map((o: { file: string }) => o.file)).toEqual([
      join(setup.editDir, 'animations/slot_1/render.mov'),
      join(setup.editDir, 'animations/slot_2/render.mov'),
      join(setup.editDir, 'animations/slot_3/render.mov'),
    ]);
  });

  it('makes preview.mp4 and final.mp4 real MP4 files, and leaves no partial files behind', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup);

    for (const file of ['preview.mp4', 'final.mp4']) {
      const bytes = readFileSync(join(setup.editDir, file));
      expect(bytes.length, file).toBeGreaterThan(2_000);
      expect(bytes.subarray(4, 8).toString('latin1'), file).toBe('ftyp');
    }
    for (let pass = 1; pass <= CHECK_PASSES; pass += 1) {
      const jpeg = readFileSync(join(setup.editDir, `verify/pass_${pass}.jpg`));
      expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    }

    const everything = readdirSync(setup.editDir, { recursive: true, encoding: 'utf8' });
    expect(everything.filter((path) => path.split('/').some((p) => p.startsWith('.')))).toEqual([]);
  });

  it('runs a job that has no audio or video: no transcripts, still a finished edit', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox(['photo.png', 'brief.txt']);
    const { outcome, steps } = await runOnce(setup);

    expect(outcome.ok).toBe(true);
    expect(steps.filter(([step]) => step === 2)).toEqual([[2, null]]);
    expect(filesUnder(setup.editDir)).not.toContainEqual(expect.stringMatching(/^transcripts\//));
    expect(existsSync(join(setup.editDir, 'final.mp4'))).toBe(true);
    expect(readFileSync(join(setup.editDir, 'takes_packed.md'), 'utf8')).toContain(
      'no audio or video',
    );
  });

  it('makes no progress calls with reportProgress off, and still writes everything', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { outcome, reports } = await runOnce(setup, { reportProgress: false });

    expect(outcome.ok).toBe(true);
    expect(reports).toEqual([]);
    expect(filesUnder(setup.editDir)).toEqual(FILES_BY_STEP.flat().sort());
  });
});

// W2 (CVP-108): with the Review switch on, an edit run ends in Review. It runs steps 2 to 7, and
// step 6 writes W9's sample composition into edit/preview/ instead of preview.mp4.
describe('a run that ends in Review (the switch is on)', () => {
  const SAMPLE = { durationSec: 6, width: 1080, height: 1920 };

  /** The files of steps 2 to 5 and 7, and the sample composition for step 6. */
  const COMPOSITION_FILES = [
    'preview/assets/fonts/noto-sans-hebrew-hebrew-700-normal.woff2',
    'preview/compositions/badge.html',
    'preview/cut.mp4',
    'preview/index.html',
    'preview/vendor/gsap.min.js',
  ];
  const REVIEW_FILES = [
    ...FILES_BY_STEP.slice(0, 5).flat(),
    ...COMPOSITION_FILES,
    ...FILES_BY_STEP.slice(6, 7).flat(),
  ].sort();

  it('reports steps 2 to 7 only, and ends ok with the preview it left', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { outcome, steps } = await runOnce(setup, { review: true });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(steps).toEqual([
      [2, null],
      [2, '1/3'],
      [2, '2/3'],
      [2, '3/3'],
      [3, null],
      [4, null],
      [5, null],
      [5, 'graphics 1/3'],
      [5, 'graphics 2/3'],
      [5, 'graphics 3/3'],
      [6, null],
      [7, null],
      [7, 'pass 1/3'],
      [7, 'pass 2/3'],
      [7, 'pass 3/3'],
    ]);
  });

  it('writes the composition in place of preview.mp4, and no final.mp4', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup, { review: true });

    expect(filesUnder(setup.editDir)).toEqual(REVIEW_FILES);
    expect(existsSync(join(setup.editDir, 'preview.mp4'))).toBe(false);
    expect(existsSync(join(setup.editDir, 'final.mp4'))).toBe(false);
  });

  it("puts the job's name in the composition's title, escaped, Hebrew and all", async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox(DEFAULT_FILES, 'מאפיית הצפון/פרומו & "סוף" <1>');
    await runOnce(setup, { review: true });

    const html = readFileSync(join(setup.editDir, 'preview', 'index.html'), 'utf8');
    expect(html).toContain('<title>פרומו &amp; &quot;סוף&quot; &lt;1&gt;</title>');
    expect(html).not.toContain('Sample preview');
  });

  it('has the composition in place when Preview (6) is reported, and the check frames after it', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { reports } = await runOnce(setup, { review: true });

    const atSix = reports.find((report) => report.step === 6);
    expect(atSix?.files).not.toContain('preview/index.html');
    const atSeven = reports.find((report) => report.step === 7);
    expect(atSeven?.files).toEqual(expect.arrayContaining(COMPOSITION_FILES));
    expect(atSeven?.files).not.toContain('verify/pass_1.jpg');
  });

  it('leaves no dot-named file or folder behind in edit/', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup, { review: true });
    const everything = readdirSync(setup.editDir, { recursive: true, encoding: 'utf8' });
    expect(everything.filter((path) => path.split('/').some((p) => p.startsWith('.')))).toEqual([]);
  });

  it('fails at Preview (6) with .fail-at-preview', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    writeFileSync(join(setup.jobDir, '.fail-at-preview'), '');
    const { outcome, steps } = await runOnce(setup, { review: true });

    expect(outcome).toEqual({
      ok: false,
      error: 'Preview failed: injected failure (.fail-at-preview)',
      step: 6,
    });
    expect(steps.at(-1)).toEqual([6, null]);
    expect(existsSync(join(setup.editDir, 'preview'))).toBe(false);
  });

  it('fails at Check (7) with .fail-at-check, after the composition', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    writeFileSync(join(setup.jobDir, '.fail-at-check'), '');
    const { outcome } = await runOnce(setup, { review: true });

    expect(outcome).toMatchObject({ ok: false, step: 7 });
    expect(existsSync(join(setup.editDir, 'preview', 'index.html'))).toBe(true);
  });

  it('has nothing to fail at Render: .fail-at-render does nothing, there is no step 8', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    writeFileSync(join(setup.jobDir, '.fail-at-render'), '');
    const { outcome, steps } = await runOnce(setup, { review: true });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(steps.some(([step]) => step === 8)).toBe(false);
  });

  it('resumed from step 7 it keeps the composition and only makes the check frames', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup, { review: true });
    rmSync(join(setup.editDir, 'verify/pass_3.jpg'));
    const before = mtimes(setup.editDir);

    const { outcome, steps } = await runOnce(setup, { review: true, mode: 'resume', step: 7 });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(steps).toEqual([
      [7, null],
      [7, 'pass 3/3'],
    ]);
    expect(filesUnder(setup.editDir)).toEqual(REVIEW_FILES);
    const after = mtimes(setup.editDir);
    for (const file of COMPOSITION_FILES) expect(after[file], file).toBe(before[file]);
  });

  it('resumed from step 6 with a composition already there leaves it alone', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup, { review: true });
    const index = join(setup.editDir, 'preview', 'index.html');
    writeFileSync(
      index,
      readFileSync(index, 'utf8').replace('data-duration="6"', 'data-duration="9"'),
    );

    const { outcome } = await runOnce(setup, { review: true, mode: 'retry', step: 6 });

    expect(outcome).toEqual({ ok: true, preview: { ...SAMPLE, durationSec: 9 } });
  });

  it('a start writes the composition again', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup, { review: true });
    const index = join(setup.editDir, 'preview', 'index.html');
    writeFileSync(index, 'STALE');

    const { outcome } = await runOnce(setup, { review: true, mode: 'start' });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(readFileSync(index, 'utf8')).toContain('data-composition-id="main"');
  });

  it('judges the composition the way the engine does: a broken template is a Preview failure', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const template = tempDir();
    writeFileSync(
      join(template, 'index.html'),
      '<html><head><title>Sample preview</title></head><body><div data-composition-id="x" data-width="1080" data-height="1920"></div></body></html>',
    );

    const { outcome } = await runOnce(setup, { review: true, previewTemplateDir: template });

    expect(outcome).toEqual({
      ok: false,
      error: 'Preview failed: the root element of edit/preview/index.html has no data-duration.',
      step: 6,
    });
  });

  it('fails at Preview (6) when the sample cannot be copied', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { outcome } = await runOnce(setup, {
      review: true,
      previewTemplateDir: join(tempDir(), 'nope'),
    });

    expect(outcome).toMatchObject({ ok: false, step: 6 });
    expect(outcome.ok === false && outcome.error).toMatch(/^Preview failed: /);
    expect(readdirSync(setup.editDir).filter((name) => name.startsWith('.preview-'))).toEqual([]);
  });

  it('with the switch off nothing changes: preview.mp4 and final.mp4, no composition', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { outcome } = await runOnce(setup, { review: false });

    expect(outcome).toEqual({ ok: true });
    expect(filesUnder(setup.editDir)).toEqual(FILES_BY_STEP.flat().sort());
    expect(existsSync(join(setup.editDir, 'preview'))).toBe(false);
  });

  it('a revise run ends in Review whatever the switch says, and stops after Check', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    mkdirSync(join(setup.editDir, 'review'), { recursive: true });
    writeFileSync(join(setup.editDir, 'review', 'round-1.md'), '- 0:01.0 — x\n');
    const reports: number[] = [];
    const runner = new FakeRunner({
      inboxPath: setup.inbox,
      speed: FAST,
      clipSeconds: CLIP_SECONDS,
    });
    const job = makeJob(setup.relPath, 4, { runKind: 'revise', round: 1 });
    const outcome = await runner.start(job, 'start', {
      signal: new AbortController().signal,
      progress: (step) => reports.push(step),
    });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(Math.max(...reports)).toBe(7);
    expect(existsSync(join(setup.editDir, 'final.mp4'))).toBe(false);
  });
});

// W3 (CVP-110): the fake runner's revise run (steps 4 to 7, after Send notes) and render run
// (step 8, after Approve). Neither runs the Brief step.
describe('roundSection', () => {
  const BAKERY = readFileSync(
    fileURLToPath(
      new URL('../../../../packages/shared/src/review/fixtures/bakery-round-1.md', import.meta.url),
    ),
    'utf8',
  );

  it('has one line per note of the round file, with the time of each', () => {
    expect(roundSection(1, BAKERY)).toBe(
      [
        '## Round 1',
        '',
        '- 0:02.4: done as asked (fake revise).',
        '- 0:07.8: done as asked (fake revise).',
        '- 0:15.6: done as asked (fake revise).',
        '',
      ].join('\n'),
    );
  });

  it('says so when the round file has no notes', () => {
    expect(roundSection(2, '# Review notes, round 2: x\n\nThe owner watched the preview.\n')).toBe(
      '## Round 2\n\n- No notes in the round file (fake revise).\n',
    );
    expect(roundSection(3, '')).toBe('## Round 3\n\n- No notes in the round file (fake revise).\n');
  });
});

describe('a revise run (after Send notes)', () => {
  const SAMPLE = { durationSec: 6, width: 1080, height: 1920 };
  const BAKERY_ROUND_1 = fileURLToPath(
    new URL('../../../../packages/shared/src/review/fixtures/bakery-round-1.md', import.meta.url),
  );
  const revise = (round = 1) => ({ runKind: 'revise' as const, round });

  /** A job as the edit run left it: a composition titled with its name, and the plan. */
  async function editedJob(round = 1, { roundFile = true } = {}) {
    const setup = makeInbox();
    mkdirSync(setup.editDir, { recursive: true });
    await writeFakePreview(setup.editDir, 'Teaser');
    writeFileSync(
      join(setup.editDir, 'project.md'),
      '# Acme: Teaser\n\n## Session 1\n\nThe plan.\n',
    );
    if (roundFile) {
      mkdirSync(join(setup.editDir, 'review'), { recursive: true });
      copyFileSync(BAKERY_ROUND_1, join(setup.editDir, 'review', `round-${round}.md`));
    }
    return setup;
  }

  const index = (setup: { editDir: string }) =>
    readFileSync(join(setup.editDir, 'preview', 'index.html'), 'utf8');
  const project = (setup: { editDir: string }) =>
    readFileSync(join(setup.editDir, 'project.md'), 'utf8');

  it('runs steps 4 to 7 only, and ends in Review with the new composition', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    const { outcome, steps } = await runOnce(setup, { review: true, step: 4, job: revise() });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(steps).toEqual([
      [4, null],
      [5, null],
      [6, null],
      [7, null],
      [7, 'pass 1/3'],
      [7, 'pass 2/3'],
      [7, 'pass 3/3'],
    ]);
  });

  it('starts at Plan even when the job still says Transcribe or Brief', async () => {
    skipWithoutFfmpeg();
    for (const step of [1, 2] as const) {
      const setup = await editedJob();
      const { steps } = await runOnce(setup, { review: true, step, job: revise() });
      expect(steps[0], String(step)).toEqual([4, null]);
    }
  });

  it('adds the Round 1 section to project.md, one line per note, after the plan', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    await runOnce(setup, { review: true, step: 4, job: revise() });

    expect(project(setup)).toBe(
      [
        '# Acme: Teaser',
        '',
        '## Session 1',
        '',
        'The plan.',
        '',
        '## Round 1',
        '',
        '- 0:02.4: done as asked (fake revise).',
        '- 0:07.8: done as asked (fake revise).',
        '- 0:15.6: done as asked (fake revise).',
        '',
      ].join('\n'),
    );
  });

  it('retitles the composition “Round 1”, in the title and on the page', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    expect(index(setup)).toContain('>Teaser<');
    await runOnce(setup, { review: true, step: 4, job: revise() });

    const html = index(setup);
    expect(html.match(/>Round 1</g)).toHaveLength(2);
    expect(html).not.toContain('Teaser');
    expect(html).not.toContain('Sample preview');
  });

  it('does not touch the footage side: no transcripts, no graphics, no final.mp4, no Brief', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    await runOnce(setup, { review: true, step: 4, job: revise() });

    const files = filesUnder(setup.editDir);
    expect(files.filter((file) => /^(transcripts|animations)\//.test(file))).toEqual([]);
    expect(files).not.toContain('final.mp4');
    expect(files).not.toContain('brief.json');
    expect(files).not.toContain('takes_packed.md');
    expect(files).toContain('verify/pass_1.jpg');
  });

  it('a retry (or a second try) does not add the section twice', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    await runOnce(setup, { review: true, step: 4, job: revise() });
    const once = project(setup);

    await runOnce(setup, { review: true, step: 4, mode: 'retry', job: revise() });
    await runOnce(setup, { review: true, step: 4, mode: 'start', job: revise() });

    expect(project(setup)).toBe(once);
    expect(project(setup).match(/^## Round 1$/gm)).toHaveLength(1);
  });

  it('round 2 adds its own section after round 1’s and titles the composition “Round 2”', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    await runOnce(setup, { review: true, step: 4, job: revise(1) });
    copyFileSync(BAKERY_ROUND_1, join(setup.editDir, 'review', 'round-2.md'));

    const { outcome } = await runOnce(setup, { review: true, step: 4, job: revise(2) });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(project(setup).match(/^## Round \d$/gm)).toEqual(['## Round 1', '## Round 2']);
    expect(index(setup).match(/>Round 2</g)).toHaveLength(2);
    expect(index(setup)).not.toContain('>Round 1<');
  });

  it('writes the composition again each time, even over one from an earlier round', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    await runOnce(setup, { review: true, step: 4, job: revise() });
    const first = readFileSync(join(setup.editDir, 'preview', 'index.html'), 'utf8');
    writeFileSync(
      join(setup.editDir, 'preview', 'index.html'),
      first.replace('>Round 1<', '>old<'),
    );

    // A resume at Preview rewrites too: an earlier round's index.html is there whatever the mode.
    const { outcome } = await runOnce(setup, {
      review: true,
      step: 6,
      mode: 'resume',
      job: revise(),
    });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(index(setup)).toContain('>Round 1<');
    expect(index(setup)).not.toContain('>old<');
  });

  it('fails at Plan (4) when the round file is missing', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob(1, { roundFile: false });
    const { outcome, steps } = await runOnce(setup, { review: true, step: 4, job: revise() });

    expect(outcome).toEqual({
      ok: false,
      error: 'Plan failed: edit/review/round-1.md is missing',
      step: 4,
    });
    expect(steps).toEqual([[4, null]]);
    expect(project(setup)).not.toContain('## Round');
    expect(index(setup)).toContain('>Teaser<');
  });

  it('fails at Plan (4) when only another round’s file is there', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob(1);
    const { outcome } = await runOnce(setup, { review: true, step: 4, job: revise(2) });
    expect(outcome).toMatchObject({
      ok: false,
      error: 'Plan failed: edit/review/round-2.md is missing',
      step: 4,
    });
  });

  it('resumed from Preview (6) it runs steps 6 and 7 only', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    const { outcome, steps } = await runOnce(setup, {
      review: true,
      step: 6,
      mode: 'resume',
      job: revise(),
    });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(steps.map(([step]) => step)).toEqual([6, 7, 7, 7, 7]);
    // Plan did not run: the round's section is not there yet.
    expect(project(setup)).not.toContain('## Round');
    expect(index(setup).match(/>Round 1</g)).toHaveLength(2);
  });

  it('fails at a step with its .fail-at marker, like any run', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    writeFileSync(join(setup.jobDir, '.fail-at-preview'), '');
    const { outcome } = await runOnce(setup, { review: true, step: 4, job: revise() });
    expect(outcome).toEqual({
      ok: false,
      error: 'Preview failed: injected failure (.fail-at-preview)',
      step: 6,
    });
  });

  it('ends in Review whatever the switch says', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob();
    const { outcome } = await runOnce(setup, { review: false, step: 4, job: revise() });
    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(existsSync(join(setup.editDir, 'final.mp4'))).toBe(false);
  });

  it('reads a round file in Hebrew as UTF-8', async () => {
    skipWithoutFfmpeg();
    const setup = await editedJob(1, { roundFile: false });
    mkdirSync(join(setup.editDir, 'review'), { recursive: true });
    writeFileSync(
      join(setup.editDir, 'review', 'round-1.md'),
      '# Review notes, round 1: פרומו\n\n- 0:03.2 — עוד שנייה על הלוגו\n',
      'utf8',
    );
    await runOnce(setup, { review: true, step: 4, job: revise() });
    expect(project(setup)).toContain('- 0:03.2: done as asked (fake revise).');
  });
});

describe('a render run (after Approve)', () => {
  const render = { runKind: 'render' as const, round: 1 };

  async function approvedJob() {
    const setup = makeInbox();
    mkdirSync(setup.editDir, { recursive: true });
    await writeFakePreview(setup.editDir, 'Teaser');
    return setup;
  }

  it('reports step 8 only and writes a real final.mp4', async () => {
    skipWithoutFfmpeg();
    const setup = await approvedJob();
    const { outcome, steps } = await runOnce(setup, { review: true, step: 8, job: render });

    expect(outcome).toEqual({ ok: true });
    expect(steps).toEqual([[8, null]]);
    const bytes = readFileSync(join(setup.editDir, 'final.mp4'));
    expect(bytes.length).toBeGreaterThan(2_000);
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  });

  it('sounds like its tone, or, with Soundtrack on, like the music that was picked', async () => {
    skipWithoutFfmpeg();
    const setup = await approvedJob();
    writeTone(join(setup.editDir, MUSIC_FILES.preview), 880);

    // Soundtrack off: the file is not looked at.
    await runOnce(setup, { review: true, step: 8, job: render });
    const tone = soundOf(join(setup.editDir, 'final.mp4'));
    expect(tone.hz).toBeGreaterThan(420);
    expect(tone.hz).toBeLessThan(460);

    rmSync(join(setup.editDir, 'final.mp4'));
    await runOnce(setup, { review: true, music: true, step: 8, job: render });
    const music = soundOf(join(setup.editDir, 'final.mp4'));
    expect(music.hz).toBeGreaterThan(850);
    expect(music.hz).toBeLessThan(910);
    expect(music.rms).toBeGreaterThan(0.02);
  });

  it('with Soundtrack on and no music.mp3, keeps its tone', async () => {
    skipWithoutFfmpeg();
    const setup = await approvedJob();
    await runOnce(setup, { review: true, music: true, step: 8, job: render });
    const tone = soundOf(join(setup.editDir, 'final.mp4'));
    expect(tone.hz).toBeGreaterThan(420);
    expect(tone.hz).toBeLessThan(460);
  });

  it('runs only Render even when the job still says an earlier step', async () => {
    skipWithoutFfmpeg();
    const setup = await approvedJob();
    const { steps } = await runOnce(setup, { review: true, step: 1, job: render });
    expect(steps).toEqual([[8, null]]);
  });

  it('writes nothing else: the composition and the plan stay as they are', async () => {
    skipWithoutFfmpeg();
    const setup = await approvedJob();
    const before = mtimes(join(setup.editDir, 'preview'));
    await runOnce(setup, { review: true, step: 8, job: render });

    expect(filesUnder(setup.editDir).filter((file) => !file.startsWith('preview/'))).toEqual([
      'final.mp4',
    ]);
    expect(mtimes(join(setup.editDir, 'preview'))).toEqual(before);
  });

  it('fails at Render (8) when the composition is gone', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { outcome } = await runOnce(setup, { review: true, step: 8, job: render });

    expect(outcome).toEqual({
      ok: false,
      error: 'Render failed: edit/preview/index.html is missing',
      step: 8,
    });
    expect(existsSync(join(setup.editDir, 'final.mp4'))).toBe(false);
  });

  it('fails at Render (8) with .fail-at-render, and renders once the marker is gone', async () => {
    skipWithoutFfmpeg();
    const setup = await approvedJob();
    writeFileSync(join(setup.jobDir, '.fail-at-render'), '');
    const failed = await runOnce(setup, { review: true, step: 8, job: render });
    expect(failed.outcome).toEqual({
      ok: false,
      error: 'Render failed: injected failure (.fail-at-render)',
      step: 8,
    });
    expect(existsSync(join(setup.editDir, 'final.mp4'))).toBe(false);

    rmSync(join(setup.jobDir, '.fail-at-render'));
    const retried = await runOnce(setup, { review: true, step: 8, mode: 'retry', job: render });
    expect(retried.outcome).toEqual({ ok: true });
    expect(existsSync(join(setup.editDir, 'final.mp4'))).toBe(true);
  });

  it('a start renders again over an earlier final.mp4; a resume keeps it', async () => {
    skipWithoutFfmpeg();
    const setup = await approvedJob();
    await runOnce(setup, { review: true, step: 8, job: render });
    const first = statSync(join(setup.editDir, 'final.mp4')).mtimeMs;

    await runOnce(setup, { review: true, step: 8, mode: 'resume', job: render });
    expect(statSync(join(setup.editDir, 'final.mp4')).mtimeMs).toBe(first);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runOnce(setup, { review: true, step: 8, mode: 'start', job: render });
    expect(statSync(join(setup.editDir, 'final.mp4')).mtimeMs).toBeGreaterThan(first);
  });

  it('delivers a video whatever the switch says', async () => {
    skipWithoutFfmpeg();
    const setup = await approvedJob();
    const { outcome } = await runOnce(setup, { review: false, step: 8, job: render });
    expect(outcome).toEqual({ ok: true });
  });
});

describe('pace', () => {
  it('waits about a minute in total at speed 1', async () => {
    skipWithoutFfmpeg();
    const waits: number[] = [];
    const setup = makeInbox();
    await runOnce(setup, { speed: 1, sleep: async (ms) => void waits.push(ms) });

    // Steps 2 to 8 add up to the minute they always were; Brief's second is the fake Brief run's.
    expect(FAKE_EDIT_MS).toBe(60_000);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeCloseTo(FAKE_EDIT_MS, 6);
  });

  it('divides every wait by the speed', async () => {
    skipWithoutFfmpeg();
    const waits: number[] = [];
    await runOnce(makeInbox(), { speed: 12, sleep: async (ms) => void waits.push(ms) });
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeCloseTo(FAKE_EDIT_MS / 12, 6);
  });

  it('gives each step its share of the run, Brief included (the fake Brief run waits that long)', () => {
    expect(Object.keys(FAKE_STEP_MS).map(Number)).toEqual([...STEP_IDS]);
    expect(FAKE_STEP_MS[1]).toBe(1_000);
    expect(EDIT_STEP_IDS).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(EDIT_STEP_IDS.reduce((sum, step) => sum + FAKE_STEP_MS[step], 0)).toBe(FAKE_EDIT_MS);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses speed %s', (speed) => {
    expect(() => new FakeRunner({ inboxPath: '/inbox', speed })).toThrow(RangeError);
  });

  it('reads STUDIO_FAKE_SPEED', () => {
    expect(fakeSpeedFromEnv({})).toBeUndefined();
    expect(fakeSpeedFromEnv({ STUDIO_FAKE_SPEED: '' })).toBeUndefined();
    expect(fakeSpeedFromEnv({ STUDIO_FAKE_SPEED: ' 30 ' })).toBe(30);
    expect(fakeSpeedFromEnv({ STUDIO_FAKE_SPEED: '0.5' })).toBe(0.5);
    expect(() => fakeSpeedFromEnv({ STUDIO_FAKE_SPEED: 'warp' })).toThrow(/STUDIO_FAKE_SPEED/);
    expect(() => fakeSpeedFromEnv({ STUDIO_FAKE_SPEED: '0' })).toThrow(/STUDIO_FAKE_SPEED/);
  });
});

describe('failure injection', () => {
  it('fails at Render with .fail-at-render, after steps 2 to 7', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    writeFileSync(join(setup.jobDir, '.fail-at-render'), '');
    const { outcome, steps } = await runOnce(setup);

    expect(outcome).toEqual({
      ok: false,
      error: 'Render failed: injected failure (.fail-at-render)',
      step: 8,
    });
    expect(steps.at(-1)).toEqual([8, null]);
    expect(filesUnder(setup.editDir)).toEqual(FILES_BY_STEP.slice(0, 7).flat().sort());
  });

  it('leaves .fail-at-brief to the fake Brief run: the edit itself does not fail on it', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    writeFileSync(join(setup.jobDir, '.fail-at-brief'), '');
    const { outcome, steps } = await runOnce(setup, { mode: 'retry', step: 1 });

    expect(outcome).toEqual({ ok: true });
    expect(steps[0]).toEqual([2, null]);
  });

  it.each(EDIT_STEP_IDS)(
    'fails at step %i with its own marker, and writes nothing from that step on',
    async (step) => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      const marker = failMarkerName(step);
      expect(marker).toBe(`.fail-at-${STEP_LABELS[step].toLowerCase()}`);
      writeFileSync(join(setup.jobDir, marker), '');
      const { outcome, steps } = await runOnce(setup);

      expect(outcome).toEqual({
        ok: false,
        error: `${STEP_LABELS[step]} failed: injected failure (${marker})`,
        step,
      });
      expect(steps.at(-1)?.[0]).toBe(step);
      expect(filesUnder(setup.editDir)).toEqual(
        FILES_BY_STEP.slice(0, step - 1)
          .flat()
          .sort(),
      );
    },
  );

  it('succeeds on retry once the marker is removed, carrying on from step 8', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const marker = join(setup.jobDir, '.fail-at-render');
    writeFileSync(marker, '');
    const failed = await runOnce(setup);
    expect(failed.outcome.ok).toBe(false);

    // The marker is still there: Retry fails again, at the same step.
    const again = await runOnce(setup, { mode: 'retry', step: 8 });
    expect(again.outcome).toMatchObject({ ok: false, step: 8 });

    rmSync(marker);
    const before = mtimes(setup.editDir);
    const retried = await runOnce(setup, { mode: 'retry', step: 8 });

    expect(retried.outcome).toEqual({ ok: true });
    expect(retried.steps).toEqual([[8, null]]);
    expect(filesUnder(setup.editDir)).toEqual(FILES_BY_STEP.flat().sort());
    const after = mtimes(setup.editDir);
    for (const [file, time] of Object.entries(before)) expect(after[file], file).toBe(time);
  });

  it('only looks at the marker for steps it actually runs', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    writeFileSync(join(setup.jobDir, '.fail-at-scan'), '');
    const { outcome, steps } = await runOnce(setup, { mode: 'retry', step: 8 });
    expect(outcome.ok).toBe(true);
    expect(steps).toEqual([[8, null]]);
  });

  it('ignores a marker inside edit/ (it belongs in the job folder)', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    mkdirSync(setup.editDir, { recursive: true });
    writeFileSync(join(setup.editDir, '.fail-at-render'), '');
    expect((await runOnce(setup)).outcome.ok).toBe(true);
  });
});

describe('modes', () => {
  it('start writes everything again; resume and retry keep what exists', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup);
    const stale = join(setup.editDir, 'takes_packed.md');
    writeFileSync(stale, 'STALE');

    for (const mode of ['resume', 'retry'] as const) {
      const { outcome } = await runOnce(setup, { mode, step: 1 });
      expect(outcome.ok).toBe(true);
      expect(readFileSync(stale, 'utf8'), mode).toBe('STALE');
    }

    const { outcome } = await runOnce(setup, { mode: 'start' });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(stale, 'utf8')).toMatch(/^# Packed transcripts/);
  });

  it('resume from step 6 skips steps 1 to 5 and makes only what is missing', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup);
    rmSync(join(setup.editDir, 'final.mp4'));
    rmSync(join(setup.editDir, 'verify/pass_2.jpg'));
    rmSync(join(setup.editDir, 'preview.mp4'));
    const before = mtimes(setup.editDir);

    const { outcome, steps } = await runOnce(setup, { mode: 'resume', step: 6 });

    expect(outcome.ok).toBe(true);
    expect(steps).toEqual([
      [6, null],
      [7, null],
      [7, 'pass 2/3'],
      [8, null],
    ]);
    expect(filesUnder(setup.editDir)).toEqual(FILES_BY_STEP.flat().sort());
    const after = mtimes(setup.editDir);
    for (const [file, time] of Object.entries(before)) expect(after[file], file).toBe(time);
  });

  it('resumes inside a step: only the transcripts that are missing are made', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup);
    rmSync(join(setup.editDir, 'transcripts/clip-02.json'));

    const { steps } = await runOnce(setup, { mode: 'resume', step: 2 });
    expect(steps.filter(([step]) => step === 2)).toEqual([
      [2, null],
      [2, '2/3'],
    ]);
    expect(existsSync(join(setup.editDir, 'transcripts/clip-02.json'))).toBe(true);
  });

  it('honours the number of graphics', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { steps } = await runOnce(setup, { graphics: 5 });
    expect(steps.filter(([step]) => step === 5).map(([, sub]) => sub)).toEqual([
      null,
      'graphics 1/5',
      'graphics 2/5',
      'graphics 3/5',
      'graphics 4/5',
      'graphics 5/5',
    ]);
    expect(filesUnder(join(setup.editDir, 'animations'))).toHaveLength(10);
  });
});

describe('abort', () => {
  it('returns at once, writing nothing, when the signal is already aborted', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const controller = new AbortController();
    controller.abort();
    const { outcome, reports } = await runOnce(setup, { controller });

    expect(outcome.ok).toBe(false);
    expect(reports).toEqual([]);
    expect(existsSync(setup.editDir)).toBe(false);
  });

  it('stops within a moment when aborted during a step at the real pace', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const controller = new AbortController();
    let abortedAt = 0;
    const { outcome, steps } = await runOnce(setup, {
      speed: 1,
      controller,
      // Abort as the first transcript starts: the run would otherwise sit there for 3 s.
      onReport: (report) => {
        if (report.sub === '1/3') {
          setTimeout(() => {
            abortedAt = Date.now();
            controller.abort();
          }, 20);
        }
      },
    });

    expect(outcome.ok).toBe(false);
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(steps.at(-1)).toEqual([2, '1/3']);
    expect(filesUnder(setup.editDir)).toEqual([]);
  });

  it('kills ffmpeg on abort and returns only after it has exited', async () => {
    const setup = makeInbox();
    const scripts = tempDir();
    const pidFile = join(scripts, 'pid');
    const bin = fakeFfmpeg(scripts, `echo $$ > "${pidFile}"\nexec sleep 30`);
    const controller = new AbortController();

    const running = runOnce(setup, { ffmpegBin: bin, controller });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5_000 });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(isAlive(pid)).toBe(true);

    controller.abort();
    const { outcome } = await running;

    expect(outcome.ok).toBe(false);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(join(setup.editDir, 'preview.mp4'))).toBe(false);
    expect(filesUnder(setup.editDir)).not.toContain('final.mp4');
  });

  it('sends SIGKILL to an ffmpeg that ignores SIGTERM', async () => {
    const setup = makeInbox();
    const scripts = tempDir();
    const pidFile = join(scripts, 'pid');
    const bin = fakeFfmpeg(scripts, `trap '' TERM\necho $$ > "${pidFile}"\nexec sleep 30`);
    const controller = new AbortController();

    const running = runOnce(setup, { ffmpegBin: bin, controller, killGraceMs: 100 });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5_000 });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());

    const abortedAt = Date.now();
    controller.abort();
    const { outcome } = await running;

    expect(outcome.ok).toBe(false);
    expect(isAlive(pid)).toBe(false);
    expect(Date.now() - abortedAt).toBeLessThan(3_000);
  });
});

describe('ffmpeg trouble', () => {
  it.each(['/no/such/dir/ffmpeg', 'no-such-ffmpeg-anywhere'])(
    'fails clearly, before writing anything, when ffmpeg is %s',
    async (ffmpegBin) => {
      const setup = makeInbox();
      const { outcome, reports } = await runOnce(setup, { ffmpegBin });

      expect(outcome).toMatchObject({ ok: false, step: 2 });
      expect((outcome as { error: string }).error).toMatch(
        /ffmpeg was not found.*brew install ffmpeg/,
      );
      expect(reports).toEqual([]);
      expect(existsSync(setup.editDir)).toBe(false);
    },
  );

  it("fails the step with ffmpeg's own message when ffmpeg exits with an error", async () => {
    const setup = makeInbox();
    const bin = fakeFfmpeg(tempDir(), 'echo "boom: no encoder" >&2\nexit 1');
    const { outcome, steps } = await runOnce(setup, { ffmpegBin: bin });

    expect(outcome).toEqual({
      ok: false,
      error: 'Preview failed: ffmpeg exited with code 1: boom: no encoder',
      step: 6,
    });
    expect(steps.at(-1)).toEqual([6, null]);
    expect(filesUnder(setup.editDir)).toEqual(FILES_BY_STEP.slice(0, 5).flat().sort());
    expect(readdirSync(setup.editDir).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('fails clearly when the job folder is gone', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    rmSync(setup.jobDir, { recursive: true });
    const { outcome } = await runOnce(setup);
    expect(outcome).toMatchObject({ ok: false, step: 2 });
    expect((outcome as { error: string }).error).toMatch(/job folder .* does not exist/);
  });
});

// With the Soundtrack switch on too, step 6 of a run that ends in Review makes the music: a plan
// that fits the cut, then the music script's fake path (a tone), and the composition plays it.
describe('a run that ends in Review with Soundtrack on', () => {
  const SAMPLE = { durationSec: 6, width: 1080, height: 1920 };
  const musicRecord = (editDir: string) =>
    musicRecordSchema.parse(JSON.parse(readFileSync(join(editDir, MUSIC_FILES.record), 'utf8')));

  /**
   * Writes the brief.json the Brief step would leave for a job whose instructions ask for music
   * (`music.wanted`, U21), before the edit starts: music is made only when it is asked for.
   */
  function askForMusic(editDir: string, music: Record<string, unknown> = {}): void {
    mkdirSync(editDir, { recursive: true });
    const draft = fakeBriefDraft({ client: 'Acme', name: 'Teaser' }, [], null);
    writeFileSync(
      join(editDir, 'brief.json'),
      JSON.stringify({
        schema: 1,
        fingerprint: 'abc',
        ...draft,
        music: {
          file: null,
          note: null,
          wanted: true,
          song: null,
          original: null,
          wantsTrending: false,
          ...music,
        },
      }),
    );
  }

  it('makes music v1 with the script’s fake path: plan, version, record and the file the composition plays', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    askForMusic(setup.editDir);
    const { outcome } = await runOnce(setup, { review: true, music: true });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    const plan = musicPlanSchema.parse(
      JSON.parse(readFileSync(join(setup.editDir, MUSIC_FILES.plan), 'utf8')),
    );
    expect(plan.lengthMs).toBe(6_000);
    const record = musicRecord(setup.editDir);
    expect(record).toMatchObject({ source: 'made', picked: 'v1', making: null, failure: null });
    expect(record.plan).toEqual(plan);
    expect(record.versions).toHaveLength(1);
    expect(record.versions[0]).toMatchObject({
      id: 'v1',
      by: 'edit',
      model: 'fake',
      lengthMs: 6_000,
    });
    expect(filesUnder(setup.editDir)).toEqual(
      expect.arrayContaining([
        'music/plan.json',
        'music/music.json',
        'music/v1.mp3',
        'preview/music.mp3',
      ]),
    );
    expect(
      readFileSync(join(setup.editDir, MUSIC_FILES.preview)).equals(
        readFileSync(join(setup.editDir, 'music', 'v1.mp3')),
      ),
    ).toBe(true);
  });

  // U21: music is made only when the job asks for it.
  describe('music only when asked', () => {
    const NOT_ASKED = 'Music was not asked for.';

    it('makes none for a job that asked for none: the plan, “no music” in the record and silence for the composition', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      const calls: (readonly string[])[] = [];
      const { outcome, steps } = await runOnce(setup, {
        review: true,
        music: true,
        musicRunner: async (call) => {
          calls.push(call.argv);
          return createMusicScriptRunner()(call);
        },
      });

      expect(outcome).toEqual({ ok: true, preview: SAMPLE });
      // One call, the script's own: no make, no song.
      expect(calls).toEqual([['none', setup.editDir, NOT_ASKED, '--plan']]);
      const plan = musicPlanSchema.parse(
        JSON.parse(readFileSync(join(setup.editDir, MUSIC_FILES.plan), 'utf8')),
      );
      expect(plan.lengthMs).toBe(6_000);
      const record = musicRecord(setup.editDir);
      expect(record).toMatchObject({
        source: 'none',
        reason: NOT_ASKED,
        picked: null,
        versions: [],
        making: null,
        failure: null,
      });
      expect(record.plan).toEqual(plan);
      expect(musicWasNotAsked(record)).toBe(true);
      expect(existsSync(join(setup.editDir, 'music', 'v1.mp3'))).toBe(false);
      // The composition has its music.mp3 (silence of the cut's length) and plays it.
      expect(existsSync(join(setup.editDir, MUSIC_FILES.preview))).toBe(true);
      expect(readFileSync(join(setup.editDir, 'preview', 'index.html'), 'utf8')).toContain(
        '<audio id="music" src="music.mp3"',
      );
      // It is no work to report: the step never says it is making music.
      expect(steps.some(([, sub]) => sub === 'making the music')).toBe(false);
    });

    it('makes none for a brief that asks for nothing, with Songs on too', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      askForMusic(setup.editDir, { wanted: false });
      const calls: string[] = [];
      await runOnce(setup, {
        review: true,
        music: true,
        songs: true,
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return createMusicScriptRunner()(call);
        },
      });
      expect(calls).toEqual(['none']);
      expect(musicRecord(setup.editDir)).toMatchObject({ source: 'none', picked: null });
    });

    it('makes v1 for a job whose brief asks for music, as before', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      askForMusic(setup.editDir);
      const calls: string[] = [];
      await runOnce(setup, {
        review: true,
        music: true,
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return createMusicScriptRunner()(call);
        },
      });
      expect(calls).toEqual(['make']);
      expect(musicRecord(setup.editDir)).toMatchObject({ source: 'made', picked: 'v1' });
    });

    it('leaves it alone on a resume, and does not make another for a job that still asks for none', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      await runOnce(setup, { review: true, music: true });
      const before = statSync(join(setup.editDir, MUSIC_FILES.record)).mtimeMs;
      const calls: string[] = [];
      await runOnce(setup, {
        review: true,
        music: true,
        mode: 'resume',
        step: 6,
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return createMusicScriptRunner()(call);
        },
      });
      expect(calls).toEqual([]);
      expect(statSync(join(setup.editDir, MUSIC_FILES.record)).mtimeMs).toBe(before);
    });

    it('makes the music on a resume once the brief asks for it (a note added since), replacing the silence', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      await runOnce(setup, { review: true, music: true });
      expect(musicRecord(setup.editDir)).toMatchObject({ source: 'none' });

      askForMusic(setup.editDir);
      await runOnce(setup, { review: true, music: true, mode: 'resume', step: 6 });

      const record = musicRecord(setup.editDir);
      expect(record).toMatchObject({ source: 'made', reason: null, picked: 'v1' });
      expect(record.versions).toHaveLength(1);
    });

    it('keeps the music the owner made in Review on a resume, whatever the brief says now', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      askForMusic(setup.editDir);
      await runOnce(setup, { review: true, music: true });
      askForMusic(setup.editDir, { wanted: false });
      const calls: string[] = [];
      await runOnce(setup, {
        review: true,
        music: true,
        mode: 'resume',
        step: 6,
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return createMusicScriptRunner()(call);
        },
      });
      expect(calls).toEqual([]);
      expect(musicRecord(setup.editDir)).toMatchObject({ source: 'made', picked: 'v1' });
    });

    it('still asks for a song that cannot be got: the made track is the stated wish', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      askForMusic(setup.editDir, {
        wanted: false,
        song: {
          title: 'Fail Song',
          artist: 'Nobody',
          version: null,
          link: null,
          fromFile: 'IMG_1.PNG',
        },
      });
      const calls: string[] = [];
      await runOnce(setup, {
        review: true,
        music: true,
        songs: true,
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return call.argv[0] === 'song'
            ? {
                kind: 'ran',
                exitCode: 3,
                signal: null,
                line: { ok: false, code: 'unavailable', message: 'The downloader didn’t answer' },
                stderr: '',
              }
            : createMusicScriptRunner()(call);
        },
      });
      expect(calls).toEqual(['song', 'make']);
      expect(musicRecord(setup.editDir)).toMatchObject({ source: 'made', picked: 'v1' });
    });

    it('does nothing about music with the switch off, asked for or not', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      askForMusic(setup.editDir);
      await runOnce(setup, { review: true, music: false });
      expect(existsSync(join(setup.editDir, 'music'))).toBe(false);
      expect(existsSync(join(setup.editDir, MUSIC_FILES.preview))).toBe(false);
    });
  });

  it('has the composition play music.mp3, quietly, over the whole cut', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup, { review: true, music: true });

    const html = readFileSync(join(setup.editDir, 'preview', 'index.html'), 'utf8');
    expect(html).toMatch(
      /<audio id="music" src="music.mp3" data-start="0" data-duration="6" data-track-index="3" data-volume="0\.\d+"><\/audio>/,
    );
  });

  it('says “making the music” on Preview (6) while it makes it', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    askForMusic(setup.editDir);
    const { steps, reports } = await runOnce(setup, { review: true, music: true });
    expect(steps.filter(([step]) => step === 6)).toEqual([
      [6, null],
      [6, 'making the music'],
    ]);
    // The composition is in place when it is reported; the music is not made yet.
    const making = reports.find((report) => report.sub === 'making the music');
    expect(making?.files).not.toContain('music/v1.mp3');
  });

  it('does nothing about music with the switch off', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { steps } = await runOnce(setup, { review: true, music: false });
    expect(steps.some(([, sub]) => sub === 'making the music')).toBe(false);
    expect(existsSync(join(setup.editDir, 'music'))).toBe(false);
    expect(existsSync(join(setup.editDir, MUSIC_FILES.preview))).toBe(false);
    expect(readFileSync(join(setup.editDir, 'preview', 'index.html'), 'utf8')).not.toContain(
      '<audio',
    );
  });

  it('makes no music for a run that delivers a video (the Review switch is off)', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup, { review: false, music: true });
    expect(existsSync(join(setup.editDir, 'music'))).toBe(false);
  });

  it('keeps the music on a resume: a second make would be a second version', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    askForMusic(setup.editDir);
    await runOnce(setup, { review: true, music: true });
    const before = statSync(join(setup.editDir, MUSIC_FILES.preview)).mtimeMs;

    await runOnce(setup, { review: true, music: true, mode: 'resume', step: 6 });

    expect(musicRecord(setup.editDir).versions).toHaveLength(1);
    expect(statSync(join(setup.editDir, MUSIC_FILES.preview)).mtimeMs).toBe(before);
  });

  it('makes the music a composition lacks on a resume (the run was stopped between the two)', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    askForMusic(setup.editDir);
    await runOnce(setup, { review: true, music: true });
    rmSync(join(setup.editDir, 'music'), { recursive: true });
    rmSync(join(setup.editDir, MUSIC_FILES.preview));

    await runOnce(setup, { review: true, music: true, mode: 'resume', step: 6 });

    expect(musicRecord(setup.editDir).picked).toBe('v1');
    expect(existsSync(join(setup.editDir, MUSIC_FILES.preview))).toBe(true);
  });

  it('goes on without music when the make fails: the run still ends in Review', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    askForMusic(setup.editDir);
    const { outcome } = await runOnce(setup, {
      review: true,
      music: true,
      musicRunner: async () => ({
        kind: 'ran',
        exitCode: 1,
        signal: null,
        line: { ok: false, code: 'failed', message: 'ffmpeg is not installed.' },
        stderr: '',
      }),
    });
    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(existsSync(join(setup.editDir, MUSIC_FILES.preview))).toBe(false);
  });

  // Songs (SG12): with the switch on too, a brief that asks for a song gets it with the `song` command.
  describe('with Songs on', () => {
    /** Writes the brief.json the Brief step would leave for the music ask, before the edit starts. */
    function writeBrief(editDir: string, music: unknown): void {
      mkdirSync(editDir, { recursive: true });
      const draft = fakeBriefDraft({ client: 'Acme', name: 'Teaser' }, [], null);
      writeFileSync(
        join(editDir, 'brief.json'),
        JSON.stringify({ schema: 1, fingerprint: 'abc', ...draft, music }),
      );
    }
    const songAsk = {
      file: null,
      note: null,
      wanted: false,
      song: {
        title: 'נתתי לך בית',
        artist: 'Ofek Adanek',
        version: 'sped up',
        link: null,
        fromFile: 'IMG_4412.PNG',
      },
      original: null,
      wantsTrending: false,
    };

    it('gets the song the brief asks for, with the plan in place first, and makes no tone of its own', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      writeBrief(setup.editDir, songAsk);
      const calls: { argv: readonly string[]; plan: boolean }[] = [];
      const { outcome } = await runOnce(setup, {
        review: true,
        music: true,
        songs: true,
        musicRunner: async (call) => {
          calls.push({
            argv: call.argv,
            plan: existsSync(join(setup.editDir, MUSIC_FILES.plan)),
          });
          return {
            kind: 'ran',
            exitCode: 0,
            signal: null,
            line: { ok: true, id: 'song', lengthMs: 6_000 },
            stderr: '',
          };
        },
      });
      expect(outcome).toEqual({ ok: true, preview: SAMPLE });
      expect(calls).toEqual([
        {
          argv: [
            ...['song', setup.editDir, '--title', 'נתתי לך בית', '--artist', 'Ofek Adanek'],
            ...['--version', 'sped up', '--from', 'screenshot', '--file', 'IMG_4412.PNG'],
            ...['--by', 'brief'],
          ],
          plan: true,
        },
      ]);
    });

    it('asks for a trending song when the brief does', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      writeBrief(setup.editDir, { ...songAsk, song: null, wantsTrending: true });
      const calls: string[][] = [];
      await runOnce(setup, {
        review: true,
        music: true,
        songs: true,
        musicRunner: async (call) => {
          calls.push([...call.argv]);
          return {
            kind: 'ran',
            exitCode: 0,
            signal: null,
            line: { ok: true, id: 'song', lengthMs: 6_000 },
            stderr: '',
          };
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.arrayContaining(['song', '--trending', '--by', 'editor']));
    });

    it('makes v1 as before when the song could not be got: the failure is the script’s to record', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      writeBrief(setup.editDir, songAsk);
      const calls: string[] = [];
      const { outcome } = await runOnce(setup, {
        review: true,
        music: true,
        songs: true,
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return call.argv[0] === 'song'
            ? {
                kind: 'ran',
                exitCode: 3,
                signal: null,
                line: { ok: false, code: 'unavailable', message: 'The downloader didn’t answer' },
                stderr: '',
              }
            : {
                kind: 'ran',
                exitCode: 0,
                signal: null,
                line: { ok: true, id: 'v1', lengthMs: 6_000 },
                stderr: '',
              };
        },
      });
      expect(outcome).toEqual({ ok: true, preview: SAMPLE });
      expect(calls).toEqual(['song', 'make']);
    });

    it('does not read the brief for a song with the switch off', async () => {
      skipWithoutFfmpeg();
      const setup = makeInbox();
      // The music is asked for as well; the song is not looked at.
      writeBrief(setup.editDir, { ...songAsk, wanted: true });
      const calls: string[] = [];
      await runOnce(setup, {
        review: true,
        music: true,
        songs: false,
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return {
            kind: 'ran',
            exitCode: 0,
            signal: null,
            line: { ok: true, id: 'v1', lengthMs: 6_000 },
            stderr: '',
          };
        },
      });
      expect(calls).toEqual(['make']);
    });
  });

  // Songs (RGM2): a revise run gets the song a note of the round asks for, with the `song` command,
  // as the real revise run does (music-revise-songs.md).
  describe('a revise run with Songs on', () => {
    const SONG_OK = {
      kind: 'ran',
      exitCode: 0,
      signal: null,
      line: { ok: true, id: 'song', lengthMs: 6_000 },
      stderr: '',
    } as const;
    const SONG_FAILED = {
      kind: 'ran',
      exitCode: 3,
      signal: null,
      line: { ok: false, code: 'unavailable', message: 'The downloader didn’t answer' },
      stderr: '',
    } as const;

    type RunOptions = NonNullable<Parameters<typeof runOnce>[1]>;
    /** An edit that ended in Review with its tone v1, and a round file with these notes (text at 0:00). */
    async function inRound(...notes: string[]) {
      const setup = makeInbox();
      askForMusic(setup.editDir);
      await runOnce(setup, { review: true, music: true });
      mkdirSync(join(setup.editDir, 'review'), { recursive: true });
      writeFileSync(
        join(setup.editDir, 'review', 'round-1.md'),
        `# Review notes, round 1: Teaser (Acme)\n\n${notes.map((note) => `- 0:00.0 — ${note}`).join('\n')}\n`,
      );
      return setup;
    }
    const revise = (setup: ReturnType<typeof makeInbox>, options: RunOptions) =>
      runOnce(setup, {
        review: true,
        music: true,
        songs: true,
        step: 4,
        job: { runKind: 'revise', round: 1 },
        ...options,
      });

    it('gets the song a name note asks for, with the plan for the cut in place first', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound('Use Blinding Lights by The Weeknd instead.');
      const calls: { argv: readonly string[]; planMs: number }[] = [];
      const { outcome, steps } = await revise(setup, {
        musicRunner: async (call) => {
          const plan = JSON.parse(readFileSync(join(setup.editDir, MUSIC_FILES.plan), 'utf8'));
          calls.push({ argv: call.argv, planMs: plan.lengthMs });
          return SONG_OK;
        },
      });

      expect(outcome).toEqual({ ok: true, preview: SAMPLE });
      expect(calls).toEqual([
        {
          argv: [
            ...['song', setup.editDir, '--title', 'Blinding Lights', '--artist', 'The Weeknd'],
            ...['--from', 'note', '--by', 'you'],
          ],
          planMs: 6_000,
        },
      ]);
      // The composition is the round's, and the run says what it is waiting for on Preview.
      expect(readFileSync(join(setup.editDir, 'preview', 'index.html'), 'utf8')).toContain(
        '<title>Round 1</title>',
      );
      expect(steps.filter(([step]) => step === 6)).toEqual([
        [6, null],
        [6, 'getting the song'],
      ]);
    });

    it('gets the song a link note asks for', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound('Use the song from https://www.instagram.com/reel/x/ instead.');
      const calls: string[][] = [];
      await revise(setup, {
        musicRunner: async (call) => {
          calls.push([...call.argv]);
          return SONG_OK;
        },
      });
      expect(calls).toEqual([
        [
          ...['song', setup.editDir, '--link', 'https://www.instagram.com/reel/x/'],
          ...['--from', 'note', '--by', 'you'],
        ],
      ]);
    });

    it('gets a trending song for the trending note, asked by you', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound('Use a trending song that fits the cut.');
      const calls: string[][] = [];
      await revise(setup, {
        musicRunner: async (call) => {
          calls.push([...call.argv]);
          return SONG_OK;
        },
      });
      expect(calls).toEqual([
        [
          ...['song', setup.editDir, '--trending', '--from', 'trending', '--by', 'you'],
          ...['--niche', '#fpv #fpvdrone'],
        ],
      ]);
    });

    it('makes one song call for each song note, in the round’s order, and none for the others', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound(
        'Make the title bigger.',
        'Use Skyline instead.',
        'Use a trending song that fits the cut.',
      );
      const calls: string[][] = [];
      await revise(setup, {
        musicRunner: async (call) => {
          calls.push([...call.argv]);
          return SONG_OK;
        },
      });
      expect(calls.map((argv) => argv.slice(0, 3))).toEqual([
        ['song', setup.editDir, '--title'],
        ['song', setup.editDir, '--trending'],
      ]);
    });

    it('leaves the music as it was when the song cannot be got, and still ends in Review', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound('Use Fail Song instead.');
      const music = join(setup.editDir, MUSIC_FILES.preview);
      const before = readFileSync(music);
      const recordBefore = readFileSync(join(setup.editDir, MUSIC_FILES.record), 'utf8');

      const { outcome } = await revise(setup, { musicRunner: async () => SONG_FAILED });

      expect(outcome).toEqual({ ok: true, preview: SAMPLE });
      expect(readFileSync(music).equals(before)).toBe(true);
      expect(readFileSync(join(setup.editDir, MUSIC_FILES.record), 'utf8')).toBe(recordBefore);
      expect(musicRecord(setup.editDir)).toMatchObject({ picked: 'v1', source: 'made' });
    });

    it('asks for nothing when the round has no song note: no call, no report, the plan as it was', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound('Make the title bigger.');
      const plan = join(setup.editDir, MUSIC_FILES.plan);
      const planBefore = statSync(plan).mtimeMs;
      const calls: string[] = [];
      const { steps } = await revise(setup, {
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return SONG_OK;
        },
      });
      expect(calls).toEqual([]);
      expect(steps.some(([, sub]) => sub === 'getting the song')).toBe(false);
      expect(statSync(plan).mtimeMs).toBe(planBefore);
    });

    it('keeps the edit run’s plan when it already fits the cut', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound('Use Skyline instead.');
      const plan = join(setup.editDir, MUSIC_FILES.plan);
      const planBefore = statSync(plan).mtimeMs;
      await revise(setup, { musicRunner: async () => SONG_OK });
      expect(statSync(plan).mtimeMs).toBe(planBefore);
    });

    it('asks for no song with the switch off, even when a note does', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound('Use Skyline instead.', 'Use a trending song that fits the cut.');
      const calls: string[] = [];
      const { outcome } = await revise(setup, {
        songs: false,
        musicRunner: async (call) => {
          calls.push(call.argv[0] ?? '');
          return SONG_OK;
        },
      });
      expect(outcome).toEqual({ ok: true, preview: SAMPLE });
      expect(calls).toEqual([]);
    });

    it('is stopped with the run: a stopped song call is a stopped run', async () => {
      skipWithoutFfmpeg();
      const setup = await inRound('Use Skyline instead.');
      const controller = new AbortController();
      const { outcome } = await revise(setup, {
        controller,
        musicRunner: async () => {
          controller.abort();
          return { kind: 'stopped', reason: 'cancel' };
        },
      });
      expect(outcome).toEqual({ ok: false, error: 'The fake edit was stopped.' });
    });
  });

  it('stops with the run: a stopped make is a stopped run', async () => {
    skipWithoutFfmpeg();
    const controller = new AbortController();
    const { outcome } = await runOnce(makeInbox(), {
      review: true,
      music: true,
      controller,
      musicRunner: async () => {
        controller.abort();
        return { kind: 'stopped', reason: 'cancel' };
      },
    });
    expect(outcome).toEqual({ ok: false, error: 'The fake edit was stopped.' });
  });

  it('a revise run keeps the music: the new composition plays the same file, unchanged', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    askForMusic(setup.editDir);
    await runOnce(setup, { review: true, music: true });
    const music = join(setup.editDir, MUSIC_FILES.preview);
    const before = { bytes: readFileSync(music), mtime: statSync(music).mtimeMs };
    mkdirSync(join(setup.editDir, 'review'), { recursive: true });
    writeFileSync(
      join(setup.editDir, 'review', 'round-1.md'),
      '# Review notes, round 1\n\n- 0:02: x\n',
    );

    const { outcome } = await runOnce(setup, {
      review: true,
      music: true,
      step: 4,
      job: { runKind: 'revise', round: 1 },
    });

    expect(outcome).toEqual({ ok: true, preview: SAMPLE });
    expect(readFileSync(music).equals(before.bytes)).toBe(true);
    expect(statSync(music).mtimeMs).toBe(before.mtime);
    expect(musicRecord(setup.editDir).versions).toHaveLength(1);
    const html = readFileSync(join(setup.editDir, 'preview', 'index.html'), 'utf8');
    expect(html).toContain('<title>Round 1</title>');
    expect(html).toContain('<audio id="music"');
  });
});

// With the Stock switch on, step 6 of a run that ends in Review gets a sound effect and a photo with
// the stock script's fake path (ST5): placeholder files, no key, no network.
describe('a run that ends in Review with Stock on', () => {
  const stockRecord = (editDir: string) =>
    stockRecordSchema.parse(JSON.parse(readFileSync(join(editDir, 'stock', 'stock.json'), 'utf8')));

  it('takes a sound effect and a photo, and records who made them', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    const { outcome } = await runOnce(setup, { review: true, stock: true });

    expect(outcome.ok).toBe(true);
    const record = stockRecord(setup.editDir);
    expect(record.items.map((item) => [item.id, item.source, item.license])).toEqual([
      ['sfx-1', 'openverse', 'by'],
      ['photo-1', 'unsplash', 'unsplash'],
    ]);
    expect(filesUnder(setup.editDir)).toEqual(
      expect.arrayContaining([
        'stock/stock.json',
        'stock/cache.json',
        'stock/sfx-1.wav',
        'stock/photo-1.jpg',
      ]),
    );
  });

  it('says “getting stock media” on Preview (6) while it does', async () => {
    skipWithoutFfmpeg();
    const { steps } = await runOnce(makeInbox(), { review: true, stock: true });
    expect(steps.filter(([step]) => step === 6)).toEqual([
      [6, null],
      [6, 'getting stock media'],
    ]);
  });

  it('keeps what a resumed run already has', async () => {
    skipWithoutFfmpeg();
    const setup = makeInbox();
    await runOnce(setup, { review: true, stock: true });
    const before = readFileSync(join(setup.editDir, 'stock', 'stock.json'), 'utf8');
    await runOnce(setup, { review: true, stock: true, mode: 'resume', step: 6 });
    expect(readFileSync(join(setup.editDir, 'stock', 'stock.json'), 'utf8')).toBe(before);
  });

  it('does nothing about stock with the switch off, or in a revise round', async () => {
    skipWithoutFfmpeg();
    const off = makeInbox();
    await runOnce(off, { review: true, stock: false });
    expect(existsSync(join(off.editDir, 'stock'))).toBe(false);

    const revise = makeInbox();
    await runOnce(revise, {
      review: true,
      stock: true,
      mode: 'start',
      job: { runKind: 'revise', round: 1 },
    });
    expect(existsSync(join(revise.editDir, 'stock'))).toBe(false);
  });
});

describe('the job log (Draft & chat)', () => {
  it('writes the lines a real run would, so the job chat fills as it goes', async () => {
    const setup = makeInbox();
    const logsDir = join(tempDir(), 'logs');
    const { outcome } = await runOnce(setup, { review: true, logsDir });
    expect(outcome.ok).toBe(true);

    const { FeedBuilder } = await import('../feed/feed-builder.js');
    const builder = new FeedBuilder({
      saveImage: () => undefined,
      readText: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
    });
    for (const line of readFileSync(join(logsDir, 'jobs', 'a1b2c3d4e5f6.log'), 'utf8').split(
      '\n',
    )) {
      builder.push(line);
    }
    const kinds = builder.items.map((item) =>
      item.kind === 'card' ? `card:${item.card.type}` : item.kind,
    );
    expect(kinds[0]).toBe('run');
    expect(kinds).toEqual(
      expect.arrayContaining([
        'text',
        'tools',
        'card:transcript',
        'card:plan',
        'card:cuts',
        'images',
      ]),
    );
    expect(builder.items[0]).toMatchObject({ run: 'draft', outcome: 'succeeded' });
  });
});
