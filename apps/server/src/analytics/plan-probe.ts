// The plan probe: how the Analytics page keeps a fresh reading of the Max plan's limits.
//
// The app's own runs bill to the API key now, so their streams no longer carry the plan's
// `rate_limit_event`s (the readings in limits.jsonl stopped on 23 Oct 2026). When the Analytics
// data is asked for and the newest reading is older than `PLAN_PROBE_STALE_MS`, the engine starts
// one tiny headless run on the plan login instead: haiku, a one-word prompt, no tools, and no
// ANTHROPIC_API_KEY, so it is the claude.ai login that answers. Its stream carries the plan's
// rate_limit_event, which runClaudeProcess appends to limits.jsonl as it does for every run
// (`limitsRefreshMs` also writes a reading that says the same as the last line, so "last
// reading" moves on). The run is not logged to usage.jsonl.
//
// `PlanProbe` is only the scheduling: at most one run at a time, never blocking the request that
// poked it, and no more than one attempt per `PLAN_PROBE_STALE_MS` even when a run fails. The run
// itself is `claudePlanProbeRun`; tests give the probe a stand-in for it.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LimitSnapshot } from '@studio/shared';
import type { Config } from '../config.js';
import { resolveClaudeBin } from '../pipeline/claude-bin.js';
import { childEnv } from '../pipeline/claude-command.js';
import {
  errorText,
  KILL_GRACE_MS,
  type RunnerLogger,
  runClaudeProcess,
  SAMPLE_INTERVAL_MS,
  SILENT_LOGGER,
  StopControl,
  stopRequestedBy,
} from '../pipeline/claude-process.js';
import { JobLog } from '../pipeline/job-log.js';
import { reapStaleRuns } from '../pipeline/run-records.js';

/** A reading older than this is stale: the probe reads again. Also the most often it runs. */
export const PLAN_PROBE_STALE_MS = 10 * 60_000;

/** The cheapest model: the run only has to be answered, to see the plan's limits. */
export const PLAN_PROBE_MODEL = 'haiku';

/** A one-word answer is all it costs. */
export const PLAN_PROBE_PROMPT = 'Reply with one word: ok';

/** A run with no tools answers in seconds; this only stops one that hangs. */
export const PLAN_PROBE_TIMEOUT_MS = 2 * 60_000;

/** Whether the newest reading (`null`: none) is stale at `now`, and so is a reason to probe. */
export function readingIsStale(
  readings: readonly Pick<LimitSnapshot, 'at'>[],
  now: number,
  staleMs: number = PLAN_PROBE_STALE_MS,
): boolean {
  let newest = Number.NEGATIVE_INFINITY;
  for (const reading of readings) {
    const at = Date.parse(reading.at);
    if (!Number.isNaN(at) && at > newest) newest = at;
  }
  return now - newest > staleMs;
}

export interface PlanProbeOptions {
  /** The readings in limits.jsonl (`readLimits(dataDir)`). */
  readLimits: () => Promise<readonly Pick<LimitSnapshot, 'at'>[]>;
  /**
   * One probe run; resolves when it has ended. Whatever it learns it writes to limits.jsonl
   * itself. The signal aborts when the engine shuts down: the run must stop then.
   */
  run: (signal: AbortSignal) => Promise<void>;
  clock?: () => Date;
  staleMs?: number;
  logger?: RunnerLogger;
}

export class PlanProbe {
  private readonly options: PlanProbeOptions;
  private readonly logger: RunnerLogger;
  private readonly shutdown = new AbortController();
  private busy: Promise<void> | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;

  constructor(options: PlanProbeOptions) {
    this.options = options;
    this.logger = options.logger ?? SILENT_LOGGER;
  }

  /**
   * Called whenever the Analytics data is asked for. Returns at once; when the newest reading is
   * stale (and no run is under way and none was tried in the last `staleMs`) a run starts in the
   * background. Never throws.
   */
  poke(): void {
    if (this.busy !== null || this.shutdown.signal.aborted) return;
    this.busy = this.check().finally(() => {
      this.busy = null;
    });
  }

  /** Resolves once the probe is idle (a run that was started has ended): for tests and shutdown. */
  idle(): Promise<void> {
    return this.busy ?? Promise.resolve();
  }

  /** No run starts from here on, and the one that is under way is stopped. Resolves once it has. */
  stop(): Promise<void> {
    this.shutdown.abort('shutdown');
    return this.idle();
  }

  private async check(): Promise<void> {
    const {
      readLimits,
      run,
      clock = () => new Date(),
      staleMs = PLAN_PROBE_STALE_MS,
    } = this.options;
    try {
      const now = clock().getTime();
      if (now - this.lastAttemptAt <= staleMs) return;
      if (!readingIsStale(await readLimits(), now, staleMs)) return;
      this.lastAttemptAt = now;
      await run(this.shutdown.signal);
    } catch (err) {
      this.logger.warn({ err }, 'the plan probe failed');
    }
  }
}

// --- the run -------------------------------------------------------------------------------------

/** Arguments of the run after the binary. */
export function planProbeArgs(): string[] {
  return [
    '-p',
    PLAN_PROBE_PROMPT,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    PLAN_PROBE_MODEL,
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

export function planProbeRunsDir(dataDir: string): string {
  return join(dataDir, 'plan-probe-runs');
}

export function planProbeLogPath(logsDir: string): string {
  return join(logsDir, 'plan-probe.log');
}

export type PlanProbeConfig = Pick<Config, 'logsDir' | 'dataDir' | 'claudeBin'>;

export interface ClaudePlanProbeOptions {
  config: PlanProbeConfig;
  logger?: RunnerLogger;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  /** The server's environment (PATH, pass-through variables); defaults to process.env. */
  env?: Record<string, string | undefined>;
  killGraceMs?: number;
  timeoutMs?: number;
  sampleIntervalMs?: number;
}

/**
 * One probe run on the plan login. `childEnv` never passes ANTHROPIC_API_KEY (only `claudeEnv`
 * adds it), so the CLI falls back to the claude.ai login, which is the plan. Resolves when the
 * run is over; a failure is only a line in the log: the page shows the plan as it last read it.
 */
export function claudePlanProbeRun(
  options: ClaudePlanProbeOptions,
): (signal: AbortSignal) => Promise<void> {
  const { config } = options;
  const logger = options.logger ?? SILENT_LOGGER;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  return async (signal) => {
    if (signal.aborted) return;
    const bin = resolveClaudeBin({
      home,
      pathEnv: env.PATH,
      configBin: config.claudeBin === 'claude' ? undefined : config.claudeBin,
    });
    if (bin === null) {
      logger.warn({}, 'the plan probe could not find Claude Code');
      return;
    }
    const records = planProbeRunsDir(config.dataDir);
    const cwd = join(records, 'work');
    await mkdir(cwd, { recursive: true });
    await reapStaleRuns(records, { graceMs: killGraceMs });
    const log = await JobLog.open(planProbeLogPath(config.logsDir));
    const runTag = `plan-probe-${randomUUID()}`;
    const args = planProbeArgs();
    const markerFields = { run: 'plan-probe' } as const;
    log.marker('plan_probe_start', {
      ...markerFields,
      bin: bin.path,
      cwd,
      model: PLAN_PROBE_MODEL,
      runTag,
    });
    const startedAt = Date.now();
    const control = new StopControl(killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await runClaudeProcess({
        jobId: 'plan-probe',
        label: 'plan probe',
        bin,
        args,
        cwd,
        env: childEnv({ home, env, runTag }),
        runTag,
        log,
        control,
        dataDir: config.dataDir,
        runsDir: records,
        home,
        killGraceMs,
        timeoutMs: options.timeoutMs ?? PLAN_PROBE_TIMEOUT_MS,
        sampleIntervalMs: options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS,
        logger,
        markerFields,
        limitsRefreshMs: PLAN_PROBE_STALE_MS,
      });
      log.marker('plan_probe_end', {
        ...markerFields,
        ...(result.started
          ? { exitCode: result.exitCode, stoppedBy: result.stoppedBy }
          : { error: result.error }),
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      log.marker('plan_probe_end', {
        ...markerFields,
        error: errorText(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
      await log.close();
    }
  };
}
