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
import { GRAPHIC_LIMITS, GRAPHIC_MESSAGES, type GraphicStep } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProcesses } from '../pipeline/process-tree.js';
import { readUsageLog } from '../usage/usage-log.js';
import {
  ClaudeGraphicRunner,
  type ClaudeGraphicRunnerOptions,
  GRAPHIC_RUN_STOPPED,
  graphicClaudeArgs,
  graphicLogPath,
  graphicRunRecordsDir,
  graphicRunsDir,
  graphicStepTracker,
  reapGraphicRuns,
} from './claude-graphic.js';
import { GRAPHIC_CHECK_SCRIPT } from './graphic-prompt.js';
import type { GraphicRunRequest } from './graphic-run.js';

// The graphic run end to end against the stand-in `claude` (pipeline/testdata/stub-claude.mjs):
// real processes, pipes and signals, no model. The stub reads its scenario from its working
// directory, which is the graphic's work/ folder.

const STUB = fileURLToPath(new URL('../pipeline/testdata/stub-claude.mjs', import.meta.url));
const ID = 'a1b2c3d4e5f6';

let root: string;
let inbox: string;
let graphicDir: string;
let dataDir: string;
let logsDir: string;
let claudeBin: string;
const leftovers: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-claude-graphic-'));
  inbox = join(root, 'inbox');
  graphicDir = join(inbox, '_Graphics', 'New graphic');
  dataDir = join(root, 'data');
  logsDir = join(dataDir, 'logs');
  claudeBin = join(root, 'bin', 'claude');
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
  mkdirSync(workDir(), { recursive: true });
  mkdirSync(join(graphicDir, 'refs'), { recursive: true });
  mkdirSync(join(graphicDir, 'fonts', 'Hebrew + English', 'Heebo'), { recursive: true });
  writeFileSync(join(graphicDir, 'fonts', 'Hebrew + English', 'Heebo', 'Heebo-Bold.ttf'), 'font');
  // Folders the run must not read: another graphic, a client, the shared fonts.
  mkdirSync(join(inbox, '_Graphics', 'Other graphic'), { recursive: true });
  mkdirSync(join(inbox, 'Kova Coffee', 'Reel 1'), { recursive: true });
  mkdirSync(join(inbox, '_Fonts'), { recursive: true });
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

function workDir(): string {
  return join(graphicDir, 'work');
}

interface Scenario {
  lines?: string[];
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
  writeFiles?: Record<string, string>;
}

function scenario(s: Scenario): void {
  writeFileSync(join(workDir(), 'stub-claude.json'), JSON.stringify(s));
}

function stubCall(): { argv: string[]; env: Record<string, string>; cwd: string; pid: number } {
  return JSON.parse(readFileSync(join(workDir(), 'stub-claude.call.json'), 'utf8'));
}

async function waitForStub(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(workDir(), 'stub-claude.call.json'))) {
      const { pid } = stubCall();
      leftovers.push(pid);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the stub never started');
}

function runner(options: Partial<ClaudeGraphicRunnerOptions> = {}) {
  return new ClaudeGraphicRunner({
    config: { inboxPath: inbox, logsDir, dataDir, claudeBin, model: undefined },
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

function request(
  overrides: Partial<GraphicRunRequest> = {},
): GraphicRunRequest & { steps: GraphicStep[] } {
  const steps: GraphicStep[] = [];
  return {
    graphic: { id: ID, name: 'New graphic', dir: graphicDir },
    message: { id: 'm1', text: 'A lower third for a name', refs: [], effort: 'xhigh' },
    version: 1,
    first: true,
    conversation: [],
    signal: new AbortController().signal,
    onStep: (step) => steps.push(step),
    steps,
    ...overrides,
  };
}

function markers(): Record<string, unknown>[] {
  return readFileSync(graphicLogPath(logsDir, ID), 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => line.startsWith('{"type":"studio_engine"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const INIT_LINE = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' });
const RESULT_LINE = (text: string, isError = false) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result: text });
const TOOL_LINE = (name: string, input: Record<string, unknown>, id = `t-${name}`) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
const ABOUT = JSON.stringify({
  name: 'Name on a white pill',
  kind: 'lower-third',
  lengthSec: 3,
  variables: [{ id: 'name', label: 'Name', default: 'דנה לוי' }],
  when: 'The first time a person is named on camera.',
  reply: 'Made v1. A white pill.',
});

describe('the command', () => {
  it('runs in work/ with the graphic tools, the effort, the deny rules and a scrubbed environment', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('Done.')] });
    await runner().run(request({ message: { id: 'm1', text: 'hi', refs: [], effort: 'high' } }));

    const call = stubCall();
    expect(call.cwd).toBe(realpathSync(workDir()));
    expect(call.argv[0]).toBe('-p');
    expect(call.argv[1]).toMatch(
      /^Make a new graphic for the owner's graphics library: version 1\./,
    );
    expect(call.argv[1]).toContain('- ../fonts/Hebrew + English/Heebo/: Heebo-Bold.ttf');
    expect(call.argv[1]).toContain(GRAPHIC_CHECK_SCRIPT);
    const flags = call.argv.slice(2);
    expect(flags.slice(0, -1)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--effort',
      'high',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--tools',
      'Bash,Read,Write,Edit,Skill',
      '--allowedTools',
      'Bash Read Write Edit Skill',
      '--strict-mcp-config',
      '--settings',
    ]);
    const settings = JSON.parse(flags.at(-1) ?? '{}') as {
      disableAllHooks: boolean;
      permissions: { deny: string[] };
    };
    expect(settings.disableAllHooks).toBe(true);
    const real = realpathSync(inbox);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        `Read(/${real}/_Graphics/Other graphic/**)`,
        `Read(/${real}/Kova Coffee/**)`,
        `Read(/${real}/_Fonts/**)`,
      ]),
    );
    expect(settings.permissions.deny.some((rule) => rule.includes('New graphic'))).toBe(false);
    expect(call.env.STUDIO_ENGINE_RUN).toMatch(new RegExp(`^graphic-${ID}-`));
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('names the model when the config sets one, and runs a change from graphic-change.md', async () => {
    scenario({ lines: [RESULT_LINE('Done.')] });
    await runner({
      config: { inboxPath: inbox, logsDir, dataDir, claudeBin, model: 'opus' },
    }).run(
      request({
        version: 2,
        first: false,
        message: { id: 'm2', text: 'make it dark', refs: [], effort: 'xhigh' },
      }),
    );
    const call = stubCall();
    expect(call.argv.slice(2, 7)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'opus',
    ]);
    expect(call.argv[1]).toMatch(
      /^Change a graphic in the owner's graphics library: make version 2\./,
    );
    expect(graphicClaudeArgs({ prompt: 'x', effort: 'medium' })).not.toContain('--model');
  });
});

describe('the steps', () => {
  it('moves to 1 at the first write under compositions/ and to 2 at the first check after it', async () => {
    const graphic = join(workDir(), 'compositions', `lib-${ID}.html`);
    scenario({
      lines: [
        INIT_LINE,
        TOOL_LINE('Bash', { command: 'npx hyperframes lint' }, 't0'),
        TOOL_LINE('Read', { file_path: join(workDir(), 'about.json') }, 't1'),
        TOOL_LINE('Write', { file_path: join(workDir(), 'about.json'), content: '{}' }, 't2'),
        TOOL_LINE('Write', { file_path: graphic, content: '<html>' }, 't3'),
        TOOL_LINE('Edit', { file_path: graphic, old_string: 'a', new_string: 'b' }, 't4'),
        TOOL_LINE('Bash', { command: 'cp ../fonts/Heebo-Bold.ttf lib/x/fonts/' }, 't5'),
        TOOL_LINE('Bash', { command: `node "${GRAPHIC_CHECK_SCRIPT}" ${ID} 3 --at 1.5,2.8` }, 't6'),
        TOOL_LINE('Bash', { command: 'npx hyperframes snapshot /tmp/x' }, 't7'),
        RESULT_LINE('Done.'),
      ],
    });
    const req = request();
    expect(await runner().run(req)).toEqual({ ok: true });
    expect(req.steps).toEqual([1, 2]);
    expect(markers().at(-1)).toMatchObject({ event: 'graphic_end', step: 2 });
  });

  it('knows the check by its command', () => {
    const steps: GraphicStep[] = [];
    const tracker = graphicStepTracker((step) => steps.push(step));
    const tool = (name: string, input: Record<string, unknown>) =>
      tracker.onEvent({ kind: 'tool_use', raw: {}, parentToolUseId: null, id: 'x', name, input });
    tool('Edit', { file_path: 'compositions/lib-x.html' });
    tool('Bash', { command: 'ls compositions' });
    expect(steps).toEqual([1]);
    tool('Bash', { command: 'npx --yes hyperframes check' });
    expect(steps).toEqual([1, 2]);
    expect(tracker.step).toBe(2);
  });
});

describe('how it ends', () => {
  it('succeeds on exit 0 and frames the stream with graphic_start and graphic_end', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('Done.')] });
    expect(await runner().run(request())).toEqual({ ok: true });
    const [start, end] = markers();
    expect(start).toMatchObject({
      event: 'graphic_start',
      run: 'graphic',
      graphicId: ID,
      messageId: 'm1',
      version: 1,
      effort: 'xhigh',
      timeoutMs: GRAPHIC_LIMITS.runTimeoutMs,
    });
    expect(end).toMatchObject({
      event: 'graphic_end',
      run: 'graphic',
      outcome: 'succeeded',
      exitCode: 0,
      sessionId: 's-1',
    });
    // The record is gone once the run is.
    expect(readdirSync(graphicRunRecordsDir(dataDir, ID))).toEqual([]);
  });

  it('fails with the Blocked: sentence', async () => {
    scenario({
      lines: [
        INIT_LINE,
        RESULT_LINE('I made what I could.\n\nBlocked: There is no font with Hebrew letters.'),
      ],
    });
    expect(await runner().run(request())).toEqual({
      ok: false,
      error: 'There is no font with Hebrew letters.',
    });
    expect(markers().at(-1)).toMatchObject({ outcome: 'failed' });
  });

  it('fails when the run ends in an error, or exits with one', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('The model is overloaded', true)] });
    expect(await runner().run(request())).toEqual({ ok: false, error: 'The model is overloaded' });

    scenario({ lines: [INIT_LINE], stderr: 'boom', exitCode: 1 });
    const outcome = await runner().run(request());
    expect(outcome.ok).toBe(false);
  });

  it('fails with a line to act on when Claude Code is not there', async () => {
    const outcome = await runner({
      config: {
        inboxPath: inbox,
        logsDir,
        dataDir,
        claudeBin: join(root, 'none'),
        model: undefined,
      },
      env: { PATH: '' },
    }).run(request());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/Claude Code (was not found|at )/);
  });
});

describe('the usage', () => {
  it('logs a first version under graphic with the name the run gave it', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('Done.')], writeFiles: { 'about.json': ABOUT } });
    await runner().run(request());
    const entries = await readUsageLog(dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'app',
      tag: 'graphic',
      did: 'Made v1 of Name on a white pill',
      session: 's-1',
    });
  });

  it('logs a change with the graphic’s name, whatever about.json says', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('Done.')], writeFiles: { 'about.json': ABOUT } });
    await runner().run(
      request({
        graphic: { id: ID, name: 'Follow card', dir: graphicDir },
        version: 3,
        first: false,
      }),
    );
    expect((await readUsageLog(dataDir))[0]).toMatchObject({
      tag: 'graphic',
      did: 'Made v3 of Follow card',
    });
  });
});

describe('stopping', () => {
  it('stops the run and its process tree on Stop', async () => {
    scenario({ lines: [INIT_LINE], hang: true });
    const controller = new AbortController();
    const running = runner().run(request({ signal: controller.signal }));
    const pid = await waitForStub();
    controller.abort();

    expect(await running).toEqual({ ok: false, error: GRAPHIC_RUN_STOPPED });
    expect((await listProcesses()).some((entry) => entry.pid === pid)).toBe(false);
    expect(markers().at(-1)).toMatchObject({ event: 'graphic_end', outcome: 'cancelled' });
  });

  it('does not start when it is stopped already', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runner().run(request({ signal: controller.signal }))).toEqual({
      ok: false,
      error: GRAPHIC_RUN_STOPPED,
    });
    expect(existsSync(join(workDir(), 'stub-claude.call.json'))).toBe(false);
  });

  it('stops a run that takes too long', async () => {
    scenario({ hang: true });
    const outcome = await runner({ timeoutMs: 400 }).run(request());
    const pid = stubCall().pid;
    leftovers.push(pid);

    expect(outcome).toEqual({ ok: false, error: GRAPHIC_MESSAGES.timedOut });
    expect(markers().at(-1)).toMatchObject({ outcome: 'timed_out' });
    expect((await listProcesses()).some((entry) => entry.pid === pid)).toBe(false);
  });
});

describe('the run records', () => {
  it('keeps one folder per graphic, and the boot reap empties them all', async () => {
    const records = graphicRunRecordsDir(dataDir, 'ffffffffffff');
    mkdirSync(records, { recursive: true });
    writeFileSync(
      join(records, 'graphic-ffffffffffff.json'),
      JSON.stringify({ jobId: 'graphic-ffffffffffff', pid: 999_999, identity: 'gone' }),
    );
    expect(await reapGraphicRuns(dataDir, { graceMs: 100 })).toEqual([]);
    expect(existsSync(records)).toBe(false);
    expect(existsSync(graphicRunsDir(dataDir))).toBe(true);
    expect(await reapGraphicRuns(join(root, 'no-data'))).toEqual([]);
  });
});
