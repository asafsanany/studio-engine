// When a review note is routed (quick fixes, QF1). The review service tells this when a note is
// added, when its text changes and when a voice note's transcript is done; this decides whether Auto
// reads it and keeps the note's `routeStatus` and `route` up to date:
//
//   - Only while the `quickFixes` switch is on, the job is in Review and its review effort is Auto
//     (`job.reviewEffort === null`). Anything else leaves the note alone, except that a note whose
//     text changed loses a sorting it already has (it was for the old text).
//   - `begin(note)` saves `routeStatus = 'pending'` at once and returns the note as it now stands; the
//     caller publishes it (`note.upsert`). The router then reads the note in the background (at most
//     three runs at once over all jobs, the rest wait their turn), the route is saved with
//     `routeStatus = 'routed'` and published (`note.upsert` again), and then `onRouted(job, note)`
//     is called (QF3 hooks the fix service there).
//   - The answer is dropped when the note was deleted, sent or changed while the router read it, and
//     when Auto was switched off meanwhile (the sorting is then taken off the note).
//   - A router that fails or answers nonsense gives the `full` route: a note is never stuck pending.
//   - A note left pending by an engine that stopped is read again at the next start (`resume`).
//   - `stop()` stops the runs that are going (and the ones that wait) and waits for them.

import { type Job, type NoteRoute, noteRouteSchema, type ReviewNote } from '@studio/shared';
import type { JobRepository, NoteRepository } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import { type NoteRouter, UNREADABLE_ROUTE } from './fix-router.js';

/** Router runs at the same time over all jobs; the rest wait. */
export const ROUTE_MAX_AT_ONCE = 3;

export interface NoteRoutingOptions {
  /** `config.quickFixes`. Off: nothing is routed and no note is touched. */
  enabled: boolean;
  router: NoteRouter;
  jobs: Pick<JobRepository, 'get'>;
  notes: Pick<NoteRepository, 'get' | 'setRoute' | 'listRoutePending'>;
  /** Publishes `note.upsert`; listens for `job.remove`. */
  bus: EventBus;
  /** Called once a note is routed, with the job and the note (QF3: the fix service). It must not throw. Default: nothing. */
  onRouted?: (job: Job, note: ReviewNote) => void;
  /** Default {@link ROUTE_MAX_AT_ONCE}. */
  maxAtOnce?: number;
  logger?: RunnerLogger;
}

export interface NoteRouting {
  /** Whether Auto routes notes at all (the switch). */
  readonly enabled: boolean;
  /**
   * A note was added, its text changed or its transcript is done. Starts reading it when Auto
   * applies, and returns the note as it now stands (`pending`, or with an old sorting taken off);
   * the caller publishes that. Any earlier read of the same note is stopped.
   */
  begin(note: ReviewNote): ReviewNote;
  /** The note was deleted: stops reading it. */
  forget(noteId: string): void;
  /** Boot: reads again the notes an earlier engine left pending. */
  resume(): void;
  /** Shutdown: stops every run and waits for them. No note is read from here on. */
  stop(): Promise<void>;
}

/** Routing that never routes: the default of a review service built without it. */
export const NO_NOTE_ROUTING: NoteRouting = {
  enabled: false,
  begin: (note) => note,
  forget: () => {},
  resume: () => {},
  stop: async () => {},
};

/** One note being read: the text it was read for, and the way to stop it. */
interface RouteTask {
  noteId: string;
  jobId: string;
  /** The note as it was when its sorting began; the router reads this. */
  note: ReviewNote;
  text: string;
  controller: AbortController;
}

export function createNoteRouting(options: NoteRoutingOptions): NoteRouting {
  const {
    enabled,
    router,
    jobs,
    notes,
    bus,
    onRouted = () => {},
    maxAtOnce = ROUTE_MAX_AT_ONCE,
    logger = SILENT_LOGGER,
  } = options;

  /** The task that reads each note (running or waiting). */
  const tasks = new Map<string, RouteTask>();
  const waiting: RouteTask[] = [];
  const inflight = new Set<Promise<void>>();
  let active = 0;
  let stopped = false;

  const publishUpsert = (note: ReviewNote): void => bus.publish({ type: 'note.upsert', note });

  // A removed job takes its notes with it: stop reading them.
  const unsubscribe = bus.subscribe((event) => {
    if (event.type !== 'job.remove') return;
    for (const task of [...tasks.values()]) {
      if (task.jobId === event.id) cancel(task.noteId);
    }
  });

  function cancel(noteId: string): void {
    const task = tasks.get(noteId);
    if (task === undefined) return;
    tasks.delete(noteId);
    const queued = waiting.indexOf(task);
    if (queued !== -1) waiting.splice(queued, 1);
    task.controller.abort();
  }

  /** Whether Auto reads this note: the job is in Review on Auto and the note is unsent text. */
  function applies(note: ReviewNote): Job | null {
    if (note.round !== null || (note.text?.trim() ?? '') === '') return null;
    const job = jobs.get(note.jobId);
    return job !== null && job.state === 'review' && job.reviewEffort === null ? job : null;
  }

  function pump(): void {
    while (!stopped && active < maxAtOnce) {
      const task = waiting.shift();
      if (task === undefined) return;
      if (task.controller.signal.aborted) continue;
      active++;
      const run = read(task).finally(() => {
        active--;
        inflight.delete(run);
        pump();
      });
      inflight.add(run);
    }
  }

  /** Asks the router, then saves its answer if it still fits the note. Never rejects. */
  async function read(task: RouteTask): Promise<void> {
    const { signal } = task.controller;
    const first = jobs.get(task.jobId);
    if (first === null) {
      // The job is gone, and its notes with it.
      if (tasks.get(task.noteId) === task) tasks.delete(task.noteId);
      return;
    }
    let route: NoteRoute;
    try {
      route = noteRouteSchema.parse(await router.route(first, task.note, signal));
    } catch (err) {
      if (signal.aborted) return;
      logger.warn({ err, noteId: task.noteId }, 'the router failed; the note goes with Send');
      route = UNREADABLE_ROUTE;
    }
    try {
      if (signal.aborted || tasks.get(task.noteId) !== task) return;
      tasks.delete(task.noteId);

      // Deleted, sent or changed while it was read: the answer is for something else.
      const current = notes.get(task.noteId);
      if (current === null || current.round !== null || current.text !== task.text) return;

      // Auto was switched off, or the job left Review: the sorting is no longer wanted.
      const job = jobs.get(task.jobId);
      if (job === null || job.state !== 'review' || job.reviewEffort !== null) {
        const cleared = notes.setRoute(task.noteId, null);
        if (cleared !== null) publishUpsert(cleared);
        return;
      }

      const routed = notes.setRoute(task.noteId, { status: 'routed', route });
      if (routed === null) return;
      publishUpsert(routed);
      try {
        onRouted(job, routed);
      } catch (err) {
        logger.warn({ err, noteId: task.noteId }, 'could not hand a routed note on');
      }
    } catch (err) {
      logger.error({ err, noteId: task.noteId }, 'could not save the route of a note');
    }
  }

  function begin(note: ReviewNote): ReviewNote {
    if (!enabled || stopped) return note;
    // A new reading replaces an earlier one of the same note.
    cancel(note.id);

    if (applies(note) === null) {
      // Not read: a sorting it has was for an older text (or another effort), so it goes.
      if (note.routeStatus === null && note.route === null) return note;
      return notes.setRoute(note.id, null) ?? note;
    }
    const pending = notes.setRoute(note.id, { status: 'pending' });
    if (pending === null) return note; // deleted or sent while we looked

    const task: RouteTask = {
      noteId: pending.id,
      jobId: pending.jobId,
      note: pending,
      text: pending.text ?? '',
      controller: new AbortController(),
    };
    tasks.set(task.noteId, task);
    waiting.push(task);
    // The router starts after the caller has published the pending note.
    queueMicrotask(pump);
    return pending;
  }

  return {
    enabled,
    begin,
    forget: cancel,

    resume() {
      if (!enabled || stopped) return;
      for (const note of notes.listRoutePending()) {
        const next = begin(note);
        if (next !== note) publishUpsert(next);
      }
    },

    async stop() {
      stopped = true;
      unsubscribe();
      waiting.length = 0;
      for (const task of [...tasks.values()]) task.controller.abort();
      tasks.clear();
      await Promise.allSettled([...inflight]);
    },
  };
}
