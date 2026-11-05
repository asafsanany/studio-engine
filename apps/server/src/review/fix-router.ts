// The router of quick fixes (QF1): with Auto, the effort for review rounds, a small Haiku run reads
// each note the moment it is added and sorts it with the difficulty index (prompts/fix-index.md)
// into a tier (quick, revise or full), a kind and a why. This file is the run; when a note is routed
// and what is saved is note-routing.ts.
//
// `ClaudeNoteRouter` is built like the topic pass's run (analytics/note-topics-claude.ts):
//
//   claude -p <prompt> --output-format stream-json --verbose --model haiku
//     --permission-mode dontAsk --permission-prompts none --tools "" --strict-mcp-config
//     --settings {"disableAllHooks":true}
//   cwd = <dataDir>/fix-route-runs/work (an empty folder), the environment of the edit run (claudeEnv)
//
// no tools and no effort flag. The stream goes to `<logsDir>/fix-route.log` between a
// `fix_route_start` and a `fix_route_end` marker; a shutdown stops the whole process tree; a run
// is stopped after FIX_LIMITS.routeSec; its run record goes to `<dataDir>/fix-route-runs` (records
// found there before the first run are ones a crashed engine left, and are reaped once); and its
// tokens are logged to usage.jsonl under the `fix-route` tag by runClaudeProcess. Up to three runs
// go at once (note-routing.ts), so every run has a record, a tag and a log section of its own.
//
// The answer is the last JSON object of the result text, checked with zod. A bad answer or a failed
// run gets one retry; after that the note is `full`, which is today's behaviour, so Auto is never
// worse than before. A run the engine stopped is not an answer: `route` rejects with the abort.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  FIX_LIMITS,
  type Job,
  type NoteRoute,
  type ReviewNote,
  ROUTER_MODEL,
} from '@studio/shared';
import type { Config } from '../config.js';
import { readGeneratedJob } from '../generate/generated-job.js';
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
  stopRequestedBy,
} from '../pipeline/claude-process.js';
import { describeFailure, trimMessage } from '../pipeline/failure.js';
import { JobLog, type RunEndOutcome } from '../pipeline/job-log.js';
import { oneLine } from '../pipeline/prompts.js';
import { reapStaleRuns } from '../pipeline/run-records.js';
import { fixRouteUsage } from '../usage/app-usage.js';
import type { AppUsage } from '../usage/usage-log.js';
import { buildRoutePrompt, parseRouteAnswer, readProjectNotes } from './fix-route-prompt.js';

/** Sorts one review note. Rejects only when `signal` aborts; any other trouble is the `full` route. */
export interface NoteRouter {
  route(job: Job, note: ReviewNote, signal?: AbortSignal): Promise<NoteRoute>;
}

/** What a router answers when it cannot read a note: the whole video, which is what a note did before Auto. */
export const UNREADABLE_ROUTE: NoteRoute = {
  tier: 'full',
  kind: 'unknown',
  why: "Auto couldn't read it",
};

export const FIX_ROUTE_TIMEOUT_MS = FIX_LIMITS.routeSec * 1000;

export const FIX_ROUTE_STOPPED = 'Fix router stopped:';

const MARKER_FIELDS = { run: 'fix-route' } as const;

/** Where the runs' records go (run-records.ts reaps every .json in it, so nothing else lives there). */
export function fixRouteRunsDir(dataDir: string): string {
  return join(dataDir, 'fix-route-runs');
}

/** The runs' working folder: empty, and apart from the records. */
export function fixRouteWorkDir(dataDir: string): string {
  return join(fixRouteRunsDir(dataDir), 'work');
}

export function fixRouteLogPath(logsDir: string): string {
  return join(logsDir, 'fix-route.log');
}

/** Arguments of the run after the binary. */
export function fixRouteClaudeArgs(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    ROUTER_MODEL,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    '',
    '--strict-mcp-config',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
  ];
}

// --- one run -------------------------------------------------------------------------------------

/** What the router needs from "a Claude run": give it a prompt, get the text it answered with. Tests give the router a stand-in. */
export interface RouteRunRequest {
  prompt: string;
  /** The run's usage tag and line, logged to usage.jsonl once it has ended. */
  usage: AppUsage;
  /** Aborted when the engine shuts down, or the note changes. */
  signal: AbortSignal;
  /** Extra fields for the run's start marker in the log (the job and note ids). */
  fields?: Record<string, unknown>;
}

export type RouteRunOutcome =
  | { ok: true; text: string }
  /** `error` is one plain line for the log. */
  | { ok: false; error: string };

export interface RouteRunner {
  run(request: RouteRunRequest): Promise<RouteRunOutcome>;
}

export type ClaudeRouteConfig = Pick<Config, 'logsDir' | 'dataDir' | 'claudeBin'> &
  Partial<Pick<Config, 'claudePlanOnly'>>;

export interface ClaudeRouteRunnerOptions {
  config: ClaudeRouteConfig;
  logger?: RunnerLogger;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  /** The server's environment (PATH, pass-through variables); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** SIGTERM -> SIGKILL grace. Default 10 s. */
  killGraceMs?: number;
  /** Default FIX_LIMITS.routeSec (tests use less). */
  timeoutMs?: number;
  /** How often the process tree is sampled while running. Default 3 s. */
  sampleIntervalMs?: number;
}

/** The headless Haiku run: one `claude -p` per call, any number at once. */
export class ClaudeRouteRunner implements RouteRunner {
  private readonly config: ClaudeRouteConfig;
  private readonly logger: RunnerLogger;
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private readonly killGraceMs: number;
  private readonly timeoutMs: number;
  private readonly sampleIntervalMs: number;
  /** Records a crashed engine left are reaped once, before the first run starts. */
  private reaped: Promise<void> | null = null;

  constructor(options: ClaudeRouteRunnerOptions) {
    this.config = options.config;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.timeoutMs = options.timeoutMs ?? FIX_ROUTE_TIMEOUT_MS;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
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

  async run(request: RouteRunRequest): Promise<RouteRunOutcome> {
    const { signal } = request;
    if (signal.aborted) return stopped('the run was stopped.');

    const control = new StopControl(this.killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    let log: JobLog | null = null;
    // Every marker of this run carries its tag, so the runs that share the log can be told apart.
    const runTag = `fix-route-${randomUUID()}`;
    const end = (
      outcome: RunEndOutcome,
      result: RouteRunOutcome,
      fields: Record<string, unknown> = {},
    ): RouteRunOutcome => {
      const error = result.ok ? undefined : result.error;
      log?.marker('fix_route_end', {
        ...MARKER_FIELDS,
        runTag,
        outcome,
        ...(error === undefined ? {} : { error }),
        exitCode: null,
        signal: null,
        sessionId: null,
        ...fields,
        durationMs: Date.now() - startedAt,
      });
      return result;
    };

    try {
      log = await JobLog.open(fixRouteLogPath(this.config.logsDir));
      return await this.execute(request, runTag, log, control, end);
    } catch (err) {
      if (isRequestedStop(control.reason))
        return end(control.reason, stopped('the run was stopped.'));
      return end('failed', stopped(`the run could not start: ${errorText(err)}`));
    } finally {
      signal.removeEventListener('abort', onAbort);
      await log?.close();
      if (log?.error) {
        this.logger.warn({ err: log.error }, 'could not write the fix router log');
      }
    }
  }

  private reapOnce(records: string, log: JobLog): Promise<void> {
    this.reaped ??= reapStaleRuns(records, { graceMs: this.killGraceMs }).then((reaped) => {
      for (const stale of reaped) {
        this.logger.warn({ ...stale }, 'stopped a fix router run left over from an earlier engine');
        log.marker('reaped', { ...MARKER_FIELDS, ...stale });
      }
    });
    return this.reaped;
  }

  private async execute(
    request: RouteRunRequest,
    runTag: string,
    log: JobLog,
    control: StopControl,
    end: (
      outcome: RunEndOutcome,
      result: RouteRunOutcome,
      fields?: Record<string, unknown>,
    ) => RouteRunOutcome,
  ): Promise<RouteRunOutcome> {
    const records = fixRouteRunsDir(this.config.dataDir);
    const cwd = fixRouteWorkDir(this.config.dataDir);
    await mkdir(cwd, { recursive: true });
    await this.reapOnce(records, log);

    const bin = this.resolveBin();
    if (bin === null) {
      return end(
        'failed',
        stopped(
          'Claude Code was not found. Open the Claude desktop app once, or set "claudeBin" in ~/.studio-engine/config.json, then run `pnpm run doctor`.',
        ),
      );
    }

    const args = fixRouteClaudeArgs(request.prompt);
    log.marker('fix_route_start', {
      ...MARKER_FIELDS,
      ...request.fields,
      bin: bin.path,
      binSource: bin.source,
      cwd,
      model: ROUTER_MODEL,
      timeoutMs: this.timeoutMs,
      runTag,
      flags: args.slice(2),
      prompt: request.prompt,
    });
    if (isRequestedStop(control.reason))
      return end(control.reason, stopped('the run was stopped.'));

    const result = await runClaudeProcess({
      // The record's name: one per run, so a run's record is never another run's.
      jobId: runTag,
      label: 'fix router run',
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
      markerFields: { ...MARKER_FIELDS, runTag },
      usage: request.usage,
    });
    if (!result.started) return end('failed', stopped(result.error));

    const fields = {
      exitCode: result.exitCode,
      signal: result.signal,
      sessionId: result.stream.sessionId,
      pid: result.pid,
    };
    const stoppedBy = result.stoppedBy;
    if (isRequestedStop(stoppedBy)) return end(stoppedBy, stopped('the run was stopped.'), fields);
    if (stoppedBy === 'timed_out') {
      return end(
        'timed_out',
        stopped(`it took longer than ${FIX_LIMITS.routeSec} seconds.`),
        fields,
      );
    }

    const answer = result.stream.lastResult;
    if (result.exitCode === 0) {
      if (answer !== null && !answer.isError) {
        return end('succeeded', { ok: true, text: answer.text }, fields);
      }
      const reason = answer?.isError ? answer.text : 'Claude finished without an answer.';
      return end('failed', stopped(reason), fields);
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

function stopped(error: string): RouteRunOutcome {
  return { ok: false, error: trimMessage(`${FIX_ROUTE_STOPPED} ${error}`) };
}

// --- the router ----------------------------------------------------------------------------------

export interface ClaudeNoteRouterOptions extends ClaudeRouteRunnerOptions {
  /** A job's folder is `<inboxPath>/<job.relPath>`; edit/project.md in it tells what the edit added and where the cut stands against the music. */
  config: ClaudeRouteConfig & Pick<Config, 'inboxPath'>;
  /** What makes a run. Default: the headless Haiku run. Replaced in tests. */
  runner?: RouteRunner;
}

/** The real router: the prompt, one Haiku run, the answer checked; one retry; then `full`. */
export class ClaudeNoteRouter implements NoteRouter {
  private readonly inboxPath: string;
  private readonly runner: RouteRunner;
  private readonly logger: RunnerLogger;

  constructor(options: ClaudeNoteRouterOptions) {
    this.inboxPath = options.config.inboxPath;
    this.runner = options.runner ?? new ClaudeRouteRunner(options);
    this.logger = options.logger ?? SILENT_LOGGER;
  }

  async route(job: Job, note: ReviewNote, signal?: AbortSignal): Promise<NoteRoute> {
    const abort = signal ?? new AbortController().signal;
    abort.throwIfAborted();
    const text = note.text?.trim() ?? '';
    if (text === '') return UNREADABLE_ROUTE;

    let prompt: string;
    try {
      const jobDir = join(this.inboxPath, job.relPath);
      const { editAdded, aboutCut } = await readProjectNotes(jobDir);
      // A generated video (GN6): the prompt has one more section about clip and voice notes.
      const generated = (await readGeneratedJob(jobDir)) !== null;
      prompt = await buildRoutePrompt({
        atSec: note.atSec,
        text,
        editAdded,
        aboutCut,
        ...(generated ? { generated } : {}),
      });
    } catch (err) {
      abort.throwIfAborted();
      this.logger.warn(
        { err, jobId: job.id, noteId: note.id },
        'could not build the router prompt',
      );
      return UNREADABLE_ROUTE;
    }

    let problem = '';
    for (const attempt of [1, 2]) {
      abort.throwIfAborted();
      const outcome = await this.runner.run({
        prompt:
          attempt === 1
            ? prompt
            : `${prompt}\nYour first answer could not be used: ${oneLine(problem)} Answer again: one line of JSON and nothing else.\n`,
        usage: fixRouteUsage(job),
        signal: abort,
        fields: { jobId: job.id, noteId: note.id, attempt },
      });
      // A run the engine (or a changed note) stopped is not an answer to retry.
      abort.throwIfAborted();
      if (outcome.ok) {
        const answer = parseRouteAnswer(outcome.text);
        if (answer.ok) return answer.route;
        problem = `${answer.error}.`;
      } else {
        problem = `${outcome.error}`;
      }
      this.logger.warn(
        { jobId: job.id, noteId: note.id, attempt, problem },
        attempt === 1
          ? 'the router could not sort a note; trying once more'
          : 'the router could not sort a note; it goes with Send',
      );
    }
    return UNREADABLE_ROUTE;
  }
}
