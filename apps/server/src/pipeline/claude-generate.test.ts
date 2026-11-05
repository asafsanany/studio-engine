import { execFile } from 'node:child_process';
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
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Brief, Job } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENERATE_ASSETS } from '../generate/generate-assets.js';
import { readUsageLog } from '../usage/usage-log.js';
import {
  ClaudeGenerateWriter,
  type ClaudeGenerateWriterOptions,
  GENERATE_MARKER_FIELDS,
  GENERATE_TIMED_OUT,
  GENERATE_TIMEOUT_MS,
} from './claude-generate.js';
import { fakeBriefDraft } from './fake-brief.js';
import type { GenerateWrite } from './generate-step.js';
import { jobLogPath } from './job-log.js';
import { listProcesses } from './process-tree.js';

// The Claude Generate run end to end against the stand-in `claude` (testdata/stub-claude.mjs): real
// processes, pipes and signals, no model, no service. The stub reads its scenario from the job
// folder and records the arguments and the environment it was started with.

const STUB = fileURLToPath(new URL('./testdata/stub-claude.mjs', import.meta.url));

let root: string;
let inboxPath: string;
let logsDir: string;
let dataDir: string;
let claudeBin: string;
let envFile: string;
const leftovers: number[] = [];

// Never real: a made-up key that must not turn up anywhere, in the pattern of a Higgsfield key.
const HIGGSFIELD_KEY = 'hf-test-0000-aaaa:zzzz-secret-value-9999';
const ELEVENLABS_KEY = 'sk_test_never_passed_0123456789';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-generate-claude-'));
  inboxPath = join(root, 'inbox');
  logsDir = join(root, 'data', 'logs');
  dataDir = join(root, 'data');
  claudeBin = join(root, 'bin', 'claude');
  envFile = join(root, 'repo', '.env');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'repo'), { recursive: true });
  writeFileSync(envFile, `HIGGSFIELD_API_KEY=${HIGGSFIELD_KEY}\n`);
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
  mkdirSync(jobDir(), { recursive: true });
});

afterEach(async () => {
  const noted = leftovers.splice(0);
  const stubs = await stubPids();
  const alive = await running([...stubs, ...noted]);
  for (const pid of [...stubs, ...noted]) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // gone, as it should be
      }
    }
  }
  rmSync(root, { recursive: true, force: true });
  expect(alive, 'a process of the run was still running when the test ended').toEqual([]);
});

const execFileAsync = promisify(execFile);

async function stubPids(): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,command='], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const mine = `${basename(root)}/bin/claude`;
  return stdout
    .split('\n')
    .filter((line) => line.includes(mine))
    .map((line) => Number.parseInt(line.trim(), 10));
}

async function running(pids: number[]): Promise<number[]> {
  const table = await listProcesses();
  return table.filter((proc) => pids.includes(proc.pid)).map((proc) => proc.pid);
}

const JOB_ID = 'b4c1a0deb4c1';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    clientId: '853479772be4',
    client: 'Pinewood',
    name: 'Window Ad',
    relPath: 'Pinewood/Window Ad',
    state: 'editing',
    step: 1,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 0, audio: 0, image: 0, doc: 1 },
    sizeBytes: 1,
    addedAt: '2026-10-25T10:00:00.000Z',
    lastChangeAt: '2026-10-25T10:00:00.000Z',
    settledAt: '2026-10-25T10:01:00.000Z',
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
    updatedAt: '2026-10-25T10:01:00.000Z',
    output: null,
    note: null,
    ...overrides,
  };
}

function jobDir(): string {
  return join(inboxPath, 'Pinewood', 'Window Ad');
}

function makeBrief(): Brief {
  return {
    schema: 1,
    fingerprint: 'f',
    ...fakeBriefDraft(makeJob(), [], null),
    production: 'generate',
    voiceover: {
      lines: [{ id: 'L1', text: 'Do you know what is in your windows?', direction: null }],
    },
    formats: ['1080x1920', '1080x1080'],
  };
}

function write(
  controller = new AbortController(),
  extra: Partial<GenerateWrite> = {},
): GenerateWrite & { chars: number[] } {
  const chars: number[] = [];
  return {
    jobDir: jobDir(),
    editDir: join(jobDir(), 'edit'),
    brief: makeBrief(),
    budgetUsd: 3,
    spentUsd: 0,
    existing: '',
    signal: controller.signal,
    addVoiceChars: (n) => chars.push(n),
    chars,
    ...extra,
  };
}

interface Scenario {
  lines?: string[];
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
  delayMs?: number;
}

function scenario(s: Scenario): void {
  writeFileSync(join(jobDir(), 'stub-claude.json'), JSON.stringify(s));
}

interface StubCall {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  pid: number;
}

function stubCall(): StubCall {
  return JSON.parse(readFileSync(join(jobDir(), 'stub-claude.call.json'), 'utf8'));
}

async function waitForStub(): Promise<StubCall> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(jobDir(), 'stub-claude.call.json'))) {
      const call = stubCall();
      leftovers.push(call.pid);
      return call;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the stub never started');
}

function writer(options: Partial<ClaudeGenerateWriterOptions> = {}) {
  return new ClaudeGenerateWriter({
    config: {
      logsDir,
      dataDir,
      claudeBin,
      model: 'sonnet',
      generateVoiceId: '68RUZBDjLe2YBQvv8zFx',
    },
    inboxPath,
    home: join(root, 'home'),
    envFile,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HIGGSFIELD_API_KEY: HIGGSFIELD_KEY,
      ELEVENLABS_API_KEY: ELEVENLABS_KEY,
      ANTHROPIC_API_KEY: 'sk-ant-test-never-passed',
    },
    killGraceMs: 1_000,
    sampleIntervalMs: 50,
    ...options,
  });
}

function markers(): Record<string, unknown>[] {
  return readFileSync(jobLogPath(logsDir, JOB_ID), 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => line.startsWith('{"type":"studio_engine"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const RESULT_LINE = (text: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });

const toolUse = (id: string, command: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  });

const toolResult = (id: string, text: string) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }],
    },
  });

const VOICE = `node "${GENERATE_ASSETS.voice}" line "/x/edit" --id L1 --text 'x'`;
const SHOTS = `node "${GENERATE_ASSETS.shots}" clip "/x/edit" A --tier easy`;

describe('the command', () => {
  it('runs claude in the job folder at the edit model, with the Generate tools and permissions', async () => {
    scenario({});

    const outcome = await writer().write(makeJob(), write());

    expect(outcome).toEqual({ ok: true, refusal: null });
    const call = stubCall();
    expect(call.cwd).toBe(realpathSync(jobDir()));
    expect(call.argv[0]).toBe('-p');
    const flags = call.argv.slice(2);
    expect(flags.slice(0, 3)).toEqual(['--output-format', 'stream-json', '--verbose']);
    expect(flags).toContain('--model');
    expect(flags[flags.indexOf('--model') + 1]).toBe('sonnet');
    // Default effort is Extra high, like the edit run.
    expect(flags[flags.indexOf('--effort') + 1]).toBe('xhigh');
    expect(flags[flags.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Write,Bash,ToolSearch');
    const allowed = flags[flags.indexOf('--allowedTools') + 1] ?? '';
    expect(allowed).toContain('Edit(./edit/**)');
    // The pictures and clips come through the Higgsfield connector on the plan (U26).
    expect(allowed).toContain('mcp__claude_ai_Higgsfield__generate_video');
    expect(allowed).toContain('ToolSearch');
    expect(allowed).toContain(`Bash(node ${GENERATE_ASSETS.voice} *)`);
    expect(allowed).toContain(`Bash(node "${GENERATE_ASSETS.shots}" *)`);
    expect(allowed).toContain('Bash(ffmpeg *)');
    expect(allowed).not.toMatch(/Bash\(\*\)|Bash\(rm|Bash\(curl|Bash\(cp/);
    // Strict mode would hide the connector.
    expect(flags).not.toContain('--strict-mcp-config');
    const settings = JSON.parse(flags[flags.indexOf('--settings') + 1] ?? '{}');
    expect(settings.disableAllHooks).toBe(true);
    // Neither key file may be opened by the run.
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        `Read(/${envFile})`,
        `Read(/${join(root, 'home', 'Developer', 'video-use', '.env')})`,
      ]),
    );
  });

  it('uses the job’s own effort', async () => {
    scenario({});
    await writer().write(makeJob({ effort: 'medium' }), write());
    const flags = stubCall().argv.slice(2);
    expect(flags[flags.indexOf('--effort') + 1]).toBe('medium');
  });

  it('gives the run the PATH of the env file and the voice, and never a key', async () => {
    scenario({});

    await writer().write(makeJob(), write());

    const { env } = stubCall();
    expect(env.STUDIO_ENV_FILE).toBe(envFile);
    expect(env.STUDIO_GENERATE_VOICE_ID).toBe('68RUZBDjLe2YBQvv8zFx');
    // A clip is waited for up to about nine minutes: Bash gets its ten.
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('600000');
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('600000');
    expect(env.STUDIO_GENERATE_FAKE).toBeUndefined();
    const all = JSON.stringify(env);
    for (const secret of [
      HIGGSFIELD_KEY,
      ELEVENLABS_KEY,
      'sk-ant-test-never-passed',
      'secret-value',
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(Object.keys(env)).not.toContain('HIGGSFIELD_API_KEY');
    expect(Object.keys(env)).not.toContain('ELEVENLABS_API_KEY');
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('lets a test turn on the scripts’ fake path', async () => {
    scenario({});
    await writer({ fake: true }).write(makeJob(), write());
    expect(stubCall().env.STUDIO_GENERATE_FAKE).toBe('1');
  });

  it('puts the scripts, the budget, the folder and what exists in the prompt', async () => {
    scenario({});

    await writer().write(
      makeJob(),
      write(undefined, { existing: 'An earlier try made L1.', spentUsd: 1.65, budgetUsd: 3 }),
    );

    const prompt = stubCall().argv[1] ?? '';
    expect(prompt).toMatch(/^Make the footage for this video\./);
    expect(prompt).toContain('Job: client "Pinewood", job "Window Ad".');
    expect(prompt).toContain(`node "${GENERATE_ASSETS.voice}" line "${join(jobDir(), 'edit')}"`);
    expect(prompt).toContain(GENERATE_ASSETS.shots);
    expect(prompt).toContain('An earlier try made L1.');
    expect(prompt).toContain('$3');
    expect(prompt).toContain('$1.65 is spent, $1.35 (about 24 credits) is left');
    expect(prompt).toContain('9:16 and 1:1');
    expect(prompt).not.toContain('{{');
  });
});

describe('the log', () => {
  it('writes generate_start and generate_end markers that carry run:generate and are not start/end', async () => {
    scenario({ lines: [RESULT_LINE('Done.')] });

    await writer().write(makeJob(), write());

    const all = markers();
    const start = all.find((marker) => marker.event === 'generate_start');
    expect(start).toMatchObject({ ...GENERATE_MARKER_FIELDS, model: 'sonnet', effort: 'xhigh' });
    expect(start?.timeoutMs).toBe(GENERATE_TIMEOUT_MS);
    expect(all.at(-1)).toMatchObject({
      event: 'generate_end',
      outcome: 'succeeded',
      run: 'generate',
    });
    // A retry's look at the last edit run never finds the Generate run.
    expect(all.some((marker) => marker.event === 'start' || marker.event === 'end')).toBe(false);
  });

  it('never holds a key, nor the word Authorization, however the run goes', async () => {
    // A stream like a real run's: script calls, their answers, and a final line.
    scenario({
      lines: [
        toolUse('t1', VOICE),
        toolResult(
          't1',
          '{"ok":true,"command":"line","id":"L1","take":1,"file":"voice/L1-take1.mp3","durationSec":3,"chars":38,"characters":38}',
        ),
        toolUse('t2', SHOTS),
        toolResult(
          't2',
          '{"ok":false,"code":"balance_empty","message":"Higgsfield balance is empty: add funds in the Higgsfield console, then Retry (clips already made are kept)."}',
        ),
        RESULT_LINE('Blocked: Higgsfield balance is empty.'),
      ],
    });

    await writer().write(makeJob(), write());

    const log = readFileSync(jobLogPath(logsDir, JOB_ID), 'utf8');
    for (const secret of [HIGGSFIELD_KEY, ELEVENLABS_KEY, 'secret-value', 'sk-ant-test']) {
      expect(log).not.toContain(secret);
    }
    expect(log).not.toMatch(/authorization/i);
    // What the log does hold about the env file is its name, not what is in it.
    expect(log).toContain('"envFile":".env"');
  });
});

describe('the usage log', () => {
  it('logs the run under the generate tag with its session and the job', async () => {
    scenario({
      lines: ['{"type":"system","subtype":"init","session_id":"s-gen-1"}', RESULT_LINE('Done.')],
    });
    const job = makeJob();

    await writer().write(job, write());

    expect(await readUsageLog(dataDir)).toEqual([
      expect.objectContaining({
        source: 'app',
        tag: 'generate',
        did: 'Planned and made the shots for Pinewood / Window Ad',
        session: 's-gen-1',
        client: 'Pinewood',
        job: { id: job.id, name: 'Window Ad' },
      }),
    ]);
  });
});

describe('what it reads from the stream', () => {
  it('counts the ElevenLabs characters the voice and the effects used', async () => {
    scenario({
      lines: [
        toolUse('t1', VOICE),
        toolResult(
          't1',
          '{"ok":true,"command":"line","id":"L1","take":1,"file":"voice/L1-take1.mp3","durationSec":3,"chars":38,"characters":38}',
        ),
        toolUse('t2', `node "${GENERATE_ASSETS.voice}" sfx "/x/edit" --id alert --prompt 'x'`),
        toolResult(
          't2',
          '{"ok":true,"command":"sfx","name":"alert","file":"sfx/alert.mp3","durationSec":1,"characters":10}',
        ),
        toolUse(
          't3',
          `node "${GENERATE_ASSETS.voice}" check "/x/edit" --file voice/L1-take1.mp3 --text 'x'`,
        ),
        toolResult(
          't3',
          '{"ok":true,"command":"check","id":"L1","take":1,"file":"voice/L1-take1.mp3","match":true,"missing":[],"extra":[],"heard":"x","words":[]}',
        ),
        RESULT_LINE('Done.'),
      ],
    });
    const request = write();

    await writer().write(makeJob(), request);

    expect(request.chars).toEqual([38, 10]);
  });

  it('ignores answers of commands that are not the two scripts', async () => {
    scenario({
      lines: [
        toolUse('t1', 'ffprobe -v error x.mp4'),
        toolResult(
          't1',
          '{"ok":true,"command":"line","id":"L1","take":1,"file":"x","durationSec":1,"chars":9999}',
        ),
        RESULT_LINE('Done.'),
      ],
    });
    const request = write();
    await writer().write(makeJob(), request);
    expect(request.chars).toEqual([]);
  });

  it('remembers the refusal that still stands and gives it with a "Blocked:" run', async () => {
    scenario({
      lines: [
        toolUse('t1', SHOTS),
        toolResult(
          't1',
          '{"ok":false,"code":"balance_empty","message":"Higgsfield balance is empty: add funds in the Higgsfield console, then Retry (clips already made are kept)."}',
        ),
        RESULT_LINE('The account has no money.\n\nBlocked: no credit left at Higgsfield.'),
      ],
    });

    const outcome = await writer().write(makeJob(), write());

    expect(outcome).toMatchObject({
      ok: false,
      blocked: 'no credit left at Higgsfield.',
      refusal: { code: 'balance_empty', service: 'higgsfield' },
    });
    expect(markers().at(-1)).toMatchObject({
      event: 'generate_end',
      outcome: 'failed',
      refusal: 'balance_empty',
    });
  });

  it('forgets a refusal when a later call of the same service worked, and a pending clip is neither', async () => {
    scenario({
      lines: [
        toolUse('t1', SHOTS),
        toolResult(
          't1',
          '{"ok":false,"code":"unavailable","message":"Higgsfield is not answering right now: wait a few minutes, then Retry (what was already made is kept)."}',
        ),
        toolUse('t2', SHOTS),
        toolResult(
          't2',
          '{"ok":false,"code":"pending","message":"still being made","requestId":"r1"}',
        ),
        toolUse('t3', SHOTS),
        toolResult(
          't3',
          '{"ok":true,"command":"clip","id":"A","take":1,"file":"clips/A/take-1.mp4","seconds":5,"usd":0.105,"requestId":"r1"}',
        ),
        RESULT_LINE('Done.'),
      ],
    });

    const outcome = await writer().write(makeJob(), write());

    expect(outcome).toEqual({ ok: true, refusal: null });
  });

  it('keeps a refusal of each service apart', async () => {
    scenario({
      lines: [
        toolUse('t1', VOICE),
        toolResult(
          't1',
          '{"ok":false,"code":"key_rejected","message":"ElevenLabs key not accepted: check ELEVENLABS_API_KEY in ~/Developer/video-use/.env"}',
        ),
        toolUse('t2', SHOTS),
        toolResult(
          't2',
          '{"ok":true,"command":"clip","id":"A","take":1,"file":"clips/A/take-1.mp4","seconds":5,"usd":0.105,"requestId":"r1"}',
        ),
        RESULT_LINE('Done.'),
      ],
    });

    const outcome = await writer().write(makeJob(), write());

    expect(outcome).toEqual({
      ok: true,
      refusal: { code: 'key_rejected', service: 'elevenlabs' },
    });
  });
});

// A run that waits quietly for a clip needs real waiting time: give the file room when a busy full run slows it (C69).
describe('how it ends', { timeout: 60_000 }, () => {
  it('turns a final "Blocked:" line into the blocker', async () => {
    scenario({
      lines: [RESULT_LINE('I made what I could.\n\nBlocked: the logo file is missing.')],
    });

    const outcome = await writer().write(makeJob(), write());

    expect(outcome).toEqual({
      ok: false,
      error: 'Generate stopped: the logo file is missing.',
      blocked: 'the logo file is missing.',
      refusal: null,
    });
  });

  it('explains a failed process the way the edit run does', async () => {
    scenario({
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

    const outcome = await writer().write(makeJob(), write());

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(/^Generate stopped: /);
    expect(markers().at(-1)).toMatchObject({ event: 'generate_end', outcome: 'failed' });
  });

  it('does not time a silence: a run that waits quietly for a clip still ends well', async () => {
    // Nothing printed for most of a second, like a Wan clip being waited for; only the wall clock limits a run.
    scenario({ delayMs: 900, lines: [RESULT_LINE('Done.')] });

    const outcome = await writer({ sampleIntervalMs: 20 }).write(makeJob(), write());

    expect(outcome).toEqual({ ok: true, refusal: null });
    expect(GENERATE_TIMEOUT_MS).toBe(4 * 60 * 60_000);
  });

  it('stops a run that takes longer than its wall clock, and fails it with the time limit', async () => {
    scenario({ hang: true });
    const startedAt = Date.now();

    const outcome = await writer({ timeoutMs: 400 }).write(makeJob(), write());
    const pid = stubCall().pid;

    expect(outcome).toEqual({ ok: false, error: GENERATE_TIMED_OUT, refusal: null });
    expect(GENERATE_TIMED_OUT).toBe('Generate stopped: the run took longer than 4 hours.');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect((await listProcesses()).some((proc) => proc.pid === pid)).toBe(false);
    expect(markers().at(-1)).toMatchObject({ event: 'generate_end', outcome: 'timed_out' });
  });

  it('is cancelled through the abort signal: the process is stopped before it resolves', async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const writing = writer().write(makeJob(), write(controller));
    const { pid } = await waitForStub();

    controller.abort('cancel');
    const outcome = await writing;

    expect(outcome.ok).toBe(false);
    expect((await listProcesses()).some((proc) => proc.pid === pid)).toBe(false);
    expect(markers().at(-1)).toMatchObject({ event: 'generate_end', outcome: 'cancelled' });
  });

  it('records a shutdown as stopped, not cancelled', async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const writing = writer().write(makeJob(), write(controller));
    await waitForStub();
    controller.abort('shutdown');
    await writing;
    expect(markers().at(-1)).toMatchObject({ event: 'generate_end', outcome: 'stopped' });
  });

  it('fails clearly when claude cannot be found', async () => {
    const outcome = await writer({
      config: {
        logsDir,
        dataDir,
        claudeBin: join(root, 'no-such-claude'),
        model: 'sonnet',
        generateVoiceId: '68RUZBDjLe2YBQvv8zFx',
      },
    }).write(makeJob(), write());
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(
      /^Generate stopped: Claude Code was not found/,
    );
  });
});
