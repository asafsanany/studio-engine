import { QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { notesKey } from './notes-cache';
import { notesQueryOptions } from './notes-query';
import { BASE_URL, createTestQueryClient, makeReviewNote } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const JOB = 'a1b2c3d4e5f6';

describe('notesQueryOptions', () => {
  it('reads the notes of the job under [notes, jobId] and keeps them fresh for ever', async () => {
    const notes = [makeReviewNote({ id: 'n1' }), makeReviewNote({ id: 'n2', atSec: 4 })];
    server.use(http.get(`${BASE_URL}/api/jobs/${JOB}/notes`, () => HttpResponse.json(notes)));
    const queryClient = createTestQueryClient();

    const options = notesQueryOptions(api, JOB);
    await queryClient.fetchQuery(options);

    expect(options.queryKey).toEqual(['notes', JOB]);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(queryClient.getQueryData(notesKey(JOB))).toEqual(notes);
  });

  it.each([409, 404, 400])(
    'does not ask again after a %s: it will not change by asking',
    async (status) => {
      let calls = 0;
      server.use(
        http.get(`${BASE_URL}/api/jobs/${JOB}/notes`, () => {
          calls += 1;
          return HttpResponse.json({ error: 'No.' }, { status });
        }),
      );
      // The app's own settings: queries retry for ever; this query must not.
      const queryClient = createTestQueryClient();
      queryClient.setDefaultOptions({ queries: { retry: true, retryDelay: 1, gcTime: Infinity } });
      const observer = new QueryObserver(queryClient, notesQueryOptions(api, JOB));
      const stop = observer.subscribe(() => {});

      await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toBe(1);
      expect(observer.getCurrentResult().error).toMatchObject({ status, message: 'No.' });
      stop();
    },
  );

  it('asks again after a failure that is not the server saying no (a 500, an engine that is away)', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/${JOB}/notes`, () => {
        calls += 1;
        return calls < 3
          ? HttpResponse.json({ error: 'Internal server error' }, { status: 500 })
          : HttpResponse.json([makeReviewNote()]);
      }),
    );
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: true, retryDelay: 1, gcTime: Infinity } });
    const observer = new QueryObserver(queryClient, notesQueryOptions(api, JOB));
    const stop = observer.subscribe(() => {});

    await vi.waitFor(() => expect(observer.getCurrentResult().data).toHaveLength(1));

    expect(calls).toBe(3);
    stop();
  });
});
