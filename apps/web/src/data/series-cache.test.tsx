import type {
  HealthResponse,
  Job,
  SeriesResponse,
  SeriesSummary,
  ServerEvent,
} from '@studio/shared';
import { type QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_KEY } from './health-query';
import { createJobEventsClient } from './job-events';
import { JOBS_KEY } from './jobs-cache';
import { createSeriesApi } from './series-api';
import { applySeries, changesSeriesCounts, clientSeriesKey, seriesKey } from './series-cache';
import {
  seriesFormatMutationOptions,
  setJobSeriesMutationOptions,
  undoSeriesMutationOptions,
} from './series-mutations';
import {
  clientSeriesQueryOptions,
  seriesEnabled,
  seriesQueryOptions,
  useClientSeries,
  useSeriesEnabled,
} from './series-query';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeEpisodeJob,
  makeJob,
  makeSeries,
  makeSeriesResponse,
  makeSeriesSummary,
  manualTimers,
  SERIES_CLIENT,
  seriesByState,
} from './test-utils';

// The series caches follow the series and job events: each event only says "this changed", so the
// queries ask again. Series are off by default, so nothing is asked until the health answer says on.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createSeriesApi({ baseUrl: BASE_URL });
const SERIES_ID = makeSeries().id;
const CLIENT_ID = SERIES_CLIENT.clientId;

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** The server's series: `calls` counts the requests of each route. */
function serverSeries(list: SeriesSummary[] = [makeSeriesSummary()], one = makeSeriesResponse()) {
  const calls = { list: 0, one: 0 };
  server.use(
    http.get(`${BASE_URL}/api/clients/:clientId/series`, () => {
      calls.list += 1;
      return HttpResponse.json({ series: list });
    }),
    http.get(`${BASE_URL}/api/series/:seriesId`, () => {
      calls.one += 1;
      return HttpResponse.json(one);
    }),
  );
  return calls;
}

/** A page showing the client's series and the series page: observers on both, loaded. */
async function showSeries(calls: { list: number; one: number }) {
  new QueryObserver(queryClient, clientSeriesQueryOptions(api, CLIENT_ID)).subscribe(() => {});
  new QueryObserver(queryClient, seriesQueryOptions(api, SERIES_ID)).subscribe(() => {});
  await vi.waitFor(() => {
    expect(queryClient.getQueryData(clientSeriesKey(CLIENT_ID))).toBeDefined();
    expect(queryClient.getQueryData(seriesKey(SERIES_ID))).toBeDefined();
  });
  expect(calls).toEqual({ list: 1, one: 1 });
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

describe('the series events', () => {
  it('series.changed loads the series and its client’s list again', async () => {
    const calls = serverSeries();
    await showSeries(calls);
    const sources = start();

    sources.latest.emit({ type: 'series.changed', series: seriesByState.learning });

    await vi.waitFor(() => expect(calls).toEqual({ list: 2, one: 2 }));
  });

  it('series.removed drops the series and loads the client’s list again', async () => {
    const calls = serverSeries();
    await showSeries(calls);
    const sources = start();
    server.use(
      http.get(`${BASE_URL}/api/series/:seriesId`, () =>
        HttpResponse.json({ error: `Series ${SERIES_ID} not found` }, { status: 404 }),
      ),
    );

    sources.latest.emit({ type: 'series.removed', seriesId: SERIES_ID, clientId: CLIENT_ID });

    await vi.waitFor(() => {
      expect(calls.list).toBe(2);
      expect(queryClient.getQueryState(seriesKey(SERIES_ID))?.status).toBe('error');
    });
    expect(queryClient.getQueryData(seriesKey(SERIES_ID))).toBeUndefined();
  });

  it('hello loads every series query again', async () => {
    const calls = serverSeries();
    await showSeries(calls);
    server.use(http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([])));
    const sources = start();

    sources.latest.emit({ type: 'hello' } satisfies ServerEvent);

    await vi.waitFor(() => expect(calls).toEqual({ list: 2, one: 2 }));
  });

  it('a job joining or leaving a series loads its client’s list again; other changes do not', async () => {
    const calls = serverSeries();
    await showSeries(calls);
    const plain = makeJob({ ...SERIES_CLIENT, id: '6554b401d32d', name: 'מיתוס או אמת 6' });
    queryClient.setQueryData<Job[]>(JOBS_KEY, [plain]);
    const sources = start();

    sources.latest.emit({ type: 'job.upsert', job: { ...plain, etaSec: 30 } });
    sources.latest.emit({ type: 'job.upsert', job: makeEpisodeJob() });
    await vi.waitFor(() => expect(calls.list).toBe(2));

    sources.latest.emit({ type: 'job.remove', id: plain.id });
    await vi.waitFor(() => expect(calls.list).toBe(3));
    expect(calls.one).toBe(1);
  });

  it('changesSeriesCounts: new episodes, joins, leaves and moves count; the rest does not', () => {
    const episode = makeEpisodeJob();
    expect(changesSeriesCounts(undefined, episode)).toBe(true);
    expect(changesSeriesCounts(undefined, makeJob())).toBe(false);
    expect(changesSeriesCounts(makeJob(), makeJob({ etaSec: 1 }))).toBe(false);
    expect(changesSeriesCounts(episode, { ...episode, seriesId: null })).toBe(true);
    expect(changesSeriesCounts(episode, { ...episode, seriesId: 'other' })).toBe(true);
    expect(changesSeriesCounts(episode, { ...episode, episode: 7 })).toBe(false);
  });
});

describe('the series actions', () => {
  it('applySeries writes the answered series over the cached one and keeps its markdown', () => {
    const cached = makeSeriesResponse();
    queryClient.setQueryData<SeriesResponse>(seriesKey(SERIES_ID), cached);

    applySeries(queryClient, seriesByState.learning);

    expect(queryClient.getQueryData(seriesKey(SERIES_ID))).toEqual({
      series: seriesByState.learning,
      markdown: cached.markdown,
    });
  });

  it('Use as the series format applies the series it answers', async () => {
    server.use(
      http.post(`${BASE_URL}/api/series/:seriesId/format`, () =>
        HttpResponse.json({ series: seriesByState.learning }, { status: 202 }),
      ),
    );
    queryClient.setQueryData<SeriesResponse>(seriesKey(SERIES_ID), makeSeriesResponse());
    const options = seriesFormatMutationOptions({ queryClient, api });

    const series = await queryClient
      .getMutationCache()
      .build(queryClient, options)
      .execute({ seriesId: SERIES_ID, jobId: '6554b401d32d' });

    expect(series).toEqual(seriesByState.learning);
    expect(queryClient.getQueryData<SeriesResponse>(seriesKey(SERIES_ID))?.series.state).toBe(
      'learning',
    );
  });

  it('putting a job in a series puts the answered job in the jobs cache', async () => {
    const episode = makeEpisodeJob();
    server.use(http.put(`${BASE_URL}/api/jobs/:jobId/series`, () => HttpResponse.json(episode)));
    queryClient.setQueryData<Job[]>(JOBS_KEY, [{ ...episode, seriesId: null, episode: null }]);
    const options = setJobSeriesMutationOptions({ queryClient, api });

    await queryClient
      .getMutationCache()
      .build(queryClient, options)
      .execute({ jobId: episode.id, seriesId: SERIES_ID });

    expect(queryClient.getQueryData<Job[]>(JOBS_KEY)).toEqual([episode]);
  });

  it('Undo drops the series', async () => {
    server.use(
      http.post(`${BASE_URL}/api/series/:seriesId/undo`, () => HttpResponse.json({ ok: true })),
    );
    queryClient.setQueryData<SeriesResponse>(seriesKey(SERIES_ID), makeSeriesResponse());
    const options = undoSeriesMutationOptions({ queryClient, api });

    await queryClient
      .getMutationCache()
      .build(queryClient, options)
      .execute({ seriesId: SERIES_ID, clientId: CLIENT_ID });

    expect(queryClient.getQueryData(seriesKey(SERIES_ID))).toBeUndefined();
  });
});

describe('whether series are on', () => {
  const health: HealthResponse = {
    ok: true,
    version: '0.7.7',
    settleMs: 60_000,
    series: false,
    jobSheet: false,
    analytics: false,
    phone: false,
    graphics: false,
    graphicsInEdits: false,
    music: false,
    luts: false,
    lutsInEdits: false,
    fonts: false,
    fontsInNotes: false,
    quickFixes: false,
  };

  function render(ui: ReactNode): string {
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    );
  }

  function Enabled() {
    return <p>{String(useSeriesEnabled())}</p>;
  }

  function Names() {
    const { data, fetchStatus } = useClientSeries(CLIENT_ID);
    return <p>{data ? data.map((one) => one.name).join(',') : `none ${fetchStatus}`}</p>;
  }

  it('is off until the health answer says on', () => {
    expect(seriesEnabled(undefined)).toBe(false);
    expect(seriesEnabled(health)).toBe(false);
    expect(seriesEnabled({ ...health, series: true })).toBe(true);

    expect(render(<Enabled />)).toBe('<p>false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, series: true });
    expect(render(<Enabled />)).toBe('<p>true</p>');
  });

  it('asks nothing while off; reads the cached list once on', () => {
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render(<Names />)).toBe('<p>none idle</p>');

    queryClient.setQueryData(HEALTH_KEY, { ...health, series: true });
    queryClient.setQueryData(clientSeriesKey(CLIENT_ID), [makeSeriesSummary()]);
    expect(render(<Names />)).toBe('<p>מיתוס או אמת</p>');
  });
});
