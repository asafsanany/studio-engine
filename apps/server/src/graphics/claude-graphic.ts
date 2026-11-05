// The headless Claude run that makes one version of a graphic (Graphics plan, "The run").
// OWNER: GR2. Pattern: analytics/note-topics-claude.ts, a Claude run not tied to a job, with its
// own log, records folder, usage tag and fake.
//
//   claude -p <prompt> --output-format stream-json --verbose [--model <config.model>]
//          --effort <the message's effort> --permission-mode dontAsk --permission-prompts none
//          --tools Bash,Read,Write,Edit,Skill --allowedTools "Bash Read Write Edit Skill"
//          --strict-mcp-config
//          --settings {"disableAllHooks":true,"permissions":{"deny":readDenyRulesOutsideJob(inbox, dir)}}
//   cwd <graphic>/work/, environment from claudeEnv
//
// The prompt is graphic-make.md or graphic-change.md (graphic-prompt.ts), with the shared fonts the
// worker copied into <graphic>/fonts/ listed in it. The deny rules keep it out of the clients'
// folders, _Fonts and the other graphics: everything it reads is in its own graphic folder.
//
// Steps come from the stream's tool calls (`graphicStepTracker`): 0 until the first Write or Edit
// of a file under compositions/, 1 until the first Bash that runs the check (hyperframes lint,
// snapshot or check, or the engine's check-graphic.mjs), 2 until the end. A step never goes back,
// and 2 only comes after 1, so a change run that lints before it edits still reads "Reading".
//
// The process is handled like the other runs (claude-process.ts): a Stop, a delete or the engine's
// shutdown aborts `signal` and the whole process tree stops; after GRAPHIC_LIMITS.runTimeoutMs it is
// stopped and fails "It took longer than 20 minutes."; a final "Blocked:" line becomes the error.
// The stream goes to <logs>/graphics/<id>.log between a graphic_start and a graphic_end marker.
// The run's record goes to <data>/graphic-runs/<id>/: one folder per graphic, because two graphics
// may run at once and reaping before a run must only stop what an earlier engine left of this
// graphic (one run per graphic at a time). `reapGraphicRuns` reaps them all, for the worker's boot.
// Its tokens are logged to usage.jsonl under the `graphic` tag, "Made vN of <Name>"; v1 is named
// from about.json, since the graphic is still "New graphic" when it starts.

import { randomUUID } from 'node:crypto';
import { readdir, readFile, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type Effort,
  GRAPHIC_LIMITS,
  GRAPHIC_MESSAGES,
  type GraphicStep,
  graphicAboutSchema,
} from '@studio/shared';
import type { Config } from '../config.js';
import { type ClaudeBin, resolveClaudeBin } from '../pipeline/claude-bin.js';
import { claudeEnv, readDenyRulesOutsideJob } from '../pipeline/claude-command.js';
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
import { type ReapedRun, reapStaleRuns } from '../pipeline/run-records.js';
import { listFonts } from '../pipeline/shared-fonts.js';
import type { StreamEvent } from '../pipeline/stream-parser.js';
import { graphicRunUsage } from '../usage/app-usage.js';
import type { AppUsage } from '../usage/usage-log.js';
import { graphicFontsDir, graphicWorkDir } from './graphic-folders.js';
import { buildGraphicPrompt, GRAPHIC_CHECK_SCRIPT } from './graphic-prompt.js';
import type { GraphicRunner, GraphicRunOutcome, GraphicRunRequest } from './graphic-run.js';

/** The built-in tools a graphic run gets, all of them without asking. Skill loads the hyperframes skills. */
export const GRAPHIC_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Skill'] as const;

/** Every marker of a graphic run carries this. */
export const GRAPHIC_MARKER_FIELDS = { run: 'graphic' } as const;

/** The error of a run that was stopped (Stop, a delete, the engine's shutdown). */
export const GRAPHIC_RUN_STOPPED = 'The run was stopped.';

/** Where the run records of all graphics go: one folder per graphic in it. */
export function graphicRunsDir(dataDir: string): string {
  return join(dataDir, 'graphic-runs');
}

/** Where the run record of one graphic's run goes. */
export function graphicRunRecordsDir(dataDir: string, graphicId: string): string {
  return join(graphicRunsDir(dataDir), graphicId);
}

/** `<logs>/graphics/<id>.log`: every run of one graphic, one after the other. */
export function graphicLogPath(logsDir: string, graphicId: string): string {
  return join(logsDir, 'graphics', `${graphicId}.log`);
}

/**
 * Stops whatever an earlier engine left running of any graphic run and deletes the records, for the
 * worker's boot (before it takes runs). Never throws.
 */
export async function reapGraphicRuns(
  dataDir: string,
  { graceMs = KILL_GRACE_MS }: { graceMs?: number } = {},
): Promise<ReapedRun[]> {
  let folders: string[];
  try {
    folders = (await readdir(graphicRunsDir(dataDir), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const reaped: ReapedRun[] = [];
  for (const folder of folders) {
    const dir = join(graphicRunsDir(dataDir), folder);
    reaped.push(...(await reapStaleRuns(dir, { graceMs })));
    await rmdir(dir).catch(() => undefined);
  }
  return reaped;
}

/** Arguments of a graphic run after the binary. `model` unset leaves the CLI's default. */
export function graphicClaudeArgs({
  prompt,
  model,
  effort,
  denyRead = [],
}: {
  prompt: string;
  model?: string;
  effort: Effort;
  denyRead?: readonly string[];
}): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(model ? ['--model', model] : []),
    '--effort',
    effort,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    GRAPHIC_TOOLS.join(','),
    '--allowedTools',
    GRAPHIC_TOOLS.join(' '),
    '--strict-mcp-config',
    '--settings',
    JSON.stringify({
      disableAllHooks: true,
      ...(denyRead.length > 0 ? { permissions: { deny: denyRead } } : {}),
    }),
  ];
}

/** A Bash command that checks the graphic: hyperframes lint, snapshot or check, or the engine's check script. */
const CHECK_COMMAND = /\bhyperframes\b[^\n]*\b(?:lint|snapshot|check)\b|check-graphic\.mjs/;

/** A path the run writes that is under compositions/ (relative to work/, or absolute). */
function isCompositionPath(path: unknown): boolean {
  return typeof path === 'string' && /(?:^|\/)compositions\//.test(path);
}

/**
 * Follows the run's steps from its tool calls and tells `onStep` each time it moves on: 1 at the
 * first Write or Edit of a file under compositions/, 2 at the first Bash that runs the check once
 * it is at 1. It never goes back.
 */
export function graphicStepTracker(onStep: (step: GraphicStep) => void): {
  onEvent(event: StreamEvent): void;
  readonly step: GraphicStep;
} {
  let step: GraphicStep = 0;
  const move = (to: GraphicStep) => {
    if (to <= step) return;
    step = to;
    onStep(to);
  };
  return {
    get step() {
      return step;
    },
    onEvent(event) {
      if (event.kind !== 'tool_use') return;
      if (
        (event.name === 'Write' || event.name === 'Edit') &&
        isCompositionPath(event.input.file_path)
      ) {
        move(1);
      } else if (
        event.name === 'Bash' &&
        step >= 1 &&
        typeof event.input.command === 'string' &&
        CHECK_COMMAND.test(event.input.command)
      ) {
        move(2);
      }
    },
  };
}

function failed(error: string): GraphicRunOutcome {
  return { ok: false, error: trimMessage(error) };
}

export type ClaudeGraphicConfig = Pick<
  Config,
  'inboxPath' | 'logsDir' | 'dataDir' | 'claudeBin' | 'model'
> &
  Partial<Pick<Config, 'claudePlanOnly'>>;

export interface ClaudeGraphicRunnerOptions {
  config: ClaudeGraphicConfig;
  logger?: RunnerLogger;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  /** The server's environment (PATH, pass-through variables); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** SIGTERM -> SIGKILL grace. Default 10 s. */
  killGraceMs?: number;
  /** Default GRAPHIC_LIMITS.runTimeoutMs (tests use less). */
  timeoutMs?: number;
  /** How often the process tree is sampled while running. Default 3 s. */
  sampleIntervalMs?: number;
  /** Folder with graphic-make.md, graphic-change.md and graphic-rules.md. */
  promptsDir?: string;
}

/** The real graphic run. OWNER: GR2. */
export class ClaudeGraphicRunner implements GraphicRunner {
  readonly kind = 'claude' as const;
  readonly options: ClaudeGraphicRunnerOptions;
  private readonly logger: RunnerLogger;
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private readonly killGraceMs: number;
  private readonly timeoutMs: number;
  private readonly sampleIntervalMs: number;
  private readonly promptsDir: string;

  constructor(options: ClaudeGraphicRunnerOptions) {
    this.options = options;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.timeoutMs = options.timeoutMs ?? GRAPHIC_LIMITS.runTimeoutMs;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.promptsDir = options.promptsDir ?? PROMPTS_DIR;
  }

  private get config(): ClaudeGraphicConfig {
    return this.options.config;
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

  async run(request: GraphicRunRequest): Promise<GraphicRunOutcome> {
    const { signal, graphic } = request;
    if (signal.aborted) return failed(GRAPHIC_RUN_STOPPED);

    const control = new StopControl(this.killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    const steps = graphicStepTracker((step) => request.onStep(step));
    let log: JobLog | null = null;
    const end = (
      outcome: RunEndOutcome,
      result: GraphicRunOutcome,
      fields: Record<string, unknown> = {},
    ): GraphicRunOutcome => {
      const error = result.ok ? undefined : result.error;
      const durationMs = Date.now() - startedAt;
      log?.marker('graphic_end', {
        ...GRAPHIC_MARKER_FIELDS,
        graphicId: graphic.id,
        messageId: request.message.id,
        version: request.version,
        outcome,
        ...(error === undefined ? {} : { error }),
        exitCode: null,
        signal: null,
        sessionId: null,
        step: steps.step,
        ...fields,
        durationMs,
      });
      const entry = { graphicId: graphic.id, version: request.version, outcome, error, durationMs };
      if (outcome === 'failed' || outcome === 'timed_out') {
        this.logger.warn(entry, 'graphic run failed');
      } else {
        this.logger.info(entry, 'graphic run ended');
      }
      return result;
    };

    try {
      log = await JobLog.open(graphicLogPath(this.config.logsDir, graphic.id));
      return await this.execute(request, log, control, steps, end);
    } catch (err) {
      if (isRequestedStop(control.reason)) return end(control.reason, failed(GRAPHIC_RUN_STOPPED));
      this.logger.error({ graphicId: graphic.id, err }, 'graphic run broke');
      return end('failed', failed(`The run could not start: ${errorText(err)}`));
    } finally {
      signal.removeEventListener('abort', onAbort);
      await log?.close();
      if (log?.error) {
        this.logger.warn(
          { graphicId: graphic.id, err: log.error },
          'could not write the graphic log',
        );
      }
    }
  }

  private async execute(
    request: GraphicRunRequest,
    log: JobLog,
    control: StopControl,
    steps: ReturnType<typeof graphicStepTracker>,
    end: (
      outcome: RunEndOutcome,
      result: GraphicRunOutcome,
      fields?: Record<string, unknown>,
    ) => GraphicRunOutcome,
  ): Promise<GraphicRunOutcome> {
    const { graphic, message, version } = request;
    const records = graphicRunRecordsDir(this.config.dataDir, graphic.id);
    const reaped = await reapStaleRuns(records, { graceMs: this.killGraceMs });
    for (const stale of reaped) {
      this.logger.warn({ ...stale }, 'stopped a graphic run left over from an earlier engine');
      log.marker('reaped', { ...GRAPHIC_MARKER_FIELDS, ...stale });
    }

    const cwd = graphicWorkDir(graphic.dir);
    const fonts = await listFonts(graphicFontsDir(graphic.dir));
    const prompt = await buildGraphicPrompt(
      {
        id: graphic.id,
        version,
        first: request.first,
        asked: message.text,
        conversation: request.conversation,
        refs: message.refs,
        fonts,
      },
      this.promptsDir,
    );
    const bin = this.resolveBin();
    if (bin === null) {
      return end(
        'failed',
        failed(
          'Claude Code was not found. Open the Claude desktop app once, or set "claudeBin" in ~/.studio-engine/config.json, then run `pnpm run doctor`.',
        ),
      );
    }

    const model = this.config.model;
    const args = graphicClaudeArgs({
      prompt,
      ...(model ? { model } : {}),
      effort: message.effort,
      denyRead: readDenyRulesOutsideJob(this.config.inboxPath, graphic.dir),
    });
    const runTag = `graphic-${graphic.id}-${randomUUID()}`;
    log.marker('graphic_start', {
      ...GRAPHIC_MARKER_FIELDS,
      graphicId: graphic.id,
      name: graphic.name,
      messageId: message.id,
      version,
      first: request.first,
      refs: message.refs,
      bin: bin.path,
      binSource: bin.source,
      cwd,
      model: model ?? null,
      effort: message.effort,
      checkScript: GRAPHIC_CHECK_SCRIPT,
      timeoutMs: this.timeoutMs,
      runTag,
      flags: args.slice(2),
      prompt,
    });
    if (isRequestedStop(control.reason)) return end(control.reason, failed(GRAPHIC_RUN_STOPPED));

    // v1 starts as "New graphic …"; its usage line takes the name the run gives it in about.json.
    const usage: AppUsage = { ...graphicRunUsage(graphic.name, version) };
    const denied = new DenialCollector();
    const result = await runClaudeProcess({
      jobId: `graphic-${graphic.id}`,
      label: 'graphic run',
      bin,
      args,
      cwd,
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
      markerFields: GRAPHIC_MARKER_FIELDS,
      onStarted: () => ({
        onEvent: (event) => {
          denied.onEvent(event);
          steps.onEvent(event);
        },
        stop: async () => {
          if (!request.first) return;
          const name = await nameFromAbout(cwd);
          if (name !== null) usage.did = graphicRunUsage(name, version).did;
        },
      }),
      usage,
    });
    if (!result.started) return end('failed', failed(result.error));

    const denials = denied.denials();
    for (const denial of denials) {
      this.logger.warn(
        { graphicId: graphic.id, tool: denial.tool, detail: denial.detail },
        'graphic run: a tool call was denied by the permission rules',
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
    if (isRequestedStop(stoppedBy)) return end(stoppedBy, failed(GRAPHIC_RUN_STOPPED), fields);
    if (stoppedBy === 'timed_out') {
      return end('timed_out', failed(GRAPHIC_MESSAGES.timedOut), fields);
    }

    const last = result.stream.lastResult;
    if (result.exitCode === 0) {
      const text = last?.text ?? result.stream.lastText ?? '';
      const blocked = blockedReason(text);
      if (blocked !== null) return end('failed', failed(blocked), fields);
      if (last?.isError)
        return end('failed', failed(last.text || 'Claude stopped with an error.'), fields);
      return end('succeeded', { ok: true }, fields);
    }
    const error = describeFailure({
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
      stream: result.stream,
    });
    return end('failed', failed(error), fields);
  }
}

/** The `name` in work/about.json, when the run wrote a readable one. */
async function nameFromAbout(workDir: string): Promise<string | null> {
  try {
    const about = graphicAboutSchema.safeParse(
      JSON.parse(await readFile(join(workDir, 'about.json'), 'utf8')),
    );
    return about.success && about.data.name !== undefined ? about.data.name : null;
  } catch {
    return null;
  }
}
