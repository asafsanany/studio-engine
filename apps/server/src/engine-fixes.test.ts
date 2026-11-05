import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiErrorSchema,
  FIX_MESSAGES,
  type Job,
  jobFixesResponseSchema,
  type QuickFix,
  type ReviewNote,
  type ServerEvent,
  undoFixResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Config, ensureDirs, loadConfig } from './config.js';
import { QuickFixRepository } from './db/index.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from './db/test-utils.js';
import { createEngine, type Engine, type EngineOptions } from './engine.js';
import type { RunningInbox } from './inbox/boot.js';
import type { InboxWatcher } from './inbox/watcher.js';
import type { MusicScriptOutcome } from './music/music-script.js';
import { fixtureRecord, ranOk, writeRecord } from './music/test-utils.js';
import { RunnerUnavailableError } from './pipeline/create-runner.js';
import { writeFakePreview } from './pipeline/fake-preview.js';
import type { Sleep } from './pipeline/fake-runner.js';
import { FakeQuickFixRunner } from './review/fake-quick-fix.js';
import { FIX_SERVICE_MESSAGES } from './review/fix-service.js';
import { FIXES_DIR_PATH, fixDirPath } from './review/quick-fix-files.js';
import { REVIEW_MESSAGES } from './review/review-service.js';
import { makeTempDir, noBuiltInLuts } from './test-temp.js';

// Quick fixes in the boot composition (QF3): with the switch on, a note the fake router calls quick is
// fixed by itself by the stand-in quick fix, one at a time, while the job stays in Review; Undo and
// Compare work through the routes; Approve, Send, Export MP4 and the music wait while it runs; the
// note rules, leaving Review, deleting a job, a shutdown and a boot after a crash all hold. With the
// switch off nothing is there.

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

const idleInbox: EngineOptions['startInbox'] = async (): Promise<RunningInbox> => ({
  watcher: {} as InboxWatcher,
  summary: {
    created: 0,
    changed: 0,
    removed: 0,
    settled: 0,
    failedMissingExport: 0,
    failedMissingPreview: 0,
    failedFolderRemoved: 0,
    resuming: 0,
    unchanged: 0,
  },
  stop: async () => {},
});

function tempConfig(env: Record<string, string> = {}): Config {
  const home = makeTempDir('studio-engine-fixes-');
  const config = loadConfig({
    home,
    env: {
      STUDIO_QUICK_FIXES: '1',
      STUDIO_MANUAL_START: '0',
      STUDIO_KNOWN_CLIENTS_ONLY: '0',
      ...env,
    },
  });
  ensureDirs(config);
  return config;
}

/** Each step of the stand-in fix waits for `gate.open` while it is closed, and ends at once when stopped. */
function heldSteps() {
  const state: { held: boolean; waiting: Array<() => void> } = { held: false, waiting: [] };
  const sleep: Sleep = (_ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted || !state.held) return resolve();
      state.waiting.push(resolve);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  return {
    sleep,
    hold: () => {
      state.held = true;
    },
    open: () => {
      state.held = false;
      for (const resolve of state.waiting.splice(0)) resolve();
    },
  };
}

function boot(config: Config, options: Partial<EngineOptions> = {}) {
  const steps = heldSteps();
  const engine = createEngine({
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    startInbox: idleInbox,
    builtInLuts: noBuiltInLuts(),
    quickFixRunner: new FakeQuickFixRunner({ config, speed: 200, sleep: steps.sleep }),
    ...options,
  });
  engines.push(engine);
  return { engine, steps, config };
}

/** A job in Review with the stand-in's composition on disk. */
async function inReview(engine: Engine, config: Config, name = 'Ep 1'): Promise<Job> {
  const { job } = engine.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  engine.jobs.applyTransition(job.id, { type: 'SETTLED' });
  engine.jobs.applyTransition(job.id, { type: 'START' });
  engine.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  const editDir = join(config.inboxPath, job.relPath, 'edit');
  mkdirSync(editDir, { recursive: true });
  await writeFakePreview(editDir, name);
  writeFileSync(join(editDir, 'project.md'), `# ${name}\n`);
  return engine.jobs.get(job.id) as Job;
}

const indexOf = (config: Config, job: Job) =>
  join(config.inboxPath, job.relPath, 'edit', 'preview', 'index.html');
const titleRule = (config: Config, job: Job) =>
  /#title\s*\{[^}]*\}/.exec(readFileSync(indexOf(config, job), 'utf8'))?.[0] ?? '';

/** Adds a note and waits until the router has sorted it. */
async function addRouted(engine: Engine, job: Job, text: string): Promise<ReviewNote> {
  const added = engine.review.addTextNote(job.id, { atSec: 2, text });
  await vi.waitFor(() => expect(engine.notes.get(added.id)?.routeStatus).toBe('routed'), {
    timeout: 3_000,
  });
  return engine.notes.get(added.id) as ReviewNote;
}

const waitFixed = (engine: Engine, noteId: string) =>
  vi.waitFor(() => expect(engine.notes.get(noteId)?.fixId).not.toBeNull(), { timeout: 5_000 });

const fixesOf = (engine: Engine, job: Job): QuickFix[] =>
  engine.fixes?.list(engine.jobs.get(job.id) as Job) ?? [];

async function expectError(res: Response, status: number, message?: string): Promise<string> {
  expect(res.status).toBe(status);
  const error = apiErrorSchema.parse(await res.json()).error;
  if (message !== undefined) expect(error).toBe(message);
  return error;
}

async function expectReviewError(work: () => unknown, status: number, message: string) {
  const error = await Promise.resolve()
    .then(work)
    .then(
      () => new Error('it did not throw'),
      (err: unknown) => err,
    );
  expect(error).toMatchObject({ name: 'ReviewError', status, message });
}

describe('a quick note in Review on Auto', () => {
  it('is fixed by itself: queued, running, fixed, with the events, the list, Compare and Undo', async () => {
    const { engine, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const before = titleRule(config, job);
    const seen: ServerEvent[] = [];
    engine.bus.subscribe((event) => seen.push(event));

    const note = await addRouted(engine, job, 'make the title yellow');
    await waitFixed(engine, note.id);

    // The composition changed and the note carries the fix.
    expect(titleRule(config, job)).toContain('#ffd60a');
    const fixed = engine.notes.get(note.id) as ReviewNote;
    expect(fixed.fixedAt).not.toBeNull();
    const statuses = seen.flatMap((event) => (event.type === 'job.fix' ? [event.fix.status] : []));
    expect(statuses[0]).toBe('queued');
    expect(statuses.at(-1)).toBe('fixed');
    expect(statuses).toContain('running');
    expect(seen.some((event) => event.type === 'job.fix' && event.fix.step === 3)).toBe(true);

    // The list and the stills.
    const list = jobFixesResponseSchema.parse(
      await (await engine.app.request(`/api/jobs/${job.id}/fixes`)).json(),
    );
    expect(list.fixes).toHaveLength(1);
    expect(list.fixes[0]).toMatchObject({
      id: fixed.fixId,
      noteId: note.id,
      status: 'fixed',
      said: 'The title is yellow now.',
      hasCompare: true,
    });
    for (const file of ['before.png', 'after.png']) {
      const res = await engine.app.request(
        `/api/jobs/${job.id}/fixes/${fixed.fixId}/compare/${file}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
    }

    // Undo puts the composition back; the note waits for Send.
    const undone = await engine.app.request(`/api/jobs/${job.id}/fixes/${fixed.fixId}/undo`, {
      method: 'POST',
    });
    expect(undone.status).toBe(200);
    expect(undoFixResponseSchema.parse(await undone.json()).fix.status).toBe('undone');
    expect(titleRule(config, job)).toBe(before);
    expect(engine.notes.get(note.id)).toMatchObject({ fixId: null, fixedAt: null });
  });

  it('runs two quick notes one after the other, the second on the first one’s result', async () => {
    const { engine, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);

    const first = await addRouted(engine, job, 'make the title yellow');
    const second = await addRouted(engine, job, 'the title should be bigger');
    await waitFixed(engine, first.id);
    await waitFixed(engine, second.id);

    const rule = titleRule(config, job);
    expect(rule).toContain('#ffd60a');
    expect(rule).toMatch(/font:\s*\d+\s+\d+px/);
    expect(fixesOf(engine, job).map((fix) => fix.status)).toEqual(['fixed', 'fixed']);
    // Only the newest can be undone.
    const older = fixesOf(engine, job)[0] as QuickFix;
    await expectError(
      await engine.app.request(`/api/jobs/${job.id}/fixes/${older.id}/undo`, { method: 'POST' }),
      409,
      FIX_MESSAGES.notNewest,
    );
  });

  it('leaves a note that the router calls bigger for Send, and one that the fix cannot do', async () => {
    const { engine, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const before = readFileSync(indexOf(config, job), 'utf8');

    // "swap this shot" is revise for the router: no fix at all.
    const revise = await addRouted(engine, job, 'swap this shot for the drone shot');
    expect(revise.route?.tier).toBe('revise');
    // "change the sign" is quick for the fake router; the stand-in fix says it is footage.
    const sign = await addRouted(engine, job, 'change the sign to English');
    await vi.waitFor(() =>
      expect(fixesOf(engine, job).map((fix) => fix.status)).toEqual(['escalated']),
    );

    expect(fixesOf(engine, job)[0]?.why).toBe('the sign is part of the footage');
    expect(engine.notes.get(sign.id)?.fixId).toBeNull();
    expect(engine.notes.get(revise.id)?.fixId).toBeNull();
    expect(readFileSync(indexOf(config, job), 'utf8')).toBe(before);
  });
});

describe('while a fix runs', () => {
  it('Send and Approve wait, and so do Export MP4 and Make another; they go again once it lands', async () => {
    const { engine, steps, config } = boot(tempConfig({ STUDIO_MUSIC: '1' }), {
      musicRunner: async () => ranOk('v3'),
    });
    await engine.start();
    const job = await inReview(engine, config);
    writeRecord(join(config.inboxPath, job.relPath, 'edit'), fixtureRecord());
    steps.hold();

    const note = await addRouted(engine, job, 'make the title yellow');
    await vi.waitFor(() => expect(fixesOf(engine, job)[0]?.status).toBe('running'));

    expect(engine.fixes?.reviewBlock(job.id)).toBe(FIX_MESSAGES.busy);
    await expectReviewError(() => engine.review.sendNotes(job.id), 409, FIX_MESSAGES.busy);
    // Approve is refused as well, with the fix's words (QF4: asked before the unsent-notes rule).
    await expectReviewError(() => engine.review.approve(job.id), 409, FIX_MESSAGES.busy);
    await expectError(
      await engine.app.request(`/api/jobs/${job.id}/review-export`, { method: 'POST' }),
      409,
      FIX_MESSAGES.busy,
    );
    await expectError(
      await engine.app.request(`/api/jobs/${job.id}/music`, { method: 'POST' }),
      409,
      FIX_MESSAGES.busy,
    );
    await expectError(
      await engine.app.request(`/api/jobs/${job.id}/music/pick`, {
        method: 'PUT',
        body: JSON.stringify({ id: 'v1' }),
        headers: { 'content-type': 'application/json' },
      }),
      409,
      FIX_MESSAGES.busy,
    );
    // The page is told Make another is off.
    const view = (await (await engine.app.request(`/api/jobs/${job.id}/music`)).json()) as {
      canMake: boolean;
      whyNot: string | null;
    };
    expect(view).toMatchObject({ canMake: false, whyNot: FIX_MESSAGES.busy });

    steps.open();
    await waitFixed(engine, note.id);
    expect(engine.fixes?.reviewBlock(job.id)).toBeNull();
    const export_ = await engine.app.request(`/api/jobs/${job.id}/review-export`, {
      method: 'POST',
    });
    expect(export_.status).toBe(200);
  });

  it('answers with the fix’s words first and the music’s when only the music is busy', async () => {
    let finish: (outcome: MusicScriptOutcome) => void = () => {};
    const { engine, steps, config } = boot(tempConfig({ STUDIO_MUSIC: '1' }), {
      musicRunner: () =>
        new Promise<MusicScriptOutcome>((resolve) => {
          finish = resolve;
        }),
    });
    await engine.start();
    const job = await inReview(engine, config);
    writeRecord(join(config.inboxPath, job.relPath, 'edit'), fixtureRecord());
    engine.review.addTextNote(job.id, { atSec: 1, text: 'a plain note that goes with Send' });
    steps.hold();

    // The music is being made: Send waits with its words, and a quick fix waits behind it.
    const making = await engine.app.request(`/api/jobs/${job.id}/music`, { method: 'POST' });
    expect(making.status).toBe(202);
    const musicWords = (await (await engine.app.request(`/api/jobs/${job.id}/music`)).json()) as {
      whyNot: string;
    };
    await expectReviewError(
      () => engine.review.sendNotes(job.id),
      409,
      engine.music?.reviewBlock(job.id) ?? '',
    );
    expect(musicWords.whyNot).toBe(engine.music?.reviewBlock(job.id));

    const quick = await addRouted(engine, job, 'make the title yellow');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixesOf(engine, job)[0]?.status).toBe('queued');
    expect(titleRule(config, job)).not.toContain('#ffd60a');
    // The fix's words come first once a fix is queued.
    await expectReviewError(() => engine.review.sendNotes(job.id), 409, FIX_MESSAGES.busy);

    // The music is done: the page hears it (job.music), and the fix goes.
    finish(ranOk('v3'));
    steps.open();
    await waitFixed(engine, quick.id);
    expect(titleRule(config, job)).toContain('#ffd60a');
  });
});

describe('the note rules', () => {
  it('refuses new words for a fixed note (409) and for a note whose fix runs', async () => {
    const { engine, steps, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    steps.hold();
    const note = await addRouted(engine, job, 'make the title yellow');
    await vi.waitFor(() => expect(fixesOf(engine, job)[0]?.status).toBe('running'));

    const patch = (id: string) =>
      engine.app.request(`/api/jobs/${job.id}/notes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: 'make it blue' }),
        headers: { 'content-type': 'application/json' },
      });
    await expectError(await patch(note.id), 409, FIX_MESSAGES.busy);

    steps.open();
    await waitFixed(engine, note.id);
    await expectError(await patch(note.id), 409, FIX_MESSAGES.editFixed);
    expect(engine.notes.get(note.id)?.text).toBe('make the title yellow');
  });

  it('cancels a queued fix when its note is deleted, refuses while it runs, undoes a fixed one first', async () => {
    const { engine, steps, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const original = readFileSync(indexOf(config, job), 'utf8');
    steps.hold();

    const running = await addRouted(engine, job, 'make the title yellow');
    await vi.waitFor(() => expect(fixesOf(engine, job)[0]?.status).toBe('running'));
    const queued = await addRouted(engine, job, 'the title should be bigger');
    expect(fixesOf(engine, job)[1]?.status).toBe('queued');

    await expectReviewError(
      () => engine.review.deleteNote(job.id, running.id),
      409,
      FIX_MESSAGES.busy,
    );
    await engine.review.deleteNote(job.id, queued.id);
    expect(fixesOf(engine, job)[1]?.status).toBe('cancelled');
    expect(engine.notes.get(queued.id)).toBeNull();

    steps.open();
    await waitFixed(engine, running.id);
    expect(titleRule(config, job)).toContain('#ffd60a');
    await engine.review.deleteNote(job.id, running.id);
    expect(fixesOf(engine, job)[0]?.status).toBe('undone');
    expect(readFileSync(indexOf(config, job), 'utf8')).toBe(original);
    expect(engine.notes.get(running.id)).toBeNull();
  });
});

describe('leaving Review, deleting the job, shutdown and a boot after a crash', () => {
  it('stops the running fix and cancels the queued one when the job is archived', async () => {
    const { engine, steps, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const original = readFileSync(indexOf(config, job), 'utf8');
    steps.hold();
    await addRouted(engine, job, 'make the title yellow');
    await vi.waitFor(() => expect(fixesOf(engine, job)[0]?.status).toBe('running'));
    await addRouted(engine, job, 'the title should be bigger');

    const res = await engine.app.request('/api/jobs/archive', {
      method: 'POST',
      body: JSON.stringify({ ids: [job.id] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() =>
      expect(fixesOf(engine, engine.jobs.get(job.id) as Job).map((fix) => fix.status)).toEqual([
        'failed',
        'cancelled',
      ]),
    );
    expect(readFileSync(indexOf(config, job), 'utf8')).toBe(original);
    expect(engine.fixes?.reviewBlock(job.id)).toBeNull();
  });

  it('stops the fixes before a job is deleted, and does not bring its folder back', async () => {
    const { engine, steps, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    steps.hold();
    await addRouted(engine, job, 'make the title yellow');
    await vi.waitFor(() => expect(fixesOf(engine, job)[0]?.status).toBe('running'));

    const res = await engine.app.request(`/api/jobs/${job.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    // The stopped fix publishes the job once more, which starts the preview video (ReviewWarmup);
    // that make is still looking for ffmpeg while Delete removes the folder, and used to make
    // `<job>/edit` again (C89: first with a recursive mkdir, 4 runs of 5; then, while `rm -r` was
    // still emptying the folder, with a plain one, about 1 run in 20 under load). Delete's
    // `job.remove` now stops the make before the rm starts. The proof is in preview-video.test.ts,
    // review-export.test.ts and engine-review-warmup.test.ts; this waits for it to have tried.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(existsSync(join(config.inboxPath, job.relPath))).toBe(false);
    expect(engine.jobs.get(job.id)).toBeNull();
    expect(engine.fixes?.reviewBlock(job.id)).toBeNull();
  });

  it('stops a running fix at shutdown and puts its copy back', async () => {
    const { engine, steps, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const original = readFileSync(indexOf(config, job), 'utf8');
    steps.hold();
    await addRouted(engine, job, 'make the title yellow');
    await vi.waitFor(() => expect(fixesOf(engine, job)[0]?.status).toBe('running'));

    await engine.stop();

    expect(readFileSync(indexOf(config, job), 'utf8')).toBe(original);
    expect(fixesOf(engine, job)[0]).toMatchObject({
      status: 'failed',
      why: FIX_SERVICE_MESSAGES.engineStopped,
    });
  });

  it('marks what a crashed engine left running failed, puts its copy back and cancels its queue', async () => {
    const db = memoryDb();
    const config = tempConfig();
    const first = boot(config, { db });
    const job = await inReview(first.engine, config);
    const original = readFileSync(indexOf(config, job), 'utf8');
    const running = first.engine.notes.create({
      id: 'r1',
      jobId: job.id,
      kind: 'text',
      atSec: 1,
      text: 'make the title yellow',
    });
    const queued = first.engine.notes.create({
      id: 'q1',
      jobId: job.id,
      kind: 'text',
      atSec: 2,
      text: 'the title should be bigger',
    });
    // The earlier engine: a copy of the preview, a half-done change, and two rows.
    const fixDir = join(config.inboxPath, job.relPath, fixDirPath('crashed'));
    mkdirSync(join(fixDir, 'before'), { recursive: true });
    cpSync(
      join(config.inboxPath, job.relPath, 'edit', 'preview'),
      join(fixDir, 'before', 'preview'),
      { recursive: true },
    );
    writeFileSync(indexOf(config, job), '<html>half done</html>');
    const repo = new QuickFixRepository(db);
    const row = (id: string, noteId: string, status: QuickFix['status']): QuickFix => ({
      id,
      jobId: job.id,
      noteId,
      round: 1,
      status,
      step: null,
      stepLabel: null,
      said: null,
      why: null,
      model: 'sonnet',
      effort: 'medium',
      startedAt: status === 'running' ? '2026-10-25T09:00:00.000Z' : null,
      endedAt: null,
      durationSec: null,
      hasCompare: false,
    });
    repo.insert(row('crashed', running.id, 'running'));
    repo.insert(row('waiting', queued.id, 'queued'));
    const seen: ServerEvent[] = [];
    first.engine.bus.subscribe((event) => seen.push(event));

    await first.engine.start();

    expect(readFileSync(indexOf(config, job), 'utf8')).toBe(original);
    expect(repo.get('crashed')?.status).toBe('failed');
    expect(repo.get('waiting')?.status).toBe('cancelled');
    expect(
      seen.flatMap((event) =>
        event.type === 'job.fix' ? [`${event.fix.id}:${event.fix.status}`] : [],
      ),
    ).toEqual(['crashed:failed', 'waiting:cancelled']);
  });
});

// QF4 (CVP-376): a note fixed in Review ends the round with the others.
describe('a round with notes fixed in Review', () => {
  const roundFile = (config: Config, job: Job, n = 1) =>
    readFileSync(join(config.inboxPath, job.relPath, `edit/review/round-${n}.md`), 'utf8');
  const fixesDir = (config: Config, job: Job) =>
    join(config.inboxPath, job.relPath, FIXES_DIR_PATH);

  it('Send lists the fixed note as already changed, saves the tier the waiting note needs and clears the fix files', async () => {
    const { engine, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);

    const fixed = await addRouted(engine, job, 'make the title yellow');
    await waitFixed(engine, fixed.id);
    const waiting = await addRouted(engine, job, 'swap this shot for the drone shot');
    expect(waiting.route?.tier).toBe('revise');
    expect(existsSync(fixesDir(config, job))).toBe(true);

    const res = await engine.app.request(`/api/jobs/${job.id}/send-notes`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(engine.jobs.get(job.id)).toMatchObject({
      state: 'queued',
      runKind: 'revise',
      round: 1,
      reviseTier: 'revise',
    });
    const file = roundFile(config, job);
    expect(file).toContain('- 0:02.0 — swap this shot for the drone shot\n');
    expect(file).toContain(
      "## Already changed in Review (keep these)\n\nThe owner's other notes below were already done",
    );
    expect(file).toContain(
      '- 0:02.0 — make the title yellow\n  Changed: The title is yellow now.\n',
    );
    expect(file.indexOf('swap this shot')).toBeLessThan(file.indexOf('Already changed'));
    expect(engine.notes.get(fixed.id)).toMatchObject({ round: 1 });
    expect(engine.notes.get(waiting.id)).toMatchObject({ round: 1 });
    // The round's fix files are gone; the row stays.
    expect(existsSync(fixesDir(config, job))).toBe(false);
    const fixId = engine.notes.get(fixed.id)?.fixId as string;
    expect(engine.fixes?.find(job.id, fixId)?.status).toBe('fixed');
  });

  it('Send with only a fixed note answers 409 and sends nothing; Approve works instead', async () => {
    const { engine, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const fixed = await addRouted(engine, job, 'make the title yellow');
    await waitFixed(engine, fixed.id);

    await expectError(
      await engine.app.request(`/api/jobs/${job.id}/send-notes`, { method: 'POST' }),
      409,
      FIX_MESSAGES.onlyFixed,
    );
    expect(engine.jobs.get(job.id)).toMatchObject({ state: 'review', round: 0 });
    expect(existsSync(fixesDir(config, job))).toBe(true);

    const approved = await engine.app.request(`/api/jobs/${job.id}/approve`, { method: 'POST' });

    expect(approved.status).toBe(200);
    expect(engine.jobs.get(job.id)).toMatchObject({ state: 'queued', runKind: 'render', round: 0 });
    expect(engine.notes.get(fixed.id)).toMatchObject({ round: 1 });
    expect(engine.notes.listUnsent(job.id)).toEqual([]);
    expect(existsSync(fixesDir(config, job))).toBe(false);
    // The render uses the preview as the fix left it.
    expect(titleRule(config, job)).toContain('#ffd60a');
  });

  it('Approve with a fixed note and a waiting one answers 409 as ever', async () => {
    const { engine, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const fixed = await addRouted(engine, job, 'make the title yellow');
    await waitFixed(engine, fixed.id);
    await addRouted(engine, job, 'swap this shot for the drone shot');

    await expectError(
      await engine.app.request(`/api/jobs/${job.id}/approve`, { method: 'POST' }),
      409,
      REVIEW_MESSAGES.sendOrDeleteFirst,
    );
    expect(engine.jobs.get(job.id)?.state).toBe('review');
    expect(engine.notes.get(fixed.id)?.round).toBeNull();
  });

  it('Send waits while Auto is still reading a note', async () => {
    const { engine, config } = boot(tempConfig(), {
      // A router that never answers, but stops when it is told to.
      noteRouter: {
        route: (_job, _note, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      },
    });
    await engine.start();
    const job = await inReview(engine, config);
    engine.review.addTextNote(job.id, { atSec: 2, text: 'make the title yellow' });

    await expectError(
      await engine.app.request(`/api/jobs/${job.id}/send-notes`, { method: 'POST' }),
      409,
      FIX_MESSAGES.waitForAuto,
    );
    expect(engine.jobs.get(job.id)?.state).toBe('review');
  });

  it('a level chosen in Review sends every note as before, with no tier', async () => {
    const { engine, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const set = await engine.app.request(`/api/jobs/${job.id}/review-effort`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'high' }),
    });
    expect(set.status).toBe(200);
    expect(engine.jobs.get(job.id)?.reviewEffort).toBe('high');
    engine.review.addTextNote(job.id, { atSec: 2, text: 'make the title yellow' });
    await new Promise((resolve) => setTimeout(resolve, 450));

    const res = await engine.app.request(`/api/jobs/${job.id}/send-notes`, { method: 'POST' });

    expect(res.status).toBe(200);
    // Auto never read it: the note is a plain one, and the run is at the level chosen.
    expect(engine.jobs.get(job.id)).toMatchObject({
      state: 'queued',
      reviewEffort: 'high',
      reviseTier: null,
    });
    expect(roundFile(config, job)).not.toContain('Already changed');
  });

  it('the review effort is published, and Auto can be chosen again', async () => {
    const { engine, config } = boot(tempConfig());
    await engine.start();
    const job = await inReview(engine, config);
    const seen: Job[] = [];
    engine.bus.subscribe((event) => {
      if (event.type === 'job.upsert') seen.push(event.job);
    });
    const put = (effort: string) =>
      engine.app.request(`/api/jobs/${job.id}/review-effort`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort }),
      });

    expect((await put('medium')).status).toBe(200);
    expect((await put('auto')).status).toBe(200);

    expect(seen.map((upsert) => upsert.reviewEffort)).toEqual(['medium', null]);
  });
});

describe('with the switch off', () => {
  it('has no service, no route, no block and no router: Review is as it was', async () => {
    const { engine, config } = boot(tempConfig({ STUDIO_QUICK_FIXES: '0' }));
    await engine.start();
    const job = await inReview(engine, config);

    expect(engine.fixes).toBeNull();
    const added = engine.review.addTextNote(job.id, { atSec: 2, text: 'make the title yellow' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(engine.notes.get(added.id)).toMatchObject({ routeStatus: null, fixId: null });
    for (const [method, path] of [
      ['GET', `/api/jobs/${job.id}/fixes`],
      ['POST', `/api/jobs/${job.id}/fixes/x/undo`],
      ['GET', `/api/jobs/${job.id}/fixes/x/compare/before.png`],
    ] as const) {
      await expectError(await engine.app.request(path, { method }), 404, FIX_MESSAGES.off);
    }
    // Review's own effort has no route either (QF4).
    await expectError(
      await engine.app.request(`/api/jobs/${job.id}/review-effort`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'high' }),
      }),
      404,
      FIX_MESSAGES.off,
    );
    expect(engine.jobs.get(job.id)?.reviewEffort).toBeNull();
    // Send is not blocked by anything, and saves no tier.
    const sent = await engine.review.sendNotes(job.id);
    expect(sent).toMatchObject({ state: 'queued', reviseTier: null });
  });
});
