import type { Job } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, createApi } from './api';
import { JOBS_KEY } from './jobs-cache';
import { saveEffortMutationOptions } from './save-effort';
import { BASE_URL, cachedJobs, createTestQueryClient, makeJob, watchJobs } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const held = makeJob({
  id: 'held-one',
  state: 'held',
  placeInLine: null,
  updatedAt: '2026-10-20T13:30:00.000Z',
});
const other = makeJob({ id: 'other', updatedAt: '2026-10-20T13:10:00.000Z' });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [held, other]);
});

const saveEffort = () =>
  new MutationObserver(queryClient, saveEffortMutationOptions({ queryClient, api }));

describe('saveEffortMutationOptions', () => {
  it('sends the level and puts the job the server answers with in the cache', async () => {
    const bodies: unknown[] = [];
    const answer: Job = { ...held, effort: 'xhigh', updatedAt: '2026-10-20T13:45:00.000Z' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(answer);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([answer, other])),
    );

    const job = await saveEffort().mutate({ id: held.id, effort: 'xhigh' });

    expect(bodies).toEqual([{ effort: 'xhigh' }]);
    expect(job).toEqual(answer);
    expect(cachedJobs(queryClient)).toEqual([answer, other]);
  });

  it('sends null to put a job back on Default', async () => {
    const bodies: unknown[] = [];
    const before = { ...held, effort: 'xhigh' } as const;
    queryClient.setQueryData(JOBS_KEY, [before, other]);
    const answer: Job = { ...held, effort: null, updatedAt: '2026-10-20T13:45:00.000Z' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(answer);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([answer, other])),
    );

    await saveEffort().mutate({ id: held.id, effort: null });

    expect(bodies).toEqual([{ effort: null }]);
    expect(cachedJobs(queryClient)?.find((j) => j.id === held.id)?.effort).toBeNull();
  });

  it('shows the level in the cache as soon as the answer is in, before the list is reloaded', async () => {
    const answer: Job = { ...held, effort: 'medium', updatedAt: '2026-10-20T13:45:00.000Z' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, () => HttpResponse.json(answer)),
      http.get(`${BASE_URL}/api/jobs`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json([answer, other]);
      }),
    );
    const stop = watchJobs(queryClient, api);

    await saveEffort().mutate({ id: held.id, effort: 'medium' });

    expect(cachedJobs(queryClient)?.find((j) => j.id === held.id)?.effort).toBe('medium');
    stop();
  });

  it('rejects with the server’s own words when the job is editing (409), and changes nothing', async () => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, () =>
        HttpResponse.json(
          { error: 'Cannot change the effort of a job that is editing.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([held, other])),
    );

    const failure = await saveEffort()
      .mutate({ id: held.id, effort: 'xhigh' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 409,
      message: 'Cannot change the effort of a job that is editing.',
    });
    expect(cachedJobs(queryClient)).toEqual([held, other]);
  });

  it('repairs a cache that was behind when the server refused: the list is reloaded', async () => {
    const editing: Job = { ...held, state: 'editing', updatedAt: '2026-10-20T13:50:00.000Z' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/effort`, () =>
        HttpResponse.json(
          { error: 'Cannot change the effort of a job that is editing.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([editing, other])),
    );
    const stop = watchJobs(queryClient, api);

    await saveEffort()
      .mutate({ id: held.id, effort: 'xhigh' })
      .catch(() => {});

    await expect.poll(() => cachedJobs(queryClient)?.[0]?.state).toBe('editing');
    stop();
  });
});
