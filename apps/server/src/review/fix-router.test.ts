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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIX_LIMITS, type Job, type ReviewNote } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listProcesses } from '../pipeline/process-tree.js';
import { fixRouteUsage } from '../usage/app-usage.js';
import { readUsageLog } from '../usage/usage-log.js';
import {
  ClaudeNoteRouter,
  ClaudeRouteRunner,
  type ClaudeRouteRunnerOptions,
  fixRouteClaudeArgs,
  fixRouteLogPath,
  fixRouteRunsDir,
  fixRouteWorkDir,
  type RouteRunner,
  type RouteRunOutcome,
  type RouteRunRequest,
  UNREADABLE_ROUTE,
} from './fix-router.js';

// The router: the headless Haiku run end to end against the stand-in `claude`
// (pipeline/testdata/stub-claude.mjs: real processes, pipes and signals, no model), and the router
// around it (prompt, parsing, the retry, the fallback) against a stand-in run whose answers the
// test decides.

const STUB = fileURLToPath(new URL('../pipeline/testdata/stub-claude.mjs', import.meta.url));

const JOB = { id: 'job-1', client: 'Acme', name: 'Demo', relPath: 'Acme/Demo' } as Job;
const NOTE = {
  id: 'n1',
  jobId: 'job-1',
  round: null,
  atSec: 12,
  kind: 'text',
  text: 'Change the caption font to Heebo Bold',
} as ReviewNote;

const GOOD = '{"tier":"quick","kind":"Changing the caption font","why":""}';
const GOOD_ROUTE = { tier: 'quick', kind: 'Changing the caption font', why: '' };

let root: string;
let dataDir: string;
let logsDir: string;
let inboxPath: string;
let claudeBin: string;
const leftovers: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-fix-router-'));
  dataDir = join(root, 'data');
  logsDir = join(dataDir, 'logs');
  inboxPath = join(root, 'inbox');
  claudeBin = join(root, 'bin', 'claude');
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
  mkdirSync(workDir(), { recursive: true });
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

/** The runs' working folder: where the stub finds its scenario and leaves its call. */
function workDir(): string {
  return fixRouteWorkDir(dataDir);
}

interface Scenario {
  lines?: string[];
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
}

function scenario(s: Scenario): void {
  writeFileSync(join(workDir(), 'stub-claude.json'), JSON.stringify(s));
}

function stubCall(): { argv: string[]; env: Record<string, string>; cwd: string; pid: number } {
  return JSON.parse(readFileSync(join(workDir(), 'stub-claude.call.json'), 'utf8'));
}

/** Waits for a stub other than `not` to have started, and returns its pid. */
async function waitForStub(not?: number): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(workDir(), 'stub-claude.call.json'))) {
      const { pid } = stubCall();
      if (pid !== not) {
        leftovers.push(pid);
        return pid;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the stub never started');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runner(options: Partial<ClaudeRouteRunnerOptions> = {}) {
  return new ClaudeRouteRunner({
    config: { logsDir, dataDir, claudeBin },
    home: join(root, 'home'),
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ANTHROPIC_API_KEY: 'sk-ant-test-passed',
    },
    killGraceMs: 1_000,
    sampleIntervalMs: 50,
    ...options,
  });
}

function request(controller = new AbortController()): RouteRunRequest {
  return {
    prompt: 'Sort this note.\n{"id":"n1"}',
    usage: fixRouteUsage(JOB),
    signal: controller.signal,
    fields: { jobId: 'job-1', noteId: 'n1', attempt: 1 },
  };
}

function markers(): Record<string, unknown>[] {
  return readFileSync(fixRouteLogPath(logsDir), 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => line.startsWith('{"type":"studio_engine"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const RESULT_LINE = (text: string, isError = false) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result: text });
const INIT_LINE = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' });

describe('the command', () => {
  it('runs Haiku with no tools and no effort, in its own folder, with a scrubbed environment', async () => {
    scenario({ lines: [RESULT_LINE(GOOD)] });
    await runner().run(request());

    const call = stubCall();
    expect(call.cwd).toBe(realpathSync(workDir()));
    expect(call.argv[0]).toBe('-p');
    expect(call.argv[1]).toBe('Sort this note.\n{"id":"n1"}');
    expect(call.argv.slice(2)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'haiku',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--tools',
      '',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
    expect(call.argv).not.toContain('--effort');
    expect(fixRouteClaudeArgs('x').slice(2)).toEqual(call.argv.slice(2));
    expect(call.env.STUDIO_ENGINE_RUN).toMatch(/^fix-route-/);
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('works in <dataDir>/fix-route-runs/work, apart from the run records', () => {
    expect(workDir()).toBe(join(dataDir, 'fix-route-runs', 'work'));
    expect(fixRouteRunsDir(dataDir)).toBe(join(dataDir, 'fix-route-runs'));
    expect(fixRouteLogPath(logsDir)).toBe(join(logsDir, 'fix-route.log'));
  });
});

describe('the answer', () => {
  it('is the text the run ended with', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE(GOOD)] });
    expect(await runner().run(request())).toEqual({ ok: true, text: GOOD });
  });

  it('is a failure when the run exits with an error, an error result or no result', async () => {
    scenario({ lines: [RESULT_LINE('Credit balance is too low', true)], exitCode: 1 });
    const failed = await runner().run(request());
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toMatch(/^Fix router stopped: /);

    scenario({ lines: [RESULT_LINE('The model is overloaded', true)], exitCode: 0 });
    expect(await runner().run(request())).toEqual({
      ok: false,
      error: 'Fix router stopped: The model is overloaded',
    });

    scenario({ lines: [], exitCode: 0 });
    expect(await runner().run(request())).toEqual({
      ok: false,
      error: 'Fix router stopped: Claude finished without an answer.',
    });
  });

  it('fails with a line to act on when Claude Code is not there', async () => {
    const outcome = await runner({
      config: { logsDir, dataDir, claudeBin: join(root, 'no-such-claude') },
      env: { PATH: '' },
    }).run(request());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(
      /^Fix router stopped: Claude Code (was not found|at )/,
    );
  });
});

describe('the log and the usage', () => {
  it('frames the stream with fix_route_start and fix_route_end in logs/fix-route.log', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE(GOOD)] });
    await runner().run(request());

    const [start, end] = markers();
    expect(start).toMatchObject({
      event: 'fix_route_start',
      run: 'fix-route',
      jobId: 'job-1',
      noteId: 'n1',
      attempt: 1,
      model: 'haiku',
      timeoutMs: FIX_LIMITS.routeSec * 1000,
      prompt: 'Sort this note.\n{"id":"n1"}',
    });
    expect(String(start?.runTag)).toMatch(/^fix-route-/);
    expect(end).toMatchObject({
      event: 'fix_route_end',
      run: 'fix-route',
      runTag: start?.runTag,
      outcome: 'succeeded',
      exitCode: 0,
      sessionId: 's-1',
    });
    expect(readFileSync(fixRouteLogPath(logsDir), 'utf8')).toContain('"session_id":"s-1"');
  });

  it('logs the run in usage.jsonl under fix-route, on the job, once it has a session', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE(GOOD)] });
    await runner().run(request());

    const entries = await readUsageLog(dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'app',
      tag: 'fix-route',
      did: 'Sorted a review note for Acme / Demo',
      client: 'Acme',
      job: { id: 'job-1', name: 'Demo' },
      session: 's-1',
    });
  });

  it('records a failed run too', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('nope', true)], exitCode: 1 });
    await runner().run(request());
    expect(markers().at(-1)).toMatchObject({ event: 'fix_route_end', outcome: 'failed' });
  });
});

describe('stopping', () => {
  it('stops the run and its process tree when it is aborted', async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const running = runner().run(request(controller));
    const pid = await waitForStub();
    controller.abort();

    expect(await running).toEqual({ ok: false, error: 'Fix router stopped: the run was stopped.' });
    expect((await listProcesses()).some((entry) => entry.pid === pid)).toBe(false);
  });

  it('does not start when it is stopped already', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await runner().run(request(controller))).ok).toBe(false);
    expect(existsSync(join(workDir(), 'stub-claude.call.json'))).toBe(false);
  });

  it('stops a run that takes longer than the limit', async () => {
    scenario({ hang: true });
    const outcome = await runner({ timeoutMs: 400 }).run(request());
    const pid = stubCall().pid;
    leftovers.push(pid);

    expect(outcome).toEqual({
      ok: false,
      error: `Fix router stopped: it took longer than ${FIX_LIMITS.routeSec} seconds.`,
    });
    expect(markers().at(-1)).toMatchObject({ outcome: 'timed_out' });
    expect((await listProcesses()).some((entry) => entry.pid === pid)).toBe(false);
  });
});

describe('runs at the same time', () => {
  const records = (): string[] =>
    readdirSync(fixRouteRunsDir(dataDir)).filter((name) => name.endsWith('.json'));

  it('removes the records an earlier engine left, before the first run', async () => {
    writeFileSync(
      join(fixRouteRunsDir(dataDir), 'fix-route-old.json'),
      JSON.stringify({
        jobId: 'fix-route-old',
        pid: 2_000_000,
        identity: 'not a real process',
        startedAt: new Date().toISOString(),
      }),
    );
    expect(records()).toEqual(['fix-route-old.json']);
    scenario({ hang: true });

    const controller = new AbortController();
    const running = runner().run(request(controller));
    await waitForStub();
    expect(records()).toHaveLength(1);
    expect(records()).not.toContain('fix-route-old.json');
    controller.abort();
    await running;
    expect(records()).toEqual([]);
  });

  it('never stops a run that is going because another one starts', async () => {
    scenario({ hang: true });
    const shared = runner();
    const first = new AbortController();
    const second = new AbortController();

    const one = shared.run(request(first));
    const pidOne = await waitForStub();
    const two = shared.run(request(second));
    const pidTwo = await waitForStub(pidOne);

    // Each has its own record, and the second run's start left the first alone.
    await vi.waitFor(() => expect(records()).toHaveLength(2));
    expect(isAlive(pidOne)).toBe(true);
    expect(isAlive(pidTwo)).toBe(true);

    first.abort();
    second.abort();
    expect((await one).ok).toBe(false);
    expect((await two).ok).toBe(false);
    expect(records()).toEqual([]);
    const starts = markers().filter((marker) => marker.event === 'fix_route_start');
    expect(new Set(starts.map((marker) => marker.runTag)).size).toBe(2);
  });
});

// --- the router around the run ------------------------------------------------------------------

/** A stand-in run that answers from a list, one per call, and remembers its requests. */
function standIn(answers: Array<RouteRunOutcome | (() => Promise<RouteRunOutcome>)>) {
  const calls: RouteRunRequest[] = [];
  const run: RouteRunner = {
    async run(req) {
      calls.push(req);
      const answer = answers[calls.length - 1] ?? answers.at(-1);
      if (answer === undefined) throw new Error('no answer planned');
      return typeof answer === 'function' ? answer() : answer;
    },
  };
  return { run, calls };
}

const say = (text: string): RouteRunOutcome => ({ ok: true, text });
const fail = (error: string): RouteRunOutcome => ({ ok: false, error });

function routerWith(run: RouteRunner, logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
  return {
    router: new ClaudeNoteRouter({
      config: { logsDir, dataDir, claudeBin, inboxPath },
      runner: run,
      logger,
    }),
    logger,
  };
}

describe('the router', () => {
  it('answers with the route of a good line of JSON, after one run', async () => {
    const stub = standIn([say(GOOD)]);
    const { router } = routerWith(stub.run);

    expect(await router.route(JOB, NOTE)).toEqual(GOOD_ROUTE);
    expect(stub.calls).toHaveLength(1);
  });

  it('sends the index, the note with its time, and the run’s usage line and ids', async () => {
    const stub = standIn([say(GOOD)]);
    await routerWith(stub.run).router.route(JOB, { ...NOTE, atSec: 72.34 });

    const [call] = stub.calls;
    expect(call?.prompt).toContain('# Difficulty index for review notes');
    expect(call?.prompt).toContain('at 1:12.3.');
    expect(call?.prompt).toContain(
      'Note, as a JSON string: "Change the caption font to Heebo Bold"',
    );
    expect(call?.prompt).not.toContain('What the edit added'); // no project.md
    expect(call?.usage).toEqual(fixRouteUsage(JOB));
    expect(call?.usage.tag).toBe('fix-route');
    expect(call?.fields).toEqual({ jobId: 'job-1', noteId: 'n1', attempt: 1 });
  });

  it('quotes the composition from the job’s edit/project.md', async () => {
    mkdirSync(join(inboxPath, 'Acme', 'Demo', 'edit'), { recursive: true });
    writeFileSync(
      join(inboxPath, 'Acme', 'Demo', 'edit', 'project.md'),
      '# Demo\n## Composition\nCaptions at the bottom, one title at 0:02.\n## Check\nOK\n',
    );
    const stub = standIn([say(GOOD)]);
    await routerWith(stub.run).router.route(JOB, NOTE);

    expect(stub.calls[0]?.prompt).toContain(
      '<composition-notes>\n## Composition\nCaptions at the bottom, one title at 0:02.\n</composition-notes>',
    );
  });

  it('puts "About the cut" in the prompt when project.md has lines about the beat, and leaves it out when not (C61)', async () => {
    mkdirSync(join(inboxPath, 'Acme', 'Demo', 'edit'), { recursive: true });
    const project = join(inboxPath, 'Acme', 'Demo', 'edit', 'project.md');
    writeFileSync(
      project,
      '# Demo\n## Round 4\n- The cut is beat-synced at 120 BPM.\n- Captions at the bottom.\n',
    );
    const stub = standIn([say(GOOD), say(GOOD)]);
    const { router } = routerWith(stub.run);
    await router.route(JOB, NOTE);

    expect(stub.calls[0]?.prompt).toContain('## About the cut\n');
    expect(stub.calls[0]?.prompt).toContain(
      '<cut-notes>\n- The cut is beat-synced at 120 BPM.\n</cut-notes>',
    );

    writeFileSync(project, '# Demo\n## Round 4\n- Captions at the bottom.\n');
    await router.route(JOB, NOTE);
    expect(stub.calls[1]?.prompt).not.toContain('## About the cut');
  });

  it('finds the JSON in a code fence or a sentence', async () => {
    const stub = standIn([say(`Sure!\n\`\`\`json\n${GOOD}\n\`\`\``)]);
    expect(await routerWith(stub.run).router.route(JOB, NOTE)).toEqual(GOOD_ROUTE);
  });

  it('asks once more after a bad tier, saying what was wrong', async () => {
    const stub = standIn([say('{"tier":"huge","kind":"Big","why":"it is big"}'), say(GOOD)]);
    const { router, logger } = routerWith(stub.run);

    expect(await router.route(JOB, NOTE)).toEqual(GOOD_ROUTE);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.prompt.startsWith(stub.calls[0]?.prompt ?? '?')).toBe(true);
    expect(stub.calls[1]?.prompt).toContain(
      'Your first answer could not be used: the answer is not a route (tier',
    );
    expect(stub.calls[1]?.fields).toMatchObject({ attempt: 2 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('asks once more after an answer with a field missing', async () => {
    const stub = standIn([say('{"tier":"quick","why":""}'), say(GOOD)]);
    expect(await routerWith(stub.run).router.route(JOB, NOTE)).toEqual(GOOD_ROUTE);
    expect(stub.calls).toHaveLength(2);
  });

  it('asks once more after a run that failed', async () => {
    const stub = standIn([fail('Fix router stopped: it took longer than 20 seconds.'), say(GOOD)]);
    expect(await routerWith(stub.run).router.route(JOB, NOTE)).toEqual(GOOD_ROUTE);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.prompt).toContain('it took longer than 20 seconds.');
  });

  it('answers full when the retry fails too: a failed run twice', async () => {
    const stub = standIn([fail('Fix router stopped: boom'), fail('Fix router stopped: boom')]);
    const { router, logger } = routerWith(stub.run);

    expect(await router.route(JOB, NOTE)).toEqual({
      tier: 'full',
      kind: 'unknown',
      why: "Auto couldn't read it",
    });
    expect(stub.calls).toHaveLength(2); // one retry, not more
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('answers full when the answer is bad twice', async () => {
    const stub = standIn([say('I think it is quick.'), say('{"tier":"nope"}')]);
    expect(await routerWith(stub.run).router.route(JOB, NOTE)).toEqual(UNREADABLE_ROUTE);
    expect(stub.calls).toHaveLength(2);
  });

  it('answers full without a run for a note with no text', async () => {
    const stub = standIn([say(GOOD)]);
    const { router } = routerWith(stub.run);

    expect(await router.route(JOB, { ...NOTE, text: null })).toEqual(UNREADABLE_ROUTE);
    expect(await router.route(JOB, { ...NOTE, text: '  ' })).toEqual(UNREADABLE_ROUTE);
    expect(stub.calls).toHaveLength(0);
  });

  it('rejects, without a retry, when it is aborted during a run', async () => {
    const controller = new AbortController();
    const stub = standIn([
      async () => {
        controller.abort();
        return fail('Fix router stopped: the run was stopped.');
      },
    ]);

    await expect(routerWith(stub.run).router.route(JOB, NOTE, controller.signal)).rejects.toThrow();
    expect(stub.calls).toHaveLength(1);
  });

  it('rejects without a run when it is aborted before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = standIn([say(GOOD)]);

    await expect(routerWith(stub.run).router.route(JOB, NOTE, controller.signal)).rejects.toThrow();
    expect(stub.calls).toHaveLength(0);
  });

  it('passes its signal on to the run', async () => {
    const controller = new AbortController();
    const stub = standIn([say(GOOD)]);
    await routerWith(stub.run).router.route(JOB, NOTE, controller.signal);
    expect(stub.calls[0]?.signal).toBe(controller.signal);
  });

  it('runs the real Haiku process end to end against the stand-in claude', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE(GOOD)] });
    const router = new ClaudeNoteRouter({
      config: { logsDir, dataDir, claudeBin, inboxPath },
      home: join(root, 'home'),
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      killGraceMs: 1_000,
      sampleIntervalMs: 50,
    });

    expect(await router.route(JOB, NOTE)).toEqual(GOOD_ROUTE);
    expect(stubCall().argv).toContain('haiku');
  });
});
