import type { Job } from '@studio/shared';
import { onlineManager, QueryObserver, type QueryObserverResult } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApiError, createApi } from './api';
import { JOBS_KEY } from './jobs-cache';
import { jobsQueryOptions, jobsUnreachable, reloadJobs } from './jobs-query';
import {
  createQueryClient,
  RETRY_DELAY_MAX_MS,
  RETRY_DELAY_MIN_MS,
  retryDelay,
} from './query-client';
import { BASE_URL, cachedJobs, createTestQueryClient, makeJob, watchJobs } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const job = makeJob();

describe('jobsQueryOptions', () => {
  it("caches the list under ['jobs'] and never considers it stale on its own", () => {
    const options = jobsQueryOptions(api);
    expect(options.queryKey).toEqual(['jobs']);
    expect(options.queryKey).toEqual(JOBS_KEY);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
  });

  it('fetches the list once however often it is asked for (no polling, no refetch on mount)', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => {
        calls += 1;
        return HttpResponse.json([job]);
      }),
    );
    const queryClient = createTestQueryClient();
    await queryClient.fetchQuery(jobsQueryOptions(api));
    await queryClient.fetchQuery(jobsQueryOptions(api));
    watchJobs(queryClient, api);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    expect(cachedJobs(queryClient)).toEqual([job]);
  });
});

describe('reloadJobs', () => {
  it('fetches the list again even though it is never stale', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => {
        calls += 1;
        return HttpResponse.json(calls === 1 ? [] : [job]);
      }),
    );
    const queryClient = createTestQueryClient();
    watchJobs(queryClient, api);
    await queryClient.fetchQuery(jobsQueryOptions(api));
    await reloadJobs(queryClient);
    expect(calls).toBe(2);
    expect(cachedJobs(queryClient)).toEqual([job]);
  });

  it('does nothing for a list nobody watches', async () => {
    const queryClient = createTestQueryClient();
    await reloadJobs(queryClient); // an unhandled request would fail the test
    expect(cachedJobs(queryClient)).toBeUndefined();
  });
});

describe('retryDelay', () => {
  it('starts short, doubles, and stays at two seconds', () => {
    expect([0, 1, 2, 3, 4, 10].map(retryDelay)).toEqual([500, 1000, 2000, 2000, 2000, 2000]);
    expect(retryDelay(0)).toBe(RETRY_DELAY_MIN_MS);
    expect(retryDelay(1_000)).toBe(RETRY_DELAY_MAX_MS);
  });
});

describe('createQueryClient', () => {
  it('does not retry a failed action, and never gives up on a query', () => {
    const defaults = createQueryClient().getDefaultOptions();
    expect(defaults.mutations?.retry).toBe(false);
    expect(defaults.queries?.retry).toBe(true);
    expect(defaults.queries?.retryDelay).toBe(retryDelay);
  });

  it('asks the local engine even when the browser thinks it is offline', () => {
    expect(createQueryClient().getDefaultOptions().queries?.networkMode).toBe('always');
  });
});

describe('jobsUnreachable', () => {
  const none = undefined;
  it('is false while the first load runs without a failure', () => {
    expect(jobsUnreachable({ data: none, isError: false, failureCount: 0 })).toBe(false);
  });

  it('is true after the first failed fetch, while the query is still retrying', () => {
    expect(jobsUnreachable({ data: none, isError: false, failureCount: 1 })).toBe(true);
    expect(jobsUnreachable({ data: none, isError: false, failureCount: 5 })).toBe(true);
  });

  it('is true for a query that has given up', () => {
    expect(jobsUnreachable({ data: none, isError: true, failureCount: 0 })).toBe(true);
  });

  it('is never true once a list is on screen, whatever fails later', () => {
    expect(jobsUnreachable({ data: [], isError: true, failureCount: 3 })).toBe(false);
    expect(jobsUnreachable({ data: [job], isError: false, failureCount: 1 })).toBe(false);
  });
});

describe('the jobs query while the engine is unreachable', () => {
  /** The app's client with the same policy, only with delays short enough to wait for. */
  function quickRetryClient() {
    const client = createQueryClient();
    const queries = client.getDefaultOptions().queries;
    client.setDefaultOptions({
      ...client.getDefaultOptions(),
      queries: { ...queries, retryDelay: 5 },
    });
    return client;
  }

  it('reports unreachable after the first failed fetch, keeps retrying, and fills in when the engine is back', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => {
        calls += 1;
        return calls <= 3 ? HttpResponse.error() : HttpResponse.json([job]);
      }),
    );
    const observer = new QueryObserver(quickRetryClient(), jobsQueryOptions(api));
    const seen: QueryObserverResult<Job[], ApiError>[] = [];
    const unsubscribe = observer.subscribe((result) => seen.push(result));
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([job]));
      expect(calls).toBe(4);

      // After the first failure the page already says so, and it stays "pending" (never an error
      // status) because the query is going to ask again.
      const firstFailure = seen.find((result) => result.failureCount > 0);
      expect(firstFailure).toBeDefined();
      expect(firstFailure?.failureCount).toBe(1);
      expect(firstFailure?.status).toBe('pending');
      expect(firstFailure?.isError).toBe(false);
      expect(firstFailure && jobsUnreachable(firstFailure)).toBe(true);
      expect(seen.some((result) => result.isError)).toBe(false);

      expect(jobsUnreachable(observer.getCurrentResult())).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('asks even when the browser says it is offline', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs`, () => {
        calls += 1;
        return HttpResponse.json([job]);
      }),
    );
    onlineManager.setOnline(false);
    const observer = new QueryObserver(quickRetryClient(), jobsQueryOptions(api));
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([job]));
      expect(calls).toBe(1);
    } finally {
      unsubscribe();
      onlineManager.setOnline(true);
    }
  });
});
