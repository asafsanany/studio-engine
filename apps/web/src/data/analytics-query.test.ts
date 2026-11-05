import type { AnalyticsResponse, ServerEvent } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_KEY,
  ANALYTICS_RELOAD_DELAY_MS,
  ANALYTICS_RELOAD_MAX_WAIT_MS,
  analyticsKey,
  analyticsQueryOptions,
  cancelAnalyticsReload,
  reloadAnalytics,
} from './analytics-query';
import { ApiError, createApi, UNREACHABLE_MESSAGE, UNREADABLE_MESSAGE } from './api';
import { createJobEventsClient } from './job-events';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeAnalyticsResponse,
  makeJob,
  manualTimers,
} from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});
afterEach(() => {
  cancelAnalyticsReload(queryClient);
  vi.useRealTimers();
});

/**
 * The server's answer; `asked` counts the GETs of /api/analytics, `periods` says what each one
 * asked for. With no `answer` it answers the period it is asked for.
 */
function serverAnalytics(answer?: AnalyticsResponse) {
  const state = { answer, asked: 0, periods: [] as (string | null)[] };
  server.use(
    http.get(`${BASE_URL}/api/analytics`, ({ request }) => {
      state.asked += 1;
      const period = new URL(request.url).searchParams.get('period');
      state.periods.push(period);
      return HttpResponse.json(
        state.answer ?? makeAnalyticsResponse({ period: period === 'week' ? 'week' : 'month' }),
      );
    }),
  );
  return state;
}

describe('api.getAnalytics', () => {
  it('GETs /api/analytics and parses the answer', async () => {
    const answer = makeAnalyticsResponse();
    const state = serverAnalytics(answer);

    await expect(api.getAnalytics('month')).resolves.toEqual(answer);
    expect(state.asked).toBe(1);
  });

  it('asks for the period: ?period=week or ?period=month', async () => {
    const state = serverAnalytics();

    const week = await api.getAnalytics('week');
    const month = await api.getAnalytics('month');

    expect(state.periods).toEqual(['week', 'month']);
    expect(week.period).toBe('week');
    expect(month.period).toBe('month');
    expect(week.jobs.tiles[0]?.series).toHaveLength(14);
    expect(month.jobs.tiles[0]?.series).toHaveLength(8);
  });

  it('rejects a week answer whose series are the month’s length', async () => {
    const answer = { ...makeAnalyticsResponse(), period: 'week' as const };
    serverAnalytics(answer);

    await expect(api.getAnalytics('week')).rejects.toMatchObject({ message: UNREADABLE_MESSAGE });
  });

  it('keeps the gaps: a missing value is null, not 0', async () => {
    serverAnalytics();

    const answer = await api.getAnalytics('month');

    expect(answer.jobs.tiles[0]?.value).toBeNull();
    expect(answer.jobs.deliveredPerDay[0]?.count).toBeNull();
  });

  it('rejects with an ApiError when the answer is not an Analytics answer', async () => {
    server.use(http.get(`${BASE_URL}/api/analytics`, () => HttpResponse.json({ jobs: {} })));

    const error = await api.getAnalytics('month').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: UNREADABLE_MESSAGE });
  });

  it('rejects when a series has the wrong number of values', async () => {
    const answer = makeAnalyticsResponse();
    answer.jobs.deliveredPerDay.pop();
    server.use(http.get(`${BASE_URL}/api/analytics`, () => HttpResponse.json(answer)));

    await expect(api.getAnalytics('month')).rejects.toMatchObject({ message: UNREADABLE_MESSAGE });
  });

  it('rejects with the server’s words while the switch is off on the engine (404)', async () => {
    server.use(
      http.get(`${BASE_URL}/api/analytics`, () =>
        HttpResponse.json({ error: 'Not found' }, { status: 404 }),
      ),
    );

    await expect(api.getAnalytics('month')).rejects.toMatchObject({
      status: 404,
      message: 'Not found',
    });
  });

  it('says the server cannot be reached when it is not there', async () => {
    const offline = createApi({
      baseUrl: BASE_URL,
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    await expect(offline.getAnalytics('month')).rejects.toMatchObject({
      status: 0,
      message: UNREACHABLE_MESSAGE,
    });
  });
});

describe('analyticsQueryOptions', () => {
  it("caches each period's answer under ['analytics', period]", async () => {
    serverAnalytics();

    expect(ANALYTICS_KEY).toEqual(['analytics']);
    expect(analyticsKey('week')).toEqual(['analytics', 'week']);
    expect(analyticsQueryOptions(api, 'month').queryKey).toEqual(['analytics', 'month']);
    expect(analyticsQueryOptions(api, 'week').queryKey).toEqual(['analytics', 'week']);
    await queryClient.fetchQuery(analyticsQueryOptions(api, 'month'));
    await queryClient.fetchQuery(analyticsQueryOptions(api, 'week'));

    expect(queryClient.getQueryData<AnalyticsResponse>(analyticsKey('month'))?.period).toBe(
      'month',
    );
    expect(queryClient.getQueryData<AnalyticsResponse>(analyticsKey('week'))?.period).toBe('week');
  });

  it('asks again for the other period, once, and not for one it has', async () => {
    const state = serverAnalytics();

    await queryClient.fetchQuery(analyticsQueryOptions(api, 'month'));
    await queryClient.fetchQuery(analyticsQueryOptions(api, 'week'));
    await queryClient.fetchQuery(analyticsQueryOptions(api, 'month'));
    await queryClient.fetchQuery(analyticsQueryOptions(api, 'week'));

    expect(state.periods).toEqual(['month', 'week']);
  });

  it('keeps the page that was on screen while the other period loads', async () => {
    const state = serverAnalytics();
    const month = new QueryObserver(queryClient, analyticsQueryOptions(api, 'month'));
    const stop = month.subscribe(() => {});
    await vi.waitFor(() => expect(month.getCurrentResult().data?.period).toBe('month'));
    state.answer = undefined;

    // The same observer, now looking at the week: its first result still holds the month.
    month.setOptions(analyticsQueryOptions(api, 'week'));
    const loading = month.getCurrentResult();
    expect(loading.isPlaceholderData).toBe(true);
    expect(loading.data?.period).toBe('month');

    await vi.waitFor(() => expect(month.getCurrentResult().data?.period).toBe('week'));
    expect(month.getCurrentResult().isPlaceholderData).toBe(false);
    stop();
  });

  it('is fresh until the server says otherwise: a second look does not ask again', async () => {
    const state = serverAnalytics();

    await queryClient.fetchQuery(analyticsQueryOptions(api, 'month'));
    await queryClient.fetchQuery(analyticsQueryOptions(api, 'month'));

    expect(state.asked).toBe(1);
  });
});

describe('reloadAnalytics', () => {
  /** An answer in the cache, and a spy on what is invalidated. */
  function cached(period: 'week' | 'month' = 'month') {
    queryClient.setQueryData(analyticsKey(period), makeAnalyticsResponse({ period }));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const times = () =>
      invalidate.mock.calls.filter(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(ANALYTICS_KEY),
      ).length;
    return { times };
  }

  it('waits a moment, then loads the numbers again', () => {
    vi.useFakeTimers();
    const { times } = cached();

    reloadAnalytics(queryClient);
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS - 1);
    expect(times()).toBe(0);
    vi.advanceTimersByTime(1);

    expect(times()).toBe(1);
  });

  it('joins a burst of changes into one load, after the burst', () => {
    vi.useFakeTimers();
    const { times } = cached();

    for (let i = 0; i < 20; i += 1) {
      reloadAnalytics(queryClient);
      vi.advanceTimersByTime(100);
    }
    // The last change was 100 ms ago: the wait started again with it.
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS - 101);
    expect(times()).toBe(0);
    vi.advanceTimersByTime(1);

    expect(times()).toBe(1);
  });

  it('does not wait for ever on a stream that never goes quiet', () => {
    vi.useFakeTimers();
    const { times } = cached();

    // A change every second for 25 seconds.
    for (let i = 0; i < 25; i += 1) {
      reloadAnalytics(queryClient);
      vi.advanceTimersByTime(1_000);
    }

    expect(times()).toBe(2);
    expect(ANALYTICS_RELOAD_MAX_WAIT_MS).toBeGreaterThan(ANALYTICS_RELOAD_DELAY_MS);
  });

  it('asks again for a change that comes after the load', () => {
    vi.useFakeTimers();
    const { times } = cached();

    reloadAnalytics(queryClient);
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS);
    reloadAnalytics(queryClient);
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS);

    expect(times()).toBe(2);
  });

  it('loads the numbers again for the period that is open, and marks the other one stale', async () => {
    const state = serverAnalytics();
    const observer = new QueryObserver(queryClient, analyticsQueryOptions(api, 'week'));
    const stop = observer.subscribe(() => {});
    await queryClient.fetchQuery(analyticsQueryOptions(api, 'month'));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.period).toBe('week'));
    expect([...state.periods].sort()).toEqual(['month', 'week']);

    reloadAnalytics(queryClient, 10);

    // The open one (week) is asked for again; the month, which nobody shows, only goes stale.
    await vi.waitFor(() => expect(state.periods.filter((p) => p === 'week')).toHaveLength(2));
    expect(state.periods.filter((p) => p === 'month')).toHaveLength(1);
    expect(queryClient.getQueryState(analyticsKey('month'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(analyticsKey('week'))?.isInvalidated).toBe(false);
    stop();
  });

  it('counts the numbers of either period as loaded', () => {
    vi.useFakeTimers();
    const { times } = cached('week');

    reloadAnalytics(queryClient);
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS);

    expect(times()).toBe(1);
  });

  it('does nothing, and leaves no timer, while the numbers were never loaded', () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    reloadAnalytics(queryClient);

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS * 2);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const { times } = cached();

    reloadAnalytics(queryClient);
    cancelAnalyticsReload(queryClient);
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS * 2);

    expect(times()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one wait per client', () => {
    vi.useFakeTimers();
    const other = createTestQueryClient();
    other.setQueryData(analyticsKey('month'), makeAnalyticsResponse());
    const { times } = cached();
    const otherInvalidate = vi.spyOn(other, 'invalidateQueries');

    reloadAnalytics(queryClient);
    reloadAnalytics(other);
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS);

    expect(times()).toBe(1);
    expect(otherInvalidate).toHaveBeenCalledTimes(1);
  });

  it('shows the new numbers on a page that is open', async () => {
    const state = serverAnalytics();
    const observer = new QueryObserver(queryClient, analyticsQueryOptions(api, 'month'));
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(state.asked).toBe(1));
    state.answer = { ...makeAnalyticsResponse(), timeZone: 'America/New_York' };

    reloadAnalytics(queryClient, 10);

    await vi.waitFor(() =>
      expect(queryClient.getQueryData<AnalyticsResponse>(analyticsKey('month'))?.timeZone).toBe(
        'America/New_York',
      ),
    );
    expect(state.asked).toBe(2);
    stop();
  });

  it('marks the numbers stale for a page that is not open, to be loaded when it opens', async () => {
    const state = serverAnalytics();
    await queryClient.fetchQuery(analyticsQueryOptions(api, 'month'));

    reloadAnalytics(queryClient, 10);
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(analyticsKey('month'))?.isInvalidated).toBe(true),
    );

    expect(state.asked).toBe(1);
  });
});

describe('the events client and the Analytics page', () => {
  function start() {
    const sources = fakeEventSources();
    const client = createJobEventsClient({
      queryClient,
      eventSourceFactory: sources.factory,
      timers: manualTimers().timers,
    });
    client.start();
    return sources;
  }

  function watch() {
    vi.useFakeTimers();
    queryClient.setQueryData(analyticsKey('month'), makeAnalyticsResponse());
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    return () =>
      invalidate.mock.calls.filter(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(ANALYTICS_KEY),
      ).length;
  }

  it.each<[string, ServerEvent]>([
    ['a job change', { type: 'job.upsert', job: makeJob() }],
    ['a job removed', { type: 'job.remove', id: 'a1b2c3d4e5f6' }],
    ['money.changed', { type: 'money.changed' }],
    ['hello', { type: 'hello' }],
  ])('%s loads the numbers again, after a moment', (_name, event) => {
    const times = watch();
    const sources = start();

    sources.latest.emit(event);
    expect(times()).toBe(0);
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS);

    expect(times()).toBe(1);
  });

  it('asks once for the many job updates of a running edit', () => {
    const times = watch();
    const sources = start();

    for (let i = 0; i < 10; i += 1) {
      sources.latest.emit({ type: 'job.upsert', job: makeJob({ subProgress: `${i}/10` }) });
      vi.advanceTimersByTime(500);
    }
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS);

    expect(times()).toBe(1);
  });

  it('leaves the numbers alone for events that are not about them', () => {
    const times = watch();
    const sources = start();

    sources.latest.emit({ type: 'client.removed', clientId: 'c1', client: 'Northwind Bakery' });
    sources.latest.emit({ type: 'series.removed', seriesId: 's1', clientId: 'c1' });
    vi.advanceTimersByTime(ANALYTICS_RELOAD_DELAY_MS * 2);

    expect(times()).toBe(0);
  });

  it('does nothing when the Analytics page was never opened', () => {
    vi.useFakeTimers();
    const sources = start();

    sources.latest.emit({ type: 'money.changed' });

    expect(vi.getTimerCount()).toBe(0);
  });
});
