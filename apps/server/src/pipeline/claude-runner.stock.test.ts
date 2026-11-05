import {
  chmodSync,
  copyFileSync,
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
import { STOCK_SCRIPT } from '../stock/stock-assets.js';
import { ClaudeRunner, type ClaudeRunnerOptions } from './claude-runner.js';
import type { RunContext } from './runner.js';

// Stock media (ST4): with the Stock switch on, an edit or revise run is told about the stock script and
// gets the PATH of the env file it reads its keys from (never a key), and may not read that file; a
// render run is told nothing; with the switch off nothing changes. Against the stand-in `claude`.

const STUB = fileURLToPath(new URL('./testdata/stub-claude.mjs', import.meta.url));

let root: string;
let inboxPath: string;
let claudeBin: string;
let envFile: string;
const leftovers: number[] = [];

// Never real: made-up keys that must not turn up in the run's command or environment.
const UNSPLASH_KEY = 'unsplash-test-key-never-passed-0123';
const ELEVENLABS_KEY = 'sk_test_never_passed_0123456789';

const SCRIPTS = { voice: '/scripts/make-voice.mjs', shots: '/scripts/make-shots.mjs' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-runner-stock-'));
  inboxPath = join(root, 'inbox');
  claudeBin = join(root, 'bin', 'claude');
  envFile = join(root, 'repo', '.env');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'repo'), { recursive: true });
  writeFileSync(envFile, `UNSPLASH_ACCESS_KEY=${UNSPLASH_KEY}\n`);
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
function _brief(over: Record<string, unknown> = {}): void {
  write('edit/brief.json', JSON.stringify({ schema: 1, summary: 'x', ...over }));
}

function _spend(entries: Array<{ usd: number; refunded: boolean }>): void {
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
      UNSPLASH_ACCESS_KEY: UNSPLASH_KEY,
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
const render = () => makeJob(7, { runKind: 'render', round: 2 });

describe('the edit and revise runs with Stock on', () => {
  beforeEach(() => {
    scenario();
  });

  it('an edit run is told about the stock script, with its real path', async () => {
    const outcome = await runner({ stock: true }).start(makeJob(1), 'start', context());
    expect(outcome.ok).toBe(true);
    const prompt = promptOf(stubCall());
    expect(prompt).toContain(`node "${STOCK_SCRIPT}" sfx "<edit dir>"`);
    expect(prompt).toContain(`node "${STOCK_SCRIPT}" get "<edit dir>" <ref>`);
    expect(prompt).toContain('Stock media: on this machine');
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });

  it('a revise run gets the shorter part in its list', async () => {
    await runner({ stock: true }).start(revise(), 'start', context());
    const prompt = promptOf(stubCall());
    expect(prompt).toContain(`- Stock media: a note that asks for a sound effect or a photo`);
    expect(prompt).toContain(`node "${STOCK_SCRIPT}"`);
    expect(prompt).not.toContain('Stock media: on this machine');
  });

  it('a render run is told nothing and gets no env file', async () => {
    await runner({ stock: true }).start(render(), 'start', context());
    const call = stubCall();
    expect(promptOf(call)).not.toContain('stock.mjs');
    expect(call.env.STUDIO_ENV_FILE).toBeUndefined();
    expect(denyRules(call)).not.toContain(`Read(/${envFile})`);
  });

  it.each([
    ['an edit run', () => makeJob(1)],
    ['a revise run', () => revise()],
  ])('%s gets the env file’s PATH and never a key', async (_name, job) => {
    await runner({ stock: true }).start(job(), 'start', context());
    const call = stubCall();
    expect(call.env.STUDIO_ENV_FILE).toBe(envFile);
    const everything = JSON.stringify(call.env);
    expect(everything).not.toContain(UNSPLASH_KEY);
    expect(everything).not.toContain(ELEVENLABS_KEY);
    expect(Object.keys(call.env)).not.toContain('UNSPLASH_ACCESS_KEY');
    expect(Object.keys(call.env)).not.toContain('OPENVERSE_CLIENT_SECRET');
    expect(JSON.stringify(call.argv)).not.toContain(UNSPLASH_KEY);
  });

  it('may not read the env file, and is still kept out of the other jobs', async () => {
    mkdirSync(join(inboxPath, 'Pinewood', 'Other job'), { recursive: true });
    await runner({ stock: true }).start(makeJob(1), 'start', context());
    const rules = denyRules(stubCall());
    expect(rules).toContain(`Read(/${envFile})`);
    expect(rules.some((rule) => rule.includes('Other job'))).toBe(true);
  });

  it('works together with the music', async () => {
    await runner({ stock: true, music: true }).start(makeJob(1), 'start', context());
    const prompt = promptOf(stubCall());
    expect(prompt).toContain('make-music.mjs');
    expect(prompt.indexOf('Music: on this machine')).toBeLessThan(
      prompt.indexOf('Stock media: on this machine'),
    );
  });
});

describe('the runs with Stock off', () => {
  beforeEach(() => {
    scenario();
  });

  it.each([
    ['left out', {}],
    ['off', { stock: false }],
  ])(
    '%s: the prompt, the environment and the deny list are what they were',
    async (_name, over) => {
      await runner(over).start(makeJob(1), 'start', context());
      const call = stubCall();
      expect(promptOf(call)).not.toContain('stock.mjs');
      expect(promptOf(call)).not.toContain('Stock media');
      expect(call.env.STUDIO_ENV_FILE).toBeUndefined();
      expect(denyRules(call)).not.toContain(`Read(/${envFile})`);
    },
  );
});
