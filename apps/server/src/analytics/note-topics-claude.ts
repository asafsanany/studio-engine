// The Claude run of the topic pass (Analytics plan, AN4): one short headless Sonnet session that
// answers a prompt in text. Unlike the style runs it writes no file and gets no tools at all, so
// there is nothing for it to read or change.
//
//   claude -p <prompt> --output-format stream-json --verbose --model sonnet
//     --permission-mode dontAsk --permission-prompts none --tools "" --strict-mcp-config
//     --settings {"disableAllHooks":true}
//   cwd = <dataDir>/note-topics-runs/work (an empty folder), the environment of the edit run (claudeEnv)
//
// It is handled like the style run (clients/claude-style.ts, claude-process.ts): the stream goes to
// `<logsDir>/note-topics.log` between a `note_topics_start` and a `note_topics_end` marker; a
// shutdown stops the whole process tree; after 5 minutes it is stopped; its run record goes to
// `<dataDir>/note-topics-runs` (a record found there before a run is one a crashed engine left);
// and its tokens are logged to usage.jsonl under the `note-topics` tag by runClaudeProcess.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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
  stopRequestedBy,
} from '../pipeline/claude-process.js';
import { describeFailure, trimMessage } from '../pipeline/failure.js';
import { JobLog, type RunEndOutcome } from '../pipeline/job-log.js';
import { reapStaleRuns } from '../pipeline/run-records.js';
import type {
  NoteTopicRunner,
  NoteTopicRunOutcome,
  NoteTopicRunRequest,
} from './note-topics-run.js';

/** Labelling a few notes needs no Opus. */
export const NOTE_TOPICS_MODEL = 'sonnet';

/** A run with no tools answers in seconds; this only stops one that hangs. */
export const NOTE_TOPICS_TIMEOUT_MS = 5 * 60_000;

export const NOTE_TOPICS_STOPPED = 'Note topics stopped:';

const MARKER_FIELDS = { run: 'note-topics' } as const;

/** Where the run's record goes (run-records.ts reaps every .json in it, so nothing else lives there). */
export function noteTopicsRunsDir(dataDir: string): string {
  return join(dataDir, 'note-topics-runs');
}

/** The run's working folder: empty, and apart from the records. */
export function noteTopicsWorkDir(dataDir: string): string {
  return join(noteTopicsRunsDir(dataDir), 'work');
}

export function noteTopicsLogPath(logsDir: string): string {
  return join(logsDir, 'note-topics.log');
}

/** Arguments of the run after the binary. */
export function noteTopicsClaudeArgs(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    NOTE_TOPICS_MODEL,
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

export type ClaudeNoteTopicConfig = Pick<Config, 'logsDir' | 'dataDir' | 'claudeBin'> &
  Partial<Pick<Config, 'claudePlanOnly'>>;

export interface ClaudeNoteTopicRunnerOptions {
  config: ClaudeNoteTopicConfig;
  logger?: RunnerLogger;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  /** The server's environment (PATH, pass-through variables); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** SIGTERM -> SIGKILL grace. Default 10 s. */
  killGraceMs?: number;
  /** Default 5 minutes (tests use less). */
  timeoutMs?: number;
  /** How often the process tree is sampled while running. Default 3 s. */
  sampleIntervalMs?: number;
}

export class ClaudeNoteTopicRunner implements NoteTopicRunner {
  private readonly config: ClaudeNoteTopicConfig;
  private readonly logger: RunnerLogger;
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private readonly killGraceMs: number;
  private readonly timeoutMs: number;
  private readonly sampleIntervalMs: number;

  constructor(options: ClaudeNoteTopicRunnerOptions) {
    this.config = options.config;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.timeoutMs = options.timeoutMs ?? NOTE_TOPICS_TIMEOUT_MS;
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

  async run(request: NoteTopicRunRequest): Promise<NoteTopicRunOutcome> {
    const { signal } = request;
    if (signal.aborted) return stopped('the run was stopped.');

    const control = new StopControl(this.killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    let log: JobLog | null = null;
    const end = (
      outcome: RunEndOutcome,
      result: NoteTopicRunOutcome,
      fields: Record<string, unknown> = {},
    ): NoteTopicRunOutcome => {
      const error = result.ok ? undefined : result.error;
      log?.marker('note_topics_end', {
        ...MARKER_FIELDS,
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
      log = await JobLog.open(noteTopicsLogPath(this.config.logsDir));
      return await this.execute(request, log, control, end);
    } catch (err) {
      if (isRequestedStop(control.reason))
        return end(control.reason, stopped('the run was stopped.'));
      return end('failed', stopped(`the run could not start: ${errorText(err)}`));
    } finally {
      signal.removeEventListener('abort', onAbort);
      await log?.close();
      if (log?.error) {
        this.logger.warn({ err: log.error }, 'could not write the note topics log');
      }
    }
  }

  private async execute(
    request: NoteTopicRunRequest,
    log: JobLog,
    control: StopControl,
    end: (
      outcome: RunEndOutcome,
      result: NoteTopicRunOutcome,
      fields?: Record<string, unknown>,
    ) => NoteTopicRunOutcome,
  ): Promise<NoteTopicRunOutcome> {
    const records = noteTopicsRunsDir(this.config.dataDir);
    const cwd = noteTopicsWorkDir(this.config.dataDir);
    await mkdir(cwd, { recursive: true });
    const reaped = await reapStaleRuns(records, { graceMs: this.killGraceMs });
    for (const stale of reaped) {
      this.logger.warn({ ...stale }, 'stopped a note topics run left over from an earlier engine');
      log.marker('reaped', { ...MARKER_FIELDS, ...stale });
    }

    const bin = this.resolveBin();
    if (bin === null) {
      return end(
        'failed',
        stopped(
          'Claude Code was not found. Open the Claude desktop app once, or set "claudeBin" in ~/.studio-engine/config.json, then run `pnpm run doctor`.',
        ),
      );
    }

    const args = noteTopicsClaudeArgs(request.prompt);
    const runTag = `note-topics-${randomUUID()}`;
    log.marker('note_topics_start', {
      ...MARKER_FIELDS,
      bin: bin.path,
      binSource: bin.source,
      cwd,
      model: NOTE_TOPICS_MODEL,
      timeoutMs: this.timeoutMs,
      runTag,
      flags: args.slice(2),
      prompt: request.prompt,
    });
    if (isRequestedStop(control.reason))
      return end(control.reason, stopped('the run was stopped.'));

    const result = await runClaudeProcess({
      jobId: 'note-topics',
      label: 'note topics run',
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
      markerFields: MARKER_FIELDS,
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
      return end('timed_out', stopped('it took longer than 5 minutes.'), fields);
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

function stopped(error: string): NoteTopicRunOutcome {
  return { ok: false, error: trimMessage(`${NOTE_TOPICS_STOPPED} ${error}`) };
}
