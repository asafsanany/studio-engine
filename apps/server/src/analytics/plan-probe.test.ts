import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS_LOG_FILE, readLimits } from './limits-log.js';
import {
  claudePlanProbeRun,
  PLAN_PROBE_MODEL,
  PLAN_PROBE_PROMPT,
  PLAN_PROBE_STALE_MS,
  PlanProbe,
  planProbeArgs,
  planProbeLogPath,
  planProbeRunsDir,
  readingIsStale,
} from './plan-probe.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const readingAt = (minutesAgo: number) => ({ at: new Date(NOW - minutesAgo * MIN).toISOString() });

describe('readingIsStale', () => {
  it('is stale with no reading at all', () => {
    expect(readingIsStale([], NOW)).toBe(true);
  });

  it('is stale when the newest reading is older than 10 minutes, not at exactly 10', () => {
    expect(PLAN_PROBE_STALE_MS).toBe(10 * MIN);
    expect(readingIsStale([readingAt(11)], NOW)).toBe(true);
    expect(readingIsStale([readingAt(10)], NOW)).toBe(false);
    expect(readingIsStale([readingAt(3)], NOW)).toBe(false);
  });

  it('goes by the newest reading wherever it sits in the file', () => {
    expect(readingIsStale([readingAt(120), readingAt(2), readingAt(300)], NOW)).toBe(false);
    expect(readingIsStale([readingAt(2), readingAt(120)], NOW)).toBe(false);
    expect(readingIsStale([readingAt(120), readingAt(30)], NOW)).toBe(true);
  });

  it('skips a reading whose time cannot be read', () => {
    expect(readingIsStale([{ at: 'not a time' }, readingAt(1)], NOW)).toBe(false);
    expect(readingIsStale([{ at: 'not a time' }], NOW)).toBe(true);
  });
});

describe('PlanProbe', () => {
  function probe(
    readings: { at: string }[],
    run: (signal: AbortSignal) => Promise<void>,
    clock: { now: number } = { now: NOW },
  ) {
    return new PlanProbe({
      readLimits: async () => readings,
      run,
      clock: () => new Date(clock.now),
    });
  }

  it('starts a run in the background when the newest reading is stale, and poke does not wait for it', async () => {
    let release: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const p = probe([readingAt(60)], run);

    p.poke();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    release();
    await p.idle();
  });

  it('starts nothing when the newest reading is fresh', async () => {
    const run = vi.fn(async () => {});
    const p = probe([readingAt(4)], run);

    p.poke();
    await p.idle();

    expect(run).not.toHaveBeenCalled();
  });

  it('runs at most one at a time: pokes while it runs start no other', async () => {
    let release: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const p = probe([], run);

    p.poke();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    p.poke();
    p.poke();
    release();
    await p.idle();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not try again within 10 minutes, even when the run learned nothing', async () => {
    const run = vi.fn(async () => {});
    const clock = { now: NOW };
    const p = probe([], run, clock);

    p.poke();
    await p.idle();
    clock.now += 9 * MIN;
    p.poke();
    await p.idle();
    expect(run).toHaveBeenCalledTimes(1);

    clock.now += 2 * MIN;
    p.poke();
    await p.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('swallows a failing run (and a failing read) and still waits before the next try', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const clock = { now: NOW };
    const p = probe([], run, clock);

    p.poke();
    await p.idle();
    p.poke();
    await p.idle();
    expect(run).toHaveBeenCalledTimes(1);

    const broken = new PlanProbe({
      readLimits: async () => {
        throw new Error('cannot read');
      },
      run,
    });
    broken.poke();
    await expect(broken.idle()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop aborts the run under way and starts no more', async () => {
    let seen: AbortSignal | null = null;
    const run = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          seen = signal;
          signal.addEventListener('abort', () => resolve());
        }),
    );
    const clock = { now: NOW };
    const p = probe([], run, clock);

    p.poke();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await p.stop();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);

    clock.now += 60 * MIN;
    p.poke();
    await p.idle();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('the command', () => {
  it('is haiku, a one-word prompt and no tools at all', () => {
    const args = planProbeArgs();
    expect(args.slice(0, 2)).toEqual(['-p', PLAN_PROBE_PROMPT]);
    expect(args[args.indexOf('--model') + 1]).toBe(PLAN_PROBE_MODEL);
    expect(PLAN_PROBE_MODEL).toBe('haiku');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
    expect(args).toContain('--strict-mcp-config');
  });
});

// The run end to end against the stand-in `claude` (pipeline/testdata/stub-claude.mjs).

const STUB = fileURLToPath(new URL('../pipeline/testdata/stub-claude.mjs', import.meta.url));

describe('claudePlanProbeRun', () => {
  let root: string;
  let dataDir: string;
  let logsDir: string;
  let claudeBin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'studio-plan-probe-'));
    dataDir = join(root, 'data');
    logsDir = join(dataDir, 'logs');
    claudeBin = join(root, 'bin', 'claude');
    mkdirSync(join(root, 'bin'), { recursive: true });
    copyFileSync(STUB, claudeBin);
    chmodSync(claudeBin, 0o755);
    mkdirSync(join(planProbeRunsDir(dataDir), 'work'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const work = () => join(planProbeRunsDir(dataDir), 'work');
  const scenario = (s: object) =>
    writeFileSync(join(work(), 'stub-claude.json'), JSON.stringify(s));
  const call = () =>
    JSON.parse(readFileSync(join(work(), 'stub-claude.call.json'), 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };

  const EVENT = (fiveHour: number, sevenDay: number) =>
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: fiveHour, resetsAt: 1792850000 },
          seven_day: { utilization: sevenDay, resetsAt: 1792864800 },
        },
      },
    });
  const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-probe' });
  const RESULT = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
  });

  function run(env: Record<string, string | undefined> = {}) {
    return claudePlanProbeRun({
      config: { logsDir, dataDir, claudeBin },
      home: join(root, 'home'),
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...env },
      killGraceMs: 1_000,
      sampleIntervalMs: 50,
    })(new AbortController().signal);
  }

  it('runs the probe command without the API key, even when the server has one', async () => {
    scenario({ lines: [INIT, EVENT(0.3, 0.96), RESULT] });

    await run({ ANTHROPIC_API_KEY: 'sk-ant-must-not-pass' });

    const { argv, env } = call();
    expect(argv).toEqual(planProbeArgs());
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe(join(root, 'home'));
  });

  it('writes the plan’s reading to limits.jsonl', async () => {
    scenario({ lines: [INIT, EVENT(0.3, 0.96), RESULT] });

    await run();

    const readings = await readLimits(dataDir);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      status: 'allowed',
      fiveHour: { utilization: 0.3 },
      sevenDay: { utilization: 0.96, resetsAt: '2026-10-24T18:00:00.000Z' },
    });
    expect(existsSync(join(dataDir, LIMITS_LOG_FILE))).toBe(true);
  });

  it('is not logged to usage.jsonl', async () => {
    scenario({ lines: [INIT, EVENT(0.3, 0.96), RESULT] });

    await run();

    expect(existsSync(join(dataDir, 'usage.jsonl'))).toBe(false);
  });

  it('leaves a log with its start and end, and no run record behind', async () => {
    scenario({ lines: [INIT, EVENT(0.3, 0.96), RESULT] });

    await run();

    const log = readFileSync(planProbeLogPath(logsDir), 'utf8');
    expect(log).toContain('"event":"plan_probe_start"');
    expect(log).toContain('"event":"plan_probe_end"');
    expect(existsSync(join(planProbeRunsDir(dataDir), 'plan-probe.json'))).toBe(false);
  });

  it('adds nothing when the run learns nothing (not logged in), and does not throw', async () => {
    scenario({ lines: [INIT, RESULT], exitCode: 1 });

    await expect(run()).resolves.toBeUndefined();

    expect(await readLimits(dataDir)).toEqual([]);
  });

  it('does not start when it is already shut down', async () => {
    const controller = new AbortController();
    controller.abort('shutdown');
    await claudePlanProbeRun({ config: { logsDir, dataDir, claudeBin }, home: root, env: {} })(
      controller.signal,
    );
    expect(existsSync(join(work(), 'stub-claude.call.json'))).toBe(false);
  });
});
