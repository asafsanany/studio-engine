// The headless Claude run of a quick fix (quick fixes plan, section 2 "The quick fix run"; QF2): one
// short Sonnet run that changes one review note's worth of the live composition in edit/preview/
// while the owner waits in Review, and the engine's checks after it (verify-quick-fix.ts).
//
//   claude -p <quick-fix.md> --output-format stream-json --verbose --model sonnet --effort medium
//          --permission-mode dontAsk --permission-prompts none
//          --tools Read,Glob,Grep,Edit,Write,Bash --allowedTools <quickFixAllowedTools(fixId)>
//          --strict-mcp-config
//          --settings {"disableAllHooks":true,"permissions":{"deny":quickFixDenyRules(...)}}
//   cwd <inbox>/<job.relPath> (the job folder), environment from claudeEnv
//
// Model and effort are `TIER_RUNS.quick` (packages/shared). No Skill and no Task: the run needs no
// video-use and starts nothing else. What it may do, as permission rules (they are the first line of
// defence; verify-quick-fix.ts checks the result because a rule can miss a way):
//   - Read, Glob, Grep: anywhere but the clients' other folders (readDenyRulesOutsideJob);
//   - Edit (which covers Write): edit/preview/, edit/project.md and its own folder
//     edit/review/fixes/<fixId>/, never cut.mp4 or any video or audio file;
//   - Bash: the HyperFrames lint and snapshot of edit/preview, `ls`, and copying a font from
//     edit/fonts/ into edit/preview/assets/fonts/ (how a font reaches the composition). A compound
//     command needs every part allowed, so a `cd` first is not one of the forms.
//
// Checked in the CVP-374 spike (claude 2.1.308, hyperframes 0.8.197, dontAsk, on the rules above):
//   allowed  `npx hyperframes lint edit/preview` (also with `--json`), `npx hyperframes snapshot
//            edit/preview --at=3 --no-end --keep -o <folder>` (also piped into `tail`), `ls`, `cat`,
//            `mkdir -p edit/preview/assets/fonts`, `cp edit/fonts/Heebo-Bold.ttf edit/preview/assets/fonts/`
//            (and the same with the source path in double or single quotes, which a font folder with a
//            space in its name needs; backslash-escaped spaces are denied), and a `>` redirect into edit/preview/ (the Edit rule covers it);
//   denied   `cd edit/preview && npx hyperframes lint`, `sed -i`, any other `cp`, `rm`, `mkdir`,
//            python, ffmpeg, `hyperframes render`, `lint && rm …`; and, by the deny rule on cut.mp4,
//            `cp … edit/preview/cut.mp4` and `rm edit/preview/cut.mp4`.
// `hyperframes snapshot` names its file itself (`--keep -o <folder>` writes at-<seconds>s.png and no
// contact sheet) and keeps state in edit/preview/.hyperframes/, so the run snapshots into stills/ and
// the engine makes before.png and after.png from it (verify-quick-fix.ts).
//
// The process is handled like the other runs (claude-process.ts): its stream goes to the job's log
// between a `quick_fix_start` and a `quick_fix_end` marker (every marker of it carries
// `"run":"quick-fix"`; they are not `start`/`end`, so a retry's look at the last edit run never finds
// them), a stop (the note deleted, Undo, the engine's shutdown) aborts `signal` and the whole process
// tree stops (SIGTERM, then SIGKILL after 10 s), and after FIX_LIMITS.runSec it is stopped and the
// fix fails "it took longer than 4 minutes". Its tokens are logged to usage.jsonl under the
// `quick-fix` tag (`quickFixUsage`). The run's record goes to <data>/fix-runs/<jobId>/: fixes of
// different jobs may run at once, and reaping before a run must only stop what an earlier engine
// left of this job's fix (`reapQuickFixRuns` reaps them all, for the engine's boot).
//
// Steps come from the stream's tool calls (`quickFixStepTracker`): Reading the edit (0) → Changing
// the <kind> (1, at the first Edit or Write under edit/preview/) → Checking it (2, a lint after
// that) → Looking at the frames (3, a snapshot after that). A step never goes back.
//
// What the service (QF3) does around `run`: clones edit/preview/ for Undo before, and puts the
// clone back after every outcome but `fixed`. This file never snapshots or restores.

import { randomUUID } from 'node:crypto';
import { readdir, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FIX_LIMITS, TIER_RUNS } from '@studio/shared';
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
import { describeFailure, trimMessage } from '../pipeline/failure.js';
import { JobLog, jobLogPath, type RunEndOutcome } from '../pipeline/job-log.js';
import { DenialCollector } from '../pipeline/permission-denials.js';
import { PREVIEW_INDEX_PATH } from '../pipeline/preview-files.js';
import { PROMPTS_DIR } from '../pipeline/prompts.js';
import { type ReapedRun, reapStaleRuns } from '../pipeline/run-records.js';
import type { StreamEvent } from '../pipeline/stream-parser.js';
import { quickFixUsage } from '../usage/app-usage.js';
import type { AppUsage } from '../usage/usage-log.js';
import { createLintPreview } from './lint-preview.js';
import { fixDirPath } from './quick-fix-files.js';
import { buildQuickFixPrompt } from './quick-fix-prompt.js';
import {
  type QuickFixOutcome,
  type QuickFixRequest,
  type QuickFixRunner,
  type QuickFixStep,
  quickFixStepLabel,
} from './quick-fix-run.js';
import { type LintPreview, listJobFolder, verifyQuickFix } from './verify-quick-fix.js';

/** The built-in tools a quick fix run gets. No Skill (it needs no video-use) and no Task (it starts nothing else). */
export const QUICK_FIX_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;

/** Every marker of a quick fix run carries this, so its lines can be told from the edit run's. */
export const QUICK_FIX_MARKER_FIELDS = { run: 'quick-fix' } as const;

/** The Bash commands a quick fix run may run. See the header; `*` matches the rest of a command. */
export const QUICK_FIX_BASH_RULES = [
  'Bash(npx hyperframes lint edit/preview)',
  'Bash(npx hyperframes lint edit/preview *)',
  'Bash(npx hyperframes snapshot edit/preview *)',
  'Bash(ls)',
  'Bash(ls *)',
  'Bash(mkdir -p edit/preview/assets/fonts)',
  'Bash(cp edit/fonts/* edit/preview/assets/fonts/*)',
  // A font folder with a space in its name ("Hebrew + English") has to be quoted, and a quote before
  // `edit/` is not matched by the rule above (found in the CVP-381 acceptance run).
  'Bash(cp "edit/fonts/*" edit/preview/assets/fonts/*)',
  "Bash(cp 'edit/fonts/*' edit/preview/assets/fonts/*)",
] as const;

/**
 * What a quick fix run may do without asking; anything else is denied (`dontAsk`). Edit rules cover
 * every file-writing tool; only these three places can be written.
 */
export function quickFixAllowedTools(fixId: string): string[] {
  return [
    'Read',
    'Glob',
    'Grep',
    'Edit(./edit/preview/**)',
    'Edit(./edit/project.md)',
    `Edit(./${fixDirPath(fixId)}/**)`,
    ...QUICK_FIX_BASH_RULES,
  ];
}

/** Video and audio extensions a quick fix may not write, whatever the folder. */
const DENIED_WRITE_EXTENSIONS = [
  'mp4',
  'mov',
  'm4v',
  'webm',
  'mkv',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
] as const;

/**
 * What a quick fix run is refused on top of not being allowed it: reading the clients' other
 * folders (`denyRead`, readDenyRulesOutsideJob) and writing cut.mp4 and any video or audio file of
 * edit/preview/ (the allow rule for edit/preview/ would otherwise cover them).
 */
export function quickFixDenyRules(denyRead: readonly string[] = []): string[] {
  return [
    ...denyRead,
    'Edit(./edit/preview/cut.mp4)',
    ...DENIED_WRITE_EXTENSIONS.map((extension) => `Edit(./edit/preview/**/*.${extension})`),
  ];
}

/** Arguments of a quick fix run after the binary: Sonnet at medium (TIER_RUNS.quick). */
export function quickFixClaudeArgs({
  prompt,
  fixId,
  denyRead = [],
}: {
  prompt: string;
  fixId: string;
  denyRead?: readonly string[];
}): string[] {
  const { model, effort } = TIER_RUNS.quick;
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(model === null ? [] : ['--model', model]),
    '--effort',
    effort,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    QUICK_FIX_TOOLS.join(','),
    '--allowedTools',
    quickFixAllowedTools(fixId).join(','),
    '--strict-mcp-config',
    '--settings',
    JSON.stringify({
      disableAllHooks: true,
      permissions: { deny: quickFixDenyRules(denyRead) },
    }),
  ];
}

/** A path the run writes that is the composition (relative to the job folder, or absolute), not the CLI's own state folder. */
const COMPOSITION_PATH = /(?:^|\/)edit\/preview\/(?!\.hyperframes\/)/;

/** A Bash command that lints, or snapshots, the composition. */
const LINT_COMMAND = /\bhyperframes\s+lint\b/;
const SNAPSHOT_COMMAND = /\bhyperframes\s+snapshot\b/;

/**
 * Follows the run's steps from its tool calls and tells `onStep` each time it moves on: 1 at the
 * first Edit or Write of a file under edit/preview/, 2 at the first lint and 3 at the first snapshot
 * once it is at 1 (a lint or a snapshot before the edit is the run looking, not checking: the
 * "before" snapshot is one). It never goes back.
 */
export function quickFixStepTracker(onStep: (step: QuickFixStep) => void): {
  onEvent(event: StreamEvent): void;
  readonly step: QuickFixStep;
} {
  let step: QuickFixStep = 0;
  const move = (to: QuickFixStep) => {
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
      const path = event.input.file_path;
      if (
        (event.name === 'Edit' || event.name === 'Write') &&
        typeof path === 'string' &&
        COMPOSITION_PATH.test(path)
      ) {
        move(1);
      } else if (event.name === 'Bash' && step >= 1 && typeof event.input.command === 'string') {
        if (SNAPSHOT_COMMAND.test(event.input.command)) move(3);
        else if (LINT_COMMAND.test(event.input.command)) move(2);
      }
    },
  };
}

/** Where the run records of all quick fixes go: one folder per job in it. */
export function quickFixRunsDir(dataDir: string): string {
  return join(dataDir, 'fix-runs');
}

/** Where the run record of one job's quick fix goes. */
export function quickFixRunRecordsDir(dataDir: string, jobId: string): string {
  return join(quickFixRunsDir(dataDir), jobId);
}

/**
 * Stops whatever an earlier engine left running of any quick fix and deletes the records, for the
 * engine's boot (before it takes fixes). Never throws.
 */
export async function reapQuickFixRuns(
  dataDir: string,
  { graceMs = KILL_GRACE_MS }: { graceMs?: number } = {},
): Promise<ReapedRun[]> {
  let folders: string[];
  try {
    folders = (await readdir(quickFixRunsDir(dataDir), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const reaped: ReapedRun[] = [];
  for (const folder of folders) {
    const dir = join(quickFixRunsDir(dataDir), folder);
    reaped.push(...(await reapStaleRuns(dir, { graceMs })));
    await rmdir(dir).catch(() => undefined);
  }
  return reaped;
}

/** Why a fix that was stopped (the note deleted, Undo, the engine's shutdown) ended, as the line under the note puts it. */
export const QUICK_FIX_STOPPED = 'the fix was stopped';

/** What a fix that ran out of time says. */
export const QUICK_FIX_TIMED_OUT = `it took longer than ${FIX_LIMITS.runSec / 60} minutes`;

function failed(why: string): QuickFixOutcome {
  return { status: 'failed', why: trimMessage(why, 160), hasCompare: false };
}

export type ClaudeQuickFixConfig = Pick<Config, 'inboxPath' | 'logsDir' | 'dataDir' | 'claudeBin'> &
  Partial<Pick<Config, 'claudePlanOnly'>>;

export interface ClaudeQuickFixRunnerOptions {
  config: ClaudeQuickFixConfig;
  logger?: RunnerLogger;
  /** Home folder; defaults to os.homedir(). */
  home?: string;
  /** The server's environment (PATH, pass-through variables); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** SIGTERM -> SIGKILL grace. Default 10 s. */
  killGraceMs?: number;
  /** Default FIX_LIMITS.runSec (tests use less). */
  timeoutMs?: number;
  /** How often the process tree is sampled while running. Default 3 s. */
  sampleIntervalMs?: number;
  /** Folder with quick-fix.md and composition-rules.md. */
  promptsDir?: string;
  /** The engine's own lint after the run; default `npx hyperframes lint` (lint-preview.ts). */
  lint?: LintPreview;
  /** Paths of the job folder that are not the run's doing and the checks leave out (tests). */
  ignoreChanges?: (path: string) => boolean;
}

/** The real quick fix run and its checks. OWNER: QF2. */
export class ClaudeQuickFixRunner implements QuickFixRunner {
  readonly kind = 'claude' as const;
  readonly options: ClaudeQuickFixRunnerOptions;
  private readonly logger: RunnerLogger;
  private readonly home: string;
  private readonly env: Record<string, string | undefined>;
  private readonly killGraceMs: number;
  private readonly timeoutMs: number;
  private readonly sampleIntervalMs: number;
  private readonly promptsDir: string;
  private readonly lint: LintPreview;

  constructor(options: ClaudeQuickFixRunnerOptions) {
    this.options = options;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.home = options.home ?? homedir();
    this.env = options.env ?? process.env;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.timeoutMs = options.timeoutMs ?? FIX_LIMITS.runSec * 1000;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.promptsDir = options.promptsDir ?? PROMPTS_DIR;
    this.lint = options.lint ?? createLintPreview({ env: this.env, home: this.home });
  }

  private get config(): ClaudeQuickFixConfig {
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

  async run(request: QuickFixRequest): Promise<QuickFixOutcome> {
    const { signal, job, fix } = request;
    if (signal.aborted) return failed(QUICK_FIX_STOPPED);

    const control = new StopControl(this.killGraceMs);
    const onAbort = () => control.request(stopRequestedBy(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    const steps = quickFixStepTracker((step) =>
      request.onStep?.(step, quickFixStepLabel(step, request.note.route?.kind)),
    );
    let log: JobLog | null = null;
    const end = (
      outcome: RunEndOutcome,
      result: QuickFixOutcome,
      fields: Record<string, unknown> = {},
    ): QuickFixOutcome => {
      const durationMs = Date.now() - startedAt;
      log?.marker('quick_fix_end', {
        ...QUICK_FIX_MARKER_FIELDS,
        jobId: job.id,
        fixId: fix.id,
        outcome,
        status: result.status,
        ...(result.status === 'fixed' ? { said: result.said } : { why: result.why }),
        hasCompare: result.hasCompare,
        exitCode: null,
        signal: null,
        sessionId: null,
        step: steps.step,
        ...fields,
        durationMs,
      });
      const entry = { jobId: job.id, fixId: fix.id, outcome, status: result.status, durationMs };
      if (result.status === 'failed') this.logger.warn(entry, 'quick fix failed');
      else this.logger.info(entry, 'quick fix ended');
      return result;
    };

    try {
      log = await JobLog.open(jobLogPath(this.config.logsDir, job.id));
      return await this.execute(request, log, control, steps, end);
    } catch (err) {
      if (isRequestedStop(control.reason)) return end(control.reason, failed(QUICK_FIX_STOPPED));
      this.logger.error({ jobId: job.id, fixId: fix.id, err }, 'quick fix broke');
      return end('failed', failed(`it could not run: ${errorText(err)}`));
    } finally {
      signal.removeEventListener('abort', onAbort);
      await log?.close();
      if (log?.error) {
        this.logger.warn({ jobId: job.id, err: log.error }, 'could not write the job log');
      }
    }
  }

  private async execute(
    request: QuickFixRequest,
    log: JobLog,
    control: StopControl,
    steps: ReturnType<typeof quickFixStepTracker>,
    end: (
      outcome: RunEndOutcome,
      result: QuickFixOutcome,
      fields?: Record<string, unknown>,
    ) => QuickFixOutcome,
  ): Promise<QuickFixOutcome> {
    const { job, note, fix, signal } = request;
    const records = quickFixRunRecordsDir(this.config.dataDir, job.id);
    const reaped = await reapStaleRuns(records, { graceMs: this.killGraceMs });
    for (const stale of reaped) {
      this.logger.warn({ ...stale }, 'stopped a quick fix run left over from an earlier engine');
      log.marker('reaped', { ...QUICK_FIX_MARKER_FIELDS, ...stale });
    }

    const text = note.text?.trim() ?? '';
    if (text === '') return end('failed', failed('the note has no words yet'));
    const jobDir = join(this.config.inboxPath, job.relPath);
    try {
      await stat(join(jobDir, PREVIEW_INDEX_PATH));
    } catch {
      return end('failed', failed('there is no preview to change'));
    }

    const bin = this.resolveBin();
    if (bin === null) {
      return end(
        'failed',
        failed(
          'Claude Code was not found. Open the Claude desktop app once, or set "claudeBin" in ~/.studio-engine/config.json, then run `pnpm run doctor`.',
        ),
      );
    }

    const before = await listJobFolder(jobDir);
    const prompt = await buildQuickFixPrompt(
      {
        client: job.client,
        job: job.name,
        atSec: note.atSec,
        note: text,
        round: fix.round,
        fixId: fix.id,
      },
      this.promptsDir,
    );
    const args = quickFixClaudeArgs({
      prompt,
      fixId: fix.id,
      denyRead: readDenyRulesOutsideJob(this.config.inboxPath, jobDir),
    });
    const runTag = `fix-${fix.id}-${randomUUID()}`;
    log.marker('quick_fix_start', {
      ...QUICK_FIX_MARKER_FIELDS,
      jobId: job.id,
      relPath: job.relPath,
      fixId: fix.id,
      noteId: note.id,
      round: fix.round,
      atSec: note.atSec,
      kind: note.route?.kind ?? null,
      bin: bin.path,
      binSource: bin.source,
      cwd: jobDir,
      model: TIER_RUNS.quick.model,
      effort: TIER_RUNS.quick.effort,
      timeoutMs: this.timeoutMs,
      runTag,
      flags: args.slice(2),
      prompt,
    });
    if (isRequestedStop(control.reason)) return end(control.reason, failed(QUICK_FIX_STOPPED));

    const usage: AppUsage = quickFixUsage(job, note.route?.kind ?? '');
    const denied = new DenialCollector();
    const result = await runClaudeProcess({
      jobId: `fix-${fix.id}`,
      label: 'quick fix run',
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
      runsDir: records,
      home: this.home,
      killGraceMs: this.killGraceMs,
      timeoutMs: this.timeoutMs,
      sampleIntervalMs: this.sampleIntervalMs,
      logger: this.logger,
      markerFields: QUICK_FIX_MARKER_FIELDS,
      onStarted: () => {
        request.onStep?.(0, quickFixStepLabel(0, null));
        return {
          onEvent: (event) => {
            denied.onEvent(event);
            steps.onEvent(event);
          },
        };
      },
      usage,
    });
    if (!result.started) return end('failed', failed(result.error));

    const denials = denied.denials();
    for (const denial of denials) {
      this.logger.warn(
        { jobId: job.id, fixId: fix.id, tool: denial.tool, detail: denial.detail },
        'quick fix run: a tool call was denied by the permission rules',
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
    if (isRequestedStop(stoppedBy)) return end(stoppedBy, failed(QUICK_FIX_STOPPED), fields);
    if (stoppedBy === 'timed_out') {
      return end('timed_out', failed(QUICK_FIX_TIMED_OUT), fields);
    }
    if (result.exitCode !== 0) {
      const error = describeFailure({
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr,
        stream: result.stream,
      });
      return end('failed', failed(error), fields);
    }
    const last = result.stream.lastResult;
    if (last?.isError) {
      return end('failed', failed(last.text || 'Claude stopped with an error.'), fields);
    }

    const outcome = await verifyQuickFix({
      jobDir,
      fixId: fix.id,
      atSec: note.atSec,
      before,
      lint: this.lint,
      signal,
      ...(this.options.ignoreChanges === undefined ? {} : { ignore: this.options.ignoreChanges }),
    });
    return end(outcome.status === 'failed' ? 'failed' : 'succeeded', outcome, fields);
  }
}
