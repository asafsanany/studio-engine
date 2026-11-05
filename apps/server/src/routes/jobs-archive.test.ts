import {
  ARCHIVE_BLOCKED_STATES,
  ARCHIVE_MAX_IDS,
  apiErrorSchema,
  archiveJobsResponseSchema,
  JOB_STATES,
  type Job,
  type JobEvent,
  jobListResponseSchema,
  moneyFileSchema,
  moneyResponseSchema,
  paymentResponseSchema,
  unarchiveJobsResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { StudioDb } from '../db/database.js';
import { DeliveryRepository } from '../db/delivery-repository.js';
import { JobRepository } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, rawRow, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createRecordDelivery } from '../deliveries/deliveries.js';
import { logger } from '../logger.js';
import type { ActionWorker } from './jobs.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// CVP-196: POST /api/jobs/archive and /unarchive. The real repositories on an in-memory database
// and the real routes, `app.request` for the HTTP. Archiving hides a job from the lists (the web
// app filters on `archivedAt`) and changes nothing else about it.

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
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ],
  ready: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'SUCCEED', output: OUTPUT }],
  failed: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'FAIL', step: 4, error: 'boom' }],
  cancelled: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }],
};

const MONEY_NOW = new Date('2026-10-21T09:00:00+03:00');

function setup(options: { throwing?: boolean } = {}) {
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const recordDelivery = createRecordDelivery({
    deliveries,
    jobs,
    priceFor: () => ({ price: 40, currency: 'ILS' }),
    clock,
  });
  /** What `onJobChanged` was told, and what the worker was told, in order. */
  const changed: Job[] = [];
  const woken = { count: 0 };
  const worker: ActionWorker = {
    cancel: async () => null,
    notify: () => {
      woken.count += 1;
    },
  };
  const onJobChanged = (job: Job) => {
    changed.push(job);
    if (options.throwing) throw new Error('listener broke');
  };
  /** How many times the route said the Money page's numbers moved. */
  const money = { changed: 0 };
  const onMoneyChanged = () => {
    money.changed += 1;
    if (options.throwing) throw new Error('listener broke');
  };
  const app = createApp({
    jobs: { jobs, worker, exportsDir: '/nonexistent/exports', onJobChanged, onMoneyChanged },
    delivery: { jobs, deliveries, recordDelivery, onJobChanged, onMoneyChanged: () => {} },
    money: {
      deliveries,
      money: { get: () => moneyFileSchema.parse({}) },
      timeZone: () => 'Asia/Jerusalem',
      clock: () => MONEY_NOW,
      // As the engine wires it: an archived delivery is not "not paid yet" (CVP-210).
      archivedJobIds: () => jobs.archivedIds(),
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

  /** A ready job marked delivered (and paid on `paidOn`, when given). */
  function delivered(name: string, paidOn?: string): Job {
    const job = seed('ready', name);
    clock.tick();
    recordDelivery(job);
    if (paidOn !== undefined) deliveries.markPaid([job.id], paidOn);
    return jobs.get(job.id) as Job;
  }

  return { app, db, clock, jobs, deliveries, changed, woken, money, seed, delivered };
}

const archive = (app: Hono, body: unknown) => send(app, 'archive', body);
const unarchive = (app: Hono, body: unknown) => send(app, 'unarchive', body);

async function send(app: Hono, verb: string, body: unknown): Promise<Response> {
  return app.request(`/api/jobs/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function errorOf(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await res.json()).error;
}

async function jobsOf(res: Response): Promise<Job[]> {
  expect(res.status).toBe(200);
  return archiveJobsResponseSchema.parse(await res.json()).jobs;
}

async function listOf(app: Hono): Promise<Job[]> {
  return jobListResponseSchema.parse(await (await app.request('/api/jobs')).json());
}

const ids = (list: readonly Pick<Job, 'id'>[]) => list.map((job) => job.id);

describe('POST /api/jobs/archive', () => {
  it('archives the jobs and answers with them, in the order asked', async () => {
    const t = setup();
    const a = t.seed('ready', 'A ready');
    const b = t.seed('failed', 'B failed');
    const c = t.seed('review', 'C review');
    t.clock.tick(5_000);

    const body = await jobsOf(await archive(t.app, { ids: [c.id, a.id, b.id] }));

    const archivedAt = t.clock().toISOString();
    expect(body).toEqual([c, a, b].map((job) => ({ ...job, archivedAt })));
    expect(body.every((job) => job.archivedAt === archivedAt)).toBe(true);
    expect(ids(body)).toEqual([c.id, a.id, b.id]);
    for (const job of body) expect(t.jobs.get(job.id)).toEqual(job);
  });

  it('keeps everything about a job but the date, updatedAt included', async () => {
    const t = setup();
    const job = t.seed('cancelled');
    t.clock.tick(60_000);

    const [archived] = await jobsOf(await archive(t.app, { ids: [job.id] }));

    expect(archived).toEqual({ ...job, archivedAt: t.clock().toISOString() });
    expect(archived?.updatedAt).toBe(job.updatedAt);
  });

  it('keeps the first date when a job is archived again, and says nothing new about it', async () => {
    const t = setup();
    const job = t.seed('ready');
    t.clock.tick(1_000);
    const [first] = await jobsOf(await archive(t.app, { ids: [job.id] }));
    t.changed.length = 0;
    t.clock.tick(86_400_000);

    const [again] = await jobsOf(await archive(t.app, { ids: [job.id] }));

    expect(again?.archivedAt).toBe(first?.archivedAt);
    expect(t.changed).toEqual([]);
  });

  it('publishes a job event for each job that changed, with the job as it is then', async () => {
    const t = setup();
    const done = t.seed('ready', 'Done');
    const fresh = t.seed('failed', 'Fresh');
    const other = t.seed('held', 'Other');
    await archive(t.app, { ids: [done.id] });
    t.changed.length = 0;
    t.clock.tick(5_000);

    const body = await jobsOf(await archive(t.app, { ids: [done.id, fresh.id] }));

    expect(ids(t.changed)).toEqual([fresh.id]);
    expect(t.changed[0]).toEqual(body[1]);
    expect(t.changed[0]?.archivedAt).toBe(t.clock().toISOString());
    expect(t.jobs.get(other.id)?.archivedAt).toBeNull();
  });

  it('does not wake the worker', async () => {
    const t = setup();
    const job = t.seed('ready');
    t.seed('queued', 'Waiting');

    await archive(t.app, { ids: [job.id] });
    await unarchive(t.app, { ids: [job.id] });

    expect(t.woken.count).toBe(0);
  });

  it('still answers 200 when a listener of the job events throws, and logs it', async () => {
    const t = setup({ throwing: true });
    const job = t.seed('ready');

    const [archived] = await jobsOf(await archive(t.app, { ids: [job.id] }));

    expect(archived?.archivedAt).not.toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it.each(ARCHIVE_BLOCKED_STATES)(
    'answers 409 "Can\'t archive "<name>" while it is %s." and changes nothing',
    async (state) => {
      const t = setup();
      const job = t.seed(state, 'Spring menu');
      t.changed.length = 0;
      const rows = rawRow(t.db, 'jobs');

      const error = await errorOf(await archive(t.app, { ids: [job.id] }), 409);

      expect(error).toBe(`Can't archive "Spring menu" while it is ${state}.`);
      expect(rawRow(t.db, 'jobs')).toEqual(rows);
      expect(t.changed).toEqual([]);
    },
  );

  it('is all or nothing: one job that is working keeps the others in the lists', async () => {
    const t = setup();
    const ready = t.seed('ready', 'Ready');
    const editing = t.seed('editing', 'Coach intro reel');
    const failed = t.seed('failed', 'Failed');
    t.changed.length = 0;

    const error = await errorOf(
      await archive(t.app, { ids: [ready.id, editing.id, failed.id] }),
      409,
    );

    expect(error).toBe('Can\'t archive "Coach intro reel" while it is editing.');
    expect((await listOf(t.app)).map((job) => job.archivedAt)).toEqual([null, null, null]);
    expect(t.changed).toEqual([]);
  });

  it('answers 404 for an unknown job, and changes nothing', async () => {
    const t = setup();
    const ready = t.seed('ready');
    t.changed.length = 0;

    const error = await errorOf(await archive(t.app, { ids: [ready.id, 'nosuchjob00'] }), 404);

    expect(error).toBe('Job nosuchjob00 not found');
    expect(t.jobs.get(ready.id)?.archivedAt).toBeNull();
    expect(t.changed).toEqual([]);
  });

  it('answers 404 before 409 when both an unknown job and a working one are named', async () => {
    const t = setup();
    const editing = t.seed('editing');

    await errorOf(await archive(t.app, { ids: [editing.id, 'nosuchjob00'] }), 404);
  });

  describe('400', () => {
    const MESSAGE = `Send the jobs as JSON: { "ids": ["<job id>", ...] }, from 1 to ${ARCHIVE_MAX_IDS} jobs, each named once.`;
    const BAD_BODIES: [string, unknown][] = [
      ['no ids', {}],
      ['no jobs in the list', { ids: [] }],
      ['a job named twice', { ids: ['a', 'b', 'a'] }],
      [
        'more than 200 jobs',
        { ids: Array.from({ length: ARCHIVE_MAX_IDS + 1 }, (_, i) => `job${i}`) },
      ],
      ['a bare id', { ids: 'abc' }],
      ['an empty id', { ids: [''] }],
      ['a number', { ids: [1] }],
      ['another name', { jobIds: ['abc'] }],
      ['a list', '["abc"]'],
      ['text that is not JSON', 'abc'],
      ['an empty body', ''],
    ];

    it.each(BAD_BODIES)('answers 400 for %s, and changes nothing', async (_name, body) => {
      const t = setup();
      const job = t.seed('ready');
      const rows = rawRow(t.db, 'jobs');

      expect(await errorOf(await archive(t.app, body), 400)).toBe(MESSAGE);
      expect(await errorOf(await unarchive(t.app, body), 400)).toBe(MESSAGE);

      expect(rawRow(t.db, 'jobs')).toEqual(rows);
      expect(t.jobs.get(job.id)?.archivedAt).toBeNull();
    });

    it('takes 200 jobs (they are looked up, so 200 unknown ones are a 404, not a 400)', async () => {
      const t = setup();
      const many = Array.from({ length: ARCHIVE_MAX_IDS }, (_, i) => `job${i}`);
      await errorOf(await archive(t.app, { ids: many }), 404);
    });
  });
});

describe('POST /api/jobs/unarchive', () => {
  it('takes jobs out of the archive and answers with them, in the order asked', async () => {
    const t = setup();
    const a = t.seed('ready', 'A');
    const b = t.seed('failed', 'B');
    await archive(t.app, { ids: [a.id, b.id] });
    t.changed.length = 0;
    t.clock.tick(5_000);

    const body = await jobsOf(await unarchive(t.app, { ids: [b.id, a.id] }));

    expect(body).toEqual([b, a]);
    expect(unarchiveJobsResponseSchema.safeParse({ jobs: body }).success).toBe(true);
    expect(ids(t.changed)).toEqual([b.id, a.id]);
    expect(ids(body)).toEqual([b.id, a.id]);
    expect((await listOf(t.app)).map((job) => job.archivedAt)).toEqual([null, null]);
  });

  it('answers 200 for a job that is not archived, and says nothing about it', async () => {
    const t = setup();
    const job = t.seed('ready');
    t.changed.length = 0;

    const body = await jobsOf(await unarchive(t.app, { ids: [job.id] }));

    expect(body).toEqual([job]);
    expect(t.changed).toEqual([]);
  });

  it('gives a new date when the job is archived again', async () => {
    const t = setup();
    const job = t.seed('ready');
    t.clock.tick(1_000);
    const [first] = await jobsOf(await archive(t.app, { ids: [job.id] }));
    await unarchive(t.app, { ids: [job.id] });
    t.clock.tick(60_000);

    const [second] = await jobsOf(await archive(t.app, { ids: [job.id] }));

    expect(Date.parse(second?.archivedAt ?? '')).toBeGreaterThan(
      Date.parse(first?.archivedAt ?? ''),
    );
  });

  it('answers 404 for an unknown job, and changes nothing', async () => {
    const t = setup();
    const job = t.seed('ready');
    await archive(t.app, { ids: [job.id] });
    t.changed.length = 0;

    const error = await errorOf(await unarchive(t.app, { ids: [job.id, 'nosuchjob00'] }), 404);

    expect(error).toBe('Job nosuchjob00 not found');
    expect(t.jobs.get(job.id)?.archivedAt).not.toBeNull();
    expect(t.changed).toEqual([]);
  });
});

describe('a job leaves the archive when it runs again', () => {
  it.each([
    ['failed', 'retry'],
    ['cancelled', 'resume'],
    ['held', 'release'],
    ['review', 'send-notes'],
    ['review', 'approve'],
  ] as const)('%s, then %s', async (state, action) => {
    const t = setup();
    const job = t.seed(state);
    await archive(t.app, { ids: [job.id] });
    t.changed.length = 0;
    t.clock.tick(5_000);

    const res = await t.app.request(`/api/jobs/${job.id}/${action}`, { method: 'POST' });

    expect(res.status).toBe(200);
    const after = (await res.json()) as Job;
    expect(ARCHIVE_BLOCKED_STATES).toContain(after.state);
    expect(after.archivedAt).toBeNull();
    expect(t.changed.map((j) => j.archivedAt)).toEqual([null]);
    expect((await listOf(t.app))[0]?.archivedAt).toBeNull();
  });
});

describe('the paths', () => {
  it('are not caught by any /:id route', () => {
    const t = setup();
    const swallowing = t.app.routes.filter(
      (route) =>
        (route.method === 'POST' || route.method === 'ALL') &&
        /^\/api\/jobs\/(:[^/]+|\*)\/?$/.test(route.path),
    );
    expect(swallowing).toEqual([]);

    const own = t.app.routes
      .filter((route) => route.method === 'POST' && /^\/api\/jobs\/(un)?archive$/.test(route.path))
      .map((route) => route.path);
    expect(own).toEqual(['/api/jobs/archive', '/api/jobs/unarchive']);
  });

  it('answer the archive routes, not a job named "archive" or "unarchive"', async () => {
    const t = setup();
    for (const verb of ['archive', 'unarchive']) {
      const res = await t.app.request(`/api/jobs/${verb}`, { method: 'POST' });
      // The archive routes' own 400 (no body), not a job that is not found.
      expect(await errorOf(res, 400)).toContain('"ids"');
    }
  });

  it('are POST only', async () => {
    const t = setup();
    for (const verb of ['archive', 'unarchive']) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await t.app.request(`/api/jobs/${verb}`, { method });
        expect(res.status, `${method} ${verb}`).toBe(404);
      }
    }
  });

  it('leave the actions on a job whose id is one of the words alone', async () => {
    const t = setup();
    const res = await t.app.request('/api/jobs/archive/hold', { method: 'POST' });
    expect(await errorOf(res, 404)).toBe('Job archive not found');
  });
});

describe('the Money page is told', () => {
  it('when archive or unarchive changes a job that has a delivery', async () => {
    const t = setup();
    const owed = t.delivered('Owed job');
    await jobsOf(await archive(t.app, { ids: [owed.id] }));
    expect(t.money.changed).toBe(1);
    // Archiving it again changes nothing, so nothing is said.
    await jobsOf(await archive(t.app, { ids: [owed.id] }));
    expect(t.money.changed).toBe(1);
    await jobsOf(await unarchive(t.app, { ids: [owed.id] }));
    expect(t.money.changed).toBe(2);
  });

  it('not for a job with no delivery', async () => {
    const t = setup();
    const approved = t.seed('ready', 'Approved only');
    const failed = t.seed('failed', 'Broken');
    await jobsOf(await archive(t.app, { ids: [approved.id, failed.id] }));
    await jobsOf(await unarchive(t.app, { ids: [approved.id, failed.id] }));
    expect(t.money.changed).toBe(0);
  });

  it('and a listener that throws does not fail the request', async () => {
    const t = setup({ throwing: true });
    const owed = t.delivered('Owed job');
    expect(await jobsOf(await archive(t.app, { ids: [owed.id] }))).toHaveLength(1);
    expect(t.money.changed).toBe(1);
  });
});

describe('what archiving does not change', () => {
  it('GET /api/jobs still lists archived jobs, with their date, in the same order', async () => {
    const t = setup();
    const oldest = t.seed('ready', 'Oldest');
    const middle = t.seed('failed', 'Middle');
    const newest = t.seed('ready', 'Newest');
    const before = await listOf(t.app);
    expect(ids(before)).toEqual([newest.id, middle.id, oldest.id]);
    t.clock.tick(60_000);

    await archive(t.app, { ids: [middle.id, oldest.id] });
    const after = await listOf(t.app);

    expect(ids(after)).toEqual(ids(before));
    expect(after.map((job) => [job.id, job.archivedAt !== null])).toEqual([
      [newest.id, false],
      [middle.id, true],
      [oldest.id, true],
    ]);
    expect(after.map((job) => job.updatedAt)).toEqual(before.map((job) => job.updatedAt));

    await unarchive(t.app, { ids: [middle.id, oldest.id] });
    expect(await listOf(t.app)).toEqual(before);
  });

  it('deliveries are untouched; Money keeps the income and leaves archived jobs out of not paid yet', async () => {
    const t = setup();
    const paid = t.delivered('Paid job', '2026-10-20');
    const owed = t.delivered('Owed job');
    const notDelivered = t.seed('ready', 'Approved only');
    const getMoney = async () =>
      moneyResponseSchema.parse(await (await t.app.request('/api/money?month=2026-10')).json());
    const moneyBefore = await getMoney();
    const deliveriesBefore = t.deliveries.list();
    const rowsBefore = rawRow(t.db, 'deliveries');
    expect(moneyBefore.ledger).toHaveLength(2);
    expect(moneyBefore.banners.income.unpaid).toEqual({ value: 40, count: 1 });
    t.clock.tick(60_000);

    await jobsOf(await archive(t.app, { ids: [paid.id, owed.id, notDelivered.id] }));

    // Archived means paid already or not needed: the owed job is no longer "not paid yet", and
    // the ledger says the two are archived. Everything else is as it was.
    const moneyArchived = await getMoney();
    expect(moneyArchived.banners.income.unpaid).toEqual({ value: 0, count: 0 });
    expect(moneyArchived.ledger.map((entry) => entry.archived)).toEqual([true, true]);
    expect({
      ...moneyArchived,
      banners: { ...moneyArchived.banners, income: moneyBefore.banners.income },
      ledger: moneyArchived.ledger.map((entry) => ({ ...entry, archived: false })),
    }).toEqual(moneyBefore);
    expect(t.deliveries.list()).toEqual(deliveriesBefore);
    expect(rawRow(t.db, 'deliveries')).toEqual(rowsBefore);
    // The jobs still carry their delivery, so they still count as paid and as owed.
    const list = await listOf(t.app);
    expect(list.find((job) => job.id === paid.id)?.delivery).toEqual(paid.delivery);
    expect(list.find((job) => job.id === owed.id)?.delivery).toEqual(owed.delivery);
    expect(list.find((job) => job.id === notDelivered.id)?.delivery).toBeNull();

    await jobsOf(await unarchive(t.app, { ids: [paid.id, owed.id, notDelivered.id] }));
    expect(await getMoney()).toEqual(moneyBefore);
    expect(rawRow(t.db, 'deliveries')).toEqual(rowsBefore);
  });

  it('an archived delivered job can still be marked paid, and Money counts it', async () => {
    const t = setup();
    const owed = t.delivered('Owed job');
    await archive(t.app, { ids: [owed.id] });
    t.clock.tick(5_000);

    const res = await t.app.request('/api/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobIds: [owed.id], paidOn: '2026-10-21' }),
    });

    expect(res.status).toBe(200);
    const [paid] = paymentResponseSchema.parse(await res.json()).jobs;
    expect(paid?.delivery?.paidOn).toBe('2026-10-21');
    expect(paid?.archivedAt).not.toBeNull();
    const money = moneyResponseSchema.parse(
      await (await t.app.request('/api/money?month=2026-10')).json(),
    );
    expect(money.ledger.map((entry) => entry.paidOn)).toEqual(['2026-10-21']);
  });
});

// Every state is covered above or by the repository tests: this keeps the two lists in step.
describe('the states', () => {
  it('that can be archived are the ones the route accepts', async () => {
    const t = setup();
    const results: Record<string, number> = {};
    for (const state of JOB_STATES) {
      const job = t.seed(state, `In ${state}`);
      results[state] = (await archive(t.app, { ids: [job.id] })).status;
    }
    expect(
      Object.entries(results)
        .filter(([, status]) => status === 409)
        .map(([s]) => s),
    ).toEqual([...ARCHIVE_BLOCKED_STATES]);
    expect(Object.values(results).every((status) => status === 200 || status === 409)).toBe(true);
  });
});
