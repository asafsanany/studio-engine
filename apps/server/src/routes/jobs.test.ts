import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  apiErrorSchema,
  JOB_ACTIONS,
  JOB_STATES,
  type Job,
  type JobAction,
  type JobEvent,
  jobActionPath,
  jobActionResponseSchema,
  jobListResponseSchema,
  jobSchema,
  NOTE_MAX_LENGTH,
  REVIEW_TIME_MAX_SEC,
  reviewTimeResponseSchema,
  SETTLE_MS,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository, StepRunRepository } from '../db/index.js';
import { type FakeClock, fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { logger } from '../logger.js';
import type { Runner } from '../pipeline/runner.js';
import { QueueWorker } from '../pipeline/worker.js';
import type { ActionWorker } from './jobs.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The real repository on an in-memory database, the real routes, `app.request` for the HTTP. Only
// the worker is a stand-in, except in the tests that say they use the real one.

interface Harness {
  app: Hono;
  jobs: JobRepository;
  clock: FakeClock;
  /** What `onJobChanged` was called with, and what the fake worker was told, in order. */
  log: string[];
  changed: Job[];
  /** How many times `onReviewTime` was called. */
  reviewTimes: { count: number };
  worker: ActionWorker | null;
}

const NO_OUTPUT_DIR = '/nonexistent/exports';

interface HarnessOptions {
  /** Builds the worker the routes get; it can use the repository the harness made. */
  worker?: (deps: { jobs: JobRepository; log: string[] }) => ActionWorker;
  exportsDir?: string;
  /** The settle delay the repository runs on (`Config.settleMs`); 60 s when left out. */
  settleMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = fakeClock();
  const jobs = new JobRepository(memoryDb(), { clock, settleMs: options.settleMs });
  const log: string[] = [];
  const changed: Job[] = [];
  const reviewTimes = { count: 0 };
  const worker = options.worker?.({ jobs, log }) ?? null;
  const app = createApp({
    jobs: {
      jobs,
      worker,
      exportsDir: options.exportsDir ?? NO_OUTPUT_DIR,
      onJobChanged: (job) => {
        changed.push(job);
        log.push(`changed:${job.state}`);
      },
      onReviewTime: () => {
        reviewTimes.count += 1;
      },
    },
  });
  return { app, jobs, clock, log, changed, reviewTimes, worker };
}

interface FakeWorker extends ActionWorker {
  cancelled: string[];
  notified: number;
}

/** A worker that records what it is told, and cancels the way the test says (default: nothing to stop). */
function fakeWorker(
  log: string[],
  cancel: (id: string) => Promise<Job | null> = async () => null,
): FakeWorker {
  const worker: FakeWorker = {
    cancelled: [],
    notified: 0,
    cancel: async (id) => {
      worker.cancelled.push(id);
      return cancel(id);
    },
    notify: () => {
      worker.notified += 1;
      log.push('notify');
    },
  };
  return worker;
}

/** A harness whose worker stops a run by applying CANCEL, as the real one does. */
function harnessCancellingLikeTheWorker(): Harness & { worker: FakeWorker } {
  const h = harness({
    worker: ({ jobs, log }) =>
      fakeWorker(log, async (id) => jobs.applyTransition(id, { type: 'CANCEL' })),
  });
  return h as Harness & { worker: FakeWorker };
}

const OUTPUT = {
  fileName: 'Northwind Bakery/Spring menu.mp4',
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 1000,
};

function events(...list: JobEvent[]): JobEvent[] {
  return list;
}

/** Adds a job and walks it to `state` through real events. */
function seed(
  { jobs, clock }: Pick<Harness, 'jobs' | 'clock'>,
  state: Job['state'],
  name = 'Spring menu',
  client = 'Northwind Bakery',
): Job {
  const { job } = jobs.upsertFromScan(makeScan(client, name));
  const path: Record<Job['state'], JobEvent[]> = {
    arriving: [],
    queued: events({ type: 'SETTLED' }),
    held: events({ type: 'HOLD' }),
    editing: events({ type: 'SETTLED' }, { type: 'START' }),
    review: events(
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
    ),
    ready: events(
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'SUCCEED', output: { ...OUTPUT, fileName: `${client}/${name}.mp4` } },
    ),
    failed: events(
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'FAIL', step: 4, error: 'boom' },
    ),
    cancelled: events({ type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }),
  };
  let current = job;
  for (const event of path[state]) {
    clock.tick();
    current = jobs.applyTransition(job.id, event);
  }
  return current;
}

async function post(app: Hono, id: string, action: string): Promise<Response> {
  return app.request(`/api/jobs/${id}/${action}`, { method: 'POST' });
}

async function expectError(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await res.json()).error;
}

describe('GET /api/jobs', () => {
  it('is an empty list when there are no jobs', async () => {
    const { app } = harness();

    const res = await app.request('/api/jobs');

    expect(res.status).toBe(200);
    expect(jobListResponseSchema.parse(await res.json())).toEqual([]);
  });

  it('lists every job, newest update first, matching the shared schema', async () => {
    const h = harness();
    const arriving = seed(h, 'arriving', 'A arriving');
    const queuedFirst = seed(h, 'queued', 'B queued first');
    const queuedSecond = seed(h, 'queued', 'C queued second');
    const editing = seed(h, 'editing', 'D editing');
    const ready = seed(h, 'ready', 'E ready');

    const res = await h.app.request('/api/jobs');

    expect(res.status).toBe(200);
    const list = jobListResponseSchema.parse(await res.json());
    expect(list.map((job) => job.id)).toEqual(
      [ready, editing, queuedSecond, queuedFirst, arriving].map((job) => job.id),
    );
    expect(list.map((job) => job.state)).toEqual([
      'ready',
      'editing',
      'queued',
      'queued',
      'arriving',
    ]);
  });

  it('includes the derived placeInLine and settlesAt', async () => {
    const h = harness();
    seed(h, 'queued', 'First');
    seed(h, 'queued', 'Second');
    const arriving = seed(h, 'arriving', 'Third');

    const list = jobListResponseSchema.parse(await (await h.app.request('/api/jobs')).json());

    const byName = Object.fromEntries(list.map((job) => [job.name, job]));
    expect(byName.First?.placeInLine).toBe(1);
    expect(byName.Second?.placeInLine).toBe(2);
    expect(byName.Third?.placeInLine).toBeNull();
    expect(byName.Third?.settlesAt).toBe(
      new Date(Date.parse(arriving.lastChangeAt) + SETTLE_MS).toISOString(),
    );
    expect(byName.First?.settlesAt).toBeNull();
  });

  it('derives settlesAt from the configured settle delay, not a fixed minute', async () => {
    const h = harness({ settleMs: 5_000 });
    const arriving = seed(h, 'arriving', 'Third');

    const list = jobListResponseSchema.parse(await (await h.app.request('/api/jobs')).json());

    expect(list[0]?.settlesAt).toBe(
      new Date(Date.parse(arriving.lastChangeAt) + 5_000).toISOString(),
    );
    expect(arriving.settlesAt).toBe(list[0]?.settlesAt);
  });

  it('serves Hebrew names as they are', async () => {
    const h = harness();
    seed(h, 'queued', 'תפריט אביב', 'לקוח');

    const [job] = jobListResponseSchema.parse(await (await h.app.request('/api/jobs')).json());

    expect(job?.client).toBe('לקוח');
    expect(job?.name).toBe('תפריט אביב');
    expect(job?.relPath).toBe('לקוח/תפריט אביב');
  });

  it('answers 500 with { error } when the database fails', async () => {
    const h = harness();
    vi.spyOn(h.jobs, 'getAll').mockImplementation(() => {
      throw new Error('disk on fire');
    });

    const res = await h.app.request('/api/jobs');

    expect(await expectError(res, 500)).toBe('Internal server error');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/jobs' }),
      'unhandled error in a request',
    );
  });
});

describe('POST /api/jobs/:id/:action', () => {
  // [action, state it is allowed in, state it leaves the job in]
  const allowed: Array<[JobAction, Job['state'], Job['state']]> = [
    ['start', 'arriving', 'queued'],
    ['hold', 'arriving', 'held'],
    ['hold', 'queued', 'held'],
    ['release', 'held', 'queued'],
    ['cancel', 'editing', 'cancelled'],
    ['resume', 'cancelled', 'queued'],
    ['retry', 'failed', 'queued'],
    ['send_notes', 'review', 'queued'],
    ['approve', 'review', 'queued'],
  ];

  it.each(allowed)('%s on a %s job answers 200 with the job now %s', async (action, from, to) => {
    const h = harness();
    const job = seed(h, from);
    // A held job whose files changed long ago goes straight to the queue.
    h.clock.tick(SETTLE_MS * 2);

    const res = await post(h.app, job.id, jobActionPath(action));

    expect(res.status).toBe(200);
    const body = jobActionResponseSchema.parse(await res.json());
    expect(body.id).toBe(job.id);
    expect(body.state).toBe(to);
    expect(h.jobs.get(job.id)).toEqual(body);
  });

  describe('send-notes and approve (a job in review)', () => {
    it('send-notes answers a queued revise job at round 1 with no step', async () => {
      const h = harness();
      const job = seed(h, 'review');
      h.clock.tick(5_000);

      const res = await post(h.app, job.id, 'send-notes');

      expect(res.status).toBe(200);
      const body = jobActionResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        state: 'queued',
        runKind: 'revise',
        round: 1,
        step: null,
        preview: SAMPLE_PREVIEW,
        approvedAt: null,
        settledAt: h.clock().toISOString(),
        placeInLine: 1,
      });
      expect(h.jobs.get(job.id)).toEqual(body);
    });

    it('approve answers a queued render job stamped with the time of the approval', async () => {
      const h = harness();
      const job = seed(h, 'review');
      h.clock.tick(5_000);

      const res = await post(h.app, job.id, 'approve');

      expect(res.status).toBe(200);
      const body = jobActionResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        state: 'queued',
        runKind: 'render',
        round: 0,
        step: null,
        preview: SAMPLE_PREVIEW,
        approvedAt: h.clock().toISOString(),
        placeInLine: 1,
      });
      expect(h.jobs.get(job.id)).toEqual(body);
    });

    it('send-notes puts the job behind the ones already waiting', async () => {
      const h = harness();
      const review = seed(h, 'review', 'In review');
      seed(h, 'queued', 'Waiting');
      h.clock.tick(5_000);

      const body = jobSchema.parse(await (await post(h.app, review.id, 'send-notes')).json());

      expect(body.placeInLine).toBe(2);
    });
  });

  it('puts a queued job in its place in line in the response', async () => {
    const h = harness();
    seed(h, 'queued', 'Ahead');
    const held = seed(h, 'held', 'Back');
    h.clock.tick(SETTLE_MS * 2);

    const body = jobSchema.parse(await (await post(h.app, held.id, 'release')).json());

    expect(body.state).toBe('queued');
    expect(body.placeInLine).toBe(2);
  });

  // CVP-140: the note dialog holds a job while a note is written and releases it with ?restore=1.
  describe('release?restore=1 (keeping the place in line)', () => {
    /** Two queued jobs, then `First` is held, as the note dialog does. */
    async function firstHeld() {
      const h = harness();
      const first = seed(h, 'queued', 'First');
      const second = seed(h, 'queued', 'Second');
      expect((await post(h.app, first.id, 'hold')).status).toBe(200);
      expect(h.jobs.get(second.id)?.placeInLine).toBe(1);
      // Long enough that a plain release queues the job (its files changed long ago).
      h.clock.tick(SETTLE_MS * 2);
      return { h, first, second };
    }

    it('puts the job back where it stood in line', async () => {
      const { h, first, second } = await firstHeld();

      const res = await post(h.app, first.id, 'release?restore=1');

      expect(res.status).toBe(200);
      const body = jobActionResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        state: 'queued',
        placeInLine: 1,
        settledAt: first.settledAt,
        heldSettledAt: null,
      });
      expect(h.jobs.get(first.id)).toEqual(body);
      expect(h.jobs.get(second.id)?.placeInLine).toBe(2);
    });

    it('a plain release still sends the job to the back of the line', async () => {
      const { h, first, second } = await firstHeld();

      const body = jobSchema.parse(await (await post(h.app, first.id, 'release')).json());

      expect(body).toMatchObject({ state: 'queued', placeInLine: 2, heldSettledAt: null });
      expect(body.settledAt).toBe(h.clock().toISOString());
      expect(h.jobs.get(second.id)?.placeInLine).toBe(1);
    });

    it.each(['0', 'true', '', 'yes'])('restore=%j is not a request to restore', async (value) => {
      const { h, first } = await firstHeld();

      const body = jobSchema.parse(
        await (await post(h.app, first.id, `release?restore=${value}`)).json(),
      );

      expect(body.placeInLine).toBe(2);
    });

    it('keeps an arriving job arriving, on its settle timer', async () => {
      const h = harness();
      const job = seed(h, 'arriving');
      await post(h.app, job.id, 'hold');
      h.clock.tick(5_000);

      const body = jobSchema.parse(await (await post(h.app, job.id, 'release?restore=1')).json());

      expect(body).toMatchObject({
        state: 'arriving',
        lastChangeAt: job.lastChangeAt,
        settlesAt: job.settlesAt,
        heldSettledAt: null,
      });
    });

    it('lets the existing rules win when the files changed while the job was held', async () => {
      const { h, first } = await firstHeld();
      h.jobs.applyTransition(first.id, { type: 'FILES_CHANGED' });
      h.clock.tick(5_000);

      const body = jobSchema.parse(await (await post(h.app, first.id, 'release?restore=1')).json());

      expect(body.state).toBe('arriving');
      expect(body.settledAt).toBeNull();
    });

    it('answers 409 for a job that is not held, like a plain release', async () => {
      const h = harness();
      const queued = seed(h, 'queued');

      const error = await expectError(await post(h.app, queued.id, 'release?restore=1'), 409);

      expect(error).toBe('Cannot release a job that is queued.');
      expect(h.jobs.get(queued.id)?.state).toBe('queued');
    });

    it('answers 404 for an unknown job', async () => {
      const h = harness();
      expect((await post(h.app, 'nope', 'release?restore=1')).status).toBe(404);
    });

    it('tells the others, and wakes the worker, as a release does', async () => {
      const h = harness({ worker: ({ log }) => fakeWorker(log) });
      const first = seed(h, 'queued', 'First');
      seed(h, 'queued', 'Second');
      await post(h.app, first.id, 'hold');
      h.log.length = 0;

      await post(h.app, first.id, 'release?restore=1');

      expect(h.log).toEqual(['changed:queued', 'notify']);
      expect(h.changed.at(-1)).toMatchObject({ id: first.id, placeInLine: 1 });
    });

    it('is ignored by the other actions', async () => {
      const h = harness();
      const queued = seed(h, 'queued');

      const body = jobSchema.parse(await (await post(h.app, queued.id, 'hold?restore=1')).json());

      expect(body.state).toBe('held');
    });
  });

  describe('start (Start now)', () => {
    it('queues an arriving job at once, before its settle delay is over', async () => {
      const h = harness();
      const job = seed(h, 'arriving');
      h.clock.tick(5_000);
      expect(Date.parse(job.lastChangeAt) + SETTLE_MS).toBeGreaterThan(h.clock().getTime());

      const res = await post(h.app, job.id, 'start');

      expect(res.status).toBe(200);
      const body = jobActionResponseSchema.parse(await res.json());
      expect(body).toMatchObject({
        id: job.id,
        state: 'queued',
        placeInLine: 1,
        settlesAt: null,
        settledAt: h.clock().toISOString(),
        lastChangeAt: job.lastChangeAt,
      });
      expect(h.jobs.get(job.id)).toEqual(body);
    });

    it('goes to the back of the line, behind the jobs that were already waiting', async () => {
      const h = harness();
      seed(h, 'queued', 'Ahead');
      const arriving = seed(h, 'arriving', 'Back');
      h.clock.tick(1_000);

      const body = jobSchema.parse(await (await post(h.app, arriving.id, 'start')).json());

      expect(body.placeInLine).toBe(2);
    });

    it('is the same transition the settle timer makes', async () => {
      const a = harness();
      const b = harness();
      const viaRoute = seed(a, 'arriving');
      const viaTimer = seed(b, 'arriving');
      a.clock.tick(5_000);
      b.clock.tick(5_000);

      const started = jobSchema.parse(await (await post(a.app, viaRoute.id, 'start')).json());
      const settled = b.jobs.applyTransition(viaTimer.id, { type: 'SETTLED' });

      expect({ ...started, id: '', relPath: '' }).toEqual({ ...settled, id: '', relPath: '' });
    });

    it('answers 409 "Cannot start a job that is <state>." for a job that is not arriving', async () => {
      const h = harness();
      const queued = seed(h, 'queued');

      const error = await expectError(await post(h.app, queued.id, 'start'), 409);

      expect(error).toBe('Cannot start a job that is queued.');
    });
  });

  it('release answers arriving when the files changed less than a minute ago', async () => {
    const h = harness();
    const job = seed(h, 'held');

    const body = jobSchema.parse(await (await post(h.app, job.id, 'release')).json());

    expect(body.state).toBe('arriving');
    expect(body.settlesAt).not.toBeNull();
  });

  describe('release follows the configured settle delay', () => {
    it('answers arriving, with settlesAt on the configured delay, inside it', async () => {
      const h = harness({ settleMs: 5_000 });
      const job = seed(h, 'held');
      const lastChangeAt = h.jobs.get(job.id)?.lastChangeAt ?? '';
      h.clock.tick(2_000);

      const body = jobSchema.parse(await (await post(h.app, job.id, 'release')).json());

      expect(body.state).toBe('arriving');
      expect(body.settlesAt).toBe(new Date(Date.parse(lastChangeAt) + 5_000).toISOString());
      expect(h.jobs.get(job.id)).toEqual(body);
    });

    it('answers queued once the configured delay is over, long before a minute', async () => {
      const h = harness({ settleMs: 5_000 });
      const job = seed(h, 'held');
      h.clock.tick(10_000);

      const body = jobSchema.parse(await (await post(h.app, job.id, 'release')).json());

      expect(body.state).toBe('queued');
      expect(body.settlesAt).toBeNull();
      expect(body.placeInLine).toBe(1);
    });

    it('with the default delay the same job is still arriving', async () => {
      const h = harness();
      const job = seed(h, 'held');
      h.clock.tick(10_000);

      const body = jobSchema.parse(await (await post(h.app, job.id, 'release')).json());

      expect(body.state).toBe('arriving');
    });
  });

  it('retry and resume keep the step the job stopped at', async () => {
    const h = harness();
    const failed = seed(h, 'failed', 'Failed one');
    const cancelled = seed(h, 'cancelled', 'Cancelled one');

    const retried = jobSchema.parse(await (await post(h.app, failed.id, 'retry')).json());
    const resumed = jobSchema.parse(await (await post(h.app, cancelled.id, 'resume')).json());

    expect(retried.state).toBe('queued');
    expect(retried.step).toBe(4);
    expect(resumed.state).toBe('queued');
    expect(resumed.step).toBe(1);
  });

  describe.each(JOB_ACTIONS)('%s', (action) => {
    it('answers 404 for an unknown job', async () => {
      const { app } = harness();

      const error = await expectError(await post(app, 'nosuchjob00', jobActionPath(action)), 404);

      expect(error).toContain('nosuchjob00');
    });

    it('answers 409 in every state it is not allowed in, and changes nothing', async () => {
      const refused = JOB_STATES.filter(
        (state) => !allowed.some(([name, from]) => name === action && from === state),
      );
      expect(refused.length).toBeGreaterThan(0);

      for (const state of refused) {
        const h = harness({ worker: ({ log }) => fakeWorker(log) });
        const job = seed(h, state);
        h.changed.length = 0;

        const error = await expectError(await post(h.app, job.id, jobActionPath(action)), 409);

        expect(error, `${action} on ${state}`).toBe(
          `Cannot ${action === 'send_notes' ? 'send the notes of' : action} a job that is ${state}.`,
        );
        expect(h.jobs.get(job.id), `${action} on ${state}`).toEqual(job);
        expect(h.changed).toEqual([]);
      }
    });
  });

  it('answers 404 for a word that is not an action, and for the wrong method', async () => {
    const h = harness();
    const job = seed(h, 'queued');

    expect(await expectError(await post(h.app, job.id, 'explode'), 404)).toBe('Not found');
    // The action is send_notes, the URL is send-notes.
    expect(await expectError(await post(h.app, job.id, 'send_notes'), 404)).toBe('Not found');
    expect(await expectError(await h.app.request(`/api/jobs/${job.id}/hold`), 404)).toBe(
      'Not found',
    );
    expect(await expectError(await h.app.request(`/api/jobs/${job.id}`), 404)).toBe('Not found');
    expect(h.jobs.get(job.id)?.state).toBe('queued');
  });

  it('answers 500 with { error } for a failure that is not the state machine', async () => {
    const h = harness();
    const job = seed(h, 'queued');
    vi.spyOn(h.jobs, 'applyTransition').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    expect(await expectError(await post(h.app, job.id, 'hold'), 500)).toBe('Internal server error');
  });

  describe('telling the others', () => {
    it('publishes the job once, and before the worker is told', async () => {
      const h = harness({ worker: ({ log }) => fakeWorker(log) });
      const job = seed(h, 'held');
      h.clock.tick(SETTLE_MS * 2);

      await post(h.app, job.id, 'release');

      expect(h.log).toEqual(['changed:queued', 'notify']);
      expect(h.changed.map((changed) => changed.id)).toEqual([job.id]);
    });

    it('wakes the worker after start, release, retry and resume when the job is queued', async () => {
      const h = harness({ worker: ({ log }) => fakeWorker(log) });
      const worker = h.worker as FakeWorker;
      const arriving = seed(h, 'arriving', 'Arriving one');
      const held = seed(h, 'held', 'Held one');
      const failed = seed(h, 'failed', 'Failed one');
      const cancelled = seed(h, 'cancelled', 'Cancelled one');
      await post(h.app, arriving.id, 'start');
      expect(worker.notified).toBe(1);
      h.clock.tick(SETTLE_MS * 2);

      await post(h.app, held.id, 'release');
      expect(worker.notified).toBe(2);
      await post(h.app, failed.id, 'retry');
      expect(worker.notified).toBe(3);
      await post(h.app, cancelled.id, 'resume');
      expect(worker.notified).toBe(4);
    });

    it('wakes the worker once after send-notes and once after approve', async () => {
      const h = harness({ worker: ({ log }) => fakeWorker(log) });
      const worker = h.worker as FakeWorker;
      const notes = seed(h, 'review', 'Notes one');
      const approved = seed(h, 'review', 'Approved one');

      await post(h.app, notes.id, 'send-notes');
      expect(worker.notified).toBe(1);
      await post(h.app, approved.id, 'approve');
      expect(worker.notified).toBe(2);
    });

    it('does not wake the worker for hold, or when the job did not become queued', async () => {
      const h = harness({ worker: ({ log }) => fakeWorker(log) });
      const worker = h.worker as FakeWorker;
      const queued = seed(h, 'queued', 'Queued one');
      const heldRecently = seed(h, 'held', 'Held one');
      const ready = seed(h, 'ready', 'Ready one');

      await post(h.app, queued.id, 'hold');
      await post(h.app, heldRecently.id, 'release'); // files changed just now: arriving
      await post(h.app, ready.id, 'retry'); // 409
      await post(h.app, 'nosuchjob00', 'resume'); // 404

      expect(worker.notified).toBe(0);
    });

    it('survives a listener that throws', async () => {
      const jobs = new JobRepository(memoryDb(), { clock: fakeClock() });
      const app = createApp({
        jobs: {
          jobs,
          exportsDir: NO_OUTPUT_DIR,
          onJobChanged: () => {
            throw new Error('listener bug');
          },
        },
      });
      const { job } = jobs.upsertFromScan(makeScan());

      const res = await post(app, job.id, 'hold');

      expect(res.status).toBe(200);
      expect(jobs.get(job.id)?.state).toBe('held');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id }),
        'onJobChanged listener threw',
      );
    });
  });

  describe('cancel', () => {
    it('asks the worker to stop the run and answers with the job it returns', async () => {
      const h = harnessCancellingLikeTheWorker();
      const job = seed(h, 'editing');

      const res = await post(h.app, job.id, 'cancel');

      expect(res.status).toBe(200);
      expect(jobActionResponseSchema.parse(await res.json()).state).toBe('cancelled');
      expect(h.worker.cancelled).toEqual([job.id]);
      expect(h.jobs.get(job.id)?.state).toBe('cancelled');
      expect(h.changed.map((changed) => changed.state)).toEqual(['cancelled']);
      expect(h.worker.notified).toBe(0);
    });

    it('does not answer before the worker has finished stopping the run', async () => {
      let stopped = false;
      const h = harness({
        worker: ({ jobs, log }) =>
          fakeWorker(log, async (id) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            stopped = true;
            return jobs.applyTransition(id, { type: 'CANCEL' });
          }),
      });
      const job = seed(h, 'editing');

      const res = await post(h.app, job.id, 'cancel');

      expect(stopped).toBe(true);
      expect(res.status).toBe(200);
    });

    it('applies CANCEL itself when the worker has nothing to stop', async () => {
      const h = harness({ worker: ({ log }) => fakeWorker(log) }); // cancel answers null
      const job = seed(h, 'editing');

      const res = await post(h.app, job.id, 'cancel');

      expect((h.worker as FakeWorker).cancelled).toEqual([job.id]);
      expect(res.status).toBe(200);
      expect(jobActionResponseSchema.parse(await res.json()).state).toBe('cancelled');
    });

    it('applies CANCEL itself when there is no worker (edits paused)', async () => {
      const h = harness();
      const job = seed(h, 'editing');

      const res = await post(h.app, job.id, 'cancel');

      expect(res.status).toBe(200);
      expect(jobActionResponseSchema.parse(await res.json()).state).toBe('cancelled');
    });

    it('answers 409 when the run ended on its own before it could be cancelled', async () => {
      const h = harness({
        worker: ({ jobs, log }) =>
          fakeWorker(log, async (id) =>
            jobs.applyTransition(id, { type: 'FAIL', step: 5, error: 'ran out of luck' }),
          ),
      });
      const job = seed(h, 'editing');

      const error = await expectError(await post(h.app, job.id, 'cancel'), 409);

      expect(error).toBe('Cannot cancel this job: it is failed.');
      expect(h.changed).toEqual([]);
    });
  });

  describe('with the real queue worker', () => {
    function realWorker(jobs: JobRepository, runner: Runner): QueueWorker {
      return new QueueWorker({
        jobs,
        stepRuns: new StepRunRepository(memoryDb()),
        runner,
        finalize: async () => {
          throw new Error('no export in these tests');
        },
      });
    }

    it('cancel stops the runner before the response, and the job is cancelled', async () => {
      const aborted: string[] = [];
      const runner: Runner = {
        start: (job, _mode, { signal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted.push(job.id);
              resolve({ ok: false, error: 'killed' });
            });
          }),
      };
      let worker!: QueueWorker;
      const h = harness({ worker: ({ jobs }) => (worker = realWorker(jobs, runner)) });
      const job = seed(h, 'queued');
      worker.start();
      expect(h.jobs.get(job.id)?.state).toBe('editing');
      expect(worker.activeJobId).toBe(job.id);

      const res = await post(h.app, job.id, 'cancel');

      expect(res.status).toBe(200);
      expect(jobActionResponseSchema.parse(await res.json()).state).toBe('cancelled');
      expect(aborted).toEqual([job.id]);
      expect(worker.activeJobId).toBeNull();
      expect(h.jobs.get(job.id)?.state).toBe('cancelled');
      await worker.stop();
    });

    it('start wakes the worker, which starts the job without waiting for the settle delay', async () => {
      const started: string[] = [];
      const runner: Runner = {
        start: (job, _mode, { signal }) => {
          started.push(job.id);
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped' }));
          });
        },
      };
      let worker!: QueueWorker;
      const h = harness({ worker: ({ jobs }) => (worker = realWorker(jobs, runner)) });
      const job = seed(h, 'arriving');
      worker.start();
      expect(started).toEqual([]);

      const res = await post(h.app, job.id, 'start');

      expect(jobActionResponseSchema.parse(await res.json()).state).toBe('queued');
      expect(started).toEqual([job.id]);
      expect(h.jobs.get(job.id)?.state).toBe('editing');
      await worker.stop();
    });

    it('release wakes the worker, which starts the job', async () => {
      const started: string[] = [];
      const runner: Runner = {
        start: (job, _mode, { signal }) => {
          started.push(job.id);
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ ok: false, error: 'stopped' }));
          });
        },
      };
      let worker!: QueueWorker;
      const h = harness({ worker: ({ jobs }) => (worker = realWorker(jobs, runner)) });
      const job = seed(h, 'held');
      h.clock.tick(SETTLE_MS * 2);
      worker.start();
      expect(started).toEqual([]);

      const res = await post(h.app, job.id, 'release');

      // The answer is the job as the action left it; the worker takes it from there.
      expect(jobActionResponseSchema.parse(await res.json()).state).toBe('queued');
      expect(started).toEqual([job.id]);
      expect(h.jobs.get(job.id)?.state).toBe('editing');
      await worker.stop();
    });
  });
});

async function putNote(app: Hono, id: string, body: unknown): Promise<Response> {
  return app.request(`/api/jobs/${id}/note`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('PUT /api/jobs/:id/note', () => {
  const EDITABLE: Job['state'][] = ['arriving', 'queued', 'held', 'failed', 'cancelled'];

  it.each(EDITABLE)('saves the note of a %s job and answers with the job', async (state) => {
    const h = harness();
    const job = seed(h, state);
    h.clock.tick(5_000);

    const res = await putNote(h.app, job.id, { note: 'Keep it under 30 seconds.' });

    expect(res.status).toBe(200);
    const body = jobSchema.parse(await res.json());
    expect(body).toEqual({
      ...job,
      note: 'Keep it under 30 seconds.',
      updatedAt: h.clock().toISOString(),
    });
    expect(h.jobs.get(job.id)).toEqual(body);
  });

  it('trims the note', async () => {
    const h = harness();
    const job = seed(h, 'queued');

    const body = jobSchema.parse(
      await (await putNote(h.app, job.id, { note: '  \n Use the second take.  \n' })).json(),
    );

    expect(body.note).toBe('Use the second take.');
  });

  it('keeps Hebrew and line breaks inside the note', async () => {
    const h = harness();
    const job = seed(h, 'held');
    const note = 'תשאיר את זה מתחת ל-30 שניות.\nUse the second take – הטייק השני';

    const body = jobSchema.parse(await (await putNote(h.app, job.id, { note })).json());

    expect(body.note).toBe(note);
  });

  it.each(['', '   ', '\n\t '])('clears the note when it is %j', async (empty) => {
    const h = harness();
    const job = seed(h, 'queued');
    await putNote(h.app, job.id, { note: 'Something' });
    h.clock.tick();

    const res = await putNote(h.app, job.id, { note: empty });

    expect(res.status).toBe(200);
    expect(jobSchema.parse(await res.json()).note).toBeNull();
    expect(h.jobs.get(job.id)?.note).toBeNull();
  });

  it('shows the note in the job list', async () => {
    const h = harness();
    const noted = seed(h, 'queued', 'With note');
    const plain = seed(h, 'queued', 'Without note');
    await putNote(h.app, noted.id, { note: 'Keep it short' });

    const list = jobListResponseSchema.parse(await (await h.app.request('/api/jobs')).json());

    expect(list.find((job) => job.id === noted.id)?.note).toBe('Keep it short');
    expect(list.find((job) => job.id === plain.id)?.note).toBeNull();
  });

  it('does not change the state, the settle timer or the place in line', async () => {
    const h = harness();
    seed(h, 'queued', 'Ahead');
    const arriving = seed(h, 'arriving', 'Arriving');
    const queued = seed(h, 'queued', 'Behind');

    const a = jobSchema.parse(await (await putNote(h.app, arriving.id, { note: 'x' })).json());
    const q = jobSchema.parse(await (await putNote(h.app, queued.id, { note: 'x' })).json());

    expect(a).toMatchObject({ state: 'arriving', settlesAt: arriving.settlesAt, settledAt: null });
    expect(q).toMatchObject({ state: 'queued', placeInLine: 2, settledAt: queued.settledAt });
  });

  it.each(JOB_STATES.filter((state) => !EDITABLE.includes(state)))(
    'answers 409 "Cannot edit the note of a job that is %s." and changes nothing',
    async (state) => {
      const h = harness({ worker: ({ log }) => fakeWorker(log) });
      const job = seed(h, state);
      h.changed.length = 0;

      const error = await expectError(await putNote(h.app, job.id, { note: 'Too late' }), 409);

      expect(error).toBe(`Cannot edit the note of a job that is ${state}.`);
      expect(h.jobs.get(job.id)).toEqual(job);
      expect(h.changed).toEqual([]);
    },
  );

  it('answers 404 for an unknown job', async () => {
    const { app } = harness();

    const error = await expectError(await putNote(app, 'nosuchjob00', { note: 'x' }), 404);

    expect(error).toContain('nosuchjob00');
  });

  it('accepts exactly 4000 characters', async () => {
    const h = harness();
    const job = seed(h, 'queued');
    expect(NOTE_MAX_LENGTH).toBe(4000);

    const res = await putNote(h.app, job.id, { note: 'x'.repeat(4000) });

    expect(res.status).toBe(200);
    expect(jobSchema.parse(await res.json()).note).toHaveLength(4000);
  });

  it('answers 400 for a note of 4001 characters, and changes nothing', async () => {
    const h = harness();
    const job = seed(h, 'queued');
    h.changed.length = 0;

    const error = await expectError(await putNote(h.app, job.id, { note: 'x'.repeat(4001) }), 400);

    expect(error).toBe('The note can be at most 4000 characters.');
    expect(h.jobs.get(job.id)).toEqual(job);
    expect(h.changed).toEqual([]);
  });

  it.each([
    ['no body', ''],
    ['text that is not JSON', 'Keep it short'],
    ['an empty object', {}],
    ['a null note', { note: null }],
    ['a numeric note', { note: 5 }],
    ['the wrong key', { text: 'Keep it short' }],
    ['a bare string', JSON.stringify('Keep it short')],
    ['a list', ['Keep it short']],
  ])('answers 400 for %s, and changes nothing', async (_label, body) => {
    const h = harness();
    const job = seed(h, 'queued');
    h.changed.length = 0;

    const error = await expectError(await putNote(h.app, job.id, body), 400);

    expect(error).toBe('Send the note as JSON: { "note": "text" }.');
    expect(h.jobs.get(job.id)).toEqual(job);
    expect(h.changed).toEqual([]);
  });

  it('publishes the job once, without waking the worker', async () => {
    const h = harness({ worker: ({ log }) => fakeWorker(log) });
    const job = seed(h, 'queued');

    await putNote(h.app, job.id, { note: 'Keep it short' });

    expect(h.log).toEqual(['changed:queued']);
    expect(h.changed).toHaveLength(1);
    expect(h.changed[0]).toMatchObject({ id: job.id, note: 'Keep it short' });
    expect((h.worker as FakeWorker).notified).toBe(0);
  });

  it('survives a listener that throws', async () => {
    const jobs = new JobRepository(memoryDb(), { clock: fakeClock() });
    const app = createApp({
      jobs: {
        jobs,
        exportsDir: NO_OUTPUT_DIR,
        onJobChanged: () => {
          throw new Error('listener bug');
        },
      },
    });
    const { job } = jobs.upsertFromScan(makeScan());

    const res = await putNote(app, job.id, { note: 'Keep it short' });

    expect(res.status).toBe(200);
    expect(jobs.get(job.id)?.note).toBe('Keep it short');
  });

  it('answers 500 with { error } for a failure that is not about the note', async () => {
    const h = harness();
    const job = seed(h, 'queued');
    vi.spyOn(h.jobs, 'setNote').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    expect(await expectError(await putNote(h.app, job.id, { note: 'x' }), 500)).toBe(
      'Internal server error',
    );
  });

  it('only answers PUT: the other methods get the ordinary JSON 404', async () => {
    const h = harness();
    const job = seed(h, 'queued');

    expect(await expectError(await h.app.request(`/api/jobs/${job.id}/note`), 404)).toBe(
      'Not found',
    );
    expect(
      await expectError(await h.app.request(`/api/jobs/${job.id}/note`, { method: 'POST' }), 404),
    ).toBe('Not found');
  });
});

describe('GET /api/jobs/:id/download', () => {
  const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  let exportsDir: string;
  let outsideDir: string;

  /** Writes `bytes` at `<exports>/<fileName>`, creating the client folder. */
  function put(fileName: string, bytes: Buffer = BYTES): void {
    const path = join(exportsDir, fileName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  /** A `ready` job whose export is `fileName`. */
  function readyJob(
    h: Pick<Harness, 'jobs' | 'clock'>,
    { client, name, fileName }: { client: string; name: string; fileName: string },
  ): Job {
    const { job } = h.jobs.upsertFromScan(makeScan(client, name));
    for (const event of events(
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'SUCCEED', output: { ...OUTPUT, fileName } },
    )) {
      h.clock.tick();
      h.jobs.applyTransition(job.id, event);
    }
    return h.jobs.get(job.id) as Job;
  }

  function get(app: Hono, id: string, headers: Record<string, string> = {}, method = 'GET') {
    return app.request(`/api/jobs/${id}/download`, { method, headers });
  }

  async function bytesOf(res: Response): Promise<Buffer> {
    return Buffer.from(await res.arrayBuffer());
  }

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'studio-download-'));
    exportsDir = join(base, 'exports');
    outsideDir = join(base, 'outside');
    mkdirSync(exportsDir);
    mkdirSync(outsideDir);
  });

  afterAll(() => {
    rmSync(dirname(exportsDir), { recursive: true, force: true });
  });

  it('streams the whole export as an attachment', async () => {
    put('Northwind Bakery/Spring menu.mp4');
    const h = harness({ exportsDir });
    const job = readyJob(h, {
      client: 'Northwind Bakery',
      name: 'Spring menu',
      fileName: 'Northwind Bakery/Spring menu.mp4',
    });

    const res = await get(h.app, job.id);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Spring menu.mp4"; filename*=UTF-8''Spring%20menu.mp4`,
    );
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(res.headers.get('last-modified')).toBeTruthy();
    expect((await bytesOf(res)).equals(BYTES)).toBe(true);
  });

  it('names a Hebrew job in UTF-8 and keeps the header plain ASCII', async () => {
    put('לקוח/תפריט אביב.mp4');
    const h = harness({ exportsDir });
    const job = readyJob(h, {
      client: 'לקוח',
      name: 'תפריט אביב',
      fileName: 'לקוח/תפריט אביב.mp4',
    });

    const res = await get(h.app, job.id);

    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toBe(
      `attachment; filename="export.mp4"; filename*=UTF-8''%D7%AA%D7%A4%D7%A8%D7%99%D7%98%20%D7%90%D7%91%D7%99%D7%91.mp4`,
    );
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    const encoded = /filename\*=UTF-8''(.+)$/.exec(disposition)?.[1] ?? '';
    expect(decodeURIComponent(encoded)).toBe('תפריט אביב.mp4');
    expect((await bytesOf(res)).equals(BYTES)).toBe(true);
  });

  describe('byte ranges', () => {
    let h: Harness;
    let id: string;

    beforeAll(() => {
      put('Ranges/Clip.mp4');
      h = harness({ exportsDir });
      id = readyJob(h, { client: 'Ranges', name: 'Clip', fileName: 'Ranges/Clip.mp4' }).id;
    });

    it('answers 206 with the first bytes', async () => {
      const res = await get(h.app, id, { Range: 'bytes=0-99' });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
      expect(res.headers.get('content-length')).toBe('100');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect((await bytesOf(res)).equals(BYTES.subarray(0, 100))).toBe(true);
    });

    it('answers a range from the middle to the end', async () => {
      const res = await get(h.app, id, { Range: 'bytes=900-' });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 900-999/1000');
      expect((await bytesOf(res)).equals(BYTES.subarray(900))).toBe(true);
    });

    it('answers the last bytes for a suffix range', async () => {
      const res = await get(h.app, id, { Range: 'bytes=-10' });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 990-999/1000');
      expect((await bytesOf(res)).equals(BYTES.subarray(990))).toBe(true);
    });

    it('cuts a range that runs past the end back to the end', async () => {
      const res = await get(h.app, id, { Range: 'bytes=995-5000' });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 995-999/1000');
      expect(res.headers.get('content-length')).toBe('5');
    });

    it('answers a single byte', async () => {
      const res = await get(h.app, id, { Range: 'bytes=7-7' });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-length')).toBe('1');
      expect((await bytesOf(res)).equals(BYTES.subarray(7, 8))).toBe(true);
    });

    it('answers 416 with the file size for a range past the end', async () => {
      const res = await get(h.app, id, { Range: 'bytes=1000-' });

      expect(await expectError(res, 416)).toBe('Range not satisfiable.');
      expect(res.headers.get('content-range')).toBe('bytes */1000');
    });

    it('answers 416 for a backwards or garbled range', async () => {
      for (const range of ['bytes=50-10', 'bytes=-0', 'bytes=abc']) {
        const res = await get(h.app, id, { Range: range });

        expect(res.status, range).toBe(416);
        expect(res.headers.get('content-range'), range).toBe('bytes */1000');
      }
    });

    it('sends the whole file for a unit it does not know or several ranges', async () => {
      for (const range of ['items=0-5', 'bytes=0-5,10-15']) {
        const res = await get(h.app, id, { Range: range });

        expect(res.status, range).toBe(200);
        expect(res.headers.get('content-length'), range).toBe('1000');
        expect((await bytesOf(res)).equals(BYTES), range).toBe(true);
      }
    });

    it('honours If-Range only while the file is the one the client started on', async () => {
      const first = await get(h.app, id);
      const etag = first.headers.get('etag') ?? '';
      const lastModified = first.headers.get('last-modified') ?? '';
      await first.arrayBuffer();

      const sameTag = await get(h.app, id, { Range: 'bytes=0-9', 'If-Range': etag });
      const sameDate = await get(h.app, id, { Range: 'bytes=0-9', 'If-Range': lastModified });
      const otherTag = await get(h.app, id, { Range: 'bytes=0-9', 'If-Range': '"stale"' });

      expect(sameTag.status).toBe(206);
      expect(sameDate.status).toBe(206);
      expect(otherTag.status).toBe(200);
      expect(otherTag.headers.get('content-length')).toBe('1000');
      await Promise.all([sameTag, sameDate, otherTag].map((res) => res.arrayBuffer()));
    });

    it('answers HEAD with the headers and no body', async () => {
      const res = await get(h.app, id, {}, 'HEAD');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe('1000');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('content-disposition')).toContain('attachment');
      expect(await res.text()).toBe('');
    });
  });

  it('serves an empty export with Content-Length 0', async () => {
    put('Empty/Nothing.mp4', Buffer.alloc(0));
    const h = harness({ exportsDir });
    const job = readyJob(h, { client: 'Empty', name: 'Nothing', fileName: 'Empty/Nothing.mp4' });

    const whole = await get(h.app, job.id);
    const ranged = await get(h.app, job.id, { Range: 'bytes=0-' });

    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe('0');
    expect((await bytesOf(whole)).length).toBe(0);
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('content-range')).toBe('bytes */0');
  });

  describe('404', () => {
    it('for an unknown job', async () => {
      const { app } = harness({ exportsDir });

      expect(await expectError(await get(app, 'nosuchjob00'), 404)).toContain('nosuchjob00');
    });

    it('for a job that is not ready, whatever file is lying around', async () => {
      put('Northwind Bakery/Spring menu.mp4');
      const h = harness({ exportsDir });
      for (const state of [
        'arriving',
        'queued',
        'held',
        'editing',
        'failed',
        'cancelled',
      ] as const) {
        const job = seed(h, state, `Job ${state}`);

        const error = await expectError(await get(h.app, job.id), 404);

        expect(error, state).toBe('This job has no export yet.');
      }
    });

    it('for a ready job whose file is gone', async () => {
      const h = harness({ exportsDir });
      const job = readyJob(h, { client: 'Gone', name: 'Missing', fileName: 'Gone/Missing.mp4' });

      expect(await expectError(await get(h.app, job.id), 404)).toBe('The export file is missing.');
    });

    it('for a ready job whose export is a folder', async () => {
      mkdirSync(join(exportsDir, 'Folder', 'Odd.mp4'), { recursive: true });
      const h = harness({ exportsDir });
      const job = readyJob(h, { client: 'Folder', name: 'Odd', fileName: 'Folder/Odd.mp4' });

      expect(await expectError(await get(h.app, job.id), 404)).toBe('The export file is missing.');
    });

    it('for an exports folder that does not exist', async () => {
      const h = harness({ exportsDir: join(exportsDir, 'nope') });
      const job = readyJob(h, { client: 'A', name: 'B', fileName: 'A/B.mp4' });

      expect(await expectError(await get(h.app, job.id), 404)).toBe('The export file is missing.');
    });
  });

  describe('files outside the exports folder', () => {
    beforeAll(() => {
      writeFileSync(join(outsideDir, 'secret.mp4'), 'top secret');
      symlinkSync(outsideDir, join(exportsDir, 'Linked'));
    });

    it.each([
      ['a name that climbs out with ..', '../outside/secret.mp4'],
      ['a name that climbs out from inside a client folder', 'Client/../../outside/secret.mp4'],
      ['an absolute name', () => join(outsideDir, 'secret.mp4')],
      ['a symlink that points out', 'Linked/secret.mp4'],
    ])('are refused: %s', async (_label, fileName) => {
      const h = harness({ exportsDir });
      const name = typeof fileName === 'function' ? fileName() : fileName;
      const job = readyJob(h, { client: 'Evil', name: 'Escape', fileName: name });

      const res = await get(h.app, job.id);

      expect(await expectError(res, 404)).toBe('The export file is missing.');
    });
  });
});

async function postReviewTime(
  app: Hono,
  id: string,
  body: unknown,
  contentType = 'application/json',
): Promise<Response> {
  return app.request(`/api/jobs/${id}/review-time`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/jobs/:id/review-time', () => {
  it('adds the seconds to a job in review and answers with the new total', async () => {
    const h = harness();
    const job = seed(h, 'review');

    const res = await postReviewTime(h.app, job.id, { sec: 15 });

    expect(res.status).toBe(200);
    expect(reviewTimeResponseSchema.parse(await res.json())).toEqual({ reviewSec: 15 });
    expect(h.jobs.getMeta(job.id)?.reviewSec).toBe(15);
  });

  it('adds up the seconds of many requests', async () => {
    const h = harness();
    const job = seed(h, 'review');

    const totals: number[] = [];
    for (const sec of [15, 15, 1, REVIEW_TIME_MAX_SEC, 7]) {
      const body = reviewTimeResponseSchema.parse(
        await (await postReviewTime(h.app, job.id, { sec })).json(),
      );
      totals.push(body.reviewSec);
    }

    expect(totals).toEqual([15, 30, 31, 91, 98]);
    expect(h.jobs.getMeta(job.id)?.reviewSec).toBe(98);
  });

  it('counts each job on its own', async () => {
    const h = harness();
    const first = seed(h, 'review', 'First');
    const second = seed(h, 'review', 'Second');

    await postReviewTime(h.app, first.id, { sec: 10 });
    await postReviewTime(h.app, second.id, { sec: 25 });
    await postReviewTime(h.app, first.id, { sec: 5 });

    expect(h.jobs.getMeta(first.id)?.reviewSec).toBe(15);
    expect(h.jobs.getMeta(second.id)?.reviewSec).toBe(25);
  });

  it('tells onReviewTime after each successful add, once per request', async () => {
    const h = harness();
    const job = seed(h, 'review');

    await postReviewTime(h.app, job.id, { sec: 15 });
    await postReviewTime(h.app, job.id, { sec: 15 });

    expect(h.reviewTimes.count).toBe(2);
  });

  it('does not tell onReviewTime when nothing was added', async () => {
    const h = harness();
    const review = seed(h, 'review', 'In review');
    const ready = seed(h, 'ready', 'Ready');

    await postReviewTime(h.app, 'nope', { sec: 15 }); // 404
    await postReviewTime(h.app, ready.id, { sec: 15 }); // 409
    await postReviewTime(h.app, review.id, { sec: 0 }); // 400
    await postReviewTime(h.app, review.id, 'not json'); // 400

    expect(h.reviewTimes.count).toBe(0);
  });

  it('still answers 200 and keeps the seconds when onReviewTime throws', async () => {
    const jobs = new JobRepository(memoryDb(), { clock: fakeClock() });
    const app = createApp({
      jobs: {
        jobs,
        exportsDir: NO_OUTPUT_DIR,
        onReviewTime: () => {
          throw new Error('listener broke');
        },
      },
    });
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
    for (const event of [
      { type: 'SETTLED' },
      { type: 'START' },
      { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
    ] as const) {
      jobs.applyTransition(job.id, event);
    }

    const res = await postReviewTime(app, job.id, { sec: 15 });

    expect(res.status).toBe(200);
    expect(reviewTimeResponseSchema.parse(await res.json())).toEqual({ reviewSec: 15 });
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error), jobId: job.id },
      'onReviewTime listener threw',
    );
  });

  it('reads the body as JSON whatever its content type, as the beacon sent at page close needs', async () => {
    const h = harness();
    const job = seed(h, 'review');

    const res = await postReviewTime(h.app, job.id, { sec: 12 }, 'text/plain;charset=UTF-8');

    expect(res.status).toBe(200);
    expect(h.jobs.getMeta(job.id)?.reviewSec).toBe(12);
  });

  it('changes nothing the page shows and publishes nothing', async () => {
    const h = harness();
    const job = seed(h, 'review');
    const before = h.jobs.get(job.id);
    h.changed.length = 0;
    h.clock.tick(30_000);

    await postReviewTime(h.app, job.id, { sec: 15 });

    expect(h.jobs.get(job.id)).toEqual(before);
    expect(h.changed).toEqual([]);
  });

  it('keeps counting after a round of notes, when the job is in review again', async () => {
    const h = harness();
    const job = seed(h, 'review');
    await postReviewTime(h.app, job.id, { sec: 20 });
    h.clock.tick();
    h.jobs.applyTransition(job.id, { type: 'SEND_NOTES' });
    h.clock.tick();
    h.jobs.applyTransition(job.id, { type: 'START' });
    h.clock.tick();
    h.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });

    const res = await postReviewTime(h.app, job.id, { sec: 5 });

    expect(reviewTimeResponseSchema.parse(await res.json())).toEqual({ reviewSec: 25 });
  });

  describe('409', () => {
    const NOT_IN_REVIEW = JOB_STATES.filter((state) => state !== 'review');

    it.each(NOT_IN_REVIEW)(
      'answers 409 for a job that is %s, and counts nothing',
      async (state) => {
        const h = harness();
        const job = seed(h, state);

        const res = await postReviewTime(h.app, job.id, { sec: 15 });

        expect(await expectError(res, 409)).toBe(
          `Review time can only be counted while the job is in Review, and this job is ${state}.`,
        );
        expect(h.jobs.getMeta(job.id)?.reviewSec).toBe(0);
      },
    );

    it('answers 409 before it looks at the body', async () => {
      const h = harness();
      const job = seed(h, 'ready');

      const res = await postReviewTime(h.app, job.id, 'not json');

      expect(res.status).toBe(409);
    });

    it('stops counting once the job is approved', async () => {
      const h = harness();
      const job = seed(h, 'review');
      await postReviewTime(h.app, job.id, { sec: 15 });
      h.jobs.applyTransition(job.id, { type: 'APPROVE' });

      const res = await postReviewTime(h.app, job.id, { sec: 15 });

      expect(res.status).toBe(409);
      expect(h.jobs.getMeta(job.id)?.reviewSec).toBe(15);
    });
  });

  describe('404', () => {
    it('answers 404 for an unknown job', async () => {
      const h = harness();

      const res = await postReviewTime(h.app, 'nope', { sec: 15 });

      expect(await expectError(res, 404)).toBe('Job nope not found');
    });
  });

  describe('400', () => {
    const BAD_BODIES: [string, unknown][] = [
      ['zero seconds', { sec: 0 }],
      ['negative seconds', { sec: -5 }],
      ['more than a minute', { sec: REVIEW_TIME_MAX_SEC + 1 }],
      ['a fraction', { sec: 1.5 }],
      ['text', { sec: '15' }],
      ['null', { sec: null }],
      ['no sec', {}],
      ['another name', { seconds: 15 }],
      ['a bare number', '15'],
      ['a list', '[15]'],
      ['text that is not JSON', 'fifteen'],
      ['an empty body', ''],
    ];

    it.each(BAD_BODIES)('answers 400 for %s, and counts nothing', async (_name, body) => {
      const h = harness();
      const job = seed(h, 'review');

      const res = await postReviewTime(h.app, job.id, body);

      expect(await expectError(res, 400)).toBe(
        'Send the time as JSON: { "sec": 15 }, a whole number of seconds from 1 to 60.',
      );
      expect(h.jobs.getMeta(job.id)?.reviewSec).toBe(0);
    });
  });
});

async function putEffort(app: Hono, id: string, body: unknown): Promise<Response> {
  return app.request(`/api/jobs/${id}/effort`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// CVP-192: the effort level of a job's edit and revise runs, set from the row menu while it waits.
describe('PUT /api/jobs/:id/effort', () => {
  const EDITABLE: Job['state'][] = ['arriving', 'queued', 'held', 'review', 'failed', 'cancelled'];

  it.each(EDITABLE)('saves the effort of a %s job and answers with the job', async (state) => {
    const h = harness();
    const job = seed(h, state);
    h.clock.tick(5_000);

    const res = await putEffort(h.app, job.id, { effort: 'xhigh' });

    expect(res.status).toBe(200);
    const body = jobSchema.parse(await res.json());
    expect(body).toEqual({ ...job, effort: 'xhigh', updatedAt: h.clock().toISOString() });
    expect(h.jobs.get(job.id)).toEqual(body);
  });

  it.each(['medium', 'high', 'xhigh'])('accepts %s', async (effort) => {
    const h = harness();
    const job = seed(h, 'queued');
    const body = jobSchema.parse(await (await putEffort(h.app, job.id, { effort })).json());
    expect(body.effort).toBe(effort);
  });

  it('null puts the job back on Default', async () => {
    const h = harness();
    const job = seed(h, 'queued');
    await putEffort(h.app, job.id, { effort: 'high' });
    h.clock.tick();

    const res = await putEffort(h.app, job.id, { effort: null });

    expect(res.status).toBe(200);
    expect(jobSchema.parse(await res.json()).effort).toBeNull();
    expect(h.jobs.get(job.id)?.effort).toBeNull();
  });

  it('shows the effort in the job list and publishes the change', async () => {
    const h = harness();
    const set = seed(h, 'queued', 'With effort');
    const plain = seed(h, 'queued', 'Without effort');
    h.changed.length = 0;
    await putEffort(h.app, set.id, { effort: 'xhigh' });

    const list = jobListResponseSchema.parse(await (await h.app.request('/api/jobs')).json());

    expect(list.find((job) => job.id === set.id)?.effort).toBe('xhigh');
    expect(list.find((job) => job.id === plain.id)?.effort).toBeNull();
    expect(h.changed.map((job) => [job.id, job.effort])).toEqual([[set.id, 'xhigh']]);
  });

  it('does not change the state, the settle timer or the place in line, and does not wake the worker', async () => {
    const h = harness({ worker: ({ log }) => fakeWorker(log) });
    seed(h, 'queued', 'Ahead');
    const arriving = seed(h, 'arriving', 'Arriving');
    const queued = seed(h, 'queued', 'Behind');
    h.log.length = 0;

    const a = jobSchema.parse(
      await (await putEffort(h.app, arriving.id, { effort: 'medium' })).json(),
    );
    const q = jobSchema.parse(
      await (await putEffort(h.app, queued.id, { effort: 'medium' })).json(),
    );

    expect(a).toMatchObject({ state: 'arriving', settlesAt: arriving.settlesAt, settledAt: null });
    expect(q).toMatchObject({ state: 'queued', placeInLine: 2, settledAt: queued.settledAt });
    expect(h.log).not.toContain('notify');
  });

  it.each(JOB_STATES.filter((state) => !EDITABLE.includes(state)))(
    'answers 409 "Cannot change the effort of a job that is %s." and changes nothing',
    async (state) => {
      const h = harness({ worker: ({ log }) => fakeWorker(log) });
      const job = seed(h, state);
      h.changed.length = 0;

      const error = await expectError(await putEffort(h.app, job.id, { effort: 'xhigh' }), 409);

      expect(error).toBe(`Cannot change the effort of a job that is ${state}.`);
      expect(h.jobs.get(job.id)).toEqual(job);
      expect(h.changed).toEqual([]);
    },
  );

  it('answers 404 for an unknown job', async () => {
    const { app } = harness();

    const error = await expectError(await putEffort(app, 'nosuchjob00', { effort: 'medium' }), 404);

    expect(error).toContain('nosuchjob00');
  });

  describe('400', () => {
    const BAD_BODIES: [string, unknown][] = [
      ['a level that does not exist', { effort: 'ultra' }],
      ['Low, which is not offered', { effort: 'low' }],
      ['Max, which is not offered', { effort: 'max' }],
      ['"default" (use null)', { effort: 'default' }],
      ['a capital letter', { effort: 'Max' }],
      ['a number', { effort: 3 }],
      ['no effort', {}],
      ['another name', { level: 'max' }],
      ['a bare string', '"max"'],
      ['a list', '["max"]'],
      ['text that is not JSON', 'max'],
      ['an empty body', ''],
    ];

    it.each(BAD_BODIES)('answers 400 for %s, and changes nothing', async (_name, body) => {
      const h = harness();
      const job = seed(h, 'queued');

      const res = await putEffort(h.app, job.id, body);

      expect(await expectError(res, 400)).toBe(
        'Send the effort as JSON: { "effort": "medium" | "high" | "xhigh" | null }.',
      );
      expect(h.jobs.get(job.id)).toEqual(job);
    });
  });
});
