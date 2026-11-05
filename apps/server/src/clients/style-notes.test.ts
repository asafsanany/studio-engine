import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Job, type ReviewNote, renderStyleNotesFile, type ServerEvent } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientStyleRepository, JobRepository, toClientStyle } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import type { Timers } from '../inbox/watcher.js';
import type { Sleep } from '../pipeline/fake-runner.js';
import { FakeStyleRunner } from './fake-style.js';
import { StyleDrops } from './style-drops.js';
import { createStyleNotes } from './style-notes.js';
import type { StylePass } from './style-pass.js';
import type { StyleRunner, StyleRunOutcome, StyleRunRequest } from './style-run.js';
import { StyleWorker } from './style-worker.js';

// Add to style (Phase 3 §7, W7) on the real repositories (in memory), a temp inbox, the real style
// worker and the Finder drops on hand-driven timers. The style runs are the fake style runner (the
// one `STUDIO_RUNNER=fake` uses), held where a test needs to look between two runs.

const CLIENT = 'מאפיית הצפון';
const JOB = 'פרומו לסוף השבוע';
const SENT_AT = '2026-10-21T10:00:00.000Z';
const SETTLE_MS = 60_000;

/** The files of a Read pass (a Learn pass has none). */
const readFiles = (pass: StylePass | undefined) => (pass?.kind === 'read' ? pass.files : []);

/** The file the notes are written to, as W16 names it. */
const NOTES_FILE = `Review notes – ${JOB} – round 1.md`;
const NOTES_FILE_TAKEN = `Review notes – ${JOB} – round 1 (1).md`;

const GOLDEN = fileURLToPath(
  new URL('../../../../packages/shared/src/review/fixtures/bakery-style-notes.md', import.meta.url),
);

let root: string;
let inboxPath: string;
let jobs: JobRepository;
let clientStyles: ClientStyleRepository;
let published: ServerEvent[];
let runner: HeldFakeStyleRunner;
let worker: StyleWorker;
let timers: HandTimers;
let dropped: string[];
let drops: StyleDrops;
let warnings: { obj: object; msg: string }[];
let hook: ReturnType<typeof createStyleNotes>;
let job: Job;

/** Timers the test fires by hand. */
class HandTimers implements Timers {
  readonly pending = new Map<number, () => void>();
  private next = 1;
  setTimeout(callback: () => void): unknown {
    this.pending.set(this.next, callback);
    return this.next++;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fireAll(): void {
    for (const [handle, callback] of [...this.pending]) {
      this.pending.delete(handle);
      callback();
    }
  }
}

/** The fake style runner, which can be held at its waiting until the test lets it go. */
class HeldFakeStyleRunner implements StyleRunner {
  held = false;
  readonly runs: StyleRunRequest[] = [];
  active = 0;
  maxActive = 0;
  private readonly releases: (() => void)[] = [];
  /** Releases that came before the run was waiting. */
  private permits = 0;
  private readonly fake = new FakeStyleRunner({
    sleep: (ms, signal) => this.wait(ms, signal),
    clock: () => new Date(2026, 9, 21, 12),
  });

  private wait: Sleep = (_ms, signal) => {
    if (!this.held) return Promise.resolve();
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.releases.push(resolve);
      signal.addEventListener('abort', () => resolve());
    });
  };

  async run(request: StyleRunRequest): Promise<StyleRunOutcome> {
    this.runs.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.fake.run(request);
    } finally {
      this.active -= 1;
    }
  }

  /** Lets the run that is waiting go on. */
  release(): void {
    const waiting = this.releases.shift();
    if (waiting === undefined) this.permits += 1;
    else waiting();
  }

  /** Waits until `count` runs have started. */
  async started(count: number): Promise<void> {
    await vi.waitFor(() => expect(this.runs.length).toBeGreaterThanOrEqual(count));
    expect(this.runs).toHaveLength(count);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-style-notes-'));
  inboxPath = join(root, 'inbox');
  const db = memoryDb();
  jobs = new JobRepository(db);
  clientStyles = new ClientStyleRepository(db);
  published = [];
  const bus = createEventBus();
  bus.subscribe((event) => published.push(event));
  runner = new HeldFakeStyleRunner();
  worker = new StyleWorker({
    clientStyles,
    inboxPath,
    dataDir: join(root, 'data'),
    runner,
    onChanged: (style) => bus.publish({ type: 'client.upsert', style: toClientStyle(style) }),
  });
  timers = new HandTimers();
  dropped = [];
  drops = new StyleDrops({
    inboxPath,
    settleMs: SETTLE_MS,
    timers,
    enqueue: async (_client, pass) => {
      dropped.push(...pass.files.map((file) => file.name));
    },
  });
  warnings = [];
  hook = createStyleNotes({
    styleFiles: { inboxPath, clientStyles, worker, uploads: drops },
    logger: {
      info: () => {},
      warn: (obj, msg) => warnings.push({ obj, msg }),
      error: () => {},
    },
  });
  // The client's folder, with the job in it, as the scanner leaves it.
  mkdirSync(join(inboxPath, CLIENT, JOB), { recursive: true });
  mkdirSync(styleDir(), { recursive: true });
  job = { ...jobs.upsertFromScan(makeScan(CLIENT, JOB)).job, round: 1 };
});

afterEach(async () => {
  runner.held = false;
  for (let i = 0; i < 10; i++) runner.release();
  await worker.stop();
  drops.stop();
  rmSync(root, { recursive: true, force: true });
});

const styleDir = () => join(inboxPath, CLIENT, '_Style');
const listStyleDir = () => readdirSync(styleDir()).sort();
const readStyleFile = (name: string) => readFileSync(join(styleDir(), name), 'utf8');
const styleOfJob = () => clientStyles.get(job.clientId);
const upserts = () => published.filter((event) => event.type === 'client.upsert');

/** W16's bakeryStyle notes: a Hebrew text note, a voice note with its transcript, an English text note and a voice note that failed. */
function bakeryNotes(): ReviewNote[] {
  const note = (overrides: Partial<ReviewNote>): ReviewNote => ({
    id: `n${Math.random()}`,
    jobId: job.id,
    round: 1,
    atSec: 0,
    kind: 'text',
    text: 'A note.',
    audioFile: null,
    audioSec: null,
    transcriptStatus: null,
    addToStyle: true,
    addToSeries: false,
    createdAt: SENT_AT,
    sentAt: SENT_AT,
    routeStatus: null,
    route: null,
    fixId: null,
    fixedAt: null,
    ...overrides,
  });
  return [
    note({ atSec: 21, text: 'End card: keep the logo up for two seconds.' }),
    note({
      atSec: 7.8,
      kind: 'voice',
      text: 'כאן הכתוביות מכסות את הידיים של יוסי. להעלות אותן קצת, או לבחור שוט אחר.',
      audioFile: 'edit/review/voice/n2.webm',
      audioSec: 6,
      transcriptStatus: 'done',
    }),
    note({ atSec: 2.43, text: 'הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.' }),
    note({
      atSec: 12,
      kind: 'voice',
      text: null,
      audioFile: 'edit/review/voice/n4.webm',
      audioSec: 5,
      transcriptStatus: 'failed',
    }),
  ];
}

describe('the style-notes file', () => {
  it('is written into the client’s _Style as W16 renders it', async () => {
    await hook.append(job, bakeryNotes());

    expect(listStyleDir()).toEqual([NOTES_FILE]);
    const text = readStyleFile(NOTES_FILE);
    expect(text).toBe(renderStyleNotesFile({ job: JOB, round: 1, notes: bakeryNotes() }));
    expect(text).toBe(readFileSync(GOLDEN, 'utf8'));
    expect(text.startsWith(`# Review notes from ${JOB} (round 1)\n`)).toBe(true);
    expect(text).toContain('- 0:02.4 — הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.');
    expect(text).toContain(
      '- 0:07.8 — כאן הכתוביות מכסות את הידיים של יוסי. להעלות אותן קצת, או לבחור שוט אחר.',
    );
    expect(text).toContain('- 0:21.0 — End card: keep the logo up for two seconds.');
    expect(text).not.toContain('0:12.0');
  });

  it('takes the next free name when its own is taken, and leaves the first file as it was', async () => {
    writeFileSync(join(styleDir(), NOTES_FILE), 'The owner’s own notes.\n');

    await hook.append(job, bakeryNotes());

    expect(listStyleDir()).toEqual([NOTES_FILE_TAKEN, NOTES_FILE].sort());
    expect(readStyleFile(NOTES_FILE)).toBe('The owner’s own notes.\n');
    expect(readStyleFile(NOTES_FILE_TAKEN)).toBe(
      renderStyleNotesFile({ job: JOB, round: 1, notes: bakeryNotes() }),
    );
    expect(styleOfJob()?.lastPass).toMatchObject({ files: [{ name: NOTES_FILE_TAKEN }] });
  });

  it('leaves nothing but the file behind: no staging folder', async () => {
    await hook.append(job, bakeryNotes());

    expect(readdirSync(styleDir(), { withFileTypes: true }).map((e) => e.name)).toEqual([
      NOTES_FILE,
    ]);
  });
});

describe('the Read pass', () => {
  it('is exactly one, in create mode while there is no style.md, with exactly that file', async () => {
    await hook.append(job, bakeryNotes());

    const style = styleOfJob();
    expect(style).toMatchObject({ state: 'analysing', version: 0, error: null });
    expect(style?.lastPass).toEqual({
      kind: 'read',
      mode: 'create',
      files: [{ name: NOTES_FILE, size: Buffer.byteLength(readStyleFile(NOTES_FILE)) }],
    });
    expect(upserts()).toHaveLength(1);
    expect(upserts()[0]).toMatchObject({
      style: { clientId: job.clientId, client: CLIENT, state: 'analysing' },
    });
    // The worker was not started: nothing ran, and nothing else is queued.
    expect(runner.runs).toEqual([]);
  });

  it('is in add mode when the client already has a style.md', async () => {
    writeFileSync(
      join(styleDir(), 'style.md'),
      `# Style: ${CLIENT}\nFrom your files: notes.txt.\n`,
    );

    await hook.append(job, bakeryNotes());

    expect(styleOfJob()?.lastPass).toEqual({
      kind: 'read',
      mode: 'add',
      files: [{ name: NOTES_FILE, size: Buffer.byteLength(readStyleFile(NOTES_FILE)) }],
    });
  });

  it('turns the notes into the client’s style once the worker runs it', async () => {
    writeFileSync(
      join(styleDir(), 'style.md'),
      `# Style: ${CLIENT}\nFrom your files: notes.txt.\n`,
    );
    worker.start();

    await hook.append(job, bakeryNotes());
    await worker.idle();

    expect(styleOfJob()).toMatchObject({ state: 'ready', version: 1, error: null });
    expect(readStyleFile('style.md').split('\n')[1]).toContain(`Plus ${NOTES_FILE} (2026-10-21)`);
  });

  it('is not queued when no note has anything to turn into a rule', async () => {
    const failedVoiceOnly = bakeryNotes().filter((note) => note.atSec === 12);

    await hook.append(job, failedVoiceOnly);

    expect(listStyleDir()).toEqual([]);
    expect(styleOfJob()).toBeNull();
    expect(upserts()).toEqual([]);
    expect(runner.runs).toEqual([]);
  });
});

describe('while the client’s style is being analysed', () => {
  async function analysing(): Promise<void> {
    writeFileSync(join(styleDir(), 'brand.txt'), 'Use green.');
    runner.held = true;
    worker.start();
    await worker.enqueue(CLIENT, {
      kind: 'read',
      mode: 'add',
      files: [{ name: 'brand.txt', size: 10 }],
    });
    await runner.started(1);
  }

  it('queues the pass behind the running one: no 409, never two at a time, analysing until both are done', async () => {
    await analysing();

    await expect(hook.append(job, bakeryNotes())).resolves.toBeUndefined();

    // Still the first run only; the notes wait, and the client is analysing.
    expect(runner.runs).toHaveLength(1);
    expect(readFiles(runner.runs[0]?.pass).map((file) => file.name)).toEqual(['brand.txt']);
    expect(listStyleDir()).toContain(NOTES_FILE);
    expect(styleOfJob()?.state).toBe('analysing');
    expect(warnings).toEqual([]);

    runner.release();
    await runner.started(2);
    // The first style is in place, the second run is going: not ready yet.
    expect(styleOfJob()).toMatchObject({ state: 'analysing', version: 1 });
    expect(runner.runs[1]?.pass).toMatchObject({
      mode: 'add',
      files: [{ name: NOTES_FILE }],
    });

    runner.release();
    await worker.idle();

    expect(styleOfJob()).toMatchObject({ state: 'ready', version: 2, error: null });
    expect(runner.maxActive).toBe(1);
    expect(readStyleFile('style.md')).toContain(`Plus ${NOTES_FILE}`);
  });

  it('joins a pass that is already waiting, so no file is left out', async () => {
    await analysing();
    writeFileSync(join(styleDir(), 'logo.txt'), 'A green leaf.');
    await worker.enqueue(CLIENT, {
      kind: 'read',
      mode: 'add',
      files: [{ name: 'logo.txt', size: 13 }],
    });

    await hook.append(job, bakeryNotes());

    runner.release();
    await runner.started(2);
    expect(
      readFiles(runner.runs[1]?.pass)
        .map((file) => file.name)
        .sort(),
    ).toEqual(['logo.txt', NOTES_FILE].sort());
    runner.release();
    await worker.idle();
    expect(runner.maxActive).toBe(1);
  });
});

describe('Send', () => {
  it('gets its answer once the pass is queued, before the Read pass has run', async () => {
    runner.held = true;
    worker.start();

    await hook.append(job, bakeryNotes());

    expect(styleOfJob()).toMatchObject({ state: 'analysing', version: 0 });
    expect(readdirSync(styleDir())).not.toContain('style.md');

    runner.release();
    await worker.idle();
    expect(styleOfJob()).toMatchObject({ state: 'ready', version: 1 });
  });

  it('is not failed by a style that can’t take the file: append logs it and resolves, nothing is queued', async () => {
    rmSync(styleDir(), { recursive: true });
    writeFileSync(styleDir(), 'not a folder');

    await expect(hook.append(job, bakeryNotes())).resolves.toBeUndefined();

    const logged = warnings.filter(
      (warning) => warning.msg === 'could not add the review notes to the style',
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]?.obj).toMatchObject({ jobId: job.id, clientId: job.clientId });
    expect(styleOfJob()).toBeNull();
    expect(upserts()).toEqual([]);
  });

  it('is not failed by a client folder that is gone: it is not made again', async () => {
    rmSync(join(inboxPath, CLIENT), { recursive: true });

    await expect(hook.append(job, bakeryNotes())).resolves.toBeUndefined();

    expect(warnings.map((warning) => warning.msg)).toEqual([
      'could not add the review notes to the style',
    ]);
    expect(() => readdirSync(join(inboxPath, CLIENT))).toThrow();
  });

  it('is not failed by a Read pass that fails: it shows as the client’s failed style', async () => {
    writeFileSync(join(styleDir(), '.fail-style'), '');
    worker.start();

    await expect(hook.append(job, bakeryNotes())).resolves.toBeUndefined();
    await worker.idle();

    const style = styleOfJob();
    expect(style?.state).toBe('failed');
    expect(style?.error).toMatch(/^Style stopped: /);
    expect(style?.lastPass).toMatchObject({ files: [{ name: NOTES_FILE }] });
    expect(warnings).toEqual([]);
  });
});

describe('the Finder watcher', () => {
  it('does not queue a second pass for the file the notes wrote', async () => {
    await hook.append(job, bakeryNotes());

    // The events the file causes in _Style, as the inbox watcher passes them on.
    drops.notify({ kind: 'add', client: CLIENT, path: NOTES_FILE });
    drops.notify({ kind: 'change', client: CLIENT, path: NOTES_FILE });
    expect(timers.pending.size).toBe(1);
    timers.fireAll();
    await drops.whenIdle();

    expect(dropped).toEqual([]);
  });

  it('still queues a file somebody dropped next to it', async () => {
    await hook.append(job, bakeryNotes());
    writeFileSync(join(styleDir(), 'logo.png'), 'png');

    drops.notify({ kind: 'add', client: CLIENT, path: NOTES_FILE });
    drops.notify({ kind: 'add', client: CLIENT, path: 'logo.png' });
    timers.fireAll();
    await drops.whenIdle();

    expect(dropped).toEqual(['logo.png']);
  });
});
