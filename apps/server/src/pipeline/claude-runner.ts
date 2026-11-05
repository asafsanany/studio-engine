// The real Runner (E3): one headless Claude Code run with the video-use skill per job.
//
//   claude -p <prompt> --output-format stream-json --verbose [--model <model>] [--effort <level>] ...E1's flags
//   cwd = <inbox>/<Client>/<Job>, stdin ignored, detached (its own process group)
//
// Run kinds (Phase 3, W3): the prompt follows the job's `runKind` (prompts.ts: an edit run has
// start/resume/retry.md, a revise run revise.md with the round it applies, a render run
// render.md). An edit and a revise run use `config.model` at the job's effort (`--effort`; Default
// is Extra high); a render run uses RENDER_MODEL (sonnet) at the CLI's default effort: it renders
// and checks the approved preview, it doesn't edit.
//
// A revise run with the Quick fixes switch on (QF4, `reviseRunOf` in @studio/shared) takes its model,
// effort and self-check from the job as it is when the run starts: the level chosen in Review
// (`job.reviewEffort`, the configured model, the full check), else the tier Send saved with Auto
// (`job.reviseTier`: Revise is Sonnet at High with the slim check, Full the configured model at Extra
// high), else the edit's effort as above. A retry or a resume of the run chooses the same, because
// it reads the same job. The `start` marker of the job log says which model and effort it was.
//
// A generated video (GN6): a job whose brief says `production: generate` has no footage, and its edit
// and revise prompts say so (prompts.ts: the `generated` and `generate-revise` parts, with the two
// scripts' paths and the budget, what is spent and what is left, read from the brief and from
// edit/generate/spend.json when the run starts). A revise run of such a job can make a new take of a
// clip or a voice line with the Generate step's two scripts, so it gets what they need and nothing
// more: the PATH of the env file (STUDIO_ENV_FILE, never a key), the voice id and a Bash timeout of
// 10 minutes (a clip waits for Higgsfield for up to about 9), and the key files are denied to its
// Read tool as they are to the Generate run. Every other run's command and environment are unchanged.
//
// How a run ends (docs/reference.md "Running edits" → "When is a run finished?"):
//   - success: the process exited 0 AND edit/final.mp4 exists. Only after the exit: final.mp4
//     appears minutes before the end and can be deleted and rendered again after the self-check.
//     A run that ends in Review (a revise run, or an edit run with the Review switch on,
//     `runFinishOf`) succeeds on exit 0 AND a valid edit/preview/index.html instead (`readPreview`:
//     its root element has data-composition-id, data-width, data-height and data-duration that
//     parse); the outcome carries the `preview` read from them. edit/final.mp4 does not count
//     for such a run.
//   - failure: anything else, with one readable line from failure.ts. A run that ends in Review
//     and exited 0 without a valid composition fails at Preview (6): "Finished without a preview".
//   - cancel: the worker's signal aborts -> the whole process tree gets SIGTERM, SIGKILL after
//     10 s (process-tree.ts). The worker records CANCEL; the runner only stops and settles.
//   - stopped: the same, when the abort's reason is the engine shutting down. The job log's
//     `end` marker says `stopped` instead of `cancelled` (CVP-89), so the two can be told apart;
//     the job stays `editing` and resumes at the next start.
//   - timeout: `runTimeoutMin` (default 90) -> stopped the same way, fails "Timed out ...".
// `start` resolves only once nothing of the run is left running.
//
// The ElevenLabs key is not in the run's environment (E1: it lives in ~/Developer/video-use/.env,
// read by video-use's transcribe helper), and neither is ANTHROPIC_API_KEY: every run uses the
// claude.ai plan login (claudeEnv). The environment is never logged.
//
// The Draft (Draft & chat, DR4): with `config.draftChat` on, an edit run's prompt is draft.md
// (`/video-use`, the owner's note, the job, the finish). Before it starts the runner writes
// edit/studio/notes.md (the rules the start prompt says inline, `buildStudioNotes`) and
// edit/studio/brief-schema.json (the brief's shape), and tells the prompt whether edit/brief.json is
// still the placeholder, so the Draft reads the instructions itself. Revise and render runs are as
// they were.
//
// Progress: every parsed stream event goes to the optional `track` hook, where E4's progress
// tracker plugs in (it gets the job folder and `progress` too). The runner itself infers no steps.

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  briefPromptSchema,
  DEFAULT_GENERATE_VOICE_ID,
  DRAFT_PENDING_BRIEF_SUMMARY,
  extraFinalName,
  extraFormatsOf,
  type Job,
  PREVIEW_STEP,
  reviseRunOf,
  runEffort,
  type StepId,
} from '@studio/shared';
import { type Config, envFilePath } from '../config.js';
import { GENERATE_ASSETS } from '../generate/generate-assets.js';
import { budgetOfGeneratedJob, readGeneratedJob, readSpentUsd } from '../generate/generated-job.js';
import { MUSIC_SCRIPT } from '../music/music-assets.js';
import { STOCK_SCRIPT } from '../stock/stock-assets.js';
import { jobRunUsage } from '../usage/app-usage.js';
import { BRIEF_STEP } from './brief-step.js';
import { type ClaudeBin, resolveClaudeBin } from './claude-bin.js';
import {
  claudeArgs,
  claudeEnv,
  type GenerateEnv,
  generateDenyRead,
  RENDER_MODEL,
  readDenyRulesOutsideJob,
  type StockEnv,
  stockDenyRead,
} from './claude-command.js';
import {
  errorText,
  isRequestedStop,
  KILL_GRACE_MS,
  type RequestedStop,
  type RunnerLogger,
  runClaudeProcess,
  SAMPLE_INTERVAL_MS,
  SILENT_LOGGER,
  StopControl,
  type StreamTracker,
  stopRequestedBy,
} from './claude-process.js';
import {
  describeFailure,
  describeMissingPreview,
  endsWaitingForCameraLut,
  FINISHED_WITHOUT_VIDEO,
  type RunEnd,
} from './failure.js';
import { type EndMarker, JobLog, jobLogPath, type RunEndOutcome, readLastEnd } from './job-log.js';
import { readPreview } from './preview-composition.js';
import { editProgressStep } from './progress-evidence.js';
import {
  buildPrompt,
  buildStudioNotes,
  type GeneratedPromptVars,
  PROMPTS_DIR,
  type PromptVars,
  STUDIO_BRIEF_SCHEMA_PATH,
  STUDIO_NOTES_PATH,
} from './prompts.js';
import { type RunFinish, runFinishOf } from './run-finish.js';
import { reapStaleRuns, runsDir } from './run-records.js';
import type { RunContext, RunMode, Runner, RunOutcome } from './runner.js';

export { KILL_GRACE_MS, type RunnerLogger } from './claude-process.js';

/**
 * What the runner reads from the config. `review` (the Review switch) is optional so a config built
 * without it is valid; missing means off. So are `graphicsInEdits` (the Graphics library in edits;
 * missing means off) and `graphics` (the Graphics switch; missing means on, as by default): edits
 * use the library only while both are on. So is `music` (the Soundtrack switch; missing means off):
 * on, the prompts get their music part and the music script's path. So are `songs` (the Songs
 * switch; missing means off) and `songTools`: songs on, with the music, adds the song lines to
 * those parts and gives the run STUDIO_YT_DLP and STUDIO_DENO for the script's `song` command (SG4).
 */
export type ClaudeRunnerConfig = Pick<
  Config,
  'inboxPath' | 'logsDir' | 'dataDir' | 'claudeBin' | 'model' | 'runTimeoutMin'
> &
  Partial<
    Pick<
      Config,
      'review' | 'graphics' | 'graphicsInEdits' | 'music' | 'quickFixes' | 'songs' | 'stock'
    >
  > &
  Partial<Pick<Config, 'songTools'>> &
  Partial<Pick<Config, 'generateBudgetUsd' | 'generateUsdPerCredit' | 'generateVoiceId'>> &
  Partial<Pick<Config, 'claudePlanOnly' | 'draftChat' | 'generate'>>;

/** One run, as the `track` hook sees it. */
export interface TrackedRun {
  readonly job: Job;
  readonly mode: RunMode;
  /** `<inbox>/<Client>/<Job>`, the run's working directory. */
  readonly jobDir: string;
  /** `<jobDir>/edit`, the video-use workspace (it may not exist yet). */
  readonly editDir: string;
  /** The Claude process (leader of its own process group). */
  readonly pid: number;
  /** Aborts when the run is cancelled or the engine stops. */
  readonly signal: AbortSignal;
  /** The worker's progress callback (cheap, never throws). */
  progress: RunContext['progress'];
  /** Transcribe's N from the brief, when the worker has one (`RunContext.transcribeTotal`). */
  readonly transcribeTotal?: number;
  /** How this run ends: `preview` for a run that ends in Review (W2). Left out: `final`. */
  readonly finish?: RunFinish;
}

/** What the `track` hook returns: E4's progress tracker for one run. */
export type RunTracker = StreamTracker;

export interface ClaudeRunnerOptions {
  config: ClaudeRunnerConfig;
  logger?: RunnerLogger;
  /** Called once per run, right after the process has started. */
  track?: (run: TrackedRun) => RunTracker | undefined;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  /** The server's environment (PATH, pass-through variables); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** SIGTERM -> SIGKILL grace. Default 10 s (architecture §6). */
  killGraceMs?: number;
  /** Overrides `config.runTimeoutMin` (tests). */
  timeoutMs?: number;
  /** How often the process tree is sampled while running. Default 3 s. */
  sampleIntervalMs?: number;
  /** Folder with start.md, resume.md, retry.md and unattended.md. */
  promptsDir?: string;
  /** The Generate step's two scripts, told to the revise run of a generated video; defaults to the engine's own (tests point them at others). */
  generateScripts?: { voice: string; shots: string };
  /** The env file whose PATH (never what is in it) a generated video's revise run gets; defaults to `envFilePath()`. */
  envFile?: string;
}

/** Whether edit/brief.json is still the placeholder the Draft writes over (DR4). */
async function briefIsPending(jobDir: string): Promise<boolean> {
  try {
    const brief: unknown = JSON.parse(await readFile(join(jobDir, 'edit', 'brief.json'), 'utf8'));
    return (
      typeof brief === 'object' &&
      brief !== null &&
      (brief as { summary?: unknown }).summary === DRAFT_PENDING_BRIEF_SUMMARY
    );
  } catch {
    return false;
  }
}

const CANCELLED: RunOutcome = { ok: false, error: 'Cancelled' };
const STOPPED: RunOutcome = { ok: false, error: 'Stopped because the engine shut down' };

function isVideoFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** The extra formats' videos (`edit/final-<id>.mp4`) a render run of this job still has not made. */
function missingFormatFinals(editDir: string, job: Pick<Job, 'formats'>): string[] {
  return extraFormatsOf(job.formats)
    .map((format) => extraFinalName(format.id))
    .filter((name) => !isVideoFile(join(editDir, name)))
    .map((name) => `edit/${name}`);
}

const REQUESTED_STOPS: Record<RequestedStop, RunOutcome> = {
  cancelled: CANCELLED,
  stopped: STOPPED,
};

type EndFields = Partial<Omit<EndMarker, 'type' | 'event' | 'at' | 'outcome' | 'error'>>;

/** Writes the `end` marker and logs the outcome; returns `result`. */
type EndRun = (outcome: RunEndOutcome, result: RunOutcome, fields?: EndFields) => RunOutcome;

export class ClaudeRunner implements Runner {
  private readonly config: ClaudeRunnerConfig;
  private readonly logger: RunnerLogger;
  private readonly track: ClaudeRunnerOptions['track'];
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private readonly killGraceMs: number;
  private readonly timeoutMs: number;
  private readonly sampleIntervalMs: number;
  private readonly promptsDir: string;
  private readonly generateScripts: { voice: string; shots: string };
  private readonly envFile: string;

  constructor(options: ClaudeRunnerOptions) {
    this.config = options.config;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.track = options.track;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.timeoutMs = options.timeoutMs ?? options.config.runTimeoutMin * 60_000;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.promptsDir = options.promptsDir ?? PROMPTS_DIR;
    this.generateScripts = options.generateScripts ?? {
      voice: GENERATE_ASSETS.voice,
      shots: GENERATE_ASSETS.shots,
    };
    this.envFile = options.envFile ?? envFilePath(this.env, this.home);
  }

  /** Whether the run may get a song: the Songs switch and the music it adds to (SG4). */
  private songsOn(): boolean {
    return this.config.songs === true && this.config.music === true;
  }

  /** The binary the next run will use (resolved on every run: desktop app updates move it). */
  resolveBin(): ClaudeBin | null {
    const configured = this.config.claudeBin;
    return resolveClaudeBin({
      home: this.home,
      pathEnv: this.env.PATH,
      // `claude` is the config default, i.e. "not set": look it up like the doctor does.
      configBin: configured === 'claude' ? undefined : configured,
    });
  }

  async start(job: Job, mode: RunMode, context: RunContext): Promise<RunOutcome> {
    if (context.signal.aborted) return REQUESTED_STOPS[stopRequestedBy(context.signal)];

    const control = new StopControl(this.killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(context.signal));
    context.signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    let log: JobLog | null = null;
    const end: EndRun = (outcome, result, fields = {}) => {
      const error = result.ok ? undefined : result.error;
      const durationMs = Date.now() - startedAt;
      log?.marker('end', {
        outcome,
        ...(error === undefined ? {} : { error }),
        exitCode: null,
        signal: null,
        sessionId: null,
        ...fields,
        durationMs,
      });
      const entry = { jobId: job.id, mode, outcome, error, durationMs };
      if (outcome === 'failed' || outcome === 'timed_out') {
        this.logger.warn(entry, 'edit run failed');
      } else {
        this.logger.info(entry, 'edit run ended');
      }
      return result;
    };

    try {
      log = await JobLog.open(jobLogPath(this.config.logsDir, job.id));
      return await this.run(job, mode, context, log, control, end);
    } catch (err) {
      // Anything unexpected (a prompt file missing, the log folder unwritable): a failed run.
      if (isRequestedStop(control.reason)) {
        return end(control.reason, REQUESTED_STOPS[control.reason]);
      }
      this.logger.error({ jobId: job.id, err }, 'edit run broke');
      return end('failed', { ok: false, error: `The edit could not run: ${errorText(err)}` });
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      await log?.close();
      if (log?.error) {
        this.logger.warn({ jobId: job.id, err: log.error }, 'could not write the job log');
      }
    }
  }

  /** Everything before the spawn: folder, leftovers, prompt, binary, the `start` marker. */
  private async run(
    job: Job,
    mode: RunMode,
    context: RunContext,
    log: JobLog,
    control: StopControl,
    end: EndRun,
  ): Promise<RunOutcome> {
    const jobDir = join(this.config.inboxPath, job.relPath);
    if (!existsSync(jobDir)) {
      return end('failed', { ok: false, error: `The job folder is missing: ${job.relPath}` });
    }

    const reaped = await reapStaleRuns(runsDir(this.config.dataDir), {
      graceMs: this.killGraceMs,
      // The other job editing beside this one keeps its run.
      forJob: job.id,
    });
    for (const stale of reaped) {
      this.logger.warn({ ...stale }, 'stopped a Claude run left over from an earlier engine');
      log.marker('reaped', { ...stale });
    }

    // RETRY clears the job's error, so the previous attempt's comes from this log. A retry with
    // no recorded failure (the run before it was cancelled, or it succeeded and only the export
    // failed) carries on like a resume.
    let promptMode: RunMode = mode;
    let previous: EndMarker | null = null;
    if (mode === 'retry') {
      previous = await readLastEnd(log.path);
      if (previous?.outcome !== 'failed' && previous?.outcome !== 'timed_out')
        promptMode = 'resume';
    }
    // Whether the run ends in Review or delivers final.mp4: the job's run kind and the Review switch.
    const finish = runFinishOf(job.runKind, this.config.review === true);
    // A revise run's model, effort and self-check (QF4): from the job as it is now, so a retry and a
    // resume choose the same. With the Quick fixes switch off a revise run is what it always was.
    const revise =
      job.runKind === 'revise' && this.config.quickFixes === true ? reviseRunOf(job) : null;
    const promptStep = await this.promptStep(job, promptMode, jobDir, finish);
    const generated = await this.generatedFor(job, jobDir);
    // The Draft (DR4): an edit run with Draft & chat on.
    const draft = this.config.draftChat === true && job.runKind === 'edit';
    const promptVars: PromptVars = {
      client: job.client,
      job: job.name,
      kind: job.runKind,
      round: job.round,
      step: promptStep,
      error: previous?.error,
      review: this.config.review === true,
      // The slim self-check of a Revise-tier round (QF4); everything else asks for the full one.
      ...(revise === null ? {} : { checks: revise.checks }),
      graphics: this.config.graphicsInEdits === true && this.config.graphics !== false,
      // LUTs named in the notes (LU9): resolved and copied into the job before the run started.
      ...(context.libraryRefs === undefined ? {} : { libraryRefs: context.libraryRefs }),
      // Formats (GN7): only a job with two or more carries them, so any other prompt is unchanged.
      ...(job.formats === undefined ? {} : { formats: job.formats }),
      // Generated videos (GN6): only a job whose brief says `production: generate` carries it.
      ...(generated === null ? {} : { generated }),
      // Soundtrack: the music part and the script it calls, only while the switch is on.
      ...(this.config.music === true ? { music: true, musicScript: MUSIC_SCRIPT } : {}),
      // Songs (SG4): the song lines of those parts, only while both switches are on.
      ...(this.songsOn() ? { songs: true } : {}),
      // Stock media (ST4): the stock part and the script it calls, only while the switch is on.
      ...(this.config.stock === true ? { stock: true, stockScript: STOCK_SCRIPT } : {}),
    };
    if (draft) {
      promptVars.draft = true;
      promptVars.note = job.note;
      promptVars.briefPending = await briefIsPending(jobDir);
      await this.writeStudioNotes(promptMode, promptVars, jobDir);
    }
    const prompt = await buildPrompt(promptMode, promptVars, this.promptsDir);

    const bin = this.resolveBin();
    if (bin === null) {
      return end('failed', {
        ok: false,
        error:
          'Claude Code was not found. Open the Claude desktop app once, or set "claudeBin" in ~/.studio-engine/config.json, then run `pnpm run doctor`.',
      });
    }

    // A render run renders and checks the approved preview, so it runs on Sonnet at the default
    // effort; the others use the configured model (an unset one leaves the CLI's own default) at
    // the effort the owner set on the job (none: Default, which is Extra high). A revise run with quick
    // fixes on may have its own (see `revise` above); a tier's `null` model is the configured one.
    const render = job.runKind === 'render';
    const model = render ? RENDER_MODEL : (revise?.model ?? this.config.model);
    const effort = render ? undefined : (revise?.effort ?? runEffort(job.effort));
    // The run reads only its own job folder: no other job, client, _Style, _Series or _Fonts (CVP-258).
    // A generated video's revise run may call the Generate step's scripts, which read their own keys:
    // it has no reason to open the files that hold them (GN6), as the Generate run has none.
    const generate: GenerateEnv | undefined =
      generated !== null && job.runKind === 'revise'
        ? {
            envFile: this.envFile,
            voiceId: this.config.generateVoiceId ?? DEFAULT_GENERATE_VOICE_ID,
            // What a Higgsfield plan credit is worth: the shots script books the connector's credits at it.
            ...(this.config.generateUsdPerCredit === undefined
              ? {}
              : { usdPerCredit: this.config.generateUsdPerCredit }),
          }
        : undefined;
    // Stock media (ST4): an edit or revise run may call the stock script, which reads its own keys.
    const stock: StockEnv | undefined =
      this.config.stock === true && !render ? { envFile: this.envFile } : undefined;
    const denyRead = [
      ...new Set([
        ...readDenyRulesOutsideJob(this.config.inboxPath, jobDir, { shared: true }),
        ...(generate === undefined ? [] : generateDenyRead(generate.envFile, this.home)),
        ...(stock === undefined ? [] : stockDenyRead(stock.envFile)),
      ]),
    ];
    // The revise run of a generated video retakes shots through the Higgsfield connector on the
    // plan's credits (U26), so it gets the connector's tools and the plan login.
    const args = claudeArgs({
      prompt,
      model,
      effort,
      denyRead,
      higgsfield: generate !== undefined,
    });
    // Every process of the run inherits this, so even one whose parent is gone can be found.
    const runTag = `${job.id}-${randomUUID()}`;
    log.marker('start', {
      jobId: job.id,
      relPath: job.relPath,
      mode,
      promptMode,
      runKind: job.runKind,
      finish,
      step: job.step,
      promptStep: promptStep ?? null,
      bin: bin.path,
      binSource: bin.source,
      cwd: jobDir,
      model: model ?? null,
      effort: effort ?? null,
      timeoutMs: this.timeoutMs,
      runTag,
      flags: args.slice(2),
      prompt,
    });
    if (isRequestedStop(control.reason)) {
      return end(control.reason, REQUESTED_STOPS[control.reason]);
    }

    return this.spawnAndWait({
      job,
      mode,
      context,
      log,
      control,
      end,
      bin,
      args,
      jobDir,
      runTag,
      finish,
      generate,
      stock,
    });
  }

  /**
   * The Draft's two files (DR4): edit/studio/notes.md, Studio Engine's rules for this edit, and
   * edit/studio/brief-schema.json, the shape of the brief it writes. Written before every Draft, so
   * they follow the switches and the job as they are now.
   */
  private async writeStudioNotes(mode: RunMode, vars: PromptVars, jobDir: string): Promise<void> {
    const notes = await buildStudioNotes(mode, vars, this.promptsDir);
    const schema = briefPromptSchema({
      music: this.config.music === true,
      songs: this.songsOn(),
      generate: this.config.generate === true,
    });
    await mkdir(join(jobDir, 'edit', 'studio'), { recursive: true });
    await writeFile(join(jobDir, STUDIO_NOTES_PATH), notes);
    await writeFile(join(jobDir, STUDIO_BRIEF_SCHEMA_PATH), `${schema}\n`);
  }

  /**
   * What the edit and the revise prompt of a generated video are told (GN6), or `null` for any other
   * job (and for a render run, which renders what was approved): the Generate step's two scripts, the
   * edit folder, the job's budget (the brief's own when it names one, else the one the Generate step stored on
   * the job, else the configured one) and what spend.json says is spent now, because a revise round may spend more.
   */
  private async generatedFor(job: Job, jobDir: string): Promise<GeneratedPromptVars | null> {
    if (job.runKind === 'render') return null;
    const brief = await readGeneratedJob(jobDir);
    if (brief === null) return null;
    return {
      voiceScript: this.generateScripts.voice,
      shotsScript: this.generateScripts.shots,
      editDir: join(jobDir, 'edit'),
      // A budget the brief names (the owner's "budget $4" note) wins over the one stored when the Generate
      // step started, so a note can give a job more money in a review round (C77).
      budgetUsd:
        brief.budgetUsd ??
        job.generate?.budgetUsd ??
        budgetOfGeneratedJob(brief, this.config.generateBudgetUsd),
      spentUsd: await readSpentUsd(jobDir),
    };
  }

  /**
   * The step the resume or retry prompt names (CVP-138). Normally the job's own. A job at Brief (1)
   * that has run before got there because a fresh brief failed or was stopped, perhaps after the
   * edit had got much further, and its edit/ still holds that work. The prompt then names the step
   * the work reached, the one the progress tracker reports when it replays edit/, so it does not
   * say "step 1 of 8 (Brief)" over a folder full of cuts. If edit/ cannot be read, or holds no
   * work, the job's own step stands. `finish` is how the run ends: a run that ends in Review reads
   * the composition in edit/preview/ as its Preview and Check work.
   */
  private async promptStep(
    job: Job,
    promptMode: RunMode,
    jobDir: string,
    finish: RunFinish,
  ): Promise<StepId | undefined> {
    const stored = job.step ?? undefined;
    if (promptMode === 'start' || (stored ?? BRIEF_STEP) > BRIEF_STEP) return stored;
    try {
      return (await editProgressStep(join(jobDir, 'edit'), finish)) ?? stored;
    } catch (err) {
      this.logger.warn(
        { jobId: job.id, err },
        'could not look for the step in edit/: the prompt names the job’s own step',
      );
      return stored;
    }
  }

  /** The run itself: spawn, wait until nothing of it is left, judge the outcome. */
  private async spawnAndWait(run: {
    job: Job;
    mode: RunMode;
    context: RunContext;
    log: JobLog;
    control: StopControl;
    end: EndRun;
    bin: ClaudeBin;
    args: string[];
    jobDir: string;
    runTag: string;
    finish: RunFinish;
    generate: GenerateEnv | undefined;
    stock: StockEnv | undefined;
  }): Promise<RunOutcome> {
    const {
      job,
      mode,
      context,
      log,
      control,
      end,
      bin,
      args,
      jobDir,
      runTag,
      finish,
      generate,
      stock,
    } = run;
    const editDir = join(jobDir, 'edit');

    const result = await runClaudeProcess({
      jobId: job.id,
      label: 'edit run',
      bin,
      args,
      cwd: jobDir,
      env: claudeEnv({
        home: this.home,
        env: this.env,
        runTag,
        // The connector is a claude.ai connector: a generated video's revise run is always on the plan login.
        planOnly: generate !== undefined ? true : this.config.claudePlanOnly,
        // The song command's tools (SG4): only a run whose prompt can call it gets them.
        ...(this.songsOn() && this.config.songTools !== undefined
          ? { songTools: this.config.songTools }
          : {}),
        // The Generate scripts' settings (GN6): only the revise run of a generated video; the PATH of
        // the env file, the voice id and the Bash timeouts, never a key.
        ...(generate === undefined ? {} : { generate }),
        // Stock media (ST4): the PATH of the env file the stock script reads its keys from.
        ...(stock === undefined ? {} : { stock }),
      }),
      runTag,
      log,
      control,
      dataDir: this.config.dataDir,
      home: this.home,
      killGraceMs: this.killGraceMs,
      timeoutMs: this.timeoutMs,
      sampleIntervalMs: this.sampleIntervalMs,
      logger: this.logger,
      logFields: { mode },
      usage: jobRunUsage(job),
      onStarted: (pid) =>
        this.track?.({
          job,
          mode,
          jobDir,
          editDir,
          pid,
          signal: context.signal,
          progress: context.progress,
          finish,
          ...(context.transcribeTotal === undefined
            ? {}
            : { transcribeTotal: context.transcribeTotal }),
        }),
    });
    if (!result.started) return end('failed', { ok: false, error: result.error });

    const fields: EndFields = {
      exitCode: result.exitCode,
      signal: result.signal,
      sessionId: result.stream.sessionId,
      pid: result.pid,
    };
    const { stoppedBy } = result;
    if (isRequestedStop(stoppedBy)) return end(stoppedBy, REQUESTED_STOPS[stoppedBy], fields);

    const runEnd: RunEnd = {
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      stream: result.stream,
    };
    if (stoppedBy === 'timed_out') {
      const error = describeFailure({ ...runEnd, timedOutAfterMs: this.timeoutMs });
      return end('timed_out', { ok: false, error }, fields);
    }
    if (result.exitCode === 0 && finish === 'preview') {
      // A run that ends in Review: the composition is the result, edit/final.mp4 doesn't count.
      const check = await readPreview(jobDir, job.formats);
      if (check.ok) {
        // A composition without the graded cut is not a finished edit: a run that ends on the
        // camera-LUT sentence is a job that waits for the LUT, however much it did (LU13).
        const waiting = endsWaitingForCameraLut(runEnd);
        if (waiting !== null) {
          return end('failed', { ok: false, error: waiting, step: PREVIEW_STEP }, fields);
        }
        return end(
          'succeeded',
          { ok: true, preview: check.preview },
          { ...fields, preview: check.preview },
        );
      }
      const error = describeMissingPreview(runEnd, check.problem);
      return end('failed', { ok: false, error, step: PREVIEW_STEP }, fields);
    }
    if (result.exitCode === 0 && isVideoFile(join(editDir, 'final.mp4'))) {
      // Formats (GN7): a render run of a job with two or more formats delivers a video of each.
      const missing = job.runKind === 'render' ? missingFormatFinals(editDir, job) : [];
      if (missing.length > 0) {
        const error = `${FINISHED_WITHOUT_VIDEO}: ${missing.join(' and ')} ${missing.length === 1 ? 'was' : 'were'} not made.`;
        return end('failed', { ok: false, error }, fields);
      }
      return end('succeeded', { ok: true }, fields);
    }
    return end('failed', { ok: false, error: describeFailure(runEnd) }, fields);
  }
}
