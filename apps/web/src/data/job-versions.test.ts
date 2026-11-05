import { type Job, type JobVersion, type ServerEvent, VERSION_MESSAGES } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import { createJobEventsClient } from './job-events';
import {
  JOB_VERSIONS_KEY,
  jobVersionsKey,
  jobVersionsQueryOptions,
  restoreJobVersionMutationOptions,
} from './job-versions';
import { JOBS_KEY } from './jobs-cache';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  makeJobVersion,
  manualTimers,
} from './test-utils';

// The job sheet's versions query and the restore: asked only while somebody watches the list,
// asked again when that job (and no other) changes; a restore puts the job it answers with in the
// list and reads the versions again.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's versions of two jobs; `calls` counts GET /api/jobs/:id/versions per job. */
function serverVersions() {
  const calls = { [A]: 0, [B]: 0 } as Record<string, number>;
  const versions = {
    [A]: [makeJobVersion(2, { current: true }), makeJobVersion(1)],
    [B]: [makeJobVersion(1, { current: true })],
  } as Record<string, JobVersion[]>;
  server.use(
    http.get(`${BASE_URL}/api/jobs/:id/versions`, ({ params }) => {
      const id = String(params.id);
      calls[id] = (calls[id] ?? 0) + 1;
      return HttpResponse.json({ versions: versions[id] ?? [] });
    }),
  );
  return { calls, versions };
}

/** What `useJobVersions(id, { enabled })` does in a component: an observer on the query. */
function watch(jobId: string, enabled = true) {
  const observer = new QueryObserver(queryClient, {
    ...jobVersionsQueryOptions(api, jobId),
    enabled,
  });
  const stop = observer.subscribe(() => {});
  return { observer, stop };
}

function start() {
  const sources = fakeEventSources();
  createJobEventsClient({
    queryClient,
    eventSourceFactory: sources.factory,
    timers: manualTimers().timers,
  }).start();
  return sources;
}

const upsert = (id: string): ServerEvent => ({ type: 'job.upsert', job: makeJob({ id }) });

describe('jobVersionsKey', () => {
  it('is [job-versions, jobId] under its own root', () => {
    expect(JOB_VERSIONS_KEY).toEqual(['job-versions']);
    expect(jobVersionsKey(A)).toEqual(['job-versions', A]);
    expect(jobVersionsKey(A)).not.toEqual(jobVersionsKey(B));
  });
});

describe('jobVersionsQueryOptions', () => {
  it('reads the job’s versions under [job-versions, jobId], fresh until an event says otherwise', async () => {
    const state = serverVersions();
    const options = jobVersionsQueryOptions(api, A);

    await queryClient.fetchQuery(options);

    expect(options.queryKey).toEqual(['job-versions', A]);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(queryClient.getQueryData(jobVersionsKey(A))).toEqual({ versions: state.versions[A] });
  });

  it('asks nothing while disabled (a closed part)', async () => {
    const state = serverVersions();
    const { stop } = watch(A, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[A]).toBe(0);
    stop();
  });

  it('does not ask again after a 404: the job is gone, it will not change by asking', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/${A}/versions`, () => {
        calls += 1;
        return HttpResponse.json({ error: 'Job not found' }, { status: 404 });
      }),
    );
    queryClient.setDefaultOptions({ queries: { retry: true, retryDelay: 1, gcTime: Infinity } });
    const { observer, stop } = watch(A);

    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
    expect(observer.getCurrentResult().error).toMatchObject({ status: 404 });
    stop();
  });
});

describe('the versions and the events', () => {
  it('reads an open part’s versions again when that job changes, and only that job’s', async () => {
    const state = serverVersions();
    const open = watch(A);
    const other = watch(B);
    await vi.waitFor(() => expect(open.observer.getCurrentResult().isSuccess).toBe(true));
    await vi.waitFor(() => expect(other.observer.getCurrentResult().isSuccess).toBe(true));
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: A }), makeJob({ id: B })]);
    const sources = start();

    // A new run ended in Review: a third cut.
    state.versions[A] = [
      makeJobVersion(3, { current: true }),
      makeJobVersion(2),
      makeJobVersion(1),
    ];
    sources.latest.emit(upsert(A));

    await vi.waitFor(() => expect(state.calls[A]).toBe(2));
    expect(open.observer.getCurrentResult().data?.versions).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[B]).toBe(1);
    open.stop();
    other.stop();
  });

  it('only marks the versions of a closed part stale: they are read when it opens', async () => {
    const state = serverVersions();
    await queryClient.fetchQuery(jobVersionsQueryOptions(api, A));
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: A })]);
    const sources = start();

    sources.latest.emit(upsert(A));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(state.calls[A]).toBe(1);
    expect(queryClient.getQueryState(jobVersionsKey(A))?.isInvalidated).toBe(true);
    const { stop } = watch(A);
    await vi.waitFor(() => expect(state.calls[A]).toBe(2));
    stop();
  });

  it('marks every job’s versions stale after a reconnect (hello): cuts may have been made meanwhile', async () => {
    serverVersions();
    await queryClient.fetchQuery(jobVersionsQueryOptions(api, A));
    await queryClient.fetchQuery(jobVersionsQueryOptions(api, B));
    const sources = start();

    sources.latest.emit({ type: 'hello' });

    await vi.waitFor(() => {
      expect(queryClient.getQueryState(jobVersionsKey(A))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(jobVersionsKey(B))?.isInvalidated).toBe(true);
    });
  });
});

describe('restoreJobVersionMutationOptions', () => {
  const restored = makeJob({ id: A, state: 'review', round: 1 });

  it('POSTs the restore, puts the job it answers with in the list and reads the versions again', async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/versions/:n/restore`, ({ request }) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`);
        return HttpResponse.json(restored);
      }),
    );
    const state = serverVersions();
    await queryClient.fetchQuery(jobVersionsQueryOptions(api, A));
    queryClient.setQueryData<Job[]>(JOBS_KEY, [makeJob({ id: A, state: 'review', round: 0 })]);
    const options = restoreJobVersionMutationOptions({ queryClient, api });

    await queryClient.getMutationCache().build(queryClient, options).execute({ id: A, n: 1 });

    expect(seen).toEqual([`POST /api/jobs/${A}/versions/1/restore`]);
    expect(queryClient.getQueryData<Job[]>(JOBS_KEY)?.[0]?.round).toBe(1);
    expect(queryClient.getQueryState(jobVersionsKey(A))?.isInvalidated).toBe(true);
    expect(state.calls[A]).toBe(1);
  });

  it('rejects with the server’s words when the job is not in Review (409)', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/:id/versions/:n/restore`, () =>
        HttpResponse.json({ error: VERSION_MESSAGES.notInReview }, { status: 409 }),
      ),
    );
    const options = restoreJobVersionMutationOptions({ queryClient, api });

    const error = await queryClient
      .getMutationCache()
      .build(queryClient, options)
      .execute({ id: A, n: 1 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: VERSION_MESSAGES.notInReview });
  });
});
