import {
  apiErrorSchema,
  GENERATE_MESSAGES,
  type GenerateHistoryEvent,
  generateHistoryResponseSchema,
  generateResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { GenerateRepository, JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { createGenerateService, disabledGenerateService } from '../generate/generate-service.js';
import { ROUTE_POLICIES } from '../team/route-policies.js';

// Generated videos, GN0: GET /api/jobs/:id/generate answers the job's Generate state (200), or 404 for
// a job that has none and for an unknown job. With the switch off the route does not exist.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const EVENTS: GenerateHistoryEvent[] = [
  { kind: 'decided', at: '2026-10-25T14:00:00.000Z', formats: ['9:16', '1:1'] },
  { kind: 'voice', at: '2026-10-25T14:03:00.000Z', lines: 7, seconds: 31 },
];

function harness({ generate = true }: { generate?: boolean } = {}) {
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { generate });
  const repo = new GenerateRepository(db);
  const generated = jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad')).job;
  const plain = jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo 2')).job;
  repo.start(generated.id, 3);
  repo.update(generated.id, {
    phase: 'clips',
    voice: { done: 7, total: 7 },
    looks: { done: 3, total: 3 },
    keyframes: { done: 7, total: 7 },
    clips: { done: 4, total: 6 },
    spendUsd: 1.65,
  });
  const app: Hono = createApp({
    jobs: { jobs, exportsDir: '/tmp/exports' },
    generate,
    generateRoutes: {
      jobs,
      generate: generate
        ? createGenerateService(repo, { history: async () => EVENTS })
        : disabledGenerateService,
    },
  });
  return { app, generated, plain };
}

describe('GET /api/jobs/:id/generate', () => {
  it('answers 200 with the job’s Generate state', async () => {
    const { app, generated } = harness();

    const res = await app.request(`/api/jobs/${generated.id}/generate`);

    expect(res.status).toBe(200);
    expect(generateResponseSchema.parse(await res.json())).toEqual({
      phase: 'clips',
      counts: {
        voice: { done: 7, total: 7 },
        looks: { done: 3, total: 3 },
        keyframes: { done: 7, total: 7 },
        clips: { done: 4, total: 6 },
        belowBar: 0,
      },
      spendUsd: 1.65,
      budgetUsd: 3,
    });
  });

  it('answers 404 "This job is not a generated video." for a job with no Generate stage', async () => {
    const { app, plain } = harness();

    const res = await app.request(`/api/jobs/${plain.id}/generate`);

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({
      error: GENERATE_MESSAGES.notGenerated,
    });
  });

  it('answers 404 for a job that does not exist', async () => {
    const { app } = harness();

    const res = await app.request('/api/jobs/000000000000/generate');

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toBe('Job 000000000000 not found');
  });

  it('is the job in the list too: the job carries its state', async () => {
    const { app, generated, plain } = harness();

    const res = await app.request('/api/jobs');
    const list = (await res.json()) as { id: string; generate?: unknown }[];

    expect(list.find((job) => job.id === generated.id)?.generate).toMatchObject({
      phase: 'clips',
      spendUsd: 1.65,
    });
    expect(list.find((job) => job.id === plain.id)).not.toHaveProperty('generate');
  });

  it('does not exist while the switch is off: the ordinary 404, and the job has no state', async () => {
    const { app, generated } = harness({ generate: false });

    const res = await app.request(`/api/jobs/${generated.id}/generate`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    const list = (await (await app.request('/api/jobs')).json()) as object[];
    for (const job of list) expect(job).not.toHaveProperty('generate');
    const health = (await (await app.request('/api/health')).json()) as { generate: boolean };
    expect(health.generate).toBe(false);
  });

  it('only answers GET', async () => {
    const { app, generated } = harness();
    const res = await app.request(`/api/jobs/${generated.id}/generate`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/jobs/:id/generate/history (GN5)', () => {
  it('answers the events of the stage, oldest first', async () => {
    const { app, generated } = harness();

    const res = await app.request(`/api/jobs/${generated.id}/generate/history`);

    expect(res.status).toBe(200);
    expect(generateHistoryResponseSchema.parse(await res.json())).toEqual({ events: EVENTS });
  });

  it('answers 404 for a job with no Generate stage and for one that does not exist', async () => {
    const { app, plain } = harness();

    const none = await app.request(`/api/jobs/${plain.id}/generate/history`);
    expect(none.status).toBe(404);
    expect(apiErrorSchema.parse(await none.json())).toEqual({
      error: GENERATE_MESSAGES.notGenerated,
    });

    const gone = await app.request('/api/jobs/000000000000/generate/history');
    expect(gone.status).toBe(404);
    expect(apiErrorSchema.parse(await gone.json()).error).toBe('Job 000000000000 not found');
  });

  it('does not exist while the switch is off', async () => {
    const { app, generated } = harness({ generate: false });
    const res = await app.request(`/api/jobs/${generated.id}/generate/history`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});

describe('the route policy', () => {
  it('lets an editor reach the route only for a job of their clients', () => {
    expect(ROUTE_POLICIES.filter((row) => row.pattern === '/api/jobs/:id/generate')).toEqual([
      { method: 'GET', pattern: '/api/jobs/:id/generate', policy: 'job' },
    ]);
    expect(
      ROUTE_POLICIES.filter((row) => row.pattern === '/api/jobs/:id/generate/history'),
    ).toEqual([{ method: 'GET', pattern: '/api/jobs/:id/generate/history', policy: 'job' }]);
  });
});
