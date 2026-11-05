import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIX_MESSAGES,
  type Job,
  type JobEvent,
  type NoteRoute,
  type QuickFix,
  type ReviewNote,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewExports } from '../clients/review-export.js';
import { JobRepository, NoteRepository, QuickFixRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { createFixService, FIX_SERVICE_MESSAGES } from './fix-service.js';
import { fixDirPath } from './quick-fix-files.js';
import type { QuickFixOutcome, QuickFixRequest, QuickFixRunner } from './quick-fix-run.js';

// The fix service on the real repositories (an in-memory database), a real job folder in a temp
// dir and a runner whose every outcome the test gives by hand. The queue, the files around each
// run (copy, restore byte for byte), Undo, the stale exports, the blocks, leaving Review and the
// start-up recovery are all checked here; the routes, the note rules and the engine have their own
// test files.

const CLIENT = 'Northwind Bakery';
const REVIEW_PATH: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
];

const QUICK: NoteRoute = { tier: 'quick', kind: 'Changing the caption font', why: '' };
const REVISE: NoteRoute = { tier: 'revise', kind: 'Replacing a shot', why: 'it changes the cut' };

interface RunCall {
  request: QuickFixRequest;
  /** Ends the run with this outcome (an abort ends it by itself, as the real runner does). */
  finish(outcome: QuickFixOutcome): void;
  /** Ends the run with a throw. */
  crash(error: unknown): void;
}

/** A runner that records every run and lets the test end each one by hand. */
function handRunner() {
  const calls: RunCall[] = [];
  const runner: QuickFixRunner = {
    kind: 'fake',
    run(request) {
      return new Promise<QuickFixOutcome>((resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => resolve({ status: 'failed', why: 'the fix was stopped', hasCompare: false }),
          { once: true },
        );
        calls.push({ request, finish: resolve, crash: reject });
      });
    },
  };
  return { runner, calls };
}

const FIXED: QuickFixOutcome = {
  status: 'fixed',
  said: 'The captions are Heebo Bold now.',
  hasCompare: true,
};

const dirs: string[] = [];
const opened: StudioDb[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface SetupOptions {
  jobsAtOnce?: number;
  reap?: () => Promise<unknown>;
}

function setup(options: SetupOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), 'studio-fix-service-'));
  dirs.push(base);
  const inboxPath = join(base, 'inbox');
  mkdirSync(inboxPath, { recursive: true });
  const db = memoryDb();
  opened.push(db);
  const noteClock = fakeClock();
  // The engine builds the repository with the switch on, whenever it builds the fix service.
  const jobs = new JobRepository(db, { clock: fakeClock(), quickFixes: true });
  const notes = new NoteRepository(db, { clock: noteClock });
  const fixRepo = new QuickFixRepository(db);
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const hand = handRunner();
  const hold = { value: false };
  let fixNumber = 0;
  const service = createFixService({
    inboxPath,
    jobs,
    notes,
    fixes: fixRepo,
    bus,
    runner: hand.runner,
    logger,
    newId: () => `fix${++fixNumber}`,
    jobsAtOnce: options.jobsAtOnce,
    holdOff: () => hold.value,
    reap: options.reap,
  });
  const stopListening = service.listen(bus);
  const exports = new ReviewExports({ inboxPath, render: async () => {} });

  let jobNumber = 0;
  let noteNumber = 0;
  const h = {
    inboxPath,
    db,
    jobs,
    notes,
    fixRepo,
    bus,
    events,
    logger,
    hand,
    hold,
    service,
    exports,
    noteClock,
    stopListening,
    /** A job in Review with a preview on disk, and a project.md. */
    addJob(name = `Teaser ${++jobNumber}`, path: JobEvent[] = REVIEW_PATH): Job {
      const { job } = jobs.upsertFromScan(makeScan(CLIENT, name));
      for (const event of path) jobs.applyTransition(job.id, event);
      writePreview(join(inboxPath, CLIENT, name));
      return jobs.get(job.id) as Job;
    },
    /** An unsent text note, sorted as `route` (quick by default). */
    addNote(
      job: Job,
      text = 'change the caption font',
      route: NoteRoute | null = QUICK,
    ): ReviewNote {
      noteClock.tick(1_000);
      const created = notes.create({
        id: `n${++noteNumber}`,
        jobId: job.id,
        kind: 'text',
        atSec: 12,
        text,
      });
      if (route === null) return created;
      return notes.setRoute(created.id, { status: 'routed', route }) as ReviewNote;
    },
    /** The job folder. */
    dir(job: Job): string {
      return join(inboxPath, job.relPath);
    },
    fixEvents(): QuickFix[] {
      return events.flatMap((event) => (event.type === 'job.fix' ? [event.fix] : []));
    },
    /** Waits for the nth run to have started. */
    async started(count: number): Promise<void> {
      await vi.waitFor(() => expect(hand.calls.length).toBeGreaterThanOrEqual(count));
    },
    async status(id: string, status: QuickFix['status']): Promise<void> {
      await vi.waitFor(() => expect(fixRepo.get(id)?.status).toBe(status));
    },
  };
  return h;
}

type Harness = ReturnType<typeof setup>;

function writePreview(jobDir: string): void {
  const preview = join(jobDir, 'edit', 'preview');
  mkdirSync(join(preview, 'compositions'), { recursive: true });
  mkdirSync(join(preview, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(preview, 'index.html'), '<html>captions in Rubik</html>');
  writeFileSync(join(preview, 'compositions', 'captions.html'), '<div>caption</div>');
  writeFileSync(join(preview, 'assets', 'fonts', 'Rubik.ttf'), Buffer.from([0, 1, 2, 250, 255]));
  writeFileSync(join(preview, 'cut.mp4'), Buffer.from('not really a video'));
  writeFileSync(join(jobDir, 'edit', 'project.md'), '# Teaser\n\nThe captions are Rubik.\n');
}

/** Every file under `dir` (relative path → its bytes in base64), so a restore is checked byte for byte. */
function readTree(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(folder, entry.name), rel);
      else tree[rel] = readFileSync(join(folder, entry.name)).toString('base64');
    }
  };
  walk(dir, '');
  return tree;
}

const previewOf = (h: Harness, job: Job) => join(h.dir(job), 'edit', 'preview');
const projectOf = (h: Harness, job: Job) => join(h.dir(job), 'edit', 'project.md');

/** What a run does to the files: the composition, a new file, a removed one and the project notes. */
function fiddle(h: Harness, job: Job, marker = 'Heebo'): void {
  const preview = previewOf(h, job);
  writeFileSync(join(preview, 'index.html'), `<html>captions in ${marker}</html>`);
  writeFileSync(join(preview, 'compositions', 'extra.css'), `.caption { font: ${marker}; }`);
  rmSync(join(preview, 'compositions', 'captions.html'), { force: true });
  mkdirSync(join(preview, '.hyperframes'), { recursive: true });
  writeFileSync(join(preview, '.hyperframes', 'state.json'), '{}');
  writeFileSync(projectOf(h, job), `# Teaser\n\nThe captions are ${marker}.\n`);
}

describe('queueing a fix', () => {
  it('queues a quick routed note of a job in Review and starts it at once', async () => {
    const h = setup();
    const job = h.addJob();
    const note = h.addNote(job);
    await h.service.start();

    const fix = h.service.enqueue(job, note);

    expect(fix).toEqual({
      id: 'fix1',
      jobId: job.id,
      noteId: note.id,
      round: 1,
      status: 'queued',
      step: null,
      stepLabel: null,
      said: null,
      why: null,
      model: 'sonnet',
      effort: 'medium',
      startedAt: null,
      endedAt: null,
      durationSec: null,
      hasCompare: false,
    });
    await h.started(1);
    expect(h.fixEvents().map((event) => event.status)).toEqual(['queued', 'running']);
    expect(h.fixRepo.get('fix1')).toMatchObject({
      status: 'running',
      step: 0,
      stepLabel: 'Reading the edit',
    });
    const { request } = h.hand.calls[0] as RunCall;
    expect(request.job.id).toBe(job.id);
    expect(request.note).toMatchObject({
      id: note.id,
      text: 'change the caption font',
      route: QUICK,
    });
    expect(request.fix).toMatchObject({ id: 'fix1', round: 1 });
  });

  it('takes the round the note will be stamped with: the next one', async () => {
    const h = setup();
    const job = h.addJob('Second round', [
      ...REVIEW_PATH,
      { type: 'SEND_NOTES' },
      { type: 'START' },
      { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
    ]);
    expect(job.round).toBe(1);
    const note = h.addNote(job);
    await h.service.start();

    expect(h.service.enqueue(job, note)?.round).toBe(2);
  });

  it('does not queue a note that is not a quick one, a sent one or one already fixed', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const revise = h.addNote(job, 'swap this shot', REVISE);
    const unsorted = h.addNote(job, 'unsorted', null);
    const pending = h.addNote(job, 'pending', null);
    h.notes.setRoute(pending.id, { status: 'pending' });
    const fixed = h.addNote(job, 'fixed');
    h.notes.setFix(fixed.id, { fixId: 'old', fixedAt: '2026-10-20T10:00:00.000Z' });
    const sent = h.addNote(job, 'sent');
    h.notes.markSent(job.id, [sent.id], 1, '2026-10-20T10:00:00.000Z');

    for (const note of [revise, unsorted, pending, fixed, sent]) {
      expect(h.service.enqueue(job, h.notes.get(note.id) as ReviewNote)).toBeNull();
    }
    expect(h.fixRepo.listQueued()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('does not queue for a job that is not in Review, is archived or is on a manual level', async () => {
    const h = setup();
    await h.service.start();
    const editing = h.addJob('Editing', [{ type: 'SETTLED' }, { type: 'START' }]);
    const archived = h.addJob('Archived');
    h.jobs.archive([archived.id]);
    const manual = h.addJob('Manual');
    h.jobs.setReviewEffort(manual.id, 'high');

    for (const name of [editing, archived, manual]) {
      const job = h.jobs.get(name.id) as Job;
      const note = h.addNote(job);
      expect(h.service.enqueue(job, note)).toBeNull();
    }
    expect(h.hand.calls).toHaveLength(0);
  });

  it('does not queue a note with no words, or the same note twice', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const note = h.addNote(job);

    expect(h.service.enqueue(job, note)).not.toBeNull();
    expect(h.service.enqueue(job, note)).toBeNull();
    await h.started(1);
    // ... also while it runs.
    expect(h.service.enqueue(job, note)).toBeNull();
    expect(h.fixRepo.listForRound(job.id, 1)).toHaveLength(1);

    const voice = h.notes.create({
      id: 'v1',
      jobId: job.id,
      kind: 'voice',
      atSec: 3,
      audioFile: 'edit/review/voice/v1.webm',
      audioSec: 2,
    });
    h.notes.setRoute(voice.id, { status: 'routed', route: QUICK });
    expect(h.service.enqueue(job, h.notes.get(voice.id) as ReviewNote)).toBeNull();
  });

  it('holds a fix queued before the service is started and runs it once it is', async () => {
    const h = setup();
    const job = h.addJob();
    const note = h.addNote(job);

    expect(h.service.enqueue(job, note)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.hand.calls).toHaveLength(0);

    await h.service.start();
    await h.started(1);
  });
});

describe('the order of the fixes', () => {
  it('runs one fix at a time per job, the next when the one before ends', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const first = h.addNote(job, 'first');
    const second = h.addNote(job, 'second');
    h.service.enqueue(job, first);
    h.service.enqueue(job, second);

    await h.started(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.hand.calls).toHaveLength(1);
    expect(h.fixRepo.get('fix2')?.status).toBe('queued');

    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.started(2);
    expect(h.hand.calls[1]?.request.note.id).toBe(second.id);
    expect(h.fixRepo.get('fix1')?.status).toBe('fixed');
    expect(h.fixRepo.get('fix2')?.status).toBe('running');
  });

  it('runs the notes in the order they were added, though the router answered out of order', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const first = h.addNote(job, 'first note');
    const second = h.addNote(job, 'second note');
    const third = h.addNote(job, 'third note');
    h.hold.value = true;

    // Answered: third, first, second.
    h.service.enqueue(job, third);
    h.service.enqueue(job, first);
    h.service.enqueue(job, second);
    h.hold.value = false;
    h.service.poke();

    await h.started(1);
    expect(h.hand.calls[0]?.request.note.id).toBe(first.id);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.started(2);
    expect(h.hand.calls[1]?.request.note.id).toBe(second.id);
    (h.hand.calls[1] as RunCall).finish(FIXED);
    await h.started(3);
    expect(h.hand.calls[2]?.request.note.id).toBe(third.id);
  });

  it('runs at most jobsAtOnce jobs at the same time, and the next job when one ends', async () => {
    const h = setup({ jobsAtOnce: 2 });
    await h.service.start();
    const jobs = [h.addJob('A'), h.addJob('B'), h.addJob('C')];
    for (const job of jobs) h.service.enqueue(job, h.addNote(job));

    await h.started(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both start at once, so which run is called first is not fixed.
    expect(new Set(h.hand.calls.map((call) => call.request.job.id))).toEqual(
      new Set([jobs[0]?.id, jobs[1]?.id]),
    );
    expect(h.fixRepo.get('fix3')?.status).toBe('queued');

    (h.hand.calls[1] as RunCall).finish(FIXED);
    await h.started(3);
    expect(h.hand.calls[2]?.request.job.id).toBe(jobs[2]?.id);
  });

  it('gives a job that just fixed a place behind the jobs that wait', async () => {
    const h = setup({ jobsAtOnce: 1 });
    await h.service.start();
    const a = h.addJob('A');
    const b = h.addJob('B');
    h.service.enqueue(a, h.addNote(a, 'a one'));
    h.service.enqueue(a, h.addNote(a, 'a two'));
    h.service.enqueue(b, h.addNote(b, 'b one'));

    await h.started(1);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.started(2);

    // B was waiting before A's second fix: it goes first.
    expect(h.hand.calls[1]?.request.job.id).toBe(b.id);
    (h.hand.calls[1] as RunCall).finish(FIXED);
    await h.started(3);
    expect(h.hand.calls[2]?.request.note.text).toBe('a two');
  });

  it('keeps a fix waiting while the music is being made, and starts it when the music is done', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.hold.value = true;

    h.service.enqueue(job, h.addNote(job));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.hand.calls).toHaveLength(0);
    expect(h.service.reviewBlock(job.id)).toBe(FIX_MESSAGES.busy);

    // The music service tells the page when a make ends: that is what looks at the queues again.
    h.hold.value = false;
    h.bus.publish({ type: 'job.music', jobId: job.id, music: null });
    await h.started(1);
  });
});

describe('around a run', () => {
  it('copies the preview and project.md before the run', async () => {
    const h = setup();
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);

    const before = join(h.dir(job), fixDirPath('fix1'), 'before');
    expect(readTree(join(before, 'preview'))).toEqual(original);
    expect(readFileSync(join(before, 'project.md'), 'utf8')).toBe(
      '# Teaser\n\nThe captions are Rubik.\n',
    );
  });

  it('saves a fixed fix with its words, its time and the stills flag, and the note with it', async () => {
    const h = setup();
    const job = h.addJob();
    const note = h.addNote(job);
    await h.service.start();
    h.service.enqueue(job, note);
    await h.started(1);

    fiddle(h, job);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');

    const fix = h.fixRepo.get('fix1') as QuickFix;
    expect(fix).toMatchObject({
      status: 'fixed',
      step: null,
      stepLabel: null,
      said: 'The captions are Heebo Bold now.',
      why: null,
      hasCompare: true,
    });
    expect(fix.startedAt).not.toBeNull();
    expect(fix.endedAt).not.toBeNull();
    expect(fix.durationSec).toBeGreaterThanOrEqual(0);
    const saved = h.notes.get(note.id) as ReviewNote;
    expect(saved.fixId).toBe('fix1');
    expect(saved.fixedAt).toBe(fix.endedAt);
    // The new composition stays, and the copy to go back to is kept for Undo.
    expect(readFileSync(join(previewOf(h, job), 'index.html'), 'utf8')).toContain('Heebo');
    expect(existsSync(join(h.dir(job), fixDirPath('fix1'), 'before', 'preview'))).toBe(true);
  });

  it('publishes job.fix on every change, steps included, and note.upsert before the fix lands', async () => {
    const h = setup();
    const job = h.addJob();
    const note = h.addNote(job);
    await h.service.start();
    h.service.enqueue(job, note);
    await h.started(1);
    const { request } = h.hand.calls[0] as RunCall;

    request.onStep?.(0, 'Reading the edit');
    request.onStep?.(1, 'Changing the caption font');
    request.onStep?.(1, 'Changing the caption font');
    request.onStep?.(2, 'Checking it');
    request.onStep?.(3, 'Looking at the frames');
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');

    const seen = h.events.flatMap((event) =>
      event.type === 'job.fix'
        ? [`${event.fix.status}:${event.fix.step}:${event.fix.stepLabel}`]
        : event.type === 'note.upsert'
          ? [`note:${event.note.fixId}`]
          : [],
    );
    expect(seen).toEqual([
      'queued:null:null',
      'running:0:Reading the edit',
      'running:1:Changing the caption font',
      'running:2:Checking it',
      'running:3:Looking at the frames',
      'note:fix1',
      'fixed:null:null',
    ]);
    expect(h.events.every((event) => event.type !== 'job.fix' || event.jobId === job.id)).toBe(
      true,
    );
  });

  it.each([
    [
      'escalated',
      { status: 'escalated', why: 'it changes the cut', hasCompare: false } as QuickFixOutcome,
    ],
    ['failed', { status: 'failed', why: 'the lint failed', hasCompare: false } as QuickFixOutcome],
  ])(
    'puts the preview and project.md back byte for byte when the run is %s',
    async (status, outcome) => {
      const h = setup();
      const job = h.addJob();
      const note = h.addNote(job);
      const original = readTree(previewOf(h, job));
      const originalProject = readFileSync(projectOf(h, job), 'utf8');
      await h.service.start();
      h.service.enqueue(job, note);
      await h.started(1);

      fiddle(h, job);
      expect(readTree(previewOf(h, job))).not.toEqual(original);
      (h.hand.calls[0] as RunCall).finish(outcome);
      await h.status('fix1', status as QuickFix['status']);

      expect(readTree(previewOf(h, job))).toEqual(original);
      expect(readFileSync(projectOf(h, job), 'utf8')).toBe(originalProject);
      expect(h.fixRepo.get('fix1')).toMatchObject({
        status,
        why: (outcome as { why: string }).why,
        said: null,
        step: null,
        stepLabel: null,
      });
      expect(h.fixRepo.get('fix1')?.endedAt).not.toBeNull();
      // The note waits for Send, and the copy is dropped.
      expect(h.notes.get(note.id)).toMatchObject({ fixId: null, fixedAt: null });
      expect(existsSync(join(h.dir(job), fixDirPath('fix1'), 'before'))).toBe(false);
    },
  );

  it('removes a project.md the run made when the job had none', async () => {
    const h = setup();
    const job = h.addJob();
    rmSync(projectOf(h, job));
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);

    writeFileSync(projectOf(h, job), 'made by the run');
    writeFileSync(join(previewOf(h, job), 'index.html'), 'changed');
    (h.hand.calls[0] as RunCall).finish({ status: 'escalated', why: 'no', hasCompare: false });
    await h.status('fix1', 'escalated');

    expect(existsSync(projectOf(h, job))).toBe(false);
    expect(readFileSync(join(previewOf(h, job), 'index.html'), 'utf8')).toContain('Rubik');
  });

  it('leaves the files and their times alone when the run changed nothing', async () => {
    const h = setup();
    const job = h.addJob();
    const index = join(previewOf(h, job), 'index.html');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(index, old, old);
    const before = statSync(index).mtimeMs;
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);

    (h.hand.calls[0] as RunCall).finish({ status: 'escalated', why: 'no', hasCompare: false });
    await h.status('fix1', 'escalated');

    expect(statSync(index).mtimeMs).toBe(before);
  });

  it('counts a run that throws as a failed fix and puts the files back', async () => {
    const h = setup();
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);

    fiddle(h, job);
    (h.hand.calls[0] as RunCall).crash(new Error('claude was not found'));
    await h.status('fix1', 'failed');

    expect(h.fixRepo.get('fix1')?.why).toBe('it could not run: claude was not found');
    expect(readTree(previewOf(h, job))).toEqual(original);
  });

  it('fails a fix whose job has no preview, without starting the run', async () => {
    const h = setup();
    const job = h.addJob();
    rmSync(join(previewOf(h, job), 'index.html'));
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));

    await h.status('fix1', 'failed');
    expect(h.fixRepo.get('fix1')?.why).toBe(FIX_SERVICE_MESSAGES.noPreview);
    expect(h.hand.calls).toHaveLength(0);
  });

  it('cancels a fix whose note is gone when its turn comes, and goes on to the next', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job, 'running'));
    await h.started(1);
    const gone = h.addNote(job, 'will be deleted');
    h.service.enqueue(job, gone);
    const last = h.addNote(job, 'the last one');
    h.service.enqueue(job, last);
    h.notes.remove(gone.id);

    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.started(2);

    expect(h.fixRepo.get('fix2')?.status).toBe('cancelled');
    expect(h.hand.calls[1]?.request.note.id).toBe(last.id);
  });

  it('does not keep a job blocked when the service itself breaks in the middle of a fix', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const note = h.addNote(job, 'breaks');
    const real = h.notes.get.bind(h.notes);
    let calls = 0;
    vi.spyOn(h.notes, 'get').mockImplementation((id) => {
      // The first look is the queueing's, the second the fix's own, at its start.
      calls += 1;
      if (calls === 2) throw new Error('the disk is full');
      return real(id);
    });

    h.service.enqueue(job, note);
    await h.status('fix1', 'failed');

    expect(h.fixRepo.get('fix1')?.why).toBe('it could not run');
    expect(h.service.reviewBlock(job.id)).toBeNull();
    expect(h.logger.error).toHaveBeenCalled();
    // The job takes the next one.
    vi.restoreAllMocks();
    h.service.enqueue(job, h.addNote(job, 'fine'));
    await h.started(1);
  });

  it('starts the next queued fix after a fixed one and after one that is not', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    for (const text of ['one', 'two', 'three']) h.service.enqueue(job, h.addNote(job, text));

    await h.started(1);
    (h.hand.calls[0] as RunCall).finish({ status: 'escalated', why: 'no', hasCompare: false });
    await h.started(2);
    (h.hand.calls[1] as RunCall).finish({ status: 'failed', why: 'bad', hasCompare: false });
    await h.started(3);
    (h.hand.calls[2] as RunCall).finish(FIXED);
    await h.status('fix3', 'fixed');

    expect(h.fixRepo.listForRound(job.id, 1).map((fix) => fix.status)).toEqual([
      'escalated',
      'failed',
      'fixed',
    ]);
    expect(h.service.reviewBlock(job.id)).toBeNull();
  });
});

describe('stale exports', () => {
  /** The export of the preview as it is: made after everything the composition is made of. */
  function exportCurrent(h: Harness, job: Job): void {
    const out = join(h.dir(job), 'edit', 'review-export.mp4');
    writeFileSync(out, 'video');
    const now = new Date();
    utimesSync(out, now, now);
  }

  /** Every file of the preview is an hour old, as the export is checked against all of them. */
  function oldPreview(h: Harness, job: Job): void {
    const old = new Date(Date.now() - 3_600_000);
    for (const file of readdirSync(previewOf(h, job), { recursive: true, withFileTypes: true })) {
      if (file.isFile()) utimesSync(join(file.parentPath, file.name), old, old);
    }
  }

  it('makes the export stale when a fix lands, even when it changed only a stylesheet', async () => {
    const h = setup();
    const job = h.addJob();
    oldPreview(h, job);
    exportCurrent(h, job);
    expect((await h.exports.statusFor(job)).state).toBe('ready');
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Not index.html, not a sub-composition: only a stylesheet.
    writeFileSync(join(previewOf(h, job), 'assets', 'captions.css'), '.c { color: yellow }');
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');

    expect((await h.exports.statusFor(job)).state).toBe('idle');
  });

  it('makes a current export stale again when the fix is undone, and when files are put back', async () => {
    const h = setup();
    const job = h.addJob();
    oldPreview(h, job);
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);
    fiddle(h, job);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');

    // An export of the fixed preview is current ...
    await new Promise((resolve) => setTimeout(resolve, 15));
    exportCurrent(h, job);
    expect((await h.exports.statusFor(job)).state).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 15));
    // ... and is not once the fix is undone, though the copy has older files.
    expect((await h.service.undo(job, 'fix1')).ok).toBe(true);
    expect((await h.exports.statusFor(job)).state).toBe('idle');

    // The same when a run that changed files is put back.
    h.service.enqueue(job, h.addNote(job, 'again'));
    await h.started(2);
    fiddle(h, job, 'Frank');
    await new Promise((resolve) => setTimeout(resolve, 15));
    exportCurrent(h, job);
    expect((await h.exports.statusFor(job)).state).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 15));
    (h.hand.calls[1] as RunCall).finish({ status: 'failed', why: 'bad', hasCompare: false });
    await h.status('fix2', 'failed');
    expect((await h.exports.statusFor(job)).state).toBe('idle');
  });
});

describe('telling the Jobs list (C57)', () => {
  /** What each `job.upsert` says of the job's fixes: the time of the note being fixed and the count of fixed notes. */
  function told(h: Harness): Array<{ fixing: number | null; fixedCount: number }> {
    return h.events.flatMap((event) =>
      event.type === 'job.upsert'
        ? [{ fixing: event.job.fixing?.atSec ?? null, fixedCount: event.job.fixedCount }]
        : [],
    );
  }

  it('announces the job when its first fix starts, not for each step, and again when it is fixed', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const note = h.addNote(job);
    h.service.enqueue(job, note);
    await h.started(1);
    // Steps of the same fix: a new job.fix each, and nothing for the list.
    h.hand.calls[0]?.request.onStep?.(1, 'Changing the caption font');
    await vi.waitFor(() => expect(h.fixRepo.get('fix1')?.step).toBe(1));
    expect(told(h)).toEqual([{ fixing: 12, fixedCount: 0 }]);

    fiddle(h, job);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');

    expect(told(h)).toEqual([
      { fixing: 12, fixedCount: 0 },
      { fixing: null, fixedCount: 1 },
    ]);
    const last = h.events.filter((event) => event.type === 'job.upsert').at(-1);
    expect(last).toMatchObject({ job: { id: job.id, state: 'review' } });
  });

  it('moves the line from one note to the next, and counts the fixed ones', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job, 'first'));
    h.service.enqueue(job, h.addNote(job, 'second'));
    await h.started(1);
    fiddle(h, job);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');
    await h.started(2);
    fiddle(h, job, 'Frank');
    (h.hand.calls[1] as RunCall).finish(FIXED);
    await h.status('fix2', 'fixed');

    // Both notes are at 0:12, so the line keeps its time while the count goes up.
    expect(told(h)).toEqual([
      { fixing: 12, fixedCount: 0 },
      { fixing: 12, fixedCount: 1 },
      { fixing: null, fixedCount: 2 },
    ]);
  });

  it('says nothing is being fixed any more when the fix fails', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);
    (h.hand.calls[0] as RunCall).finish({ status: 'failed', why: 'bad', hasCompare: false });
    await h.status('fix1', 'failed');

    expect(told(h)).toEqual([
      { fixing: 12, fixedCount: 0 },
      { fixing: null, fixedCount: 0 },
    ]);
  });

  it('announces the job again when an Undo takes a fixed note back', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);
    fiddle(h, job);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');
    h.events.length = 0;

    await h.service.undo(job, 'fix1');

    expect(told(h)).toEqual([{ fixing: null, fixedCount: 0 }]);
  });

  it('does not announce what the page already heard from a job.upsert of someone else', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);
    h.events.length = 0;
    // Another part of the engine announced the job after the fix started: it already says "fixing".
    h.bus.publish({ type: 'job.upsert', job: h.jobs.get(job.id) as Job });
    fiddle(h, job);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');

    expect(told(h)).toEqual([
      { fixing: 12, fixedCount: 0 },
      { fixing: null, fixedCount: 1 },
    ]);
  });
});

describe('Undo', () => {
  async function fixedJob(h: Harness, job: Job, text: string, marker: string) {
    const note = h.addNote(job, text);
    const fix = h.service.enqueue(job, note) as QuickFix;
    await h.started(h.hand.calls.length + 1);
    const call = h.hand.calls.at(-1) as RunCall;
    fiddle(h, job, marker);
    call.finish(FIXED);
    await h.status(fix.id, 'fixed');
    return { note, fix };
  }

  it('puts the preview and project.md back, marks the fix undone and frees its note', async () => {
    const h = setup();
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    const originalProject = readFileSync(projectOf(h, job), 'utf8');
    await h.service.start();
    const { note } = await fixedJob(h, job, 'change the font', 'Heebo');
    h.events.length = 0;

    const result = await h.service.undo(job, 'fix1');

    expect(result).toMatchObject({ ok: true, fix: { id: 'fix1', status: 'undone' } });
    expect(readTree(previewOf(h, job))).toEqual(original);
    expect(readFileSync(projectOf(h, job), 'utf8')).toBe(originalProject);
    expect(h.fixRepo.get('fix1')?.status).toBe('undone');
    expect(h.notes.get(note.id)).toMatchObject({ fixId: null, fixedAt: null });
    expect(existsSync(join(h.dir(job), fixDirPath('fix1'), 'before'))).toBe(false);
    expect(
      h.events.map((event) =>
        event.type === 'job.fix' ? `fix:${event.fix.status}` : `${event.type}`,
      ),
      // The count of notes fixed here went down, so the Jobs list hears of the job too.
    ).toEqual(['note.upsert', 'fix:undone', 'job.upsert']);
  });

  it("moves the fix's endedAt to the moment of the Undo, so the web's rev changes too", async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    await fixedJob(h, job, 'change the font', 'Heebo');
    const fixedEndedAt = h.fixRepo.get('fix1')?.endedAt as string;
    expect(fixedEndedAt).not.toBeNull();
    // A few ms pass, so the Undo's moment is later than the fix's own.
    await new Promise((resolve) => setTimeout(resolve, 15));
    h.events.length = 0;

    const result = await h.service.undo(job, 'fix1');

    expect(result.ok).toBe(true);
    const undoneEndedAt = h.fixRepo.get('fix1')?.endedAt as string;
    expect(Date.parse(undoneEndedAt)).toBeGreaterThan(Date.parse(fixedEndedAt));
    // The fix that went out on the bus carries it too.
    expect(h.fixEvents().at(-1)).toMatchObject({ status: 'undone', endedAt: undoneEndedAt });
  });

  it('undoes only the newest fixed fix: A, B fixed; B first, then A, back to the start', async () => {
    const h = setup();
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    await h.service.start();
    await fixedJob(h, job, 'first', 'Heebo');
    // The copy leaves out the tool's own state (.hyperframes/), so Undo brings back none.
    const afterFirst = Object.fromEntries(
      Object.entries(readTree(previewOf(h, job))).filter(([path]) => !path.startsWith('.')),
    );
    await fixedJob(h, job, 'second', 'Frank');

    expect(await h.service.undo(job, 'fix1')).toEqual({
      ok: false,
      status: 409,
      error: FIX_MESSAGES.notNewest,
    });
    expect((await h.service.undo(job, 'fix2')).ok).toBe(true);
    expect(readTree(previewOf(h, job))).toEqual(afterFirst);
    expect((await h.service.undo(job, 'fix1')).ok).toBe(true);
    expect(readTree(previewOf(h, job))).toEqual(original);
  });

  it('takes the fix that ended last, not the one that was queued last', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    // Answered third then first: fix1 is the third note's, but runs second.
    const first = h.addNote(job, 'first note');
    const second = h.addNote(job, 'second note');
    h.hold.value = true;
    h.service.enqueue(job, second);
    h.service.enqueue(job, first);
    h.hold.value = false;
    h.service.poke();
    await h.started(1);
    fiddle(h, job, 'One');
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.started(2);
    fiddle(h, job, 'Two');
    (h.hand.calls[1] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');
    await h.status('fix2', 'fixed');

    // fix2 (the first note's) ran first; fix1 (queued first) ran last and is the newest.
    expect(h.hand.calls[0]?.request.fix.id).toBe('fix2');
    expect((await h.service.undo(job, 'fix2')).ok).toBe(false);
    expect((await h.service.undo(job, 'fix1')).ok).toBe(true);
    expect((await h.service.undo(job, 'fix2')).ok).toBe(true);
  });

  it('answers 409 busy while a fix is queued or running for the job', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    await fixedJob(h, job, 'first', 'Heebo');
    h.service.enqueue(job, h.addNote(job, 'second'));
    await h.started(2);

    // Running ...
    expect(await h.service.undo(job, 'fix1')).toEqual({
      ok: false,
      status: 409,
      error: FIX_MESSAGES.busy,
    });
    // ... and queued behind it.
    h.service.enqueue(job, h.addNote(job, 'third'));
    expect((await h.service.undo(job, 'fix1')).ok).toBe(false);
    expect(h.fixRepo.get('fix1')?.status).toBe('fixed');
  });

  it('answers 409 for a fix that is not fixed or not of this round, and 404 for one the job lacks', async () => {
    const h = setup();
    const job = h.addJob();
    const other = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);
    (h.hand.calls[0] as RunCall).finish({ status: 'escalated', why: 'no', hasCompare: false });
    await h.status('fix1', 'escalated');

    expect(await h.service.undo(job, 'fix1')).toMatchObject({ status: 409, ok: false });
    expect(await h.service.undo(job, 'nope')).toMatchObject({ status: 404, ok: false });
    expect(await h.service.undo(other, 'fix1')).toMatchObject({ status: 404, ok: false });

    // Fixed once, undone: a second Undo is not the newest fixed fix any more.
    h.service.enqueue(job, h.addNote(job, 'again'));
    await h.started(2);
    (h.hand.calls[1] as RunCall).finish(FIXED);
    await h.status('fix2', 'fixed');
    expect((await h.service.undo(job, 'fix2')).ok).toBe(true);
    expect(await h.service.undo(job, 'fix2')).toMatchObject({
      ok: false,
      status: 409,
      error: FIX_MESSAGES.notNewest,
    });
  });

  it('answers 409 when the job is not in Review, and when the copy to go back to is gone', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    await fixedJob(h, job, 'first', 'Heebo');
    const edited = readTree(previewOf(h, job));

    rmSync(join(h.dir(job), fixDirPath('fix1'), 'before'), { recursive: true });
    expect(await h.service.undo(job, 'fix1')).toEqual({
      ok: false,
      status: 409,
      error: FIX_SERVICE_MESSAGES.noCopy,
    });
    // Nothing was changed, and the job is not left claimed.
    expect(readTree(previewOf(h, job))).toEqual(edited);
    expect(h.fixRepo.get('fix1')?.status).toBe('fixed');
    expect(h.service.reviewBlock(job.id)).toBeNull();

    h.jobs.applyTransition(job.id, { type: 'SEND_NOTES' });
    expect(await h.service.undo(h.jobs.get(job.id) as Job, 'fix1')).toMatchObject({
      status: 409,
      error: FIX_SERVICE_MESSAGES.notInReview,
    });
  });
});

describe('lists and stills', () => {
  it('lists the fixes of the job’s next round, oldest first', async () => {
    const h = setup();
    const job = h.addJob();
    const other = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job, 'one'));
    h.service.enqueue(job, h.addNote(job, 'two'));
    h.service.enqueue(other, h.addNote(other, 'elsewhere'));

    expect(h.service.list(job).map((fix) => fix.id)).toEqual(['fix1', 'fix2']);
    expect(h.service.list(other).map((fix) => fix.id)).toEqual(['fix3']);
    expect(h.service.find(job.id, 'fix1')?.id).toBe('fix1');
    expect(h.service.find(job.id, 'fix3')).toBeNull();
  });

  it('finds a still of the fix inside its folder, and nothing for a missing one', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    const fixDir = join(h.dir(job), fixDirPath('fix1'));
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, 'before.png'), 'png');

    expect(await h.service.comparePath(job.id, 'fix1', 'before.png')).toBe(
      realpathSync(join(fixDir, 'before.png')),
    );
    expect(await h.service.comparePath(job.id, 'fix1', 'after.png')).toBeNull();
    expect(await h.service.comparePath(job.id, 'nope', 'before.png')).toBeNull();
  });
});

describe('the block on Approve, Send, a restore, the export and the music', () => {
  it('answers busy while a fix is queued or running, and null before and after', async () => {
    const h = setup();
    const job = h.addJob();
    const other = h.addJob();
    await h.service.start();
    expect(h.service.reviewBlock(job.id)).toBeNull();

    h.service.enqueue(job, h.addNote(job, 'one'));
    h.service.enqueue(job, h.addNote(job, 'two'));
    await h.started(1);
    expect(h.service.reviewBlock(job.id)).toBe(FIX_MESSAGES.busy);
    expect(h.service.reviewBlock(other.id)).toBeNull();

    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.started(2);
    // Between two fixes of the job it is still busy: one is queued, then running.
    expect(h.service.reviewBlock(job.id)).toBe(FIX_MESSAGES.busy);
    (h.hand.calls[1] as RunCall).finish(FIXED);
    await h.status('fix2', 'fixed');
    expect(h.service.reviewBlock(job.id)).toBeNull();
  });

  it('is free by the time the final job.fix is published', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const blocks: Array<[string, string | null]> = [];
    h.bus.subscribe((event) => {
      if (event.type === 'job.fix') blocks.push([event.fix.status, h.service.reviewBlock(job.id)]);
    });

    h.service.enqueue(job, h.addNote(job));
    await h.started(1);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');

    expect(blocks).toEqual([
      ['queued', FIX_MESSAGES.busy],
      ['running', FIX_MESSAGES.busy],
      ['fixed', null],
    ]);
  });
});

describe('the note rules', () => {
  it('refuses new words for a note with a fix, and for one whose fix runs', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const note = h.addNote(job);
    h.service.enqueue(job, note);
    await h.started(1);

    expect(h.service.beforeNoteEdit(h.notes.get(note.id) as ReviewNote)).toBe(FIX_MESSAGES.busy);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');
    expect(h.service.beforeNoteEdit(h.notes.get(note.id) as ReviewNote)).toBe(
      FIX_MESSAGES.editFixed,
    );
  });

  it('cancels the queued fix of a note whose words change', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job, 'running'));
    const waiting = h.addNote(job, 'waiting');
    h.service.enqueue(job, waiting);
    await h.started(1);

    expect(h.service.beforeNoteEdit(waiting)).toBeNull();

    expect(h.fixRepo.get('fix2')?.status).toBe('cancelled');
    expect(h.fixRepo.get('fix2')?.endedAt).not.toBeNull();
    expect(h.fixEvents().at(-1)).toMatchObject({ id: 'fix2', status: 'cancelled' });
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.hand.calls).toHaveLength(1);
  });

  it('deletes a note: the queued fix is cancelled, a running one is 409 busy', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const running = h.addNote(job, 'running');
    h.service.enqueue(job, running);
    const waiting = h.addNote(job, 'waiting');
    h.service.enqueue(job, waiting);
    await h.started(1);

    expect(await h.service.beforeNoteDelete(running)).toBe(FIX_MESSAGES.busy);
    expect(await h.service.beforeNoteDelete(waiting)).toBeNull();
    expect(h.fixRepo.get('fix2')?.status).toBe('cancelled');
    expect(h.fixRepo.get('fix1')?.status).toBe('running');
  });

  it('deletes a fixed note only for the newest fix, which is undone first', async () => {
    const h = setup();
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    await h.service.start();
    const first = h.addNote(job, 'first');
    h.service.enqueue(job, first);
    await h.started(1);
    fiddle(h, job, 'One');
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');
    const second = h.addNote(job, 'second');
    h.service.enqueue(job, second);
    await h.started(2);
    fiddle(h, job, 'Two');
    (h.hand.calls[1] as RunCall).finish(FIXED);
    await h.status('fix2', 'fixed');

    // The older one is refused; the newest is undone, then the older one is the newest.
    expect(await h.service.beforeNoteDelete(h.notes.get(first.id) as ReviewNote)).toBe(
      FIX_MESSAGES.deleteFixed,
    );
    expect(await h.service.beforeNoteDelete(h.notes.get(second.id) as ReviewNote)).toBeNull();
    expect(h.fixRepo.get('fix2')?.status).toBe('undone');
    expect(await h.service.beforeNoteDelete(h.notes.get(first.id) as ReviewNote)).toBeNull();
    expect(readTree(previewOf(h, job))).toEqual(original);
  });

  it('lets a note go whose fix did not land', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    const note = h.addNote(job);
    h.service.enqueue(job, note);
    await h.started(1);
    (h.hand.calls[0] as RunCall).finish({ status: 'escalated', why: 'no', hasCompare: false });
    await h.status('fix1', 'escalated');

    expect(h.service.beforeNoteEdit(h.notes.get(note.id) as ReviewNote)).toBeNull();
    expect(await h.service.beforeNoteDelete(h.notes.get(note.id) as ReviewNote)).toBeNull();
    expect(await h.service.beforeNoteDelete(h.addNote(job, 'plain', null))).toBeNull();
  });
});

describe('leaving Review', () => {
  it.each([
    [
      'is cancelled',
      (job: Job): ServerEvent => ({ type: 'job.upsert', job: { ...job, state: 'cancelled' } }),
    ],
    [
      'goes on to a new round',
      (job: Job): ServerEvent => ({ type: 'job.upsert', job: { ...job, state: 'queued' } }),
    ],
    [
      'is archived',
      (job: Job): ServerEvent => ({
        type: 'job.upsert',
        job: { ...job, archivedAt: '2026-10-25T10:00:00.000Z' },
      }),
    ],
    ['is deleted', (job: Job): ServerEvent => ({ type: 'job.remove', id: job.id })],
  ])('stops the running fix and cancels the queued ones when the job %s', async (_name, event) => {
    const h = setup();
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    const originalProject = readFileSync(projectOf(h, job), 'utf8');
    await h.service.start();
    h.service.enqueue(job, h.addNote(job, 'running'));
    h.service.enqueue(job, h.addNote(job, 'waiting'));
    h.service.enqueue(job, h.addNote(job, 'also waiting'));
    await h.started(1);
    fiddle(h, job);
    const signal = (h.hand.calls[0] as RunCall).request.signal;

    h.bus.publish(event(job));
    await h.status('fix1', 'failed');

    expect(signal.aborted).toBe(true);
    expect(h.fixRepo.get('fix1')?.why).toBe('the fix was stopped');
    expect(readTree(previewOf(h, job))).toEqual(original);
    expect(readFileSync(projectOf(h, job), 'utf8')).toBe(originalProject);
    expect(h.fixRepo.get('fix2')?.status).toBe('cancelled');
    expect(h.fixRepo.get('fix3')?.status).toBe('cancelled');
    expect(h.service.reviewBlock(job.id)).toBeNull();
    // The queue does not start anything else.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.hand.calls).toHaveLength(1);
  });

  it('stopJob stops the run and waits until its files are back', async () => {
    const h = setup();
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    h.service.enqueue(job, h.addNote(job, 'second'));
    await h.started(1);
    fiddle(h, job);

    await h.service.stopJob(job.id);

    expect(readTree(previewOf(h, job))).toEqual(original);
    expect(h.fixRepo.get('fix1')?.status).toBe('failed');
    expect(h.fixRepo.get('fix2')?.status).toBe('cancelled');
    await h.service.stopJob('no such job');
  });

  it('cancels the queued fixes of a job that leaves Auto and lets the running one finish', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job, 'running'));
    h.service.enqueue(job, h.addNote(job, 'waiting'));
    await h.started(1);

    h.bus.publish({ type: 'job.upsert', job: { ...job, reviewEffort: 'high' } });

    expect(h.fixRepo.get('fix2')?.status).toBe('cancelled');
    expect(h.fixRepo.get('fix1')?.status).toBe('running');
    expect(h.hand.calls[0]?.request.signal.aborted).toBe(false);
    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix1', 'fixed');
  });

  it('skips a queued fix whose job left Auto before it came up', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job, 'running'));
    h.service.enqueue(job, h.addNote(job, 'waiting'));
    await h.started(1);
    h.jobs.setReviewEffort(job.id, 'high');

    (h.hand.calls[0] as RunCall).finish(FIXED);
    await h.status('fix2', 'cancelled');
    expect(h.hand.calls).toHaveLength(1);
  });
});

describe('start-up and shutdown', () => {
  it('marks the fixes an earlier engine left running failed, puts their copies back and cancels the queued ones', async () => {
    const reap = vi.fn(async () => []);
    const h = setup({ reap });
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    const originalProject = readFileSync(projectOf(h, job), 'utf8');
    const running = h.addNote(job, 'was running');
    const queued = h.addNote(job, 'was queued');

    // The earlier engine: a copy, a half-done change, and two rows.
    const fixDir = join(h.dir(job), fixDirPath('old1'));
    mkdirSync(join(fixDir, 'before'), { recursive: true });
    writeFileSync(join(fixDir, 'before', 'project.md'), originalProject);
    cpSync(previewOf(h, job), join(fixDir, 'before', 'preview'), { recursive: true });
    fiddle(h, job);
    const row = (id: string, noteId: string, status: QuickFix['status']): QuickFix => ({
      id,
      jobId: job.id,
      noteId,
      round: 1,
      status,
      step: status === 'running' ? 1 : null,
      stepLabel: status === 'running' ? 'Changing the caption font' : null,
      said: null,
      why: null,
      model: 'sonnet',
      effort: 'medium',
      startedAt: status === 'running' ? '2026-10-25T09:00:00.000Z' : null,
      endedAt: null,
      durationSec: null,
      hasCompare: false,
    });
    h.fixRepo.insert(row('old1', running.id, 'running'));
    h.fixRepo.insert(row('old2', queued.id, 'queued'));

    await h.service.start();

    expect(reap).toHaveBeenCalledTimes(1);
    expect(h.fixRepo.get('old1')).toMatchObject({ status: 'failed', step: null, stepLabel: null });
    expect(h.fixRepo.get('old1')?.why).toContain('engine stopped');
    expect(h.fixRepo.get('old2')?.status).toBe('cancelled');
    expect(readTree(previewOf(h, job))).toEqual(original);
    expect(readFileSync(projectOf(h, job), 'utf8')).toBe(originalProject);
    expect(existsSync(join(fixDir, 'before'))).toBe(false);
    expect(h.fixEvents().map((fix) => `${fix.id}:${fix.status}`)).toEqual([
      'old1:failed',
      'old2:cancelled',
    ]);
    expect(h.service.reviewBlock(job.id)).toBeNull();
  });

  it('keeps a fix queued since the boot, and runs it once start has looked at what was left', async () => {
    const h = setup();
    const job = h.addJob();
    const stale = h.addNote(job, 'from the last engine');
    h.fixRepo.insert({
      id: 'old',
      jobId: job.id,
      noteId: stale.id,
      round: 1,
      status: 'queued',
      step: null,
      stepLabel: null,
      said: null,
      why: null,
      model: 'sonnet',
      effort: 'medium',
      startedAt: null,
      endedAt: null,
      durationSec: null,
      hasCompare: false,
    });
    const fresh = h.addNote(job, 'since the boot');
    h.service.enqueue(job, fresh);

    await h.service.start();

    expect(h.fixRepo.get('old')?.status).toBe('cancelled');
    await h.started(1);
    expect(h.hand.calls[0]?.request.note.id).toBe(fresh.id);
  });

  it('stops a running fix at shutdown, puts its copy back and says the engine stopped', async () => {
    const h = setup();
    const job = h.addJob();
    const original = readTree(previewOf(h, job));
    await h.service.start();
    h.service.enqueue(job, h.addNote(job, 'running'));
    h.service.enqueue(job, h.addNote(job, 'waiting'));
    await h.started(1);
    fiddle(h, job);
    const signal = (h.hand.calls[0] as RunCall).request.signal;

    await h.service.stop();

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('shutdown');
    expect(readTree(previewOf(h, job))).toEqual(original);
    expect(h.fixRepo.get('fix1')).toMatchObject({
      status: 'failed',
      why: FIX_SERVICE_MESSAGES.engineStopped,
    });
    // The fix that waited is left for the next boot to cancel; nothing new starts.
    expect(h.fixRepo.get('fix2')?.status).toBe('queued');
    expect(h.hand.calls).toHaveLength(1);
    expect(h.service.enqueue(job, h.addNote(job, 'late'))).toBeNull();
  });
});

describe('clearRound', () => {
  it('removes the fixes folder of the job and nothing else', async () => {
    const h = setup();
    const job = h.addJob();
    const other = h.addJob();
    await h.service.start();
    for (const j of [job, other]) {
      mkdirSync(join(h.dir(j), fixDirPath('x')), { recursive: true });
      writeFileSync(join(h.dir(j), fixDirPath('x'), 'before.png'), 'png');
    }

    await h.service.clearRound(job.id);

    expect(existsSync(join(h.dir(job), 'edit', 'review', 'fixes'))).toBe(false);
    expect(existsSync(join(h.dir(job), 'edit', 'preview', 'index.html'))).toBe(true);
    expect(existsSync(join(h.dir(other), fixDirPath('x'), 'before.png'))).toBe(true);
    await h.service.clearRound('no such job');
    await h.service.clearRound(job.id);
  });

  it('does nothing while a fix is queued or running for the job', async () => {
    const h = setup();
    const job = h.addJob();
    await h.service.start();
    h.service.enqueue(job, h.addNote(job));
    await h.started(1);

    await h.service.clearRound(job.id);

    expect(existsSync(join(h.dir(job), fixDirPath('fix1'), 'before'))).toBe(true);
  });
});
