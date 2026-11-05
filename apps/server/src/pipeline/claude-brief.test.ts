import { execFile } from 'node:child_process';
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
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { briefPromptSchema, briefSchema, type Job, noInstructionsBrief } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurationCache } from '../inbox/probe.js';
import type { JobFile } from '../inbox/scan.js';
import { BriefStep, type BriefWrite } from './brief-step.js';
import {
  BRIEF_TIMED_OUT,
  ClaudeBriefWriter,
  type ClaudeBriefWriterOptions,
} from './claude-brief.js';
import { jobLogPath, readLastEnd } from './job-log.js';
import { listProcesses } from './process-tree.js';

// The Claude Brief run end to end against the stand-in `claude` (testdata/stub-claude.mjs): real
// processes, pipes and signals, no model. The stub reads its scenario from the job folder.

const STUB = fileURLToPath(new URL('./testdata/stub-claude.mjs', import.meta.url));

let root: string;
let inboxPath: string;
let logsDir: string;
let dataDir: string;
let claudeBin: string;
const leftovers: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-brief-'));
  inboxPath = join(root, 'inbox');
  logsDir = join(root, 'data', 'logs');
  dataDir = join(root, 'data');
  claudeBin = join(root, 'bin', 'claude');
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
  mkdirSync(jobDir(), { recursive: true });
});

afterEach(async () => {
  // A Brief run must not outlive its write(): whatever of it is still running now is a leak. It is
  // stopped here, so that a failing test cannot leave a stub behind, and then reported.
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

/** The stubs this test started and that are still running: each runs `<root>/bin/claude`. */
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

function makeJob(note: string | null = null): Job {
  return {
    id: JOB_ID,
    clientId: '853479772be4',
    client: 'Acme Studio',
    name: 'Launch teaser',
    relPath: 'Acme Studio/Launch teaser',
    state: 'editing',
    step: 1,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 1, audio: 0, image: 0, doc: 1 },
    sizeBytes: 1,
    addedAt: '2026-10-21T10:00:00.000Z',
    lastChangeAt: '2026-10-21T10:00:00.000Z',
    settledAt: '2026-10-21T10:01:00.000Z',
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
    updatedAt: '2026-10-21T10:01:00.000Z',
    output: null,
    note,
  };
}

function jobDir(): string {
  return join(inboxPath, 'Acme Studio', 'Launch teaser');
}

interface Scenario {
  lines?: string[];
  stderr?: string;
  writeFiles?: Record<string, string>;
  exitCode?: number;
  hang?: boolean;
  ignoreTerm?: boolean;
  grandchild?: boolean | 'stubborn';
}

function scenario(s: Scenario): void {
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
  return JSON.parse(readFileSync(join(jobDir(), 'stub-claude.call.json'), 'utf8'));
}

/** Waits until the stub is running, and notes its pids so that the test cannot leave them behind. */
async function waitForStub(): Promise<StubCall> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(jobDir(), 'stub-claude.call.json'))) {
      const call = stubCall();
      leftovers.push(call.pid, ...(call.grandchild === undefined ? [] : [call.grandchild]));
      return call;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the stub never started');
}

function writer(options: Partial<ClaudeBriefWriterOptions> = {}) {
  return new ClaudeBriefWriter({
    config: { logsDir, dataDir, claudeBin },
    home: join(root, 'home'),
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ELEVENLABS_API_KEY: 'sk_test_never_passed',
      ANTHROPIC_API_KEY: 'sk-ant-test-passed',
    },
    killGraceMs: 1_000,
    sampleIntervalMs: 50,
    ...options,
  });
}

function run(
  controller = new AbortController(),
  note: string | null = null,
  files: JobFile[] = [],
): BriefWrite {
  return { jobDir: jobDir(), files, note, signal: controller.signal };
}

/** A logger that remembers what the writer warns about. */
function spyLogger() {
  const warnings: { entry: Record<string, unknown>; message: string }[] = [];
  return {
    warnings,
    logger: {
      info() {},
      error() {},
      warn(entry: object, message: string) {
        warnings.push({ entry: entry as Record<string, unknown>, message });
      },
    },
  };
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

describe('the command', () => {
  it('runs claude in the job folder with Sonnet, the Brief tools and a scrubbed environment', async () => {
    scenario({});
    const outcome = await writer().write(
      makeJob('Keep it short.'),
      run(undefined, 'Keep it short.'),
    );

    expect(outcome).toEqual({ ok: true });
    const call = stubCall();
    expect(call.cwd).toBe(realpathSync(jobDir()));
    expect(call.argv[0]).toBe('-p');
    const prompt = call.argv[1] ?? '';
    expect(prompt).toMatch(/^Write the brief for this edit\./);
    expect(prompt).toContain('Job: client "Acme Studio", job "Launch teaser".');
    expect(prompt).toContain('<note>\nKeep it short.\n</note>');
    expect(prompt.trimEnd().endsWith(briefPromptSchema())).toBe(true);
    const home = join(root, 'home');
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
      'Read,Glob,Grep,Write,Bash',
      '--allowedTools',
      [
        'Read',
        'Glob',
        'Grep',
        'Edit(./edit/**)',
        'Bash(ls)',
        'Bash(ls *)',
        'Bash(ffprobe *)',
        'Bash(textutil -convert txt -stdout *)',
        'Bash(~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/transcribe.py *)',
        `Bash(${home}/Developer/video-use/.venv/bin/python ${home}/Developer/video-use/helpers/transcribe.py *)`,
      ].join(','),
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
    expect(call.env.HOME).toBe(home);
    expect(call.env.CLAUDE_CODE_SHELL).toBe('/bin/bash');
    expect(call.env.STUDIO_ENGINE_RUN).toMatch(new RegExp(`^${JOB_ID}-`));
    expect(call.env).not.toHaveProperty('ELEVENLABS_API_KEY');
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(readFileSync(jobLogPath(logsDir, JOB_ID), 'utf8')).not.toMatch(
      /never_passed|sk-ant-test-passed/,
    );
  });

  it('says "(none)" in the prompt for a job without a note', async () => {
    scenario({});
    await writer().write(makeJob(), run());
    expect(stubCall().argv[1]).toContain('<note>\n(none)\n</note>');
  });

  // CVP-255: an episode's Brief run is told the series' format follows its brief.
  it('tells the run it is an episode when the step gives it the series, and not otherwise', async () => {
    scenario({});
    await writer().write(makeJob(), { ...run(), series: { name: 'Show', episode: 6 } });
    const episode = stubCall().argv[1] ?? '';
    expect(episode).toContain(
      'This job is episode 6 of the series “Show”. The engine adds the series’ format to the brief after yours',
    );

    scenario({});
    await writer().write(makeJob(), { ...run(), series: null });
    expect(stubCall().argv[1]).not.toContain('This job is');
  });
});

// SG4: with the Songs switch on the Brief run reads the song off a screenshot, a link or the words,
// and its schema has the song keys; with it off the prompt is what it was.
describe('the Songs switch', () => {
  it('adds the songs part and the song keys to the prompt only when it is on', async () => {
    scenario({});
    await writer().write(makeJob(), run());
    const off = stubCall().argv[1] ?? '';
    expect(off).not.toContain('- Songs.');
    expect(off).not.toContain('wantsTrending');
    expect(off.trimEnd().endsWith(briefPromptSchema())).toBe(true);

    scenario({});
    await writer({ config: { logsDir, dataDir, claudeBin, songs: false } }).write(makeJob(), run());
    expect(stubCall().argv[1]).toBe(off);

    scenario({});
    await writer({ config: { logsDir, dataDir, claudeBin, songs: true } }).write(makeJob(), run());
    const on = stubCall().argv[1] ?? '';
    expect(on).toContain('- Songs. The client or the owner may ask for a song under the video.');
    expect(on).toContain('“Original audio · [account]”');
    expect(on).toContain('wantsTrending');
    expect(on.trimEnd().endsWith(briefPromptSchema({ songs: true }))).toBe(true);
  });
});

// U21: with the music switch on the Brief run is told that music is asked for only in so many words
// (music.wanted) and its schema has the key; with it off the prompt is what it was.
describe('the music switch', () => {
  it('adds the music part and wanted to the prompt only when it is on', async () => {
    scenario({});
    await writer().write(makeJob(), run());
    const off = stubCall().argv[1] ?? '';
    expect(off).not.toContain('- Music. Studio Engine makes music only when the job asks for it');
    expect(off).not.toContain('wanted');
    expect(off.trimEnd().endsWith(briefPromptSchema())).toBe(true);

    scenario({});
    await writer({ config: { logsDir, dataDir, claudeBin, music: false } }).write(makeJob(), run());
    expect(stubCall().argv[1]).toBe(off);

    scenario({});
    await writer({ config: { logsDir, dataDir, claudeBin, music: true } }).write(makeJob(), run());
    const on = stubCall().argv[1] ?? '';
    expect(on).toContain('- Music. Studio Engine makes music only when the job asks for it.');
    expect(on).toContain('music.wanted says whether the instructions ask for music');
    expect(on).not.toContain('- Songs.');
    expect(on.trimEnd().endsWith(briefPromptSchema({ music: true }))).toBe(true);
  });
});

// GN4: with the Generate switch on the Brief run is told the rules for production, voiceover, formats
// and budgetUsd, its schema has those four keys, and a file unpacked from a zip is listed with its
// zip; with it off the prompt is what it was.
describe('the Generate switch', () => {
  it('adds the generated-video part and the four keys to the prompt only when it is on', async () => {
    scenario({});
    await writer().write(makeJob(), run());
    const off = stubCall().argv[1] ?? '';
    expect(off).not.toContain('- Generated videos.');
    expect(off).not.toContain('voiceover');
    expect(off.trimEnd().endsWith(briefPromptSchema())).toBe(true);

    scenario({});
    await writer({ config: { logsDir, dataDir, claudeBin, generate: false } }).write(
      makeJob(),
      run(),
    );
    expect(stubCall().argv[1]).toBe(off);

    scenario({});
    await writer({ config: { logsDir, dataDir, claudeBin, generate: true } }).write(
      makeJob(),
      run(),
    );
    const on = stubCall().argv[1] ?? '';
    expect(on).toContain('- Generated videos. The schema also has production, voiceover');
    expect(on).toContain('production: "generate" only when there is no footage for the video');
    expect(on.trimEnd().endsWith(briefPromptSchema({ generate: true }))).toBe(true);
  });

  it('lists a file unpacked from a zip with the zip it came from', async () => {
    scenario({});
    const logo = 'edit/brief/unzipped/refs/logo.png';
    const files: BriefWrite['files'] = [
      {
        relPath: 'refs.zip',
        absPath: join(jobDir(), 'refs.zip'),
        kind: 'other',
        size: 10,
        mtimeMs: Date.UTC(2026, 9, 25, 12, 52),
      },
      {
        relPath: logo,
        absPath: join(jobDir(), logo),
        kind: 'image',
        size: 20,
        mtimeMs: Date.UTC(2026, 9, 25, 12, 52),
        fromZip: 'refs.zip',
        contentKey: 'abcdef01',
      },
    ];
    await writer({ config: { logsDir, dataDir, claudeBin, generate: true } }).write(makeJob(), {
      ...run(),
      files,
    });
    const prompt = stubCall().argv[1] ?? '';
    expect(prompt).toContain('- refs.zip (unknown type, 10 bytes, modified 2026-10-25 12:52 UTC)');
    expect(prompt).toContain(
      `- ${logo} (image, 20 bytes, from refs.zip, modified 2026-10-25 12:52 UTC)`,
    );
  });

  it('names the client’s shared files the step gives it, under the production rule', async () => {
    scenario({});
    await writer({ config: { logsDir, dataDir, claudeBin, generate: true } }).write(makeJob(), {
      ...run(),
      shared: ['C7909.MP4'],
    });
    const prompt = stubCall().argv[1] ?? '';
    expect(prompt).toContain('its _Shared folder (../_Shared/ from the job folder)');
    expect(prompt).toContain('    - At the top: C7909.MP4\n');
  });
});

// P18 (CVP-133): the run's step 1 used to need a compound `find | xargs`, which the allow list
// refuses; the denial made the model give up on Bash and skip the voice notes. The prompt now
// carries the file list, with durations probed by the engine.
describe('the file list in the prompt', () => {
  function jobFile(relPath: string, kind: JobFile['kind'], size: number): JobFile {
    return {
      relPath,
      absPath: join(jobDir(), relPath),
      kind,
      size,
      mtimeMs: Date.UTC(2026, 9, 19, 8, 3),
    };
  }

  it('lists every file with its kind, size, modified time and, for video and audio, its length', async () => {
    scenario({});
    const seen: string[] = [];
    const durations = new DurationCache(async (path) => {
      seen.push(path);
      return path.endsWith('.m4a') ? 21.4 : path.endsWith('broken.mp4') ? null : 8.2;
    });
    const files = [
      jobFile('_chat.txt', 'doc', 1_234),
      jobFile('broken.mp4', 'video', 500),
      jobFile('clip.mp4', 'video', 12_345_678),
      jobFile('note.m4a', 'audio', 45_678),
      jobFile('logo.png', 'image', 27_000),
    ];

    await writer({ durations }).write(makeJob(), run(undefined, null, files));

    const prompt = stubCall().argv[1] ?? '';
    expect(prompt).toContain(
      [
        '- _chat.txt (text, 1.2 KB, modified 2026-10-19 08:03 UTC)',
        '- broken.mp4 (video, 500 bytes, duration unreadable, modified 2026-10-19 08:03 UTC)',
        '- clip.mp4 (video, 12 MB, 0:08, modified 2026-10-19 08:03 UTC)',
        '- note.m4a (audio, 46 KB, 0:21, modified 2026-10-19 08:03 UTC)',
        '- logo.png (image, 27 KB, modified 2026-10-19 08:03 UTC)',
      ].join('\n'),
    );
    // Only video and audio are probed.
    expect(seen.map((path) => path.split('/').pop()).sort()).toEqual([
      'broken.mp4',
      'clip.mp4',
      'note.m4a',
    ]);
    expect(prompt).toContain('Bash here runs only these commands, one per call');
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });
});

// P18 (CVP-133): a denied tool call is not a failure of the run, but it must not go unseen.
describe('permission denials', () => {
  const DENIED =
    "Permission to use Bash has been denied because Claude Code is running in don't ask mode.";
  const FIND = 'find . -path ./edit -prune -o -type f -print0 | xargs -0 ls -l; ls -la edit';

  const toolUse = (id: string, name: string, input: object) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
  const deniedEvent = (id: string, tool = 'Bash') =>
    JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: tool,
      tool_use_id: id,
      message: DENIED,
    });
  const deniedResult = (id: string) =>
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: DENIED, is_error: true }],
      },
    });

  it('logs each denial as a warning and lists it in brief_end, once however many places show it', async () => {
    scenario({
      lines: [
        toolUse('t1', 'Bash', { command: FIND }),
        deniedEvent('t1'),
        deniedResult('t1'),
        toolUse('t2', 'Write', { file_path: '/tmp/outside.json', content: '{}' }),
        deniedEvent('t2', 'Write'),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Done.',
          permission_denials: [
            { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: FIND } },
            {
              tool_name: 'Write',
              tool_use_id: 't2',
              tool_input: { file_path: '/tmp/outside.json' },
            },
          ],
        }),
      ],
    });
    const { warnings, logger } = spyLogger();

    const outcome = await writer({ logger }).write(makeJob(), run());

    // The run itself is not failed: the brief is judged by the Brief step.
    expect(outcome).toEqual({ ok: true });
    const denials = warnings.filter((w) => /denied/.test(w.message));
    expect(denials.map((w) => w.entry)).toEqual([
      { jobId: JOB_ID, tool: 'Bash', detail: FIND },
      { jobId: JOB_ID, tool: 'Write', detail: '/tmp/outside.json' },
    ]);
    const end = markers().find((m) => m.event === 'brief_end');
    expect(end).toMatchObject({
      outcome: 'succeeded',
      permissionDenials: [
        { tool: 'Bash', detail: FIND },
        { tool: 'Write', detail: '/tmp/outside.json' },
      ],
    });
  });

  it('finds a denial that only the tool result shows (an older CLI), with the command from the call', async () => {
    scenario({
      lines: [
        toolUse('t1', 'Bash', { command: 'cat a | head' }),
        deniedResult('t1'),
        RESULT_LINE('Done.'),
      ],
    });
    const { warnings, logger } = spyLogger();

    await writer({ logger }).write(makeJob(), run());

    expect(warnings.filter((w) => /denied/.test(w.message)).map((w) => w.entry)).toEqual([
      { jobId: JOB_ID, tool: 'Bash', detail: 'cat a | head' },
    ]);
    expect(markers().find((m) => m.event === 'brief_end')).toMatchObject({
      permissionDenials: [{ tool: 'Bash', detail: 'cat a | head' }],
    });
  });

  it('says "permissionDenials": [] and warns of nothing when nothing was denied', async () => {
    scenario({
      lines: [
        toolUse('t1', 'Bash', { command: 'ls -la' }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'total 0', is_error: false },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Done.',
          permission_denials: [],
        }),
      ],
    });
    const { warnings, logger } = spyLogger();

    await writer({ logger }).write(makeJob(), run());

    expect(warnings).toEqual([]);
    expect(markers().find((m) => m.event === 'brief_end')).toMatchObject({
      outcome: 'succeeded',
      permissionDenials: [],
    });
  });

  it('records the denials of a failed run too', async () => {
    scenario({
      lines: [
        toolUse('t1', 'Bash', { command: FIND }),
        deniedEvent('t1'),
        RESULT_LINE('Blocked: no key'),
      ],
    });
    const { warnings, logger } = spyLogger();

    const outcome = await writer({ logger }).write(makeJob(), run());

    expect(outcome.ok).toBe(false);
    expect(warnings.filter((w) => /denied/.test(w.message))).toHaveLength(1);
    expect(markers().find((m) => m.event === 'brief_end')).toMatchObject({
      outcome: 'failed',
      permissionDenials: [{ tool: 'Bash', detail: FIND }],
    });
  });
});

describe('the job log', () => {
  it('frames the stream with brief_start and brief_end, every marker tagged "run":"brief"', async () => {
    scenario({
      lines: ['{"type":"system","subtype":"init","session_id":"s-1"}', RESULT_LINE('Done.')],
      stderr: 'a warning\n',
    });
    await writer().write(makeJob(), run());

    const log = readFileSync(jobLogPath(logsDir, JOB_ID), 'utf8').trimEnd().split('\n');
    expect(log).toContain('{"type":"system","subtype":"init","session_id":"s-1"}');
    const events = markers().map((m) => [m.event, m.run]);
    expect(events).toEqual([
      ['brief_start', 'brief'],
      ['stderr', 'brief'],
      ['brief_end', 'brief'],
    ]);
    expect(markers()[0]).toMatchObject({ model: 'sonnet', timeoutMs: 600_000, cwd: jobDir() });
    expect(markers()[2]).toMatchObject({ outcome: 'succeeded', exitCode: 0, sessionId: 's-1' });
    expect(readdirSync(join(dataDir, 'runs'))).toEqual([]);
  });

  it('is never mistaken for the edit run: a retry still finds the last edit run', async () => {
    const path = jobLogPath(logsDir, JOB_ID);
    mkdirSync(join(logsDir, 'jobs'), { recursive: true });
    const editEnd = {
      type: 'studio_engine',
      event: 'end',
      at: '2026-10-21T10:00:00.000Z',
      outcome: 'failed',
      error: 'render crashed',
      exitCode: 1,
      signal: null,
      durationMs: 1,
      sessionId: null,
    };
    writeFileSync(path, `${JSON.stringify(editEnd)}\n`);
    scenario({});

    await writer().write(makeJob(), run());

    expect(await readLastEnd(path)).toMatchObject({ outcome: 'failed', error: 'render crashed' });
  });
});

describe('how it ends', () => {
  it('turns a final "Blocked:" line into the error', async () => {
    scenario({ lines: [RESULT_LINE('I read the chat.\n\nBlocked: the voice note is encrypted.')] });
    expect(await writer().write(makeJob(), run())).toEqual({
      ok: false,
      error: 'Brief stopped: the voice note is encrypted.',
    });
    expect(markers().at(-1)).toMatchObject({ event: 'brief_end', outcome: 'failed' });
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
    expect(await writer().write(makeJob(), run())).toEqual({
      ok: false,
      error:
        'Brief stopped: Claude Code is not logged in. Run `pnpm run doctor` for the login command, then retry.',
    });
  });

  it('stops a run that takes too long, and fails it with the time limit', async () => {
    scenario({ hang: true });
    const startedAt = Date.now();
    const outcome = await writer({ timeoutMs: 400 }).write(makeJob(), run());
    const pid = stubCall().pid;

    expect(outcome).toEqual({ ok: false, error: BRIEF_TIMED_OUT });
    expect(BRIEF_TIMED_OUT).toBe('Brief stopped: the brief took longer than 10 minutes.');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect((await listProcesses()).some((proc) => proc.pid === pid)).toBe(false);
    expect(markers().at(-1)).toMatchObject({ event: 'brief_end', outcome: 'timed_out' });
  });

  it('is cancelled through the abort signal: the process is stopped before it resolves', async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const writing = writer().write(makeJob(), run(controller));
    const { pid } = await waitForStub();

    controller.abort('cancel');
    const outcome = await writing;

    expect(outcome.ok).toBe(false);
    expect((await listProcesses()).some((proc) => proc.pid === pid)).toBe(false);
    expect(markers().at(-1)).toMatchObject({ event: 'brief_end', outcome: 'cancelled' });
  });

  it('records a shutdown as stopped, not cancelled', async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const writing = writer().write(makeJob(), run(controller));
    await waitForStub();
    controller.abort('shutdown');
    await writing;
    expect(markers().at(-1)).toMatchObject({ event: 'brief_end', outcome: 'stopped' });
  });

  it('fails clearly when claude cannot be found', async () => {
    const outcome = await writer({
      config: { logsDir, dataDir, claudeBin: join(root, 'no-such-claude') },
    }).write(makeJob(), run());
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(
      /^Brief stopped: Claude Code was not found/,
    );
  });
});

// C18 (CVP-195): a Brief run must leave nothing running, however it ends. The stubborn scenario is
// the worst case: claude ignores SIGTERM, and so does a tool command in a process group of its
// own, the way Claude Code's Bash tool starts one. The afterEach above also fails any test of
// this file that ends with a process of its run still alive.
//
// These tests are heavy (C79): stopping the run's tree is a dozen `ps -A -E` passes (the tag scan:
// 0.3 s each at a load of 100, 50 ms on a quiet machine) with the grace period between them, so
// one takes 2 to 4 s in a full run on a busy machine and the default 5 s was too close, and ended
// one of them now and then. 60 s is room for that; what they check is waited on, not timed.
describe('nothing of a Brief run outlives it', { timeout: 60_000 }, () => {
  const STUBBORN: Scenario = { hang: true, ignoreTerm: true, grandchild: 'stubborn' };

  it.each([
    ['cancel', 'cancelled'],
    ['shutdown', 'stopped'],
  ])(
    'a %s stops claude and its tool command, even when both ignore SIGTERM',
    async (reason, outcome) => {
      scenario(STUBBORN);
      const controller = new AbortController();
      const writing = writer({ killGraceMs: 300 }).write(makeJob(), run(controller));
      const call = await waitForStub();
      expect(await running([call.pid, call.grandchild as number])).toHaveLength(2);

      controller.abort(reason);
      expect((await writing).ok).toBe(false);

      expect(await running([call.pid, call.grandchild as number])).toEqual([]);
      expect(await stubPids()).toEqual([]);
      expect(markers().at(-1)).toMatchObject({ event: 'brief_end', outcome, signal: 'SIGKILL' });
    },
  );

  it('the time limit stops claude and its tool command, even when both ignore SIGTERM', async () => {
    scenario(STUBBORN);

    const outcome = await writer({ timeoutMs: 400, killGraceMs: 300 }).write(makeJob(), run());
    const call = stubCall();
    leftovers.push(call.pid, call.grandchild as number);

    expect(outcome).toEqual({ ok: false, error: BRIEF_TIMED_OUT });
    expect(await running([call.pid, call.grandchild as number])).toEqual([]);
    expect(await stubPids()).toEqual([]);
    expect(markers().at(-1)).toMatchObject({
      event: 'brief_end',
      outcome: 'timed_out',
      signal: 'SIGKILL',
    });
  });

  it('a run that ends by itself takes its tool command with it', async () => {
    scenario({ grandchild: 'stubborn', lines: [RESULT_LINE('Done.')] });

    const outcome = await writer({ killGraceMs: 300 }).write(makeJob(), run());
    const call = stubCall();
    leftovers.push(call.grandchild as number);

    expect(outcome).toEqual({ ok: true });
    expect(await running([call.pid, call.grandchild as number])).toEqual([]);
    expect(markers().find((m) => m.event === 'cleanup')).toMatchObject({
      run: 'brief',
      leftover: 1,
    });
  });

  it('a run that was cancelled before it started starts nothing', async () => {
    scenario(STUBBORN);
    const controller = new AbortController();
    controller.abort('cancel');

    const outcome = await writer().write(makeJob(), run(controller));

    expect(outcome.ok).toBe(false);
    expect(existsSync(join(jobDir(), 'stub-claude.call.json'))).toBe(false);
    expect(await stubPids()).toEqual([]);
  });
});

describe('with the Brief step', () => {
  it('a run that writes a valid draft becomes edit/brief.json and brief.md', async () => {
    writeFileSync(join(jobDir(), 'brief.txt'), 'Short and punchy.');
    const draft = { ...noInstructionsBrief([]), summary: 'A short punchy reel.' };
    scenario({
      writeFiles: { 'edit/brief.json': JSON.stringify(draft) },
      lines: [RESULT_LINE('Done.')],
    });
    const step = new BriefStep({ inboxPath, writer: writer() });

    const outcome = await step.prepare(makeJob(), {
      signal: new AbortController().signal,
      progress: () => {},
    });

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    const saved = briefSchema.parse(
      JSON.parse(readFileSync(join(jobDir(), 'edit/brief.json'), 'utf8')),
    );
    expect(saved.summary).toBe('A short punchy reel.');
    expect(readFileSync(join(jobDir(), 'edit/brief.md'), 'utf8')).toContain('A short punchy reel.');
  });
});
