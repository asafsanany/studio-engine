// The Claude Brief run (B4): a short headless Claude Code run that reads the client's material in
// the job folder and the owner's note, and writes edit/brief.json. brief-step.ts validates it.
//
//   claude -p <brief prompt> --output-format stream-json --verbose --model sonnet
//     --permission-mode dontAsk --permission-prompts none --tools Read,Glob,Grep,Write,Bash
//     --allowedTools <Read, Glob, Grep, writes under ./edit/, Bash limited to ls, ffprobe,
//     textutil and video-use's transcribe.py> --strict-mcp-config --settings {"disableAllHooks":true}
//   cwd = the job folder, the same environment as the edit run (claudeEnv)
//
// The process is handled like the edit run's (claude-process.ts): its stream goes to the job log
// between a `brief_start` and a `brief_end` marker (every marker of it carries `"run":"brief"`,
// and they are not `start`/`end`, so a retry's look at the last edit run never finds them), a
// Cancel or a shutdown stops the whole process tree (SIGTERM, then SIGKILL after 10 s), and after
// 10 minutes it is stopped and fails "Brief stopped: the brief took longer than 10 minutes.".
// A final "Blocked:" line becomes the error, as in the edit run.
//
// Two things keep the run from giving up on Bash after one refused command (P18 · CVP-133). The
// prompt lists the job's files with their durations (so step 1 needs no Bash) and names the Bash
// forms that work. And every permission denial in the stream is logged as a warning and listed in
// the `brief_end` marker as `permissionDenials`: the run goes on and the brief is still accepted,
// but a brief written after a denial can be told from one that was not.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { Job } from '@studio/shared';
import type { Config } from '../config.js';
import { isTimedKind } from '../inbox/classify.js';
import { type DurationCache, sharedDurationCache } from '../inbox/probe.js';
import { briefUsage } from '../usage/app-usage.js';
import {
  BRIEF_STOPPED,
  type BriefFile,
  type BriefWrite,
  type BriefWriteOutcome,
  type BriefWriter,
} from './brief-step.js';
import { type ClaudeBin, resolveClaudeBin } from './claude-bin.js';
import { BRIEF_MODEL, briefClaudeArgs, claudeEnv } from './claude-command.js';
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
  stopRequestedBy,
} from './claude-process.js';
import { blockedReason, describeFailure, trimMessage } from './failure.js';
import { JobLog, jobLogPath, type RunEndOutcome } from './job-log.js';
import { DenialCollector } from './permission-denials.js';
import { type BriefPromptFile, buildBriefPrompt, PROMPTS_DIR } from './prompts.js';
import { reapStaleRuns, runsDir } from './run-records.js';

/** How long a Brief run may take. */
export const BRIEF_TIMEOUT_MS = 10 * 60_000;

export const BRIEF_TIMED_OUT = `${BRIEF_STOPPED} the brief took longer than 10 minutes.`;

/** Every marker of a Brief run carries this, so its lines can be told from the edit run's. */
export const BRIEF_MARKER_FIELDS = { run: 'brief' } as const;

/**
 * What the Brief run reads from the config. `songs` (the Songs switch, already off whenever the
 * music is) is optional so a config built without it is valid; missing means off. On: the prompt
 * reads the song off a screenshot, a link or the words, and its schema has the song keys (SG4).
 * `music` (the Soundtrack switch, U21) is optional the same way. On: the prompt has the rules for
 * `music.wanted` (brief-music.md) and its schema lists it. `generate` (the Generate switch) is
 * optional the same way. On: the prompt has the rules for
 * production, voiceover, formats and budgetUsd, and its schema lists those four keys (GN4).
 */
export type ClaudeBriefConfig = Pick<Config, 'logsDir' | 'dataDir' | 'claudeBin'> &
  Partial<Pick<Config, 'music' | 'songs' | 'generate' | 'claudePlanOnly'>>;

export interface ClaudeBriefWriterOptions {
  config: ClaudeBriefConfig;
  logger?: RunnerLogger;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  /** The server's environment (PATH, pass-through variables); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** SIGTERM -> SIGKILL grace. Default 10 s. */
  killGraceMs?: number;
  /** Default 10 minutes (tests use less). */
  timeoutMs?: number;
  /** How often the process tree is sampled while running. Default 3 s. */
  sampleIntervalMs?: number;
  /** Folder with brief.md. */
  promptsDir?: string;
  /**
   * Where the lengths of the job's video and audio files come from, for the prompt's file list.
   * Defaults to the cache the scanner shares, which has most of them already.
   */
  durations?: DurationCache;
}

const STOPPED: BriefWriteOutcome = { ok: false, error: `${BRIEF_STOPPED} the brief was stopped.` };

function stopped(error: string): BriefWriteOutcome {
  return { ok: false, error: trimMessage(`${BRIEF_STOPPED} ${error}`) };
}

export class ClaudeBriefWriter implements BriefWriter {
  private readonly config: ClaudeBriefConfig;
  private readonly logger: RunnerLogger;
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private readonly killGraceMs: number;
  private readonly timeoutMs: number;
  private readonly sampleIntervalMs: number;
  private readonly promptsDir: string;
  private readonly durations: DurationCache;

  constructor(options: ClaudeBriefWriterOptions) {
    this.config = options.config;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.timeoutMs = options.timeoutMs ?? BRIEF_TIMEOUT_MS;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.promptsDir = options.promptsDir ?? PROMPTS_DIR;
    this.durations = options.durations ?? sharedDurationCache();
  }

  /** The job's files for the prompt: what the scanner saw, plus ffprobe's length of each video and audio file. */
  private async promptFiles(files: readonly BriefFile[]): Promise<BriefPromptFile[]> {
    return Promise.all(
      files.map(async (file) => {
        const seconds = isTimedKind(file.kind)
          ? await this.durations.seconds(file.absPath, file)
          : null;
        return {
          relPath: file.relPath,
          kind: file.kind,
          size: file.size,
          mtimeMs: file.mtimeMs,
          durationSec: seconds !== null && seconds > 0 ? seconds : null,
          ...(file.attached === true ? { attached: true } : {}),
          ...(file.fromZip !== undefined ? { fromZip: file.fromZip } : {}),
        };
      }),
    );
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

  async write(job: Job, run: BriefWrite): Promise<BriefWriteOutcome> {
    const { signal } = run;
    if (signal.aborted) return STOPPED;

    const control = new StopControl(this.killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    let log: JobLog | null = null;
    const end = (
      outcome: RunEndOutcome,
      result: BriefWriteOutcome,
      fields: Record<string, unknown> = {},
    ): BriefWriteOutcome => {
      const error = result.ok ? undefined : result.error;
      const durationMs = Date.now() - startedAt;
      log?.marker('brief_end', {
        ...BRIEF_MARKER_FIELDS,
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
        this.logger.warn(entry, 'brief run failed');
      } else {
        this.logger.info(entry, 'brief run ended');
      }
      return result;
    };

    try {
      log = await JobLog.open(jobLogPath(this.config.logsDir, job.id));
      return await this.run(job, run, log, control, end);
    } catch (err) {
      if (isRequestedStop(control.reason)) return end(control.reason, STOPPED);
      this.logger.error({ jobId: job.id, err }, 'brief run broke');
      return end('failed', stopped(`the brief could not run: ${errorText(err)}`));
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
    { jobDir, files, note, series, shared }: BriefWrite,
    log: JobLog,
    control: StopControl,
    end: (
      outcome: RunEndOutcome,
      result: BriefWriteOutcome,
      fields?: Record<string, unknown>,
    ) => BriefWriteOutcome,
  ): Promise<BriefWriteOutcome> {
    // The Brief run is the first process of a job's run: anything an earlier engine left behind
    // is stopped before it starts.
    const reaped = await reapStaleRuns(runsDir(this.config.dataDir), {
      graceMs: this.killGraceMs,
      // The other job editing beside this one keeps its run.
      forJob: job.id,
    });
    for (const stale of reaped) {
      this.logger.warn({ ...stale }, 'stopped a Claude run left over from an earlier engine');
      log.marker('reaped', { ...BRIEF_MARKER_FIELDS, ...stale });
    }

    const prompt = await buildBriefPrompt(
      {
        client: job.client,
        job: job.name,
        note,
        files: await this.promptFiles(files),
        series,
        ...(this.config.music === true ? { music: true } : {}),
        ...(this.config.songs === true ? { songs: true } : {}),
        ...(this.config.generate === true ? { generate: true } : {}),
        ...(shared !== undefined && shared.length > 0 ? { shared } : {}),
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

    const args = briefClaudeArgs({ prompt, home: this.home });
    const runTag = `${job.id}-${randomUUID()}`;
    log.marker('brief_start', {
      ...BRIEF_MARKER_FIELDS,
      jobId: job.id,
      relPath: job.relPath,
      step: job.step,
      bin: bin.path,
      binSource: bin.source,
      cwd: jobDir,
      model: BRIEF_MODEL,
      timeoutMs: this.timeoutMs,
      runTag,
      flags: args.slice(2),
      prompt,
    });
    if (isRequestedStop(control.reason)) return end(control.reason, STOPPED);

    const denied = new DenialCollector();
    const result = await runClaudeProcess({
      jobId: job.id,
      label: 'brief run',
      bin,
      args,
      cwd: jobDir,
      env: claudeEnv({
        home: this.home,
        env: this.env,
        runTag,
        planOnly: this.config.claudePlanOnly,
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
      markerFields: BRIEF_MARKER_FIELDS,
      onStarted: () => ({ onEvent: (event) => denied.onEvent(event) }),
      usage: briefUsage(job),
    });
    if (!result.started) return end('failed', stopped(result.error));

    const denials = denied.denials();
    for (const denial of denials) {
      this.logger.warn(
        { jobId: job.id, tool: denial.tool, detail: denial.detail },
        'brief run: a tool call was denied by the permission rules',
      );
    }
    const fields = {
      exitCode: result.exitCode,
      signal: result.signal,
      sessionId: result.stream.sessionId,
      pid: result.pid,
      permissionDenials: denials,
    };
    const stoppedBy: StopReason | null = result.stoppedBy;
    if (isRequestedStop(stoppedBy)) return end(stoppedBy, STOPPED, fields);
    if (stoppedBy === 'timed_out') {
      return end('timed_out', { ok: false, error: BRIEF_TIMED_OUT }, fields);
    }

    if (result.exitCode === 0) {
      const text = result.stream.lastResult?.text ?? result.stream.lastText ?? '';
      const blocked = blockedReason(text);
      if (blocked !== null) return end('failed', stopped(blocked), fields);
      return end('succeeded', { ok: true }, fields);
    }
    const error = describeFailure({
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      stream: result.stream,
    });
    return end('failed', stopped(error), fields);
  }
}
