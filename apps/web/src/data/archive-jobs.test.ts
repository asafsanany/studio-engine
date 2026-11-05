import type { Job } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, createApi } from './api';
import { archiveJobsMutationOptions, unarchiveJobsMutationOptions } from './archive-jobs';
import { JOBS_KEY } from './jobs-cache';
import { BASE_URL, cachedJobs, createTestQueryClient, makeJob, watchJobs } from './test-utils';

// CVP-196: the archive and unarchive mutations put the jobs the server answers with into the jobs
// cache, each where it stands (archiving does not move `updatedAt`), then reload the list.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const archivedAt = '2026-10-21T10:00:00.000Z';
const newest = makeJob({ id: 'newest', state: 'queued', updatedAt: '2026-10-20T13:50:00.000Z' });
const ready = makeJob({
  id: 'ready',
  state: 'ready',
  placeInLine: null,
  updatedAt: '2026-10-20T13:30:00.000Z',
});
const failed = makeJob({
  id: 'failed',
  state: 'failed',
  placeInLine: null,
  updatedAt: '2026-10-20T13:20:00.000Z',
});
const oldest = makeJob({
  id: 'oldest',
  state: 'ready',
  placeInLine: null,
  updatedAt: '2026-10-20T13:10:00.000Z',
});

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [newest, ready, failed, oldest]);
});

const archive = () =>
  new MutationObserver(queryClient, archiveJobsMutationOptions({ queryClient, api }));
const unarchive = () =>
  new MutationObserver(queryClient, unarchiveJobsMutationOptions({ queryClient, api }));

const archivedReady: Job = { ...ready, archivedAt };
const archivedFailed: Job = { ...failed, archivedAt };

describe('archiveJobsMutationOptions', () => {
  it('sends the ids and puts the jobs the server answers with in the cache, each where it stood', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/archive`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ jobs: [archivedFailed, archivedReady] });
      }),
      http.get(`${BASE_URL}/api/jobs`, () =>
        HttpResponse.json([newest, archivedReady, archivedFailed, oldest]),
      ),
    );

    const jobs = await archive().mutate(['failed', 'ready']);

    expect(bodies).toEqual([{ ids: ['failed', 'ready'] }]);
    expect(jobs).toEqual([archivedFailed, archivedReady]);
    // Same order as before: archiving leaves `updatedAt` alone, so each job is swapped in place.
    expect(cachedJobs(queryClient)).toEqual([newest, archivedReady, archivedFailed, oldest]);
  });

  it('shows the archive in the cache as soon as the answer is in, before the list is reloaded', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/archive`, () => HttpResponse.json({ jobs: [archivedReady] })),
      http.get(`${BASE_URL}/api/jobs`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json([newest, archivedReady, failed, oldest]);
      }),
    );
    const stop = watchJobs(queryClient, api);

    await archive().mutate(['ready']);

    expect(cachedJobs(queryClient)?.find((job) => job.id === 'ready')?.archivedAt).toBe(archivedAt);
    stop();
  });

  it('adds a job the cache did not have, and does nothing to a cache that is not loaded yet', async () => {
    const stranger = makeJob({
      id: 'stranger',
      state: 'ready',
      placeInLine: null,
      archivedAt,
      updatedAt: '2026-10-20T13:40:00.000Z',
    });
    server.use(
      http.post(`${BASE_URL}/api/jobs/archive`, () => HttpResponse.json({ jobs: [stranger] })),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([newest, ready, failed, oldest])),
    );

    await archive().mutate(['stranger']);
    expect(cachedJobs(queryClient)?.map((job) => job.id)).toEqual([
      'newest',
      'stranger',
      'ready',
      'failed',
      'oldest',
    ]);

    const empty = createTestQueryClient();
    await new MutationObserver(
      empty,
      archiveJobsMutationOptions({ queryClient: empty, api }),
    ).mutate(['stranger']);
    expect(empty.getQueryData(JOBS_KEY)).toBeUndefined();
  });

  it('rejects with the server’s own words when a job is editing (409), and changes nothing', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/archive`, () =>
        HttpResponse.json(
          { error: 'Can\'t archive "Spring menu" while it is editing.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([newest, ready, failed, oldest])),
    );

    const failure = await archive()
      .mutate(['ready', 'newest'])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 409,
      message: 'Can\'t archive "Spring menu" while it is editing.',
    });
    expect(cachedJobs(queryClient)).toEqual([newest, ready, failed, oldest]);
  });

  it('repairs a cache that was behind when the server refused: the list is reloaded', async () => {
    const editing: Job = { ...ready, state: 'editing', updatedAt: '2026-10-20T13:55:00.000Z' };
    server.use(
      http.post(`${BASE_URL}/api/jobs/archive`, () =>
        HttpResponse.json(
          { error: 'Can\'t archive "Spring menu" while it is editing.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([editing, newest, failed, oldest])),
    );
    const stop = watchJobs(queryClient, api);

    await archive()
      .mutate(['ready'])
      .catch(() => {});

    await expect.poll(() => cachedJobs(queryClient)?.[0]?.state).toBe('editing');
    stop();
  });
});

describe('unarchiveJobsMutationOptions', () => {
  beforeEach(() => {
    queryClient.setQueryData(JOBS_KEY, [newest, archivedReady, archivedFailed, oldest]);
  });

  it('sends the ids and puts the jobs, out of the archive, in the cache where they stood', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/unarchive`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ jobs: [ready, failed] });
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([newest, ready, failed, oldest])),
    );

    const jobs = await unarchive().mutate(['ready', 'failed']);

    expect(bodies).toEqual([{ ids: ['ready', 'failed'] }]);
    expect(jobs).toEqual([ready, failed]);
    expect(cachedJobs(queryClient)).toEqual([newest, ready, failed, oldest]);
    expect(cachedJobs(queryClient)?.map((job) => job.archivedAt)).toEqual([null, null, null, null]);
  });

  it('rejects with the server’s words when a job is gone (404), and changes nothing', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/unarchive`, () =>
        HttpResponse.json({ error: 'Job gone not found' }, { status: 404 }),
      ),
      http.get(`${BASE_URL}/api/jobs`, () =>
        HttpResponse.json([newest, archivedReady, archivedFailed, oldest]),
      ),
    );

    const failure = await unarchive()
      .mutate(['ready', 'gone'])
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 404, message: 'Job gone not found' });
    expect(cachedJobs(queryClient)).toEqual([newest, archivedReady, archivedFailed, oldest]);
  });
});
