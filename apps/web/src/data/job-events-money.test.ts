import type { Job, MoneyResponse, ServerEvent } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import { createJobEventsClient } from './job-events';
import { JOBS_KEY } from './jobs-cache';
import { moneyKey, moneyQueryOptions } from './money-query';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeJob,
  makeMoneyResponse,
  manualTimers,
} from './test-utils';

// The Money page lists every job, not only the delivered ones (U25), so a job that is new, moves
// on or spends money on its shots asks the page for its numbers again, and a progress tick of a
// job it already knows does not.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const MONTH = '2026-10';
const job = makeJob({ id: 'a' });
const upsert = (j: Job): ServerEvent => ({ type: 'job.upsert', job: j });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

async function showMoney() {
  const state = { calls: 0 };
  server.use(
    http.get(`${BASE_URL}/api/money`, () => {
      state.calls += 1;
      return HttpResponse.json(makeMoneyResponse() satisfies MoneyResponse);
    }),
  );
  new QueryObserver(queryClient, moneyQueryOptions(api, MONTH)).subscribe(() => {});
  await vi.waitFor(() => expect(queryClient.getQueryData(moneyKey(MONTH))).toBeDefined());
  expect(state.calls).toBe(1);
  return state;
}

function start() {
  const sources = fakeEventSources();
  createJobEventsClient({
    queryClient,
    eventSourceFactory: sources.factory,
    timers: manualTimers().timers,
    onUnreadableEvent: vi.fn(),
  }).start();
  return sources;
}

describe('the Money page and the job events', () => {
  it('loads the month again for a new job, a job that moved on and a job that is removed', async () => {
    const state = await showMoney();
    queryClient.setQueryData<Job[]>(JOBS_KEY, [job]);
    const sources = start();

    sources.latest.emit(upsert(makeJob({ id: 'new' })));
    await vi.waitFor(() => expect(state.calls).toBe(2));

    sources.latest.emit(upsert({ ...job, state: 'review' }));
    await vi.waitFor(() => expect(state.calls).toBe(3));

    sources.latest.emit({ type: 'job.remove', id: job.id });
    await vi.waitFor(() => expect(state.calls).toBe(4));
  });

  it('does not for the progress tick of a job it already knows', async () => {
    const state = await showMoney();
    queryClient.setQueryData<Job[]>(JOBS_KEY, [job]);
    const sources = start();

    sources.latest.emit(upsert({ ...job, step: 4, updatedAt: '2026-10-20T14:00:05.000Z' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.calls).toBe(1);
  });
});
