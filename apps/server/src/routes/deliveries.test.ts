import {
  apiErrorSchema,
  JOB_STATES,
  type Job,
  type JobEvent,
  jobSchema,
  jobStage,
  type OrphanDelivery,
  orphanDeliveriesResponseSchema,
  PAYMENT_JOBS_MAX,
  paymentRefusedResponseSchema,
  paymentResponseSchema,
  undeliverRefusedResponseSchema,
  undeliverResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { createRecordDelivery, type PriceFor } from '../deliveries/deliveries.js';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The real repositories on an in-memory database and the real routes, `app.request` for the HTTP.
// The delivery is written by the real `createRecordDelivery`, with a price the test sets.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  vi.clearAllMocks();
});

const OUTPUT = { fileName: 'x.mp4', durationSec: 30, width: 1080, height: 1920, sizeBytes: 1 };

const PATH: Record<Job['state'], JobEvent[]> = {
  arriving: [],
  queued: [{ type: 'SETTLED' }],
  held: [{ type: 'HOLD' }],
  editing: [{ type: 'SETTLED' }, { type: 'START' }],
  review: [
    { type: 'SETTLED' },
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: { durationSec: 28.4, width: 1080, height: 1920 } },
  ],
  ready: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'SUCCEED', output: OUTPUT }],
  failed: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'FAIL', step: 4, error: 'boom' }],
  cancelled: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }],
};

function setup(options: { throwing?: boolean; moneyIsValid?: () => boolean } = {}) {
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const price = { value: 40 };
  const priceFor = vi.fn<PriceFor>(() => ({ price: price.value, currency: 'ILS' }));
  // What the engine hands the routes: the record without the Money page's event.
  const recordDelivery = createRecordDelivery({ deliveries, jobs, priceFor, clock });
  // The reels linked to jobs. Nothing writes `delivery.uploadedAt` yet (a linked reel does, once it
  // exists), so a test says which jobs a reel links and the routes read the job with it added.
  const reels = new Map<string, { uploadedAt: string; reelUrl: string }>();
  const jobsWithReels: Pick<JobRepository, 'get'> = {
    get(id) {
      const job = jobs.get(id);
      const reel = reels.get(id);
      return job === null || job.delivery === null || reel === undefined
        ? job
        : { ...job, delivery: { ...job.delivery, ...reel } };
    },
  };
  /** The events in the order they were sent: `job.upsert:<id>` and `money.changed`. */
  const events: string[] = [];
  const app = createApp({
    delivery: {
      jobs: jobsWithReels,
      deliveries,
      recordDelivery,
      moneyIsValid: options.moneyIsValid,
      onJobChanged: (job) => {
        events.push(`job.upsert:${job.id}`);
        if (options.throwing) throw new Error('listener broke');
      },
      onMoneyChanged: () => {
        events.push('money.changed');
        if (options.throwing) throw new Error('listener broke');
      },
    },
  });

  /** A job walked to `state` through real events. */
  function seed(state: Job['state'], name = 'Spring menu', client = 'Northwind Bakery'): Job {
    const { job } = jobs.upsertFromScan(makeScan(client, name));
    let current = job;
    for (const event of PATH[state]) {
      clock.tick();
      current = jobs.applyTransition(job.id, event);
    }
    return current;
  }

  /** A ready job that is delivered already (not through the route, so no events are logged). */
  function delivered(name = 'Spring menu', client = 'Northwind Bakery'): Job {
    const job = seed('ready', name, client);
    clock.tick();
    recordDelivery(job);
    return jobs.get(job.id) as Job;
  }

  /** A delivered job that is paid on `day` too. */
  function paid(name: string, day = '2026-10-20'): Job {
    const job = delivered(name);
    deliveries.markPaid([job.id], day);
    return jobs.get(job.id) as Job;
  }

  /** A delivered job a reel posted on 20 Oct is linked to (what IG4's link will do). */
  function uploaded(name = 'Spring menu'): Job {
    const job = delivered(name);
    reels.set(job.id, {
      uploadedAt: '2026-10-20T09:30:00.000Z',
      reelUrl: 'https://www.instagram.com/reel/C-spring/',
    });
    return jobsWithReels.get(job.id) as Job;
  }

  return {
    app,
    db,
    clock,
    jobs,
    deliveries,
    price,
    priceFor,
    events,
    seed,
    delivered,
    paid,
    uploaded,
    reels,
  };
}

type Setup = ReturnType<typeof setup>;

function post(app: Hono, path: string, body?: unknown): Promise<Response> | Response {
  return app.request(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function errorOf(res: Response | Promise<Response>, status: number): Promise<string> {
  const response = await res;
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await response.json()).error;
}

async function jobOf(res: Response | Promise<Response>): Promise<Job> {
  const response = await res;
  expect(response.status).toBe(200);
  return jobSchema.parse(await response.json());
}

async function jobsOf(res: Response | Promise<Response>): Promise<Job[]> {
  const response = await res;
  expect(response.status).toBe(200);
  return paymentResponseSchema.parse(await response.json()).jobs;
}

function upsert(...jobs: Pick<Job, 'id'>[]): string[] {
  return jobs.map((job) => `job.upsert:${job.id}`);
}

describe('POST /api/jobs/:id/deliver', () => {
  it('marks a ready job delivered, with the client’s price from now, and answers with the job', async () => {
    const t = setup();
    const job = t.seed('ready');
    t.clock.tick(3_600_000);

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/deliver`));

    expect(body).toEqual({
      ...job,
      delivery: {
        deliveredAt: t.clock().toISOString(),
        price: 40,
        currency: 'ILS',
        paidOn: null,
        paidAmount: null,
      },
    });
    expect(t.priceFor).toHaveBeenCalledWith('Northwind Bakery');
    expect(t.jobs.get(job.id)).toEqual(body);
  });

  it('keeps the job’s state and updatedAt: a delivery is not a change to the job row', async () => {
    const t = setup();
    const job = t.seed('ready');
    t.clock.tick(3_600_000);

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/deliver`));

    expect(body.state).toBe('ready');
    expect(body.updatedAt).toBe(job.updatedAt);
  });

  it('freezes the price it was delivered at', async () => {
    const t = setup();
    const job = t.seed('ready');
    await post(t.app, `/api/jobs/${job.id}/deliver`);

    t.price.value = 55;

    expect(t.jobs.get(job.id)?.delivery?.price).toBe(40);
  });

  it('copies the job’s review time into the delivery', async () => {
    const t = setup();
    const job = t.seed('review');
    t.jobs.addReviewSec(job.id, 45);
    t.jobs.applyTransition(job.id, { type: 'APPROVE' });
    t.jobs.applyTransition(job.id, { type: 'START' });
    t.jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });
    expect(t.jobs.get(job.id)?.state).toBe('ready');

    await post(t.app, `/api/jobs/${job.id}/deliver`);

    expect(t.deliveries.get(job.id)?.reviewSec).toBe(45);
  });

  it('tells the jobs once and the Money page once, the job first', async () => {
    const t = setup();
    const job = t.seed('ready');

    await post(t.app, `/api/jobs/${job.id}/deliver`);

    expect(t.events).toEqual([...upsert(job), 'money.changed']);
  });

  it('publishes the job as it is after the change, with its delivery', async () => {
    const t = setup();
    const job = t.seed('ready');
    const seen: Job[] = [];
    const app = createApp({
      delivery: {
        jobs: t.jobs,
        deliveries: t.deliveries,
        recordDelivery: createRecordDelivery({
          deliveries: t.deliveries,
          jobs: t.jobs,
          priceFor: t.priceFor,
        }),
        onJobChanged: (changed) => seen.push(changed),
      },
    });

    await post(app, `/api/jobs/${job.id}/deliver`);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.delivery).toMatchObject({ price: 40, paidOn: null });
  });

  it('works for a job with a Hebrew name', async () => {
    const t = setup();
    const job = t.seed('ready', 'חלות לשבת', 'מאפיית הצפון');

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/deliver`));

    expect(body.name).toBe('חלות לשבת');
    expect(t.deliveries.get(job.id)).toMatchObject({ client: 'מאפיית הצפון', name: 'חלות לשבת' });
  });

  it('delivers each job on its own', async () => {
    const t = setup();
    const first = t.seed('ready', 'One');
    const second = t.seed('ready', 'Two');

    await post(t.app, `/api/jobs/${first.id}/deliver`);

    expect(t.jobs.get(first.id)?.delivery).not.toBeNull();
    expect(t.jobs.get(second.id)?.delivery).toBeNull();
  });

  it('answers 404 for an unknown job and tells nobody', async () => {
    const t = setup();

    expect(await errorOf(post(t.app, '/api/jobs/nope/deliver'), 404)).toBe('Job nope not found');
    expect(t.events).toEqual([]);
    expect(t.deliveries.list()).toEqual([]);
  });

  it.each(JOB_STATES.filter((state) => state !== 'ready'))(
    'answers 409 for a job that is %s, and writes nothing',
    async (state) => {
      const t = setup();
      const job = t.seed(state);

      const error = await errorOf(post(t.app, `/api/jobs/${job.id}/deliver`), 409);

      expect(error).toBe(
        `Cannot mark a job delivered that is ${state}: only an approved video can be.`,
      );
      expect(t.deliveries.list()).toEqual([]);
      expect(t.priceFor).not.toHaveBeenCalled();
      expect(t.events).toEqual([]);
    },
  );

  it('answers 409 for a job that is delivered already, keeping its first time and price', async () => {
    const t = setup();
    const job = t.delivered();
    const row = t.deliveries.get(job.id);
    t.price.value = 99;
    t.clock.tick(86_400_000);

    const error = await errorOf(post(t.app, `/api/jobs/${job.id}/deliver`), 409);

    expect(error).toBe('This video is marked delivered already.');
    expect(t.deliveries.get(job.id)).toEqual(row);
    expect(t.events).toEqual([]);
  });

  it('answers 409 while money.json is invalid with no good version, and writes nothing', async () => {
    const valid = { value: false };
    const t = setup({ moneyIsValid: () => valid.value });
    const job = t.seed('ready');

    const error = await errorOf(post(t.app, `/api/jobs/${job.id}/deliver`), 409);

    expect(error).toBe('money.json is invalid – run pnpm run doctor');
    expect(t.priceFor).not.toHaveBeenCalled();
    expect(t.deliveries.list()).toEqual([]);
    expect(t.jobs.get(job.id)?.delivery).toBeNull();
    expect(t.events).toEqual([]);

    valid.value = true;
    expect((await jobOf(post(t.app, `/api/jobs/${job.id}/deliver`))).delivery?.price).toBe(40);
  });

  it('still takes a delivery back and pays it while money.json is invalid', async () => {
    const valid = { value: true };
    const t = setup({ moneyIsValid: () => valid.value });
    const first = t.delivered('One');
    const second = t.delivered('Two');
    valid.value = false;

    expect((await jobOf(post(t.app, `/api/jobs/${first.id}/undeliver`))).delivery).toBeNull();
    const paid = await jobsOf(
      post(t.app, '/api/payments', { jobIds: [second.id], paidOn: '2026-10-20' }),
    );
    expect(paid[0]?.delivery?.paidOn).toBe('2026-10-20');
  });

  it('answers 409 for a job that is paid', async () => {
    const t = setup();
    const job = t.paid('Spring menu');

    await errorOf(post(t.app, `/api/jobs/${job.id}/deliver`), 409);

    expect(t.deliveries.get(job.id)?.paidOn).toBe('2026-10-20');
  });

  it('answers 409 for a delivered job that left ready too: it keeps its delivery', async () => {
    const t = setup();
    const job = t.delivered();
    t.jobs.applyTransition(job.id, { type: 'EXPORT_MISSING' });
    expect(t.jobs.get(job.id)?.state).toBe('failed');

    await errorOf(post(t.app, `/api/jobs/${job.id}/deliver`), 409);
  });

  it('still answers 200 and keeps the delivery when a listener throws', async () => {
    const t = setup({ throwing: true });
    const job = t.seed('ready');

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/deliver`));

    expect(body.delivery).not.toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(t.events).toEqual([...upsert(job), 'money.changed']);
  });

  it('answers 500 with { error } when the price cannot be worked out, and writes nothing', async () => {
    const t = setup();
    const job = t.seed('ready');
    t.priceFor.mockImplementation(() => {
      throw new Error('no money file');
    });

    expect(await errorOf(post(t.app, `/api/jobs/${job.id}/deliver`), 500)).toBe(
      'Internal server error',
    );
    expect(t.deliveries.list()).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('only answers POST: other methods get the ordinary JSON 404', async () => {
    const t = setup();
    const job = t.seed('ready');

    const res = await t.app.request(`/api/jobs/${job.id}/deliver`);

    expect(await errorOf(res, 404)).toBe('Not found');
  });
});

describe('POST /api/jobs/:id/undeliver', () => {
  it('deletes the delivery and answers with the job, back to approved', async () => {
    const t = setup();
    const job = t.delivered();

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/undeliver`));

    expect(body).toEqual({ ...job, delivery: null });
    expect(t.deliveries.get(job.id)).toBeNull();
    expect(t.deliveries.list()).toEqual([]);
  });

  it('tells the jobs once and the Money page once, the job first', async () => {
    const t = setup();
    const job = t.delivered();

    await post(t.app, `/api/jobs/${job.id}/undeliver`);

    expect(t.events).toEqual([...upsert(job), 'money.changed']);
  });

  it('delivers again with the price of that moment', async () => {
    const t = setup();
    const job = t.delivered();
    await post(t.app, `/api/jobs/${job.id}/undeliver`);
    t.price.value = 60;

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/deliver`));

    expect(body.delivery?.price).toBe(60);
  });

  it('works for a delivered job that left ready, so its delivery can be taken back', async () => {
    const t = setup();
    const job = t.delivered();
    t.jobs.applyTransition(job.id, { type: 'EXPORT_MISSING' });

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/undeliver`));

    expect(body.state).toBe('failed');
    expect(body.delivery).toBeNull();
    expect(t.deliveries.get(job.id)).toBeNull();
  });

  it('answers 404 for an unknown job and tells nobody', async () => {
    const t = setup();

    expect(await errorOf(post(t.app, '/api/jobs/nope/undeliver'), 404)).toBe('Job nope not found');
    expect(t.events).toEqual([]);
  });

  it('answers 409 for a job that is not delivered, and tells nobody', async () => {
    const t = setup();
    const job = t.seed('ready');

    expect(await errorOf(post(t.app, `/api/jobs/${job.id}/undeliver`), 409)).toBe(
      'This video is not marked delivered.',
    );
    expect(t.events).toEqual([]);
  });

  it('answers 409 for a paid job, which stays delivered and paid', async () => {
    const t = setup();
    const job = t.paid('Spring menu', '2026-10-22');

    expect(await errorOf(post(t.app, `/api/jobs/${job.id}/undeliver`), 409)).toBe(
      'This video is marked paid: mark it not paid first.',
    );
    expect(t.deliveries.get(job.id)).toMatchObject({ paidOn: '2026-10-22' });
    expect(t.events).toEqual([]);
  });

  it('answers 409 with the reason uploaded while a reel is linked, and changes and tells nothing', async () => {
    const t = setup();
    const job = t.uploaded();

    const res = await post(t.app, `/api/jobs/${job.id}/undeliver`);

    expect(res.status).toBe(409);
    const body = undeliverRefusedResponseSchema.parse(await res.json());
    expect(body).toEqual({
      error: 'This video is on Instagram: unlink the reel on the client page first.',
      reason: 'uploaded',
    });
    expect(t.deliveries.get(job.id)).not.toBeNull();
    expect(t.events).toEqual([]);
  });

  it('delivers back to approved once the reel is unlinked', async () => {
    const t = setup();
    const job = t.uploaded();
    t.reels.delete(job.id);

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/undeliver`));

    expect(body.delivery).toBeNull();
  });

  it('says the job is paid first when it is paid and uploaded', async () => {
    const t = setup();
    const job = t.uploaded();
    t.deliveries.markPaid([job.id], '2026-10-22');

    expect(await errorOf(post(t.app, `/api/jobs/${job.id}/undeliver`), 409)).toBe(
      'This video is marked paid: mark it not paid first.',
    );
  });

  it('only undelivers the job it names', async () => {
    const t = setup();
    const first = t.delivered('One');
    const second = t.delivered('Two');

    await post(t.app, `/api/jobs/${first.id}/undeliver`);

    expect(t.deliveries.get(first.id)).toBeNull();
    expect(t.deliveries.get(second.id)).not.toBeNull();
  });

  it('still answers 200 and deletes the delivery when a listener throws', async () => {
    const t = setup({ throwing: true });
    const job = t.delivered();

    const body = await jobOf(post(t.app, `/api/jobs/${job.id}/undeliver`));

    expect(body.delivery).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

/** The mark-paid request for these jobs. */
function pay(t: Setup, jobs: Pick<Job, 'id'>[], paidOn = '2026-10-23') {
  return post(t.app, '/api/payments', { jobIds: jobs.map((job) => job.id), paidOn });
}

describe('POST /api/payments', () => {
  it('marks the jobs paid on the day and answers with them, in the order asked', async () => {
    const t = setup();
    const a = t.delivered('A');
    const b = t.delivered('B');
    const c = t.delivered('C');

    const body = await jobsOf(pay(t, [c, a]));

    expect(body.map((job) => job.id)).toEqual([c.id, a.id]);
    expect(body.map((job) => job.delivery?.paidOn)).toEqual(['2026-10-23', '2026-10-23']);
    expect(t.jobs.get(a.id)?.delivery?.paidOn).toBe('2026-10-23');
    expect(t.jobs.get(c.id)?.delivery?.paidOn).toBe('2026-10-23');
    expect(t.jobs.get(b.id)?.delivery?.paidOn).toBeNull();
  });

  it('marks an uploaded job paid: its reel stays linked and it is Paid', async () => {
    const t = setup();
    const job = t.uploaded();

    const [body] = await jobsOf(pay(t, [job]));

    expect(body?.delivery).toMatchObject({
      paidOn: '2026-10-23',
      uploadedAt: '2026-10-20T09:30:00.000Z',
      reelUrl: 'https://www.instagram.com/reel/C-spring/',
    });
    expect(t.deliveries.get(job.id)).toMatchObject({ paidOn: '2026-10-23' });
  });

  it('tells the jobs, each once and in the order asked, then the Money page once', async () => {
    const t = setup();
    const a = t.delivered('A');
    const b = t.delivered('B');
    const c = t.delivered('C');

    await pay(t, [b, c, a]);

    expect(t.events).toEqual([...upsert(b, c, a), 'money.changed']);
  });

  it('keeps the price and the delivery time: only the paid day and amount are set', async () => {
    const t = setup();
    const job = t.delivered();
    const before = t.jobs.get(job.id)?.delivery;

    await pay(t, [job]);

    // Nothing typed: the video was paid its price.
    expect(t.jobs.get(job.id)?.delivery).toEqual({
      ...before,
      paidOn: '2026-10-23',
      paidAmount: 40,
    });
  });

  it('records what was paid for each video, ₪0 included, and keeps the price', async () => {
    const t = setup();
    const a = t.delivered('A');
    const b = t.delivered('B');

    const body = await jobsOf(
      post(t.app, '/api/payments', {
        jobIds: [a.id, b.id],
        paidOn: '2026-10-23',
        amounts: { [a.id]: 0, [b.id]: 32.5 },
      }),
    );

    expect(body.map((job) => [job.delivery?.price, job.delivery?.paidAmount])).toEqual([
      [40, 0],
      [40, 32.5],
    ]);
    expect(t.deliveries.get(a.id)).toMatchObject({ price: 40, paidAmount: 0 });
  });

  it.each([
    ['a negative amount', (id: string) => ({ [id]: -5 })],
    ['an amount as text', (id: string) => ({ [id]: '40' })],
    ['an amount for a video the payment does not cover', () => ({ other: 40 })],
  ])('answers 400 for %s, and changes nothing', async (_, amounts) => {
    const t = setup();
    const job = t.delivered();

    const error = await errorOf(
      post(t.app, '/api/payments', {
        jobIds: [job.id],
        paidOn: '2026-10-23',
        amounts: amounts(job.id),
      }),
      400,
    );

    expect(error).toContain('amounts');
    expect(t.deliveries.get(job.id)?.paidOn).toBeNull();
  });

  it('keeps the job’s updatedAt: a payment is not a change to the job row', async () => {
    const t = setup();
    const job = t.delivered();
    t.clock.tick(86_400_000);

    const [after] = await jobsOf(pay(t, [job]));

    expect(after?.updatedAt).toBe(job.updatedAt);
  });

  it('pays a delivered job that left ready as well: the delivery is what counts', async () => {
    const t = setup();
    const job = t.delivered();
    t.jobs.applyTransition(job.id, { type: 'EXPORT_MISSING' });

    const [after] = await jobsOf(pay(t, [job]));

    expect(after?.delivery?.paidOn).toBe('2026-10-23');
  });

  it('ignores keys it does not know', async () => {
    const t = setup();
    const job = t.delivered();

    const res = await post(t.app, '/api/payments', {
      jobIds: [job.id],
      paidOn: '2026-10-23',
      note: 'paid by bit',
    });

    expect(res.status).toBe(200);
  });

  describe('all or nothing (409)', () => {
    it('refuses the lot when one job is not delivered, and changes and tells nothing', async () => {
      const t = setup();
      const delivered = t.delivered('Delivered');
      const approved = t.seed('ready', 'Approved only');

      const res = await pay(t, [delivered, approved]);

      expect(res.status).toBe(409);
      const body = paymentRefusedResponseSchema.parse(await res.json());
      expect(body.refused).toEqual([{ jobId: approved.id, reason: 'not-delivered' }]);
      expect(body.error).toBe('Nothing was changed: Approved only is not delivered yet.');
      expect(t.jobs.get(delivered.id)?.delivery?.paidOn).toBeNull();
      expect(t.events).toEqual([]);
    });

    it('refuses the lot when one job is paid already, which keeps its first day', async () => {
      const t = setup();
      const open = t.delivered('Open');
      const settled = t.paid('Settled', '2026-10-01');

      const res = await pay(t, [open, settled], '2026-10-23');

      expect(res.status).toBe(409);
      const body = paymentRefusedResponseSchema.parse(await res.json());
      expect(body.refused).toEqual([{ jobId: settled.id, reason: 'already-paid' }]);
      expect(body.error).toBe('Nothing was changed: Settled is paid already.');
      expect(t.jobs.get(open.id)?.delivery?.paidOn).toBeNull();
      expect(t.jobs.get(settled.id)?.delivery?.paidOn).toBe('2026-10-01');
      expect(t.events).toEqual([]);
    });

    it('names every job that stopped it, in the order asked', async () => {
      const t = setup();
      const open = t.delivered('Open');
      const settled = t.paid('Settled');
      const approved = t.seed('ready', 'Approved only');

      const res = await pay(t, [approved, open, settled]);

      const body = paymentRefusedResponseSchema.parse(await res.json());
      expect(body.refused).toEqual([
        { jobId: approved.id, reason: 'not-delivered' },
        { jobId: settled.id, reason: 'already-paid' },
      ]);
      expect(body.error).toBe(
        'Nothing was changed: Approved only is not delivered yet; Settled is paid already.',
      );
    });

    it('keeps every job as it was, delivered or not, when the lot is refused', async () => {
      const t = setup();
      const a = t.delivered('A');
      const b = t.delivered('B');
      const settled = t.paid('Settled');
      const before = t.deliveries.list();

      await pay(t, [a, b, settled]);

      expect(t.deliveries.list()).toEqual(before);
    });
  });

  describe('400', () => {
    it.each([
      ['no body', undefined],
      ['a body that is not JSON', 'not json'],
      ['an array', []],
      ['no jobIds', { paidOn: '2026-10-23' }],
      ['no paidOn', { jobIds: ['a'] }],
      ['no jobs', { jobIds: [], paidOn: '2026-10-23' }],
      ['jobIds that is not a list', { jobIds: 'a', paidOn: '2026-10-23' }],
      ['an id that is not text', { jobIds: [7], paidOn: '2026-10-23' }],
      ['an empty id', { jobIds: [''], paidOn: '2026-10-23' }],
      ['a job listed twice', { jobIds: ['a', 'a'], paidOn: '2026-10-23' }],
      [
        '201 jobs',
        { jobIds: Array.from({ length: 201 }, (_, i) => `job${i}`), paidOn: '2026-10-23' },
      ],
      ['a day that does not exist', { jobIds: ['a'], paidOn: '2026-02-30' }],
      ['a day written the other way', { jobIds: ['a'], paidOn: '23/10/2026' }],
      ['a day with a time', { jobIds: ['a'], paidOn: '2026-10-23T10:00:00Z' }],
      ['a day that is a number', { jobIds: ['a'], paidOn: 20261023 }],
      ['an empty day', { jobIds: ['a'], paidOn: '' }],
    ])('answers 400 for %s, and changes and tells nothing', async (_name, body) => {
      const t = setup();
      const job = t.delivered('A');

      const res =
        typeof body === 'string'
          ? await t.app.request('/api/payments', { method: 'POST', body })
          : await post(t.app, '/api/payments', body);

      expect(await errorOf(res, 400)).toMatch(/^Send the payment as JSON/);
      expect(t.jobs.get(job.id)?.delivery?.paidOn).toBeNull();
      expect(t.events).toEqual([]);
    });

    it('takes exactly 200 jobs: that many unknown ones are a 404, not a 400', async () => {
      const t = setup();
      const jobIds = Array.from({ length: PAYMENT_JOBS_MAX }, (_, i) => `job${i}`);

      const res = await post(t.app, '/api/payments', { jobIds, paidOn: '2026-10-23' });

      expect(res.status).toBe(404);
    });

    it('takes a leap day', async () => {
      const t = setup();
      const job = t.delivered();

      const res = await pay(t, [job], '2028-02-29');

      expect(res.status).toBe(200);
    });
  });

  describe('404', () => {
    it('answers 404 for an unknown job, and changes and tells nothing', async () => {
      const t = setup();
      const job = t.delivered();

      const res = await post(t.app, '/api/payments', {
        jobIds: [job.id, 'nope'],
        paidOn: '2026-10-23',
      });

      expect(await errorOf(res, 404)).toBe('Job nope not found');
      expect(t.jobs.get(job.id)?.delivery?.paidOn).toBeNull();
      expect(t.events).toEqual([]);
    });

    it('names every unknown job', async () => {
      const t = setup();
      const job = t.delivered();

      const res = await post(t.app, '/api/payments', {
        jobIds: ['nope', job.id, 'gone'],
        paidOn: '2026-10-23',
      });

      expect(await errorOf(res, 404)).toBe('Jobs not found: nope, gone');
    });
  });

  it('still answers 200 and keeps the payment when a listener throws', async () => {
    const t = setup({ throwing: true });
    const job = t.delivered();

    const [after] = await jobsOf(pay(t, [job]));

    expect(after?.delivery?.paidOn).toBe('2026-10-23');
  });

  it('only answers POST: other methods get the ordinary JSON 404', async () => {
    const t = setup();

    expect(await errorOf(t.app.request('/api/payments'), 404)).toBe('Not found');
  });
});

describe('POST /api/payments/undo', () => {
  /** The request that takes these jobs back to Delivered. */
  function unpay(t: Setup, jobs: Pick<Job, 'id'>[]) {
    return post(t.app, '/api/payments/undo', { jobIds: jobs.map((job) => job.id) });
  }

  it('clears the paid day and answers with the jobs, in the order asked', async () => {
    const t = setup();
    const a = t.paid('A');
    const b = t.paid('B');
    const c = t.paid('C');

    const body = await jobsOf(unpay(t, [b, a]));

    expect(body.map((job) => job.id)).toEqual([b.id, a.id]);
    expect(body.map((job) => job.delivery?.paidOn)).toEqual([null, null]);
    expect(t.jobs.get(c.id)?.delivery?.paidOn).toBe('2026-10-20');
  });

  it('puts an uploaded job back to Uploaded, not Delivered: its reel stays linked', async () => {
    const t = setup();
    const job = t.uploaded();
    await pay(t, [job]);

    const [body] = await jobsOf(unpay(t, [job]));

    expect(body).toBeDefined();
    expect(jobStage(body as Job)).toBe('uploaded');
    expect(body?.delivery?.paidOn).toBeNull();
  });

  it('keeps the delivery and its price: the job goes back to delivered, not approved', async () => {
    const t = setup();
    const job = t.paid('A');
    const before = t.jobs.get(job.id)?.delivery;

    await unpay(t, [job]);

    expect(t.jobs.get(job.id)?.delivery).toEqual({ ...before, paidOn: null, paidAmount: null });
  });

  it('tells the jobs, each once and in the order asked, then the Money page once', async () => {
    const t = setup();
    const a = t.paid('A');
    const b = t.paid('B');

    await unpay(t, [b, a]);

    expect(t.events).toEqual([...upsert(b, a), 'money.changed']);
  });

  it('can be paid again on another day', async () => {
    const t = setup();
    const job = t.paid('A', '2026-10-20');
    await unpay(t, [job]);

    const [after] = await jobsOf(pay(t, [job], '2026-10-25'));

    expect(after?.delivery?.paidOn).toBe('2026-10-25');
  });

  describe('all or nothing (409)', () => {
    it('refuses the lot when one job is not paid, and changes and tells nothing', async () => {
      const t = setup();
      const settled = t.paid('Settled');
      const open = t.delivered('Open');

      const res = await unpay(t, [settled, open]);

      expect(res.status).toBe(409);
      const body = paymentRefusedResponseSchema.parse(await res.json());
      expect(body.refused).toEqual([{ jobId: open.id, reason: 'not-paid' }]);
      expect(body.error).toBe('Nothing was changed: Open is not paid.');
      expect(t.jobs.get(settled.id)?.delivery?.paidOn).toBe('2026-10-20');
      expect(t.events).toEqual([]);
    });

    it('names a job that is not delivered at all', async () => {
      const t = setup();
      const settled = t.paid('Settled');
      const approved = t.seed('ready', 'Approved only');

      const res = await unpay(t, [settled, approved]);

      const body = paymentRefusedResponseSchema.parse(await res.json());
      expect(body.refused).toEqual([{ jobId: approved.id, reason: 'not-delivered' }]);
      expect(t.jobs.get(settled.id)?.delivery?.paidOn).toBe('2026-10-20');
    });
  });

  describe('400', () => {
    it.each([
      ['no body', undefined],
      ['no jobIds', {}],
      ['no jobs', { jobIds: [] }],
      ['a job listed twice', { jobIds: ['a', 'a'] }],
      ['an id that is not text', { jobIds: [null] }],
      ['201 jobs', { jobIds: Array.from({ length: 201 }, (_, i) => `job${i}`) }],
    ])('answers 400 for %s, and changes and tells nothing', async (_name, body) => {
      const t = setup();
      const job = t.paid('A');

      const res = await post(t.app, '/api/payments/undo', body);

      expect(await errorOf(res, 400)).toMatch(/^Send the videos as JSON/);
      expect(t.jobs.get(job.id)?.delivery?.paidOn).toBe('2026-10-20');
      expect(t.events).toEqual([]);
    });
  });

  it('answers 404 for an unknown job, and changes and tells nothing', async () => {
    const t = setup();
    const job = t.paid('A');

    const res = await post(t.app, '/api/payments/undo', { jobIds: [job.id, 'nope'] });

    expect(await errorOf(res, 404)).toBe('Job nope not found');
    expect(t.jobs.get(job.id)?.delivery?.paidOn).toBe('2026-10-20');
    expect(t.events).toEqual([]);
  });

  it('is not taken for a payment: /api/payments/undo does not read paidOn', async () => {
    const t = setup();
    const job = t.delivered();

    const res = await post(t.app, '/api/payments/undo', { jobIds: [job.id], paidOn: '2026-10-23' });

    expect(res.status).toBe(409);
    expect(t.jobs.get(job.id)?.delivery?.paidOn).toBeNull();
  });
});

describe('the whole way there and back', () => {
  it('goes approved, delivered, paid, delivered, approved and tells each step', async () => {
    const t = setup();
    const job = t.seed('ready');

    const stage = () => {
      const delivery = t.jobs.get(job.id)?.delivery ?? null;
      return delivery === null ? 'approved' : delivery.paidOn === null ? 'delivered' : 'paid';
    };
    const steps: string[] = [stage()];

    await jobOf(post(t.app, `/api/jobs/${job.id}/deliver`));
    steps.push(stage());
    await jobsOf(pay(t, [job], '2026-10-23'));
    steps.push(stage());
    await jobsOf(post(t.app, '/api/payments/undo', { jobIds: [job.id] }));
    steps.push(stage());
    await jobOf(post(t.app, `/api/jobs/${job.id}/undeliver`));
    steps.push(stage());

    expect(steps).toEqual(['approved', 'delivered', 'paid', 'delivered', 'approved']);
    // One job.upsert and one money.changed for each of the four changes.
    expect(t.events).toEqual([0, 1, 2, 3].flatMap(() => [...upsert(job), 'money.changed']));
  });
});

describe('videos whose folder was deleted (CVP-204)', () => {
  /** A delivered video whose folder is deleted afterwards: its delivery is all that is left. */
  function orphaned(t: Setup, name = 'History check'): Job {
    const job = t.delivered(name);
    expect(t.jobs.remove(job.id)).toBe(true);
    t.events.length = 0;
    return job;
  }

  async function orphansOf(res: Response | Promise<Response>): Promise<OrphanDelivery[]> {
    const response = await res;
    expect(response.status).toBe(200);
    return paymentResponseSchema.parse(await response.json()).orphans;
  }

  async function listed(t: Setup): Promise<OrphanDelivery[]> {
    const response = await t.app.request('/api/deliveries/unpaid-without-job');
    expect(response.status).toBe(200);
    return orphanDeliveriesResponseSchema.parse(await response.json()).orphans;
  }

  describe('GET /api/deliveries/unpaid-without-job', () => {
    it('lists the unpaid deliveries whose job is gone, as the delivery row says', async () => {
      const t = setup();
      const job = orphaned(t);

      expect(await listed(t)).toEqual([
        {
          id: job.id,
          clientId: job.clientId,
          client: 'Northwind Bakery',
          name: 'History check',
          relPath: 'Northwind Bakery/History check',
          delivery: {
            deliveredAt: job.delivery?.deliveredAt,
            price: 40,
            currency: 'ILS',
            paidOn: null,
            paidAmount: null,
          },
        },
      ]);
    });

    it('is empty when every delivered video still has its folder', async () => {
      const t = setup();
      t.delivered('Here');

      expect(await listed(t)).toEqual([]);
    });

    it('leaves out a paid one, and lists it again once the payment is taken back', async () => {
      const t = setup();
      const job = orphaned(t);
      await pay(t, [job]);
      expect(await listed(t)).toEqual([]);

      await post(t.app, '/api/payments/undo', { jobIds: [job.id] });

      expect((await listed(t)).map((orphan) => orphan.id)).toEqual([job.id]);
    });

    it('lists the newest delivery first', async () => {
      const t = setup();
      const older = orphaned(t, 'Older');
      t.clock.tick(3_600_000);
      const newer = orphaned(t, 'Newer');

      expect((await listed(t)).map((orphan) => orphan.id)).toEqual([newer.id, older.id]);
    });

    it('only answers GET', async () => {
      const t = setup();

      const res = await post(t.app, '/api/deliveries/unpaid-without-job');

      expect(await errorOf(res, 404)).toBe('Not found');
    });
  });

  describe('POST /api/payments', () => {
    it('marks it paid and answers with it in orphans, not in jobs', async () => {
      const t = setup();
      const job = orphaned(t);

      const res = await pay(t, [job]);

      expect(res.status).toBe(200);
      const body = paymentResponseSchema.parse(await res.json());
      expect(body.jobs).toEqual([]);
      expect(body.orphans).toEqual([
        expect.objectContaining({
          id: job.id,
          name: 'History check',
          delivery: expect.objectContaining({ price: 40, paidOn: '2026-10-23' }),
        }),
      ]);
      expect(t.deliveries.get(job.id)?.paidOn).toBe('2026-10-23');
    });

    it('tells only the Money page: there is no job to publish', async () => {
      const t = setup();
      const job = orphaned(t);

      await pay(t, [job]);

      expect(t.events).toEqual(['money.changed']);
    });

    it('pays it together with a video that still has its folder, each in its own list', async () => {
      const t = setup();
      const gone = orphaned(t, 'Gone');
      const here = t.delivered('Here');
      t.events.length = 0;

      const res = await pay(t, [gone, here]);

      const body = paymentResponseSchema.parse(await res.json());
      expect(body.jobs.map((job) => job.id)).toEqual([here.id]);
      expect(body.jobs[0]?.delivery?.paidOn).toBe('2026-10-23');
      expect(body.orphans.map((orphan) => orphan.id)).toEqual([gone.id]);
      expect(t.events).toEqual([...upsert(here), 'money.changed']);
    });

    it('answers 404 for an id that is neither a job nor a delivery, and changes nothing', async () => {
      const t = setup();
      const job = orphaned(t);

      const res = await post(t.app, '/api/payments', {
        jobIds: [job.id, 'nope'],
        paidOn: '2026-10-23',
      });

      expect(await errorOf(res, 404)).toBe('Job nope not found');
      expect(t.deliveries.get(job.id)?.paidOn).toBeNull();
      expect(t.events).toEqual([]);
    });

    it('answers 409 for one that is paid already, naming it, and changes nothing', async () => {
      const t = setup();
      const paidAlready = orphaned(t, 'Paid already');
      await pay(t, [paidAlready], '2026-10-20');
      const other = orphaned(t, 'Other');
      t.events.length = 0;

      const response = await pay(t, [other, paidAlready]);

      expect(response.status).toBe(409);
      const body = paymentRefusedResponseSchema.parse(await response.json());
      expect(body.error).toBe('Nothing was changed: Paid already is paid already.');
      expect(body.refused).toEqual([{ jobId: paidAlready.id, reason: 'already-paid' }]);
      expect(t.deliveries.get(other.id)?.paidOn).toBeNull();
      expect(t.deliveries.get(paidAlready.id)?.paidOn).toBe('2026-10-20');
      expect(t.events).toEqual([]);
    });
  });

  describe('POST /api/payments/undo', () => {
    it('takes the payment back and answers with it in orphans', async () => {
      const t = setup();
      const job = orphaned(t);
      await pay(t, [job]);
      t.events.length = 0;

      const orphans = await orphansOf(post(t.app, '/api/payments/undo', { jobIds: [job.id] }));

      expect(orphans.map((orphan) => orphan.delivery.paidOn)).toEqual([null]);
      expect(t.deliveries.get(job.id)).toMatchObject({ paidOn: null, price: 40 });
      expect(t.events).toEqual(['money.changed']);
    });

    it('answers 409 for one that is not paid, naming it', async () => {
      const t = setup();
      const job = orphaned(t, 'Not paid');

      const res = await post(t.app, '/api/payments/undo', { jobIds: [job.id] });

      expect(await errorOf(res, 409)).toBe('Nothing was changed: Not paid is not paid.');
      expect(t.events).toEqual([]);
    });

    it('answers 404 for an id that is neither a job nor a delivery', async () => {
      const t = setup();
      const job = orphaned(t);
      await pay(t, [job]);

      const res = await post(t.app, '/api/payments/undo', { jobIds: [job.id, 'nope'] });

      expect(await errorOf(res, 404)).toBe('Job nope not found');
      expect(t.deliveries.get(job.id)?.paidOn).toBe('2026-10-23');
    });
  });

  describe('POST /api/jobs/:id/undeliver', () => {
    it('deletes the delivery and answers with the one taken off: there is no job to go back to approved', async () => {
      const t = setup();
      const job = orphaned(t);

      const res = await post(t.app, `/api/jobs/${job.id}/undeliver`);

      expect(res.status).toBe(200);
      const body = undeliverResponseSchema.parse(await res.json());
      expect(body).toEqual({
        removed: expect.objectContaining({
          id: job.id,
          name: 'History check',
          delivery: expect.objectContaining({ price: 40, paidOn: null }),
        }),
      });
      expect(t.deliveries.get(job.id)).toBeNull();
      expect(t.jobs.get(job.id)).toBeNull();
      expect(await listed(t)).toEqual([]);
    });

    it('tells only the Money page', async () => {
      const t = setup();
      const job = orphaned(t);

      await post(t.app, `/api/jobs/${job.id}/undeliver`);

      expect(t.events).toEqual(['money.changed']);
    });

    it('answers 409 for a paid one, which stays delivered and paid', async () => {
      const t = setup();
      const job = orphaned(t);
      await pay(t, [job], '2026-10-22');
      t.events.length = 0;

      const res = await post(t.app, `/api/jobs/${job.id}/undeliver`);

      expect(await errorOf(res, 409)).toBe('This video is marked paid: mark it not paid first.');
      expect(t.deliveries.get(job.id)?.paidOn).toBe('2026-10-22');
      expect(t.events).toEqual([]);
    });

    it('answers 404 for an id that is neither a job nor a delivery', async () => {
      const t = setup();
      const job = orphaned(t);
      await post(t.app, `/api/jobs/${job.id}/undeliver`);

      expect(await errorOf(post(t.app, `/api/jobs/${job.id}/undeliver`), 404)).toBe(
        `Job ${job.id} not found`,
      );
    });
  });

  describe('POST /api/jobs/:id/deliver', () => {
    it('still needs a real ready job: a video without one answers 404', async () => {
      const t = setup();
      const job = orphaned(t);
      await post(t.app, `/api/jobs/${job.id}/undeliver`);

      expect(await errorOf(post(t.app, `/api/jobs/${job.id}/deliver`), 404)).toBe(
        `Job ${job.id} not found`,
      );
      expect(t.deliveries.get(job.id)).toBeNull();
    });
  });

  it('goes delivered, paid, delivered, taken back and tells the Money page each time', async () => {
    const t = setup();
    const job = orphaned(t);
    const steps: string[] = [];
    const stage = async () => {
      const [orphan] = await listed(t);
      steps.push(orphan === undefined ? 'not listed' : 'listed');
    };

    await stage();
    await pay(t, [job]);
    await stage();
    await post(t.app, '/api/payments/undo', { jobIds: [job.id] });
    await stage();
    await post(t.app, `/api/jobs/${job.id}/undeliver`);
    await stage();

    expect(steps).toEqual(['listed', 'not listed', 'listed', 'not listed']);
    expect(t.events).toEqual(['money.changed', 'money.changed', 'money.changed']);
  });
});
