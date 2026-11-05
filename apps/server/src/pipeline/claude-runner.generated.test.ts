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
import type { Job, StepId } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRunner, type ClaudeRunnerOptions } from './claude-runner.js';
import type { RunContext } from './runner.js';

// Generated videos (GN6): the edit run and the revise run of a job whose brief says `production:
// generate` are told about its footage, and the revise run, which may make a new take with the
// Generate step's two scripts, gets what they need and nothing more. Against the stand-in `claude`.

const STUB = fileURLToPath(new URL('./testdata/stub-claude.mjs', import.meta.url));

let root: string;
let inboxPath: string;
let claudeBin: string;
let envFile: string;
const leftovers: number[] = [];

// Never real: made-up keys that must not turn up in the run's command or environment.
const HIGGSFIELD_KEY = 'hf-test-0000-aaaa:zzzz-secret-value-9999';
const ELEVENLABS_KEY = 'sk_test_never_passed_0123456789';

const SCRIPTS = { voice: '/scripts/make-voice.mjs', shots: '/scripts/make-shots.mjs' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-runner-generated-'));
  inboxPath = join(root, 'inbox');
  claudeBin = join(root, 'bin', 'claude');
  envFile = join(root, 'repo', '.env');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'repo'), { recursive: true });
  writeFileSync(envFile, `HIGGSFIELD_API_KEY=${HIGGSFIELD_KEY}\n`);
  copyFileSync(STUB, claudeBin);
  chmodSync(claudeBin, 0o755);
  mkdirSync(jobDir(), { recursive: true });
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

const JOB_ID = 'b4c1a0deb4c2';

function makeJob(step: StepId | null, overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    clientId: '853479772be4',
    client: 'Pinewood',
    name: 'Window Ad',
    relPath: 'Pinewood/Window Ad',
    state: 'editing',
    step,
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

const jobDir = () => join(inboxPath, 'Pinewood', 'Window Ad');

const GOOD =
  '<!doctype html><html><head><title>x</title></head><body><div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="28.4"></div></body></html>';

/** What the stub run writes before it exits 0: a valid composition. */
function scenario(extra: Record<string, string> = {}): void {
  writeFileSync(
    join(jobDir(), 'stub-claude.json'),
    JSON.stringify({ writeFiles: { 'edit/preview/index.html': GOOD, ...extra } }),
  );
}

function write(path: string, content: string): void {
  const file = join(jobDir(), path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

/** A brief.json the Brief step would have written, as far as the engine reads it. */
function brief(over: Record<string, unknown> = {}): void {
  write('edit/brief.json', JSON.stringify({ schema: 1, summary: 'x', ...over }));
}

function spend(entries: Array<{ usd: number; refunded: boolean }>): void {
  write(
    'edit/generate/spend.json',
    JSON.stringify({
      entries: entries.map((entry, at) => ({
        at: '2026-10-25T10:00:00.000Z',
        kind: 'clip',
        slug: 'alibaba/wan-3.0/image-to-video',
        requestId: `r${at}`,
        ...entry,
      })),
      // The file's own total is never trusted: the entries are summed.
      total: 99,
    }),
  );
}

interface StubCall {
  argv: string[];
  env: Record<string, string>;
  pid: number;
  grandchild?: number;
}

function stubCall(): StubCall {
  const call = JSON.parse(
    readFileSync(join(jobDir(), 'stub-claude.call.json'), 'utf8'),
  ) as StubCall;
  leftovers.push(call.pid);
  return call;
}

function runner(
  over: Partial<ClaudeRunnerOptions['config']> = {},
  options: Partial<ClaudeRunnerOptions> = {},
) {
  return new ClaudeRunner({
    config: {
      inboxPath,
      logsDir: join(root, 'data', 'logs'),
      dataDir: join(root, 'data'),
      claudeBin,
      model: 'opus',
      runTimeoutMin: 90,
      review: true,
      ...over,
    },
    home: join(root, 'home'),
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ELEVENLABS_API_KEY: ELEVENLABS_KEY,
      HIGGSFIELD_API_KEY: HIGGSFIELD_KEY,
      ANTHROPIC_API_KEY: 'sk-ant-test-passed',
    },
    killGraceMs: 2_000,
    sampleIntervalMs: 50,
    generateScripts: SCRIPTS,
    envFile,
    ...options,
  });
}

function context() {
  const controller = new AbortController();
  return { signal: controller.signal, progress: vi.fn() } satisfies RunContext;
}

const promptOf = (call: StubCall) => call.argv[1] as string;

/** The `permissions.deny` rules of the run's --settings. */
function denyRules(call: StubCall): string[] {
  const at = call.argv.indexOf('--settings');
  const settings = JSON.parse(call.argv[at + 1] as string) as {
    permissions?: { deny?: string[] };
  };
  return settings.permissions?.deny ?? [];
}

const revise = (over: Partial<Job> = {}) => makeJob(4, { runKind: 'revise', round: 2, ...over });

describe('the revise run of a generated job', () => {
  beforeEach(() => {
    brief({ production: 'generate', budgetUsd: null });
    spend([
      { usd: 1.5, refunded: false },
      { usd: 0.83, refunded: false },
      { usd: 0.4, refunded: true },
    ]);
    scenario();
  });

  it('is told about the footage, the two scripts and the money left (the refunded take is not spent)', async () => {
    const outcome = await runner().start(revise(), 'start', context());
    expect(outcome.ok).toBe(true);

    const prompt = promptOf(stubCall());
    expect(prompt).toContain(
      'Generated footage: this video has no footage. Its clips and its voice',
    );
    expect(prompt).toContain('The Higgsfield budget for this whole video is $5');
    expect(prompt).toContain('$2.33 is spent and $2.67 is left');
    expect(prompt).toContain('node "/scripts/make-shots.mjs" book');
    expect(prompt).toContain('node "/scripts/make-shots.mjs" save');
    // The retake goes through the Higgsfield connector on the plan’s credits (U26).
    expect(prompt).toContain('mcp__claude_ai_Higgsfield__generate_video');
    expect(prompt).not.toContain('estimate');
    expect(prompt).toContain('node "/scripts/make-voice.mjs" assemble');
    expect(prompt).toContain(`"${join(jobDir(), 'edit')}"`);
  });

  it('gets the env file’s path, the voice and 10-minute Bash timeouts, and never a key', async () => {
    await runner().start(revise(), 'start', context());
    const { env } = stubCall();
    expect(env.STUDIO_ENV_FILE).toBe(envFile);
    expect(env.STUDIO_GENERATE_VOICE_ID).toBe('68RUZBDjLe2YBQvv8zFx');
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('600000');
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('600000');
    expect(env.STUDIO_GENERATE_FAKE).toBeUndefined();
    const everything = JSON.stringify(env);
    expect(everything).not.toContain(HIGGSFIELD_KEY);
    expect(everything).not.toContain('zzzz-secret-value');
    expect(everything).not.toContain(ELEVENLABS_KEY);
    expect(Object.keys(env)).not.toContain('HIGGSFIELD_API_KEY');
    expect(Object.keys(env)).not.toContain('ELEVENLABS_API_KEY');
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
    // Nor the keys in the command line, the prompt included.
    expect(JSON.stringify(stubCall().argv)).not.toContain(HIGGSFIELD_KEY);
    expect(JSON.stringify(stubCall().argv)).not.toContain(ELEVENLABS_KEY);
  });

  it('uses the configured voice', async () => {
    await runner({ generateVoiceId: 'abcdefgh12345678' }).start(revise(), 'start', context());
    expect(stubCall().env.STUDIO_GENERATE_VOICE_ID).toBe('abcdefgh12345678');
  });

  it('may not read the two key files, and is still kept out of the other jobs', async () => {
    mkdirSync(join(inboxPath, 'Pinewood', 'Other job'), { recursive: true });
    await runner().start(revise(), 'start', context());
    const rules = denyRules(stubCall());
    expect(rules).toContain(`Read(/${envFile})`);
    expect(rules).toContain(`Read(/${join(root, 'home', 'Developer', 'video-use', '.env')})`);
    expect(rules.some((rule) => rule.includes('Other job'))).toBe(true);
  });

  it('has the tools of any revise run (Bash is open, as the scripts need) plus the Higgsfield connector for retakes (U26)', async () => {
    await runner().start(revise(), 'start', context());
    const argv = stubCall().argv;
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Bash,Read,Write,Edit,Skill,Task,ToolSearch');
    const allowed = (argv[argv.indexOf('--allowedTools') + 1] ?? '').split(' ');
    expect(allowed).toEqual(
      expect.arrayContaining([
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Skill',
        'Task',
        'ToolSearch',
        'mcp__claude_ai_Higgsfield__generate_video',
      ]),
    );
    // The connector is a claude.ai connector, so strict mode is off for this run only.
    expect(argv).not.toContain('--strict-mcp-config');
  });

  it('takes the budget the Generate step stored on the job first', async () => {
    const generate = {
      phase: 'done',
      counts: {
        voice: { done: 7, total: 7 },
        looks: { done: 3, total: 3 },
        keyframes: { done: 7, total: 7 },
        clips: { done: 6, total: 6 },
        belowBar: 0,
      },
      spendUsd: 2.33,
      budgetUsd: 5,
    } as const;
    await runner({ generateBudgetUsd: 4 }).start(revise({ generate }), 'start', context());
    const prompt = promptOf(stubCall());
    expect(prompt).toContain('budget for this whole video is $5');
    expect(prompt).toContain('$2.33 is spent and $2.67 is left');
    expect(prompt).toContain('--budget 5');
  });

  it('a budget the brief names wins over the one stored on the job, so a note can raise it (C77)', async () => {
    brief({ production: 'generate', budgetUsd: 4 });
    const generate = {
      phase: 'done',
      counts: {
        voice: { done: 7, total: 7 },
        looks: { done: 3, total: 3 },
        keyframes: { done: 7, total: 7 },
        clips: { done: 6, total: 6 },
        belowBar: 0,
      },
      spendUsd: 2.33,
      budgetUsd: 3,
    } as const;
    await runner().start(revise({ generate }), 'start', context());
    const prompt = promptOf(stubCall());
    expect(prompt).toContain('budget for this whole video is $4');
    expect(prompt).toContain('$2.33 is spent and $1.67 is left');
    expect(prompt).toContain('--budget 4');
  });

  it('else the brief’s own budget, else the configured one, else $5', async () => {
    brief({ production: 'generate', budgetUsd: 6 });
    await runner({ generateBudgetUsd: 4 }).start(revise(), 'start', context());
    expect(promptOf(stubCall())).toContain('budget for this whole video is $6');

    rmSync(join(jobDir(), 'stub-claude.call.json'));
    brief({ production: 'generate', budgetUsd: null });
    await runner({ generateBudgetUsd: 4 }).start(revise(), 'start', context());
    expect(promptOf(stubCall())).toContain('budget for this whole video is $4');

    rmSync(join(jobDir(), 'stub-claude.call.json'));
    await runner().start(revise(), 'start', context());
    expect(promptOf(stubCall())).toContain('budget for this whole video is $5');
  });

  it('with no spend.json yet, nothing is spent', async () => {
    rmSync(join(jobDir(), 'edit', 'generate'), { recursive: true });
    await runner().start(revise(), 'start', context());
    expect(promptOf(stubCall())).toContain('$0 is spent and $5 is left');
  });

  it('the prompt is read again for every run: a round that spent more says so', async () => {
    await runner().start(revise(), 'start', context());
    expect(promptOf(stubCall())).toContain('$2.67 is left');
    rmSync(join(jobDir(), 'stub-claude.call.json'));
    spend([
      { usd: 1.5, refunded: false },
      { usd: 0.83, refunded: false },
      { usd: 0.51, refunded: false },
    ]);
    await runner().start(revise({ round: 3 }), 'start', context());
    expect(promptOf(stubCall())).toContain('$2.84 is spent and $2.16 is left');
  });
});

describe('the edit run of a generated job', () => {
  beforeEach(() => {
    brief({ production: 'generate', budgetUsd: null });
    spend([{ usd: 2.33, refunded: false }]);
    scenario();
  });

  it.each(['start', 'resume', 'retry'] as const)(
    '%s: is told about the footage, and spends nothing: no scripts, no key file, no timeouts',
    async (mode) => {
      const outcome = await runner().start(makeJob(2), mode, context());
      expect(outcome.ok).toBe(true);

      const call = stubCall();
      const prompt = promptOf(call);
      expect(prompt).toContain(
        'Generated footage: this video has no footage. Its clips, its voice',
      );
      expect(prompt).toContain('Do not transcribe it again');
      expect(prompt).not.toContain('make-shots.mjs');
      expect(prompt).not.toContain('make-voice.mjs');
      expect(prompt).not.toContain('is spent and');
      expect(call.env.STUDIO_ENV_FILE).toBeUndefined();
      expect(call.env.STUDIO_GENERATE_VOICE_ID).toBeUndefined();
      expect(call.env.BASH_DEFAULT_TIMEOUT_MS).toBeUndefined();
      expect(denyRules(call).some((rule) => rule.includes('.env'))).toBe(false);
    },
  );
});

describe('any other run', () => {
  it('a footage job’s edit and revise runs have the prompts and the environment they always had', async () => {
    // No brief at all, then a brief that says footage, then one that says nothing.
    for (const brief_ of [undefined, { production: 'footage' }, { production: null }]) {
      if (brief_ !== undefined) brief(brief_);
      for (const job of [makeJob(2), revise()]) {
        scenario();
        rmSync(join(jobDir(), 'stub-claude.call.json'), { force: true });
        await runner().start(job, 'start', context());
        const call = stubCall();
        expect(promptOf(call)).not.toContain('Generated footage');
        expect(promptOf(call)).not.toContain('voice-words.json');
        expect(call.env.STUDIO_ENV_FILE).toBeUndefined();
        expect(call.env.BASH_MAX_TIMEOUT_MS).toBeUndefined();
        expect(denyRules(call).some((rule) => rule.includes('.env'))).toBe(false);
      }
    }
  });

  it('a render run of a generated job is told nothing and gets no scripts’ settings', async () => {
    brief({ production: 'generate', budgetUsd: null });
    write('edit/final.mp4', 'x');
    writeFileSync(join(jobDir(), 'stub-claude.json'), JSON.stringify({ writeFinal: true }));
    await runner().start(makeJob(8, { runKind: 'render', round: 1 }), 'start', context());
    const call = stubCall();
    expect(promptOf(call)).not.toContain('Generated footage');
    expect(call.env.STUDIO_ENV_FILE).toBeUndefined();
    expect(call.env.BASH_MAX_TIMEOUT_MS).toBeUndefined();
  });

  it('a brief.json that does not parse is a footage job', async () => {
    write('edit/brief.json', '{ nope');
    scenario();
    await runner().start(revise(), 'start', context());
    expect(promptOf(stubCall())).not.toContain('Generated footage');
    expect(existsSync(join(jobDir(), 'stub-claude.call.json'))).toBe(true);
  });
});
