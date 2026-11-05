import type { JobStepRun, JobStepsResponse, ServerEvent } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { createJobEventsClient } from './job-events';
import { JOB_STEPS_KEY, jobStepsKey, jobStepsQueryOptions } from './job-steps';
import { JOBS_KEY } from './jobs-cache';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  manualTimers,
} from './test-utils';

// The job sheet's steps query: asked only while somebody watches it, and asked again when that
// job (and no other) changes.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

const run: JobStepRun = {
  step: 1,
  runKind: 'edit',
  round: 0,
  startedAt: '2026-10-22T14:30:00.000Z',
  endedAt: '2026-10-22T14:31:00.000Z',
};

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's step runs of two jobs; `calls` counts GET /api/jobs/:id/steps per job. */
function serverSteps() {
  const calls = { [A]: 0, [B]: 0 } as Record<string, number>;
  const runs = { [A]: [run], [B]: [run] } as Record<string, JobStepRun[]>;
  server.use(
    http.get(`${BASE_URL}/api/jobs/:id/steps`, ({ params }) => {
      const id = String(params.id);
      calls[id] = (calls[id] ?? 0) + 1;
      const body: JobStepsResponse = { jobId: id, runs: runs[id] ?? [] };
      return HttpResponse.json(body);
    }),
  );
  return { calls, runs };
}

/** What `useJobSteps(id, { enabled })` does in a component: an observer on the query. */
function watch(jobId: string, enabled = true) {
  const observer = new QueryObserver(queryClient, { ...jobStepsQueryOptions(api, jobId), enabled });
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
const hello: ServerEvent = { type: 'hello' };

describe('jobStepsKey', () => {
  it('is [job-steps, jobId] under its own root', () => {
    expect(JOB_STEPS_KEY).toEqual(['job-steps']);
    expect(jobStepsKey(A)).toEqual(['job-steps', A]);
    expect(jobStepsKey(A)).not.toEqual(jobStepsKey(B));
  });
});

describe('jobStepsQueryOptions', () => {
  it('reads the job’s steps under [job-steps, jobId] and keeps them fresh until an event says otherwise', async () => {
    serverSteps();
    const options = jobStepsQueryOptions(api, A);

    await queryClient.fetchQuery(options);

    expect(options.queryKey).toEqual(['job-steps', A]);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(queryClient.getQueryData(jobStepsKey(A))).toEqual({ jobId: A, runs: [run] });
  });

  it('asks nothing while disabled (a closed sheet)', async () => {
    const state = serverSteps();
    const { stop } = watch(A, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[A]).toBe(0);
    stop();
  });

  it.each([404, 400])(
    'does not ask again after a %s: it will not change by asking',
    async (status) => {
      let calls = 0;
      server.use(
        http.get(`${BASE_URL}/api/jobs/${A}/steps`, () => {
          calls += 1;
          return HttpResponse.json({ error: 'No.' }, { status });
        }),
      );
      // The app's own settings: queries retry for ever; this query must not after a 4xx.
      queryClient.setDefaultOptions({ queries: { retry: true, retryDelay: 1, gcTime: Infinity } });
      const { observer, stop } = watch(A);

      await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toBe(1);
      expect(observer.getCurrentResult().error).toMatchObject({ status, message: 'No.' });
      stop();
    },
  );

  it('asks again after a failure that is not the server saying no (a 500)', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/${A}/steps`, () => {
        calls += 1;
        return calls < 3
          ? HttpResponse.json({ error: 'Oops' }, { status: 500 })
          : HttpResponse.json({ jobId: A, runs: [] });
      }),
    );
    queryClient.setDefaultOptions({ queries: { retry: true, retryDelay: 1, gcTime: Infinity } });
    const { observer, stop } = watch(A);

    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));

    expect(calls).toBe(3);
    stop();
  });
});

describe('the steps and the events', () => {
  it('reads an open sheet’s steps again when that job changes, and only that job’s', async () => {
    const state = serverSteps();
    const open = watch(A);
    const other = watch(B);
    await vi.waitFor(() => expect(open.observer.getCurrentResult().isSuccess).toBe(true));
    await vi.waitFor(() => expect(other.observer.getCurrentResult().isSuccess).toBe(true));
    expect(state.calls).toEqual({ [A]: 1, [B]: 1 });
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: A }), makeJob({ id: B })]);
    const sources = start();

    state.runs[A] = [run, { ...run, step: 2, endedAt: null }];
    sources.latest.emit(upsert(A));

    await vi.waitFor(() => expect(state.calls[A]).toBe(2));
    expect(open.observer.getCurrentResult().data?.runs).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[B]).toBe(1);
    open.stop();
    other.stop();
  });

  it('only marks the steps of a closed sheet stale: they are read when it opens', async () => {
    const state = serverSteps();
    await queryClient.fetchQuery(jobStepsQueryOptions(api, A));
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: A })]);
    const sources = start();

    sources.latest.emit(upsert(A));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(state.calls[A]).toBe(1);
    expect(queryClient.getQueryState(jobStepsKey(A))?.isInvalidated).toBe(true);
    // The sheet opens: the stale steps are read again.
    const { stop } = watch(A);
    await vi.waitFor(() => expect(state.calls[A]).toBe(2));
    stop();
  });

  it('leaves the steps of a job alone when another job changes', async () => {
    serverSteps();
    await queryClient.fetchQuery(jobStepsQueryOptions(api, A));
    await queryClient.fetchQuery(jobStepsQueryOptions(api, B));
    const sources = start();

    sources.latest.emit(upsert(B));

    await vi.waitFor(() =>
      expect(queryClient.getQueryState(jobStepsKey(B))?.isInvalidated).toBe(true),
    );
    expect(queryClient.getQueryState(jobStepsKey(A))?.isInvalidated).toBe(false);
  });

  it('marks every job’s steps stale on a hello (events missed while disconnected)', async () => {
    serverSteps();
    await queryClient.fetchQuery(jobStepsQueryOptions(api, A));
    await queryClient.fetchQuery(jobStepsQueryOptions(api, B));
    const sources = start();

    sources.latest.emit(hello);

    await vi.waitFor(() =>
      expect(queryClient.getQueryState(jobStepsKey(A))?.isInvalidated).toBe(true),
    );
    expect(queryClient.getQueryState(jobStepsKey(B))?.isInvalidated).toBe(true);
  });
});
