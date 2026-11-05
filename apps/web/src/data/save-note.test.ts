import type { Job } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, createApi } from './api';
import { JOBS_KEY } from './jobs-cache';
import { saveNoteMutationOptions } from './save-note';
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

const saveNote = () =>
  new MutationObserver(queryClient, saveNoteMutationOptions({ queryClient, api }));

describe('saveNoteMutationOptions', () => {
  it('sends the note and puts the job the server answers with in the cache', async () => {
    const bodies: unknown[] = [];
    const answer: Job = {
      ...held,
      note: 'Keep it under 30 seconds.',
      updatedAt: '2026-10-20T13:45:00.000Z',
    };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(answer);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([answer, other])),
    );

    const job = await saveNote().mutate({ id: held.id, note: '  Keep it under 30 seconds.  ' });

    expect(bodies).toEqual([{ note: '  Keep it under 30 seconds.  ' }]);
    // The server's job, trimmed, not what was typed.
    expect(job).toEqual(answer);
    expect(cachedJobs(queryClient)).toEqual([answer, other]);
  });

  it('shows the note in the cache as soon as the answer is in, before the list is reloaded', async () => {
    const answer: Job = { ...held, note: 'A note', updatedAt: '2026-10-20T13:45:00.000Z' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, () => HttpResponse.json(answer)),
      // The reload is slow; the marker must not wait for it.
      http.get(`${BASE_URL}/api/jobs`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json([answer, other]);
      }),
    );
    const stop = watchJobs(queryClient, api);

    await saveNote().mutate({ id: held.id, note: 'A note' });

    expect(cachedJobs(queryClient)?.find((j) => j.id === held.id)?.note).toBe('A note');
    stop();
  });

  it('reloads the list afterwards, so the cache ends up as the server has it', async () => {
    const answer: Job = { ...held, note: 'A note', updatedAt: '2026-10-20T13:45:00.000Z' };
    // By the time the list is reloaded the job has moved on (the worker released it).
    const later: Job = { ...answer, state: 'queued', updatedAt: '2026-10-20T13:46:00.000Z' };
    let reloads = 0;
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, () => HttpResponse.json(answer)),
      http.get(`${BASE_URL}/api/jobs`, () => {
        reloads += 1;
        return HttpResponse.json([later, other]);
      }),
    );
    const stop = watchJobs(queryClient, api);

    await saveNote().mutate({ id: held.id, note: 'A note' });

    await expect.poll(() => reloads).toBeGreaterThanOrEqual(1);
    await expect.poll(() => cachedJobs(queryClient)?.[0]?.state).toBe('queued');
    stop();
  });

  it('rejects with the server’s own words when the job is editing (409), and changes nothing', async () => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, () =>
        HttpResponse.json(
          { error: 'Cannot edit the note of a job that is editing.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([held, other])),
    );

    const failure = await saveNote()
      .mutate({ id: held.id, note: 'Too late' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 409,
      message: 'Cannot edit the note of a job that is editing.',
    });
    expect(cachedJobs(queryClient)).toEqual([held, other]);
  });

  it('repairs a cache that was behind when the server refused: the list is reloaded', async () => {
    // The page thought the job was held; the server has it editing.
    const editing: Job = { ...held, state: 'editing', updatedAt: '2026-10-20T13:50:00.000Z' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, () =>
        HttpResponse.json(
          { error: 'Cannot edit the note of a job that is editing.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([editing, other])),
    );
    const stop = watchJobs(queryClient, api);

    await saveNote()
      .mutate({ id: held.id, note: 'x' })
      .catch(() => {});

    await expect.poll(() => cachedJobs(queryClient)?.[0]?.state).toBe('editing');
    stop();
  });

  it.each([
    [404, 'No such job.'],
    [400, 'The note can be at most 4000 characters.'],
  ])('rejects an answer of %s with its text', async (status, error) => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/note`, () => HttpResponse.json({ error }, { status })),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([held, other])),
    );
    await expect(saveNote().mutate({ id: held.id, note: 'x' })).rejects.toMatchObject({
      status,
      message: error,
    });
  });
});
