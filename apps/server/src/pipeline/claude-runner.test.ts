import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Job, jobFormatsOf, type StepId } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLimits } from '../analytics/limits-log.js';
import { MUSIC_SCRIPT } from '../music/music-assets.js';
import { readUsageLog } from '../usage/usage-log.js';
import { ClaudeRunner, type ClaudeRunnerOptions, type TrackedRun } from './claude-runner.js';
import { jobLogPath } from './job-log.js';
import { listProcesses } from './process-tree.js';
import type { RunContext, RunMode } from './runner.js';
import type { StreamEvent } from './stream-parser.js';

// The runner end to end against a stand-in `claude` (testdata/stub-claude.mjs): real processes,
// real pipes, real signals, no model. The stub reads its scenario from the job folder.

const STUB = fileURLToPath(new URL('./testdata/stub-claude.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../../../fixtures/stream/', import.meta.url));

let root: string;
let inboxPath: string;
let logsDir: string;
let dataDir: string;
let claudeBin: string;
const leftovers: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-runner-'));
  inboxPath = join(root, 'inbox');
  logsDir = join(root, 'data', 'logs');
  dataDir = join(root, 'data');
  claudeBin = join(root, 'bin', 'claude');
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
});

afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone, as it should be
    }
  }
  rmSync(root, { recursive: true, force: true });
});

const JOB_ID = 'e3e3e3e3e3e3';

function makeJob(step: StepId | null = null, overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    clientId: '853479772be4',
    client: 'Acme Studio',
    name: 'Launch teaser',
    relPath: 'Acme Studio/Launch teaser',
    state: 'editing',
    step,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 1, audio: 0, image: 0, doc: 0 },
    sizeBytes: 1,
    addedAt: '2026-10-20T10:00:00.000Z',
    lastChangeAt: '2026-10-20T10:00:00.000Z',
    settledAt: '2026-10-20T10:01:00.000Z',
    heldSettledAt: null,
    runKind: 'edit',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: null,
    updatedAt: '2026-10-20T10:01:00.000Z',
    output: null,
    note: null,
    ...overrides,
  };
}

const jobDir = () => join(inboxPath, 'Acme Studio', 'Launch teaser');

interface Scenario {
  replay?: string;
  lines?: string[];
  stderr?: string;
  /** Files to write, by path relative to the job folder (the stub makes the folders). */
  writeFiles?: Record<string, string>;
  writeFinal?: boolean;
  exitCode?: number;
  hang?: boolean;
  ignoreTerm?: boolean;
  grandchild?: boolean | 'stubborn';
}

function scenario(s: Scenario): void {
  mkdirSync(jobDir(), { recursive: true });
  writeFileSync(join(jobDir(), 'stub-claude.json'), JSON.stringify(s));
}

interface StubCall {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  pid: number;
  grandchild?: number;
}

function stubCall(): StubCall {
  return JSON.parse(readFileSync(join(jobDir(), 'stub-claude.call.json'), 'utf8')) as StubCall;
}

async function waitForStub(): Promise<StubCall> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(jobDir(), 'stub-claude.call.json'))) {
      const call = stubCall();
      leftovers.push(call.pid, ...(call.grandchild ? [call.grandchild] : []));
      return call;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the stub never started');
}

async function running(pids: number[]): Promise<number[]> {
  const table = await listProcesses();
  return table.filter((proc) => pids.includes(proc.pid)).map((proc) => proc.pid);
}

function runner({
  review,
  graphics,
  graphicsInEdits,
  music,
  quickFixes,
  songs,
  songTools,
  claudePlanOnly,
  noModel = false,
  ...options
}: Partial<ClaudeRunnerOptions> & {
  review?: boolean;
  graphics?: boolean;
  graphicsInEdits?: boolean;
  music?: boolean;
  quickFixes?: boolean;
  songs?: boolean;
  songTools?: { ytDlp: string; deno: string };
  claudePlanOnly?: boolean;
  noModel?: boolean;
} = {}) {
  return new ClaudeRunner({
    config: {
      inboxPath,
      logsDir,
      dataDir,
      claudeBin,
      model: noModel ? undefined : 'opus',
      runTimeoutMin: 90,
      ...(review === undefined ? {} : { review }),
      ...(graphics === undefined ? {} : { graphics }),
      ...(graphicsInEdits === undefined ? {} : { graphicsInEdits }),
      ...(music === undefined ? {} : { music }),
      ...(quickFixes === undefined ? {} : { quickFixes }),
      ...(songs === undefined ? {} : { songs }),
      ...(songTools === undefined ? {} : { songTools }),
      ...(claudePlanOnly === undefined ? {} : { claudePlanOnly }),
    },
    home: join(root, 'home'),
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ELEVENLABS_API_KEY: 'sk_test_never_passed',
      ANTHROPIC_API_KEY: 'sk-ant-test-passed',
    },
    killGraceMs: 2_000,
    sampleIntervalMs: 50,
    ...options,
  });
}

function context(controller = new AbortController()) {
  const progress = vi.fn<RunContext['progress']>();
  return { controller, ctx: { signal: controller.signal, progress } satisfies RunContext };
}

function logLines(): string[] {
  return readFileSync(jobLogPath(logsDir, JOB_ID), 'utf8').trimEnd().split('\n');
}

function markers(event?: string): Record<string, unknown>[] {
  return logLines()
    .filter((line) => line.startsWith('{"type":"studio_engine"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((m) => event === undefined || m.event === event);
}

describe('a run that delivers', () => {
  it('replays the E1 sample run: success, every line logged, events to the tracker', async () => {
    scenario({ replay: `${FIXTURES}sample-run.jsonl`, writeFinal: true });
    const events: StreamEvent[] = [];
    const tracked: TrackedRun[] = [];
    const stop = vi.fn();
    const track = (run: TrackedRun) => {
      tracked.push(run);
      return { onEvent: (event: StreamEvent) => events.push(event), stop };
    };
    const { ctx } = context();

    const outcome = await runner({ track }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({ ok: true });
    // The log: start marker, the 249 stream lines verbatim, end marker.
    const fixture = readFileSync(`${FIXTURES}sample-run.jsonl`, 'utf8').trimEnd().split('\n');
    const lines = logLines();
    expect(lines.slice(1, -1)).toEqual(fixture);
    expect(markers('start')[0]).toMatchObject({
      mode: 'start',
      promptMode: 'start',
      model: 'opus',
    });
    expect(markers('end')[0]).toMatchObject({
      outcome: 'succeeded',
      exitCode: 0,
      sessionId: '143ff80c-b7b1-4765-a77b-2de4e013424b',
    });
    // The tracker hook: one run, every event, stopped at the end.
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({
      mode: 'start',
      jobDir: jobDir(),
      editDir: join(jobDir(), 'edit'),
    });
    expect(events.filter((e) => e.kind === 'tool_use')[0]).toMatchObject({ name: 'Skill' });
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(1);
    expect(stop).toHaveBeenCalledOnce();
    // No run record left behind.
    expect(readdirSync(join(dataDir, 'runs'))).toEqual([]);
  });

  it('logs the run in usage.jsonl under its run kind, with its session', async () => {
    scenario({ replay: `${FIXTURES}sample-run.jsonl`, writeFinal: true });
    const job = makeJob();

    await runner().start(job, 'start', context().ctx);

    expect(await readUsageLog(dataDir)).toEqual([
      expect.objectContaining({
        source: 'app',
        tag: 'edit',
        did: 'Edited Acme Studio / Launch teaser',
        session: '143ff80c-b7b1-4765-a77b-2de4e013424b',
        client: 'Acme Studio',
        job: { id: job.id, name: 'Launch teaser' },
      }),
    ]);
  });

  it('logs the Claude limits the stream reports in limits.jsonl, a line for each change (AN5)', async () => {
    scenario({ replay: `${FIXTURES}sample-run.jsonl`, writeFinal: true });

    await runner().start(makeJob(), 'start', context().ctx);

    // The sample has three rate_limit_events: the five-hour use goes .26, .27, .28 and the weekly
    // use stays at .5, so every event is a change.
    await vi.waitFor(async () => expect(await readLimits(dataDir)).toHaveLength(3));
    const limits = await readLimits(dataDir);
    expect(limits.map((l) => l.fiveHour?.utilization)).toEqual([0.26, 0.27, 0.28]);
    expect(limits[0]).toMatchObject({
      status: 'allowed',
      sevenDay: { utilization: 0.5, resetsAt: '2026-10-24T18:00:00.000Z' },
    });
  });

  it('gives the run the API key only when the Claude billing switch is off', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();

    await runner({ claudePlanOnly: true }).start(makeJob(), 'start', ctx);
    expect(stubCall().env.ANTHROPIC_API_KEY).toBeUndefined();

    await runner({ claudePlanOnly: false }).start(makeJob(), 'start', ctx);
    expect(stubCall().env.ANTHROPIC_API_KEY).toBe('sk-ant-test-passed');
  });

  it('hands the brief’s footage count to the tracker hook, and leaves it out when there is none (CVP-134)', async () => {
    scenario({ writeFinal: true });
    const tracked: TrackedRun[] = [];
    const track = (run: TrackedRun) => {
      tracked.push(run);
      return undefined;
    };
    const { ctx } = context();

    await runner({ track }).start(makeJob(), 'start', { ...ctx, transcribeTotal: 4 });
    await runner({ track }).start(makeJob(), 'start', ctx);

    expect(tracked).toHaveLength(2);
    expect(tracked[0]?.transcribeTotal).toBe(4);
    expect(tracked[1]).not.toHaveProperty('transcribeTotal');
  });

  it('spawns claude with E1 flags, cwd = job folder and a scrubbed environment', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner().start(makeJob(), 'start', ctx);

    const call = stubCall();
    expect(call.cwd).toBe(realpathSync(jobDir()));
    expect(call.env.STUDIO_ENGINE_RUN).toMatch(new RegExp(`^${JOB_ID}-[0-9a-f-]{36}$`));
    expect(call.argv[0]).toBe('-p');
    expect(call.argv[1]).toMatch(/^Edit the footage in this folder with the video-use skill/);
    expect(call.argv.slice(2)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'opus',
      // A job on Default runs at Extra high.
      '--effort',
      'xhigh',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--tools',
      'Bash,Read,Write,Edit,Skill,Task',
      '--allowedTools',
      'Bash Read Write Edit Skill Task',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
    expect(call.env.CLAUDE_CODE_SHELL).toBe('/bin/bash');
    expect(call.env.HOME).toBe(join(root, 'home'));
    expect(call.env.PATH?.split(':').slice(0, 2)).toEqual(['/opt/homebrew/bin', '/usr/local/bin']);
    expect(call.env).not.toHaveProperty('ELEVENLABS_API_KEY');
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    // Nothing secret reaches the log either.
    expect(readFileSync(jobLogPath(logsDir, JOB_ID), 'utf8')).not.toMatch(
      /never_passed|sk-ant-test-passed/,
    );
  });

  // CVP-258: in a real series run an edit read another series' kit and a sibling episode's folder.
  it("denies reads of the inbox's other folders in the settings, never the job's own", async () => {
    scenario({ writeFinal: true });
    for (const other of ['Acme Studio/Other job', 'Acme Studio/_Series/Show', 'Other Studio/Job']) {
      mkdirSync(join(inboxPath, other), { recursive: true });
    }
    const { ctx } = context();
    await runner().start(makeJob(), 'start', ctx);

    const argv = stubCall().argv;
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] as string);
    const inbox = realpathSync(inboxPath);
    expect(settings).toEqual({
      disableAllHooks: true,
      permissions: {
        deny: [
          `Read(/${inbox}/Acme Studio/Other job/**)`,
          `Read(/${inbox}/Acme Studio/_Series/**)`,
          `Read(/${inbox}/Other Studio/**)`,
        ],
      },
    });
  });

  it('stops a process the run left behind, and still succeeds', async () => {
    scenario({ writeFinal: true, grandchild: true });
    const { ctx } = context();
    const outcome = await runner().start(makeJob(), 'start', ctx);
    const call = await waitForStub();

    expect(outcome).toEqual({ ok: true });
    expect(await running([call.pid, call.grandchild as number])).toEqual([]);
    expect(markers('cleanup')[0]).toMatchObject({ leftover: 1 });
  });
});

describe('a run that fails', () => {
  it('blocked run (E1 fixture): exit 0 without final.mp4', async () => {
    scenario({ replay: `${FIXTURES}blocked-run.jsonl` });
    const { ctx } = context();
    const outcome = await runner().start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({
      ok: false,
      error:
        'Finished without a final video: To unblock it, install ffmpeg (brew install ffmpeg) and put an ELEVENLABS_API_KEY in ~/Developer/video-use/.env.',
    });
    expect(markers('end')[0]).toMatchObject({ outcome: 'failed', exitCode: 0 });
  });

  it('exit 0 and only a hidden temp file in edit/ is still no final video', async () => {
    scenario({});
    mkdirSync(join(jobDir(), 'edit'), { recursive: true });
    writeFileSync(join(jobDir(), 'edit', '.final.mp4.partial'), 'x');
    writeFileSync(join(jobDir(), 'edit', 'final.prenorm.mp4'), 'x');
    const { ctx } = context();
    const outcome = await runner().start(makeJob(), 'start', ctx);
    expect(outcome).toEqual({ ok: false, error: 'Finished without a final video.' });
  });

  it('an empty final.mp4 is not a final video', async () => {
    scenario({});
    mkdirSync(join(jobDir(), 'edit'), { recursive: true });
    writeFileSync(join(jobDir(), 'edit', 'final.mp4'), '');
    const { ctx } = context();
    expect((await runner().start(makeJob(), 'start', ctx)).ok).toBe(false);
  });

  it('a final.mp4 with a non-zero exit is a failure', async () => {
    scenario({
      writeFinal: true,
      exitCode: 1,
      lines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Not logged in · Please run /login',
        }),
      ],
    });
    const { ctx } = context();
    const outcome = await runner().start(makeJob(), 'start', ctx);
    expect(outcome).toEqual({
      ok: false,
      error:
        'Claude Code is not logged in. Run `pnpm run doctor` for the login command, then retry.',
    });
  });

  it('stderr is logged and classified', async () => {
    scenario({ exitCode: 2, stderr: 'Error: ENOSPC: no space left on device, write\n' });
    const { ctx } = context();
    const outcome = await runner().start(makeJob(), 'start', ctx);
    expect(outcome).toEqual({
      ok: false,
      error: 'The disk is full (no space left on device). Free up some space, then retry.',
    });
    expect(markers('stderr')[0]).toMatchObject({
      text: 'Error: ENOSPC: no space left on device, write',
    });
  });

  it('a configured claudeBin that does not exist', async () => {
    scenario({});
    const r = new ClaudeRunner({
      config: {
        inboxPath,
        logsDir,
        dataDir,
        claudeBin: join(root, 'nope'),
        model: undefined,
        runTimeoutMin: 90,
      },
      home: root,
      env: { PATH: process.env.PATH },
    });
    const { ctx } = context();
    expect(await r.start(makeJob(), 'start', ctx)).toEqual({
      ok: false,
      error: 'Claude Code was not found at ~/nope. Run `pnpm run doctor`.',
    });
    expect(markers('end')[0]).toMatchObject({ outcome: 'failed' });
  });

  it('a job folder that is gone', async () => {
    const { ctx } = context();
    expect(await runner().start(makeJob(), 'start', ctx)).toEqual({
      ok: false,
      error: 'The job folder is missing: Acme Studio/Launch teaser',
    });
  });
});

describe('cancel', () => {
  it('stops claude and a tool command in its own process group, and leaves nothing running', async () => {
    scenario({ lines: ['{"type":"system","subtype":"init"}'], hang: true, grandchild: true });
    const { controller, ctx } = context();
    const pending = runner().start(makeJob(4), 'start', ctx);
    const call = await waitForStub();
    expect(await running([call.pid, call.grandchild as number])).toHaveLength(2);

    controller.abort();
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(await running([call.pid, call.grandchild as number])).toEqual([]);
    expect(markers('end')[0]).toMatchObject({ outcome: 'cancelled', signal: 'SIGTERM' });
    expect(readdirSync(join(dataDir, 'runs'))).toEqual([]);
  });

  it('SIGKILLs a tree that ignores SIGTERM after the grace period, then settles', async () => {
    scenario({ hang: true, ignoreTerm: true, grandchild: 'stubborn' });
    const { controller, ctx } = context();
    const pending = runner({ killGraceMs: 300 }).start(makeJob(4), 'start', ctx);
    const call = await waitForStub();

    const t0 = Date.now();
    controller.abort();
    const outcome = await pending;

    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(outcome.ok).toBe(false);
    expect(await running([call.pid, call.grandchild as number])).toEqual([]);
    expect(markers('end')[0]).toMatchObject({ outcome: 'cancelled', signal: 'SIGKILL' });
  });

  it('a cancel that comes after a successful exit, while leftovers are cleaned up, changes nothing', async () => {
    // The run delivers and exits 0 but leaves a tool command that ignores SIGTERM, so the
    // cleanup takes the whole grace period; the user cancels during it.
    scenario({ writeFinal: true, grandchild: 'stubborn' });
    const { controller, ctx } = context();
    const pending = runner({ killGraceMs: 600 }).start(makeJob(8), 'start', ctx);
    const call = await waitForStub();
    await vi.waitFor(async () => expect(await running([call.pid])).toEqual([]));
    controller.abort();

    expect(await pending).toEqual({ ok: true });
    expect(await running([call.grandchild as number])).toEqual([]);
    expect(markers('end')[0]).toMatchObject({ outcome: 'succeeded' });
  });

  it('an already aborted signal starts nothing', async () => {
    scenario({ writeFinal: true });
    const { controller, ctx } = context();
    controller.abort();
    expect(await runner().start(makeJob(), 'start', ctx)).toEqual({
      ok: false,
      error: 'Cancelled',
    });
    expect(existsSync(join(jobDir(), 'stub-claude.call.json'))).toBe(false);
  });
});

describe('shutdown (CVP-89)', () => {
  it('stops the run like a cancel but records it as stopped, so the log tells them apart', async () => {
    scenario({ lines: ['{"type":"system","subtype":"init"}'], hang: true, grandchild: true });
    const info = vi.fn();
    const { controller, ctx } = context();
    const pending = runner({ logger: { info, warn: vi.fn(), error: vi.fn() } }).start(
      makeJob(4),
      'start',
      ctx,
    );
    const call = await waitForStub();
    expect(await running([call.pid, call.grandchild as number])).toHaveLength(2);

    controller.abort('shutdown');
    const outcome = await pending;

    expect(outcome).toEqual({ ok: false, error: 'Stopped because the engine shut down' });
    expect(await running([call.pid, call.grandchild as number])).toEqual([]);
    expect(markers('end')[0]).toMatchObject({
      outcome: 'stopped',
      error: 'Stopped because the engine shut down',
      signal: 'SIGTERM',
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID, outcome: 'stopped' }),
      'edit run ended',
    );
    expect(readdirSync(join(dataDir, 'runs'))).toEqual([]);
  });

  it('writes a different end marker for a shutdown than for a cancel', async () => {
    scenario({ hang: true });
    const cancelled = context();
    const first = runner().start(makeJob(4), 'start', cancelled.ctx);
    await waitForStub();
    cancelled.controller.abort('cancel');
    await first;

    rmSync(join(jobDir(), 'stub-claude.call.json'));
    const shutdown = context();
    const second = runner().start(makeJob(4), 'resume', shutdown.ctx);
    await waitForStub();
    shutdown.controller.abort('shutdown');
    await second;

    const [cancel, stop] = markers('end');
    expect(cancel).toMatchObject({ outcome: 'cancelled', error: 'Cancelled' });
    expect(stop).toMatchObject({ outcome: 'stopped' });
    expect(stop?.outcome).not.toBe(cancel?.outcome);
    expect(stop?.error).not.toBe(cancel?.error);
  });

  it('an abort with no reason, or any reason but the shutdown, is a cancel as before', async () => {
    scenario({ hang: true });
    const plain = context();
    const first = runner().start(makeJob(4), 'start', plain.ctx);
    await waitForStub();
    plain.controller.abort();
    await first;

    rmSync(join(jobDir(), 'stub-claude.call.json'));
    const other = context();
    const second = runner().start(makeJob(4), 'resume', other.ctx);
    await waitForStub();
    other.controller.abort(new Error('something else'));
    await second;

    expect(markers('end').map((marker) => marker.outcome)).toEqual(['cancelled', 'cancelled']);
  });

  it('an already aborted signal starts nothing, whichever the reason', async () => {
    scenario({ writeFinal: true });
    const { controller, ctx } = context();
    controller.abort('shutdown');
    expect(await runner().start(makeJob(), 'start', ctx)).toEqual({
      ok: false,
      error: 'Stopped because the engine shut down',
    });
    expect(existsSync(join(jobDir(), 'stub-claude.call.json'))).toBe(false);
  });

  it('SIGKILLs a tree that ignores SIGTERM after a shutdown too, and still records stopped', async () => {
    scenario({ hang: true, ignoreTerm: true, grandchild: 'stubborn' });
    const { controller, ctx } = context();
    const pending = runner({ killGraceMs: 300 }).start(makeJob(4), 'start', ctx);
    const call = await waitForStub();

    controller.abort('shutdown');
    await pending;

    expect(await running([call.pid, call.grandchild as number])).toEqual([]);
    expect(markers('end')[0]).toMatchObject({ outcome: 'stopped', signal: 'SIGKILL' });
  });
});

describe('timeout', () => {
  it('stops the run at its limit and fails it as timed out', async () => {
    scenario({ hang: true, grandchild: true });
    const { ctx } = context();
    const outcome = await runner({ timeoutMs: 500 }).start(makeJob(6), 'start', ctx);
    const call = stubCall();
    leftovers.push(call.pid, call.grandchild as number);

    expect(outcome).toEqual({
      ok: false,
      error: 'Timed out after 1 s: the edit took longer than the run limit (runTimeoutMin).',
    });
    expect(await running([call.pid, call.grandchild as number])).toEqual([]);
    expect(markers('end')[0]).toMatchObject({ outcome: 'timed_out' });
  });
});

// GR8: the graphicsInEdits switch reaches the prompt: on, the run is told where the library is.
describe('the Graphics library switch', () => {
  const promptOf = () => stubCall().argv[1] as string;
  const LIBRARY_LINE = /^- The Graphics library is already copied into edit\/graphics\//m;

  it.each([
    ['is left out', undefined],
    ['is off', false],
  ])('leaves the prompt as it was when it %s', async (_case, graphicsInEdits) => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner({ graphicsInEdits }).start(makeJob(), 'start', ctx);
    expect(promptOf()).not.toMatch(/edit\/graphics|_Graphics|Graphics library/);
  });

  it('leaves the prompt as it was when Graphics is off, whatever the library in edits says', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner({ graphics: false, graphicsInEdits: true }).start(makeJob(), 'start', ctx);
    expect(promptOf()).not.toMatch(/edit\/graphics|_Graphics|Graphics library/);
  });

  it('tells the run where the library is when it is on', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner({ graphicsInEdits: true }).start(makeJob(), 'start', ctx);
    expect(promptOf()).toMatch(LIBRARY_LINE);
    expect(promptOf()).toContain('- A Graphics library section, when there is one,');
  });
});

// LU9: what the run's notes name in the library (`context.libraryRefs`, given by withLutRefs while
// the lutsInEdits switch is on) reaches the prompt; without it the prompt is what it always was.
describe('LUTs named in the notes', () => {
  const promptOf = () => stubCall().argv[1] as string;
  const refs = {
    luts: [
      {
        slug: 'golden-hour-warm',
        name: 'Golden Hour Warm',
        kind: 'look' as const,
        owner: 'yours' as const,
        path: 'edit/luts/golden-hour-warm.cube',
        look: null,
      },
    ],
    graphics: [],
    missing: [{ library: 'luts' as const, slug: 'xyz', reason: 'notInLibrary' as const }],
  };

  it('leaves the prompt as it was when the context carries nothing', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner().start(makeJob(), 'start', ctx);
    expect(promptOf()).not.toMatch(/Library references|--look-lut/);
  });

  it('tells an edit run what the note names, and the log keeps the prompt', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner().start(makeJob(), 'start', { ...ctx, libraryRefs: refs });
    expect(promptOf()).toContain('- Library references:');
    expect(promptOf()).toContain(
      '  - @luts/golden-hour-warm: “Golden Hour Warm”, a Look LUT, file ./edit/luts/golden-hour-warm.cube',
    );
    expect(promptOf()).toContain('`--look-lut ./edit/luts/golden-hour-warm.cube`');
    expect(promptOf()).toContain(
      'The note names @luts/xyz, which is not in the library. Do the closest thing and say so in project.md.',
    );
    expect(String(markers('start')[0]?.prompt)).toContain('Library references');
  });

  it('tells a revise run too', async () => {
    scenario({
      writeFiles: {
        'edit/preview/index.html':
          '<!doctype html><html><head><title>x</title></head><body><div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="28.4"></div></body></html>',
      },
    });
    const { ctx } = context();
    await runner({ review: true }).start(
      makeJob(4, { runKind: 'revise', round: 1, state: 'editing' }),
      'start',
      { ...ctx, libraryRefs: refs },
    );
    expect(promptOf()).toMatch(/- Do what each note asks[^\n]*\n- Library references:/);
    expect(promptOf().split('- Library references:')).toHaveLength(2);
  });
});

// SD0: the Soundtrack switch reaches the prompt: on, the run gets the music part with the script.
describe('the Soundtrack switch', () => {
  const promptOf = () => stubCall().argv[1] as string;

  it.each([
    ['is left out', undefined],
    ['is off', false],
  ])('leaves the prompt as it was when it %s', async (_case, music) => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner({ music }).start(makeJob(), 'start', ctx);
    expect(promptOf()).not.toContain('make-music.mjs');
    expect(promptOf()).not.toMatch(/^Music: /m);
  });

  it('gives the run the music part and the script’s path when it is on', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner({ music: true }).start(makeJob(), 'start', ctx);
    expect(promptOf()).toMatch(/^Music: /m);
    expect(promptOf()).toContain(`node "${MUSIC_SCRIPT}"`);
  });
});

// SG4: the Songs switch reaches the prompt and the environment: on (with the music), the run gets the
// song lines and the song command's tools; otherwise it is what it was.
describe('the Songs switch', () => {
  const promptOf = () => stubCall().argv[1] as string;
  const songTools = { ytDlp: '/opt/homebrew/bin/yt-dlp', deno: '/opt/homebrew/bin/deno' };
  const SONG_CALL = `song "<edit dir>"`;

  it.each([
    ['is left out', { music: true }],
    ['is off', { music: true, songs: false, songTools }],
    ['is on without the music', { songs: true, songTools }],
    ['is on with the music off', { music: false, songs: true, songTools }],
  ])('leaves the prompt and the environment as they were when it %s', async (_case, over) => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner({
      ...over,
      env: {
        PATH: process.env.PATH,
        STUDIO_YT_DLP: '/server/own/yt-dlp',
        STUDIO_DENO: '/server/own/deno',
      },
    }).start(makeJob(), 'start', ctx);
    expect(promptOf()).not.toContain(SONG_CALL);
    expect(promptOf()).not.toContain('Getting the song');
    const { env } = stubCall();
    expect(env).not.toHaveProperty('STUDIO_YT_DLP');
    expect(env).not.toHaveProperty('STUDIO_DENO');
  });

  it('gives the edit run the song lines, the script’s path and the tools when it is on with the music', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner({ review: true, music: true, songs: true, songTools }).start(
      makeJob(),
      'start',
      ctx,
    );
    expect(promptOf()).toMatch(/^Music: /m);
    expect(promptOf()).toContain(`node "${MUSIC_SCRIPT}" ${SONG_CALL} --title`);
    expect(promptOf()).toContain('Getting the song');
    expect(stubCall().env.STUDIO_YT_DLP).toBe('/opt/homebrew/bin/yt-dlp');
    expect(stubCall().env.STUDIO_DENO).toBe('/opt/homebrew/bin/deno');
    // Nothing else of Songs reaches the run: the script reads its Apify key itself.
    expect(Object.keys(stubCall().env).filter((key) => /APIFY|SONG/i.test(key))).toEqual([]);
  });

  it('gives a revise run its song lines and the tools too', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner({ review: true, music: true, songs: true, songTools }).start(
      makeJob(4, { runKind: 'revise', round: 1, state: 'editing' }),
      'start',
      ctx,
    );
    expect(promptOf()).toContain(`node "${MUSIC_SCRIPT}" ${SONG_CALL} --title`);
    expect(promptOf()).toContain('A note that asks for another song');
    expect(stubCall().env.STUDIO_YT_DLP).toBe('/opt/homebrew/bin/yt-dlp');
  });
});

describe('resume and retry prompts', () => {
  const promptOf = () => stubCall().argv[1] as string;

  it('resume carries on from the job step', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner().start(makeJob(5), 'resume', ctx);
    expect(promptOf()).toContain('stopped partway, at step 5 of 8 (Cut)');
    expect(markers('start')[0]).toMatchObject({ mode: 'resume', promptMode: 'resume', step: 5 });
  });

  it("retry quotes the previous attempt's error, read back from the job log", async () => {
    scenario({ replay: `${FIXTURES}blocked-run.jsonl` });
    const { ctx } = context();
    const failed = await runner().start(makeJob(2), 'start', ctx);
    expect(failed.ok).toBe(false);

    scenario({ writeFinal: true });
    const second = context();
    const outcome = await runner().start(makeJob(2), 'retry', second.ctx);

    expect(outcome).toEqual({ ok: true });
    expect(promptOf()).toContain('The previous attempt failed at step 2 of 8 (Transcribe)');
    expect(promptOf()).toContain(
      '> Finished without a final video: To unblock it, install ffmpeg (brew install ffmpeg)',
    );
    expect(markers('start').map((m) => m.promptMode)).toEqual(['start', 'retry']);
  });

  it('retry after a cancel (no recorded failure) uses the resume prompt', async () => {
    scenario({ hang: true });
    const first = context();
    const pending = runner().start(makeJob(7), 'start', first.ctx);
    await waitForStub();
    first.controller.abort();
    await pending;

    scenario({ writeFinal: true });
    const second = context();
    await runner().start(makeJob(7), 'retry' as RunMode, second.ctx);
    expect(promptOf()).toContain('stopped partway, at step 7 of 8 (Check)');
    expect(markers('start').at(-1)).toMatchObject({ mode: 'retry', promptMode: 'resume' });
  });

  it('a retry after a stopped run carries on like a resume: nothing failed, so no error is quoted', async () => {
    scenario({ hang: true });
    const first = context();
    const pending = runner().start(makeJob(7), 'start', first.ctx);
    await waitForStub();
    first.controller.abort('shutdown');
    await pending;

    scenario({ writeFinal: true });
    const second = context();
    await runner().start(makeJob(7), 'retry' as RunMode, second.ctx);

    expect(promptOf()).toContain('stopped partway, at step 7 of 8 (Check)');
    expect(promptOf()).not.toContain('Stopped because the engine shut down');
    expect(markers('start').at(-1)).toMatchObject({ mode: 'retry', promptMode: 'resume' });
  });
});

// CVP-138: a job whose fresh brief failed sits at step 1 with the edit's work still in edit/. Its
// resume and retry prompts name the step that work reached, not "step 1 of 8 (Brief)".
describe('resume and retry prompts for a job at Brief with edit work in edit/ (CVP-138)', () => {
  const promptOf = () => stubCall().argv[1] as string;

  /** Writes files into the job's edit/ folder, as an edit that got somewhere leaves them. */
  function writeEdit(paths: string[]): void {
    for (const path of paths) {
      const full = join(jobDir(), 'edit', path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, 'x');
    }
  }

  /** What an edit that got to Cut (5) leaves, besides the files of the Brief step. */
  const CUT = [
    'brief.json',
    'brief.md',
    'transcripts/a.json',
    'takes_packed.md',
    'project.md',
    'edl.json',
    'animations/slot_1/index.html',
  ];

  it('resume names the replayed step, "step 5 of 8 (Cut)", not Brief', async () => {
    scenario({ writeFinal: true });
    writeEdit(CUT);
    const { ctx } = context();
    await runner().start(makeJob(1), 'resume', ctx);

    expect(promptOf()).toContain('stopped partway, at step 5 of 8 (Cut)');
    expect(promptOf()).not.toContain('step 1 of 8');
    expect(markers('start')[0]).toMatchObject({
      mode: 'resume',
      promptMode: 'resume',
      step: 1,
      promptStep: 5,
    });
  });

  it('retry names the replayed step, and still quotes the error of the previous run', async () => {
    scenario({ replay: `${FIXTURES}blocked-run.jsonl` });
    const first = context();
    const failed = await runner().start(makeJob(2), 'start', first.ctx);
    expect(failed.ok).toBe(false);

    // The edit carried on to Cut, then a fresh brief failed and the job dropped to step 1.
    scenario({ writeFinal: true });
    writeEdit(CUT);
    const { ctx } = context();
    await runner().start(makeJob(1), 'retry', ctx);

    expect(promptOf()).toContain('The previous attempt failed at step 5 of 8 (Cut)');
    expect(promptOf()).not.toContain('step 1 of 8');
    expect(promptOf()).toContain('> Finished without a final video');
    expect(markers('start').at(-1)).toMatchObject({ promptMode: 'retry', step: 1, promptStep: 5 });
  });

  it('a retry with no recorded failure carries on like a resume, at the replayed step', async () => {
    scenario({ writeFinal: true });
    writeEdit([...CUT, 'preview.mp4', 'verify/p_0.9.jpg']);
    const { ctx } = context();
    await runner().start(makeJob(1), 'retry', ctx);

    expect(promptOf()).toContain('stopped partway, at step 7 of 8 (Check)');
    expect(markers('start')[0]).toMatchObject({
      mode: 'retry',
      promptMode: 'resume',
      promptStep: 7,
    });
  });

  it('keeps step 1 when edit/ holds only the Brief step’s files', async () => {
    scenario({ writeFinal: true });
    writeEdit(['brief.json', 'brief.md', 'brief/transcripts/note.json', 'verify/src_full.png']);
    const { ctx } = context();
    await runner().start(makeJob(1), 'resume', ctx);

    expect(promptOf()).toContain('stopped partway, at step 1 of 8 (Brief)');
    expect(markers('start')[0]).toMatchObject({ step: 1, promptStep: 1 });
  });

  it('keeps the job’s own step when it is past Brief: the stored step is right then', async () => {
    scenario({ writeFinal: true });
    writeEdit(CUT);
    const { ctx } = context();
    await runner().start(makeJob(3), 'resume', ctx);

    expect(promptOf()).toContain('stopped partway, at step 3 of 8 (Scan)');
    expect(markers('start')[0]).toMatchObject({ step: 3, promptStep: 3 });
  });

  it('keeps step 1 and warns when edit/ cannot be read', async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    scenario({ writeFinal: true });
    writeEdit(CUT);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const editDir = join(jobDir(), 'edit');
    chmodSync(editDir, 0o000);
    try {
      const { ctx } = context();
      await runner({ logger }).start(makeJob(1), 'resume', ctx);
    } finally {
      chmodSync(editDir, 0o755);
    }

    expect(promptOf()).toContain('stopped partway, at step 1 of 8 (Brief)');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
      expect.stringContaining('could not look for the step in edit/'),
    );
  });
});

// W2 (CVP-108): with the Review switch on, an edit run ends as a live composition in edit/preview/.
describe('a run that ends in Review (the switch is on)', () => {
  const promptOf = () => stubCall().argv[1] as string;
  const INDEX = 'edit/preview/index.html';
  const composition = (attributes: string): string =>
    `<!doctype html><html><head><title>x</title></head><body><div id="root" ${attributes}></div></body></html>`;
  const GOOD = composition(
    'data-composition-id="main" data-width="1080" data-height="1920" data-duration="28.4"',
  );
  const PREVIEW = { durationSec: 28.4, width: 1080, height: 1920 };

  it('succeeds on exit 0 and a valid composition, and reports the preview it describes', async () => {
    scenario({ writeFiles: { [INDEX]: GOOD, 'edit/preview/cut.mp4': 'x' } });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({ ok: true, preview: PREVIEW });
    expect(markers('start')[0]).toMatchObject({ runKind: 'edit', finish: 'preview' });
    expect(markers('end')[0]).toMatchObject({
      outcome: 'succeeded',
      exitCode: 0,
      preview: PREVIEW,
    });
  });

  // LU13: a real editor, told to end on the camera-LUT sentence, still leaves the composition it
  // could make without the graded cut. The sentence decides: the job waits, it is not in Review.
  it('a valid composition whose final message ends on the camera-LUT sentence waits for the LUT', async () => {
    const sentence = 'Waiting for a camera LUT: the clips are Sony S-Log3 (A7S_S-Log3_001.mp4).';
    scenario({
      writeFiles: { [INDEX]: GOOD },
      lines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: `I did everything that does not need the grade.\n\nBlocked: ${sentence}`,
        }),
      ],
    });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({ ok: false, step: 6, error: sentence });
    expect(markers('end')[0]).toMatchObject({ outcome: 'failed', exitCode: 0 });
  });

  it('a valid composition with a Blocked: line that is not the last line, or not about a camera LUT, still goes to Review', async () => {
    scenario({
      writeFiles: { [INDEX]: GOOD },
      lines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result:
            'Blocked: Waiting for a camera LUT: the clips are log footage.\n\nThe LUT arrived in the job folder, so I used it and finished the cut.',
        }),
      ],
    });
    const { ctx } = context();
    expect(await runner({ review: true }).start(makeJob(), 'start', ctx)).toEqual({
      ok: true,
      preview: PREVIEW,
    });
  });

  it('does not need an edit/final.mp4', async () => {
    scenario({ writeFiles: { [INDEX]: GOOD } });
    const { ctx } = context();
    const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);
    expect(outcome).toEqual({ ok: true, preview: PREVIEW });
    expect(existsSync(join(jobDir(), 'edit', 'final.mp4'))).toBe(false);
  });

  it('exit 0 with nothing written fails at Preview (6)', async () => {
    scenario({});
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({
      ok: false,
      step: 6,
      error: 'Finished without a preview: edit/preview/index.html is missing.',
    });
    expect(markers('end')[0]).toMatchObject({ outcome: 'failed', exitCode: 0 });
    expect(markers('end')[0]).not.toHaveProperty('preview');
  });

  it('a final.mp4 without a composition fails', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({
      ok: false,
      step: 6,
      error: 'Finished without a preview: edit/preview/index.html is missing.',
    });
  });

  it.each([
    [
      'no root element',
      '<html><body></body></html>',
      'edit/preview/index.html has no element with data-composition-id.',
    ],
    [
      'no duration',
      composition('data-composition-id="main" data-width="1080" data-height="1920"'),
      'the root element of edit/preview/index.html has no data-duration.',
    ],
    [
      'a width that is not a whole number',
      composition(
        'data-composition-id="main" data-width="1080.5" data-height="1920" data-duration="6"',
      ),
      'data-width="1080.5" on the root element of edit/preview/index.html is not a whole number above 0.',
    ],
  ])(
    'a composition with %s fails at Preview (6) and says what is wrong',
    async (_label, html, problem) => {
      scenario({ writeFiles: { [INDEX]: html } });
      const { ctx } = context();

      const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);

      expect(outcome).toEqual({
        ok: false,
        step: 6,
        error: `Finished without a preview: ${problem}`,
      });
    },
  );

  it('the E1 blocked run has no Blocked: line, so the failure says what is missing', async () => {
    // The fixture predates the Blocked: contract; its last paragraph is not used for a preview.
    scenario({ replay: `${FIXTURES}blocked-run.jsonl` });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({
      ok: false,
      step: 6,
      error: 'Finished without a preview: edit/preview/index.html is missing.',
    });
  });

  it('a run that ends with a Blocked: line fails with its reason', async () => {
    scenario({
      lines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Installed nothing.\n\nBlocked: ffmpeg is not installed (brew install ffmpeg).',
        }),
      ],
    });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({
      ok: false,
      step: 6,
      error: 'Finished without a preview: ffmpeg is not installed (brew install ffmpeg).',
    });
  });

  it('a composition with a non-zero exit is a failure with the usual text and no step', async () => {
    scenario({
      writeFiles: { [INDEX]: GOOD },
      exitCode: 1,
      lines: [
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Not logged in · Please run /login',
        }),
      ],
    });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({
      ok: false,
      error:
        'Claude Code is not logged in. Run `pnpm run doctor` for the login command, then retry.',
    });
    expect(outcome).not.toHaveProperty('step');
  });

  it('reads a composition in a job folder with Hebrew and spaces', async () => {
    const hebrew = join(inboxPath, 'מאפיית הצפון', 'פרומו לסוף השבוע');
    mkdirSync(hebrew, { recursive: true });
    writeFileSync(
      join(hebrew, 'stub-claude.json'),
      JSON.stringify({ writeFiles: { [INDEX]: GOOD } }),
    );
    const { ctx } = context();
    const job = makeJob(null, {
      client: 'מאפיית הצפון',
      name: 'פרומו לסוף השבוע',
      relPath: 'מאפיית הצפון/פרומו לסוף השבוע',
    });

    const outcome = await runner({ review: true }).start(job, 'start', ctx);

    expect(outcome).toEqual({ ok: true, preview: PREVIEW });
  });

  it.each(['start', 'resume', 'retry'] as const)(
    'sends the %s prompt with the preview goal and the preview finish',
    async (mode) => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const { ctx } = context();
      await runner({ review: true }).start(makeJob(5), mode, ctx);

      const prompt = promptOf();
      expect(prompt).toContain(
        'with the video-use skill and finish it as a live preview in edit/preview/ (Studio Engine renders the final video after the owner approves).',
      );
      expect(prompt).not.toContain('deliver edit/final.mp4');
      expect(prompt).not.toContain('The job is done when edit/final.mp4');
      expect(
        prompt.endsWith('Do not leave anything running in the background when you finish.\n'),
      ).toBe(true);
      expect(prompt).toContain('Finish the edit as a live preview, not a rendered video.');
      expect(prompt).toContain(
        '- The job is done when edit/preview/index.html passes lint and you have checked the snapshots.',
      );
    },
  );

  it('a retry quotes the Finished without a preview error of the previous run', async () => {
    scenario({});
    const first = context();
    const failed = await runner({ review: true }).start(makeJob(6), 'start', first.ctx);
    expect(failed.ok).toBe(false);

    scenario({ writeFiles: { [INDEX]: GOOD } });
    const second = context();
    const outcome = await runner({ review: true }).start(makeJob(6), 'retry', second.ctx);

    expect(outcome).toEqual({ ok: true, preview: PREVIEW });
    expect(promptOf()).toContain('The previous attempt failed at step 6 of 8 (Preview)');
    expect(promptOf()).toContain(
      '> Finished without a preview: edit/preview/index.html is missing.',
    );
  });

  it('gives the tracker hook finish: preview', async () => {
    scenario({ writeFiles: { [INDEX]: GOOD } });
    const tracked: TrackedRun[] = [];
    const track = (run: TrackedRun) => {
      tracked.push(run);
      return undefined;
    };
    const { ctx } = context();

    await runner({ review: true, track }).start(makeJob(), 'start', ctx);

    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.finish).toBe('preview');
  });

  it('with the switch off a composition alone is still "Finished without a final video."', async () => {
    scenario({ writeFiles: { [INDEX]: GOOD } });
    const tracked: TrackedRun[] = [];
    const track = (run: TrackedRun) => {
      tracked.push(run);
      return undefined;
    };
    const { ctx } = context();

    const outcome = await runner({ track }).start(makeJob(), 'start', ctx);

    expect(outcome).toEqual({ ok: false, error: 'Finished without a final video.' });
    expect(promptOf()).toMatch(
      /^Edit the footage in this folder with the video-use skill and deliver edit\/final\.mp4\./,
    );
    expect(promptOf()).not.toContain('live preview');
    expect(tracked[0]?.finish).toBe('final');
    expect(markers('start')[0]).toMatchObject({ runKind: 'edit', finish: 'final' });
  });

  it('with review: false given, final.mp4 still succeeds without a preview', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    const outcome = await runner({ review: false }).start(makeJob(), 'start', ctx);
    expect(outcome).toEqual({ ok: true });
    expect(markers('end')[0]).not.toHaveProperty('preview');
  });
});

// W3 (CVP-110): the runs after Send notes (revise) and after Approve (render).
describe('revise and render runs', () => {
  const promptOf = () => stubCall().argv[1] as string;
  const modelOf = (): string | null => {
    const argv = stubCall().argv;
    const at = argv.indexOf('--model');
    return at === -1 ? null : (argv[at + 1] ?? null);
  };
  const effortOf = (): string | null => {
    const argv = stubCall().argv;
    const at = argv.indexOf('--effort');
    return at === -1 ? null : (argv[at + 1] ?? null);
  };
  const INDEX = 'edit/preview/index.html';
  const GOOD =
    '<!doctype html><html><head><title>x</title></head><body><div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="28.4"></div></body></html>';
  const PREVIEW = { durationSec: 28.4, width: 1080, height: 1920 };
  const revise = (step: StepId | null = 4, round = 1) =>
    makeJob(step, { runKind: 'revise', round, state: 'editing' });
  const render = (step: StepId | null = 8) =>
    makeJob(step, { runKind: 'render', round: 1, state: 'editing' });

  describe('a revise run', () => {
    it('gets the revise prompt for its round and the configured model', async () => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const { ctx } = context();

      const outcome = await runner({ review: true }).start(revise(4, 2), 'start', ctx);

      expect(outcome).toEqual({ ok: true, preview: PREVIEW });
      expect(promptOf()).toMatch(/^Apply the owner's review notes to the edit in this folder/);
      expect(promptOf()).toContain('This is review round 2.');
      expect(promptOf()).toContain('edit/review/round-2.md');
      expect(promptOf()).not.toContain('The previous attempt');
      expect(promptOf()).not.toContain('An earlier run');
      expect(modelOf()).toBe('opus');
    });

    it('ends in a preview whatever the switch says', async () => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const { ctx } = context();
      const outcome = await runner({ review: false }).start(revise(), 'start', ctx);
      expect(outcome).toEqual({ ok: true, preview: PREVIEW });
      expect(markers('start')[0]).toMatchObject({ runKind: 'revise', finish: 'preview' });
    });

    it('records the run kind and the model it used in the start marker', async () => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const { ctx } = context();
      await runner({ review: true }).start(revise(), 'start', ctx);
      expect(markers('start')[0]).toMatchObject({
        runKind: 'revise',
        finish: 'preview',
        model: 'opus',
        effort: 'xhigh',
        mode: 'start',
        step: 4,
      });
    });

    it('needs a valid composition: nothing written fails at Preview (6)', async () => {
      scenario({});
      const { ctx } = context();
      const outcome = await runner({ review: true }).start(revise(), 'start', ctx);
      expect(outcome).toEqual({
        ok: false,
        step: 6,
        error: 'Finished without a preview: edit/preview/index.html is missing.',
      });
    });

    it('an edit/final.mp4 left by something else does not count', async () => {
      scenario({ writeFinal: true });
      const { ctx } = context();
      const outcome = await runner({ review: true }).start(revise(), 'start', ctx);
      expect(outcome).toMatchObject({ ok: false, step: 6 });
    });

    it('hands the tracker hook its kind and finish', async () => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const tracked: TrackedRun[] = [];
      const track = (run: TrackedRun) => {
        tracked.push(run);
        return undefined;
      };
      const { ctx } = context();
      await runner({ review: true, track }).start(revise(), 'start', ctx);
      expect(tracked[0]?.finish).toBe('preview');
      expect(tracked[0]?.job.runKind).toBe('revise');
    });

    it('a retry after a failed run quotes the error in the again sentence', async () => {
      scenario({});
      const first = context();
      const failed = await runner({ review: true }).start(revise(6), 'start', first.ctx);
      expect(failed.ok).toBe(false);

      scenario({ writeFiles: { [INDEX]: GOOD } });
      const second = context();
      const outcome = await runner({ review: true }).start(revise(6), 'retry', second.ctx);

      expect(outcome).toEqual({ ok: true, preview: PREVIEW });
      expect(promptOf()).toContain(
        'The previous attempt at this round failed at step 6 of 8 (Preview) with: Finished without a preview: edit/preview/index.html is missing. Find the cause first and fix it.',
      );
      expect(markers('start').map((m) => m.promptMode)).toEqual(['start', 'retry']);
    });

    it('a retry after a cancelled run uses the resume sentence', async () => {
      scenario({ hang: true });
      const first = context();
      const pending = runner({ review: true }).start(revise(6), 'start', first.ctx);
      await waitForStub();
      first.controller.abort();
      await pending;

      scenario({ writeFiles: { [INDEX]: GOOD } });
      const second = context();
      await runner({ review: true }).start(revise(6), 'retry', second.ctx);

      expect(promptOf()).toContain(
        'An earlier run of this round was stopped at step 6 of 8 (Preview). Carry on from what is in ./edit/.',
      );
      expect(markers('start').at(-1)).toMatchObject({ mode: 'retry', promptMode: 'resume' });
    });

    it('a resume names the step it carries on from', async () => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const { ctx } = context();
      await runner({ review: true }).start(revise(5), 'resume', ctx);
      expect(promptOf()).toContain(
        'An earlier run of this round was stopped at step 5 of 8 (Cut).',
      );
    });

    it('leaves the model to the CLI when none is configured', async () => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const { ctx } = context();
      await runner({ review: true, noModel: true }).start(revise(), 'start', ctx);
      expect(modelOf()).toBeNull();
      expect(markers('start')[0]).toMatchObject({ model: null });
    });
  });

  describe('a render run', () => {
    it('runs on sonnet with the render prompt', async () => {
      scenario({ writeFinal: true });
      const { ctx } = context();

      const outcome = await runner({ review: true }).start(render(), 'start', ctx);

      expect(outcome).toEqual({ ok: true });
      expect(modelOf()).toBe('sonnet');
      expect(promptOf()).toMatch(/^Render the approved edit in this folder to edit\/final\.mp4/);
      expect(promptOf()).toContain('npx hyperframes render -q delivery --strict --no-best-effort');
      expect(promptOf()).not.toContain('The previous attempt');
      expect(markers('start')[0]).toMatchObject({
        runKind: 'render',
        finish: 'final',
        model: 'sonnet',
        effort: null,
        step: 8,
      });
    });

    it('runs on sonnet even when no model is configured, and when another one is', async () => {
      scenario({ writeFinal: true });
      const { ctx } = context();
      await runner({ noModel: true }).start(render(), 'start', ctx);
      expect(modelOf()).toBe('sonnet');
    });

    it('needs the final video: a composition alone is "Finished without a final video."', async () => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const { ctx } = context();
      const outcome = await runner({ review: true }).start(render(), 'start', ctx);
      expect(outcome).toEqual({ ok: false, error: 'Finished without a final video.' });
    });

    it('hands the tracker hook finish: final', async () => {
      scenario({ writeFinal: true });
      const tracked: TrackedRun[] = [];
      const track = (run: TrackedRun) => {
        tracked.push(run);
        return undefined;
      };
      const { ctx } = context();
      await runner({ review: true, track }).start(render(), 'start', ctx);
      expect(tracked[0]?.finish).toBe('final');
      expect(tracked[0]?.job.runKind).toBe('render');
    });

    it('a retry after a failed render quotes the error', async () => {
      scenario({ replay: `${FIXTURES}blocked-run.jsonl` });
      const first = context();
      const failed = await runner({ review: true }).start(render(), 'start', first.ctx);
      expect(failed.ok).toBe(false);

      scenario({ writeFinal: true });
      const second = context();
      const outcome = await runner({ review: true }).start(render(), 'retry', second.ctx);

      expect(outcome).toEqual({ ok: true });
      expect(promptOf()).toContain(
        'The previous attempt at the render failed at step 8 of 8 (Render) with: Finished without a final video: To unblock it, install ffmpeg (brew install ffmpeg)',
      );
    });

    it('a resume says an earlier render was stopped', async () => {
      scenario({ writeFinal: true });
      const { ctx } = context();
      await runner({ review: true }).start(render(), 'resume', ctx);
      expect(promptOf()).toContain(
        'An earlier render was stopped at step 8 of 8 (Render). Carry on from what is in ./edit/.',
      );
    });
  });

  it('an edit run still gets the configured model and the edit prompt', async () => {
    scenario({ writeFinal: true });
    const { ctx } = context();
    await runner().start(makeJob(), 'start', ctx);
    expect(modelOf()).toBe('opus');
    expect(promptOf()).toMatch(/^Edit the footage in this folder/);
  });

  // CVP-192: the job's effort (the owner sets it from the row menu while the job waits) goes to the CLI.
  // A job on Default (null) runs at Extra high.
  describe('the job’s effort', () => {
    it('an edit run with no effort (Default) is sent --effort xhigh, and logs it', async () => {
      scenario({ writeFinal: true });
      const { ctx } = context();
      await runner().start(makeJob(), 'start', ctx);
      expect(effortOf()).toBe('xhigh');
      expect(modelOf()).toBe('opus');
      expect(markers('start')[0]).toMatchObject({ effort: 'xhigh' });
    });

    it.each(['medium', 'high', 'xhigh'] as const)(
      'an edit run with effort %s sends --effort %s and logs it',
      async (effort) => {
        scenario({ writeFinal: true });
        const { ctx } = context();
        await runner().start(makeJob(null, { effort }), 'start', ctx);
        expect(effortOf()).toBe(effort);
        expect(modelOf()).toBe('opus');
        expect(markers('start')[0]).toMatchObject({ effort });
      },
    );

    it('a resume and a retry keep the job’s effort', async () => {
      for (const mode of ['resume', 'retry'] as const) {
        scenario({ writeFinal: true });
        const { ctx } = context();
        await runner().start(makeJob(3, { effort: 'high' }), mode, ctx);
        expect(effortOf(), mode).toBe('high');
      }
    });

    it('a revise run uses the job’s effort, or the default', async () => {
      scenario({ writeFiles: { [INDEX]: GOOD } });
      const { ctx } = context();
      await runner({ review: true }).start(revise(4, 1), 'start', ctx);
      expect(effortOf()).toBe('xhigh');

      scenario({ writeFiles: { [INDEX]: GOOD } });
      const second = context();
      await runner({ review: true }).start(
        makeJob(4, { runKind: 'revise', round: 1, state: 'editing', effort: 'medium' }),
        'start',
        second.ctx,
      );
      expect(effortOf()).toBe('medium');
      expect(markers('start').at(-1)).toMatchObject({ runKind: 'revise', effort: 'medium' });
    });

    // QF4 (CVP-376): with the Quick fixes switch on, a revise run takes the level chosen in Review,
    // else the tier Send saved with Auto, else the edit's effort. `opus` is the configured model.
    describe('a revise run with quick fixes on', () => {
      const SLIM = 'Self-eval only around what this round changed';
      const WHOLE = 'Self-eval on the composition instead of a render';
      const table: [
        string,
        Partial<Job>,
        { model: string; effort: string; checks: typeof SLIM | typeof WHOLE },
      ][] = [
        ['nothing saved: today’s run', {}, { model: 'opus', effort: 'xhigh', checks: WHOLE }],
        [
          'nothing saved, the edit at Medium',
          { effort: 'medium' },
          { model: 'opus', effort: 'medium', checks: WHOLE },
        ],
        [
          'Auto asked for the Revise tier: Sonnet at High with the slim check',
          { reviseTier: 'revise' },
          { model: 'sonnet', effort: 'high', checks: SLIM },
        ],
        [
          'Auto asked for the Full tier: the configured model at Extra high, the whole check',
          { reviseTier: 'full', effort: 'medium' },
          { model: 'opus', effort: 'xhigh', checks: WHOLE },
        ],
        [
          'a level chosen in Review: the configured model at that level',
          { reviewEffort: 'medium' },
          { model: 'opus', effort: 'medium', checks: WHOLE },
        ],
        [
          'a level beats a tier still on the job',
          { reviewEffort: 'high', reviseTier: 'revise' },
          { model: 'opus', effort: 'high', checks: WHOLE },
        ],
      ];

      it.each(table)('%s', async (_name, over, expected) => {
        scenario({ writeFiles: { [INDEX]: GOOD } });
        const { ctx } = context();
        await runner({ review: true, quickFixes: true }).start(
          makeJob(4, { runKind: 'revise', round: 1, state: 'editing', ...over }),
          'start',
          ctx,
        );
        expect(modelOf()).toBe(expected.model);
        expect(effortOf()).toBe(expected.effort);
        expect(promptOf()).toContain(expected.checks);
        expect(promptOf()).not.toContain(expected.checks === SLIM ? WHOLE : SLIM);
        // The job log says which model and effort the run had.
        expect(markers('start').at(-1)).toMatchObject({
          runKind: 'revise',
          model: expected.model,
          effort: expected.effort,
        });
      });

      it('a retry and a resume of the round choose the same', async () => {
        for (const mode of ['resume', 'retry'] as const) {
          scenario({ writeFiles: { [INDEX]: GOOD } });
          const { ctx } = context();
          await runner({ review: true, quickFixes: true }).start(
            makeJob(5, { runKind: 'revise', round: 1, state: 'editing', reviseTier: 'revise' }),
            mode,
            ctx,
          );
          expect(modelOf(), mode).toBe('sonnet');
          expect(effortOf(), mode).toBe('high');
          expect(promptOf(), mode).toContain(SLIM);
        }
      });

      it('does not touch an edit run or a render run', async () => {
        scenario({ writeFinal: true });
        const first = context();
        await runner({ quickFixes: true }).start(
          makeJob(null, { effort: 'high', reviewEffort: 'medium', reviseTier: 'revise' }),
          'start',
          first.ctx,
        );
        expect(modelOf()).toBe('opus');
        expect(effortOf()).toBe('high');
        expect(promptOf()).not.toContain(SLIM);

        scenario({ writeFinal: true });
        const second = context();
        await runner({ review: true, quickFixes: true }).start(
          makeJob(8, {
            runKind: 'render',
            round: 1,
            state: 'editing',
            effort: 'high',
            reviewEffort: 'medium',
            reviseTier: 'revise',
          }),
          'start',
          second.ctx,
        );
        expect(modelOf()).toBe('sonnet');
        expect(effortOf()).toBeNull();
      });

      it('is today’s run with the switch off, whatever the job carries', async () => {
        scenario({ writeFiles: { [INDEX]: GOOD } });
        const { ctx } = context();
        await runner({ review: true }).start(
          makeJob(4, {
            runKind: 'revise',
            round: 1,
            state: 'editing',
            effort: 'medium',
            reviewEffort: 'high',
            reviseTier: 'revise',
          }),
          'start',
          ctx,
        );
        expect(modelOf()).toBe('opus');
        expect(effortOf()).toBe('medium');
        expect(promptOf()).toContain(WHOLE);
        expect(promptOf()).not.toContain(SLIM);
      });
    });

    it('a render run never gets --effort, whatever the job has', async () => {
      scenario({ writeFinal: true });
      const { ctx } = context();
      await runner({ review: true }).start(
        makeJob(8, { runKind: 'render', round: 1, state: 'editing', effort: 'high' }),
        'start',
        ctx,
      );
      expect(modelOf()).toBe('sonnet');
      expect(effortOf()).toBeNull();
      expect(markers('start')[0]).toMatchObject({ runKind: 'render', effort: null });
    });
  });
});

// Formats (GN7): a job with two or more formats (`job.formats`) has a composition per format and a
// video per format. A run that ends in Review succeeds only when ALL of them are valid.
describe('a job with two formats', () => {
  const promptOf = () => stubCall().argv[1] as string;
  const composition = (width: number, height: number): string =>
    `<!doctype html><html><head><title>x</title></head><body><div id="root" data-composition-id="main" data-width="${width}" data-height="${height}" data-duration="28.4"></div></body></html>`;
  const MAIN = composition(1080, 1920);
  const SQUARE = composition(1080, 1080);
  const PREVIEW = { durationSec: 28.4, width: 1080, height: 1920 };
  const formats = jobFormatsOf(['1080x1920', '1080x1080']);
  const job = (overrides: Partial<Job> = {}) => makeJob(6, { formats, ...overrides });

  it('succeeds when both compositions are valid, and sends the formats part of the prompt', async () => {
    scenario({
      writeFiles: {
        'edit/preview/index.html': MAIN,
        'edit/preview-1x1/index.html': SQUARE,
      },
    });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(job(), 'start', ctx);

    expect(outcome).toEqual({ ok: true, preview: PREVIEW });
    expect(promptOf()).toContain('Formats: the brief asks for 2 formats');
    expect(promptOf()).toContain('edit/preview-1x1/ for 1:1 (1080x1080)');
  });

  it('fails with the problem of the second composition when it is missing', async () => {
    scenario({ writeFiles: { 'edit/preview/index.html': MAIN } });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(job(), 'start', ctx);

    expect(outcome).toEqual({
      ok: false,
      step: 6,
      error: 'Finished without a preview: edit/preview-1x1/index.html is missing.',
    });
  });

  it('fails when the second composition has the wrong shape', async () => {
    scenario({
      writeFiles: {
        'edit/preview/index.html': MAIN,
        'edit/preview-1x1/index.html': MAIN,
      },
    });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(job(), 'start', ctx);

    expect(outcome).toEqual({
      ok: false,
      step: 6,
      error:
        'Finished without a preview: edit/preview-1x1/index.html is 1080x1920, but the 1:1 format is 1080x1080.',
    });
  });

  it('a job with one format does not look for another composition', async () => {
    scenario({ writeFiles: { 'edit/preview/index.html': MAIN } });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(makeJob(6), 'start', ctx);

    expect(outcome).toEqual({ ok: true, preview: PREVIEW });
    expect(promptOf()).not.toContain('Formats: the brief asks for');
  });

  it('a revise run keeps both compositions in step', async () => {
    scenario({
      writeFiles: { 'edit/preview/index.html': MAIN, 'edit/preview-1x1/index.html': SQUARE },
    });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(
      job({ runKind: 'revise', round: 1 }),
      'start',
      ctx,
    );

    expect(outcome).toEqual({ ok: true, preview: PREVIEW });
    expect(promptOf()).toContain('Formats: the brief asks for 2 formats');
  });

  it('a revise run that left only the main composition fails', async () => {
    scenario({ writeFiles: { 'edit/preview/index.html': MAIN } });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(
      job({ runKind: 'revise', round: 1 }),
      'start',
      ctx,
    );

    expect(outcome.ok).toBe(false);
  });

  it('a render run needs a video of each format, and tells the run to render them', async () => {
    scenario({ writeFiles: { 'edit/final.mp4': 'x', 'edit/final-1x1.mp4': 'x' } });
    const { ctx } = context();
    const render = job({ runKind: 'render', round: 1 });

    expect(await runner({ review: true }).start(render, 'start', ctx)).toEqual({ ok: true });
    expect(promptOf()).toContain('This job has more than one format, so render each one');
    expect(promptOf()).toContain('-o ../final-1x1.mp4');
  });

  it('a render run that made only the main video fails and names the other', async () => {
    scenario({ writeFiles: { 'edit/final.mp4': 'x' } });
    const { ctx } = context();

    const outcome = await runner({ review: true }).start(
      job({ runKind: 'render', round: 1 }),
      'start',
      ctx,
    );

    expect(outcome).toEqual({
      ok: false,
      error: 'Finished without a final video: edit/final-1x1.mp4 was not made.',
    });
  });

  it('a render run of a job with one format needs only edit/final.mp4, as before', async () => {
    scenario({ writeFiles: { 'edit/final.mp4': 'x' } });
    const { ctx } = context();
    expect(
      await runner({ review: true }).start(
        makeJob(8, { runKind: 'render', round: 1 }),
        'start',
        ctx,
      ),
    ).toEqual({ ok: true });
  });

  it('an edit run that skips Review delivers one video and is not told about formats', async () => {
    scenario({ writeFiles: { 'edit/final.mp4': 'x' } });
    const { ctx } = context();

    const outcome = await runner({ review: false }).start(job(), 'start', ctx);

    expect(outcome).toEqual({ ok: true });
    expect(promptOf()).not.toContain('Formats: the brief asks for');
  });
});

describe('leftovers from an earlier engine', () => {
  it('stops a run its record still points at before starting the next one', async () => {
    // Engine #1 starts a run and "crashes": nobody aborts it, the record stays.
    scenario({ hang: true, grandchild: true });
    const first = context();
    const firstRun = runner().start(makeJob(3), 'start', first.ctx);
    const orphan = await waitForStub();
    await vi.waitFor(() => expect(readdirSync(join(dataDir, 'runs'))).toEqual([`${JOB_ID}.json`]));

    // Engine #2 resumes the job: the old claude and its tool command are stopped first.
    rmSync(join(jobDir(), 'stub-claude.call.json'));
    scenario({ writeFinal: true });
    const second = context();
    const outcome = await runner().start(makeJob(3), 'resume', second.ctx);

    expect(outcome).toEqual({ ok: true });
    expect(await running([orphan.pid, orphan.grandchild as number])).toEqual([]);
    expect(markers('reaped')[0]).toMatchObject({ jobId: JOB_ID, pid: orphan.pid, processes: 2 });
    // (In this test both "engines" are one process, so the first run settles now as well.)
    expect((await firstRun).ok).toBe(false);
  });
});
