import type { Job } from '@studio/shared';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import { JOBS_KEY } from './jobs-cache';
import { REVIEW_EFFORT_FAILED_TEXT, setReviewEffortMutationOptions } from './set-review-effort';
import { BASE_URL, cachedJobs, createTestQueryClient, deferred, makeJob } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

const review = makeJob({
  id: 'review-one',
  state: 'review',
  placeInLine: null,
  reviewEffort: null,
  updatedAt: '2026-10-20T13:30:00.000Z',
});
const other = makeJob({ id: 'other', updatedAt: '2026-10-20T13:10:00.000Z' });

const notify = vi.fn<(message: string, options: { description: string }) => void>();

let queryClient: QueryClient;
beforeEach(() => {
  notify.mockClear();
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [review, other]);
});

const setReviewEffort = (jobId = review.id) =>
  new MutationObserver(
    queryClient,
    setReviewEffortMutationOptions({ queryClient, api, jobId, notify }),
  );

describe('api.saveReviewEffort', () => {
  it('PUTs { effort } as JSON to /api/jobs/:id/review-effort and returns the job', async () => {
    const seen: { method: string; path: string; type: string | null; body: unknown }[] = [];
    const answer: Job = { ...review, reviewEffort: 'high' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async ({ request }) => {
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          type: request.headers.get('content-type'),
          body: await request.json(),
        });
        return HttpResponse.json(answer);
      }),
    );

    await expect(api.saveReviewEffort(review.id, 'high')).resolves.toEqual(answer);

    expect(seen).toEqual([
      {
        method: 'PUT',
        path: `/api/jobs/${review.id}/review-effort`,
        type: 'application/json',
        body: { effort: 'high' },
      },
    ]);
  });

  it('sends "auto" for null, which is Auto', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(review);
      }),
    );
    await api.saveReviewEffort(review.id, null);
    expect(bodies).toEqual([{ effort: 'auto' }]);
  });

  it('puts the id in the path safely', async () => {
    const seen: string[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(review);
      }),
    );
    await api.saveReviewEffort('a/b c', 'medium');
    expect(seen).toEqual(['/api/jobs/a%2Fb%20c/review-effort']);
  });

  it.each([
    [409, 'Cannot change the effort of a job that is not in Review.'],
    [404, 'Quick fixes are off.'],
  ])('keeps the explanation the server gives for a %s', async (status, message) => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, () =>
        HttpResponse.json({ error: message }, { status }),
      ),
    );
    const error = await api.saveReviewEffort(review.id, 'high').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message });
  });
});

describe('setReviewEffortMutationOptions', () => {
  it('shows the level on the cached job at once, before the server has answered', async () => {
    const gate = deferred();
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...review, reviewEffort: 'medium' });
      }),
      http.get(`${BASE_URL}/api/jobs`, () =>
        HttpResponse.json([{ ...review, reviewEffort: 'medium' }, other]),
      ),
    );

    const pending = setReviewEffort().mutate('medium');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cachedJobs(queryClient)).toEqual([{ ...review, reviewEffort: 'medium' }, other]);
    gate.resolve();
    await pending;
  });

  it('sends the level, and null as "auto", and takes the job the server answers with', async () => {
    const bodies: unknown[] = [];
    const answer: Job = { ...review, reviewEffort: 'xhigh', updatedAt: '2026-10-20T13:45:00.000Z' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(answer);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([answer, other])),
    );

    const job = await setReviewEffort().mutate('xhigh');
    expect(job).toEqual(answer);
    expect(cachedJobs(queryClient)).toEqual([answer, other]);

    const back: Job = { ...answer, reviewEffort: null, updatedAt: '2026-10-20T13:50:00.000Z' };
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(back);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([back, other])),
    );
    await setReviewEffort().mutate(null);

    expect(bodies).toEqual([{ effort: 'xhigh' }, { effort: 'auto' }]);
    expect(cachedJobs(queryClient)?.[0]?.reviewEffort).toBeNull();
  });

  it('keeps the list in its order and leaves the other jobs alone', async () => {
    const gate = deferred();
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...review, reviewEffort: 'high' });
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([review, other])),
    );
    const pending = setReviewEffort().mutate('high');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cachedJobs(queryClient)?.map((job) => job.id)).toEqual(['review-one', 'other']);
    expect(cachedJobs(queryClient)?.[1]).toBe(other);
    gate.resolve();
    await pending;
  });

  it('puts the old level back, and passes on the server’s reason, when the server refuses', async () => {
    const before = { ...review, reviewEffort: 'high' } as const;
    queryClient.setQueryData(JOBS_KEY, [before, other]);
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, () =>
        HttpResponse.json(
          { error: 'Cannot change the effort of a job that is not in Review.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([before, other])),
    );

    const failure = await setReviewEffort()
      .mutate(null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 409,
      message: 'Cannot change the effort of a job that is not in Review.',
    });
    expect(cachedJobs(queryClient)?.[0]?.reviewEffort).toBe('high');
    expect(notify.mock.calls).toEqual([
      [
        'Could not change the effort',
        { description: 'Cannot change the effort of a job that is not in Review.' },
      ],
    ]);
    expect(REVIEW_EFFORT_FAILED_TEXT).toBe('Could not change the effort');
  });

  it('says nothing when the server accepts', async () => {
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, () =>
        HttpResponse.json({ ...review, reviewEffort: 'high' }),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([review, other])),
    );
    await setReviewEffort().mutate('high');
    expect(notify).not.toHaveBeenCalled();
  });

  it('changes nothing in the cache for a job it does not hold', async () => {
    const gate = deferred();
    server.use(
      http.put(`${BASE_URL}/api/jobs/:id/review-effort`, async () => {
        await gate.promise;
        return HttpResponse.json({ ...review, id: 'ghost' });
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([review, other])),
    );
    const pending = setReviewEffort('ghost').mutate('medium');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cachedJobs(queryClient)).toEqual([review, other]);
    gate.resolve();
    await pending;
  });
});
