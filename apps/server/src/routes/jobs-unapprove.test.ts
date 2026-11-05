import {
  apiErrorSchema,
  JOB_STATES,
  type Job,
  type JobEvent,
  jobActionResponseSchema,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createRecordDelivery } from '../deliveries/deliveries.js';
import type { ActionWorker } from './jobs.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// POST /api/jobs/:id/unapprove: an approved video goes back to Review. The real repositories on an
// in-memory database and the real routes, `app.request` for the HTTP.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const OUTPUT = {
  fileName: 'Northwind Bakery/Spring menu.mp4',
  durationSec: 30,
  width: 1080,
  height: 1920,
  sizeBytes: 1,
};

const TO_REVIEW: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
];

function setup(options: { review?: boolean } = {}) {
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  // Review on, as the engine runs: only a render run may SUCCEED.
  const jobs = new JobRepository(db, { clock, review: options.review ?? true });
  const deliveries = new DeliveryRepository(db);
  const recordDelivery = createRecordDelivery({
    deliveries,
    jobs,
    priceFor: () => ({ price: 40, currency: 'ILS' }),
    clock,
  });
  const changed: Job[] = [];
  const woken = { count: 0 };
  const worker: ActionWorker = {
    cancel: async () => null,
    notify: () => {
      woken.count += 1;
    },
  };
  const app = createApp({
    jobs: {
      jobs,
      worker,
      exportsDir: '/nonexistent/exports',
      onJobChanged: (job) => changed.push(job),
    },
  });

  function walk(id: string, events: JobEvent[]): Job {
    let current = jobs.get(id) as Job;
    for (const event of events) {
      clock.tick();
      current = jobs.applyTransition(id, event);
    }
    return current;
  }

  /** A video that went through Review, Approve and the render: ready, approved, not delivered. */
  function approved(name = 'Spring menu', rounds = 0): Job {
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', name));
    walk(job.id, TO_REVIEW);
    for (let round = 1; round <= rounds; round += 1) {
      walk(job.id, [
        { type: 'SEND_NOTES' },
        { type: 'START' },
        { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
      ]);
    }
    return walk(job.id, [
      { type: 'APPROVE' },
      { type: 'START' },
      { type: 'SUCCEED', output: { ...OUTPUT, fileName: `Northwind Bakery/${name}.mp4` } },
    ]);
  }

  const post = (id: string) => app.request(`/api/jobs/${id}/unapprove`, { method: 'POST' });
  return { app, clock, jobs, deliveries, recordDelivery, changed, woken, walk, approved, post };
}

async function errorOf(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  return apiErrorSchema.parse(await res.json()).error;
}

describe('POST /api/jobs/:id/unapprove', () => {
  it('puts an approved video back in Review, keeping its composition and clearing its export', async () => {
    const h = setup();
    const job = h.approved();
    expect(job).toMatchObject({ state: 'ready', runKind: 'render' });
    expect(job.approvedAt).not.toBeNull();
    h.clock.tick(5_000);

    const res = await h.post(job.id);

    expect(res.status).toBe(200);
    const body = jobActionResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      state: 'review',
      step: 7,
      runKind: 'edit',
      round: 0,
      preview: SAMPLE_PREVIEW,
      output: null,
      approvedAt: null,
      placeInLine: null,
      updatedAt: h.clock().toISOString(),
    });
    expect(h.jobs.get(job.id)).toEqual(body);
  });

  it('puts the run kind back to revise for a video that had a round of notes', async () => {
    const h = setup();
    const job = h.approved('Two rounds', 2);

    const body = jobActionResponseSchema.parse(await (await h.post(job.id)).json());

    expect(body).toMatchObject({ state: 'review', runKind: 'revise', round: 2 });
  });

  it('tells the page the job changed, and does not wake the worker: nothing is queued', async () => {
    const h = setup();
    const job = h.approved();
    h.changed.length = 0;

    await h.post(job.id);

    expect(h.changed.map((changed) => changed.state)).toEqual(['review']);
    expect(h.woken.count).toBe(0);
  });

  it('can be approved again afterwards: Approve queues the render run', async () => {
    const h = setup();
    const job = h.approved();
    await h.post(job.id);
    h.clock.tick(1_000);

    const res = await h.app.request(`/api/jobs/${job.id}/approve`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(jobActionResponseSchema.parse(await res.json())).toMatchObject({
      state: 'queued',
      runKind: 'render',
    });
  });

  it('answers 409 for a delivered video and leaves it ready: Not delivered yet comes first', async () => {
    const h = setup();
    const job = h.approved();
    h.clock.tick();
    h.recordDelivery(job);

    const message = await errorOf(await h.post(job.id), 409);

    expect(message).toBe(
      'Cannot unapprove a video that was delivered. Mark it not delivered first.',
    );
    expect(h.jobs.get(job.id)).toMatchObject({ state: 'ready', approvedAt: job.approvedAt });
  });

  it('answers 409 for a paid video too', async () => {
    const h = setup();
    const job = h.approved();
    h.clock.tick();
    h.recordDelivery(job);
    h.deliveries.markPaid([job.id], '2026-10-22');

    await errorOf(await h.post(job.id), 409);

    expect(h.jobs.get(job.id)?.state).toBe('ready');
  });

  it('works again once the delivery was taken off', async () => {
    const h = setup();
    const job = h.approved();
    h.clock.tick();
    h.recordDelivery(job);
    h.deliveries.remove(job.id);

    const res = await h.post(job.id);

    expect(res.status).toBe(200);
    expect(jobActionResponseSchema.parse(await res.json()).state).toBe('review');
  });

  it('answers 409 for a ready video that was never approved (an edit that ended with Review off)', async () => {
    const h = setup({ review: false });
    const { job } = h.jobs.upsertFromScan(makeScan('Northwind Bakery', 'No review'));
    h.walk(job.id, [{ type: 'SETTLED' }, { type: 'START' }, { type: 'SUCCEED', output: OUTPUT }]);
    expect(h.jobs.get(job.id)).toMatchObject({ state: 'ready', approvedAt: null, preview: null });

    const message = await errorOf(await h.post(job.id), 409);

    expect(message).toBe('Cannot unapprove a job that is ready.');
    expect(h.jobs.get(job.id)?.state).toBe('ready');
  });

  it.each(JOB_STATES.filter((state) => state !== 'ready'))(
    'answers 409 for a job that is %s',
    async (state) => {
      const h = setup();
      const { job } = h.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Not ready'));
      const paths: Record<Job['state'], JobEvent[]> = {
        arriving: [],
        queued: [{ type: 'SETTLED' }],
        held: [{ type: 'HOLD' }],
        editing: [{ type: 'SETTLED' }, { type: 'START' }],
        review: TO_REVIEW,
        ready: [],
        failed: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'FAIL', step: 4, error: 'boom' }],
        cancelled: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }],
      };
      h.walk(job.id, paths[state]);

      const message = await errorOf(await h.post(job.id), 409);

      expect(message).toBe(`Cannot unapprove a job that is ${state}.`);
      expect(h.jobs.get(job.id)?.state).toBe(state);
    },
  );

  it('answers 404 for a job that does not exist', async () => {
    const h = setup();

    await errorOf(await h.post('nope'), 404);
  });
});
