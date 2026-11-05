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
import { FIX_LIMITS, TIER_RUNS } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakePreview } from '../pipeline/fake-preview.js';
import { listProcesses } from '../pipeline/process-tree.js';
import { parseStreamLine } from '../pipeline/stream-parser.js';
import { readUsageLog } from '../usage/usage-log.js';
import {
  ClaudeQuickFixRunner,
  type ClaudeQuickFixRunnerOptions,
  QUICK_FIX_BASH_RULES,
  QUICK_FIX_STOPPED,
  QUICK_FIX_TIMED_OUT,
  QUICK_FIX_TOOLS,
  quickFixAllowedTools,
  quickFixClaudeArgs,
  quickFixDenyRules,
  quickFixRunRecordsDir,
  quickFixRunsDir,
  quickFixStepTracker,
  reapQuickFixRuns,
} from './claude-quick-fix.js';
import { fixDirPath } from './quick-fix-files.js';
import type { QuickFixRequest, QuickFixStep } from './quick-fix-run.js';

// The quick fix run end to end against the stand-in `claude` (pipeline/testdata/stub-claude.mjs):
// real processes, pipes and signals, no model. The stub reads its scenario from its working
// directory, which is the job folder, and writes the files a run would.

const STUB = fileURLToPath(new URL('../pipeline/testdata/stub-claude.mjs', import.meta.url));
// A real run's stream: the spike's "change the caption font to Heebo Bold" on the sample composition
// (CVP-374), trimmed to the init, the tool calls, short tool results and the answer.
const STREAM = fileURLToPath(new URL('./testdata/quick-fix-stream.jsonl', import.meta.url));
const FIX_ID = 'f0a1b2c3-d4e5-4f60-8a7b-9c0d1e2f3a4b';
const FIX_DIR = fixDirPath(FIX_ID);

let root: string;
let inbox: string;
let jobDir: string;
let dataDir: string;
let logsDir: string;
let claudeBin: string;
const leftovers: number[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'studio-claude-quick-fix-'));
  inbox = join(root, 'inbox');
  jobDir = join(inbox, 'Acme Studio', 'Launch teaser');
  dataDir = join(root, 'data');
  logsDir = join(dataDir, 'logs');
  claudeBin = join(root, 'bin', 'claude');
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
  mkdirSync(join(jobDir, 'edit'), { recursive: true });
  await writeFakePreview(join(jobDir, 'edit'), 'Launch teaser');
  writeFileSync(
    join(jobDir, 'edit', 'project.md'),
    '# Launch teaser\n\n## Composition\n- a title\n',
  );
  // Folders the run must not read: another client and the shared fonts.
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

interface Scenario {
  replay?: string;
  lines?: string[];
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
  writeFiles?: Record<string, string>;
}

function scenario(s: Scenario): void {
  writeFileSync(join(jobDir, 'stub-claude.json'), JSON.stringify(s));
}

function stubCall(): { argv: string[]; env: Record<string, string>; cwd: string; pid: number } {
  return JSON.parse(readFileSync(join(jobDir, 'stub-claude.call.json'), 'utf8'));
}

async function waitForStub(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(jobDir, 'stub-claude.call.json'))) {
      const { pid } = stubCall();
      leftovers.push(pid);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the stub never started');
}

const LINT_OK = async () => ({ ok: true }) as const;

function runner(options: Partial<ClaudeQuickFixRunnerOptions> = {}) {
  return new ClaudeQuickFixRunner({
    config: { inboxPath: inbox, logsDir, dataDir, claudeBin },
    home: join(root, 'home'),
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ANTHROPIC_API_KEY: 'sk-ant-test-passed',
    },
    killGraceMs: 1_000,
    sampleIntervalMs: 50,
    lint: LINT_OK,
    // The stub's own scenario and call files sit in the job folder, where a real run writes nothing.
    ignoreChanges: (path) => path.startsWith('stub-claude'),
    ...options,
  });
}

const NOTE_TEXT = 'change the caption font to Heebo Bold';

function request(
  overrides: Partial<QuickFixRequest> = {},
): QuickFixRequest & { steps: [QuickFixStep, string][] } {
  const steps: [QuickFixStep, string][] = [];
  return {
    job: {
      id: 'job-1',
      client: 'Acme Studio',
      name: 'Launch teaser',
      relPath: 'Acme Studio/Launch teaser',
    },
    note: {
      id: 'note-1',
      atSec: 3,
      text: NOTE_TEXT,
      route: { tier: 'quick', kind: 'Changing the caption font', why: '' },
    },
    fix: { id: FIX_ID, round: 2 },
    signal: new AbortController().signal,
    onStep: (step, label) => steps.push([step, label]),
    steps,
    ...overrides,
  };
}

function markers(): Record<string, unknown>[] {
  return readFileSync(join(logsDir, 'jobs', 'job-1.log'), 'utf8')
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

/** index.html with the title yellow: what a real fix leaves. */
function changedIndex(): string {
  const html = readFileSync(join(jobDir, 'edit', 'preview', 'index.html'), 'utf8');
  const changed = html.replace(
    'color: #fff; text-align: center;',
    'color: #ffd60a; text-align: center;',
  );
  expect(changed).not.toBe(html);
  return changed;
}

const STILLS = {
  [`${FIX_DIR}/stills/before/at-3s.png`]: 'png of the moment before',
  [`${FIX_DIR}/stills/after/at-3s.png`]: 'png of the moment after',
};

/** A fix that went well: the composition changed, both stills, the answer. */
function fixedScenario(extra: Record<string, string> = {}): Scenario {
  return {
    replay: STREAM,
    writeFiles: {
      'edit/preview/index.html': changedIndex(),
      'edit/project.md':
        '# Launch teaser\n\n## Round 2 · fixed in Review\n- The title is yellow.\n',
      [`${FIX_DIR}/reply.json`]: JSON.stringify({ done: true, said: 'The title is yellow now.' }),
      ...STILLS,
      ...extra,
    },
  };
}

describe('the permission rules', () => {
  it('allow reading anywhere, writing three places and four kinds of command', () => {
    const allowed = quickFixAllowedTools(FIX_ID);
    expect(allowed).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit(./edit/preview/**)',
      'Edit(./edit/project.md)',
      `Edit(./edit/review/fixes/${FIX_ID}/**)`,
      ...QUICK_FIX_BASH_RULES,
    ]);
    expect(QUICK_FIX_BASH_RULES).toEqual([
      'Bash(npx hyperframes lint edit/preview)',
      'Bash(npx hyperframes lint edit/preview *)',
      'Bash(npx hyperframes snapshot edit/preview *)',
      'Bash(ls)',
      'Bash(ls *)',
      'Bash(mkdir -p edit/preview/assets/fonts)',
      'Bash(cp edit/fonts/* edit/preview/assets/fonts/*)',
      'Bash(cp "edit/fonts/*" edit/preview/assets/fonts/*)',
      "Bash(cp 'edit/fonts/*' edit/preview/assets/fonts/*)",
    ]);
    // Nothing broader than the folders above: no bare Bash, Edit or Write.
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('Edit');
    expect(allowed).not.toContain('Write');
  });

  it('deny the clients’ other folders, cut.mp4 and every video and audio file of the preview', () => {
    const deny = quickFixDenyRules(['Read(//inbox/Kova/**)']);
    expect(deny[0]).toBe('Read(//inbox/Kova/**)');
    expect(deny).toContain('Edit(./edit/preview/cut.mp4)');
    for (const extension of ['mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a']) {
      expect(deny).toContain(`Edit(./edit/preview/**/*.${extension})`);
    }
    expect(quickFixDenyRules()).not.toContain('Read(//inbox/Kova/**)');
  });
});

describe('the command', () => {
  it('is Sonnet at medium with the quick fix tools, the allow and deny rules and a scrubbed environment', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('Done.')] });
    await runner().run(request());

    const call = stubCall();
    expect(call.cwd).toBe(realpathSync(jobDir));
    expect(call.argv[0]).toBe('-p');
    expect(call.argv[1]).toMatch(/^The owner is watching the live preview of this edit/);
    expect(call.argv[1]).toContain(NOTE_TEXT);
    expect(call.argv[1]).toContain(`${FIX_DIR}/reply.json`);
    expect(call.argv[1]).toContain('## Round 2 · fixed in Review');
    expect(TIER_RUNS.quick).toEqual({ model: 'sonnet', effort: 'medium' });
    const flags = call.argv.slice(2);
    expect(flags.slice(0, -1)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
      '--effort',
      'medium',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--tools',
      'Read,Glob,Grep,Edit,Write,Bash',
      '--allowedTools',
      quickFixAllowedTools(FIX_ID).join(','),
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
        `Read(/${real}/Kova Coffee/**)`,
        `Read(/${real}/_Fonts/**)`,
        'Edit(./edit/preview/cut.mp4)',
      ]),
    );
    expect(settings.permissions.deny.some((rule) => rule.includes('Launch teaser'))).toBe(false);
    expect(call.env.STUDIO_ENGINE_RUN).toMatch(new RegExp(`^fix-${FIX_ID}-`));
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('has no Skill and no Task tool, whatever the arguments are built with', () => {
    expect(QUICK_FIX_TOOLS).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
    const args = quickFixClaudeArgs({ prompt: 'x', fixId: FIX_ID });
    const tools = args[args.indexOf('--tools') + 1] ?? '';
    expect(tools).not.toMatch(/Skill|Task/);
  });
});

describe('the steps', () => {
  const edit = (path: string) => ({ file_path: path, old_string: 'a', new_string: 'b' });
  function follow(events: [string, Record<string, unknown>][]): QuickFixStep[] {
    const moves: QuickFixStep[] = [];
    const tracker = quickFixStepTracker((step) => moves.push(step));
    events.forEach(([name, input], index) => {
      for (const event of parseStreamLine(TOOL_LINE(name, input, `t${index}`)))
        tracker.onEvent(event);
    });
    return moves;
  }

  it('goes 1, 2, 3 on the trimmed real run: the edit, then a lint, then a snapshot', () => {
    const moves: QuickFixStep[] = [];
    const tracker = quickFixStepTracker((step) => moves.push(step));
    for (const line of readFileSync(STREAM, 'utf8').split('\n')) {
      for (const event of parseStreamLine(line)) tracker.onEvent(event);
    }
    expect(moves).toEqual([1, 2, 3]);
    expect(tracker.step).toBe(3);
  });

  it('stays at 0 while it reads, snapshots and lints before editing', () => {
    expect(
      follow([
        ['Read', { file_path: '/j/edit/project.md' }],
        ['Bash', { command: 'npx hyperframes snapshot edit/preview --at=3 --no-end --keep -o x' }],
        ['Bash', { command: 'npx hyperframes lint edit/preview' }],
      ]),
    ).toEqual([]);
  });

  it('takes only an Edit or a Write of the composition for step 1', () => {
    expect(follow([['Write', { file_path: `/j/${FIX_DIR}/reply.json`, content: '{}' }]])).toEqual(
      [],
    );
    expect(follow([['Edit', edit('/j/edit/project.md')]])).toEqual([]);
    expect(follow([['Edit', edit('/j/edit/preview/.hyperframes/video-state.json')]])).toEqual([]);
    expect(
      follow([['Bash', { command: 'cp edit/fonts/a.ttf edit/preview/assets/fonts/' }]]),
    ).toEqual([]);
    expect(follow([['Edit', edit('/j/edit/preview/compositions/captions.html')]])).toEqual([1]);
    expect(
      follow([['Write', { file_path: 'edit/preview/index.html', content: '<html>' }]]),
    ).toEqual([1]);
  });

  it('never goes back, and a snapshot straight after the edit skips the lint step', () => {
    expect(
      follow([
        ['Edit', edit('/j/edit/preview/index.html')],
        ['Bash', { command: 'npx hyperframes snapshot edit/preview --at=3 --no-end --keep -o x' }],
        ['Bash', { command: 'npx hyperframes lint edit/preview' }],
        ['Edit', edit('/j/edit/preview/index.html')],
      ]),
    ).toEqual([1, 3]);
  });

  it('reports step 0 when the run starts and the words of each step, step 1 being the note’s kind', async () => {
    scenario(fixedScenario());
    const req = request();
    await runner().run(req);
    expect(req.steps).toEqual([
      [0, 'Reading the edit'],
      [1, 'Changing the caption font'],
      [2, 'Checking it'],
      [3, 'Looking at the frames'],
    ]);
  });

  it('says "Changing the edit" for a note the router gave no kind', async () => {
    scenario(fixedScenario());
    const req = request({
      note: { id: 'note-1', atSec: 3, text: NOTE_TEXT, route: null },
    });
    await runner().run(req);
    expect(req.steps[1]).toEqual([1, 'Changing the edit']);
  });
});

describe('a fix that works', () => {
  it('is fixed with the run’s sentence, and leaves before.png and after.png', async () => {
    scenario(fixedScenario());
    const outcome = await runner().run(request());

    expect(outcome).toEqual({
      status: 'fixed',
      said: 'The title is yellow now.',
      hasCompare: true,
    });
    const fix = join(jobDir, FIX_DIR);
    expect(readFileSync(join(fix, 'before.png'), 'utf8')).toBe('png of the moment before');
    expect(readFileSync(join(fix, 'after.png'), 'utf8')).toBe('png of the moment after');
    expect(existsSync(join(fix, 'stills'))).toBe(false);
    expect(readFileSync(join(jobDir, 'edit', 'project.md'), 'utf8')).toContain('fixed in Review');
  });

  it('writes its stream to the job log between quick_fix_start and quick_fix_end', async () => {
    scenario(fixedScenario());
    await runner().run(request());

    const log = readFileSync(join(logsDir, 'jobs', 'job-1.log'), 'utf8');
    const lines = log.trimEnd().split('\n');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'quick_fix_start',
      run: 'quick-fix',
    });
    expect(log).toContain('"name": "Edit"');
    const all = markers();
    expect(all[0]).toMatchObject({
      event: 'quick_fix_start',
      run: 'quick-fix',
      jobId: 'job-1',
      fixId: FIX_ID,
      noteId: 'note-1',
      round: 2,
      atSec: 3,
      kind: 'Changing the caption font',
      model: 'sonnet',
      effort: 'medium',
      timeoutMs: FIX_LIMITS.runSec * 1000,
    });
    expect(String(all[0]?.prompt)).toContain(NOTE_TEXT);
    expect(all.at(-1)).toMatchObject({
      event: 'quick_fix_end',
      run: 'quick-fix',
      outcome: 'succeeded',
      status: 'fixed',
      said: 'The title is yellow now.',
      hasCompare: true,
      exitCode: 0,
      step: 3,
    });
  });

  it('logs its tokens under quick-fix, with the note’s kind', async () => {
    scenario(fixedScenario());
    await runner().run(request());
    const entries = await readUsageLog(dataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'app',
      tag: 'quick-fix',
      did: 'Fixed a review note for Acme Studio / Launch teaser: Changing the caption font',
    });
  });

  it('has no compare when the run left only one of the two stills', async () => {
    const s = fixedScenario();
    delete s.writeFiles?.[`${FIX_DIR}/stills/after/at-3s.png`];
    scenario(s);
    const outcome = await runner().run(request());
    expect(outcome).toMatchObject({ status: 'fixed', hasCompare: false });
  });
});

describe('a fix that cannot be done here', () => {
  it('escalates when the run says it could not, with its words', async () => {
    scenario({
      lines: [INIT_LINE, RESULT_LINE('Done.')],
      writeFiles: {
        [`${FIX_DIR}/reply.json`]: JSON.stringify({
          done: false,
          why: 'the sign is part of the footage',
        }),
      },
    });
    expect(await runner().run(request())).toEqual({
      status: 'escalated',
      why: 'the sign is part of the footage',
      hasCompare: false,
    });
    expect(markers().at(-1)).toMatchObject({ outcome: 'succeeded', status: 'escalated' });
  });

  it('escalates "nothing changed" when it says done but changed no file', async () => {
    scenario({
      lines: [INIT_LINE, RESULT_LINE('Done.')],
      writeFiles: {
        [`${FIX_DIR}/reply.json`]: JSON.stringify({ done: true, said: 'It is done.' }),
      },
    });
    expect(await runner().run(request())).toMatchObject({
      status: 'escalated',
      why: 'nothing changed',
    });
  });
});

describe('a fix that fails', () => {
  it('fails when claude exits with an error, with the reason', async () => {
    scenario({ lines: [INIT_LINE], stderr: 'boom', exitCode: 1 });
    const outcome = await runner().run(request());
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.why).toMatch(/exit code 1|boom/);
    expect(markers().at(-1)).toMatchObject({ outcome: 'failed', status: 'failed', exitCode: 1 });
  });

  it('fails when claude ends with an error result', async () => {
    scenario({ lines: [INIT_LINE, RESULT_LINE('You have reached your usage limit.', true)] });
    expect(await runner().run(request())).toMatchObject({
      status: 'failed',
      why: 'You have reached your usage limit.',
    });
  });

  it('fails when the run wrote no answer', async () => {
    scenario({
      lines: [INIT_LINE, RESULT_LINE('Done.')],
      writeFiles: { 'edit/preview/index.html': changedIndex() },
    });
    expect(await runner().run(request())).toMatchObject({
      status: 'failed',
      why: 'it finished without writing its answer',
    });
  });

  it('fails when the run touched cut.mp4, and says so', async () => {
    scenario(fixedScenario({ 'edit/preview/cut.mp4': 'not the same video' }));
    expect(await runner().run(request())).toMatchObject({
      status: 'failed',
      why: 'it changed cut.mp4, which it must not touch',
    });
  });

  it('fails when the run wrote outside the composition', async () => {
    scenario(fixedScenario({ 'edit/brief.json': '{}' }));
    expect(await runner().run(request())).toMatchObject({
      status: 'failed',
      why: 'it changed edit/brief.json, outside the composition',
    });
  });

  it('fails when the engine’s own lint does not pass, with its first error', async () => {
    scenario(fixedScenario());
    const lint = async () =>
      ({ ok: false, why: 'lint: Root composition is missing data-width' }) as const;
    expect(await runner({ lint }).run(request())).toMatchObject({
      status: 'failed',
      why: 'lint: Root composition is missing data-width',
    });
  });

  it('fails before it starts when there is no preview, and when the note has no words', async () => {
    scenario({});
    rmSync(join(jobDir, 'edit', 'preview', 'index.html'));
    expect(await runner().run(request())).toMatchObject({
      status: 'failed',
      why: 'there is no preview to change',
    });
    expect(existsSync(join(jobDir, 'stub-claude.call.json'))).toBe(false);

    const voice = request({
      note: { id: 'note-2', atSec: 1, text: null, route: null },
    });
    expect(await runner().run(voice)).toMatchObject({
      status: 'failed',
      why: 'the note has no words yet',
    });
    expect(existsSync(join(jobDir, 'stub-claude.call.json'))).toBe(false);
  });

  it('fails with a plain line when claude is not installed', async () => {
    scenario({});
    const outcome = await runner({
      config: { inboxPath: inbox, logsDir, dataDir, claudeBin: join(root, 'missing', 'claude') },
    }).run(request());
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.why).toMatch(/Claude Code (was not found|at )/);
  });
});

describe('stopping', () => {
  it('stops the run and its process tree when the signal aborts', async () => {
    scenario({ lines: [INIT_LINE], hang: true });
    const controller = new AbortController();
    const running = runner().run(request({ signal: controller.signal }));
    const pid = await waitForStub();
    controller.abort();

    expect(await running).toEqual({ status: 'failed', why: QUICK_FIX_STOPPED, hasCompare: false });
    expect((await listProcesses()).some((entry) => entry.pid === pid)).toBe(false);
    expect(markers().at(-1)).toMatchObject({ event: 'quick_fix_end', outcome: 'cancelled' });
  });

  it('does not start when it is stopped already', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runner().run(request({ signal: controller.signal }))).toEqual({
      status: 'failed',
      why: QUICK_FIX_STOPPED,
      hasCompare: false,
    });
    expect(existsSync(join(jobDir, 'stub-claude.call.json'))).toBe(false);
  });

  it('stops a run that takes too long and fails it', async () => {
    scenario({ hang: true });
    const outcome = await runner({ timeoutMs: 400 }).run(request());
    const pid = stubCall().pid;
    leftovers.push(pid);

    expect(outcome).toEqual({ status: 'failed', why: QUICK_FIX_TIMED_OUT, hasCompare: false });
    expect(QUICK_FIX_TIMED_OUT).toBe('it took longer than 4 minutes');
    expect(markers().at(-1)).toMatchObject({ outcome: 'timed_out' });
    expect((await listProcesses()).some((entry) => entry.pid === pid)).toBe(false);
  });
});

describe('the run records', () => {
  it('keeps one folder per job, and the boot reap empties them all', async () => {
    const records = quickFixRunRecordsDir(dataDir, 'job-9');
    mkdirSync(records, { recursive: true });
    writeFileSync(
      join(records, 'fix-abc.json'),
      JSON.stringify({ jobId: 'fix-abc', pid: 999_999, identity: 'gone' }),
    );
    expect(await reapQuickFixRuns(dataDir, { graceMs: 100 })).toEqual([]);
    expect(existsSync(records)).toBe(false);
    expect(existsSync(quickFixRunsDir(dataDir))).toBe(true);
    expect(await reapQuickFixRuns(join(root, 'no-data'))).toEqual([]);
  });

  it('removes its own record once the run is over', async () => {
    scenario(fixedScenario());
    await runner().run(request());
    expect(existsSync(join(quickFixRunRecordsDir(dataDir, 'job-1'), `fix-${FIX_ID}.json`))).toBe(
      false,
    );
  });
});
