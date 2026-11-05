import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noInstructionsBrief, renderBriefMd } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientStyleRepository, type StoredClientStyle, toClientStyle } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import { historyDirFor, historyFileFor, historyKitDirFor, historySourceFileFor } from './paths.js';
import { STYLE_BAD_TITLE, STYLE_MISSING } from './style-install.js';
import type { LearnPass, ReadPass, StylePass } from './style-pass.js';
import type { StyleRunner, StyleRunOutcome, StyleRunRequest } from './style-run.js';
import { NOTHING_TO_RERUN, StyleRefusedError, StyleWorker, UNDO_REASON } from './style-worker.js';

// The style worker on the real repository (in memory) and a temp inbox. The runner is a stand-in
// the tests script: it writes style.md.new, fails, or waits to be let go.

const KOVA = 'Kova Coffee';
const ARC = 'Arc Fitness';

let root: string;
let inboxPath: string;
let dataDir: string;
let clientStyles: ClientStyleRepository;
let changes: StoredClientStyle[];
let runner: TestRunner;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-style-worker-'));
  inboxPath = join(root, 'inbox');
  dataDir = join(root, 'data');
  clientStyles = new ClientStyleRepository(memoryDb());
  changes = [];
  runner = new TestRunner();
  for (const client of [KOVA, ARC]) mkdirSync(styleDir(client), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const styleDir = (client: string) => join(inboxPath, client, '_Style');
const write = (client: string, name: string, text = 'x') =>
  writeFileSync(join(styleDir(client), name), text);
const read = (client: string, name: string) => readFileSync(join(styleDir(client), name), 'utf8');
const styleOf = (client: string) => clientStyles.get(clientIdFor(client));

function pass(mode: ReadPass['mode'], ...names: string[]): ReadPass {
  return { kind: 'read', mode, files: names.map((name) => ({ name, size: 1 })) };
}

const filesOf = (run: StylePass) => (run.kind === 'read' ? run.files : []);

interface Gate {
  request: StyleRunRequest;
  release: (outcome?: StyleRunOutcome) => void;
}

/** Writes `# Style: <client>` + a line per run, unless told otherwise; can hold runs until let go. */
class TestRunner implements StyleRunner {
  readonly calls: StyleRunRequest[] = [];
  readonly gates: Gate[] = [];
  /** What the next runs do, in order; then the default (write a good style). */
  readonly script: ((request: StyleRunRequest) => Promise<StyleRunOutcome>)[] = [];
  hold = false;
  active = 0;
  maxActive = 0;

  async run(request: StyleRunRequest): Promise<StyleRunOutcome> {
    this.calls.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.hold) {
        const outcome = await new Promise<StyleRunOutcome | undefined>((resolve) => {
          this.gates.push({ request, release: resolve });
          request.signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped' }));
        });
        if (outcome !== undefined) return outcome;
      }
      const step = this.script.shift();
      return step ? await step(request) : await writeGood(request);
    } finally {
      this.active -= 1;
    }
  }

  /** Waits until `count` runs have started. */
  async started(count: number): Promise<void> {
    for (let i = 0; i < 200 && this.calls.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(this.calls.length).toBe(count);
  }
}

async function writeGood({ client, styleDir: dir, pass: run }: StyleRunRequest) {
  writeFileSync(
    join(dir, 'style.md.new'),
    `# Style: ${client}\n${run.mode} from ${run.kind === 'read' ? run.files.map((file) => file.name).join(', ') : run.job}\n`,
  );
  return { ok: true } as const;
}

function worker(): StyleWorker {
  return new StyleWorker({
    clientStyles,
    inboxPath,
    dataDir,
    runner,
    onChanged: (style) => changes.push(style),
  });
}

describe('queuing', () => {
  it('marks the client analysing at once, stores the pass and publishes the change', async () => {
    write(KOVA, 'logo.png');
    const styles = worker();

    const queued = await styles.enqueue(KOVA, pass('add', 'logo.png'));

    expect(queued).toMatchObject({ client: KOVA, state: 'analysing', version: 0, error: null });
    // No style.md yet: the add pass is stored as create.
    expect(queued.lastPass).toEqual(pass('create', 'logo.png'));
    expect(changes.map((style) => style.state)).toEqual(['analysing']);
    // Not started: nothing runs.
    expect(runner.calls).toEqual([]);
  });

  it('runs one pass at a time, in the order they came, apart from anything else', async () => {
    write(KOVA, 'logo.png');
    write(ARC, 'notes.txt');
    runner.hold = true;
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('add', 'logo.png'));
    await styles.enqueue(ARC, pass('add', 'notes.txt'));
    await runner.started(1);
    expect(runner.calls[0]?.client).toBe(KOVA);
    expect(styles.activeClientId).toBe(clientIdFor(KOVA));
    expect(styleOf(ARC)?.state).toBe('analysing');

    runner.gates[0]?.release();
    await runner.started(2);
    expect(runner.calls[1]?.client).toBe(ARC);
    runner.gates[1]?.release();
    await styles.idle();

    expect(runner.maxActive).toBe(1);
    expect(styleOf(KOVA)?.state).toBe('ready');
    expect(styleOf(ARC)?.state).toBe('ready');
  });
});

describe('installing', () => {
  it('keeps the old style.md in history, adds 1 to the version and is ready', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nversion two\n');
    write(KOVA, 'logo.png');
    clientStyles.upsert({ clientId: clientIdFor(KOVA), client: KOVA, state: 'ready', version: 2 });
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('replace', 'logo.png'));
    await styles.idle();

    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nreplace from logo.png\n');
    expect(existsSync(join(styleDir(KOVA), 'style.md.new'))).toBe(false);
    expect(readFileSync(historyFileFor(dataDir, clientIdFor(KOVA), 2), 'utf8')).toBe(
      '# Style: Kova Coffee\nversion two\n',
    );
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 3, error: null });
    expect(changes.map((style) => [style.state, style.version])).toEqual([
      ['analysing', 2],
      ['ready', 3],
    ]);
  });

  it('runs create without a style.md, and add or replace with one, as asked', async () => {
    write(KOVA, 'a.png');
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('replace', 'a.png'));
    await styles.idle();
    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await styles.idle();
    await styles.enqueue(KOVA, pass('replace', 'a.png'));
    await styles.idle();

    expect(runner.calls.map((call) => call.pass.mode)).toEqual(['create', 'add', 'replace']);
    expect(styleOf(KOVA)?.version).toBe(3);
  });

  it('keeps the job a look was learned from when files are added, not when the style is replaced', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\n');
    write(KOVA, 'a.png');
    const id = clientIdFor(KOVA);
    clientStyles.upsert({
      clientId: id,
      client: KOVA,
      state: 'ready',
      version: 1,
      sourceJobId: 'job1',
    });
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await styles.idle();
    expect(styleOf(KOVA)?.sourceJobId).toBe('job1');

    await styles.enqueue(KOVA, pass('replace', 'a.png'));
    await styles.idle();
    expect(styleOf(KOVA)?.sourceJobId).toBeNull();
  });
});

describe('failing', () => {
  it('fails when the run wrote no style.md.new, keeping the pass for Retry', async () => {
    write(KOVA, 'a.png');
    runner.script.push(async () => ({ ok: true }));
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await styles.idle();

    expect(styleOf(KOVA)).toMatchObject({
      state: 'failed',
      version: 0,
      error: STYLE_MISSING,
      lastPass: pass('create', 'a.png'),
    });
  });

  it('fails when style.md.new does not start with the title, and style.md stays as it was', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nold\n');
    write(KOVA, 'a.png');
    clientStyles.upsert({ clientId: clientIdFor(KOVA), client: KOVA, state: 'ready', version: 1 });
    runner.script.push(async ({ styleDir: dir }) => {
      writeFileSync(join(dir, 'style.md.new'), 'Sure! Here it is.\n');
      return { ok: true };
    });
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await styles.idle();

    expect(styleOf(KOVA)).toMatchObject({ state: 'failed', version: 1, error: STYLE_BAD_TITLE });
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nold\n');
    expect(existsSync(historyFileFor(dataDir, clientIdFor(KOVA), 1))).toBe(false);
  });

  it("fails with the run's own reason (a timeout, a Blocked: line)", async () => {
    write(KOVA, 'a.png');
    runner.script.push(async () => ({
      ok: false,
      error: 'Style stopped: the style took longer than 10 minutes.',
    }));
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await styles.idle();

    expect(styleOf(KOVA)).toMatchObject({
      state: 'failed',
      error: 'Style stopped: the style took longer than 10 minutes.',
    });
    expect(changes.at(-1)?.state).toBe('failed');
  });

  it('never takes a style.md.new an earlier run left for this run’s work', async () => {
    write(KOVA, 'a.png');
    write(KOVA, 'style.md.new', '# Style: Kova Coffee\nleft over\n');
    runner.script.push(async () => ({ ok: true }));
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await styles.idle();

    expect(styleOf(KOVA)?.error).toBe(STYLE_MISSING);
    expect(existsSync(join(styleDir(KOVA), 'style.md'))).toBe(false);
  });
});

describe('retry', () => {
  it('is refused unless the style failed', async () => {
    const styles = worker();
    await expect(styles.retry(KOVA)).rejects.toThrow(StyleRefusedError);
    clientStyles.upsert({ clientId: clientIdFor(KOVA), client: KOVA, state: 'ready', version: 1 });
    await expect(styles.retry(KOVA)).rejects.toThrow(/has not failed/);
  });

  it('runs the failed pass again, and the style is made once the cause is gone', async () => {
    write(KOVA, 'a.png');
    write(KOVA, 'b.txt');
    runner.script.push(async () => ({ ok: false, error: 'Style stopped: injected failure' }));
    const styles = worker();
    styles.start();
    await styles.enqueue(KOVA, pass('add', 'a.png', 'b.txt'));
    await styles.idle();
    expect(styleOf(KOVA)?.state).toBe('failed');

    const retried = await styles.retry(KOVA);
    expect(retried).toMatchObject({ state: 'analysing', error: null });
    await styles.idle();

    expect(runner.calls.at(-1)?.pass).toEqual({
      kind: 'read',
      mode: 'create',
      files: [
        { name: 'a.png', size: 1 },
        { name: 'b.txt', size: 1 },
      ],
    });
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 1, error: null });
  });

  it('is refused for a failure with nothing stored to run again', async () => {
    clientStyles.upsert({
      clientId: clientIdFor(KOVA),
      client: KOVA,
      state: 'failed',
      error: 'Style stopped: x',
    });
    await expect(worker().retry(KOVA)).rejects.toThrow(/cannot be run again/);
  });
});

describe('boot and shutdown', () => {
  it('runs the last_pass of every client left analysing again at the next start', async () => {
    write(KOVA, 'logo.png');
    clientStyles.upsert({
      clientId: clientIdFor(KOVA),
      client: KOVA,
      state: 'analysing',
      lastPass: pass('create', 'logo.png'),
    });
    clientStyles.upsert({ clientId: clientIdFor(ARC), client: ARC, state: 'ready', version: 1 });
    const styles = worker();

    styles.start();
    await styles.idle();

    expect(runner.calls.map((call) => [call.client, call.pass])).toEqual([
      [KOVA, { kind: 'read', mode: 'create', files: [{ name: 'logo.png', size: 1 }] }],
    ]);
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 1 });
    expect(styleOf(ARC)).toMatchObject({ state: 'ready', version: 1 });
  });

  it('fails a client left analysing with nothing it could run again', async () => {
    clientStyles.upsert({ clientId: clientIdFor(KOVA), client: KOVA, state: 'analysing' });
    const styles = worker();
    styles.start();
    await styles.idle();

    expect(styleOf(KOVA)).toMatchObject({ state: 'failed', error: NOTHING_TO_RERUN });
    expect(runner.calls).toEqual([]);
  });

  it('stops the running pass at shutdown and leaves it, and the ones waiting, for the next start', async () => {
    write(KOVA, 'a.png');
    write(ARC, 'b.png');
    runner.hold = true;
    const first = worker();
    first.start();
    await first.enqueue(KOVA, pass('add', 'a.png'));
    await first.enqueue(ARC, pass('add', 'b.png'));
    await runner.started(1);

    await first.stop();
    expect(runner.calls[0]?.signal.reason).toBe('shutdown');
    expect(styleOf(KOVA)).toMatchObject({ state: 'analysing', lastPass: pass('create', 'a.png') });
    expect(styleOf(ARC)).toMatchObject({ state: 'analysing', lastPass: pass('create', 'b.png') });
    // Nothing more starts once stopped.
    await first.enqueue(KOVA, pass('add', 'a.png'));
    expect(runner.calls).toHaveLength(1);

    runner.hold = false;
    const next = worker();
    next.start();
    await next.idle();
    expect(
      runner.calls
        .slice(1)
        .map((call) => call.client)
        .sort(),
    ).toEqual([ARC, KOVA]);
    expect(styleOf(KOVA)?.state).toBe('ready');
    expect(styleOf(ARC)?.state).toBe('ready');
  });
});

describe('passes that meet', () => {
  it('a Finder pass joins the pass waiting for that client, and one for a running client waits behind it', async () => {
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png']) write(KOVA, name);
    write(ARC, 'x.png');
    runner.hold = true;
    const styles = worker();
    styles.start();

    await styles.enqueue(ARC, pass('add', 'x.png'));
    await runner.started(1);
    // Kova waits behind Arc; its Finder drop joins the waiting upload.
    await styles.enqueue(KOVA, pass('replace', 'a.png'));
    await styles.enqueue(KOVA, pass('add', 'b.png'));
    expect(styleOf(KOVA)?.lastPass).toEqual(pass('create', 'a.png', 'b.png'));

    runner.gates[0]?.release();
    await runner.started(2);
    // Kova runs; a drop now waits behind it, and last_pass holds both.
    await styles.enqueue(KOVA, pass('add', 'c.png'));
    expect(styleOf(KOVA)?.lastPass).toEqual(pass('create', 'a.png', 'b.png', 'c.png'));
    runner.gates[1]?.release();
    await runner.started(3);
    // Between the two, the client stayed analysing.
    expect(styleOf(KOVA)).toMatchObject({ state: 'analysing', version: 1 });
    runner.gates[2]?.release();
    await styles.idle();

    expect(
      runner.calls.map((call) => [call.client, call.pass.mode, filesOf(call.pass).length]),
    ).toEqual([
      [ARC, 'create', 1],
      [KOVA, 'create', 2],
      [KOVA, 'add', 1],
    ]);
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 2 });
  });

  it("puts a failed run's files into the pass waiting behind it", async () => {
    write(KOVA, 'a.png');
    write(KOVA, 'b.png');
    runner.hold = true;
    const styles = worker();
    styles.start();
    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await runner.started(1);
    await styles.enqueue(KOVA, pass('add', 'b.png'));

    runner.gates[0]?.release({ ok: false, error: 'Style stopped: boom' });
    await runner.started(2);
    expect(styleOf(KOVA)).toMatchObject({ state: 'analysing', error: null });
    expect(runner.calls[1]?.pass).toEqual(pass('create', 'a.png', 'b.png'));
    runner.gates[1]?.release();
    await styles.idle();
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 1 });
  });
});

describe('files that are gone', () => {
  it('runs with the files that are still there, at their size now', async () => {
    write(KOVA, 'a.png', 'four');
    const styles = worker();
    styles.start();
    await styles.enqueue(KOVA, pass('add', 'a.png', 'gone.txt'));
    await styles.idle();
    expect(runner.calls[0]?.pass).toMatchObject({ files: [{ name: 'a.png', size: 4 }] });
  });

  it('skips a pass whose files are all gone, and the style is as it was', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\n');
    clientStyles.upsert({ clientId: clientIdFor(KOVA), client: KOVA, state: 'ready', version: 4 });
    const styles = worker();
    styles.start();
    await styles.enqueue(KOVA, pass('add', 'gone.png'));
    await styles.idle();

    expect(runner.calls).toEqual([]);
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 4, error: null });
    await styles.enqueue(ARC, pass('add', 'gone.png'));
    await styles.idle();
    expect(styleOf(ARC)?.state).toBe('none');
  });
});

// --- Learn passes (C4) -------------------------------------------------------------------------

const jobDir = (client: string, job: string) => join(inboxPath, client, job);

/** A finished job of `client` with one graphic (and its render) in edit/animations. */
function finishedJob(client: string, job: string): void {
  const slot = join(jobDir(client, job), 'edit', 'animations', 'slot_title');
  mkdirSync(join(slot, 'assets'), { recursive: true });
  writeFileSync(join(slot, 'index.html'), `<h1>${job}</h1>`);
  writeFileSync(join(slot, 'assets', 'font.woff2'), 'font');
  writeFileSync(join(slot, 'render.mov'), 'render');
}

function learn(job: string, mode: LearnPass['mode'] = 'create'): LearnPass {
  return { kind: 'learn', mode, jobId: `id-${job}`, job };
}

describe('Learn passes', () => {
  it('copies the kit, runs in the job folder and makes the style, learned from the job', async () => {
    finishedJob(KOVA, 'Menu');
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, learn('Menu'));
    await styles.idle();

    expect(runner.calls[0]).toMatchObject({
      client: KOVA,
      styleDir: styleDir(KOVA),
      pass: learn('Menu'),
      learn: { jobDir: jobDir(KOVA, 'Menu'), kit: ['slot_title'] },
    });
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\ncreate from Menu\n');
    expect(read(KOVA, 'kit/slot_title/index.html')).toBe('<h1>Menu</h1>');
    expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_title', 'render.mov'))).toBe(false);
    expect(styleOf(KOVA)).toMatchObject({
      state: 'ready',
      version: 1,
      sourceJobId: 'id-Menu',
      lastPass: learn('Menu'),
    });
  });

  it('replaces the style and the kit, keeping both in history with the job they came from', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nfrom Menu\n');
    mkdirSync(join(styleDir(KOVA), 'kit', 'slot_old'), { recursive: true });
    write(KOVA, 'kit/slot_old/index.html', 'old graphic');
    const id = clientIdFor(KOVA);
    clientStyles.upsert({
      clientId: id,
      client: KOVA,
      state: 'ready',
      version: 2,
      sourceJobId: 'id-Menu',
    });
    finishedJob(KOVA, 'Winter');
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, learn('Winter', 'replace'));
    await styles.idle();

    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nreplace from Winter\n');
    expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_old'))).toBe(false);
    expect(readFileSync(historyFileFor(dataDir, id, 2), 'utf8')).toBe(
      '# Style: Kova Coffee\nfrom Menu\n',
    );
    expect(
      readFileSync(join(historyKitDirFor(dataDir, id, 2), 'slot_old', 'index.html'), 'utf8'),
    ).toBe('old graphic');
    expect(JSON.parse(readFileSync(historySourceFileFor(dataDir, id, 2), 'utf8'))).toEqual({
      sourceJobId: 'id-Menu',
    });
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 3, sourceJobId: 'id-Winter' });
    expect(existsSync(join(styleDir(KOVA), '.kit-previous'))).toBe(false);
  });

  it('a failed Learn fails the style only, and puts the old kit back', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nold\n');
    mkdirSync(join(styleDir(KOVA), 'kit', 'slot_old'), { recursive: true });
    write(KOVA, 'kit/slot_old/index.html', 'old graphic');
    clientStyles.upsert({ clientId: clientIdFor(KOVA), client: KOVA, state: 'ready', version: 1 });
    finishedJob(KOVA, 'Winter');
    runner.script.push(async () => ({ ok: false, error: 'Style stopped: Blocked: no frames' }));
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, learn('Winter', 'replace'));
    await styles.idle();

    expect(styleOf(KOVA)).toMatchObject({
      state: 'failed',
      version: 1,
      error: 'Style stopped: Blocked: no frames',
      lastPass: learn('Winter', 'replace'),
    });
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nold\n');
    expect(read(KOVA, 'kit/slot_old/index.html')).toBe('old graphic');
    expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_title'))).toBe(false);
    expect(existsSync(join(styleDir(KOVA), '.kit-previous'))).toBe(false);
  });

  it('fails without a run when the job has no edit folder any more', async () => {
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, learn('Gone'));
    await styles.idle();

    expect(runner.calls).toEqual([]);
    expect(styleOf(KOVA)).toMatchObject({
      state: 'failed',
      error: 'Style stopped: the job “Gone” has no edit folder to learn from.',
    });
  });

  it('merges a Learn into the style.md there is, and Use this look replaces it', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nfrom files\n');
    clientStyles.upsert({ clientId: clientIdFor(KOVA), client: KOVA, state: 'ready', version: 1 });
    finishedJob(KOVA, 'Menu');
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, learn('Menu', 'merge'));
    await styles.idle();
    expect(runner.calls.map((call) => call.pass)).toEqual([learn('Menu', 'merge')]);
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nmerge from Menu\n');
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 2, sourceJobId: 'id-Menu' });
    expect(readFileSync(historyFileFor(dataDir, clientIdFor(KOVA), 1), 'utf8')).toBe(
      '# Style: Kova Coffee\nfrom files\n',
    );

    await styles.enqueue(KOVA, learn('Menu', 'replace'));
    await styles.idle();
    expect(runner.calls.at(-1)?.pass).toEqual(learn('Menu', 'replace'));
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 3, sourceJobId: 'id-Menu' });
  });

  it('replaces the kit with the merged job’s graphics, and keeps the old kit in history', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nfrom Menu\n');
    mkdirSync(join(styleDir(KOVA), 'kit', 'slot_old'), { recursive: true });
    write(KOVA, 'kit/slot_old/index.html', 'old graphic');
    const id = clientIdFor(KOVA);
    clientStyles.upsert({ clientId: id, client: KOVA, state: 'ready', version: 1 });
    finishedJob(KOVA, 'Winter');
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, learn('Winter', 'merge'));
    await styles.idle();

    expect(runner.calls[0]?.learn).toEqual({ jobDir: jobDir(KOVA, 'Winter'), kit: ['slot_title'] });
    expect(read(KOVA, 'kit/slot_title/index.html')).toBe('<h1>Winter</h1>');
    expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_old'))).toBe(false);
    expect(
      readFileSync(join(historyKitDirFor(dataDir, id, 1), 'slot_old', 'index.html'), 'utf8'),
    ).toBe('old graphic');
    expect(existsSync(join(styleDir(KOVA), '.kit-previous'))).toBe(false);
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 2, sourceJobId: 'id-Winter' });
  });

  it('merges a first Learn queued behind a Read pass into the style that pass made', async () => {
    write(KOVA, 'logo.png');
    finishedJob(KOVA, 'Menu');
    runner.hold = true;
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('add', 'logo.png'));
    await runner.started(1);
    await styles.enqueue(KOVA, learn('Menu'));
    expect(styleOf(KOVA)?.state).toBe('analysing');
    runner.gates[0]?.release();
    await runner.started(2);
    runner.gates[1]?.release();
    await styles.idle();

    // The Read pass made style.md first: the Learn adds the job's look to it.
    expect(runner.calls.map((call) => call.pass)).toEqual([
      pass('create', 'logo.png'),
      learn('Menu', 'merge'),
    ]);
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nmerge from Menu\n');
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 2, sourceJobId: 'id-Menu' });
  });

  it('learns from two finished jobs in turn, the newer one merged into the older one’s style', async () => {
    finishedJob(KOVA, 'Autumn');
    finishedJob(KOVA, 'Winter');
    runner.hold = true;
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, learn('Autumn'));
    await runner.started(1);
    // A second job is ready while the first one's Learn runs: it waits its turn, not joined,
    // and merges into the style the first one made once its turn comes.
    const queued = await styles.enqueue(KOVA, learn('Winter'));
    expect(queued.lastPass).toEqual(learn('Winter'));
    runner.gates[0]?.release();
    await runner.started(2);
    runner.gates[1]?.release();
    await styles.idle();

    expect(runner.calls.map((call) => call.pass)).toEqual([
      learn('Autumn', 'create'),
      learn('Winter', 'merge'),
    ]);
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nmerge from Winter\n');
    expect(read(KOVA, 'kit/slot_title/index.html')).toBe('<h1>Winter</h1>');
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 2, sourceJobId: 'id-Winter' });
  });

  it('runs a stopped Learn again at the next start, the kit as it was meanwhile', async () => {
    finishedJob(KOVA, 'Menu');
    runner.hold = true;
    const first = worker();
    first.start();
    await first.enqueue(KOVA, learn('Menu'));
    await runner.started(1);
    await first.stop();

    expect(styleOf(KOVA)).toMatchObject({ state: 'analysing', lastPass: learn('Menu') });
    expect(existsSync(join(styleDir(KOVA), 'kit'))).toBe(false);

    runner.hold = false;
    const second = worker();
    second.start();
    await second.idle();
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 1, sourceJobId: 'id-Menu' });
    expect(read(KOVA, 'kit/slot_title/index.html')).toBe('<h1>Menu</h1>');
  });

  it('tells the web what it is doing while the client is analysing', async () => {
    finishedJob(KOVA, 'Menu');
    const styles = worker();

    const queued = await styles.enqueue(KOVA, learn('Menu'));

    expect(toClientStyle(queued).pass).toEqual({
      kind: 'learn',
      mode: 'create',
      fileCount: 0,
      jobId: 'id-Menu',
      job: 'Menu',
    });
  });

  it('says it merges while it adds a job’s look to the style there is', async () => {
    write(ARC, 'style.md', '# Style: Arc Fitness\nfrom files\n');
    finishedJob(ARC, 'Gym tour');
    const styles = worker();

    // Queued as a first Learn: with a style.md it is a merge from the start.
    const queued = await styles.enqueue(ARC, learn('Gym tour'));

    expect(toClientStyle(queued).pass).toEqual({
      kind: 'learn',
      mode: 'merge',
      fileCount: 0,
      jobId: 'id-Gym tour',
      job: 'Gym tour',
    });
  });
});

describe('isLearning and learned', () => {
  it('waits while the client has a Learn pass queued or running, whatever the other clients do', async () => {
    finishedJob(KOVA, 'Menu');
    write(ARC, 'a.png');
    runner.hold = true;
    const styles = worker();
    styles.start();
    await styles.enqueue(ARC, pass('add', 'a.png'));
    await styles.enqueue(KOVA, learn('Menu'));
    expect(styles.isLearning(clientIdFor(KOVA))).toBe(true);
    expect(styles.isLearning(clientIdFor(ARC))).toBe(false);

    let learned = false;
    const waiting = styles.learned(clientIdFor(KOVA)).then(() => {
      learned = true;
    });
    await runner.started(1);
    runner.gates[0]?.release();
    await runner.started(2);
    expect(learned).toBe(false);

    runner.gates[1]?.release();
    await waiting;
    expect(styleOf(KOVA)?.state).toBe('ready');
    expect(styles.isLearning(clientIdFor(KOVA))).toBe(false);
  });

  it('does not wait for a Read pass of the client', async () => {
    write(KOVA, 'a.png');
    runner.hold = true;
    const styles = worker();
    styles.start();
    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await runner.started(1);

    expect(styles.isLearning(clientIdFor(KOVA))).toBe(false);
    await styles.learned(clientIdFor(KOVA));
    expect(styleOf(KOVA)?.state).toBe('analysing');
  });

  it('has nothing to wait for before start() and after stop(): nothing would run it', async () => {
    finishedJob(KOVA, 'Menu');
    runner.hold = true;
    const styles = worker();
    await styles.enqueue(KOVA, learn('Menu'));
    expect(styles.isLearning(clientIdFor(KOVA))).toBe(false);
    await styles.learned(clientIdFor(KOVA));

    styles.start();
    expect(styles.isLearning(clientIdFor(KOVA))).toBe(true);
    const waiting = styles.learned(clientIdFor(KOVA));
    await runner.started(1);
    await styles.stop();
    await waiting;
    expect(styles.isLearning(clientIdFor(KOVA))).toBe(false);
  });
});

describe('undo', () => {
  const id = () => clientIdFor(KOVA);

  it('puts the newest kept style back, adds 1 to the version and takes its source job back', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nfrom Winter\n');
    clientStyles.upsert({
      clientId: id(),
      client: KOVA,
      state: 'ready',
      version: 3,
      sourceJobId: 'id-Winter',
    });
    mkdirSync(historyDirFor(dataDir, id()), { recursive: true });
    writeFileSync(historyFileFor(dataDir, id(), 1), '# Style: Kova Coffee\nfrom files\n');
    writeFileSync(historyFileFor(dataDir, id(), 2), '# Style: Kova Coffee\nfrom Menu\n');
    writeFileSync(historySourceFileFor(dataDir, id(), 2), '{"sourceJobId":"id-Menu"}\n');
    const styles = worker();

    const undone = await styles.undo(KOVA);

    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nfrom Menu\n');
    expect(undone).toMatchObject({ state: 'ready', version: 4, sourceJobId: 'id-Menu' });
    // The style it replaced is kept, so nothing is lost.
    expect(readFileSync(historyFileFor(dataDir, id(), 3), 'utf8')).toBe(
      '# Style: Kova Coffee\nfrom Winter\n',
    );
    expect(changes.at(-1)).toMatchObject({ state: 'ready', version: 4 });
  });

  it('puts the kit of that style back when the kit changed after it, and keeps the current one', async () => {
    // Version 1 had kit A; a Learn (version 2) replaced it with kit B.
    finishedJob(KOVA, 'Menu');
    write(KOVA, 'style.md', '# Style: Kova Coffee\none\n');
    mkdirSync(join(styleDir(KOVA), 'kit', 'slot_a'), { recursive: true });
    write(KOVA, 'kit/slot_a/index.html', 'A');
    clientStyles.upsert({ clientId: id(), client: KOVA, state: 'ready', version: 1 });
    const styles = worker();
    styles.start();
    await styles.enqueue(KOVA, learn('Menu', 'replace'));
    await styles.idle();
    expect(read(KOVA, 'kit/slot_title/index.html')).toBe('<h1>Menu</h1>');

    const undone = await styles.undo(KOVA);

    expect(undone).toMatchObject({ version: 3, sourceJobId: null });
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\none\n');
    expect(read(KOVA, 'kit/slot_a/index.html')).toBe('A');
    expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_title'))).toBe(false);
    expect(
      readFileSync(join(historyKitDirFor(dataDir, id(), 2), 'slot_title', 'index.html'), 'utf8'),
    ).toBe('<h1>Menu</h1>');

    // A second Undo goes back to the learned style, kit and source job included.
    const redone = await styles.undo(KOVA);
    expect(redone).toMatchObject({ version: 4, sourceJobId: 'id-Menu' });
    expect(read(KOVA, 'kit/slot_title/index.html')).toBe('<h1>Menu</h1>');
    expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_a'))).toBe(false);
  });

  it('clears the kit when the style it goes back to had none', async () => {
    finishedJob(KOVA, 'Menu');
    write(KOVA, 'style.md', '# Style: Kova Coffee\nfrom files\n');
    clientStyles.upsert({ clientId: id(), client: KOVA, state: 'ready', version: 1 });
    const styles = worker();
    styles.start();
    await styles.enqueue(KOVA, learn('Menu', 'replace'));
    await styles.idle();

    await styles.undo(KOVA);

    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nfrom files\n');
    expect(existsSync(join(styleDir(KOVA), 'kit'))).toBe(false);
  });

  it('keeps the kit as it is when it did not change after the style it goes back to', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nadded to\n');
    mkdirSync(join(styleDir(KOVA), 'kit', 'slot_a'), { recursive: true });
    write(KOVA, 'kit/slot_a/index.html', 'A');
    clientStyles.upsert({ clientId: id(), client: KOVA, state: 'ready', version: 2 });
    mkdirSync(historyDirFor(dataDir, id()), { recursive: true });
    writeFileSync(historyFileFor(dataDir, id(), 1), '# Style: Kova Coffee\nlearned\n');

    await worker().undo(KOVA);

    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nlearned\n');
    expect(read(KOVA, 'kit/slot_a/index.html')).toBe('A');
  });

  describe('while a Learn pass of the client runs (Use this look, then Undo at once)', () => {
    /** A client with a style, a kit and a version, and a finished job to take the look from. */
    function usedLook(): void {
      write(KOVA, 'style.md', '# Style: Kova Coffee\nfrom Menu\n');
      mkdirSync(join(styleDir(KOVA), 'kit', 'slot_old'), { recursive: true });
      write(KOVA, 'kit/slot_old/index.html', 'old graphic');
      clientStyles.upsert({
        clientId: id(),
        client: KOVA,
        state: 'ready',
        version: 2,
        sourceJobId: 'id-Menu',
      });
      finishedJob(KOVA, 'Winter');
    }

    const nothingLeft = () => {
      expect(existsSync(join(styleDir(KOVA), 'style.md.new'))).toBe(false);
      expect(existsSync(join(styleDir(KOVA), '.kit-previous'))).toBe(false);
      expect(existsSync(join(styleDir(KOVA), '.kit-copying'))).toBe(false);
    };

    it('cancels the running pass: the style, the kit and the version are as they were', async () => {
      usedLook();
      runner.hold = true;
      const styles = worker();
      styles.start();
      await styles.enqueue(KOVA, learn('Winter', 'replace'));
      await runner.started(1);
      // The new kit is in place and the old one is set aside, as long as the run goes on.
      expect(read(KOVA, 'kit/slot_title/index.html')).toBe('<h1>Winter</h1>');
      expect(existsSync(join(styleDir(KOVA), '.kit-previous', 'slot_old'))).toBe(true);
      expect(styleOf(KOVA)?.state).toBe('analysing');

      const undone = await styles.undo(KOVA);

      expect(runner.calls[0]?.signal.aborted).toBe(true);
      expect(runner.calls[0]?.signal.reason).toBe(UNDO_REASON);
      expect(undone).toMatchObject({
        state: 'ready',
        version: 2,
        error: null,
        sourceJobId: 'id-Menu',
      });
      expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 2, sourceJobId: 'id-Menu' });
      expect(changes.at(-1)).toMatchObject({ state: 'ready', version: 2 });
      expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nfrom Menu\n');
      expect(read(KOVA, 'kit/slot_old/index.html')).toBe('old graphic');
      expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_title'))).toBe(false);
      nothingLeft();
      // Nothing went to history: there is no version to go back to, and the worker is free again.
      expect(existsSync(historyDirFor(dataDir, id()))).toBe(false);
      expect(styles.activeClientId).toBeNull();
      expect(styles.isLearning(id())).toBe(false);
      await styles.idle();
    });

    it('drops a style.md.new the run wrote, even when the run says it finished', async () => {
      usedLook();
      runner.script.push(async (request) => {
        writeFileSync(join(request.styleDir, 'style.md.new'), '# Style: Kova Coffee\nnew look\n');
        await new Promise((resolve) =>
          request.signal.addEventListener('abort', resolve, { once: true }),
        );
        return { ok: true };
      });
      const styles = worker();
      styles.start();
      await styles.enqueue(KOVA, learn('Winter', 'replace'));
      await runner.started(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(join(styleDir(KOVA), 'style.md.new'))).toBe(true);

      await styles.undo(KOVA);

      expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nfrom Menu\n');
      expect(read(KOVA, 'kit/slot_old/index.html')).toBe('old graphic');
      expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 2 });
      nothingLeft();
    });

    it('cancels a pass that is still queued behind another client’s run, and that run goes on', async () => {
      usedLook();
      write(ARC, 'a.png');
      runner.hold = true;
      const styles = worker();
      styles.start();
      await styles.enqueue(ARC, pass('add', 'a.png'));
      await runner.started(1);
      await styles.enqueue(KOVA, learn('Winter', 'replace'));
      expect(styles.isLearning(id())).toBe(true);
      let learned = false;
      const waiting = styles.learned(id()).then(() => {
        learned = true;
      });

      const undone = await styles.undo(KOVA);
      await waiting;

      expect(learned).toBe(true);
      expect(undone).toMatchObject({ state: 'ready', version: 2 });
      expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 2 });
      expect(changes.filter((style) => style.client === KOVA).map((style) => style.state)).toEqual([
        'analysing',
        'ready',
      ]);
      // The other client's run was not touched, and the cancelled pass never starts.
      expect(runner.calls[0]?.signal.aborted).toBe(false);
      runner.gates[0]?.release();
      await styles.idle();
      expect(runner.calls).toHaveLength(1);
      expect(styleOf(ARC)).toMatchObject({ state: 'ready', version: 1 });
      expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nfrom Menu\n');
      expect(read(KOVA, 'kit/slot_old/index.html')).toBe('old graphic');
      nothingLeft();
    });

    it('cancels a pass queued before the worker has started', async () => {
      usedLook();
      const styles = worker();
      await styles.enqueue(KOVA, learn('Winter', 'replace'));

      const undone = await styles.undo(KOVA);

      expect(undone).toMatchObject({ state: 'ready', version: 2 });
      styles.start();
      await styles.idle();
      expect(runner.calls).toEqual([]);
    });

    it('goes back to no style at all when the client had none before', async () => {
      finishedJob(KOVA, 'Winter');
      runner.hold = true;
      const styles = worker();
      styles.start();
      await styles.enqueue(KOVA, learn('Winter', 'replace'));
      await runner.started(1);

      const undone = await styles.undo(KOVA);

      expect(undone).toMatchObject({ state: 'none', version: 0 });
      expect(existsSync(join(styleDir(KOVA), 'style.md'))).toBe(false);
      expect(existsSync(join(styleDir(KOVA), 'kit'))).toBe(false);
      nothingLeft();
    });

    it('leaves a Read pass queued behind the Learn to run, and the client analysing until it ends', async () => {
      usedLook();
      write(KOVA, 'logo.png');
      runner.hold = true;
      const styles = worker();
      styles.start();
      await styles.enqueue(KOVA, learn('Winter', 'replace'));
      await runner.started(1);
      // A Finder drop while the Learn runs waits behind it.
      await styles.enqueue(KOVA, pass('add', 'logo.png'));

      const undone = await styles.undo(KOVA);

      expect(undone).toMatchObject({
        state: 'analysing',
        version: 2,
        lastPass: pass('add', 'logo.png'),
      });
      expect(read(KOVA, 'kit/slot_old/index.html')).toBe('old graphic');
      await runner.started(2);
      expect(runner.calls[1]?.pass).toEqual(pass('add', 'logo.png'));
      runner.gates[1]?.release();
      await styles.idle();
      expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 3 });
      expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_title'))).toBe(false);
    });

    it('is a plain Undo once the pass has finished', async () => {
      usedLook();
      mkdirSync(historyDirFor(dataDir, id()), { recursive: true });
      writeFileSync(historyFileFor(dataDir, id(), 1), '# Style: Kova Coffee\nearlier\n');
      const styles = worker();
      styles.start();
      await styles.enqueue(KOVA, learn('Winter', 'replace'));
      await styles.idle();
      expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 3, sourceJobId: 'id-Winter' });

      const undone = await styles.undo(KOVA);

      expect(runner.calls[0]?.signal.aborted).toBe(false);
      expect(undone).toMatchObject({ state: 'ready', version: 4, sourceJobId: 'id-Menu' });
      expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nfrom Menu\n');
      expect(read(KOVA, 'kit/slot_old/index.html')).toBe('old graphic');
      expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_title'))).toBe(false);
      nothingLeft();
    });

    it('drops a Learn queued behind a Read pass without stopping the Read pass', async () => {
      usedLook();
      write(KOVA, 'logo.png');
      runner.hold = true;
      const styles = worker();
      styles.start();
      await styles.enqueue(KOVA, pass('add', 'logo.png'));
      await runner.started(1);
      await styles.enqueue(KOVA, learn('Winter', 'replace'));

      const undone = await styles.undo(KOVA);

      // Answered at once, the Read pass still going on.
      expect(undone).toMatchObject({
        state: 'analysing',
        version: 2,
        lastPass: pass('add', 'logo.png'),
      });
      runner.gates[0]?.release();
      await styles.idle();
      expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 3 });
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]?.signal.aborted).toBe(false);
      expect(existsSync(join(styleDir(KOVA), 'kit', 'slot_title'))).toBe(false);
    });
  });

  it('is refused when nothing was ever kept, and while the client is analysing', async () => {
    const styles = worker();
    await expect(styles.undo(KOVA)).rejects.toThrow('There is no earlier style to go back to.');

    mkdirSync(historyDirFor(dataDir, id()), { recursive: true });
    writeFileSync(historyFileFor(dataDir, id(), 1), '# Style: Kova Coffee\n');
    write(KOVA, 'a.png');
    await styles.enqueue(KOVA, pass('add', 'a.png'));
    await expect(styles.undo(KOVA)).rejects.toThrow(StyleRefusedError);
    expect(existsSync(join(styleDir(KOVA), 'style.md'))).toBe(false);
  });
});

// C17: Replace really replaces. The new style.md has no ## Kit, so the client's kit goes to
// history with the old style.md, and only once the new one is installed.
describe('Replace takes the kit with it (C17)', () => {
  const id = () => clientIdFor(KOVA);
  const OLD_STYLE =
    '# Style: Kova Coffee\nyellow Petel, 1080x1920\n## Kit\n- slot_title: yellow card\n';
  const kitDir = () => join(styleDir(KOVA), 'kit');
  const keptKit = (version: number) => historyKitDirFor(dataDir, id(), version);

  /** A client at version 4 with a style.md and a kit of two graphics, as a Learn leaves it. */
  function clientWithKit(): void {
    write(KOVA, 'style.md', OLD_STYLE);
    write(KOVA, 'notes.txt', 'square, Assistant ExtraBold, white title on a red band');
    for (const slot of ['slot_title', 'slot_end']) {
      mkdirSync(join(kitDir(), slot), { recursive: true });
      writeFileSync(join(kitDir(), slot, 'index.html'), `old ${slot}`);
    }
    clientStyles.upsert({ clientId: id(), client: KOVA, state: 'ready', version: 4 });
  }

  /** What the Brief step would copy into the next job's edit/style/, and the brief made from it. */
  function nextBrief(): string {
    const files = readdirSync(styleDir(KOVA), { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return renderBriefMd(noInstructionsBrief(['clip.mp4']), {
      client: KOVA,
      job: 'Next',
      note: null,
      style: { markdown: read(KOVA, 'style.md'), files },
    });
  }

  it('moves the kit to history beside the old style.md, and leaves no kit in the style folder', async () => {
    clientWithKit();
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
    await styles.idle();

    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nreplace from notes.txt\n');
    expect(readFileSync(historyFileFor(dataDir, id(), 4), 'utf8')).toBe(OLD_STYLE);
    expect(readFileSync(join(keptKit(4), 'slot_title', 'index.html'), 'utf8')).toBe(
      'old slot_title',
    );
    expect(readFileSync(join(keptKit(4), 'slot_end', 'index.html'), 'utf8')).toBe('old slot_end');
    expect(existsSync(kitDir())).toBe(false);
    expect(existsSync(join(styleDir(KOVA), '.kit-previous'))).toBe(false);
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 5, error: null });
  });

  it('leaves the kit where it is while the run is going, so a job started now sees one whole style', async () => {
    clientWithKit();
    let kitDuringRun: string[] = [];
    runner.script.push(async (request) => {
      kitDuringRun = readdirSync(kitDir()).sort();
      return writeGood(request);
    });
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
    await styles.idle();

    expect(kitDuringRun).toEqual(['slot_end', 'slot_title']);
    expect(existsSync(kitDir())).toBe(false);
  });

  describe('a replace that does not finish leaves the old style.md and the kit exactly as they were', () => {
    function expectUntouched(): void {
      expect(read(KOVA, 'style.md')).toBe(OLD_STYLE);
      expect(readFileSync(join(kitDir(), 'slot_title', 'index.html'), 'utf8')).toBe(
        'old slot_title',
      );
      expect(readFileSync(join(kitDir(), 'slot_end', 'index.html'), 'utf8')).toBe('old slot_end');
      expect(existsSync(join(styleDir(KOVA), 'style.md.new'))).toBe(false);
      expect(existsSync(join(styleDir(KOVA), '.kit-previous'))).toBe(false);
      expect(existsSync(historyFileFor(dataDir, id(), 4))).toBe(false);
      expect(existsSync(keptKit(4))).toBe(false);
    }

    it('with a bad style.md.new', async () => {
      clientWithKit();
      runner.script.push(async ({ styleDir: dir }) => {
        writeFileSync(join(dir, 'style.md.new'), 'Sure! Here is your new style.\n');
        return { ok: true };
      });
      const styles = worker();
      styles.start();

      await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
      await styles.idle();

      expect(styleOf(KOVA)).toMatchObject({
        state: 'failed',
        version: 4,
        error: STYLE_BAD_TITLE,
        lastPass: expect.objectContaining({ kind: 'read', mode: 'replace' }),
      });
      expectUntouched();
    });

    it('with no style.md.new at all', async () => {
      clientWithKit();
      runner.script.push(async () => ({ ok: true }));
      const styles = worker();
      styles.start();

      await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
      await styles.idle();

      expect(styleOf(KOVA)).toMatchObject({ state: 'failed', version: 4, error: STYLE_MISSING });
      expectUntouched();
    });

    it('when the run itself fails, and a Retry that works then moves the kit', async () => {
      clientWithKit();
      runner.script.push(async () => ({ ok: false, error: 'Style stopped: timed out' }));
      const styles = worker();
      styles.start();

      await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
      await styles.idle();
      expect(styleOf(KOVA)).toMatchObject({ state: 'failed', version: 4 });
      expectUntouched();

      await styles.retry(KOVA);
      await styles.idle();
      expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 5 });
      expect(existsSync(kitDir())).toBe(false);
      expect(existsSync(join(keptKit(4), 'slot_title', 'index.html'))).toBe(true);
    });

    it('when the engine shuts down during the run, and the next start runs it again', async () => {
      clientWithKit();
      runner.hold = true;
      const first = worker();
      first.start();
      await first.enqueue(KOVA, pass('replace', 'notes.txt'));
      await runner.started(1);

      await first.stop();

      expect(runner.calls[0]?.signal.reason).toBe('shutdown');
      expect(styleOf(KOVA)).toMatchObject({ state: 'analysing', version: 4 });
      expectUntouched();

      runner.hold = false;
      const next = worker();
      next.start();
      await next.idle();
      expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 5 });
      expect(existsSync(kitDir())).toBe(false);
      expect(existsSync(join(keptKit(4), 'slot_end', 'index.html'))).toBe(true);
    });
  });

  it('is undone with the old style.md and its kit together, and undone again with the new style', async () => {
    clientWithKit();
    const styles = worker();
    styles.start();
    await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
    await styles.idle();
    expect(existsSync(kitDir())).toBe(false);

    const undone = await styles.undo(KOVA);

    expect(undone).toMatchObject({ state: 'ready', version: 6 });
    expect(read(KOVA, 'style.md')).toBe(OLD_STYLE);
    expect(readFileSync(join(kitDir(), 'slot_title', 'index.html'), 'utf8')).toBe('old slot_title');
    expect(readFileSync(join(kitDir(), 'slot_end', 'index.html'), 'utf8')).toBe('old slot_end');
    // The replaced style is kept too, with the fact that it had no kit.
    expect(readFileSync(historyFileFor(dataDir, id(), 5), 'utf8')).toBe(
      '# Style: Kova Coffee\nreplace from notes.txt\n',
    );
    expect(readdirSync(keptKit(5))).toEqual([]);

    // A second Undo goes forward again: the new style, without a kit, the kit kept in history.
    const redone = await styles.undo(KOVA);

    expect(redone).toMatchObject({ state: 'ready', version: 7 });
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nreplace from notes.txt\n');
    expect(existsSync(kitDir())).toBe(false);
    expect(readFileSync(join(keptKit(6), 'slot_title', 'index.html'), 'utf8')).toBe(
      'old slot_title',
    );
  });

  it('works as before for a client with no kit: nothing to move, no empty kit in history', async () => {
    write(KOVA, 'style.md', '# Style: Kova Coffee\nfrom files\n');
    write(KOVA, 'notes.txt');
    clientStyles.upsert({ clientId: id(), client: KOVA, state: 'ready', version: 2 });
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
    await styles.idle();

    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nreplace from notes.txt\n');
    expect(readFileSync(historyFileFor(dataDir, id(), 2), 'utf8')).toBe(
      '# Style: Kova Coffee\nfrom files\n',
    );
    expect(existsSync(kitDir())).toBe(false);
    expect(existsSync(keptKit(2))).toBe(false);
    expect(styleOf(KOVA)).toMatchObject({ state: 'ready', version: 3 });

    await styles.undo(KOVA);
    expect(read(KOVA, 'style.md')).toBe('# Style: Kova Coffee\nfrom files\n');
    expect(existsSync(kitDir())).toBe(false);
  });

  it('keeps the kit for an add, and for a create', async () => {
    clientWithKit();
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('add', 'notes.txt'));
    await styles.idle();

    expect(runner.calls[0]?.pass.mode).toBe('add');
    expect(readdirSync(kitDir()).sort()).toEqual(['slot_end', 'slot_title']);
    expect(existsSync(keptKit(4))).toBe(false);

    // No style.md: the pass is a create, which never touches a kit.
    rmSync(join(styleDir(KOVA), 'style.md'));
    await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
    await styles.idle();

    expect(runner.calls[1]?.pass.mode).toBe('create');
    expect(readdirSync(kitDir()).sort()).toEqual(['slot_end', 'slot_title']);
    expect(existsSync(keptKit(5))).toBe(false);
  });

  it('gives the next job a brief that points at no kit, where it pointed at one before', async () => {
    clientWithKit();
    expect(nextBrief()).toContain('Reuse the graphics in edit/style/kit/');
    const styles = worker();
    styles.start();

    await styles.enqueue(KOVA, pass('replace', 'notes.txt'));
    await styles.idle();

    const brief = nextBrief();
    expect(brief).not.toContain('edit/style/kit/');
    expect(brief).toContain('Build the graphics in this look.');
  });
});
