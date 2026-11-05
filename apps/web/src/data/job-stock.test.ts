import type { ServerEvent, StockItem, StockResponse } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { createJobEventsClient } from './job-events';
import { JOB_STOCK_KEY, jobStockKey, jobStockQueryOptions } from './job-stock';
import { JOBS_KEY } from './jobs-cache';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  manualTimers,
} from './test-utils';

// The job sheet's stock query: asked only while somebody watches it, and asked again when that job
// (and no other) changes. A run that takes a sound effect or a photo is a change of the job.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

const item = (id: string): StockItem => ({
  id,
  kind: 'sfx',
  source: 'openverse',
  sourceId: `ov-${id}`,
  file: `${id}.mp3`,
  title: 'Whoosh',
  creator: 'Jane Doe',
  creatorUrl: null,
  license: 'by',
  licenseUrl: null,
  sourceUrl: 'https://openverse.org/audio/x',
  query: 'whoosh',
  run: '',
  durationMs: 1200,
  width: null,
  height: null,
  fetchedAt: '2026-10-25T10:00:00.000Z',
});

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function serverStock() {
  const calls = { [A]: 0, [B]: 0 } as Record<string, number>;
  const items = { [A]: [item('sfx-1')], [B]: [] } as Record<string, StockItem[]>;
  server.use(
    http.get(`${BASE_URL}/api/jobs/:id/stock`, ({ params }) => {
      const id = String(params.id);
      calls[id] = (calls[id] ?? 0) + 1;
      const body: StockResponse = { jobId: id, items: items[id] ?? [] };
      return HttpResponse.json(body);
    }),
  );
  return { calls, items };
}

function watch(jobId: string, enabled = true) {
  const observer = new QueryObserver(queryClient, { ...jobStockQueryOptions(api, jobId), enabled });
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

describe('jobStockKey', () => {
  it('is [job-stock, jobId] under its own root', () => {
    expect(JOB_STOCK_KEY).toEqual(['job-stock']);
    expect(jobStockKey(A)).toEqual(['job-stock', A]);
    expect(jobStockKey(A)).not.toEqual(jobStockKey(B));
  });
});

describe('jobStockQueryOptions', () => {
  it('reads the job’s stock media and keeps it fresh until an event says otherwise', async () => {
    serverStock();
    const options = jobStockQueryOptions(api, A);

    await queryClient.fetchQuery(options);

    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(queryClient.getQueryData(jobStockKey(A))).toEqual({ jobId: A, items: [item('sfx-1')] });
  });

  it('asks nothing while disabled (a closed sheet)', async () => {
    const state = serverStock();
    const { stop } = watch(A, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[A]).toBe(0);
    stop();
  });

  it('does not ask again after a 404: it will not change by asking', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/${A}/stock`, () => {
        calls += 1;
        return HttpResponse.json({ error: 'Job not found' }, { status: 404 });
      }),
    );
    queryClient.setDefaultOptions({ queries: { retry: true, retryDelay: 1, gcTime: Infinity } });
    const { observer, stop } = watch(A);

    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
    stop();
  });
});

describe('the stock media and the events', () => {
  it('reads an open sheet’s stock again when that job changes, and only that job’s', async () => {
    const state = serverStock();
    const open = watch(A);
    const other = watch(B);
    await vi.waitFor(() => expect(open.observer.getCurrentResult().isSuccess).toBe(true));
    await vi.waitFor(() => expect(other.observer.getCurrentResult().isSuccess).toBe(true));
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: A }), makeJob({ id: B })]);
    const sources = start();

    state.items[A] = [item('sfx-1'), item('sfx-2')];
    sources.latest.emit(upsert(A));

    await vi.waitFor(() => expect(state.calls[A]).toBe(2));
    expect(open.observer.getCurrentResult().data?.items).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[B]).toBe(1);
    open.stop();
    other.stop();
  });

  it('only marks a closed sheet’s stock stale, and a reconnect marks every job’s', async () => {
    const state = serverStock();
    await queryClient.fetchQuery(jobStockQueryOptions(api, A));
    await queryClient.fetchQuery(jobStockQueryOptions(api, B));
    queryClient.setQueryData(JOBS_KEY, [makeJob({ id: A }), makeJob({ id: B })]);
    const sources = start();

    sources.latest.emit(upsert(A));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.calls[A]).toBe(1);
    expect(queryClient.getQueryState(jobStockKey(A))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(jobStockKey(B))?.isInvalidated).toBe(false);

    sources.latest.emit({ type: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(queryClient.getQueryState(jobStockKey(B))?.isInvalidated).toBe(true);
  });
});
