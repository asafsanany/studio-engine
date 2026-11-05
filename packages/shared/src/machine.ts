// The job state machine: the only place job transitions are defined (architecture §4).
// The server is the authority (`transition` is the only way it changes a job's state); the web app
// uses the same functions for optimistic updates and button enablement.
//
// Pure functions: no I/O, no clock. The caller passes `now`.
//
//   state      event(s)                          → next state
//   ---------  --------------------------------  --------------------------------------------
//   arriving   FILES_CHANGED                     → arriving (settle timer restarts)
//              SETTLED (settle delay quiet)      → queued (also what the Start now action sends)
//              HOLD                              → held
//   queued     FILES_CHANGED                     → arriving
//              START (the worker picks it)       → editing, at the step it stopped at, or at the
//                                                   first step of its run kind (`firstStepOf`)
//              HOLD                              → held
//   held       RELEASE                           → arriving if files changed < settle delay ago, else queued
//                                                   (at the back of the line; see "Keeping a place" below)
//              FILES_CHANGED                     → held (remembers the change for RELEASE)
//   editing    PROGRESS(step, sub)               → editing
//              PREVIEW_READY(preview)            → review (edit and revise runs; at Check)
//              SUCCEED(output)                   → ready (render runs; edit runs too while the
//                                                   Review switch is off)
//              FAIL(step, error)                 → failed
//              CANCEL                            → cancelled
//   review     SEND_NOTES (Send notes)           → queued: a revise run, round + 1
//              APPROVE (Approve)                 → queued: the render run
//              PREVIEW_MISSING                   → failed (edit/preview/index.html is gone; Preview)
//   ready      EXPORT_MISSING                    → failed (the export file is gone; the Render step)
//              UNAPPROVE (Unapprove)             → review: an approved video goes back to Review
//                                                   (only one that was approved and not delivered)
//   failed     RETRY                             → queued (from the failed step)
//   cancelled  RESUME                            → queued (from the stopped step)
//
// Run kinds (Phase 3). Every job starts with runKind `edit`. SEND_NOTES makes it `revise` and
// APPROVE makes it `render`; RETRY and RESUME keep the kind. A fresh run (step null) starts at the
// kind's first step: edit at Brief (1), revise at Plan (4), render at Render (8). PREVIEW_READY
// and SUCCEED also check the kind (`runKindAllows`); `options.review` is the Review switch.
// UNAPPROVE puts the kind back to what it was before Approve: `revise` after a round of notes,
// else `edit`.
//
// Keeping a place in line. HOLD remembers when a queued job joined the queue (`heldSettledAt`).
// A plain RELEASE forgets it: the job joins the queue again, behind everyone. RELEASE with
// `restorePlace` (what the note dialog sends: it holds a job while the person writes) puts a job
// that was queued back where it stood, as queued, by giving it its old `settledAt`. That is only
// for a job whose files did not change while it was held: then the usual rules apply (a folder
// that changed a moment ago goes back to arriving, one that is quiet queues at the back). A job
// that was arriving has no place; it keeps its settle timer, as it does with any RELEASE.
//
// The settle delay is 60 s (`SETTLE_MS`) unless the caller passes `settleMs` (the server passes
// `Config.settleMs`, the value the inbox watcher settles with).
//
// FILES_CHANGED is never an error: in `editing`, `review`, `ready`, `failed` and `cancelled` it is
// ignored (the job comes back unchanged, the same object). Every other (state, event) pair not in
// the table throws `InvalidTransition`.

import type { JobAction, JobActionOptions } from './domain/actions.ts';
import type { Job, JobOutput, JobPreview } from './domain/job.ts';
import { firstStepOf } from './domain/run-kind.ts';
import { JOB_STATES, type JobState } from './domain/status.ts';
import { CHECK_STEP, PREVIEW_STEP, RENDER_STEP, type StepId } from './domain/steps.ts';

/**
 * How long a job's folder must be quiet before it settles into the queue (architecture §4). The
 * default; the server runs on `Config.settleMs` and passes it wherever the delay matters.
 */
export const SETTLE_MS = 60_000;

/** The error of a `ready` job whose export file is not on disk any more (`EXPORT_MISSING`). */
export const EXPORT_MISSING_ERROR = 'Exported file is missing';

/** The error of a `review` job whose edit/preview/index.html is not on disk any more (`PREVIEW_MISSING`). */
export const PREVIEW_MISSING_ERROR = 'Preview is missing';

/**
 * When the settle timer of a job whose files last changed at `lastChangeAt` fires (ISO), for a
 * settle delay of `settleMs` (default `SETTLE_MS`).
 */
export function settleTime(lastChangeAt: string, settleMs: number = SETTLE_MS): string {
  return new Date(Date.parse(lastChangeAt) + settleMs).toISOString();
}

/** What `transition` can be told besides the job, the event and the time. */
export interface TransitionOptions {
  /**
   * How long a job's folder must be quiet before it settles, `Config.settleMs` on the server.
   * Decides `settlesAt` and whether RELEASE goes to `arriving` or `queued`. Default `SETTLE_MS`.
   */
  settleMs?: number;
  /**
   * Whether the Review switch is on (`Config.review` on the server, W2). On: an edit run ends in
   * Review (PREVIEW_READY) and only a render run may SUCCEED. Off (the default): an edit run may
   * also SUCCEED, straight to ready, as before Phase 3. A revise run never SUCCEEDs.
   */
  review?: boolean;
}

/** Every event the machine understands. */
export const JOB_EVENT_TYPES = [
  'FILES_CHANGED',
  'SETTLED',
  'HOLD',
  'RELEASE',
  'START',
  'PROGRESS',
  'SUCCEED',
  'FAIL',
  'CANCEL',
  'RESUME',
  'RETRY',
  'EXPORT_MISSING',
  'PREVIEW_READY',
  'SEND_NOTES',
  'APPROVE',
  'UNAPPROVE',
  'PREVIEW_MISSING',
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

export type JobEvent =
  /** Files in the job folder changed (the watcher). */
  | { type: 'FILES_CHANGED' }
  /**
   * The folder is ready to queue: the settle timer fired (it has been quiet for the settle delay)
   * or the user chose Start now (the `start` action).
   */
  | { type: 'SETTLED' }
  /** The user paused the job before it started. */
  | { type: 'HOLD' }
  /**
   * The user let a held job go. With `restorePlace` a job that was queued when it was held goes
   * back to the place it had in the queue, instead of to the back of it.
   */
  | { type: 'RELEASE'; restorePlace?: boolean }
  /** The worker picked the job. */
  | { type: 'START' }
  /** The runner is now at `step`; `sub` is the free-text count inside it (`null` = none). */
  | { type: 'PROGRESS'; step: StepId; sub: string | null }
  /** The export is in `_Exports`. */
  | { type: 'SUCCEED'; output: JobOutput }
  /** The runner stopped with an error while on `step`. */
  | { type: 'FAIL'; step: StepId; error: string }
  | { type: 'CANCEL' }
  | { type: 'RESUME' }
  | { type: 'RETRY' }
  /** The startup check (W3) found that the export of a `ready` job is gone from the exports folder. */
  | { type: 'EXPORT_MISSING' }
  /** An edit or revise run finished as a live composition in edit/preview/ (W2, W3). */
  | { type: 'PREVIEW_READY'; preview: JobPreview }
  /** The owner sent their review notes (the `send_notes` action): a revise run is queued. */
  | { type: 'SEND_NOTES' }
  /** The owner approved the preview (the `approve` action): the render run is queued. */
  | { type: 'APPROVE' }
  /** The owner took the approval back (the `unapprove` action): the video is in Review again. */
  | { type: 'UNAPPROVE' }
  /** The startup check found that a review job's edit/preview/index.html is gone. */
  | { type: 'PREVIEW_MISSING' };

/** Thrown when the event is not allowed in the job's current state. The API answers 409. */
export class InvalidTransition extends Error {
  readonly jobId: string;
  readonly state: JobState;
  readonly event: JobEventType;

  constructor(job: Pick<Job, 'id' | 'state'>, event: JobEventType) {
    super(`Cannot apply ${event} to job ${job.id} in state ${job.state}`);
    this.name = 'InvalidTransition';
    this.jobId = job.id;
    this.state = job.state;
    this.event = event;
  }
}

/** The states each event is allowed in. Anything else throws `InvalidTransition`. */
const ALLOWED_FROM: Readonly<Record<JobEventType, readonly JobState[]>> = {
  // Never an error; states that do not react to it ignore it (see `change`).
  FILES_CHANGED: JOB_STATES,
  SETTLED: ['arriving'],
  HOLD: ['arriving', 'queued'],
  RELEASE: ['held'],
  START: ['queued'],
  PROGRESS: ['editing'],
  SUCCEED: ['editing'],
  FAIL: ['editing'],
  CANCEL: ['editing'],
  RESUME: ['cancelled'],
  RETRY: ['failed'],
  EXPORT_MISSING: ['ready'],
  PREVIEW_READY: ['editing'],
  SEND_NOTES: ['review'],
  APPROVE: ['review'],
  UNAPPROVE: ['ready'],
  PREVIEW_MISSING: ['review'],
};

const EVENT_TYPE_BY_ACTION = {
  // Start now skips the rest of the settle wait: the same transition the settle timer makes.
  // (START is something else: the worker picking a queued job.)
  start: 'SETTLED',
  hold: 'HOLD',
  release: 'RELEASE',
  cancel: 'CANCEL',
  resume: 'RESUME',
  retry: 'RETRY',
  send_notes: 'SEND_NOTES',
  approve: 'APPROVE',
  unapprove: 'UNAPPROVE',
} as const satisfies Record<JobAction, JobEventType>;

/**
 * The event a user action (`POST /api/jobs/:id/<action>`) stands for. `options.restorePlace` only
 * means something for `release` and is ignored by the other actions.
 */
export function eventForAction(action: JobAction, options: JobActionOptions = {}): JobEvent {
  if (action === 'release' && options.restorePlace === true) {
    return { type: 'RELEASE', restorePlace: true };
  }
  return { type: EVENT_TYPE_BY_ACTION[action] };
}

/** What `unapproveAllows` reads: a plain `Job` has all three. */
type ApprovalFields = Partial<Pick<Job, 'approvedAt' | 'preview' | 'delivery'>>;

/**
 * Whether a ready job can go back to Review: it was approved (an edit that finished with the Review
 * switch off never was), its live composition is still the job's, and it was not delivered (Not
 * delivered yet comes first; Money keeps the delivery of a job that leaves ready). A field that is
 * left out counts as `null`, so a caller that does not say what it knows gets a no.
 */
function unapproveAllows(job: ApprovalFields): boolean {
  return (
    (job.approvedAt ?? null) !== null &&
    (job.preview ?? null) !== null &&
    (job.delivery ?? null) === null
  );
}

/**
 * Whether `action` is allowed on a job right now. Agrees with `transition` by construction: both
 * read the same table. Takes anything with a `state`, so the web can pass a plain `Job`; `unapprove`
 * also reads `approvedAt`, `preview` and `delivery` (see `unapproveAllows`).
 */
export function can(job: Pick<Job, 'state'> & ApprovalFields, action: JobAction): boolean {
  const event = EVENT_TYPE_BY_ACTION[action];
  if (event === 'UNAPPROVE' && !unapproveAllows(job)) return false;
  return ALLOWED_FROM[event].includes(job.state);
}

// Derived fields (`etaSec`, `placeInLine`, `settlesAt`) are never stored and the machine cannot
// work out the first two, so every state change clears them; the server fills them in again when
// it reads the job. `arriving` is the exception: its `settlesAt` follows from `lastChangeAt`.
const NO_DERIVED = { etaSec: null, placeInLine: null, settlesAt: null } as const;

function enterArriving(lastChangeAt: string, at: string, settleMs: number): Partial<Job> {
  return {
    ...NO_DERIVED,
    state: 'arriving',
    lastChangeAt,
    settledAt: null,
    heldSettledAt: null,
    settlesAt: settleTime(lastChangeAt, settleMs),
    updatedAt: at,
  };
}

/** Joins the queue at `at`, or at `place` (an earlier `settledAt`) to keep a place in line. */
function enterQueued(at: string, place: string = at): Partial<Job> {
  return {
    ...NO_DERIVED,
    state: 'queued',
    settledAt: place,
    heldSettledAt: null,
    updatedAt: at,
  };
}

/**
 * The `settledAt` a released job gets back to restore its place in line: when it joined the queue
 * before it was held. `null` when there is no place to restore: the job was arriving when it was
 * held, or its files changed since (a changed folder is new work and queues like any other).
 */
function placeToRestore(job: Job): string | null {
  const place = job.heldSettledAt;
  if (place === null) return null;
  // A queued job's last file change is never later than the time it joined the queue, so a later
  // one means the files changed while it was held.
  return Date.parse(job.lastChangeAt) <= Date.parse(place) ? place : null;
}

/**
 * PREVIEW_READY and SUCCEED also depend on the kind of run that is ending. An edit or revise run
 * ends in Review; a render run ends ready, and so does an edit run while the Review switch is off.
 * No user action maps to either event, so `can` still needs only the state.
 */
function runKindAllows(job: Pick<Job, 'runKind'>, event: JobEvent, review: boolean): boolean {
  if (event.type === 'PREVIEW_READY') return job.runKind === 'edit' || job.runKind === 'revise';
  if (event.type === 'SUCCEED') {
    return job.runKind === 'render' || (job.runKind === 'edit' && !review);
  }
  return true;
}

/**
 * The fields the event changes, or `null` when it changes nothing (the event is ignored). The
 * caller has already checked that the event is allowed in `job.state`.
 */
function change(job: Job, event: JobEvent, now: Date, settleMs: number): Partial<Job> | null {
  const at = now.toISOString();
  switch (event.type) {
    case 'FILES_CHANGED':
      if (job.state === 'held') return { lastChangeAt: at, updatedAt: at };
      if (job.state === 'arriving' || job.state === 'queued')
        return enterArriving(at, at, settleMs);
      return null;
    case 'SETTLED':
      return enterQueued(at);
    case 'HOLD':
      // A queued job's place is kept for a RELEASE that restores it; an arriving job has none.
      return {
        ...NO_DERIVED,
        state: 'held',
        settledAt: null,
        heldSettledAt: job.settledAt,
        updatedAt: at,
      };
    case 'RELEASE': {
      // A job that was queued and whose files have not changed since goes straight back to its
      // place, whatever the settle delay: it had settled (or was started by Start now) already.
      const place = event.restorePlace === true ? placeToRestore(job) : null;
      if (place !== null) return enterQueued(at, place);
      return now.getTime() - Date.parse(job.lastChangeAt) < settleMs
        ? enterArriving(job.lastChangeAt, at, settleMs)
        : enterQueued(at);
    }
    case 'START':
      // A retried or resumed job keeps its step. A fresh run begins at its kind's first step
      // (edit: Brief, revise: Plan, render: Render).
      return {
        ...NO_DERIVED,
        state: 'editing',
        step: job.step ?? firstStepOf(job.runKind),
        subProgress: null,
        updatedAt: at,
      };
    case 'PREVIEW_READY':
      return {
        ...NO_DERIVED,
        state: 'review',
        step: CHECK_STEP,
        subProgress: null,
        preview: { ...event.preview },
        updatedAt: at,
      };
    case 'SEND_NOTES':
      // A new round: the revise run starts from its first step, at the back of the line.
      return {
        ...enterQueued(at),
        runKind: 'revise',
        round: job.round + 1,
        step: null,
        subProgress: null,
      };
    case 'APPROVE':
      return {
        ...enterQueued(at),
        runKind: 'render',
        step: null,
        subProgress: null,
        approvedAt: at,
      };
    case 'UNAPPROVE':
      // Back where Approve found it: in Review at the Check step, the composition kept, and the
      // run kind as it was before the render (a round of notes was sent: revise). No export is
      // pointed at; the file in the exports folder stays until the next render replaces it.
      return {
        ...NO_DERIVED,
        state: 'review',
        step: CHECK_STEP,
        subProgress: null,
        runKind: job.round > 0 ? 'revise' : 'edit',
        output: null,
        approvedAt: null,
        updatedAt: at,
      };
    case 'PREVIEW_MISSING':
      // Failed at Preview, so a retry builds the composition again. There is no preview to show.
      return {
        ...NO_DERIVED,
        state: 'failed',
        step: PREVIEW_STEP,
        failedAt: PREVIEW_STEP,
        error: PREVIEW_MISSING_ERROR,
        preview: null,
        subProgress: null,
        updatedAt: at,
      };
    case 'PROGRESS':
      if (job.step === event.step && job.subProgress === event.sub) return null;
      return { step: event.step, subProgress: event.sub, updatedAt: at };
    case 'SUCCEED':
      return {
        ...NO_DERIVED,
        state: 'ready',
        step: RENDER_STEP,
        subProgress: null,
        output: event.output,
        updatedAt: at,
      };
    case 'FAIL':
      return {
        ...NO_DERIVED,
        state: 'failed',
        step: event.step,
        failedAt: event.step,
        error: event.error,
        updatedAt: at,
      };
    case 'CANCEL':
      return { ...NO_DERIVED, state: 'cancelled', stoppedAt: job.step, updatedAt: at };
    case 'EXPORT_MISSING':
      // Failed at the last step, so a retry only renders again. There is no export to point at.
      return {
        ...NO_DERIVED,
        state: 'failed',
        step: RENDER_STEP,
        failedAt: RENDER_STEP,
        error: EXPORT_MISSING_ERROR,
        output: null,
        updatedAt: at,
      };
    case 'RESUME':
    case 'RETRY':
      // Back in line from the same step; the old failure or stop is forgotten.
      return {
        ...enterQueued(at),
        failedAt: null,
        stoppedAt: null,
        error: null,
        subProgress: null,
      };
  }
}

/**
 * Applies `event` to `job` at time `now` and returns the new job; the input is never modified.
 * Returns `job` itself when the event is ignored (a file change in a state that does not react to
 * it, or a PROGRESS that repeats the current step and count). Throws `InvalidTransition` when the
 * event is not allowed in the job's state or, for PREVIEW_READY and SUCCEED, not allowed for the
 * job's run kind.
 *
 * `updatedAt` becomes `now` whenever the job's state, step/sub-progress, error, output or input
 * files change. Fields the machine does not know about (a stored record's extras) pass through.
 *
 * `options.settleMs` is the settle delay (default 60 s, `SETTLE_MS`) and `options.review` the Review
 * switch; see `TransitionOptions`.
 */
export function transition<J extends Job>(
  job: J,
  event: JobEvent,
  now: Date,
  options: TransitionOptions = {},
): J {
  if (
    !ALLOWED_FROM[event.type].includes(job.state) ||
    !runKindAllows(job, event, options.review === true) ||
    (event.type === 'UNAPPROVE' && !unapproveAllows(job))
  ) {
    throw new InvalidTransition(job, event.type);
  }
  const patch = change(job, event, now, options.settleMs ?? SETTLE_MS);
  return patch === null ? job : { ...job, ...patch };
}
