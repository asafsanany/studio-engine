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
import { DRAFT_PENDING_BRIEF_SUMMARY } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeRunner, type ClaudeRunnerOptions } from './claude-runner.js';
import type { RunContext } from './runner.js';

// Draft & chat (DR4): with the switch on, an edit run is the Draft. Its prompt starts with /video-use,
// and before it starts the runner writes edit/studio/notes.md and edit/studio/brief-schema.json.
// Revise and render runs, and every run with the switch off, are unchanged. Against the stand-in
// `claude`.

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
  root = mkdtempSync(join(tmpdir(), 'studio-runner-draft-'));
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

const revise = () => makeJob(4, { runKind: 'revise', round: 2 });

describe('the Draft', () => {
  beforeEach(() => {
    scenario();
  });

  it('starts with /video-use and the note, and leaves the rules in edit/studio/', async () => {
    const outcome = await runner({ draftChat: true, music: true }).start(
      makeJob(1, { note: 'Keep it under 35 s.' }),
      'start',
      context(),
    );
    expect(outcome.ok).toBe(true);
    const prompt = promptOf(stubCall());
    expect(prompt.startsWith('/video-use\n')).toBe(true);
    expect(prompt).toContain('> Keep it under 35 s.');
    expect(prompt).not.toContain('Footage quality.');
    const notes = readFileSync(join(jobDir(), 'edit', 'studio', 'notes.md'), 'utf8');
    expect(notes).toContain('Footage quality.');
    expect(notes).toContain('Notes for this machine');
    const schema = JSON.parse(
      readFileSync(join(jobDir(), 'edit', 'studio', 'brief-schema.json'), 'utf8'),
    ) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain('summary');
  });

  it('tells the Draft to read the instructions while the brief is the placeholder', async () => {
    write('edit/brief.json', JSON.stringify({ schema: 1, summary: DRAFT_PENDING_BRIEF_SUMMARY }));
    await runner({ draftChat: true }).start(makeJob(1), 'start', context());
    expect(promptOf(stubCall())).toContain('Nobody has read the client');
  });

  it('leaves a revise run as it was, and an edit run with the switch off', async () => {
    await runner({ draftChat: true }).start(revise(), 'start', context());
    const round = promptOf(stubCall());
    await runner().start(revise(), 'start', context());
    expect(promptOf(stubCall())).toBe(round);

    await runner().start(makeJob(1), 'start', context());
    const edit = promptOf(stubCall());
    expect(edit.startsWith('Edit the footage in this folder with the video-use skill')).toBe(true);
    expect(() => readFileSync(join(jobDir(), 'edit', 'studio', 'notes.md'))).toThrow();
  });
});
