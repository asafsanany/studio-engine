import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Effort, Job, JobEvent, NoteRoute, ReviewNote, ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRepository, NoteRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import type { VoiceJob, VoiceTranscript } from '../pipeline/voice-transcriber.js';
import { UNREADABLE_ROUTE } from './fix-router.js';
import { createNoteRouting, NO_NOTE_ROUTING, ROUTE_MAX_AT_ONCE } from './note-routing.js';
import { createReviewService, type ReviewService } from './review-service.js';

// The hook that routes notes (QF1): the real review service and repositories on an in-memory
// database, a bus that records every event, a transcriber stand-in and a router whose every
// answer the test gives by hand.

const REVIEW_PATH: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
];
const EDITING_PATH: JobEvent[] = [{ type: 'SETTLED' }, { type: 'START' }];

const QUICK: NoteRoute = { tier: 'quick', kind: 'Changing the caption font', why: '' };
const REVISE: NoteRoute = { tier: 'revise', kind: 'Replacing a shot', why: 'it changes the cut' };
const FULL: NoteRoute = {
  tier: 'full',
  kind: 'Pacing',
  why: 'it changes the whole video',
};

interface RouterCall {
  job: Job;
  note: ReviewNote;
  signal: AbortSignal | undefined;
  answer(route: NoteRoute | unknown): void;
  fail(error: unknown): void;
}

/** A router that records every call and lets the test answer each one by hand (an abort rejects it). */
function handRouter() {
  const calls: RouterCall[] = [];
  const router = {
    route(job: Job, note: ReviewNote, signal?: AbortSignal): Promise<NoteRoute> {
      return new Promise<NoteRoute>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        calls.push({
          job,
          note,
          signal,
          answer: (route) => resolve(route as NoteRoute),
          fail: reject,
        });
      });
    },
  };
  return { router, calls };
}

const dirs: string[] = [];
const opened: StudioDb[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface SetupOptions {
  /** `config.quickFixes`. Default on. */
  enabled?: boolean;
  maxAtOnce?: number;
  onRouted?: (job: Job, note: ReviewNote) => void;
}

function setup(options: SetupOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), 'studio-note-routing-'));
  dirs.push(base);
  const inboxPath = join(base, 'inbox');
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const hand = handRouter();
  const routed: Array<{ job: Job; note: ReviewNote }> = [];
  const routing =
    options.enabled === false
      ? NO_NOTE_ROUTING
      : createNoteRouting({
          enabled: true,
          router: hand.router,
          jobs,
          notes,
          bus,
          onRouted: (job, note) => {
            routed.push({ job, note });
            options.onRouted?.(job, note);
          },
          maxAtOnce: options.maxAtOnce,
          logger,
        });

  // A transcriber whose results the test decides, per recording.
  const transcriptions: Array<{
    file: string;
    resolve(text: string): void;
    reject(e: unknown): void;
  }> = [];
  const transcriber = {
    enqueue(job: VoiceJob): Promise<VoiceTranscript> {
      return new Promise<VoiceTranscript>((resolve, reject) => {
        transcriptions.push({
          file: basename(job.audioPath),
          resolve: (text) => resolve({ text }),
          reject,
        });
      });
    },
  };
  let counter = 0;
  const review: ReviewService = createReviewService({
    db,
    jobs,
    notes,
    bus,
    inboxPath,
    transcriber,
    logger,
    routing,
    clock,
    newId: () => `n${++counter}`,
  });

  function addJob(path: JobEvent[] = REVIEW_PATH, name = 'Spring menu'): Job {
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', name));
    for (const event of path) jobs.applyTransition(job.id, event);
    mkdirSync(join(inboxPath, job.relPath), { recursive: true });
    return jobs.get(job.id) as Job;
  }

  const upserts = (noteId?: string): ReviewNote[] =>
    events.flatMap((event) =>
      event.type === 'note.upsert' && (noteId === undefined || event.note.id === noteId)
        ? [event.note]
        : [],
    );

  return {
    db,
    jobs,
    notes,
    bus,
    events,
    logger,
    review,
    routing,
    hand,
    routed,
    transcriptions,
    addJob,
    upserts,
  };
}

/** Lets the promise callbacks and the router's start run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const voice = { audio: WEBM, type: 'audio/webm' as const, atSec: 7.8, audioSec: 12 };

describe('a text note on Auto in Review with quick fixes on', () => {
  it('is pending when it is added, and routed when the router answers', async () => {
    const h = setup();
    const job = h.addJob();

    const added = h.review.addTextNote(job.id, { atSec: 12, text: 'Change the caption font' });
    expect(added).toMatchObject({ routeStatus: 'pending', route: null });
    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: 'pending', route: null });
    await flush();
    expect(h.hand.calls).toHaveLength(1);
    expect(h.hand.calls[0]?.job.id).toBe(job.id);
    expect(h.hand.calls[0]?.note).toMatchObject({ id: added.id, text: 'Change the caption font' });

    h.hand.calls[0]?.answer(QUICK);
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: 'routed', route: QUICK });
    // note.upsert twice: pending, then routed.
    expect(h.upserts().map((note) => [note.routeStatus, note.route])).toEqual([
      ['pending', null],
      ['routed', QUICK],
    ]);
  });

  it('calls onRouted with the job and the routed note, after the second note.upsert', async () => {
    const order: string[] = [];
    const h = setup({ onRouted: () => order.push('onRouted') });
    h.bus.subscribe((event) => {
      if (event.type === 'note.upsert') order.push(`upsert ${event.note.routeStatus}`);
    });
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'Swap this shot' });
    await flush();
    h.hand.calls[0]?.answer(REVISE);
    await flush();

    expect(order).toEqual(['upsert pending', 'upsert routed', 'onRouted']);
    expect(h.routed).toHaveLength(1);
    expect(h.routed[0]?.job.id).toBe(job.id);
    expect(h.routed[0]?.note).toMatchObject({ id: added.id, routeStatus: 'routed', route: REVISE });
  });

  it('does not stop at an onRouted that throws', async () => {
    const h = setup({
      onRouted: () => {
        throw new Error('boom');
      },
    });
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'x' });
    await flush();
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    expect(h.notes.get(added.id)?.routeStatus).toBe('routed');
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it('routes every one of several notes', async () => {
    const h = setup();
    const job = h.addJob();
    const a = h.review.addTextNote(job.id, { atSec: 1, text: 'one' });
    const b = h.review.addTextNote(job.id, { atSec: 2, text: 'two' });
    await flush();
    expect(h.hand.calls.map((call) => call.note.id)).toEqual([a.id, b.id]);
    h.hand.calls[1]?.answer(FULL);
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    expect(h.notes.get(a.id)?.route).toEqual(QUICK);
    expect(h.notes.get(b.id)?.route).toEqual(FULL);
  });
});

describe('when a note is not routed', () => {
  it('leaves every note alone with the switch off', async () => {
    const h = setup({ enabled: false });
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'Change the font' });
    h.review.updateNote(job.id, added.id, { text: 'Change the font to Heebo' });
    await flush();

    expect(h.hand.calls).toHaveLength(0);
    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: null, route: null });
    expect(h.upserts().every((note) => note.routeStatus === null)).toBe(true);
    expect(h.upserts()).toHaveLength(2); // the add and the edit, as ever
  });

  it('leaves a note alone with the switch off even when it carries a sorting', () => {
    const routing = createNoteRouting({
      enabled: false,
      router: handRouter().router,
      jobs: { get: () => null },
      notes: {
        get: () => null,
        setRoute: () => {
          throw new Error('must not be touched');
        },
        listRoutePending: () => [],
      },
      bus: createEventBus(),
    });
    const note = { id: 'n1', route: QUICK, routeStatus: 'routed' } as ReviewNote;
    expect(routing.begin(note)).toBe(note);
    expect(() => routing.resume()).not.toThrow();
  });

  it.each<Effort>(['medium', 'high', 'xhigh'])(
    'does not route on a manual level (%s)',
    async (level) => {
      const h = setup();
      const job = h.addJob();
      h.jobs.setReviewEffort(job.id, level);
      const added = h.review.addTextNote(job.id, { atSec: 1, text: 'Change the font' });
      await flush();

      expect(added).toMatchObject({ routeStatus: null, route: null });
      expect(h.hand.calls).toHaveLength(0);
      expect(h.upserts()).toHaveLength(1);
    },
  );

  it('does not route a note of a job that is not in Review', async () => {
    const h = setup();
    const job = h.addJob(EDITING_PATH, 'Still editing');
    const note = h.notes.create({ id: 'x1', jobId: job.id, kind: 'text', atSec: 1, text: 'font' });

    expect(h.routing.begin(note)).toEqual(note);
    await flush();
    expect(h.hand.calls).toHaveLength(0);
    expect(h.notes.get('x1')?.routeStatus).toBeNull();
    expect(h.events).toEqual([]);
  });

  it('does not route a note that was sent already', async () => {
    const h = setup();
    const job = h.addJob();
    const note = h.notes.create({ id: 'x1', jobId: job.id, kind: 'text', atSec: 1, text: 'font' });
    const [sent] = h.notes.markSent(job.id, ['x1'], 1, '2026-10-25T10:00:00.000Z');

    expect(h.routing.begin(sent as ReviewNote)).toEqual(sent);
    await flush();
    expect(note.round).toBeNull();
    expect(h.hand.calls).toHaveLength(0);
  });
});

describe('a voice note', () => {
  it('is not routed when it is added, and is routed once its transcript is done', async () => {
    const h = setup();
    const job = h.addJob();
    const added = await h.review.addVoiceNote(job.id, voice);
    await flush();

    expect(added).toMatchObject({ routeStatus: null, transcriptStatus: 'pending' });
    expect(h.hand.calls).toHaveLength(0);

    h.transcriptions[0]?.resolve('תעשה את הכתוביות צהובות');
    await flush();

    expect(h.hand.calls).toHaveLength(1);
    expect(h.hand.calls[0]?.note).toMatchObject({ id: added.id, text: 'תעשה את הכתוביות צהובות' });
    // One upsert carries the transcript and the pending state together.
    expect(h.upserts(added.id).at(-1)).toMatchObject({
      transcriptStatus: 'done',
      text: 'תעשה את הכתוביות צהובות',
      routeStatus: 'pending',
    });

    h.hand.calls[0]?.answer(QUICK);
    await flush();
    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: 'routed', route: QUICK });
    expect(h.routed).toHaveLength(1);
  });

  it('is not routed when its transcript failed', async () => {
    const h = setup();
    const job = h.addJob();
    const added = await h.review.addVoiceNote(job.id, voice);
    h.transcriptions[0]?.reject(new Error('no speech'));
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ transcriptStatus: 'failed', routeStatus: null });
    expect(h.hand.calls).toHaveLength(0);
  });

  it('is not routed when its transcript lands after Auto was switched off', async () => {
    const h = setup();
    const job = h.addJob();
    const added = await h.review.addVoiceNote(job.id, voice);
    h.jobs.setReviewEffort(job.id, 'high');
    h.transcriptions[0]?.resolve('make it yellow');
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ text: 'make it yellow', routeStatus: null });
    expect(h.hand.calls).toHaveLength(0);
  });
});

describe('an answer that no longer fits', () => {
  it('is dropped when the text changed meanwhile, and the new text is read instead', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();
    const first = h.hand.calls[0];

    const edited = h.review.updateNote(job.id, added.id, { text: 'make it red' });
    expect(edited).toMatchObject({ routeStatus: 'pending', route: null, text: 'make it red' });
    expect(first?.signal?.aborted).toBe(true); // the old reading is stopped
    await flush();
    expect(h.hand.calls).toHaveLength(2);
    expect(h.hand.calls[1]?.note.text).toBe('make it red');

    first?.answer(FULL); // too late: it was for the old words
    h.hand.calls[1]?.answer(QUICK);
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: 'routed', route: QUICK });
    expect(h.upserts().map((note) => note.routeStatus)).toEqual(['pending', 'pending', 'routed']);
  });

  it('is dropped when the text was changed under the router, without a new reading', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();

    h.notes.update(added.id, { text: 'something else' }); // not through the service
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: 'pending', route: null });
    expect(h.upserts().map((note) => note.routeStatus)).toEqual(['pending']);
  });

  it('is dropped when the note was deleted meanwhile', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();
    const call = h.hand.calls[0];

    await h.review.deleteNote(job.id, added.id);
    expect(call?.signal?.aborted).toBe(true);
    call?.answer(QUICK);
    await flush();

    expect(h.notes.get(added.id)).toBeNull();
    expect(h.events.map((event) => event.type)).toEqual(['note.upsert', 'note.remove']);
    expect(h.routed).toEqual([]);
  });

  it('is dropped when the note was sent meanwhile', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();

    h.notes.markSent(job.id, [added.id], 1, '2026-10-25T10:00:00.000Z');
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ round: 1, routeStatus: 'pending', route: null });
    expect(h.routed).toEqual([]);
  });

  it('is dropped, and the sorting taken off, when Auto was switched off meanwhile', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();

    h.jobs.setReviewEffort(job.id, 'high');
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: null, route: null });
    expect(h.upserts().at(-1)).toMatchObject({ routeStatus: null });
    expect(h.routed).toEqual([]);
  });

  it('stops the reading of the notes of a job that is removed', async () => {
    const h = setup();
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();
    const call = h.hand.calls[0];

    h.bus.publish({ type: 'job.remove', id: job.id });
    expect(call?.signal?.aborted).toBe(true);
  });
});

describe('editing a note', () => {
  it('does not read it again when its text did not change', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    const updated = h.review.updateNote(job.id, added.id, {
      text: 'make it yellow',
      addToStyle: true,
    });
    await flush();

    expect(updated).toMatchObject({ routeStatus: 'routed', route: QUICK, addToStyle: true });
    expect(h.hand.calls).toHaveLength(1);
  });

  it('reads a routed note again when its text changes, and drops the old sorting at once', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    const updated = h.review.updateNote(job.id, added.id, { text: 'swap this shot' });
    expect(updated).toMatchObject({ routeStatus: 'pending', route: null });
    await flush();
    h.hand.calls[1]?.answer(REVISE);
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: 'routed', route: REVISE });
  });

  it('takes the old sorting off a note whose text changes on a manual level', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    h.jobs.setReviewEffort(job.id, 'medium');
    const updated = h.review.updateNote(job.id, added.id, { text: 'swap this shot' });

    expect(updated).toMatchObject({ routeStatus: null, route: null, text: 'swap this shot' });
    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: null, route: null });
    expect(h.upserts().at(-1)).toMatchObject({ routeStatus: null, text: 'swap this shot' });
    expect(h.hand.calls).toHaveLength(1);
  });
});

describe('when the router fails', () => {
  it('saves the full route when the router rejects', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();

    h.hand.calls[0]?.fail(new Error('no network'));
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: 'routed', route: UNREADABLE_ROUTE });
    expect(h.logger.warn).toHaveBeenCalled();
    expect(h.routed).toHaveLength(1);
  });

  it('saves the full route when the router answers something that is not a route', async () => {
    const h = setup();
    const job = h.addJob();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'make it yellow' });
    await flush();

    h.hand.calls[0]?.answer({ tier: 'quick', kind: 'x', why: 'a quick note has no why' });
    await flush();

    expect(h.notes.get(added.id)).toMatchObject({ routeStatus: 'routed', route: UNREADABLE_ROUTE });
  });
});

describe('how many run at once', () => {
  it('reads at most three notes at the same time over all jobs, the rest wait', async () => {
    const h = setup();
    const one = h.addJob(REVIEW_PATH, 'One');
    const two = h.addJob(REVIEW_PATH, 'Two');
    const ids = [
      h.review.addTextNote(one.id, { atSec: 1, text: 'a' }).id,
      h.review.addTextNote(one.id, { atSec: 2, text: 'b' }).id,
      h.review.addTextNote(two.id, { atSec: 1, text: 'c' }).id,
      h.review.addTextNote(two.id, { atSec: 2, text: 'd' }).id,
      h.review.addTextNote(one.id, { atSec: 3, text: 'e' }).id,
    ];
    await flush();

    expect(ROUTE_MAX_AT_ONCE).toBe(3);
    expect(h.hand.calls.map((call) => call.note.id)).toEqual(ids.slice(0, 3));
    expect(ids.slice(3).map((id) => h.notes.get(id)?.routeStatus)).toEqual(['pending', 'pending']);

    h.hand.calls[1]?.answer(QUICK); // one finishes: the next in line starts
    await flush();
    expect(h.hand.calls.map((call) => call.note.id)).toEqual(ids.slice(0, 4));

    h.hand.calls[0]?.answer(QUICK);
    h.hand.calls[2]?.answer(QUICK);
    await flush();
    expect(h.hand.calls.map((call) => call.note.id)).toEqual(ids);

    h.hand.calls[3]?.answer(REVISE);
    h.hand.calls[4]?.answer(FULL);
    await flush();
    expect(ids.map((id) => h.notes.get(id)?.routeStatus)).toEqual(Array(5).fill('routed'));
  });

  it('does not start a waiting note that was deleted before its turn', async () => {
    const h = setup({ maxAtOnce: 1 });
    const job = h.addJob();
    const first = h.review.addTextNote(job.id, { atSec: 1, text: 'a' });
    const waiting = h.review.addTextNote(job.id, { atSec: 2, text: 'b' });
    const last = h.review.addTextNote(job.id, { atSec: 3, text: 'c' });
    await flush();
    expect(h.hand.calls).toHaveLength(1);

    await h.review.deleteNote(job.id, waiting.id);
    h.hand.calls[0]?.answer(QUICK);
    await flush();

    expect(h.hand.calls.map((call) => call.note.id)).toEqual([first.id, last.id]);
  });
});

describe('shutdown and boot', () => {
  it('stops the runs that go and the ones that wait, and waits for them', async () => {
    const h = setup({ maxAtOnce: 1 });
    const job = h.addJob();
    const going = h.review.addTextNote(job.id, { atSec: 1, text: 'a' });
    const waiting = h.review.addTextNote(job.id, { atSec: 2, text: 'b' });
    await flush();
    const call = h.hand.calls[0];
    const eventsBefore = h.events.length;

    await h.routing.stop();

    expect(call?.signal?.aborted).toBe(true);
    await flush();
    expect(h.hand.calls).toHaveLength(1); // the waiting one never starts
    expect(h.events).toHaveLength(eventsBefore); // and nothing is saved or published
    // Both stay pending in the database: the next boot reads them again.
    expect([going.id, waiting.id].map((id) => h.notes.get(id)?.routeStatus)).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('routes no note once it is stopped', async () => {
    const h = setup();
    const job = h.addJob();
    await h.routing.stop();
    const added = h.review.addTextNote(job.id, { atSec: 1, text: 'a' });
    await flush();

    expect(added.routeStatus).toBeNull();
    expect(h.hand.calls).toHaveLength(0);
  });

  it('reads again at boot the notes an earlier engine left pending', async () => {
    const h = setup();
    const job = h.addJob();
    const note = h.notes.create({
      id: 'old1',
      jobId: job.id,
      kind: 'text',
      atSec: 4,
      text: 'font',
    });
    h.notes.setRoute(note.id, { status: 'pending' });

    h.routing.resume();
    await flush();

    expect(h.hand.calls).toHaveLength(1);
    expect(h.upserts('old1').at(-1)).toMatchObject({ routeStatus: 'pending' });
    h.hand.calls[0]?.answer(QUICK);
    await flush();
    expect(h.notes.get('old1')).toMatchObject({ routeStatus: 'routed', route: QUICK });
  });

  it('takes a pending sorting off a note that is no longer on Auto at boot', async () => {
    const h = setup();
    const job = h.addJob();
    h.jobs.setReviewEffort(job.id, 'high');
    const note = h.notes.create({
      id: 'old1',
      jobId: job.id,
      kind: 'text',
      atSec: 4,
      text: 'font',
    });
    h.notes.setRoute(note.id, { status: 'pending' });

    h.routing.resume();
    await flush();

    expect(h.hand.calls).toHaveLength(0);
    expect(h.notes.get('old1')).toMatchObject({ routeStatus: null, route: null });
    expect(h.upserts('old1').at(-1)).toMatchObject({ routeStatus: null });
  });
});
