// The fake runner (E7): a `Runner` that edits nothing and spends nothing, but writes the files a
// real video-use run writes, in the same order, at a pace of about a minute. It lets the whole UI
// be built and demoed (arriving -> queued -> editing through all 8 steps -> ready, and Failed +
// Retry) without tokens or real renders, and gives the tests a runner that behaves like a real one.
//
// Selected with `STUDIO_RUNNER=fake` (see `createRunner`). `STUDIO_FAKE_SPEED=10` makes a run ten
// times faster; the default whole edit is about 60 s.
//
// Step 1, Brief, is not the edit's: the fake Brief run (fake-brief.ts) writes edit/brief.json
// before this starts, as the Claude Brief run does for the real edit. What this writes into
// `<job>/edit/`, step by step (mirrors fixtures/stream/sample-run-tree.txt):
//
//   2 Transcribe  transcripts/<source>.json, one per video/audio file, sub "n/N"
//   3 Scan        takes_packed.md
//   4 Plan        project.md
//   5 Cut         edl.json, then animations/slot_N/index.html + render.mov, sub "graphics n/M"
//   6 Preview     preview.mp4 (ffmpeg test pattern)
//   7 Check       verify/pass_N.jpg for N = 1..3, sub "pass n/3"
//   8 Render      final.mp4 (ffmpeg test pattern + tone), written last
//
// With the Review switch on (W2) an edit run ends in Review and stops after Check: steps 2 to 7,
// where step 6 writes edit/preview/ (W9's sample composition, about 6 s, with the job's name as its
// title) instead of preview.mp4. There is no final.mp4, and `.fail-at-render` has nothing to fail.
//
// With the Soundtrack switch on too (`music`), step 6 also makes the job's music, but only when the job
// asks for it (U21): the brief says `music.wanted` (the fake Brief reads the owner's note and the job's text
// files for "add music"), or asks for a song. A job that asked for none gets the plan and the script's
// `none --plan` ("Music was not asked for.": no music, silence at music.mp3, nothing made). The music
// is made the way a real edit run does: edit/music/plan.json for the cut's length, then the music script's fake path
// (`make --fake`, a tone, no network) writes v1 and edit/preview/music.mp3, and the composition
// plays music.mp3 quietly. A revise run's new composition keeps the music that is playing. The
// render run's final.mp4 then has that file as its sound (the pick, or the silence of No music), as a
// real render of the composition does; without music.mp3, or with the switch off, it is the tone.
// With Songs on too (`songs`), a brief that asks for a song (a picture attached to the note, read by the
// fake Brief) gets it first, with the script's `song` command, as a real edit run does (fake-music.ts).
// A revise run with Songs on gets the song a round's note asks for the same way (RGM2, step 6).
//
// With the Stock switch on (`stock`), step 6 of an edit run also gets a sound effect and a photo
// through the stock script's fake path (`STUDIO_STOCK_FAKE=1`: placeholder files, no key, no
// network), so edit/stock/stock.json is there for whatever shows it (ST5, stock/fake-stock.ts).
//
// The other two runs of the Review loop (W3) are what the job's `runKind` says, and neither runs
// the Brief step. A revise run (after Send notes) does steps 4 to 7 over the edit that is there:
//
//   4 Plan        reads edit/review/round-N.md (written on Send; missing = fails here) and adds a
//                 "## Round N" section to project.md, one line per note, once
//   5 Cut         nothing is written: a revise touches no graphics
//   6 Preview     edit/preview/ is written again, titled "Round N"; with Songs on, each note that
//                 asks for a song ("Use [x] instead.", "Use the song from [link] instead.", "Use a
//                 trending song that fits the cut.") is one `song` call, `--from note --by you`
//                 (`--from trending --by you`), once the composition is in place (RGM2)
//   7 Check       verify/pass_N.jpg
//
// and ends in Review again with the new composition. A render run (after Approve) does step 8
// only: final.mp4 (it fails at 8 when edit/preview/index.html is gone), which the worker exports.
//
// With the lutsInEdits switch on and a note that names a LUT or a graphic (LU9), or an edit run
// (LU10: it is always told what its footage says about camera log), the run is given what the
// engine found (`context.libraryRefs`) and writes it to edit/library-refs.json before step 2 (or 4),
// so a test can assert what the editor would have been told.
//
// A job folder with a `.log-footage` file stands for log footage (LU10). With the lutsInEdits
// switch on, the Cut step then fails with "Waiting for a camera LUT: the clips are …" unless a
// Camera LUT matches the curve the files name (or a note names one), so the whole waiting flow can
// be driven without a real grade.
//
// Failure injection: an empty file named `.fail-at-<step>` in the JOB folder (not in `edit/`),
// e.g. `.fail-at-render`, `.fail-at-plan`, makes the run fail when it reaches that step (the fake
// Brief run honours `.fail-at-brief`). Remove the file and press Retry to see the job finish.
//
// Modes: `start` writes everything again, from Transcribe. `resume` and `retry` carry on from the
// job's step (Transcribe for a job still at Brief) and skip outputs that already exist.

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  CHECK_STEP,
  cameraLutWaitSentence,
  extraFinalName,
  extraFormatsOf,
  extraPreviewDirName,
  firstStepOf,
  type Job,
  MUSIC_FILES,
  PREVIEW_STEP,
  RENDER_STEP,
  type RunKind,
  STEP_IDS,
  STEP_LABELS,
  type StepId,
} from '@studio/shared';
import {
  getFakeRoundSongs,
  makeFakeMusic,
  makeFakeNoMusic,
  readFakeMusicWanted,
  readFakeNotAsked,
  readFakeSongAsk,
  songAsksOfRound,
} from '../music/fake-music.js';
import type { MusicScriptRunner } from '../music/music-script.js';
import { makeFakeStock } from '../stock/fake-stock.js';
import {
  edlJson,
  type FakeSource,
  fakeTranscript,
  listSources,
  projectMarkdown,
  roundSection,
  slotHtml,
  slotRender,
  takesPackedMarkdown,
} from './fake-content.js';
import {
  type FfmpegResult,
  type FfmpegTools,
  makeClip,
  makeStill,
  resolveFfmpeg,
} from './fake-media.js';
import { FAKE_PREVIEW_TEMPLATE_DIR, writeFakePreview } from './fake-preview.js';
import { FakeRunLog } from './fake-run-log.js';
import { readPreview } from './preview-composition.js';
import { type RunFinish, runFinishOf } from './run-finish.js';
import type { RunContext, RunMode, Runner, RunOutcome } from './runner.js';

/**
 * How long each step takes at speed 1, in milliseconds. Brief is the fake Brief run's one second
 * (fake-brief.ts); the edit's steps 2 to 8 add up to the minute they have always been.
 */
export const FAKE_STEP_MS: Readonly<Record<StepId, number>> = {
  1: 1_000,
  2: 9_000,
  3: 4_000,
  4: 8_000,
  5: 15_000,
  6: 7_000,
  7: 9_000,
  8: 8_000,
};

/** The first step this runner runs: the edit begins after the Brief step. */
export const FIRST_EDIT_STEP = 2 satisfies StepId;

/** The steps this runner runs, Transcribe to Render. */
export const EDIT_STEP_IDS: readonly StepId[] = STEP_IDS.filter((step) => step >= FIRST_EDIT_STEP);

/** The whole edit at speed 1: steps 2 to 8 (ffmpeg's own few hundred ms come on top). */
export const FAKE_EDIT_MS: number = EDIT_STEP_IDS.reduce(
  (total, step) => total + FAKE_STEP_MS[step],
  0,
);

/** Within Cut: the time for the EDL, and for all the graphics together. */
const CUT_EDL_MS = 3_000;
const CUT_GRAPHICS_MS = FAKE_STEP_MS[5] - CUT_EDL_MS;

/**
 * What the run's notes named in the library (`RunContext.libraryRefs`, LU9), written by the run
 * into the edit folder when there was any. Only the fake runner writes it.
 */
export const LIBRARY_REFS_FILE = 'library-refs.json';

/**
 * A file with this name in the JOB folder says the job's clips really are log footage (the fake
 * runner cannot measure frames the way the colour grade does). With the lutsInEdits switch on, the
 * Cut step then waits for a camera LUT, the way a real edit does, unless every curve the files name
 * has its Camera LUT or a note names one (LU10).
 */
export const LOG_FOOTAGE_MARKER = '.log-footage';

/** The self-check passes in the Check step. */
export const CHECK_PASSES = 3;

/** Share of a step that runs before an injected failure shows up. */
const FAILURE_AFTER = 0.4;

/** Prefix of the marker files: `.fail-at-render` fails the Render step. */
export const FAIL_MARKER_PREFIX = '.fail-at-';

/** The marker file name for a step, e.g. `.fail-at-render`. */
export function failMarkerName(step: StepId): string {
  return `${FAIL_MARKER_PREFIX}${STEP_LABELS[step].toLowerCase()}`;
}

/** Waits `ms` or until `signal` aborts, whichever comes first. Never rejects. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

export interface FakeRunnerOptions {
  /** The inbox folder; a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /**
   * Draft & chat (DR9): where the job logs are. Given, each run writes the lines a real run would
   * (fake-run-log.ts), so the job's chat fills as it goes. Left out (the default), no log is written.
   */
  logsDir?: string;
  /** How much faster than the default minute-long run to go. 1 (default) = about 60 s. Above 0. */
  speed?: number;
  /**
   * Call `context.progress` at every step and sub-step (default true). Turn it off once the
   * progress tracker (E4) derives the steps from the files alone.
   */
  reportProgress?: boolean;
  /** The ffmpeg executable: a bare name looked up on PATH (default `ffmpeg`) or a path. */
  ffmpegBin?: string;
  /** Length of the preview and the final video, in seconds. Default 4. */
  clipSeconds?: number;
  /** How many graphics the Cut step makes. Default 3. */
  graphics?: number;
  /** Time an ffmpeg process gets to exit after SIGTERM before SIGKILL, in ms. Default 3000. */
  killGraceMs?: number;
  /** Replaces the waiting, for tests that want to see the delays instead of living through them. */
  sleep?: Sleep;
  /** The Review switch: on, an edit run stops after Check (7) with a composition in edit/preview/ (W2). Default off. */
  review?: boolean;
  /** W9's sample composition (tests only). */
  previewTemplateDir?: string;
  /**
   * The Soundtrack switch (`Config.music`): on, step 6 of an edit run makes music v1 with the music
   * script's fake path and the composition plays it. Only for runs that end in Review. Default off.
   */
  music?: boolean;
  /**
   * The Songs switch (`Config.songs`, with music): step 6 first gets the song the brief asks for with
   * the music script's `song` command, and makes v1 only when there is none or it could not be got.
   * Default off.
   */
  songs?: boolean;
  /** Runs the music script (tests only). Default: the real script, with `--fake`, in the OS temp folder. */
  musicRunner?: MusicScriptRunner;
  /**
   * The Stock switch (`Config.stock`): on, step 6 of an edit run gets a sound effect and a photo
   * with the stock script's fake path (ST5). Only for runs that end in Review. Default off.
   */
  stock?: boolean;
  /** The stock script (tests only). Default: the engine's own, with `STUDIO_STOCK_FAKE=1`. */
  stockScript?: string;
}

/** What a run returns after an abort. The worker does not treat it as a failure. */
const STOPPED: RunOutcome = { ok: false, error: 'The fake edit was stopped.' };

/** Thrown inside a run when the signal fired; becomes `STOPPED`. */
class Stopped extends Error {}

/** Thrown inside a run for a failure at `step`; becomes `{ ok: false, error, step }`. */
class StepFailure extends Error {
  readonly step: StepId;

  constructor(step: StepId, message: string) {
    super(message);
    this.step = step;
  }
}

/** Everything one `start()` call needs, so the runner itself holds no per-run state. */
interface Run {
  job: Job;
  /** The kind of run (`job.runKind`): edit, revise (steps 4 to 7) or render (step 8). */
  kind: RunKind;
  context: RunContext;
  signal: AbortSignal;
  jobDir: string;
  editDir: string;
  /** Skip outputs that exist (`resume` / `retry`) instead of writing them again (`start`). */
  reuse: boolean;
  sources: FakeSource[];
  tools: FfmpegTools;
  /** The step being worked on, for errors that do not name one. */
  step: StepId;
  /** How the run ends: a composition in edit/preview/ (`preview`), or edit/final.mp4. */
  finish: RunFinish;
  /** The job log it writes to (Draft & chat); `null` without one. */
  log: FakeRunLog | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether every one of `paths` exists (true for none). */
async function allExist(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if (!(await exists(path))) return false;
  return true;
}

/** Writes a file in one move, so a reader never sees half of it. */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

export class FakeRunner implements Runner {
  private readonly inboxPath: string;
  private readonly speed: number;
  private readonly reportProgress: boolean;
  private readonly ffmpegBin: string;
  private readonly clipSeconds: number;
  private readonly graphics: number;
  private readonly killGraceMs: number;
  private readonly sleep: Sleep;
  private readonly review: boolean;
  private readonly previewTemplateDir: string;
  private readonly music: boolean;
  private readonly songs: boolean;
  private readonly musicRunner: MusicScriptRunner | undefined;
  private readonly stock: boolean;
  private readonly stockScript: string | undefined;
  private readonly logsDir: string | undefined;

  constructor({
    inboxPath,
    logsDir,
    speed = 1,
    reportProgress = true,
    ffmpegBin = 'ffmpeg',
    clipSeconds = 4,
    graphics = 3,
    killGraceMs = 3_000,
    sleep = realSleep,
    review = false,
    previewTemplateDir = FAKE_PREVIEW_TEMPLATE_DIR,
    music = false,
    songs = false,
    musicRunner,
    stock = false,
    stockScript,
  }: FakeRunnerOptions) {
    if (!(Number.isFinite(speed) && speed > 0)) {
      throw new RangeError(`The fake runner's speed must be a number above 0 (got ${speed}).`);
    }
    if (!(Number.isFinite(clipSeconds) && clipSeconds > 0)) {
      throw new RangeError(`clipSeconds must be a number above 0 (got ${clipSeconds}).`);
    }
    if (!Number.isInteger(graphics) || graphics < 1) {
      throw new RangeError(`graphics must be a whole number of at least 1 (got ${graphics}).`);
    }
    this.inboxPath = inboxPath;
    this.speed = speed;
    this.reportProgress = reportProgress;
    this.ffmpegBin = ffmpegBin;
    this.clipSeconds = clipSeconds;
    this.graphics = graphics;
    this.killGraceMs = killGraceMs;
    this.sleep = sleep;
    this.review = review;
    this.previewTemplateDir = previewTemplateDir;
    this.music = music;
    this.songs = music && songs;
    this.musicRunner = musicRunner;
    this.stock = stock;
    this.stockScript = stockScript;
    this.logsDir = logsDir;
  }

  async start(job: Job, mode: RunMode, context: RunContext): Promise<RunOutcome> {
    const { signal } = context;
    if (signal.aborted) return STOPPED;

    const kind = job.runKind;
    // Brief is the Brief step's: an edit begins at Transcribe, a revise run at Plan, a render run
    // at Render. A fresh run (or a job still at step 1) begins there.
    const kindFirst: StepId = kind === 'edit' ? FIRST_EDIT_STEP : firstStepOf(kind);
    const firstStep: StepId =
      mode === 'start' || job.step === null || job.step < kindFirst ? kindFirst : job.step;
    const jobDir = join(this.inboxPath, job.relPath);
    const finish = runFinishOf(kind, this.review);
    // A run that ends in Review stops after Check; there is no Render.
    const lastStep: StepId = finish === 'preview' ? CHECK_STEP : RENDER_STEP;
    const run: Run = {
      job,
      kind,
      context,
      signal,
      jobDir,
      editDir: join(jobDir, 'edit'),
      reuse: mode !== 'start',
      sources: [],
      tools: { bin: '', signal, killGraceMs: this.killGraceMs },
      step: firstStep,
      finish,
      log:
        this.logsDir === undefined
          ? null
          : await FakeRunLog.start(this.logsDir, job.id, { mode, runKind: kind, cwd: jobDir }),
    };
    const outcome = await this.runAll(run, firstStep, lastStep);
    if (run.log !== null) {
      await run.log.end(
        outcome.ok ? 'succeeded' : signal.aborted ? 'cancelled' : 'failed',
        outcome.ok || signal.aborted ? undefined : outcome.error,
      );
    }
    return outcome;
  }

  private async runAll(run: Run, firstStep: StepId, lastStep: StepId): Promise<RunOutcome> {
    const { signal, finish } = run;
    try {
      await this.prepare(run);
      for (const step of EDIT_STEP_IDS) {
        if (step < firstStep || step > lastStep) continue;
        await this.runStep(run, step);
      }
      if (signal.aborted) return STOPPED;
      if (finish === 'final') return { ok: true };
      // The composition is the result, and it is read the way the real runner reads it.
      const check = await readPreview(run.jobDir, run.job.formats);
      if (check.ok) return { ok: true, preview: check.preview };
      return { ok: false, error: `Preview failed: ${check.problem}`, step: PREVIEW_STEP };
    } catch (error) {
      if (error instanceof Stopped || signal.aborted) return STOPPED;
      if (error instanceof StepFailure)
        return { ok: false, error: error.message, step: error.step };
      return {
        ok: false,
        error: `${STEP_LABELS[run.step]} failed: ${describeError(error)}`,
        step: run.step,
      };
    }
  }

  // --- before the first step -------------------------------------------------------------------

  private async prepare(run: Run): Promise<void> {
    if (!(await exists(run.jobDir))) {
      throw new StepFailure(run.step, `The job folder ${run.jobDir} does not exist.`);
    }

    const bin = await resolveFfmpeg(this.ffmpegBin);
    if (bin === null) {
      throw new StepFailure(
        run.step,
        `ffmpeg was not found (looked for "${this.ffmpegBin}"). The fake runner needs it to make its test videos: install it (brew install ffmpeg) and make sure it is on PATH.`,
      );
    }
    run.tools.bin = bin;

    run.sources = await listSources(run.jobDir);
    await mkdir(run.editDir, { recursive: true });
    // LUTs named in the notes (LU9): the real runner puts them in the prompt, this one writes them
    // down so a test or an e2e run can see what the run was told. Only when it was told something.
    if (run.context.libraryRefs !== undefined) {
      await writeAtomic(
        join(run.editDir, LIBRARY_REFS_FILE),
        `${JSON.stringify(run.context.libraryRefs, null, 2)}\n`,
      );
    }
    this.checkStopped(run);
  }

  // --- the steps -------------------------------------------------------------------------------

  private async runStep(run: Run, step: StepId): Promise<void> {
    run.step = step;
    this.checkStopped(run);
    this.report(run, step, null);
    await this.injectedFailure(run, step);

    await this.doStep(run, step);
    await this.stepDone(run, step);
  }

  private async doStep(run: Run, step: StepId): Promise<void> {
    switch (step) {
      case 1:
        // The Brief step is fake-brief.ts's; the loop never gets here.
        return;
      case 2:
        return this.transcribe(run);
      case 3:
        return this.scan(run);
      case 4:
        return run.kind === 'revise' ? this.planRound(run) : this.plan(run);
      case 5:
        // A revise run touches no graphics.
        if (run.kind === 'revise') return this.pause(run, FAKE_STEP_MS[5]);
        await this.cameraWait(run);
        return this.cut(run);
      case 6:
        return run.finish === 'preview' ? this.previewComposition(run) : this.preview(run);
      case 7:
        return this.check(run);
      case 8:
        return this.render(run);
    }
  }

  /** Draft & chat: what the step leaves in the job log, as a real run's lines would. */
  private async stepDone(run: Run, step: StepId): Promise<void> {
    const log = run.log;
    if (log === null) return;
    const edit = run.editDir;
    switch (step) {
      case 2:
        log.say('I’ve looked at the folder. Transcribing the footage first.');
        log.command('Transcribe the footage', 'python helpers/transcribe_batch.py edit');
        return;
      case 3:
        log.command('Pack the transcripts', 'python helpers/pack_transcripts.py --edit-dir edit');
        return;
      case 4:
        log.say('I have the transcript. Writing the plan.');
        log.wrote(join(edit, 'project.md'));
        return;
      case 5:
        if (run.kind !== 'revise') log.wrote(join(edit, 'edl.json'));
        log.say('The cut is laid out. Building the preview next.');
        return;
      case 6:
        log.command('Lint the preview composition', 'npx hyperframes lint edit/preview');
        return;
      case 7:
        for (let pass = 1; pass <= CHECK_PASSES; pass += 1) {
          await log.looked(join(edit, 'verify', `pass_${pass}.jpg`));
        }
        log.say(run.finish === 'preview' ? 'Cut is ready for review.' : 'Checked; rendering now.');
        return;
      case 8:
        log.command('Render the final video', 'npx hyperframes render edit/preview');
        return;
    }
  }

  private async transcribe(run: Run): Promise<void> {
    const { sources } = run;
    if (sources.length === 0) {
      await this.pause(run, FAKE_STEP_MS[2]);
      return;
    }
    const each = FAKE_STEP_MS[2] / sources.length;
    for (const [index, source] of sources.entries()) {
      const target = join(run.editDir, 'transcripts', `${source.name}.json`);
      if (await this.alreadyThere(run, target)) continue;
      this.report(run, 2, `${index + 1}/${sources.length}`);
      await this.pause(run, each);
      await writeAtomic(target, `${JSON.stringify(fakeTranscript(source, index), null, 2)}\n`);
    }
  }

  private async scan(run: Run): Promise<void> {
    const target = join(run.editDir, 'takes_packed.md');
    if (await this.alreadyThere(run, target)) return;
    await this.pause(run, FAKE_STEP_MS[3]);
    await writeAtomic(target, takesPackedMarkdown(run.sources));
  }

  private async plan(run: Run): Promise<void> {
    const target = join(run.editDir, 'project.md');
    if (await this.alreadyThere(run, target)) return;
    await this.pause(run, FAKE_STEP_MS[4]);
    await writeAtomic(
      target,
      projectMarkdown({
        client: run.job.client,
        jobName: run.job.name,
        sources: run.sources,
        graphics: this.graphics,
        date: new Date().toISOString().slice(0, 10),
      }),
    );
  }

  /**
   * Step 4 of a revise run: reads the round file the engine wrote on Send and adds its
   * "## Round N" section to project.md, once (a retry finds it there and leaves it).
   */
  private async planRound(run: Run): Promise<void> {
    const { round } = run.job;
    let notes: string;
    try {
      notes = await readFile(join(run.editDir, 'review', `round-${round}.md`), 'utf8');
    } catch {
      throw new StepFailure(
        4,
        `${STEP_LABELS[4]} failed: edit/review/round-${round}.md is missing`,
      );
    }
    await this.pause(run, FAKE_STEP_MS[4]);
    const target = join(run.editDir, 'project.md');
    let before = '';
    try {
      before = await readFile(target, 'utf8');
    } catch {
      // No plan yet: the section is all there is.
    }
    if (new RegExp(`^## Round ${round}$`, 'm').test(before)) return;
    await writeAtomic(target, `${before.trimEnd()}\n\n${roundSection(round, notes)}`);
  }

  /**
   * Step 5 of an edit run on log footage (`.log-footage` in the job folder) with no camera LUT: the
   * colour grade would block, so the run fails with the sentence of a job that waits for one
   * (LU10). A curve the files name that the library has exactly one Camera LUT for, or a Camera LUT
   * a note names, lets the run go on.
   */
  private async cameraWait(run: Run): Promise<void> {
    const camera = run.context.libraryRefs?.camera;
    if (camera === undefined || camera.byNote) return;
    if (!(await exists(join(run.jobDir, LOG_FOOTAGE_MARKER)))) return;
    const unmatched = camera.curves.find((entry) => entry.match.kind !== 'one');
    if (camera.curves.length > 0 && unmatched === undefined) return;
    throw new StepFailure(
      5,
      unmatched === undefined
        ? cameraLutWaitSentence({ curve: null })
        : cameraLutWaitSentence({
            curve: unmatched.curve,
            source: unmatched.files[0] ?? null,
            several: unmatched.match.kind === 'several',
          }),
    );
  }

  private async cut(run: Run): Promise<void> {
    const slots = Array.from({ length: this.graphics }, (_, index) => index + 1);
    const slotDir = (slot: number): string => join(run.editDir, 'animations', `slot_${slot}`);

    const edl = join(run.editDir, 'edl.json');
    if (!(await this.alreadyThere(run, edl))) {
      await this.pause(run, CUT_EDL_MS);
      await writeAtomic(
        edl,
        edlJson({
          sources: run.sources,
          overlays: slots.map((slot) => join(slotDir(slot), 'render.mov')),
          clipSeconds: this.clipSeconds,
        }),
      );
    }

    for (const slot of slots) {
      const render = join(slotDir(slot), 'render.mov');
      if (await this.alreadyThere(run, render)) continue;
      this.report(run, 5, `graphics ${slot}/${slots.length}`);
      await writeAtomic(join(slotDir(slot), 'index.html'), slotHtml(slot));
      await this.pause(run, CUT_GRAPHICS_MS / slots.length);
      await writeAtomic(render, slotRender(slot));
    }
  }

  private async preview(run: Run): Promise<void> {
    const target = join(run.editDir, 'preview.mp4');
    if (await this.alreadyThere(run, target)) return;
    await this.pause(run, FAKE_STEP_MS[6]);
    await this.ffmpeg(
      run,
      makeClip(run.tools, target, { seconds: this.clipSeconds, pattern: 'testsrc2', toneHz: 330 }),
    );
  }

  /**
   * Step 6 of a run that ends in Review: the sample composition. An edit run titles it with the
   * job's name and keeps one that is already there on a resume. A revise run always writes it
   * again, since an earlier round's composition is there, and titles it "Round N". With the
   * Soundtrack switch on the composition plays music.mp3 (a revise run's keeps the one playing,
   * or the song a note of the round asks for, with Songs on), and an edit run that has none yet
   * makes it.
   */
  private async previewComposition(run: Run): Promise<void> {
    const revise = run.kind === 'revise';
    const kept =
      !revise && (await this.alreadyThere(run, join(run.editDir, 'preview', 'index.html')));
    if (!kept) {
      await this.pause(run, FAKE_STEP_MS[6]);
      const title = revise ? `Round ${run.job.round}` : run.job.name;
      await writeFakePreview(run.editDir, title, this.previewTemplateDir, { music: this.music });
      this.checkStopped(run);
    }
    // Formats (GN7): one more composition per extra format, the same cut at that format's size.
    for (const format of extraFormatsOf(run.job.formats)) {
      const index = join(run.editDir, extraPreviewDirName(format.id), 'index.html');
      if (!revise && (await this.alreadyThere(run, index))) continue;
      await writeFakePreview(
        run.editDir,
        revise ? `Round ${run.job.round}` : run.job.name,
        this.previewTemplateDir,
        {
          dirName: extraPreviewDirName(format.id),
          size: { width: format.width, height: format.height },
        },
      );
      this.checkStopped(run);
    }
    if (this.music && !revise) await this.makeMusic(run);
    if (this.songs && revise) await this.songsOfRound(run);
    if (this.stock && !revise) await this.getStock(run);
  }

  /**
   * Gets the job's stock media (ST5): a sound effect and a photo, through the stock script's fake
   * path, unless the job has some. A call that fails leaves the run going without it.
   */
  private async getStock(run: Run): Promise<void> {
    this.report(run, 6, 'getting stock media');
    await makeFakeStock({ editDir: run.editDir, signal: run.signal, script: this.stockScript });
    this.checkStopped(run);
  }

  /**
   * Gets the song each note of the round asks for, once the round's composition is in place (its
   * length is the cut's): the real revise run's `song` calls, `--from note --by you`
   * (music-revise-songs.md). A song that cannot be got leaves the music as it was, and the run goes
   * on. A round without a song note, or without its file, does nothing.
   */
  private async songsOfRound(run: Run): Promise<void> {
    let notes: string;
    try {
      notes = await readFile(join(run.editDir, 'review', `round-${run.job.round}.md`), 'utf8');
    } catch {
      return;
    }
    const asks = songAsksOfRound(notes);
    if (asks.length === 0) return;
    const check = await readPreview(run.jobDir);
    if (!check.ok) return;
    this.report(run, 6, 'getting the song');
    await getFakeRoundSongs({
      editDir: run.editDir,
      lengthMs: Math.round(check.preview.durationSec * 1000),
      asks,
      signal: run.signal,
      run: this.musicRunner,
    });
    this.checkStopped(run);
  }

  /**
   * Makes music v1 for the composition just written (the cut's length is its own), unless the
   * composition already plays some, and only when the job asks for it (U21): the brief says
   * `music.wanted`, or asks for a song. A job that asked for none gets the plan and the script's
   * `none --plan` ("Music was not asked for."): nothing is made, and Make music in Review has a plan.
   * A make that fails leaves the run going without music, as a real run does: the failure is in
   * music.json.
   */
  private async makeMusic(run: Run): Promise<void> {
    // Songs: the song the brief asks for, got before any music is made; a brief that says
    // "Original audio" asks for a note after the make instead (a brief with no song asks for none).
    const song = this.songs ? await readFakeSongAsk(run.editDir) : null;
    const asked = song !== null || (await readFakeMusicWanted(run.editDir));
    if (await exists(join(run.editDir, MUSIC_FILES.preview))) {
      // Music, or the silence of a job that asked for none, is in place from an earlier run. Only a
      // job that asked for none and whose brief now asks for some (a note added since) gets it.
      if (!(asked && (await readFakeNotAsked(run.editDir)))) return;
    }
    const check = await readPreview(run.jobDir);
    if (!check.ok) return;
    const lengthMs = Math.round(check.preview.durationSec * 1000);
    if (!asked) {
      await makeFakeNoMusic({
        editDir: run.editDir,
        lengthMs,
        signal: run.signal,
        run: this.musicRunner,
      });
      this.checkStopped(run);
      return;
    }
    this.report(run, 6, 'making the music');
    await makeFakeMusic({
      editDir: run.editDir,
      lengthMs,
      signal: run.signal,
      run: this.musicRunner,
      song,
    });
    this.checkStopped(run);
  }

  private async check(run: Run): Promise<void> {
    for (let pass = 1; pass <= CHECK_PASSES; pass += 1) {
      const target = join(run.editDir, 'verify', `pass_${pass}.jpg`);
      if (await this.alreadyThere(run, target)) continue;
      this.report(run, 7, `pass ${pass}/${CHECK_PASSES}`);
      await this.pause(run, FAKE_STEP_MS[7] / CHECK_PASSES);
      await this.ffmpeg(run, makeStill(run.tools, target, 'testsrc2'));
    }
  }

  private async render(run: Run): Promise<void> {
    // A render run renders the approved composition, so it needs one.
    if (run.kind === 'render' && !(await exists(join(run.editDir, 'preview', 'index.html')))) {
      throw new StepFailure(
        RENDER_STEP,
        `${STEP_LABELS[RENDER_STEP]} failed: edit/preview/index.html is missing`,
      );
    }
    const target = join(run.editDir, 'final.mp4');
    // Formats (GN7): a render run of a job with more formats makes a video of each.
    const extras =
      run.kind === 'render'
        ? extraFormatsOf(run.job.formats).map((format) =>
            join(run.editDir, extraFinalName(format.id)),
          )
        : [];
    if ((await this.alreadyThere(run, target)) && (await allExist(extras))) return;
    await this.pause(run, FAKE_STEP_MS[RENDER_STEP]);
    // With Soundtrack on, the final carries the music the composition plays: edit/preview/music.mp3,
    // the pick (a real render of the composition has it too); without it, the usual tone.
    const music = join(run.editDir, MUSIC_FILES.preview);
    const audioFile = this.music && (await exists(music)) ? music : undefined;
    await this.ffmpeg(
      run,
      makeClip(run.tools, target, {
        seconds: this.clipSeconds,
        pattern: 'testsrc',
        toneHz: 440,
        audioFile,
      }),
    );
    for (const extra of extras) {
      await this.ffmpeg(
        run,
        makeClip(run.tools, extra, {
          seconds: this.clipSeconds,
          pattern: 'testsrc2',
          toneHz: 440,
          audioFile,
        }),
      );
    }
  }

  // --- helpers ---------------------------------------------------------------------------------

  private report(run: Run, step: StepId, sub: string | null): void {
    if (this.reportProgress) run.context.progress(step, sub);
  }

  /** True when `resume`/`retry` finds this output already written and leaves it alone. */
  private async alreadyThere(run: Run, target: string): Promise<boolean> {
    return run.reuse && (await exists(target));
  }

  private checkStopped(run: Run): void {
    if (run.signal.aborted) throw new Stopped();
  }

  /** Waits for `ms` of fake work at the configured speed; throws `Stopped` if aborted meanwhile. */
  private async pause(run: Run, ms: number): Promise<void> {
    await this.sleep(ms / this.speed, run.signal);
    this.checkStopped(run);
  }

  /** Turns an ffmpeg outcome into "carry on", `Stopped` or a failure of the current step. */
  private async ffmpeg(run: Run, started: Promise<FfmpegResult>): Promise<void> {
    const result = await started;
    if (result.status === 'aborted') throw new Stopped();
    if (result.status === 'failed') {
      throw new StepFailure(run.step, `${STEP_LABELS[run.step]} failed: ${result.message}`);
    }
    this.checkStopped(run);
  }

  /** Fails the run at `step` when its marker file is in the job folder. */
  private async injectedFailure(run: Run, step: StepId): Promise<void> {
    const marker = failMarkerName(step);
    if (!(await exists(join(run.jobDir, marker)))) return;
    // Some of the step's time goes by first, so the UI shows the step before it fails.
    await this.pause(run, FAKE_STEP_MS[step] * FAILURE_AFTER);
    throw new StepFailure(step, `${STEP_LABELS[step]} failed: injected failure (${marker})`);
  }
}

/**
 * The speed from `STUDIO_FAKE_SPEED` (a number above 0; empty counts as unset), or `undefined` for
 * the default. Throws a readable error for anything else.
 */
export function fakeSpeedFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.STUDIO_FAKE_SPEED?.trim();
  if (raw === undefined || raw === '') return undefined;
  const speed = Number(raw);
  if (!(Number.isFinite(speed) && speed > 0)) {
    throw new Error(`STUDIO_FAKE_SPEED must be a number above 0 (got "${raw}").`);
  }
  return speed;
}

/** The fake runner `createRunner` hands out for `runner: 'fake'`; `STUDIO_FAKE_SPEED` sets its speed. */
export function createFakeRunner(
  {
    inboxPath,
    review,
    music,
    songs,
    stock,
    logsDir,
    draftChat,
  }: Pick<FakeRunnerOptions, 'inboxPath' | 'review' | 'music' | 'songs' | 'stock'> & {
    logsDir?: string;
    /** Draft & chat: the runs write the job log, so the chat fills (DR9). */
    draftChat?: boolean;
  },
  env: Record<string, string | undefined> = process.env,
): FakeRunner {
  return new FakeRunner({
    inboxPath,
    speed: fakeSpeedFromEnv(env),
    review,
    music,
    songs,
    stock,
    ...(draftChat === true && logsDir !== undefined ? { logsDir } : {}),
  });
}
