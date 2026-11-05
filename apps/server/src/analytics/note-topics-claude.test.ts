import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProcesses } from '../pipeline/process-tree.js';
import { noteTopicsUsage } from '../usage/app-usage.js';
import { readUsageLog } from '../usage/usage-log.js';
import {
  ClaudeNoteTopicRunner,
  type ClaudeNoteTopicRunnerOptions,
  NOTE_TOPICS_MODEL,
  noteTopicsClaudeArgs,
  noteTopicsLogPath,
  noteTopicsWorkDir,
} from './note-topics-claude.js';
import type { NoteTopicRunRequest } from './note-topics-run.js';

// The Claude run of the topic pass end to end against the stand-in `claude`
// (pipeline/testdata/stub-claude.mjs): real processes, pipes and signals, no model. The stub reads
// its scenario from its working directory, which here is <dataDir>/note-topics-runs.

const STUB = fileURLToPath(new URL('../pipeline/testdata/stub-claude.mjs', import.meta.url));

let root: string;
let dataDir: string;
let logsDir: string;
let claudeBin: string;
const leftovers: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-note-topics-claude-'));
  dataDir = join(root, 'data');
  logsDir = join(dataDir, 'logs');
  claudeBin = join(root, 'bin', 'claude');
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
  mkdirSync(runsDir(), { recursive: true });
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

/** The run's working folder: where the stub finds its scenario and leaves its call. */
function runsDir(): string {
  return noteTopicsWorkDir(dataDir);
}

interface Scenario {
  lines?: string[];
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
}

function scenario(s: Scenario): void {
  writeFileSync(join(runsDir(), 'stub-claude.json'), JSON.stringify(s));
}

function stubCall(): { argv: string[]; env: Record<string, string>; cwd: string; pid: number } {
  return JSON.parse(readFileSync(join(runsDir(), 'stub-claude.call.json'), 'utf8'));
}

async function waitForStub(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(runsDir(), 'stub-claude.call.json'))) {
      const { pid } = stubCall();
      leftovers.push(pid);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the stub never started');
}

function runner(options: Partial<ClaudeNoteTopicRunnerOptions> = {}) {
  return new ClaudeNoteTopicRunner({
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

function request(controller = new AbortController()): NoteTopicRunRequest {
  return {
    prompt: 'Give each review note a short topic.\n{"id":"n1"}',
    usage: noteTopicsUsage(1),
    signal: controller.signal,
  };
}

function markers(): Record<string, unknown>[] {
  return readFileSync(noteTopicsLogPath(logsDir), 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => line.startsWith('{"type":"studio_engine"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const RESULT_LINE = (text: string, isError = false) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result: text });
const INIT_LINE = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' });

describe('the command', () => {
  it('runs Sonnet with no tools at all, in its own folder, with a scrubbed environment', async () => {
    scenario({ lines: [RESULT_LINE('[]')] });
    await runner().run(request());

    const call = stubCall();
    expect(call.cwd).toBe(realpathSync(runsDir()));
    expect(call.argv[0]).toBe('-p');
    expect(call.argv[1]).toBe('Give each review note a short topic.\n{"id":"n1"}');
    expect(call.argv.slice(2)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
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
    expect(NOTE_TOPICS_MODEL).toBe('sonnet');
    expect(noteTopicsClaudeArgs('x').slice(2)).toEqual(call.argv.slice(2));
    expect(call.env.STUDIO_ENGINE_RUN).toMatch(/^note-topics-/);
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('the answer', () => {
  it('is the text the run ended with', async () => {
    scenario({
      lines: [INIT_LINE, RESULT_LINE('[{"id":"n1","topic":"intro too long"}]')],
    });
    expect(await runner().run(request())).toEqual({
      ok: true,
      text: '[{"id":"n1","topic":"intro too long"}]',
    });
  });

  it('is a failure when the run exits with an error, an error result or no result', async () => {
    scenario({ lines: [RESULT_LINE('Credit balance is too low', true)], exitCode: 1 });
    const failed = await runner().run(request());
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toMatch(/^Note topics stopped: /);

    scenario({ lines: [RESULT_LINE('The model is overloaded', true)], exitCode: 0 });
    expect(await runner().run(request())).toEqual({
      ok: false,
      error: 'Note topics stopped: The model is overloaded',
    });

    scenario({ lines: [], exitCode: 0 });
    expect(await runner().run(request())).toEqual({
      ok: false,
      error: 'Note topics stopped: Claude finished without an answer.',
    });
  });

  it('fails with a line to act on when Claude Code is not there', async () => {
    const outcome = await runner({
      config: { logsDir, dataDir, claudeBin: join(root, 'no-such-claude') },
      env: { PATH: '' },
    }).run(request());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(
      /^Note topics stopped: Claude Code (was not found|at )/,
    );
  });
});

describe('the log and the usage', () => {
  it('frames the stream with note_topics_start and note_topics_end in logs/note-topics.log', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('[]')] });
    await runner().run(request());

    const [start, end] = markers();
    expect(start).toMatchObject({
      event: 'note_topics_start',
      run: 'note-topics',
      model: 'sonnet',
      prompt: 'Give each review note a short topic.\n{"id":"n1"}',
    });
    expect(end).toMatchObject({
      event: 'note_topics_end',
      run: 'note-topics',
      outcome: 'succeeded',
      exitCode: 0,
      sessionId: 's-1',
    });
    expect(readFileSync(noteTopicsLogPath(logsDir), 'utf8')).toContain('"session_id":"s-1"');
  });

  it('logs the run in usage.jsonl under note-topics once it has a session', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('[]')] });
    await runner().run(request());

    const entries = await readUsageLog(dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'app',
      tag: 'note-topics',
      did: 'Grouped 1 review note into topics',
      session: 's-1',
    });
    expect(entries[0]?.client).toBeUndefined();
    expect(entries[0]?.job).toBeUndefined();
  });

  it('records a failed run too', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('nope', true)], exitCode: 1 });
    await runner().run(request());
    expect(markers().at(-1)).toMatchObject({ event: 'note_topics_end', outcome: 'failed' });
  });
});

describe('stopping', () => {
  it('stops the run and its process tree when the engine shuts down', async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const running = runner().run(request(controller));
    const pid = await waitForStub();
    controller.abort();

    expect(await running).toEqual({
      ok: false,
      error: 'Note topics stopped: the run was stopped.',
    });
    expect((await listProcesses()).some((entry) => entry.pid === pid)).toBe(false);
  });

  it('does not start when it is stopped already', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await runner().run(request(controller))).ok).toBe(false);
    expect(existsSync(join(runsDir(), 'stub-claude.call.json'))).toBe(false);
  });

  it('stops a run that takes too long', async () => {
    scenario({ hang: true });
    const outcome = await runner({ timeoutMs: 400 }).run(request());
    const pid = stubCall().pid;
    leftovers.push(pid);

    expect(outcome).toEqual({
      ok: false,
      error: 'Note topics stopped: it took longer than 5 minutes.',
    });
    expect(markers().at(-1)).toMatchObject({ outcome: 'timed_out' });
    expect((await listProcesses()).some((entry) => entry.pid === pid)).toBe(false);
  });
});
