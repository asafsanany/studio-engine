import { FIX_MESSAGES, type Job, type JobEvent, jobSchema } from '@studio/shared';
import type { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository } from '../db/index.js';
import { type FakeClock, fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// PUT /api/jobs/:id/review-effort (Quick fixes, QF4): Review's own effort, Auto by default. The real
// repository on an in-memory database and the real routes.

interface Harness {
  app: Hono;
  jobs: JobRepository;
  clock: FakeClock;
  /** What `onJobChanged` was called with. */
  changed: Job[];
}

function harness({ quickFixes }: { quickFixes: boolean }): Harness {
  const clock = fakeClock();
  const jobs = new JobRepository(memoryDb(), { clock });
  const changed: Job[] = [];
  const app = createApp({
    quickFixes,
    jobs: {
      jobs,
      exportsDir: '/nonexistent/exports',
      onJobChanged: (job) => {
        changed.push(job);
      },
    },
  });
  return { app, jobs, clock, changed };
}

const PATHS: Partial<Record<Job['state'], JobEvent[]>> = {
  arriving: [],
  queued: [{ type: 'SETTLED' }],
  held: [{ type: 'HOLD' }],
  editing: [{ type: 'SETTLED' }, { type: 'START' }],
  review: [
    { type: 'SETTLED' },
    { type: 'START' },
    { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
  ],
  failed: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'FAIL', step: 4, error: 'boom' }],
  cancelled: [{ type: 'SETTLED' }, { type: 'START' }, { type: 'CANCEL' }],
};

function seed(h: Harness, state: Job['state'], name = 'Spring menu'): Job {
  const { job } = h.jobs.upsertFromScan(makeScan('Northwind Bakery', name));
  for (const event of PATHS[state] ?? []) h.jobs.applyTransition(job.id, event);
  return h.jobs.get(job.id) as Job;
}

function put(app: Hono, id: string, body: unknown): Response | Promise<Response> {
  return app.request(`/api/jobs/${id}/review-effort`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('PUT /api/jobs/:id/review-effort', () => {
  it.each(['medium', 'high', 'xhigh'] as const)(
    'saves %s on a job in review and answers with the job',
    async (effort) => {
      const h = harness({ quickFixes: true });
      const job = seed(h, 'review');
      h.clock.tick(5000);

      const res = await put(h.app, job.id, { effort });

      expect(res.status).toBe(200);
      const body = jobSchema.parse(await res.json());
      expect(body).toEqual({ ...job, reviewEffort: effort, updatedAt: h.clock().toISOString() });
      expect(h.jobs.get(job.id)?.reviewEffort).toBe(effort);
    },
  );

  it('saves auto as null, and a level can be taken back to Auto', async () => {
    const h = harness({ quickFixes: true });
    const job = seed(h, 'review');
    await put(h.app, job.id, { effort: 'high' });
    expect(h.jobs.get(job.id)?.reviewEffort).toBe('high');

    const res = await put(h.app, job.id, { effort: 'auto' });

    expect(res.status).toBe(200);
    expect(jobSchema.parse(await res.json()).reviewEffort).toBeNull();
    expect(h.jobs.get(job.id)?.reviewEffort).toBeNull();
  });

  it('leaves the first edit’s effort alone, and the level stays on the job for later rounds', async () => {
    const h = harness({ quickFixes: true });
    const job = seed(h, 'review');
    h.jobs.setEffort(job.id, 'medium');

    await put(h.app, job.id, { effort: 'xhigh' });

    expect(h.jobs.get(job.id)).toMatchObject({ effort: 'medium', reviewEffort: 'xhigh' });
    // It is the job's setting, not Review's: the job moving on does not clear it.
    h.jobs.applyTransition(job.id, { type: 'SEND_NOTES' });
    expect(h.jobs.get(job.id)?.reviewEffort).toBe('xhigh');
  });

  it('publishes the job once, with the new effort', async () => {
    const h = harness({ quickFixes: true });
    const job = seed(h, 'review');

    await put(h.app, job.id, { effort: 'high' });

    expect(h.changed.map((changed) => [changed.id, changed.reviewEffort])).toEqual([
      [job.id, 'high'],
    ]);
  });

  it.each(['arriving', 'queued', 'held', 'editing', 'failed', 'cancelled'] as const)(
    'answers 409 for a job that is %s, and changes nothing',
    async (state) => {
      const h = harness({ quickFixes: true });
      const job = seed(h, state);

      const res = await put(h.app, job.id, { effort: 'high' });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: FIX_MESSAGES.effortNotInReview });
      expect(h.jobs.get(job.id)).toEqual(job);
      expect(h.changed).toEqual([]);
    },
  );

  it('answers 404 for a job that does not exist', async () => {
    const h = harness({ quickFixes: true });

    const res = await put(h.app, 'nosuchjob000', { effort: 'high' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Job nosuchjob000 not found' });
  });

  it.each([
    ['null', { effort: null }],
    ['a word that is not a level', { effort: 'max' }],
    ['Auto with a capital', { effort: 'Auto' }],
    ['no effort', {}],
    ['a number', { effort: 3 }],
    ['not JSON', 'effort=high'],
    ['an array', [{ effort: 'high' }]],
  ])('answers 400 for %s', async (_name, body) => {
    const h = harness({ quickFixes: true });
    const job = seed(h, 'review');

    const res = await put(h.app, job.id, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Send the effort as JSON: { "effort": "auto" | "medium" | "high" | "xhigh" }.',
    });
    expect(h.jobs.get(job.id)?.reviewEffort).toBeNull();
  });

  it('answers 404 "Quick fixes are off." while the switch is off, whatever the job or the body', async () => {
    const h = harness({ quickFixes: false });
    const job = seed(h, 'review');

    for (const [id, body] of [
      [job.id, { effort: 'high' }],
      [job.id, 'nonsense'],
      ['nosuchjob000', { effort: 'auto' }],
    ] as const) {
      const res = await put(h.app, id, body);
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: 'Quick fixes are off.' });
    }
    expect(h.jobs.get(job.id)?.reviewEffort).toBeNull();
    expect(h.changed).toEqual([]);
  });

  it('is off when the app is not told the switch is on', async () => {
    const clock = fakeClock();
    const jobs = new JobRepository(memoryDb(), { clock });
    const app = createApp({ jobs: { jobs, exportsDir: '/nonexistent/exports' } });
    const { job } = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));

    const res = await put(app, job.id, { effort: 'high' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: FIX_MESSAGES.off });
  });

  it('does not touch the other effort route, which still sets the first edit’s level', async () => {
    const h = harness({ quickFixes: true });
    const job = seed(h, 'review');

    const res = await h.app.request(`/api/jobs/${job.id}/effort`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'high' }),
    });

    expect(res.status).toBe(200);
    expect(h.jobs.get(job.id)).toMatchObject({ effort: 'high', reviewEffort: null });
  });
});
