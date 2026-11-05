// The Claude style run (Phase 2 plan §5): a short headless Sonnet session that writes a client's
// `_Style/style.md.new`. For a Read pass it reads the new files in `_Style` (style-read.md):
//
//   claude -p <style-read prompt> --output-format stream-json --verbose --model sonnet
//     --permission-mode dontAsk --permission-prompts none --tools Read,Glob,Grep,Write,Bash
//     --allowedTools <Read, Glob, Grep, writing ./style.md.new, Bash limited to ls, ffprobe,
//     ffmpeg single frames to /tmp and textutil> --strict-mcp-config
//     --settings {"disableAllHooks":true}
//   cwd = the client's _Style folder, the same environment as the edit run (claudeEnv)
//
// For a Learn pass it reads a finished job (style-learn.md): the same flags, with Write limited to
// `<_Style>/style.md.new` by its absolute path, no textutil, and cwd = the job folder. A `merge`
// may also Read `<_Style>/style.md`, the current style it adds the job's look to.
//
// The process is handled like the Brief run's (claude-brief.ts, claude-process.ts): its stream goes
// to the client's log, `<logsDir>/clients/<clientId>.log`, between a `style_start` and a
// `style_end` marker (each with `"run":"style"`); a shutdown stops the whole process tree
// (SIGTERM, then SIGKILL after 10 s); after 10 minutes it is stopped and fails "Style stopped: the
// style took longer than 10 minutes."; and a final "Blocked:" line becomes the error. Permission
// denials are logged as warnings and listed in `style_end`, as the Brief run does.
//
// Its run record goes to `<dataDir>/style-runs`, not `runs/`: the edit and Brief runs stop
// everything recorded in `runs/` before they start, and a style run may be going on beside them.
// One style run at a time, so a record found there before a run is one a crashed engine left.
//
// The series passes (Series plan §3) run the same way (`runSeries`), one at a time with the style
// runs on the client's style queue, in the same client log and the same run records. A `series`
// pass runs in the episode's folder with series-learn.md and its own rules (style-command.ts):
// Write only series.md.new (and style.md.new for a start that rewrites the style), by absolute
// path; an approved episode's pass with review notes (C26) also reads the notes files and series.md
// of the series folder. Their failures start "Series stopped:".

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { type ClaudeBin, resolveClaudeBin } from '../pipeline/claude-bin.js';
import { claudeEnv } from '../pipeline/claude-command.js';
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
} from '../pipeline/claude-process.js';
import { blockedReason, describeFailure, trimMessage } from '../pipeline/failure.js';
import { JobLog, type RunEndOutcome } from '../pipeline/job-log.js';
import { DenialCollector } from '../pipeline/permission-denials.js';
import { PROMPTS_DIR } from '../pipeline/prompts.js';
import { reapStaleRuns } from '../pipeline/run-records.js';
import { seriesPassUsage, stylePassUsage } from '../usage/app-usage.js';
import type { AppUsage } from '../usage/usage-log.js';
import { clientLogPath } from './paths.js';
import { buildSeriesLearnPrompt } from './series-prompt.js';
import {
  STYLE_MODEL,
  seriesLearnAllowedTools,
  styleClaudeArgs,
  styleLearnAllowedTools,
  styleReadAllowedTools,
} from './style-command.js';
import { buildStyleLearnPrompt, buildStyleReadPrompt, localDate } from './style-prompt.js';
import {
  SERIES_STOPPED,
  type SeriesRunner,
  type SeriesRunRequest,
  STYLE_STOPPED,
  type StyleRunner,
  type StyleRunOutcome,
  type StyleRunRequest,
} from './style-run.js';

/** How long a style run (or a series run) may take. */
export const STYLE_TIMEOUT_MS = 10 * 60_000;

export const STYLE_TIMED_OUT = `${STYLE_STOPPED} the style took longer than 10 minutes.`;

export const SERIES_TIMED_OUT = `${SERIES_STOPPED} the series took longer than 10 minutes.`;

/** Every marker of a style run carries this. */
export const STYLE_MARKER_FIELDS = { run: 'style' } as const;

/** Where the style runs' records go (see the top of this file). */
export function styleRunsDir(dataDir: string): string {
  return join(dataDir, 'style-runs');
}

export type ClaudeStyleConfig = Pick<Config, 'logsDir' | 'dataDir' | 'claudeBin'> &
  Partial<Pick<Config, 'claudePlanOnly'>>;

export interface ClaudeStyleRunnerOptions {
  config: ClaudeStyleConfig;
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
  /** Folder with style-read.md, style-learn.md, style-shape.md and the series-*.md prompts. */
  promptsDir?: string;
  /** Today, for the add mode's “Plus <files> (<date>).” and “Learned from <job> (<date>).” */
  clock?: () => Date;
}

/** What one run needs besides the request: decided by the kind of pass. */
interface RunPlan {
  cwd: string;
  prompt: string;
  allowedTools: string[];
}

/** What a run is of: a style or a series. It names the run in its failures and its log lines. */
type RunNoun = 'style' | 'series';

/** One run of either kind, as `go` takes it. */
interface RunSpec {
  clientId: string;
  client: string;
  signal: AbortSignal;
  /** The pass's kind, for the markers and the log. */
  kind: string;
  /** What `style_start` records about the pass, after its kind. */
  passFields: Record<string, unknown>;
  noun: RunNoun;
  /** The prompt, folder and tools of the pass. */
  plan: () => Promise<RunPlan>;
  /** The pass's usage tag and line (usage.jsonl). */
  usage: AppUsage;
}

const STOPPED_PREFIX: Readonly<Record<RunNoun, string>> = {
  style: STYLE_STOPPED,
  series: SERIES_STOPPED,
};

const TIMED_OUT: Readonly<Record<RunNoun, string>> = {
  style: STYLE_TIMED_OUT,
  series: SERIES_TIMED_OUT,
};

/** The outcome of a run that was stopped (a shutdown, an Undo). */
function stoppedRun(noun: RunNoun): StyleRunOutcome {
  return { ok: false, error: `${STOPPED_PREFIX[noun]} the ${noun} run was stopped.` };
}

function stopped(noun: RunNoun, error: string): StyleRunOutcome {
  return { ok: false, error: trimMessage(`${STOPPED_PREFIX[noun]} ${error}`) };
}

export class ClaudeStyleRunner implements StyleRunner, SeriesRunner {
  private readonly config: ClaudeStyleConfig;
  private readonly logger: RunnerLogger;
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private readonly killGraceMs: number;
  private readonly timeoutMs: number;
  private readonly sampleIntervalMs: number;
  private readonly promptsDir: string;
  private readonly clock: () => Date;

  constructor(options: ClaudeStyleRunnerOptions) {
    this.config = options.config;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.timeoutMs = options.timeoutMs ?? STYLE_TIMEOUT_MS;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.promptsDir = options.promptsDir ?? PROMPTS_DIR;
    this.clock = options.clock ?? (() => new Date());
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

  /** The prompt, folder and tools of a style pass. */
  private async plan({ client, styleDir, pass, learn }: StyleRunRequest): Promise<RunPlan> {
    const date = localDate(this.clock());
    switch (pass.kind) {
      case 'read':
        return {
          cwd: styleDir,
          prompt: await buildStyleReadPrompt(
            { client, mode: pass.mode, files: pass.files, date },
            this.promptsDir,
          ),
          allowedTools: styleReadAllowedTools(),
        };
      case 'learn':
        if (learn === undefined) throw new Error('a Learn pass came without its job folder');
        return {
          cwd: learn.jobDir,
          prompt: await buildStyleLearnPrompt(
            { client, mode: pass.mode, job: pass.job, date, styleDir, kit: learn.kit },
            this.promptsDir,
          ),
          allowedTools: styleLearnAllowedTools(styleDir, pass.mode),
        };
    }
  }

  /** The prompt, folder and tools of a series pass. */
  private async seriesPlan(request: SeriesRunRequest): Promise<RunPlan> {
    const { client, seriesDir, styleDir, pass, jobDir, writesStyle, styleKit, notes } = request;
    const date = localDate(this.clock());
    return {
      cwd: jobDir,
      prompt: await buildSeriesLearnPrompt(
        {
          client,
          series: pass.series,
          job: pass.job,
          date,
          seriesDir,
          styleDir,
          writesStyle,
          ...(styleKit === undefined ? {} : { styleKit }),
          ...(notes === undefined ? {} : { notes }),
        },
        this.promptsDir,
      ),
      allowedTools: seriesLearnAllowedTools({
        seriesDir,
        styleDir,
        writesStyle,
        readsNotes: notes !== undefined,
      }),
    };
  }

  async run(request: StyleRunRequest): Promise<StyleRunOutcome> {
    const { pass, learn } = request;
    return this.go({
      clientId: request.clientId,
      client: request.client,
      signal: request.signal,
      kind: pass.kind,
      passFields: {
        mode: pass.mode,
        ...(pass.kind === 'read'
          ? { files: pass.files }
          : { jobId: pass.jobId, job: pass.job, kit: learn?.kit ?? [] }),
      },
      noun: 'style',
      plan: () => this.plan(request),
      usage: stylePassUsage(request.client, pass),
    });
  }

  async runSeries(request: SeriesRunRequest): Promise<StyleRunOutcome> {
    const { pass } = request;
    return this.go({
      clientId: request.clientId,
      client: request.client,
      signal: request.signal,
      kind: pass.kind,
      passFields: {
        mode: pass.mode,
        seriesId: pass.seriesId,
        series: pass.series,
        jobId: pass.jobId,
        job: pass.job,
        writesStyle: request.writesStyle,
        ...(request.notes === undefined
          ? {}
          : { notes: request.notes.files, rounds: request.notes.rounds !== null }),
      },
      noun: 'series',
      plan: () => this.seriesPlan(request),
      usage: seriesPassUsage(request.client, pass),
    });
  }

  private async go(spec: RunSpec): Promise<StyleRunOutcome> {
    const { clientId, kind, noun, signal } = spec;
    if (signal.aborted) return stoppedRun(noun);

    const control = new StopControl(this.killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    let log: JobLog | null = null;
    const end = (
      outcome: RunEndOutcome,
      result: StyleRunOutcome,
      fields: Record<string, unknown> = {},
    ): StyleRunOutcome => {
      const error = result.ok ? undefined : result.error;
      const durationMs = Date.now() - startedAt;
      log?.marker('style_end', {
        ...STYLE_MARKER_FIELDS,
        kind,
        outcome,
        ...(error === undefined ? {} : { error }),
        exitCode: null,
        signal: null,
        sessionId: null,
        ...fields,
        durationMs,
      });
      const entry = { clientId, kind, outcome, error, durationMs };
      if (outcome === 'failed' || outcome === 'timed_out') {
        this.logger.warn(entry, `${noun} run failed`);
      } else {
        this.logger.info(entry, `${noun} run ended`);
      }
      return result;
    };

    try {
      log = await JobLog.open(clientLogPath(this.config.logsDir, clientId));
      return await this.execute(spec, log, control, end);
    } catch (err) {
      if (isRequestedStop(control.reason)) return end(control.reason, stoppedRun(noun));
      this.logger.error({ clientId, err }, `${noun} run broke`);
      return end('failed', stopped(noun, `the ${noun} could not run: ${errorText(err)}`));
    } finally {
      signal.removeEventListener('abort', onAbort);
      await log?.close();
      if (log?.error) {
        this.logger.warn({ clientId, err: log.error }, 'could not write the client log');
      }
    }
  }

  private async execute(
    spec: RunSpec,
    log: JobLog,
    control: StopControl,
    end: (
      outcome: RunEndOutcome,
      result: StyleRunOutcome,
      fields?: Record<string, unknown>,
    ) => StyleRunOutcome,
  ): Promise<StyleRunOutcome> {
    const { clientId, client, kind, noun } = spec;
    const records = styleRunsDir(this.config.dataDir);
    const reaped = await reapStaleRuns(records, { graceMs: this.killGraceMs });
    for (const stale of reaped) {
      this.logger.warn({ ...stale }, 'stopped a style run left over from an earlier engine');
      log.marker('reaped', { ...STYLE_MARKER_FIELDS, ...stale });
    }

    const plan = await spec.plan();
    const bin = this.resolveBin();
    if (bin === null) {
      return end(
        'failed',
        stopped(
          noun,
          'Claude Code was not found. Open the Claude desktop app once, or set "claudeBin" in ~/.studio-engine/config.json, then run `pnpm run doctor`.',
        ),
      );
    }

    const args = styleClaudeArgs({ prompt: plan.prompt, allowedTools: plan.allowedTools });
    const runTag = `style-${clientId}-${randomUUID()}`;
    log.marker('style_start', {
      ...STYLE_MARKER_FIELDS,
      kind,
      ...spec.passFields,
      clientId,
      client,
      bin: bin.path,
      binSource: bin.source,
      cwd: plan.cwd,
      model: STYLE_MODEL,
      timeoutMs: this.timeoutMs,
      runTag,
      flags: args.slice(2),
      prompt: plan.prompt,
    });
    if (isRequestedStop(control.reason)) return end(control.reason, stoppedRun(noun));

    const denied = new DenialCollector();
    const result = await runClaudeProcess({
      jobId: `style-${clientId}`,
      label: `${noun} run`,
      bin,
      args,
      cwd: plan.cwd,
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
      runsDir: records,
      home: this.home,
      killGraceMs: this.killGraceMs,
      timeoutMs: this.timeoutMs,
      sampleIntervalMs: this.sampleIntervalMs,
      logger: this.logger,
      markerFields: STYLE_MARKER_FIELDS,
      onStarted: () => ({ onEvent: (event) => denied.onEvent(event) }),
      usage: spec.usage,
    });
    if (!result.started) return end('failed', stopped(noun, result.error));

    const denials = denied.denials();
    for (const denial of denials) {
      this.logger.warn(
        { clientId, tool: denial.tool, detail: denial.detail },
        `${noun} run: a tool call was denied by the permission rules`,
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
    if (isRequestedStop(stoppedBy)) return end(stoppedBy, stoppedRun(noun), fields);
    if (stoppedBy === 'timed_out') {
      return end('timed_out', { ok: false, error: TIMED_OUT[noun] }, fields);
    }

    if (result.exitCode === 0) {
      const text = result.stream.lastResult?.text ?? result.stream.lastText ?? '';
      const blocked = blockedReason(text);
      if (blocked !== null) return end('failed', stopped(noun, blocked), fields);
      return end('succeeded', { ok: true }, fields);
    }
    const error = describeFailure({
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      stream: result.stream,
    });
    return end('failed', stopped(noun, error), fields);
  }
}
