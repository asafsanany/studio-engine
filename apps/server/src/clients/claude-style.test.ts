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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientStyleRepository, JobRepository, SeriesRepository } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import { listProcesses } from '../pipeline/process-tree.js';
import {
  ClaudeStyleRunner,
  type ClaudeStyleRunnerOptions,
  SERIES_TIMED_OUT,
  STYLE_TIMED_OUT,
  styleRunsDir,
} from './claude-style.js';
import { clientLogPath, historyKitDirFor } from './paths.js';
import {
  seriesLearnAllowedTools,
  styleLearnAllowedTools,
  styleReadAllowedTools,
} from './style-command.js';
import type { ReadPass, SeriesPass } from './style-pass.js';
import type { SeriesRunRequest, StyleRunRequest } from './style-run.js';
import { StyleWorker } from './style-worker.js';

// The Claude style run end to end against the stand-in `claude` (pipeline/testdata/stub-claude.mjs):
// real processes, pipes and signals, no model. The stub reads its scenario from its working
// directory, which for a Read pass is the client's _Style folder.

const STUB = fileURLToPath(new URL('../pipeline/testdata/stub-claude.mjs', import.meta.url));

const CLIENT = 'Kova Coffee';
const CLIENT_ID = clientIdFor(CLIENT);

let root: string;
let inboxPath: string;
let logsDir: string;
let dataDir: string;
let claudeBin: string;
const leftovers: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-claude-style-'));
  inboxPath = join(root, 'inbox');
  dataDir = join(root, 'data');
  logsDir = join(dataDir, 'logs');
  claudeBin = join(root, 'bin', 'claude');
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
  mkdirSync(styleDir(), { recursive: true });
  writeFileSync(join(styleDir(), 'logo.png'), 'png');
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

function styleDir(): string {
  return join(inboxPath, CLIENT, '_Style');
}

interface Scenario {
  lines?: string[];
  stderr?: string;
  writeFiles?: Record<string, string>;
  exitCode?: number;
  hang?: boolean;
}

function scenario(s: Scenario): void {
  writeFileSync(join(styleDir(), 'stub-claude.json'), JSON.stringify(s));
}

function stubCall(): { argv: string[]; env: Record<string, string>; cwd: string; pid: number } {
  return JSON.parse(readFileSync(join(styleDir(), 'stub-claude.call.json'), 'utf8'));
}

async function waitForStub(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(join(styleDir(), 'stub-claude.call.json'))) {
      const { pid } = stubCall();
      leftovers.push(pid);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the stub never started');
}

/**
 * Waits until the engine has written the run's record in `style-runs`. The stub starting is not
 * that moment: the engine asks `ps` about the process first and only then makes the folder and the
 * record, which a busy machine can put well after the stub's call file (C79). Resolves with the
 * folder's files; gives up after `ms`.
 */
async function waitForRecord(ms = 30_000): Promise<string[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const files = readdirSync(styleRunsDir(dataDir));
      if (files.length > 0) return files;
    } catch {
      // Not made yet.
    }
    if (Date.now() > deadline) throw new Error('the engine never wrote the run record');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function runner(options: Partial<ClaudeStyleRunnerOptions> = {}) {
  return new ClaudeStyleRunner({
    config: { logsDir, dataDir, claudeBin },
    home: join(root, 'home'),
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ANTHROPIC_API_KEY: 'sk-ant-test-passed',
    },
    killGraceMs: 1_000,
    sampleIntervalMs: 50,
    clock: () => new Date(2026, 9, 21, 12),
    ...options,
  });
}

const PASS: ReadPass = { kind: 'read', mode: 'add', files: [{ name: 'logo.png', size: 3 }] };

function request(controller = new AbortController(), pass: ReadPass = PASS): StyleRunRequest {
  return {
    clientId: CLIENT_ID,
    client: CLIENT,
    styleDir: styleDir(),
    pass,
    signal: controller.signal,
  };
}

function markers(): Record<string, unknown>[] {
  return readFileSync(clientLogPath(logsDir, CLIENT_ID), 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => line.startsWith('{"type":"studio_engine"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const RESULT_LINE = (text: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });

describe('the command', () => {
  it('runs claude in the _Style folder with Sonnet, the Read tools and a scrubbed environment', async () => {
    scenario({ lines: [RESULT_LINE('Done.')] });
    expect(await runner().run(request())).toEqual({ ok: true });

    const call = stubCall();
    expect(call.cwd).toBe(realpathSync(styleDir()));
    expect(call.argv[0]).toBe('-p');
    const prompt = call.argv[1] ?? '';
    expect(prompt).toMatch(/^Write this client’s style\./);
    expect(prompt).toContain('Client: "Kova Coffee".');
    expect(prompt).toContain('add “Plus logo.png (2026-10-21).”');
    expect(prompt).toContain('New files:\n- logo.png (3 bytes)\n');
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
        'Edit(./style.md.new)',
        'Bash(ls)',
        'Bash(ls *)',
        'Bash(ffprobe *)',
        'Bash(ffmpeg * -frames:v 1 /tmp/*)',
        'Bash(textutil -convert txt -stdout *)',
      ].join(','),
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
    expect(styleReadAllowedTools()).toHaveLength(9);
    expect(call.env.STUDIO_ENGINE_RUN).toMatch(new RegExp(`^style-${CLIENT_ID}-`));
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('the client log', () => {
  it('frames the stream with style_start and style_end in logs/clients/<clientId>.log', async () => {
    scenario({
      lines: ['{"type":"system","subtype":"init","session_id":"s-1"}', RESULT_LINE('Done.')],
      stderr: 'a warning\n',
    });
    await runner().run(request());

    const log = readFileSync(clientLogPath(logsDir, CLIENT_ID), 'utf8');
    expect(clientLogPath(logsDir, CLIENT_ID)).toBe(join(logsDir, 'clients', `${CLIENT_ID}.log`));
    expect(log).toContain('{"type":"system","subtype":"init","session_id":"s-1"}');
    expect(markers().map((m) => [m.event, m.run])).toEqual([
      ['style_start', 'style'],
      ['stderr', 'style'],
      ['style_end', 'style'],
    ]);
    expect(markers()[0]).toMatchObject({
      kind: 'read',
      mode: 'add',
      files: [{ name: 'logo.png', size: 3 }],
      clientId: CLIENT_ID,
      client: CLIENT,
      model: 'sonnet',
      timeoutMs: 600_000,
      cwd: styleDir(),
    });
    expect(markers()[2]).toMatchObject({ outcome: 'succeeded', exitCode: 0, sessionId: 's-1' });
    expect(log).not.toMatch(/never-passed/);
  });

  // The 60 s is room for waitForRecord on a busy machine (the default 5 s would end it first).
  it('keeps its run record apart from the edit runs’ and removes it once the run is over', async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const running = runner().run(request(controller));
    await waitForStub();

    expect(await waitForRecord()).toEqual([`style-${CLIENT_ID}.json`]);
    expect(existsSync(join(dataDir, 'runs'))).toBe(false);
    controller.abort('shutdown');
    await running;
    expect(readdirSync(styleRunsDir(dataDir))).toEqual([]);
  }, 60_000);
});

describe('how it ends', () => {
  it('turns a final "Blocked:" line into the error', async () => {
    scenario({ lines: [RESULT_LINE('I looked.\n\nBlocked: brand.pdf is password-protected.')] });
    expect(await runner().run(request())).toEqual({
      ok: false,
      error: 'Style stopped: brand.pdf is password-protected.',
    });
    expect(markers().at(-1)).toMatchObject({ event: 'style_end', outcome: 'failed' });
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
    expect(await runner().run(request())).toEqual({
      ok: false,
      error:
        'Style stopped: Claude Code is not logged in. Run `pnpm run doctor` for the login command, then retry.',
    });
  });

  it('stops a run that takes too long, and fails it with the time limit', async () => {
    scenario({ hang: true });
    const outcome = await runner({ timeoutMs: 400 }).run(request());
    const pid = stubCall().pid;

    expect(outcome).toEqual({ ok: false, error: STYLE_TIMED_OUT });
    expect(STYLE_TIMED_OUT).toBe('Style stopped: the style took longer than 10 minutes.');
    expect((await listProcesses()).some((proc) => proc.pid === pid)).toBe(false);
    expect(markers().at(-1)).toMatchObject({ event: 'style_end', outcome: 'timed_out' });
  });

  it('records a shutdown as stopped, and leaves nothing running', async () => {
    scenario({ hang: true });
    const controller = new AbortController();
    const running = runner().run(request(controller));
    const pid = await waitForStub();
    controller.abort('shutdown');

    expect((await running).ok).toBe(false);
    expect((await listProcesses()).some((proc) => proc.pid === pid)).toBe(false);
    expect(markers().at(-1)).toMatchObject({ event: 'style_end', outcome: 'stopped' });
  });

  it('fails clearly when claude cannot be found', async () => {
    const outcome = await runner({
      config: { logsDir, dataDir, claudeBin: join(root, 'no-such-claude') },
    }).run(request());
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(
      /^Style stopped: Claude Code was not found/,
    );
  });
});

describe('with the style worker', () => {
  it('a run that writes a good style.md.new becomes style.md, version 1, ready', async () => {
    scenario({
      writeFiles: { 'style.md.new': '# Style: Kova Coffee\nFrom your files: logo.png.\n' },
      lines: [RESULT_LINE('Done.')],
    });
    const clientStyles = new ClientStyleRepository(memoryDb());
    const worker = new StyleWorker({ clientStyles, inboxPath, dataDir, runner: runner() });
    worker.start();

    await worker.enqueue(CLIENT, PASS);
    await worker.idle();

    expect(readFileSync(join(styleDir(), 'style.md'), 'utf8')).toBe(
      '# Style: Kova Coffee\nFrom your files: logo.png.\n',
    );
    expect(clientStyles.get(CLIENT_ID)).toMatchObject({ state: 'ready', version: 1, error: null });
    // Without a style.md the add pass ran as create.
    expect(stubCall().argv[1]).toContain('There is no style yet.');
  });
});

describe('a Learn pass', () => {
  const JOB = 'Menu';
  const jobDir = () => join(inboxPath, CLIENT, JOB);

  beforeEach(() => {
    const slot = join(jobDir(), 'edit', 'animations', 'slot_title');
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, 'index.html'), '<h1>Kova</h1>');
    writeFileSync(join(slot, 'render.mov'), 'render');
  });

  it('runs in the job folder with Write limited to style.md.new by its absolute path', async () => {
    // The stub reads its scenario from its working directory: here the job folder.
    writeFileSync(
      join(jobDir(), 'stub-claude.json'),
      JSON.stringify({
        writeFiles: {
          '../_Style/style.md.new': '# Style: Kova Coffee\nLearned from Menu (2026-10-21).\n',
        },
        lines: [RESULT_LINE('Done.')],
      }),
    );
    const clientStyles = new ClientStyleRepository(memoryDb());
    const worker = new StyleWorker({ clientStyles, inboxPath, dataDir, runner: runner() });
    worker.start();

    await worker.enqueue(CLIENT, {
      kind: 'learn',
      mode: 'create',
      jobId: 'a1b2c3d4e5f6',
      job: JOB,
    });
    await worker.idle();

    const call = JSON.parse(readFileSync(join(jobDir(), 'stub-claude.call.json'), 'utf8')) as {
      argv: string[];
      cwd: string;
    };
    expect(call.cwd).toBe(realpathSync(jobDir()));
    const prompt = call.argv[1] ?? '';
    expect(prompt).toMatch(/^Write the style of this finished video,/);
    expect(prompt).toContain(`Client "Kova Coffee", job "Menu".`);
    expect(prompt).toContain(`copied into ${styleDir()}/kit/: slot_title.`);
    expect(prompt).toContain('“Learned from Menu (2026-10-21).”');
    const tools = call.argv[call.argv.indexOf('--allowedTools') + 1];
    expect(tools).toBe(
      [
        'Read',
        'Glob',
        'Grep',
        `Edit(/${join(styleDir(), 'style.md.new')})`,
        'Bash(ls)',
        'Bash(ls *)',
        'Bash(ffprobe *)',
        'Bash(ffmpeg * -frames:v 1 /tmp/*)',
      ].join(','),
    );
    expect(tools).toContain('Edit(//');
    expect(markers()[0]).toMatchObject({
      kind: 'learn',
      mode: 'create',
      jobId: 'a1b2c3d4e5f6',
      job: JOB,
      kit: ['slot_title'],
      cwd: jobDir(),
    });

    expect(readFileSync(join(styleDir(), 'style.md'), 'utf8')).toBe(
      '# Style: Kova Coffee\nLearned from Menu (2026-10-21).\n',
    );
    expect(readFileSync(join(styleDir(), 'kit', 'slot_title', 'index.html'), 'utf8')).toBe(
      '<h1>Kova</h1>',
    );
    expect(clientStyles.get(CLIENT_ID)).toMatchObject({
      state: 'ready',
      version: 1,
      sourceJobId: 'a1b2c3d4e5f6',
    });
  });

  it('merges into the style.md there is, which it may read, and keeps the old kit in history', async () => {
    writeFileSync(
      join(styleDir(), 'style.md'),
      '# Style: Kova Coffee\nLearned from Autumn (2026-10-01).\n## Do\n- Keep titles short.\n',
    );
    mkdirSync(join(styleDir(), 'kit', 'slot_old'), { recursive: true });
    writeFileSync(join(styleDir(), 'kit', 'slot_old', 'index.html'), 'old graphic');
    const merged =
      '# Style: Kova Coffee\nLearned from Autumn (2026-10-01). Plus Menu (2026-10-21).\n## Do\n- Keep titles short.\n';
    writeFileSync(
      join(jobDir(), 'stub-claude.json'),
      JSON.stringify({
        writeFiles: { '../_Style/style.md.new': merged },
        lines: [RESULT_LINE('Done.')],
      }),
    );
    const clientStyles = new ClientStyleRepository(memoryDb());
    clientStyles.upsert({ clientId: CLIENT_ID, client: CLIENT, state: 'ready', version: 1 });
    const worker = new StyleWorker({ clientStyles, inboxPath, dataDir, runner: runner() });
    worker.start();

    // Queued as a first Learn: the style.md there makes it a merge.
    await worker.enqueue(CLIENT, {
      kind: 'learn',
      mode: 'create',
      jobId: 'a1b2c3d4e5f6',
      job: JOB,
    });
    await worker.idle();

    const call = JSON.parse(readFileSync(join(jobDir(), 'stub-claude.call.json'), 'utf8')) as {
      argv: string[];
    };
    const prompt = call.argv[1] ?? '';
    expect(prompt).toContain(
      `5. Merge this video’s look into ${styleDir()}/style.md, the client’s current style,`,
    );
    expect(prompt).toContain('add “Plus Menu (2026-10-21).”');
    expect(prompt).not.toContain('Learned from Menu');
    const tools = call.argv[call.argv.indexOf('--allowedTools') + 1]?.split(',');
    expect(tools).toContain(`Read(/${join(styleDir(), 'style.md')})`);
    expect(tools?.filter((tool) => tool.startsWith('Edit('))).toEqual([
      `Edit(/${join(styleDir(), 'style.md.new')})`,
    ]);
    expect(markers()[0]).toMatchObject({ kind: 'learn', mode: 'merge', kit: ['slot_title'] });

    expect(readFileSync(join(styleDir(), 'style.md'), 'utf8')).toBe(merged);
    expect(readFileSync(join(styleDir(), 'kit', 'slot_title', 'index.html'), 'utf8')).toBe(
      '<h1>Kova</h1>',
    );
    expect(existsSync(join(styleDir(), 'kit', 'slot_old'))).toBe(false);
    expect(
      readFileSync(join(historyKitDirFor(dataDir, CLIENT_ID, 1), 'slot_old', 'index.html'), 'utf8'),
    ).toBe('old graphic');
    expect(clientStyles.get(CLIENT_ID)).toMatchObject({
      state: 'ready',
      version: 2,
      sourceJobId: 'a1b2c3d4e5f6',
    });
  });

  it('takes the characters a rule reads as wildcards literally in the style folder’s path', () => {
    expect(styleLearnAllowedTools('/inbox/Odd [1] * Co?/_Style', 'create')[3]).toBe(
      'Edit(//inbox/Odd \\[1\\] \\* Co\\?/_Style/style.md.new)',
    );
    expect(styleLearnAllowedTools('/inbox/Odd [1] * Co?/_Style', 'merge')[3]).toBe(
      'Read(//inbox/Odd \\[1\\] \\* Co\\?/_Style/style.md)',
    );
  });

  it('lets only a merge read the current style.md; every mode writes style.md.new alone', () => {
    const dir = '/inbox/Kova Coffee/_Style';
    const read = `Read(/${dir}/style.md)`;
    const write = `Edit(/${dir}/style.md.new)`;
    expect(styleLearnAllowedTools(dir, 'merge')).toContain(read);
    for (const mode of ['create', 'replace'] as const) {
      expect(styleLearnAllowedTools(dir, mode)).not.toContain(read);
    }
    for (const mode of ['create', 'merge', 'replace'] as const) {
      const rules = styleLearnAllowedTools(dir, mode);
      expect(rules.filter((rule) => rule.startsWith('Edit('))).toEqual([write]);
      expect(rules.filter((rule) => rule === 'Write' || rule.startsWith('Write('))).toEqual([]);
    }
  });
});

describe('a series pass', () => {
  const JOB = 'Weekly 5';
  const jobDir = () => join(inboxPath, CLIENT, JOB);
  const seriesDir = () => join(inboxPath, CLIENT, '_Series', 'Weekly');
  const START: SeriesPass = {
    kind: 'series',
    mode: 'start',
    seriesId: '622212180eef',
    series: 'Weekly',
    jobId: 'a1b2c3d4e5f6',
    job: JOB,
  };
  const NOTES = [{ name: 'Review notes – Weekly 5 – round 1.md', size: 40 }];

  function seriesRequest(
    pass: SeriesPass,
    writesStyle: boolean,
    controller = new AbortController(),
  ): SeriesRunRequest {
    return {
      clientId: CLIENT_ID,
      client: CLIENT,
      seriesDir: seriesDir(),
      styleDir: styleDir(),
      pass,
      writesStyle,
      signal: controller.signal,
      jobDir: jobDir(),
    };
  }

  function callIn(dir: string): { argv: string[]; cwd: string } {
    return JSON.parse(readFileSync(join(dir, 'stub-claude.call.json'), 'utf8'));
  }

  beforeEach(() => {
    mkdirSync(join(jobDir(), 'edit', 'preview'), { recursive: true });
    writeFileSync(join(jobDir(), 'edit', 'preview', 'index.html'), '<h1>Weekly</h1>');
    mkdirSync(seriesDir(), { recursive: true });
  });

  it('runs a start in the episode’s folder, writing series.md.new and style.md.new by absolute path', async () => {
    writeFileSync(
      join(jobDir(), 'stub-claude.json'),
      JSON.stringify({ lines: [RESULT_LINE('Done.')] }),
    );

    expect(
      await runner().runSeries({ ...seriesRequest(START, true), styleKit: { kind: 'keep' } }),
    ).toEqual({ ok: true });

    const call = callIn(jobDir());
    expect(call.cwd).toBe(realpathSync(jobDir()));
    const prompt = call.argv[1] ?? '';
    expect(prompt).toMatch(/^Write the format of a series from this finished episode,/);
    // Step 5 says what to do with ## Kit, for the kit the engine said it will be (C23).
    expect(prompt).toContain(`Keep ## Kit as it is: the graphics in ${styleDir()}/kit/ stay`);
    expect(prompt).toContain('Client "Kova Coffee", series "Weekly", episode "Weekly 5".');
    expect(prompt).toContain(
      `Write only ${seriesDir()}/series.md.new and ${styleDir()}/style.md.new.`,
    );
    expect(prompt).toContain('“Format from Weekly 5 (2026-10-21).”');
    expect(prompt).toContain(`5. Read ${styleDir()}/style.md, the client’s style.`);
    expect(call.argv[call.argv.indexOf('--allowedTools') + 1]).toBe(
      [
        'Read',
        'Glob',
        'Grep',
        `Read(/${seriesDir()}/kit/**)`,
        `Read(/${styleDir()}/style.md)`,
        `Edit(/${seriesDir()}/series.md.new)`,
        `Edit(/${styleDir()}/style.md.new)`,
        'Bash(ls)',
        'Bash(ls *)',
        'Bash(ffprobe *)',
        'Bash(ffmpeg * -frames:v 1 /tmp/*)',
      ].join(','),
    );
    expect(call.argv.slice(2, 7)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
    ]);
    expect(markers()[0]).toMatchObject({
      event: 'style_start',
      run: 'style',
      kind: 'series',
      mode: 'start',
      seriesId: START.seriesId,
      series: 'Weekly',
      jobId: START.jobId,
      job: JOB,
      writesStyle: true,
      cwd: jobDir(),
    });
    expect(markers().at(-1)).toMatchObject({
      event: 'style_end',
      kind: 'series',
      outcome: 'succeeded',
    });
  });

  it('may touch nothing of the style when the start leaves it alone (or for a new format)', async () => {
    writeFileSync(
      join(jobDir(), 'stub-claude.json'),
      JSON.stringify({ lines: [RESULT_LINE('Done.')] }),
    );

    await runner().runSeries(seriesRequest({ ...START, mode: 'replace' }, false));

    const call = callIn(jobDir());
    expect(call.argv[1]).toContain(`Write only ${seriesDir()}/series.md.new.\n`);
    const tools = call.argv[call.argv.indexOf('--allowedTools') + 1]?.split(',') ?? [];
    expect(tools.filter((tool) => tool.includes('_Style'))).toEqual([]);
    expect(tools.filter((tool) => tool.startsWith('Edit('))).toEqual([
      `Edit(/${seriesDir()}/series.md.new)`,
    ]);
  });

  it('runs an approved episode with Series notes in its folder, reading the notes and series.md (C26)', async () => {
    writeFileSync(
      join(jobDir(), 'stub-claude.json'),
      JSON.stringify({ lines: [RESULT_LINE('Done.')] }),
    );
    const pass: SeriesPass = { ...START, mode: 'replace', notes: NOTES };

    expect(
      await runner().runSeries({
        ...seriesRequest(pass, false),
        notes: { files: NOTES, rounds: '## Round 1\n\n- 0:03 "later": 0.5 s later.' },
      }),
    ).toEqual({ ok: true });

    const call = callIn(jobDir());
    expect(call.cwd).toBe(realpathSync(jobDir()));
    const prompt = call.argv[1] ?? '';
    expect(prompt).toContain(`Write only ${seriesDir()}/series.md.new.\n`);
    expect(prompt).toContain(`- ${seriesDir()}/Review notes – Weekly 5 – round 1.md (40 bytes)`);
    expect(prompt).toContain('## Round 1\n\n- 0:03 "later": 0.5 s later.');
    expect(prompt).toContain('Under ## Notes write each note as a rule with the exact value');
    expect(call.argv[call.argv.indexOf('--allowedTools') + 1]).toBe(
      [
        'Read',
        'Glob',
        'Grep',
        `Read(/${seriesDir()}/kit/**)`,
        `Read(/${seriesDir()}/*.md)`,
        `Edit(/${seriesDir()}/series.md.new)`,
        'Bash(ls)',
        'Bash(ls *)',
        'Bash(ffprobe *)',
        'Bash(ffmpeg * -frames:v 1 /tmp/*)',
      ].join(','),
    );
    expect(markers()[0]).toMatchObject({
      kind: 'series',
      mode: 'replace',
      notes: NOTES,
      rounds: true,
      cwd: jobDir(),
    });
  });

  it('fails with "Series stopped:" texts', async () => {
    writeFileSync(join(jobDir(), 'stub-claude.json'), JSON.stringify({ hang: true }));
    expect(await runner({ timeoutMs: 400 }).runSeries(seriesRequest(START, false))).toEqual({
      ok: false,
      error: SERIES_TIMED_OUT,
    });
    expect(SERIES_TIMED_OUT).toBe('Series stopped: the series took longer than 10 minutes.');

    writeFileSync(
      join(jobDir(), 'stub-claude.json'),
      JSON.stringify({ lines: [RESULT_LINE('Blocked: edit/project.md is missing.')] }),
    );
    expect(await runner().runSeries(seriesRequest(START, false))).toEqual({
      ok: false,
      error: 'Series stopped: edit/project.md is missing.',
    });

    const controller = new AbortController();
    controller.abort('shutdown');
    expect(await runner().runSeries(seriesRequest(START, false, controller))).toEqual({
      ok: false,
      error: 'Series stopped: the series run was stopped.',
    });
  });

  it('goes through the style worker: series.md v1 and the style without the series', async () => {
    writeFileSync(join(styleDir(), 'style.md'), '# Style: Kova Coffee\nLearned from Weekly 5.\n');
    writeFileSync(
      join(jobDir(), 'stub-claude.json'),
      JSON.stringify({
        writeFiles: {
          '../_Series/Weekly/series.md.new':
            '# Series: Weekly\nFormat from Weekly 5 (2026-10-21).\n',
          '../_Style/style.md.new':
            '# Style: Kova Coffee\nLearned from Weekly 5. Moved what only Weekly does into the series (2026-10-21).\n',
        },
        lines: [RESULT_LINE('Done.')],
      }),
    );
    const db = memoryDb();
    const clientStyles = new ClientStyleRepository(db);
    clientStyles.upsert({ clientId: CLIENT_ID, client: CLIENT, state: 'ready', version: 1 });
    const seriesRepo = new SeriesRepository(db);
    const created = seriesRepo.create({
      clientId: CLIENT_ID,
      client: CLIENT,
      name: 'Weekly',
      formatJobId: START.jobId,
      formatJob: JOB,
    });
    const worker = new StyleWorker({ clientStyles, inboxPath, dataDir, runner: runner() });
    worker.attachSeries({ series: seriesRepo, jobs: new JobRepository(db) });
    worker.start();

    worker.enqueueSeries(CLIENT, { ...START, seriesId: created.id });
    await worker.idle();

    expect(seriesRepo.get(created.id)).toMatchObject({ state: 'ready', version: 1, error: null });
    expect(readFileSync(join(seriesDir(), 'series.md'), 'utf8')).toBe(
      '# Series: Weekly\nFormat from Weekly 5 (2026-10-21).\n',
    );
    expect(readFileSync(join(seriesDir(), 'kit', 'index.html'), 'utf8')).toBe('<h1>Weekly</h1>');
    expect(readFileSync(join(styleDir(), 'style.md'), 'utf8')).toMatch(/Moved what only Weekly/);
    expect(clientStyles.get(CLIENT_ID)).toMatchObject({ version: 2 });
  });
});

describe('the series rules', () => {
  it('take the characters a rule reads as wildcards literally in the folders’ paths', () => {
    expect(
      seriesLearnAllowedTools({
        seriesDir: '/inbox/Odd [1] * Co?/_Series/Week*',
        styleDir: '/inbox/Odd [1] * Co?/_Style',
        writesStyle: true,
        readsNotes: true,
      }).filter((rule) => rule.startsWith('Read(') || rule.startsWith('Edit(')),
    ).toEqual([
      'Read(//inbox/Odd \\[1\\] \\* Co\\?/_Series/Week\\*/kit/**)',
      'Read(//inbox/Odd \\[1\\] \\* Co\\?/_Series/Week\\*/*.md)',
      'Read(//inbox/Odd \\[1\\] \\* Co\\?/_Style/style.md)',
      'Edit(//inbox/Odd \\[1\\] \\* Co\\?/_Series/Week\\*/series.md.new)',
      'Edit(//inbox/Odd \\[1\\] \\* Co\\?/_Style/style.md.new)',
    ]);
  });

  it('never allow the Write tool by name, and leave the style runs’ rules as they were', () => {
    const rules = seriesLearnAllowedTools({
      seriesDir: '/s',
      styleDir: '/t',
      writesStyle: true,
      readsNotes: true,
    });
    expect(rules.filter((rule) => rule === 'Write' || rule.startsWith('Write('))).toEqual([]);
    expect(styleReadAllowedTools()).toHaveLength(9);
    expect(styleLearnAllowedTools('/t', 'create')).toHaveLength(8);
  });
});
