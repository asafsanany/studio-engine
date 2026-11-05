import { SERIES_MESSAGES } from '@studio/shared';
import { HttpResponse, http, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, UNREADABLE_MESSAGE } from './api';
import { createSeriesApi } from './series-api';
import {
  BASE_URL,
  makeEpisodeJob,
  makeSeriesResponse,
  makeSeriesSummary,
  SERIES_CLIENT,
  seriesByState,
} from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createSeriesApi({ baseUrl: BASE_URL });
const SERIES_ID = '622212180eef';
const JOB_ID = '6554b401d32d';

/** Records each request's method, path and JSON body, and answers `body` with `status`. */
function record(method: 'get' | 'post' | 'put', path: string, body: JsonBodyType, status = 200) {
  const seen: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http[method](`${BASE_URL}${path}`, async ({ request }) => {
      const text = await request.text();
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text === '' ? null : JSON.parse(text),
      });
      return HttpResponse.json(body, { status });
    }),
  );
  return seen;
}

describe('the series API, one call per route', () => {
  it('GET /api/clients/:clientId/series lists the client’s series', async () => {
    const body = { series: [makeSeriesSummary()] };
    const seen = record('get', '/api/clients/:clientId/series', body);
    await expect(api.listClientSeries(SERIES_CLIENT.clientId)).resolves.toEqual(body);
    expect(seen).toEqual([
      { method: 'GET', path: `/api/clients/${SERIES_CLIENT.clientId}/series`, body: null },
    ]);
  });

  it('GET /api/series/:seriesId answers the series and its series.md', async () => {
    const body = makeSeriesResponse();
    const seen = record('get', '/api/series/:seriesId', body);
    await expect(api.getSeries(SERIES_ID)).resolves.toEqual(body);
    expect(seen[0]?.path).toBe(`/api/series/${SERIES_ID}`);
  });

  it('POST /api/jobs/:jobId/series starts a series with { name }', async () => {
    const body = { series: seriesByState.learning };
    const seen = record('post', '/api/jobs/:jobId/series', body, 202);
    await expect(api.startSeries('947ef344672b', 'מיתוס או אמת')).resolves.toEqual(body);
    expect(seen).toEqual([
      { method: 'POST', path: '/api/jobs/947ef344672b/series', body: { name: 'מיתוס או אמת' } },
    ]);
  });

  it('POST /api/series/:seriesId/format sends { jobId }', async () => {
    const body = { series: seriesByState.learning };
    const seen = record('post', '/api/series/:seriesId/format', body, 202);
    await expect(api.useAsFormat(SERIES_ID, JOB_ID)).resolves.toEqual(body);
    expect(seen).toEqual([
      { method: 'POST', path: `/api/series/${SERIES_ID}/format`, body: { jobId: JOB_ID } },
    ]);
  });

  it('PUT /api/jobs/:jobId/series sends { seriesId } or null, and answers the job', async () => {
    const job = makeEpisodeJob();
    const seen = record('put', '/api/jobs/:jobId/series', job);
    await expect(api.setJobSeries(JOB_ID, SERIES_ID)).resolves.toEqual(job);
    await expect(api.setJobSeries(JOB_ID, null)).resolves.toEqual(job);
    expect(seen.map((one) => one.body)).toEqual([{ seriesId: SERIES_ID }, { seriesId: null }]);
    expect(seen[0]).toMatchObject({ method: 'PUT', path: `/api/jobs/${JOB_ID}/series` });
  });

  it('POST /api/series/:seriesId/undo and /retry', async () => {
    const undo = record('post', '/api/series/:seriesId/undo', { ok: true });
    const retry = record(
      'post',
      '/api/series/:seriesId/retry',
      { series: seriesByState.learning },
      202,
    );
    await expect(api.undoSeries(SERIES_ID)).resolves.toBeUndefined();
    await expect(api.retrySeries(SERIES_ID)).resolves.toEqual({ series: seriesByState.learning });
    expect(undo[0]?.path).toBe(`/api/series/${SERIES_ID}/undo`);
    expect(retry[0]?.path).toBe(`/api/series/${SERIES_ID}/retry`);
  });

  it('escapes the ids', async () => {
    const seen = record('get', '/api/series/:seriesId', makeSeriesResponse());
    await api.getSeries('a b/c');
    expect(seen[0]?.path).toBe('/api/series/a%20b%2Fc');
  });
});

describe('the series API, refusals', () => {
  it('rejects with the server’s words and status: 404 while series are off, 422 for a name', async () => {
    record('get', '/api/clients/:clientId/series', { error: SERIES_MESSAGES.off }, 404);
    await expect(api.listClientSeries('c1')).rejects.toMatchObject({
      status: 404,
      message: 'Series are off.',
    });
    record('post', '/api/jobs/:jobId/series', { error: SERIES_MESSAGES.nameTaken }, 422);
    const refused = await api.startSeries('j1', 'Weekly').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      status: 422,
      message: 'A series with this name already exists.',
    });
  });

  it('rejects an answer that is not a series', async () => {
    record('get', '/api/series/:seriesId', { series: { id: SERIES_ID } });
    await expect(api.getSeries(SERIES_ID)).rejects.toMatchObject({
      status: 200,
      message: UNREADABLE_MESSAGE,
    });
  });
});
