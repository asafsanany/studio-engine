// One headless `claude -p` process, from spawn to "nothing of it is left running": the part the
// edit run (claude-runner.ts) and the Brief run (claude-brief.ts) share.
//
//   - spawned detached (its own process group), stdin ignored, with the environment it is given
//   - every stdout line goes to the job log verbatim and through the stream parser; each stderr
//     line becomes a `stderr` marker
//   - a stop (the user's Cancel, the engine's shutdown, the time limit) sends SIGTERM to the whole
//     process tree, then SIGKILL after the grace period (process-tree.ts)
//   - once the process has exited, anything it left behind is stopped too, and its run record
//     (run-records.ts, for reaping after a crash) is removed
//
// It judges nothing: the caller decides from the exit, the stop reason and the stream summary
// whether the run did its job, and writes its own `start` and `end` markers.

import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import { appendLimits } from '../analytics/limits-log.js';
import { type AppUsage, logAppUsage } from '../usage/usage-log.js';
import type { ClaudeBin } from './claude-bin.js';
import { tildePath } from './claude-command.js';
import { describeFailure } from './failure.js';
import type { JobLog } from './job-log.js';
import { ProcessTree, type TerminateResult } from './process-tree.js';
import { processIdentity, removeRunRecord, runsDir, writeRunRecord } from './run-records.js';
import { abortReasonOf } from './runner.js';
import {
  emptySummary,
  parseStreamLine,
  type StreamEvent,
  type StreamSummary,
  summarize,
} from './stream-parser.js';

/** The part of a pino logger the runners use. Defaults to logging nothing. */
export interface RunnerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export const SILENT_LOGGER: RunnerLogger = { info() {}, warn() {}, error() {} };

export const KILL_GRACE_MS = 10_000;
export const SAMPLE_INTERVAL_MS = 3_000;
/** After the exit and the cleanup, how long the pipes get to drain before they are closed. */
const DRAIN_MS = 5_000;
const STDERR_LINES_KEPT = 20;
const STDERR_LINE_MAX = 2_000;

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why the runner stopped the process itself. */
export type StopReason = 'cancelled' | 'stopped' | 'timed_out';

/** A stop somebody asked for (the user's Cancel, the engine's shutdown), as opposed to a timeout. */
export type RequestedStop = Exclude<StopReason, 'timed_out'>;

export function isRequestedStop(reason: StopReason | null): reason is RequestedStop {
  return reason === 'cancelled' || reason === 'stopped';
}

/** The stop the worker's abort asks for: `stopped` when the engine shuts down, else `cancelled`. */
export function stopRequestedBy(signal: AbortSignal): RequestedStop {
  return abortReasonOf(signal) === 'shutdown' ? 'stopped' : 'cancelled';
}

/**
 * A stop can be asked for at any moment (the abort, the timeout); it acts once there is a process
 * tree to stop. Before that it means "don't start one".
 */
export class StopControl {
  reason: StopReason | null = null;
  stopping: Promise<TerminateResult> | null = null;
  private tree: ProcessTree | null = null;
  private settled = false;
  private readonly graceMs: number;

  constructor(graceMs: number) {
    this.graceMs = graceMs;
  }

  request(reason: StopReason): void {
    if (this.settled) return;
    this.reason ??= reason;
    this.kick();
  }

  attach(tree: ProcessTree): void {
    this.tree = tree;
    this.kick();
  }

  /**
   * The process has exited. Returns why the runner was stopping it then (`null`: it ended on its
   * own), and from now on a request changes nothing: a cancel that arrives while a finished run
   * is being cleaned up must not turn it into a cancelled one.
   */
  settle(): StopReason | null {
    const reason = this.stopping === null ? null : this.reason;
    this.tree = null;
    this.reason = reason;
    this.settled = true;
    return reason;
  }

  private kick(): void {
    if (this.reason === null || this.tree === null || this.stopping !== null) return;
    this.stopping = this.tree.terminate({ graceMs: this.graceMs });
  }
}

/** What happens to the stream while the process runs. */
export interface StreamTracker {
  /** Every event of the stream, in order. If it throws, the tracker gets no more events. */
  onEvent?(event: StreamEvent): void;
  /** The process has exited and its output is read; called before the result is returned. */
  stop?(): void | Promise<void>;
}

export interface ClaudeProcessSpec {
  jobId: string;
  /** For log messages: "edit run" or "brief run". */
  label: string;
  bin: ClaudeBin;
  args: string[];
  cwd: string;
  /** The complete environment (`childEnv`); it is never logged. */
  env: Record<string, string>;
  /** The run's STUDIO_ENGINE_RUN value: every process of it carries it. */
  runTag: string;
  log: JobLog;
  control: StopControl;
  /** `Config.dataDir`: run records go to `<dataDir>/runs`. */
  dataDir: string;
  /**
   * Where the run record goes instead of `<dataDir>/runs`. The style runs keep theirs apart: the
   * edit and Brief runs stop everything recorded in `runs/` before they start, and a style run
   * may be going on beside them.
   */
  runsDir?: string;
  home: string;
  killGraceMs: number;
  /** After this, the run is stopped as `timed_out`. */
  timeoutMs: number;
  sampleIntervalMs: number;
  logger: RunnerLogger;
  /** Added to every marker written here (`stderr`, `cleanup`), e.g. `{ run: 'brief' }`. */
  markerFields?: Record<string, unknown>;
  /** Added to the "started" server log entry, e.g. `{ mode }`. */
  logFields?: Record<string, unknown>;
  /** Called once the process has started, before any line can arrive. */
  onStarted?: (pid: number) => StreamTracker | undefined;
  /** What the run is for: logged with its tokens to <dataDir>/usage.jsonl once it has ended. */
  usage?: AppUsage;
  /**
   * The plan probe sets this: a limit reading that says what the last line of limits.jsonl says is
   * still written when that line is older than this (see `appendLimits`).
   */
  limitsRefreshMs?: number;
}

export type ClaudeProcessResult =
  /** The binary could not be started; `error` is the line to show. */
  | { started: false; error: string }
  | {
      started: true;
      pid: number;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      /** Why the process was being stopped when it exited; `null` when it ended on its own. */
      stoppedBy: StopReason | null;
      stream: StreamSummary;
      /** The last stderr lines, joined. */
      stderr: string;
    };

/** Spawns the process and resolves once it has exited and nothing of it is left running. */
export async function runClaudeProcess(spec: ClaudeProcessSpec): Promise<ClaudeProcessResult> {
  const { jobId, label, bin, args, cwd, env, runTag, log, control, logger } = spec;
  const markerFields = spec.markerFields ?? {};
  const records = spec.runsDir ?? runsDir(spec.dataDir);

  const subprocess = execa(bin.path, args, {
    cwd,
    env,
    extendEnv: false,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    cleanup: false,
    buffer: false,
    reject: false,
    forceKillAfterDelay: false,
    encoding: 'utf8',
  });
  const child = subprocess.nodeChildProcess;
  // Settles once the process is gone and its pipes are closed. With `reject: false` a failure
  // to spawn resolves too, with `failed` and the error `code` (ENOENT, EACCES, ...).
  let spawnFailure: { code?: string; message?: string } | null = null;
  const finished = subprocess.then(
    (result) => {
      if (result.failed && result.exitCode === undefined && result.signal === undefined) {
        spawnFailure = { code: result.code, message: result.shortMessage ?? result.message };
      }
    },
    (err: unknown) => {
      spawnFailure = { message: errorText(err) };
    },
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  // The readers go on right away, so no line can come before them. The tracker is created as
  // soon as the process has started, before any line can arrive.
  let tracker: StreamTracker | undefined;
  let trackerBroken = false;
  const summary = emptySummary();
  const stdoutLines = createInterface({
    input: subprocess.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  stdoutLines.on('line', (line) => {
    log.line(line);
    for (const event of parseStreamLine(line)) {
      summarize(summary, event);
      // The Claude limits the run reports go to limits.jsonl for the Analytics page (never throws).
      if (event.kind === 'other' && event.type === 'rate_limit_event') {
        void appendLimits(spec.dataDir, event.raw.rate_limit_info, new Date(), {
          refreshAfterMs: spec.limitsRefreshMs,
        });
      }
      if (trackerBroken || tracker?.onEvent === undefined) continue;
      try {
        tracker.onEvent(event);
      } catch (err) {
        trackerBroken = true;
        logger.warn({ jobId, err }, 'progress tracker failed; no more events for it');
      }
    }
  });
  const stderrTail: string[] = [];
  const stderrLines = createInterface({
    input: subprocess.stderr,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  stderrLines.on('line', (line) => {
    log.marker('stderr', { ...markerFields, text: line });
    stderrTail.push(line.slice(0, STDERR_LINE_MAX));
    if (stderrTail.length > STDERR_LINES_KEPT) stderrTail.shift();
  });
  const drained = Promise.all([once(stdoutLines, 'close'), once(stderrLines, 'close')]);

  // `spawn` fires once the binary runs; a binary that cannot run emits `error` instead, and an
  // early failure (no file descriptors left) settles `finished` without either.
  const spawned = await Promise.race([
    once(child, 'spawn').then(
      () => true,
      () => false,
    ),
    finished.then(() => false),
  ]);
  if (!spawned || subprocess.pid === undefined) {
    await finished;
    const failure: { code?: string; message?: string } = spawnFailure ?? {};
    const error = describeFailure({
      spawnError: {
        code: failure.code,
        message: failure.message ?? 'unknown error',
        bin: tildePath(bin.path, spec.home),
      },
      exitCode: null,
      signal: null,
      stderr: '',
      stream: emptySummary(),
    });
    return { started: false, error };
  }

  const pid = subprocess.pid;
  try {
    tracker = spec.onStarted?.(pid);
  } catch (err) {
    logger.warn({ jobId, err }, 'progress tracker could not start');
  }
  const tree = new ProcessTree({ rootPid: pid, tag: runTag });
  control.attach(tree);
  const identity = await processIdentity(pid);
  if (identity !== null) {
    const record = { jobId, pid, identity, tag: runTag, startedAt: new Date().toISOString() };
    await writeRunRecord(records, record).catch((err: unknown) => {
      logger.warn({ jobId, err }, 'could not write the run record');
    });
  }
  logger.info({ jobId, ...spec.logFields, pid, bin: bin.path }, `${label} started`);

  const timeout = setTimeout(() => control.request('timed_out'), spec.timeoutMs);
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    tree
      .sample()
      .catch(() => undefined)
      .finally(() => {
        sampling = false;
      });
  }, spec.sampleIntervalMs);

  const exit = await exited;
  clearTimeout(timeout);
  clearInterval(sampler);

  // The process is gone, its tree may not be. A stop under way finishes; otherwise anything the
  // run left behind (a background command, an orphaned render) is stopped now.
  const pending = control.stopping;
  const stoppedBy = control.settle();
  const cleaned = await (pending ?? tree.terminate({ graceMs: spec.killGraceMs }));
  if (pending === null && cleaned.terminated > 0) {
    log.marker('cleanup', {
      ...markerFields,
      leftover: cleaned.terminated,
      killed: cleaned.killed,
    });
    logger.warn({ jobId, ...cleaned }, 'stopped processes the run left behind');
  }
  if (cleaned.survivors.length > 0) {
    logger.error(
      { jobId, survivors: cleaned.survivors },
      'processes of the run are still running after SIGKILL',
    );
  }
  await removeRunRecord(records, jobId).catch(() => undefined);

  // Read what is left in the pipes. One that a stray process still holds is closed after a while.
  // The timer is cleared once the race is over: left running, it kept the whole process alive
  // for DRAIN_MS after a run, so a shutdown during an edit still took 5 s (CVP-89).
  let drainTimer: NodeJS.Timeout | undefined;
  const drainedInTime = await Promise.race([
    Promise.all([drained, finished]).then(() => true),
    new Promise<boolean>((resolve) => {
      drainTimer = setTimeout(() => resolve(false), DRAIN_MS);
    }),
  ]);
  clearTimeout(drainTimer);
  if (!drainedInTime) {
    subprocess.stdout?.destroy();
    subprocess.stderr?.destroy();
  }

  try {
    await tracker?.stop?.();
  } catch (err) {
    logger.warn({ jobId, err }, 'progress tracker failed to stop');
  }
  if (spec.usage !== undefined && summary.sessionId !== null) {
    await logAppUsage(
      { dataDir: spec.dataDir, home: spec.home, env, logger },
      spec.usage,
      summary.sessionId,
    );
  }

  return {
    started: true,
    pid,
    exitCode: exit.code,
    signal: exit.signal,
    stoppedBy,
    stream: summary,
    stderr: stderrTail.join('\n'),
  };
}
