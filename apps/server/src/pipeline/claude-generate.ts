// The Claude Generate run (Generated videos, GN5): one long headless Claude Code run that plans the
// shots of a job with no footage, makes the voice and the clips with the two scripts, and hands
// them off in edit/generate/. generate-step.ts starts it, watches its files and judges the result.
//
//   claude -p <generate prompt> --output-format stream-json --verbose [--model <edit model>]
//     [--effort <the job's effort>] --permission-mode dontAsk --permission-prompts none
//     --tools Read,Glob,Grep,Write,Bash --allowedTools <reads, writes under ./edit/, Bash limited to
//     the two scripts, ffmpeg, ffprobe, ls, mkdir -p ./edit/, video-use's transcribe and
//     timeline_view helpers, and the Higgsfield connector's generation tools (U26)>
//     --settings {"disableAllHooks":true, deny: the key files}
//   no --strict-mcp-config: the pictures and clips are made through the "claude.ai Higgsfield"
//   connector on the Higgsfield plan's credits (claude-command.ts: HIGGSFIELD_TOOLS), so the run
//   always bills the plan login, never an API key.
//   cwd = the job folder
//
// The model and the effort are the edit run's (`config.model`, the job's effort). The environment is
// the edit run's (`claudeEnv`) plus, for this run only, the PATH of the env file (`STUDIO_ENV_FILE`),
// the ElevenLabs voice id and the Bash timeouts a clip needs: never a key (claude-command.ts). The
// scripts read their own keys.
//
// It is handled like the Brief run (claude-brief.ts): its stream goes to the job log between a
// `generate_start` and a `generate_end` marker (every marker of it carries `"run":"generate"` and
// they are not `start`/`end`, so a retry's look at the last edit run never finds them), a Cancel or
// a shutdown stops the whole process tree, and permission denials are listed in the end marker.
//
// How long it may take. A Wan clip takes minutes (about 30 s of waiting per second of video), the
// shots script waits up to about 9 minutes for one, and a pass makes several: a Generate run lasts
// tens of minutes. The only limit is a wall clock of four hours (`GENERATE_TIMEOUT_MS`); nothing
// times a silence, because a wait for a clip is silent for minutes. Bash itself is given its
// maximum of 10 minutes per command (`GENERATE_BASH_TIMEOUT_MS`).
//
// How it ends: exit 0 with a final line "Blocked: …" is a blocker (the step maps it to the plain
// sentence); exit 0 otherwise is "done" and the step checks the hand-off; anything else is a
// failure with one readable line (failure.ts). Beside that, the tracker reads each script call's
// answer from the stream: the ElevenLabs characters it used go to the job's row, and a refusal
// (an empty balance, a key not accepted) is remembered for the sentence of a Blocked run.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { Job } from '@studio/shared';
import { runEffort } from '@studio/shared';
import { type Config, envFilePath } from '../config.js';
import { GENERATE_ASSETS } from '../generate/generate-assets.js';
import { RefusalLedger, readScriptAnswers, scriptOfCommand } from '../generate/script-answers.js';
import { generateUsage } from '../usage/app-usage.js';
import { type ClaudeBin, resolveClaudeBin } from './claude-bin.js';
import {
  claudeEnv,
  generateClaudeArgs,
  generateDenyRead,
  readDenyRulesOutsideJob,
} from './claude-command.js';
import {
  errorText,
  isRequestedStop,
  KILL_GRACE_MS,
  type RunnerLogger,
  runClaudeProcess,
  SAMPLE_INTERVAL_MS,
  SILENT_LOGGER,
  StopControl,
  type StopReason,
  type StreamTracker,
  stopRequestedBy,
} from './claude-process.js';
import { blockedReason, describeFailure, trimMessage } from './failure.js';
import { buildGeneratePrompt } from './generate-prompt.js';
import {
  GENERATE_STOPPED,
  type GenerateWrite,
  type GenerateWriteOutcome,
  type GenerateWriter,
} from './generate-step.js';
import { JobLog, jobLogPath, type RunEndOutcome } from './job-log.js';
import { DenialCollector } from './permission-denials.js';
import { PROMPTS_DIR } from './prompts.js';
import { reapStaleRuns, runsDir } from './run-records.js';
import type { StreamEvent } from './stream-parser.js';

/** How long a Generate run may take: four hours of wall clock, never a silence (see the top of the file). */
export const GENERATE_TIMEOUT_MS = 4 * 60 * 60_000;

export const GENERATE_TIMED_OUT = `${GENERATE_STOPPED} the run took longer than 4 hours.`;

/** Every marker of a Generate run carries this, so its lines can be told from the edit run's. */
export const GENERATE_MARKER_FIELDS = { run: 'generate' } as const;

/** What the Generate run reads from the config. */
export type ClaudeGenerateConfig = Pick<
  Config,
  'logsDir' | 'dataDir' | 'claudeBin' | 'model' | 'generateVoiceId'
> &
  Partial<Pick<Config, 'generateUsdPerCredit'>> &
  Partial<Pick<Config, 'claudePlanOnly'>>;

export interface ClaudeGenerateWriterOptions {
  config: ClaudeGenerateConfig;
  logger?: RunnerLogger;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  /** The server's environment (PATH, pass-through variables, STUDIO_ENV_FILE); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** `<inbox>/…`: where the job folders are, to keep the run out of the other jobs. */
  inboxPath: string;
  /** SIGTERM -> SIGKILL grace. Default 10 s. */
  killGraceMs?: number;
  /** Default four hours (tests use less). */
  timeoutMs?: number;
  /** How often the process tree is sampled while running. Default 3 s. */
  sampleIntervalMs?: number;
  /** Folder with generate.md. */
  promptsDir?: string;
  /** The two scripts and the env file; defaults to the engine's own (tests point them at others). */
  scripts?: { voice: string; shots: string };
  envFile?: string;
  /** Makes both scripts run their fake (STUDIO_GENERATE_FAKE=1): tests only. */
  fake?: boolean;
}

const STOPPED: GenerateWriteOutcome = { ok: false, error: `${GENERATE_STOPPED} it was stopped.` };

function stopped(error: string): Extract<GenerateWriteOutcome, { ok: false }> {
  return { ok: false, error: trimMessage(`${GENERATE_STOPPED} ${error}`) };
}

/**
 * Reads the stream of the run for what the engine must know without asking it: the answers of the
 * two scripts (ElevenLabs characters, refusals) and the permission denials.
 */
export class GenerateStreamTracker implements StreamTracker {
  readonly ledger = new RefusalLedger();
  readonly denied = new DenialCollector();
  private readonly calls = new Map<string, 'voice' | 'shots'>();
  private readonly addChars: (chars: number) => void;

  constructor(addChars: (chars: number) => void) {
    this.addChars = addChars;
  }

  onEvent(event: StreamEvent): void {
    this.denied.onEvent(event);
    if (event.kind === 'tool_use' && event.name === 'Bash') {
      const command = typeof event.input.command === 'string' ? event.input.command : '';
      const script = scriptOfCommand(command);
      if (script !== null) this.calls.set(event.id, script);
      return;
    }
    if (event.kind !== 'tool_result') return;
    const script = this.calls.get(event.toolUseId);
    if (script === undefined) return;
    this.calls.delete(event.toolUseId);
    for (const answer of readScriptAnswers(script, event.text)) {
      const chars = this.ledger.take(answer);
      if (chars > 0) this.addChars(chars);
    }
  }
}

export class ClaudeGenerateWriter implements GenerateWriter {
  private readonly config: ClaudeGenerateConfig;
  private readonly inboxPath: string;
  private readonly logger: RunnerLogger;
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private readonly killGraceMs: number;
  private readonly timeoutMs: number;
  private readonly sampleIntervalMs: number;
  private readonly promptsDir: string;
  private readonly scripts: { voice: string; shots: string };
  private readonly envFile: string;
  private readonly fake: boolean;

  constructor(options: ClaudeGenerateWriterOptions) {
    this.config = options.config;
    this.inboxPath = options.inboxPath;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.timeoutMs = options.timeoutMs ?? GENERATE_TIMEOUT_MS;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.promptsDir = options.promptsDir ?? PROMPTS_DIR;
    this.scripts = options.scripts ?? {
      voice: GENERATE_ASSETS.voice,
      shots: GENERATE_ASSETS.shots,
    };
    this.envFile = options.envFile ?? envFilePath(this.env, this.home);
    this.fake = options.fake === true;
  }

  /** The binary the next run will use, looked up like the edit run's. */
  resolveBin(): ClaudeBin | null {
    const configured = this.config.claudeBin;
    return resolveClaudeBin({
      home: this.home,
      pathEnv: this.env.PATH,
      configBin: configured === 'claude' ? undefined : configured,
    });
  }

  async write(job: Job, run: GenerateWrite): Promise<GenerateWriteOutcome> {
    const { signal } = run;
    if (signal.aborted) return STOPPED;

    const control = new StopControl(this.killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    let log: JobLog | null = null;
    const end = (
      outcome: RunEndOutcome,
      result: GenerateWriteOutcome,
      fields: Record<string, unknown> = {},
    ): GenerateWriteOutcome => {
      const error = result.ok ? undefined : result.error;
      const durationMs = Date.now() - startedAt;
      log?.marker('generate_end', {
        ...GENERATE_MARKER_FIELDS,
        outcome,
        ...(error === undefined ? {} : { error }),
        exitCode: null,
        signal: null,
        sessionId: null,
        ...fields,
        durationMs,
      });
      const entry = { jobId: job.id, outcome, error, durationMs };
      if (outcome === 'failed' || outcome === 'timed_out') {
        this.logger.warn(entry, 'generate run failed');
      } else {
        this.logger.info(entry, 'generate run ended');
      }
      return result;
    };

    try {
      log = await JobLog.open(jobLogPath(this.config.logsDir, job.id));
      return await this.run(job, run, log, control, end);
    } catch (err) {
      if (isRequestedStop(control.reason)) return end(control.reason, STOPPED);
      this.logger.error({ jobId: job.id, err }, 'generate run broke');
      return end('failed', stopped(`the run could not start: ${errorText(err)}`));
    } finally {
      signal.removeEventListener('abort', onAbort);
      await log?.close();
      if (log?.error) {
        this.logger.warn({ jobId: job.id, err: log.error }, 'could not write the job log');
      }
    }
  }

  private async run(
    job: Job,
    { jobDir, editDir, brief, budgetUsd, spentUsd, existing, addVoiceChars }: GenerateWrite,
    log: JobLog,
    control: StopControl,
    end: (
      outcome: RunEndOutcome,
      result: GenerateWriteOutcome,
      fields?: Record<string, unknown>,
    ) => GenerateWriteOutcome,
  ): Promise<GenerateWriteOutcome> {
    // The Generate run starts after the Brief run, which already stopped anything an earlier engine
    // left behind; a run record it finds now is the engine's own leftover all the same.
    const reaped = await reapStaleRuns(runsDir(this.config.dataDir), {
      graceMs: this.killGraceMs,
      // The other job editing beside this one keeps its run.
      forJob: job.id,
    });
    for (const stale of reaped) {
      this.logger.warn({ ...stale }, 'stopped a Claude run left over from an earlier engine');
      log.marker('reaped', { ...GENERATE_MARKER_FIELDS, ...stale });
    }

    const prompt = await buildGeneratePrompt(
      {
        client: job.client,
        job: job.name,
        voiceScript: this.scripts.voice,
        shotsScript: this.scripts.shots,
        editDir,
        budgetUsd,
        spentUsd,
        usdPerCredit: this.config.generateUsdPerCredit,
        formats: brief.formats,
        existing,
      },
      this.promptsDir,
    );
    const bin = this.resolveBin();
    if (bin === null) {
      return end(
        'failed',
        stopped(
          'Claude Code was not found. Open the Claude desktop app once, or set "claudeBin" in ~/.studio-engine/config.json, then run `pnpm run doctor`.',
        ),
      );
    }

    const model = this.config.model;
    const effort = runEffort(job.effort);
    const denyRead = [
      ...readDenyRulesOutsideJob(this.inboxPath, jobDir, { shared: true }),
      ...generateDenyRead(this.envFile, this.home),
    ];
    const args = generateClaudeArgs({
      prompt,
      model,
      effort,
      home: this.home,
      scripts: this.scripts,
      denyRead,
    });
    const runTag = `${job.id}-${randomUUID()}`;
    log.marker('generate_start', {
      ...GENERATE_MARKER_FIELDS,
      jobId: job.id,
      relPath: job.relPath,
      step: job.step,
      bin: bin.path,
      binSource: bin.source,
      cwd: jobDir,
      model: model ?? null,
      effort: effort ?? null,
      timeoutMs: this.timeoutMs,
      runTag,
      // The path of the env file, never what is in it.
      envFile: basename(this.envFile),
      flags: args.slice(2),
      prompt,
    });
    if (isRequestedStop(control.reason)) return end(control.reason, STOPPED);

    const tracker = new GenerateStreamTracker(addVoiceChars);
    const result = await runClaudeProcess({
      jobId: job.id,
      label: 'generate run',
      bin,
      args,
      cwd: jobDir,
      env: claudeEnv({
        home: this.home,
        env: this.env,
        runTag,
        // Always the plan login, whatever the Settings switch says (U26): the Higgsfield connector
        // is a claude.ai connector, which a run with an API key does not have.
        planOnly: true,
        generate: {
          envFile: this.envFile,
          voiceId: this.config.generateVoiceId,
          ...(this.config.generateUsdPerCredit === undefined
            ? {}
            : { usdPerCredit: this.config.generateUsdPerCredit }),
        },
        ...(this.fake ? { generateFake: true } : {}),
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
      markerFields: GENERATE_MARKER_FIELDS,
      onStarted: () => tracker,
      usage: generateUsage(job),
    });
    if (!result.started) return end('failed', stopped(result.error));

    const denials = tracker.denied.denials();
    for (const denial of denials) {
      this.logger.warn(
        { jobId: job.id, tool: denial.tool, detail: denial.detail },
        'generate run: a tool call was denied by the permission rules',
      );
    }
    const refusal = tracker.ledger.latest();
    const fields = {
      exitCode: result.exitCode,
      signal: result.signal,
      sessionId: result.stream.sessionId,
      pid: result.pid,
      permissionDenials: denials,
      voiceChars: tracker.ledger.chars,
      ...(refusal === null ? {} : { refusal: refusal.code }),
    };
    const stoppedBy: StopReason | null = result.stoppedBy;
    if (isRequestedStop(stoppedBy)) return end(stoppedBy, STOPPED, fields);
    if (stoppedBy === 'timed_out') {
      return end('timed_out', { ok: false, error: GENERATE_TIMED_OUT, refusal }, fields);
    }

    if (result.exitCode === 0) {
      const text = result.stream.lastResult?.text ?? result.stream.lastText ?? '';
      const blocked = blockedReason(text);
      if (blocked !== null) {
        return end(
          'failed',
          { ok: false, error: stopped(blocked).error, blocked, refusal },
          fields,
        );
      }
      return end('succeeded', { ok: true, refusal }, fields);
    }
    const error = describeFailure({
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      stream: result.stream,
    });
    return end('failed', { ...stopped(error), refusal }, fields);
  }
}
