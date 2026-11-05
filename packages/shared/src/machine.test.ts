import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { JOB_ACTIONS, type JobAction } from './domain/actions.ts';
import { type Job, type JobOutput, jobSchema } from './domain/job.ts';
import { firstStepOf, RUN_KINDS } from './domain/run-kind.ts';
import { JOB_STATES, type JobState } from './domain/status.ts';
import { hebrewJob, jobsByState, makeJob, SAMPLE_PREVIEW } from './domain/test-fixtures.ts';
import * as shared from './index.ts';
import {
  can,
  EXPORT_MISSING_ERROR,
  eventForAction,
  InvalidTransition,
  JOB_EVENT_TYPES,
  type JobEvent,
  type JobEventType,
  PREVIEW_MISSING_ERROR,
  SETTLE_MS,
  settleTime,
  type TransitionOptions,
  transition,
} from './machine.ts';

const NOW = new Date('2026-10-20T14:00:00.000Z');
const NOW_ISO = NOW.toISOString();

/** An ISO timestamp `ms` before `NOW`. */
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const OUTPUT: JobOutput = {
  fileName: 'Northwind Bakery/Spring menu.mp4',
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 65_011_712,
};

/** One sample of every event. PROGRESS differs from the editing fixture (step 5, "graphics 2/5"). */
const EVENTS = {
  FILES_CHANGED: { type: 'FILES_CHANGED' },
  SETTLED: { type: 'SETTLED' },
  HOLD: { type: 'HOLD' },
  RELEASE: { type: 'RELEASE' },
  START: { type: 'START' },
  PROGRESS: { type: 'PROGRESS', step: 6, sub: 'pass 1/3' },
  SUCCEED: { type: 'SUCCEED', output: OUTPUT },
  FAIL: { type: 'FAIL', step: 7, error: 'ffmpeg exited with code 1' },
  CANCEL: { type: 'CANCEL' },
  RESUME: { type: 'RESUME' },
  RETRY: { type: 'RETRY' },
  EXPORT_MISSING: { type: 'EXPORT_MISSING' },
  PREVIEW_READY: { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  SEND_NOTES: { type: 'SEND_NOTES' },
  APPROVE: { type: 'APPROVE' },
  UNAPPROVE: { type: 'UNAPPROVE' },
  PREVIEW_MISSING: { type: 'PREVIEW_MISSING' },
} as const satisfies { [K in JobEventType]: Extract<JobEvent, { type: K }> };

/**
 * Architecture §4, written out by hand for every (state, event) pair. A state means the event is
 * allowed and moves the job there; `ignored` means it is allowed and changes nothing; `invalid`
 * means `InvalidTransition`. The `held` fixture's files last changed 20 minutes before `NOW`, so
 * RELEASE settles into the queue.
 */
type Outcome = JobState | 'ignored' | 'invalid';

const EXPECTED: Record<JobState, Record<JobEventType, Outcome>> = {
  arriving: {
    FILES_CHANGED: 'arriving',
    SETTLED: 'queued',
    HOLD: 'held',
    RELEASE: 'invalid',
    START: 'invalid',
    PROGRESS: 'invalid',
    SUCCEED: 'invalid',
    FAIL: 'invalid',
    CANCEL: 'invalid',
    RESUME: 'invalid',
    RETRY: 'invalid',
    EXPORT_MISSING: 'invalid',
    PREVIEW_READY: 'invalid',
    SEND_NOTES: 'invalid',
    APPROVE: 'invalid',
    UNAPPROVE: 'invalid',
    PREVIEW_MISSING: 'invalid',
  },
  queued: {
    FILES_CHANGED: 'arriving',
    SETTLED: 'invalid',
    HOLD: 'held',
    RELEASE: 'invalid',
    START: 'editing',
    PROGRESS: 'invalid',
    SUCCEED: 'invalid',
    FAIL: 'invalid',
    CANCEL: 'invalid',
    RESUME: 'invalid',
    RETRY: 'invalid',
    EXPORT_MISSING: 'invalid',
    PREVIEW_READY: 'invalid',
    SEND_NOTES: 'invalid',
    APPROVE: 'invalid',
    UNAPPROVE: 'invalid',
    PREVIEW_MISSING: 'invalid',
  },
  held: {
    FILES_CHANGED: 'held',
    SETTLED: 'invalid',
    HOLD: 'invalid',
    RELEASE: 'queued',
    START: 'invalid',
    PROGRESS: 'invalid',
    SUCCEED: 'invalid',
    FAIL: 'invalid',
    CANCEL: 'invalid',
    RESUME: 'invalid',
    RETRY: 'invalid',
    EXPORT_MISSING: 'invalid',
    PREVIEW_READY: 'invalid',
    SEND_NOTES: 'invalid',
    APPROVE: 'invalid',
    UNAPPROVE: 'invalid',
    PREVIEW_MISSING: 'invalid',
  },
  editing: {
    FILES_CHANGED: 'ignored',
    SETTLED: 'invalid',
    HOLD: 'invalid',
    RELEASE: 'invalid',
    START: 'invalid',
    PROGRESS: 'editing',
    SUCCEED: 'ready',
    FAIL: 'failed',
    CANCEL: 'cancelled',
    RESUME: 'invalid',
    RETRY: 'invalid',
    EXPORT_MISSING: 'invalid',
    PREVIEW_READY: 'review',
    SEND_NOTES: 'invalid',
    APPROVE: 'invalid',
    UNAPPROVE: 'invalid',
    PREVIEW_MISSING: 'invalid',
  },
  review: {
    FILES_CHANGED: 'ignored',
    SETTLED: 'invalid',
    HOLD: 'invalid',
    RELEASE: 'invalid',
    START: 'invalid',
    PROGRESS: 'invalid',
    SUCCEED: 'invalid',
    FAIL: 'invalid',
    CANCEL: 'invalid',
    RESUME: 'invalid',
    RETRY: 'invalid',
    EXPORT_MISSING: 'invalid',
    PREVIEW_READY: 'invalid',
    SEND_NOTES: 'queued',
    APPROVE: 'queued',
    UNAPPROVE: 'invalid',
    PREVIEW_MISSING: 'failed',
  },
  ready: {
    FILES_CHANGED: 'ignored',
    SETTLED: 'invalid',
    HOLD: 'invalid',
    RELEASE: 'invalid',
    START: 'invalid',
    PROGRESS: 'invalid',
    SUCCEED: 'invalid',
    FAIL: 'invalid',
    CANCEL: 'invalid',
    RESUME: 'invalid',
    RETRY: 'invalid',
    EXPORT_MISSING: 'failed',
    PREVIEW_READY: 'invalid',
    SEND_NOTES: 'invalid',
    APPROVE: 'invalid',
    UNAPPROVE: 'invalid',
    PREVIEW_MISSING: 'invalid',
  },
  failed: {
    FILES_CHANGED: 'ignored',
    SETTLED: 'invalid',
    HOLD: 'invalid',
    RELEASE: 'invalid',
    START: 'invalid',
    PROGRESS: 'invalid',
    SUCCEED: 'invalid',
    FAIL: 'invalid',
    CANCEL: 'invalid',
    RESUME: 'invalid',
    RETRY: 'queued',
    EXPORT_MISSING: 'invalid',
    PREVIEW_READY: 'invalid',
    SEND_NOTES: 'invalid',
    APPROVE: 'invalid',
    UNAPPROVE: 'invalid',
    PREVIEW_MISSING: 'invalid',
  },
  cancelled: {
    FILES_CHANGED: 'ignored',
    SETTLED: 'invalid',
    HOLD: 'invalid',
    RELEASE: 'invalid',
    START: 'invalid',
    PROGRESS: 'invalid',
    SUCCEED: 'invalid',
    FAIL: 'invalid',
    CANCEL: 'invalid',
    RESUME: 'queued',
    RETRY: 'invalid',
    EXPORT_MISSING: 'invalid',
    PREVIEW_READY: 'invalid',
    SEND_NOTES: 'invalid',
    APPROVE: 'invalid',
    UNAPPROVE: 'invalid',
    PREVIEW_MISSING: 'invalid',
  },
};

// `can` for the nine user actions, also written out by hand. The sample ready job was never approved
// (no approvedAt, no preview), so Unapprove is not for it; the UNAPPROVE tests below use an approved one.
const CAN: Record<JobAction, readonly JobState[]> = {
  start: ['arriving'],
  hold: ['arriving', 'queued'],
  release: ['held'],
  cancel: ['editing'],
  resume: ['cancelled'],
  retry: ['failed'],
  send_notes: ['review'],
  approve: ['review'],
  unapprove: [],
};

const PAIRS = JOB_STATES.flatMap((state) =>
  JOB_EVENT_TYPES.map((event) => [state, event, EXPECTED[state][event]] as const),
);

const deepCopy = (job: Job): Job => JSON.parse(JSON.stringify(job));

/** A job frozen at the top level: any write inside the machine would throw (modules are strict). */
function frozen(job: Job): Job {
  return Object.freeze({ ...job });
}

/** What the server and the UI rely on in every job the machine returns. */
function expectConsistent(job: Job) {
  expect(jobSchema.safeParse(job).success, 'valid Job').toBe(true);
  expect(job.placeInLine, 'placeInLine is derived at read time').toBeNull();
  expect(job.etaSec === null || job.state === 'editing', 'etaSec only while editing').toBe(true);
  expect(job.settlesAt, 'settlesAt only while arriving').toBe(
    job.state === 'arriving' ? settleTime(job.lastChangeAt) : null,
  );
  expect(job.failedAt !== null, 'failedAt only when failed').toBe(job.state === 'failed');
  expect(job.error !== null, 'error only when failed').toBe(job.state === 'failed');
  expect(job.output !== null, 'output only when ready').toBe(job.state === 'ready');
  if (job.state === 'arriving' || job.state === 'held') expect(job.settledAt).toBeNull();
  if (job.state !== 'held') expect(job.heldSettledAt, 'heldSettledAt only while held').toBeNull();
  if (job.state === 'queued') expect(job.settledAt).not.toBeNull();
  if (job.state === 'review') expect(job.preview, 'a review job has a preview').not.toBeNull();
  expect(job.approvedAt !== null, 'approvedAt exactly for a render run').toBe(
    job.runKind === 'render',
  );
  if (job.runKind === 'edit') expect(job.round, 'an edit run has round 0').toBe(0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the table', () => {
  it('covers every (state, event) pair', () => {
    expect(PAIRS).toHaveLength(JOB_STATES.length * JOB_EVENT_TYPES.length);
    expect(JOB_EVENT_TYPES).toEqual(Object.keys(EVENTS));
  });

  it.each(PAIRS)('%s + %s -> %s', (state, eventType, outcome) => {
    const job = frozen(jobsByState[state]);
    const event = EVENTS[eventType];

    if (outcome === 'invalid') {
      expect(() => transition(job, event, NOW)).toThrow(InvalidTransition);
      return;
    }

    const next = transition(job, event, NOW);
    if (outcome === 'ignored') {
      expect(next).toBe(job);
      return;
    }

    expect(next).not.toBe(job);
    expect(next.state).toBe(outcome);
    expect(next.updatedAt).toBe(NOW_ISO);
    expectConsistent(next);
    // Whoever does not change, stays: identity and the Hebrew-capable text fields.
    expect(next).toMatchObject({
      id: job.id,
      client: job.client,
      name: job.name,
      relPath: job.relPath,
      inputs: job.inputs,
      sizeBytes: job.sizeBytes,
      addedAt: job.addedAt,
    });
    expect(job).toEqual(jobsByState[state]);
  });
});

describe('InvalidTransition', () => {
  it('says which event hit which job in which state', () => {
    const job = makeJob({ id: 'abc123', state: 'ready' });
    let caught: unknown;
    try {
      transition(job, EVENTS.HOLD, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidTransition);
    expect(caught).toBeInstanceOf(Error);
    const error = caught as InvalidTransition;
    expect(error.name).toBe('InvalidTransition');
    expect(error.message).toBe('Cannot apply HOLD to job abc123 in state ready');
    expect(error).toMatchObject({ jobId: 'abc123', state: 'ready', event: 'HOLD' });
  });
});

describe('can', () => {
  it.each(JOB_ACTIONS.flatMap((action) => JOB_STATES.map((state) => [action, state] as const)))(
    '%s on a %s job',
    (action, state) => {
      expect(can(jobsByState[state], action)).toBe(CAN[action].includes(state));
    },
  );

  it('agrees with transition for every state and action', () => {
    for (const state of JOB_STATES) {
      for (const action of JOB_ACTIONS) {
        const job = jobsByState[state];
        let allowed = true;
        try {
          transition(job, eventForAction(action), NOW);
        } catch (error) {
          if (!(error instanceof InvalidTransition)) throw error;
          allowed = false;
        }
        expect(can(job, action), `${action} on ${state}`).toBe(allowed);
      }
    }
  });

  it('needs only a state, so a plain Job from the web works', () => {
    expect(can({ state: 'held' }, 'release')).toBe(true);
    expect(can(hebrewJob, 'hold')).toBe(true);
  });
});

describe('eventForAction', () => {
  it.each([
    ['start', 'SETTLED'],
    ['hold', 'HOLD'],
    ['release', 'RELEASE'],
    ['cancel', 'CANCEL'],
    ['resume', 'RESUME'],
    ['retry', 'RETRY'],
    ['send_notes', 'SEND_NOTES'],
    ['approve', 'APPROVE'],
  ] as const)('%s is %s', (action, type) => {
    expect(eventForAction(action)).toEqual({ type });
  });

  it('release can ask to restore the place in line', () => {
    expect(eventForAction('release', { restorePlace: true })).toEqual({
      type: 'RELEASE',
      restorePlace: true,
    });
    expect(eventForAction('release', { restorePlace: false })).toEqual({ type: 'RELEASE' });
    expect(eventForAction('release', {})).toEqual({ type: 'RELEASE' });
  });

  it.each(['start', 'hold', 'cancel', 'resume', 'retry', 'send_notes', 'approve'] as const)(
    '%s ignores restorePlace',
    (action) => {
      expect(eventForAction(action, { restorePlace: true })).toEqual(eventForAction(action));
    },
  );
});

describe('FILES_CHANGED', () => {
  it('restarts the settle timer of an arriving job', () => {
    const job = jobsByState.arriving;
    const next = transition(job, EVENTS.FILES_CHANGED, NOW);
    expect(next.state).toBe('arriving');
    expect(next.lastChangeAt).toBe(NOW_ISO);
    expect(next.settlesAt).toBe('2026-10-20T14:01:00.000Z');
    expect(next.updatedAt).toBe(NOW_ISO);
  });

  it('sends a queued job back to arriving and takes it out of the line', () => {
    const job = makeJob({ state: 'queued', placeInLine: 3, settledAt: ago(5 * 60_000) });
    const next = transition(job, EVENTS.FILES_CHANGED, NOW);
    expect(next).toMatchObject({
      state: 'arriving',
      lastChangeAt: NOW_ISO,
      settledAt: null,
      placeInLine: null,
      settlesAt: '2026-10-20T14:01:00.000Z',
    });
  });

  it('keeps a held job held but remembers the change for RELEASE', () => {
    const held = makeJob({ state: 'held', settledAt: null, placeInLine: null });
    const changed = transition(held, EVENTS.FILES_CHANGED, NOW);
    expect(changed.state).toBe('held');
    expect(changed.lastChangeAt).toBe(NOW_ISO);
    expect(changed.updatedAt).toBe(NOW_ISO);

    const later = new Date(NOW.getTime() + 30_000);
    expect(transition(changed, EVENTS.RELEASE, later).state).toBe('arriving');
  });

  it.each(['editing', 'review', 'ready', 'failed', 'cancelled'] as const)(
    'is ignored by a %s job: same object back, nothing bumped',
    (state) => {
      const job = jobsByState[state];
      const next = transition(job, EVENTS.FILES_CHANGED, NOW);
      expect(next).toBe(job);
      expect(next.updatedAt).toBe(job.updatedAt);
    },
  );
});

describe('SETTLED', () => {
  it('puts the job in line from now on', () => {
    const next = transition(jobsByState.arriving, EVENTS.SETTLED, NOW);
    expect(next).toMatchObject({
      state: 'queued',
      settledAt: NOW_ISO,
      settlesAt: null,
      lastChangeAt: jobsByState.arriving.lastChangeAt,
    });
  });
});

describe('the start action (Start now)', () => {
  it('is the SETTLED event, not START (that is the worker picking a job)', () => {
    expect(eventForAction('start')).toEqual(EVENTS.SETTLED);
    expect(eventForAction('start')).not.toEqual(EVENTS.START);
  });

  it('puts an arriving job in line at once, exactly as the settle timer would', () => {
    // Files changed 5 s ago: the settle delay still has 55 s to run.
    const job = makeJob({
      ...jobsByState.arriving,
      lastChangeAt: ago(5_000),
      settlesAt: settleTime(ago(5_000)),
    });
    const next = transition(job, eventForAction('start'), NOW);
    expect(next).toEqual(transition(job, EVENTS.SETTLED, NOW));
    expect(next).toMatchObject({
      state: 'queued',
      settledAt: NOW_ISO,
      settlesAt: null,
      updatedAt: NOW_ISO,
      lastChangeAt: job.lastChangeAt,
    });
    // Well before the settle delay is over.
    expect(Date.parse(job.lastChangeAt) + SETTLE_MS).toBeGreaterThan(NOW.getTime());
    expectConsistent(next);
  });

  it('is offered for arriving jobs only', () => {
    expect(JOB_STATES.filter((state) => can(jobsByState[state], 'start'))).toEqual(['arriving']);
    for (const state of JOB_STATES.filter((state) => state !== 'arriving')) {
      expect(() => transition(jobsByState[state], eventForAction('start'), NOW), state).toThrow(
        InvalidTransition,
      );
    }
  });

  it('a later file change sends the started job back to arriving with a fresh settle timer', () => {
    const queued = transition(jobsByState.arriving, eventForAction('start'), NOW);
    const later = new Date(NOW.getTime() + 5_000);
    const next = transition(queued, EVENTS.FILES_CHANGED, later);
    expect(next).toMatchObject({
      state: 'arriving',
      settledAt: null,
      lastChangeAt: later.toISOString(),
      settlesAt: settleTime(later.toISOString()),
    });
  });
});

describe('HOLD', () => {
  it('takes a queued job out of the line', () => {
    const next = transition(jobsByState.queued, EVENTS.HOLD, NOW);
    expect(next).toMatchObject({ state: 'held', settledAt: null, placeInLine: null });
  });

  it('remembers when a queued job joined the queue', () => {
    const next = transition(jobsByState.queued, EVENTS.HOLD, NOW);
    expect(next.heldSettledAt).toBe(jobsByState.queued.settledAt);
    expect(next.heldSettledAt).not.toBeNull();
  });

  it('has no place to remember for an arriving job', () => {
    expect(transition(jobsByState.arriving, EVENTS.HOLD, NOW).heldSettledAt).toBeNull();
  });

  it('stops the settle timer of an arriving job', () => {
    const next = transition(jobsByState.arriving, EVENTS.HOLD, NOW);
    expect(next).toMatchObject({ state: 'held', settlesAt: null, settledAt: null });
    expect(next.lastChangeAt).toBe(jobsByState.arriving.lastChangeAt);
  });
});

describe('RELEASE', () => {
  const held = (lastChangeAt: string) =>
    makeJob({ state: 'held', placeInLine: null, settledAt: null, lastChangeAt });

  it.each([
    ['just now', 0, 'arriving'],
    ['1 s ago', 1_000, 'arriving'],
    ['59.999 s ago', 59_999, 'arriving'],
    ['exactly 60 s ago', 60_000, 'queued'],
    ['60.001 s ago', 60_001, 'queued'],
    ['an hour ago', 3_600_000, 'queued'],
    ['in the future (clock skew)', -5_000, 'arriving'],
  ] as const)('with the last file change %s goes to %s', (_label, age, state) => {
    expect(transition(held(ago(age)), EVENTS.RELEASE, NOW).state).toBe(state);
  });

  it('goes to arriving on the original timer, not a fresh one', () => {
    const lastChangeAt = ago(20_000);
    const next = transition(held(lastChangeAt), EVENTS.RELEASE, NOW);
    expect(next).toMatchObject({
      state: 'arriving',
      lastChangeAt,
      settlesAt: settleTime(lastChangeAt),
      settledAt: null,
    });
    expect(next.settlesAt).toBe('2026-10-20T14:00:40.000Z');
  });

  it('goes to the back of the line when it settles into the queue', () => {
    const next = transition(held(ago(10 * 60_000)), EVENTS.RELEASE, NOW);
    expect(next).toMatchObject({ state: 'queued', settledAt: NOW_ISO, settlesAt: null });
  });

  it('goes to the back of the line even when its old place is remembered', () => {
    const job = { ...held(ago(10 * 60_000)), heldSettledAt: ago(15 * 60_000) };
    const next = transition(job, EVENTS.RELEASE, NOW);
    expect(next).toMatchObject({ state: 'queued', settledAt: NOW_ISO, heldSettledAt: null });
  });
});

describe("RELEASE with restorePlace (the note dialog's)", () => {
  const RESTORE = { type: 'RELEASE', restorePlace: true } as const;
  const joinedAt = ago(15 * 60_000);
  const held = (overrides: Partial<Job> = {}) =>
    makeJob({
      state: 'held',
      placeInLine: null,
      settledAt: null,
      heldSettledAt: joinedAt,
      lastChangeAt: ago(20 * 60_000),
      ...overrides,
    });

  it('puts a job that was queued back at its old place in line', () => {
    const next = transition(held(), RESTORE, NOW);
    expect(next).toMatchObject({
      state: 'queued',
      settledAt: joinedAt,
      heldSettledAt: null,
      settlesAt: null,
      placeInLine: null,
      updatedAt: NOW_ISO,
    });
    expectConsistent(next);
  });

  it('holds then restores to the same place, a whole round trip through the machine', () => {
    const queued = jobsByState.queued;
    const next = transition(
      transition(queued, EVENTS.HOLD, NOW),
      RESTORE,
      new Date(NOW.getTime() + 30_000),
    );
    expect(next).toMatchObject({ state: 'queued', settledAt: queued.settledAt });
    expectConsistent(next);
  });

  it('keeps an arriving job arriving, on its original settle timer', () => {
    const arriving = jobsByState.arriving; // last file change 13:41:00, a 60 s timer
    const heldJob = transition(arriving, EVENTS.HOLD, new Date('2026-10-20T13:41:20.000Z'));
    const next = transition(heldJob, RESTORE, new Date('2026-10-20T13:41:30.000Z'));
    expect(next).toMatchObject({
      state: 'arriving',
      lastChangeAt: arriving.lastChangeAt,
      settlesAt: arriving.settlesAt,
      settledAt: null,
      heldSettledAt: null,
    });
  });

  it('goes back to arriving when the files changed a moment ago, as a plain release does', () => {
    const job = held({ lastChangeAt: ago(10_000) });
    const next = transition(job, RESTORE, NOW);
    expect(next).toMatchObject({
      state: 'arriving',
      lastChangeAt: job.lastChangeAt,
      settledAt: null,
      heldSettledAt: null,
    });
    expectConsistent(next);
  });

  it('goes to the back of the line when the files changed while it was held, and are quiet now', () => {
    // Changed 5 minutes ago, after the job joined the queue 15 minutes ago.
    const next = transition(held({ lastChangeAt: ago(5 * 60_000) }), RESTORE, NOW);
    expect(next).toMatchObject({ state: 'queued', settledAt: NOW_ISO, heldSettledAt: null });
  });

  it('restores the place when the last change is exactly the moment it joined the queue', () => {
    const next = transition(held({ lastChangeAt: joinedAt }), RESTORE, NOW);
    expect(next.settledAt).toBe(joinedAt);
  });

  it('goes to the back of the line for a job held before the place was remembered', () => {
    const next = transition(held({ heldSettledAt: null }), RESTORE, NOW);
    expect(next).toMatchObject({ state: 'queued', settledAt: NOW_ISO, heldSettledAt: null });
  });

  it('goes straight back to its place for a job started with Start now, whatever the settle delay', () => {
    // Started 5 s after its last file change, held 20 s later: a plain release would find the
    // folder "changed less than a minute ago" and send it back to arriving.
    const lastChangeAt = ago(30_000);
    const place = ago(25_000);
    const job = held({ lastChangeAt, heldSettledAt: place });
    expect(transition(job, EVENTS.RELEASE, NOW).state).toBe('arriving');
    expect(transition(job, RESTORE, NOW)).toMatchObject({
      state: 'queued',
      settledAt: place,
      heldSettledAt: null,
      settlesAt: null,
    });
    expect(transition(job, RESTORE, NOW, { settleMs: 10 * 60_000 }).settledAt).toBe(place);
  });

  it('uses the custom settle delay when the files changed while it was held', () => {
    const job = held({ lastChangeAt: ago(3_000) }); // after it joined the queue 15 minutes ago
    expect(transition(job, RESTORE, NOW, { settleMs: 5_000 }).state).toBe('arriving');
    expect(transition(job, RESTORE, NOW, { settleMs: 2_000 })).toMatchObject({
      state: 'queued',
      settledAt: NOW_ISO,
    });
  });

  it('is only allowed on a held job, like RELEASE', () => {
    for (const state of JOB_STATES.filter((state) => state !== 'held')) {
      expect(() => transition(jobsByState[state], RESTORE, NOW), state).toThrow(InvalidTransition);
    }
  });

  it('never changes the job it is given', () => {
    const job = held();
    const before = deepCopy(job);
    transition(frozen(job), RESTORE, NOW);
    expect(job).toEqual(before);
  });
});

describe('START', () => {
  it('begins a fresh job at step 1 with no sub-progress', () => {
    const next = transition(jobsByState.queued, EVENTS.START, NOW);
    expect(next).toMatchObject({ state: 'editing', step: 1, subProgress: null, etaSec: null });
  });

  it('keeps the step of a retried or resumed job and forgets its sub-progress', () => {
    const queuedAtStep = makeJob({ step: 6, subProgress: 'pass 2/3' });
    const next = transition(queuedAtStep, EVENTS.START, NOW);
    expect(next).toMatchObject({ state: 'editing', step: 6, subProgress: null });
  });

  it('keeps settledAt, so a job found editing after a crash is still first in line', () => {
    const next = transition(jobsByState.queued, EVENTS.START, NOW);
    expect(next.settledAt).toBe(jobsByState.queued.settledAt);
  });

  it('clears the place in line', () => {
    expect(transition(jobsByState.queued, EVENTS.START, NOW).placeInLine).toBeNull();
  });
});

describe('PROGRESS', () => {
  it('moves to a new step and count', () => {
    const next = transition(jobsByState.editing, EVENTS.PROGRESS, NOW);
    expect(next).toMatchObject({
      state: 'editing',
      step: 6,
      subProgress: 'pass 1/3',
      updatedAt: NOW_ISO,
    });
  });

  it('keeps the ETA, which the server recomputes when it reads the job', () => {
    expect(transition(jobsByState.editing, EVENTS.PROGRESS, NOW).etaSec).toBe(240);
  });

  it('moves the count inside the same step', () => {
    const next = transition(
      jobsByState.editing,
      { type: 'PROGRESS', step: 5, sub: 'graphics 3/5' },
      NOW,
    );
    expect(next).toMatchObject({ step: 5, subProgress: 'graphics 3/5', updatedAt: NOW_ISO });
  });

  it('moves to a new step with the same count text', () => {
    const next = transition(
      jobsByState.editing,
      { type: 'PROGRESS', step: 6, sub: 'graphics 2/5' },
      NOW,
    );
    expect(next).toMatchObject({ step: 6, subProgress: 'graphics 2/5', updatedAt: NOW_ISO });
  });

  it('clears the count with null', () => {
    const next = transition(jobsByState.editing, { type: 'PROGRESS', step: 5, sub: null }, NOW);
    expect(next).toMatchObject({ step: 5, subProgress: null, updatedAt: NOW_ISO });
  });

  it('is ignored when step and count repeat: same object, updatedAt not bumped', () => {
    const job = jobsByState.editing;
    const next = transition(job, { type: 'PROGRESS', step: 5, sub: 'graphics 2/5' }, NOW);
    expect(next).toBe(job);
    expect(next.updatedAt).toBe(job.updatedAt);
  });
});

describe('SUCCEED', () => {
  it('finishes the job with its output, at the last step', () => {
    const next = transition(jobsByState.editing, EVENTS.SUCCEED, NOW);
    expect(next).toMatchObject({
      state: 'ready',
      step: 8,
      subProgress: null,
      etaSec: null,
      output: OUTPUT,
    });
  });
});

describe('FAIL', () => {
  it('records the step it failed at and the error, and keeps the sub-progress', () => {
    const next = transition(jobsByState.editing, EVENTS.FAIL, NOW);
    expect(next).toMatchObject({
      state: 'failed',
      step: 7,
      failedAt: 7,
      error: 'ffmpeg exited with code 1',
      subProgress: 'graphics 2/5',
      etaSec: null,
    });
  });

  it('trusts the step in the event over the one it last saw', () => {
    const job = makeJob({ state: 'editing', step: 3, placeInLine: null });
    expect(transition(job, { type: 'FAIL', step: 4, error: 'x' }, NOW)).toMatchObject({
      step: 4,
      failedAt: 4,
    });
  });
});

describe('EXPORT_MISSING', () => {
  it('fails a ready job at Render, with the export gone from the job', () => {
    const next = transition(jobsByState.ready, EVENTS.EXPORT_MISSING, NOW);
    expect(next).toMatchObject({
      state: 'failed',
      step: 8,
      failedAt: 8,
      error: EXPORT_MISSING_ERROR,
      output: null,
      subProgress: null,
      etaSec: null,
      placeInLine: null,
      updatedAt: NOW_ISO,
    });
    expect(EXPORT_MISSING_ERROR).toBe('Exported file is missing');
    expectConsistent(next);
  });

  it('is allowed only in ready', () => {
    for (const state of JOB_STATES) {
      const run = () => transition(jobsByState[state], EVENTS.EXPORT_MISSING, NOW);
      if (state === 'ready') expect(run).not.toThrow();
      else expect(run).toThrow(InvalidTransition);
    }
  });

  it('can be retried: RETRY queues it again from Render', () => {
    const failed = transition(jobsByState.ready, EVENTS.EXPORT_MISSING, NOW);
    const retried = transition(failed, EVENTS.RETRY, new Date(NOW.getTime() + 1_000));
    expect(retried).toMatchObject({
      state: 'queued',
      step: 8,
      error: null,
      failedAt: null,
      output: null,
    });
    expectConsistent(retried);
  });
});

describe('PREVIEW_READY', () => {
  it('sends an edit run to review with the preview, at Check', () => {
    const next = transition(jobsByState.editing, EVENTS.PREVIEW_READY, NOW);
    expect(next).toMatchObject({
      state: 'review',
      step: 7,
      subProgress: null,
      etaSec: null,
      placeInLine: null,
      preview: SAMPLE_PREVIEW,
      runKind: 'edit',
      updatedAt: NOW_ISO,
    });
    expectConsistent(next);
  });

  it('also ends an edit run that was at the Preview step', () => {
    const job = makeJob({ state: 'editing', step: 6, subProgress: 'pass 1/3', placeInLine: null });
    expect(transition(job, EVENTS.PREVIEW_READY, NOW)).toMatchObject({
      state: 'review',
      step: 7,
      subProgress: null,
    });
  });

  it('ends a revise run too, keeping its round', () => {
    const job = makeJob({
      state: 'editing',
      step: 5,
      placeInLine: null,
      runKind: 'revise',
      round: 2,
      preview: { durationSec: 20, width: 1080, height: 1920 },
    });
    const next = transition(job, EVENTS.PREVIEW_READY, NOW);
    expect(next).toMatchObject({
      state: 'review',
      step: 7,
      runKind: 'revise',
      round: 2,
      preview: SAMPLE_PREVIEW,
    });
    expectConsistent(next);
  });

  it('is refused for a render run', () => {
    const job = makeJob({
      state: 'editing',
      step: 8,
      placeInLine: null,
      runKind: 'render',
      round: 1,
      preview: SAMPLE_PREVIEW,
      approvedAt: ago(60_000),
    });
    expect(() => transition(job, EVENTS.PREVIEW_READY, NOW)).toThrow(InvalidTransition);
    expect(() => transition(job, EVENTS.PREVIEW_READY, NOW)).toThrow(
      `Cannot apply PREVIEW_READY to job ${job.id} in state editing`,
    );
  });

  it("keeps a copy of the preview, not the event's object", () => {
    const preview = { durationSec: 12, width: 720, height: 1280 };
    const next = transition(jobsByState.editing, { type: 'PREVIEW_READY', preview }, NOW);
    preview.durationSec = 99;
    expect(next.preview).toEqual({ durationSec: 12, width: 720, height: 1280 });
    expect(next.preview).not.toBe(preview);
  });

  it('is allowed only while editing', () => {
    for (const state of JOB_STATES) {
      const run = () => transition(jobsByState[state], EVENTS.PREVIEW_READY, NOW);
      if (state === 'editing') expect(run).not.toThrow();
      else expect(run, state).toThrow(InvalidTransition);
    }
  });
});

describe('SEND_NOTES', () => {
  it('queues a revise run at the back of the line, one round further', () => {
    const next = transition(jobsByState.review, EVENTS.SEND_NOTES, NOW);
    expect(next).toMatchObject({
      state: 'queued',
      runKind: 'revise',
      round: 1,
      step: null,
      subProgress: null,
      settledAt: NOW_ISO,
      heldSettledAt: null,
      placeInLine: null,
      etaSec: null,
      updatedAt: NOW_ISO,
      preview: SAMPLE_PREVIEW,
      approvedAt: null,
    });
    expectConsistent(next);
  });

  it('counts the rounds: 2 becomes 3', () => {
    const job = makeJob({
      state: 'review',
      step: 7,
      placeInLine: null,
      runKind: 'revise',
      round: 2,
      preview: SAMPLE_PREVIEW,
    });
    expect(transition(job, EVENTS.SEND_NOTES, NOW)).toMatchObject({
      runKind: 'revise',
      round: 3,
    });
  });

  it('is followed by a START at Plan', () => {
    const queued = transition(jobsByState.review, EVENTS.SEND_NOTES, NOW);
    const started = transition(queued, EVENTS.START, new Date(NOW.getTime() + 1_000));
    expect(started).toMatchObject({ state: 'editing', step: 4, runKind: 'revise', round: 1 });
  });

  it('is allowed only in review', () => {
    for (const state of JOB_STATES) {
      const run = () => transition(jobsByState[state], EVENTS.SEND_NOTES, NOW);
      if (state === 'review') expect(run).not.toThrow();
      else expect(run, state).toThrow(InvalidTransition);
    }
  });
});

describe('APPROVE', () => {
  it('queues the render run, stamped with the approval time', () => {
    const job = makeJob({
      state: 'review',
      step: 7,
      placeInLine: null,
      runKind: 'revise',
      round: 2,
      preview: SAMPLE_PREVIEW,
    });
    const next = transition(job, EVENTS.APPROVE, NOW);
    expect(next).toMatchObject({
      state: 'queued',
      runKind: 'render',
      step: null,
      subProgress: null,
      settledAt: NOW_ISO,
      approvedAt: NOW_ISO,
      round: 2,
      preview: SAMPLE_PREVIEW,
      placeInLine: null,
      updatedAt: NOW_ISO,
    });
    expectConsistent(next);
  });

  it('is followed by a START at Render', () => {
    const queued = transition(jobsByState.review, EVENTS.APPROVE, NOW);
    const started = transition(queued, EVENTS.START, new Date(NOW.getTime() + 1_000));
    expect(started).toMatchObject({ state: 'editing', step: 8, runKind: 'render' });
  });

  it('is allowed only in review', () => {
    for (const state of JOB_STATES) {
      const run = () => transition(jobsByState[state], EVENTS.APPROVE, NOW);
      if (state === 'review') expect(run).not.toThrow();
      else expect(run, state).toThrow(InvalidTransition);
    }
  });
});

describe('UNAPPROVE', () => {
  /** A job as the render run leaves it after the owner approved a preview: ready, approved, not delivered. */
  const approved = (overrides: Partial<Job> = {}) =>
    makeJob({
      ...jobsByState.ready,
      runKind: 'render',
      round: 2,
      preview: SAMPLE_PREVIEW,
      approvedAt: ago(60_000),
      ...overrides,
    });

  it('puts an approved video back in Review at Check, with its composition and no export', () => {
    const next = transition(approved(), EVENTS.UNAPPROVE, NOW);
    expect(next).toMatchObject({
      state: 'review',
      step: 7,
      subProgress: null,
      runKind: 'revise',
      round: 2,
      preview: SAMPLE_PREVIEW,
      output: null,
      approvedAt: null,
      placeInLine: null,
      updatedAt: NOW_ISO,
    });
    expectConsistent(next);
  });

  it('puts the run kind back to edit when no notes were ever sent', () => {
    const next = transition(approved({ round: 0 }), EVENTS.UNAPPROVE, NOW);
    expect(next).toMatchObject({ state: 'review', runKind: 'edit', round: 0 });
    expectConsistent(next);
  });

  it('can be approved again: APPROVE queues the render run', () => {
    const back = transition(approved(), EVENTS.UNAPPROVE, NOW);
    const queued = transition(back, EVENTS.APPROVE, new Date(NOW.getTime() + 1_000));
    expect(queued).toMatchObject({ state: 'queued', runKind: 'render', round: 2 });
    expect(queued.approvedAt).toBe(new Date(NOW.getTime() + 1_000).toISOString());
  });

  it('is allowed only in ready', () => {
    for (const state of JOB_STATES) {
      const job = state === 'ready' ? approved() : jobsByState[state];
      const run = () => transition(job, EVENTS.UNAPPROVE, NOW);
      if (state === 'ready') expect(run).not.toThrow();
      else expect(run, state).toThrow(InvalidTransition);
    }
  });

  it('refuses a ready job that was never approved (an edit that ended with Review off)', () => {
    const job = approved({ approvedAt: null, runKind: 'edit', round: 0, preview: null });
    expect(() => transition(job, EVENTS.UNAPPROVE, NOW)).toThrow(InvalidTransition);
    expect(can(job, 'unapprove')).toBe(false);
  });

  it('refuses a job with no composition to go back to', () => {
    const job = approved({ preview: null });
    expect(() => transition(job, EVENTS.UNAPPROVE, NOW)).toThrow(InvalidTransition);
    expect(can(job, 'unapprove')).toBe(false);
  });

  it('refuses a delivered or paid video: Not delivered yet comes first', () => {
    const delivered = approved({
      delivery: { deliveredAt: ago(1_000), price: 40, currency: 'ILS', paidOn: null },
    });
    const paid = approved({
      delivery: { deliveredAt: ago(1_000), price: 40, currency: 'ILS', paidOn: '2026-10-20' },
    });
    for (const job of [delivered, paid]) {
      expect(() => transition(job, EVENTS.UNAPPROVE, NOW)).toThrow(InvalidTransition);
      expect(can(job, 'unapprove')).toBe(false);
    }
  });

  it('agrees with can for an approved video, and says no when it is told only the state', () => {
    expect(can(approved(), 'unapprove')).toBe(true);
    expect(can({ state: 'ready' }, 'unapprove')).toBe(false);
  });

  it('is what the unapprove action stands for', () => {
    expect(eventForAction('unapprove')).toEqual({ type: 'UNAPPROVE' });
  });
});

describe('PREVIEW_MISSING', () => {
  it('fails a review job at Preview, with the preview gone from the job', () => {
    const next = transition(jobsByState.review, EVENTS.PREVIEW_MISSING, NOW);
    expect(next).toMatchObject({
      state: 'failed',
      step: 6,
      failedAt: 6,
      error: PREVIEW_MISSING_ERROR,
      preview: null,
      runKind: 'edit',
      subProgress: null,
      etaSec: null,
      placeInLine: null,
      updatedAt: NOW_ISO,
    });
    expect(PREVIEW_MISSING_ERROR).toBe('Preview is missing');
    expectConsistent(next);
  });

  it('keeps the kind of run and the round of the job', () => {
    const job = makeJob({
      state: 'review',
      step: 7,
      placeInLine: null,
      runKind: 'revise',
      round: 2,
      preview: SAMPLE_PREVIEW,
    });
    expect(transition(job, EVENTS.PREVIEW_MISSING, NOW)).toMatchObject({
      runKind: 'revise',
      round: 2,
      preview: null,
    });
  });

  it('is allowed only in review', () => {
    for (const state of JOB_STATES) {
      const run = () => transition(jobsByState[state], EVENTS.PREVIEW_MISSING, NOW);
      if (state === 'review') expect(run).not.toThrow();
      else expect(run, state).toThrow(InvalidTransition);
    }
  });

  it('can be retried: RETRY queues it again from Preview, with the same kind of run', () => {
    const failed = transition(jobsByState.review, EVENTS.PREVIEW_MISSING, NOW);
    const retried = transition(failed, EVENTS.RETRY, new Date(NOW.getTime() + 1_000));
    expect(retried).toMatchObject({
      state: 'queued',
      step: 6,
      error: null,
      failedAt: null,
      runKind: 'edit',
      preview: null,
    });
    expectConsistent(retried);
  });
});

describe('SUCCEED and the kind of run', () => {
  const editingAs = (runKind: Job['runKind']): Job =>
    makeJob({
      state: 'editing',
      step: 8,
      placeInLine: null,
      runKind,
      round: runKind === 'edit' ? 0 : 1,
      preview: runKind === 'edit' ? null : SAMPLE_PREVIEW,
      approvedAt: runKind === 'render' ? ago(60_000) : null,
    });

  it('lets a render run succeed, with or without the Review switch', () => {
    const job = editingAs('render');
    expect(transition(job, EVENTS.SUCCEED, NOW).state).toBe('ready');
    expect(transition(job, EVENTS.SUCCEED, NOW, { review: true }).state).toBe('ready');
    expect(transition(job, EVENTS.SUCCEED, NOW, { review: false }).state).toBe('ready');
    expectConsistent(transition(job, EVENTS.SUCCEED, NOW, { review: true }));
  });

  it('lets an edit run succeed while the Review switch is off (the default)', () => {
    const job = editingAs('edit');
    expect(transition(job, EVENTS.SUCCEED, NOW).state).toBe('ready');
    expect(transition(job, EVENTS.SUCCEED, NOW, {}).state).toBe('ready');
    expect(transition(job, EVENTS.SUCCEED, NOW, { review: false }).state).toBe('ready');
  });

  it('refuses an edit run when the Review switch is on', () => {
    expect(() => transition(editingAs('edit'), EVENTS.SUCCEED, NOW, { review: true })).toThrow(
      InvalidTransition,
    );
  });

  it('never lets a revise run succeed', () => {
    const job = editingAs('revise');
    for (const options of [undefined, {}, { review: false }, { review: true }]) {
      expect(() => transition(job, EVENTS.SUCCEED, NOW, options)).toThrow(InvalidTransition);
    }
  });

  it('does not change how the other events treat an edit run', () => {
    const job = editingAs('edit');
    expect(transition(job, EVENTS.PREVIEW_READY, NOW, { review: true }).state).toBe('review');
    expect(transition(job, EVENTS.FAIL, NOW, { review: true }).state).toBe('failed');
    expect(transition(job, EVENTS.CANCEL, NOW, { review: true }).state).toBe('cancelled');
  });
});

describe('START and the kind of run', () => {
  it.each([
    ['edit', 1],
    ['revise', 4],
    ['render', 8],
  ] as const)('a fresh %s run starts at step %i', (runKind, step) => {
    const next = transition(makeJob({ runKind, step: null }), EVENTS.START, NOW);
    expect(next.step).toBe(step);
    expect(next.step).toBe(firstStepOf(runKind));
  });

  it.each(RUN_KINDS)('keeps the stored step of a %s run', (runKind) => {
    const job = makeJob({ runKind, step: 6 });
    expect(transition(job, EVENTS.START, NOW).step).toBe(6);
  });
});

describe('CANCEL', () => {
  it('records the current step as stoppedAt and keeps the step', () => {
    const next = transition(jobsByState.editing, EVENTS.CANCEL, NOW);
    expect(next).toMatchObject({ state: 'cancelled', step: 5, stoppedAt: 5, etaSec: null });
  });

  it('records no step for a job that never reported one', () => {
    const job = makeJob({ state: 'editing', step: null, placeInLine: null });
    expect(transition(job, EVENTS.CANCEL, NOW)).toMatchObject({
      state: 'cancelled',
      stoppedAt: null,
    });
  });
});

describe('RETRY and RESUME', () => {
  it('RETRY queues a failed job again from the step it failed at, with the error cleared', () => {
    const next = transition(jobsByState.failed, EVENTS.RETRY, NOW);
    expect(next).toMatchObject({
      state: 'queued',
      step: 8,
      error: null,
      failedAt: null,
      stoppedAt: null,
      subProgress: null,
      settledAt: NOW_ISO,
    });
  });

  it('RESUME queues a cancelled job again from the step it stopped at', () => {
    const next = transition(jobsByState.cancelled, EVENTS.RESUME, NOW);
    expect(next).toMatchObject({
      state: 'queued',
      step: 4,
      error: null,
      failedAt: null,
      stoppedAt: null,
      subProgress: null,
      settledAt: NOW_ISO,
    });
  });

  it('RETRY keeps the run: a failed revise run stays revise, with its round', () => {
    const failed = makeJob({
      state: 'failed',
      step: 5,
      failedAt: 5,
      error: 'boom',
      placeInLine: null,
      runKind: 'revise',
      round: 2,
      preview: SAMPLE_PREVIEW,
    });
    const next = transition(failed, EVENTS.RETRY, NOW);
    expect(next).toMatchObject({
      state: 'queued',
      runKind: 'revise',
      round: 2,
      preview: SAMPLE_PREVIEW,
      approvedAt: null,
      step: 5,
    });
    expectConsistent(next);
  });

  it('RESUME keeps the run: a cancelled render run stays render, with its approval', () => {
    const approvedAt = ago(120_000);
    const cancelled = makeJob({
      state: 'cancelled',
      step: 8,
      stoppedAt: 8,
      placeInLine: null,
      runKind: 'render',
      round: 1,
      preview: SAMPLE_PREVIEW,
      approvedAt,
    });
    const next = transition(cancelled, EVENTS.RESUME, NOW);
    expect(next).toMatchObject({
      state: 'queued',
      runKind: 'render',
      round: 1,
      preview: SAMPLE_PREVIEW,
      approvedAt,
      step: 8,
    });
    expectConsistent(next);
  });

  it('forgets a stale sub-progress and error', () => {
    const failed = makeJob({
      state: 'failed',
      step: 7,
      failedAt: 7,
      error: 'boom',
      subProgress: 'pass 2/3',
      placeInLine: null,
    });
    expect(transition(failed, EVENTS.RETRY, NOW)).toMatchObject({
      subProgress: null,
      error: null,
      step: 7,
    });
  });
});

describe('whole lives', () => {
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

  /** Applies the events one by one, checking every intermediate job, and returns the last. */
  function run(
    start: Job,
    steps: readonly (readonly [JobEvent, Date])[],
    options: TransitionOptions = {},
  ): Job {
    let job = start;
    for (const [event, when] of steps) {
      job = transition(job, event, when, options);
      expectConsistent(job);
    }
    return job;
  }

  const fresh = makeJob({
    state: 'arriving',
    step: null,
    placeInLine: null,
    settlesAt: settleTime(NOW_ISO),
    lastChangeAt: NOW_ISO,
    settledAt: null,
  });

  it('arriving -> queued -> editing -> ready', () => {
    const job = run(fresh, [
      [EVENTS.FILES_CHANGED, at(0.5)],
      [EVENTS.SETTLED, at(2)],
      [EVENTS.START, at(3)],
      [{ type: 'PROGRESS', step: 2, sub: '1/14' }, at(4)],
      [{ type: 'PROGRESS', step: 8, sub: null }, at(20)],
      [EVENTS.SUCCEED, at(25)],
    ]);
    expect(job).toMatchObject({
      state: 'ready',
      step: 8,
      output: OUTPUT,
      updatedAt: at(25).toISOString(),
    });
  });

  it('holds and releases a job that settled long ago', () => {
    const job = run(fresh, [
      [EVENTS.HOLD, at(0.5)],
      [EVENTS.RELEASE, at(10)],
      [EVENTS.START, at(11)],
    ]);
    expect(job.state).toBe('editing');
    expect(job.settledAt).toBe(at(10).toISOString());
  });

  it('fails, is retried from the failed step and then succeeds', () => {
    const job = run(fresh, [
      [EVENTS.SETTLED, at(1)],
      [EVENTS.START, at(2)],
      [{ type: 'FAIL', step: 6, error: 'preview.mp4 missing' }, at(10)],
      [EVENTS.RETRY, at(11)],
      [EVENTS.START, at(12)],
      [EVENTS.SUCCEED, at(20)],
    ]);
    expect(job.state).toBe('ready');
    expect(job.error).toBeNull();
  });

  it('is cancelled and resumed at the step it stopped at', () => {
    const editing = run(fresh, [
      [EVENTS.SETTLED, at(1)],
      [EVENTS.START, at(2)],
      [{ type: 'PROGRESS', step: 5, sub: 'graphics 1/5' }, at(5)],
      [EVENTS.CANCEL, at(6)],
    ]);
    expect(editing).toMatchObject({ state: 'cancelled', stoppedAt: 5 });

    const resumed = run(editing, [
      [EVENTS.RESUME, at(7)],
      [EVENTS.START, at(8)],
    ]);
    expect(resumed).toMatchObject({
      state: 'editing',
      step: 5,
      subProgress: null,
      stoppedAt: null,
    });
  });

  it('edit -> review -> notes -> second preview -> approve -> render -> ready (Review on)', () => {
    const second = { durationSec: 26, width: 1080, height: 1920 };
    const job = run(
      fresh,
      [
        [EVENTS.SETTLED, at(1)],
        [EVENTS.START, at(2)],
        [{ type: 'PROGRESS', step: 7, sub: null }, at(10)],
        [EVENTS.PREVIEW_READY, at(11)],
        [EVENTS.SEND_NOTES, at(30)],
        [EVENTS.START, at(31)],
        [{ type: 'PREVIEW_READY', preview: second }, at(40)],
        [EVENTS.APPROVE, at(50)],
        [EVENTS.START, at(51)],
        [EVENTS.SUCCEED, at(60)],
      ],
      { review: true },
    );
    expect(job).toMatchObject({
      state: 'ready',
      step: 8,
      runKind: 'render',
      round: 1,
      preview: second,
      approvedAt: at(50).toISOString(),
      output: OUTPUT,
      updatedAt: at(60).toISOString(),
    });
  });

  it('with Review on, an edit run that tries to SUCCEED is refused mid-life', () => {
    const editing = run(
      fresh,
      [
        [EVENTS.SETTLED, at(1)],
        [EVENTS.START, at(2)],
      ],
      { review: true },
    );
    expect(() => transition(editing, EVENTS.SUCCEED, at(3), { review: true })).toThrow(
      InvalidTransition,
    );
  });

  it('a retry goes behind a job that was already waiting', () => {
    const failed = jobsByState.failed;
    const waiting = jobsByState.queued;
    const retried = transition(failed, EVENTS.RETRY, NOW);
    expect(Date.parse(retried.settledAt ?? '')).toBeGreaterThan(
      Date.parse(waiting.settledAt ?? ''),
    );
  });
});

describe('purity', () => {
  it('never modifies the job it is given', () => {
    for (const [state, eventType, outcome] of PAIRS) {
      if (outcome === 'invalid') continue;
      const job = deepCopy(jobsByState[state]);
      const before = deepCopy(job);
      transition(job, EVENTS[eventType], NOW);
      expect(job, `${state} + ${eventType}`).toEqual(before);
    }
  });

  it('uses only the `now` it is given, never the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2001-01-01T00:00:00.000Z'));
    const next = transition(jobsByState.queued, EVENTS.HOLD, NOW);
    expect(next.updatedAt).toBe(NOW_ISO);
    expect(transition(jobsByState.arriving, EVENTS.FILES_CHANGED, NOW).lastChangeAt).toBe(NOW_ISO);
    expect(can(jobsByState.queued, 'hold')).toBe(true);
  });

  it('gives the same answer for the same input', () => {
    const job = jobsByState.queued;
    expect(transition(job, EVENTS.START, NOW)).toEqual(transition(job, EVENTS.START, NOW));
  });

  it('passes fields it does not know about through (a stored record keeps its extras)', () => {
    const record = { ...jobsByState.queued, startedAt: null as string | null, attempt: 2 };
    const next = transition(record, EVENTS.START, NOW);
    expect(next).toMatchObject({ state: 'editing', startedAt: null, attempt: 2 });
    expectTypeOf(next).toEqualTypeOf<typeof record>();
  });

  it('returns a Job when given a Job', () => {
    expectTypeOf(transition(jobsByState.queued, EVENTS.START, NOW)).toEqualTypeOf<Job>();
  });

  it('keeps Hebrew and mixed-direction names exactly', () => {
    const next = transition(hebrewJob, EVENTS.HOLD, NOW);
    expect(next.client).toBe('מאפיית הצפון');
    expect(next.name).toBe('סרטון גיוס – Hiring video');
  });
});

describe('settle timer', () => {
  it('is 60 seconds', () => {
    expect(SETTLE_MS).toBe(60_000);
    expect(settleTime('2026-10-20T13:41:00.000Z')).toBe('2026-10-20T13:42:00.000Z');
    expect(settleTime(jobsByState.arriving.lastChangeAt)).toBe(jobsByState.arriving.settlesAt);
  });
});

// The server runs on Config.settleMs, the delay the inbox watcher settles with.
describe('a custom settle delay (settleMs)', () => {
  const FIVE_S = { settleMs: 5_000 };
  const held = (lastChangeAt: string) =>
    makeJob({ state: 'held', placeInLine: null, settledAt: null, lastChangeAt });

  it('settleTime adds the delay it is given', () => {
    expect(settleTime('2026-10-20T13:41:00.000Z', 5_000)).toBe('2026-10-20T13:41:05.000Z');
    expect(settleTime('2026-10-20T13:41:00.000Z', 0)).toBe('2026-10-20T13:41:00.000Z');
    expect(settleTime('2026-10-20T13:41:00.000Z', 120_000)).toBe('2026-10-20T13:43:00.000Z');
    expect(settleTime('2026-10-20T13:41:00.000Z', SETTLE_MS)).toBe(
      settleTime('2026-10-20T13:41:00.000Z'),
    );
  });

  it('an empty options object is the 60 s default', () => {
    const job = jobsByState.arriving;
    expect(transition(job, EVENTS.FILES_CHANGED, NOW, {})).toEqual(
      transition(job, EVENTS.FILES_CHANGED, NOW),
    );
    expect(transition(held(ago(30_000)), EVENTS.RELEASE, NOW, {}).state).toBe('arriving');
  });

  it('FILES_CHANGED restarts the timer for the custom delay', () => {
    const arriving = transition(jobsByState.arriving, EVENTS.FILES_CHANGED, NOW, FIVE_S);
    expect(arriving).toMatchObject({
      state: 'arriving',
      lastChangeAt: NOW_ISO,
      settlesAt: '2026-10-20T14:00:05.000Z',
    });

    const queued = makeJob({ state: 'queued', placeInLine: 2, settledAt: ago(60_000) });
    expect(transition(queued, EVENTS.FILES_CHANGED, NOW, FIVE_S)).toMatchObject({
      state: 'arriving',
      settlesAt: '2026-10-20T14:00:05.000Z',
    });
  });

  it.each([
    ['just now', 0, 'arriving'],
    ['4.999 s ago', 4_999, 'arriving'],
    ['exactly 5 s ago', 5_000, 'queued'],
    ['5.001 s ago', 5_001, 'queued'],
    ['30 s ago (still inside the 60 s default)', 30_000, 'queued'],
  ] as const)('RELEASE with 5 s and the last file change %s goes to %s', (_label, age, state) => {
    expect(transition(held(ago(age)), EVENTS.RELEASE, NOW, FIVE_S).state).toBe(state);
  });

  it('RELEASE goes to arriving on the original timer, running for the custom delay', () => {
    const lastChangeAt = ago(2_000);
    const next = transition(held(lastChangeAt), EVENTS.RELEASE, NOW, FIVE_S);
    expect(next).toMatchObject({
      state: 'arriving',
      lastChangeAt,
      settlesAt: '2026-10-20T14:00:03.000Z',
      settledAt: null,
    });
    expect(next.settlesAt).toBe(settleTime(lastChangeAt, 5_000));
  });

  it('RELEASE with a longer delay holds back a job the 60 s default would queue', () => {
    const job = held(ago(90_000));
    expect(transition(job, EVENTS.RELEASE, NOW).state).toBe('queued');
    const next = transition(job, EVENTS.RELEASE, NOW, { settleMs: 120_000 });
    expect(next.state).toBe('arriving');
    expect(next.settlesAt).toBe(settleTime(job.lastChangeAt, 120_000));
  });

  it('a delay of 0 queues a released job at once', () => {
    expect(transition(held(NOW_ISO), EVENTS.RELEASE, NOW, { settleMs: 0 }).state).toBe('queued');
  });

  it('does not touch the options it is given', () => {
    const options = Object.freeze({ settleMs: 5_000 });
    expect(() => transition(held(ago(1_000)), EVENTS.RELEASE, NOW, options)).not.toThrow();
    expect(options).toEqual({ settleMs: 5_000 });
  });
});

describe('@studio/shared root', () => {
  it('exports the machine', () => {
    expect(shared.transition).toBe(transition);
    expect(shared.can).toBe(can);
    expect(shared.InvalidTransition).toBe(InvalidTransition);
    expect(shared.eventForAction).toBe(eventForAction);
    expect(shared.JOB_EVENT_TYPES).toBe(JOB_EVENT_TYPES);
    expect(shared.SETTLE_MS).toBe(SETTLE_MS);
    expect(shared.settleTime).toBe(settleTime);
  });

  it('exports the review pieces', () => {
    expect(shared.PREVIEW_MISSING_ERROR).toBe(PREVIEW_MISSING_ERROR);
    expect(shared.firstStepOf).toBe(firstStepOf);
    expect(shared.RUN_KINDS).toBe(RUN_KINDS);
  });
});
