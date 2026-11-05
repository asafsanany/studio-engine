import {
  apiErrorSchema,
  clientSeriesResponseSchema,
  SERIES_MESSAGES,
  type SeriesSummary,
  seriesActionResponseSchema,
  seriesNameProblem,
  seriesNotFoundMessage,
  seriesResponseSchema,
  setJobSeriesResponseSchema,
  undoSeriesResponseSchema,
} from '@studio/shared';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import {
  disabledSeriesService,
  type SeriesService,
  seriesOk,
  seriesRefusal,
} from '../clients/series-service.js';
import { fakeSeriesService, makeSeries } from '../clients/test-utils.js';
import { makeJob } from '../events/test-utils.js';
import type { AppEnv } from '../remote/viewer.js';
import { createSeriesRoutes } from './series.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The series routes over K0's fake series service: each test gives the service the answer it
// should give and checks what the route asks of it and what it sends back. The rules themselves
// (the 409s, the Undo window, the switch) are the service's, so a refusal here is the service's
// word passed on with its status.

const SERIES = makeSeries();
const CLIENT_ID = SERIES.clientId;
const JOB_ID = 'a1b2c3d4e5f6';

function harness(answers: Parameters<typeof fakeSeriesService>[0] = {}) {
  const fake = fakeSeriesService(answers);
  const app = createApp({ series: { series: fake.service } });
  return { ...fake, app };
}

function send(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: string | object,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Response | Promise<Response> {
  return app.request(`/api${path}`, {
    method,
    headers,
    body: typeof body === 'object' ? JSON.stringify(body) : body,
  });
}

const summary = (overrides: Partial<SeriesSummary> = {}): SeriesSummary => ({
  id: SERIES.id,
  name: SERIES.name,
  state: 'ready',
  error: null,
  formatJobId: SERIES.formatJobId,
  formatJob: SERIES.formatJob,
  version: 1,
  updatedAt: SERIES.updatedAt,
  episodeCount: 4,
  lastEpisodeAt: '2026-10-21T12:00:00.000Z',
  ...overrides,
});

describe('GET /api/clients/:clientId/series', () => {
  it("answers the client's series, asking the service for that client", async () => {
    const { app, calls } = harness({
      list: async () => seriesOk({ series: [summary(), summary({ id: 'b', name: 'Other' })] }),
    });

    const response = await send(app, 'GET', `/clients/${CLIENT_ID}/series`);

    expect(response.status).toBe(200);
    const body = clientSeriesResponseSchema.parse(await response.json());
    expect(body.series.map((entry) => entry.name)).toEqual([SERIES.name, 'Other']);
    expect(calls).toEqual([{ method: 'list', args: [CLIENT_ID] }]);
  });

  it('answers an empty list for a client with none', async () => {
    const { app } = harness({ list: async () => seriesOk({ series: [] }) });

    const response = await send(app, 'GET', `/clients/${CLIENT_ID}/series`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ series: [] });
  });
});

describe('GET /api/series/:seriesId', () => {
  it('answers the series and its series.md', async () => {
    const { app, calls } = harness({
      get: async () => seriesOk({ series: SERIES, markdown: '# Series: מיתוס או אמת\n' }),
    });

    const response = await send(app, 'GET', `/series/${SERIES.id}`);

    expect(response.status).toBe(200);
    expect(seriesResponseSchema.parse(await response.json())).toEqual({
      series: SERIES,
      markdown: '# Series: מיתוס או אמת\n',
    });
    expect(calls).toEqual([{ method: 'get', args: [SERIES.id] }]);
  });

  it('answers markdown null while there is no series.md', async () => {
    const learning = makeSeries({ state: 'learning' });
    const { app } = harness({ get: async () => seriesOk({ series: learning, markdown: null }) });

    const response = await send(app, 'GET', `/series/${learning.id}`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { markdown: unknown }).markdown).toBeNull();
  });

  it('answers 404 for a series it does not know', async () => {
    const { app } = harness({
      get: async (id) => seriesRefusal(404, seriesNotFoundMessage(id)),
    });

    const response = await send(app, 'GET', '/series/nope');

    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json())).toEqual({
      error: 'Series nope not found',
    });
  });
});

describe('POST /api/jobs/:jobId/series (Start a series)', () => {
  it('starts a series from the job and answers 202 with it, learning', async () => {
    const learning = makeSeries({ state: 'learning', formatJobId: JOB_ID });
    const { app, calls } = harness({ start: async () => seriesOk({ series: learning }, 202) });

    const response = await send(app, 'POST', `/jobs/${JOB_ID}/series`, { name: SERIES.name });

    expect(response.status).toBe(202);
    expect(seriesActionResponseSchema.parse(await response.json())).toEqual({ series: learning });
    expect(calls).toEqual([{ method: 'start', args: [JOB_ID, SERIES.name] }]);
  });

  it('hands the name to the service as it came, for the service to trim and normalise', async () => {
    const { app, calls } = harness({ start: async () => seriesOk({ series: SERIES }, 202) });

    await send(app, 'POST', `/jobs/${JOB_ID}/series`, { name: '  מיתוס או אמת  ' });

    expect(calls[0]?.args).toEqual([JOB_ID, '  מיתוס או אמת  ']);
  });

  it.each([
    ['not JSON', 'name=x'],
    ['an empty body', ''],
    ['JSON that is not an object', '"a name"'],
    ['null', 'null'],
    ['an object without a name', '{}'],
    ['a name that is not text', '{"name": 5}'],
    ['a name of null', '{"name": null}'],
  ])(
    'answers 400 with the shape to send for %s, without asking the service',
    async (_label, body) => {
      const { app, calls } = harness();

      const response = await send(app, 'POST', `/jobs/${JOB_ID}/series`, body);

      expect(response.status).toBe(400);
      expect(apiErrorSchema.parse(await response.json())).toEqual({
        error: SERIES_MESSAGES.startBody,
      });
      expect(calls).toEqual([]);
    },
  );

  it('reads a JSON body whatever its content-type says', async () => {
    const { app, calls } = harness({ start: async () => seriesOk({ series: SERIES }, 202) });

    const response = await send(app, 'POST', `/jobs/${JOB_ID}/series`, '{"name": "Show"}', {
      'content-type': 'text/plain',
    });

    expect(response.status).toBe(202);
    expect(calls[0]?.args).toEqual([JOB_ID, 'Show']);
  });

  describe('the 422 name rules (the service applies seriesNameProblem; the route sends its words)', () => {
    const answers = {
      start: async (_jobId: string, name: string) => {
        const problem = seriesNameProblem(name);
        return problem === null ? seriesOk({ series: SERIES }, 202) : seriesRefusal(422, problem);
      },
    };

    it.each([
      ['empty', '', 'Give the series a name.'],
      ['blank', '   ', 'Give the series a name.'],
      ['with a slash', 'Myth / Fact', 'A series name can’t contain / or :.'],
      ['with a colon', 'Myth: Fact', 'A series name can’t contain / or :.'],
      ['starting with a dot', '.hidden', 'A series name can’t start with . or _.'],
      ['starting with an underscore', '_Series', 'A series name can’t start with . or _.'],
    ])('answers 422 for a name that is %s', async (_label, name, error) => {
      const { app } = harness(answers);

      const response = await send(app, 'POST', `/jobs/${JOB_ID}/series`, { name });

      expect(response.status).toBe(422);
      expect(apiErrorSchema.parse(await response.json())).toEqual({ error });
    });

    it('answers 422 for a name the client has already', async () => {
      const { app } = harness({
        start: async () => seriesRefusal(422, SERIES_MESSAGES.nameTaken),
      });

      const response = await send(app, 'POST', `/jobs/${JOB_ID}/series`, { name: SERIES.name });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: SERIES_MESSAGES.nameTaken });
    });
  });

  it.each([
    ['the job is not ready', SERIES_MESSAGES.notFinished],
    ['the job is in a series already', SERIES_MESSAGES.alreadyInSeries],
    ['a series pass of the client is running', SERIES_MESSAGES.seriesBusy],
  ])('answers 409 when %s', async (_label, error) => {
    const { app } = harness({ start: async () => seriesRefusal(409, error) });

    const response = await send(app, 'POST', `/jobs/${JOB_ID}/series`, { name: 'Show' });

    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await response.json())).toEqual({ error });
  });

  it('answers 404 for a job it does not know', async () => {
    const { app } = harness({
      start: async (jobId) => seriesRefusal(404, `Job ${jobId} not found`),
    });

    const response = await send(app, 'POST', '/jobs/nope/series', { name: 'Show' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Job nope not found' });
  });
});

describe('POST /api/series/:seriesId/format (Use as the series format)', () => {
  it('queues the format pass and answers 202 with the series, learning', async () => {
    const learning = makeSeries({ state: 'learning' });
    const { app, calls } = harness({
      useAsFormat: async () => seriesOk({ series: learning }, 202),
    });

    const response = await send(app, 'POST', `/series/${SERIES.id}/format`, { jobId: JOB_ID });

    expect(response.status).toBe(202);
    expect(seriesActionResponseSchema.parse(await response.json())).toEqual({ series: learning });
    expect(calls).toEqual([{ method: 'useAsFormat', args: [SERIES.id, JOB_ID] }]);
  });

  it.each([
    ['not JSON', 'jobId=x'],
    ['an empty body', ''],
    ['an object without a jobId', '{}'],
    ['an empty jobId', '{"jobId": ""}'],
    ['a jobId that is not text', '{"jobId": 7}'],
    ['null', 'null'],
  ])(
    'answers 400 with the shape to send for %s, without asking the service',
    async (_label, body) => {
      const { app, calls } = harness();

      const response = await send(app, 'POST', `/series/${SERIES.id}/format`, body);

      expect(response.status).toBe(400);
      expect(apiErrorSchema.parse(await response.json())).toEqual({
        error: SERIES_MESSAGES.formatBody,
      });
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ['the job is not a ready episode of the series', SERIES_MESSAGES.notReadyEpisode],
    ['the job is the format already', SERIES_MESSAGES.formatAlready],
    ['a style pass of the client is running', SERIES_MESSAGES.styleBusy],
    ['a series pass of the client is running', SERIES_MESSAGES.seriesBusy],
  ])('answers 409 when %s', async (_label, error) => {
    const { app } = harness({ useAsFormat: async () => seriesRefusal(409, error) });

    const response = await send(app, 'POST', `/series/${SERIES.id}/format`, { jobId: JOB_ID });

    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await response.json())).toEqual({ error });
  });

  it('answers 404 for a series or a job it does not know', async () => {
    const { app } = harness({
      useAsFormat: async (seriesId) => seriesRefusal(404, seriesNotFoundMessage(seriesId)),
    });

    const response = await send(app, 'POST', '/series/nope/format', { jobId: JOB_ID });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Series nope not found' });
  });
});

describe('PUT /api/jobs/:jobId/series (put a job in a series)', () => {
  it('puts the job in the series and answers 200 with the job', async () => {
    const job = makeJob({ id: JOB_ID, seriesId: SERIES.id, episode: 6 });
    const { app, calls } = harness({ setJobSeries: async () => seriesOk(job) });

    const response = await send(app, 'PUT', `/jobs/${JOB_ID}/series`, { seriesId: SERIES.id });

    expect(response.status).toBe(200);
    const body = setJobSeriesResponseSchema.parse(await response.json());
    expect(body.seriesId).toBe(SERIES.id);
    expect(body.episode).toBe(6);
    expect(calls).toEqual([{ method: 'setJobSeries', args: [JOB_ID, SERIES.id] }]);
  });

  it('takes the job out of its series for { seriesId: null }', async () => {
    const job = makeJob({ id: JOB_ID, seriesId: null, episode: null });
    const { app, calls } = harness({ setJobSeries: async () => seriesOk(job) });

    const response = await send(app, 'PUT', `/jobs/${JOB_ID}/series`, { seriesId: null });

    expect(response.status).toBe(200);
    expect(setJobSeriesResponseSchema.parse(await response.json()).seriesId).toBeNull();
    expect(calls).toEqual([{ method: 'setJobSeries', args: [JOB_ID, null] }]);
  });

  it.each([
    ['not JSON', 'series=x'],
    ['an empty body', ''],
    ['an object without a seriesId', '{}'],
    ['an empty seriesId', '{"seriesId": ""}'],
    ['a seriesId that is not text or null', '{"seriesId": 3}'],
    ['null', 'null'],
  ])(
    'answers 400 with the shape to send for %s, without asking the service',
    async (_label, body) => {
      const { app, calls } = harness();

      const response = await send(app, 'PUT', `/jobs/${JOB_ID}/series`, body);

      expect(response.status).toBe(400);
      expect(apiErrorSchema.parse(await response.json())).toEqual({
        error: SERIES_MESSAGES.setBody,
      });
      expect(calls).toEqual([]);
    },
  );

  it('answers 409 for a job whose edit has started', async () => {
    const { app } = harness({
      setJobSeries: async () => seriesRefusal(409, SERIES_MESSAGES.jobStarted),
    });

    const response = await send(app, 'PUT', `/jobs/${JOB_ID}/series`, { seriesId: SERIES.id });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: SERIES_MESSAGES.jobStarted });
  });

  it("answers 422 for another client's series", async () => {
    const { app } = harness({
      setJobSeries: async () => seriesRefusal(422, SERIES_MESSAGES.otherClient),
    });

    const response = await send(app, 'PUT', `/jobs/${JOB_ID}/series`, { seriesId: SERIES.id });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: SERIES_MESSAGES.otherClient });
  });

  it('answers 404 for a job or a series it does not know', async () => {
    const { app } = harness({
      setJobSeries: async (jobId) => seriesRefusal(404, `Job ${jobId} not found`),
    });

    const response = await send(app, 'PUT', '/jobs/nope/series', { seriesId: null });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Job nope not found' });
  });
});

describe('POST /api/series/:seriesId/undo', () => {
  it('undoes the start and answers 200 { ok: true }', async () => {
    const { app, calls } = harness({ undoStart: async () => seriesOk({ ok: true }) });

    const response = await send(app, 'POST', `/series/${SERIES.id}/undo`);

    expect(response.status).toBe(200);
    expect(undoSeriesResponseSchema.parse(await response.json())).toEqual({ ok: true });
    expect(calls).toEqual([{ method: 'undoStart', args: [SERIES.id] }]);
  });

  it('answers 409 once the 10 s are over', async () => {
    const { app } = harness({
      undoStart: async () => seriesRefusal(409, SERIES_MESSAGES.undoTooLate),
    });

    const response = await send(app, 'POST', `/series/${SERIES.id}/undo`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: SERIES_MESSAGES.undoTooLate });
  });

  it('answers 404 for a series it does not know', async () => {
    const { app } = harness({
      undoStart: async (id) => seriesRefusal(404, seriesNotFoundMessage(id)),
    });

    const response = await send(app, 'POST', '/series/nope/undo');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Series nope not found' });
  });
});

describe('POST /api/series/:seriesId/retry', () => {
  it('runs the failed pass again and answers 202 with the series, learning', async () => {
    const learning = makeSeries({ state: 'learning' });
    const { app, calls } = harness({ retry: async () => seriesOk({ series: learning }, 202) });

    const response = await send(app, 'POST', `/series/${SERIES.id}/retry`);

    expect(response.status).toBe(202);
    expect(seriesActionResponseSchema.parse(await response.json())).toEqual({ series: learning });
    expect(calls).toEqual([{ method: 'retry', args: [SERIES.id] }]);
  });

  it.each([
    ['the series has not failed', SERIES_MESSAGES.notFailed],
    ['a style pass of the client is running', SERIES_MESSAGES.styleBusy],
    ['a series pass of the client is running', SERIES_MESSAGES.seriesBusy],
  ])('answers 409 when %s', async (_label, error) => {
    const { app } = harness({ retry: async () => seriesRefusal(409, error) });

    const response = await send(app, 'POST', `/series/${SERIES.id}/retry`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
  });

  it('answers 404 for a series it does not know', async () => {
    const { app } = harness({
      retry: async (id) => seriesRefusal(404, seriesNotFoundMessage(id)),
    });

    const response = await send(app, 'POST', '/series/nope/retry');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Series nope not found' });
  });
});

describe('while the Series switch is off', () => {
  const app = createApp({ series: { series: disabledSeriesService } });

  it.each([
    ['GET', `/clients/${CLIENT_ID}/series`, undefined],
    ['GET', `/series/${SERIES.id}`, undefined],
    ['POST', `/jobs/${JOB_ID}/series`, { name: 'Show' }],
    ['POST', `/series/${SERIES.id}/format`, { jobId: JOB_ID }],
    ['PUT', `/jobs/${JOB_ID}/series`, { seriesId: SERIES.id }],
    ['POST', `/series/${SERIES.id}/undo`, undefined],
    ['POST', `/series/${SERIES.id}/retry`, undefined],
  ])('%s %s answers 404 "Series are off."', async (method, path, body) => {
    const response = await send(app, method, path, body);

    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(await response.json())).toEqual({ error: 'Series are off.' });
  });

  it('still answers 400 to a body that does not fit: the route reads the body before the service', async () => {
    const response = await send(app, 'POST', `/jobs/${JOB_ID}/series`, '{}');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: SERIES_MESSAGES.startBody });
  });
});

describe('the app around the routes', () => {
  it('answers 500 { error } when the service itself fails, not a stack trace', async () => {
    const failing: SeriesService = {
      ...disabledSeriesService,
      get: async () => {
        throw new Error('database is locked');
      },
    };
    const app = createApp({ series: { series: failing } });

    const response = await send(app, 'GET', `/series/${SERIES.id}`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('has no series routes without the series option (a test app)', async () => {
    const response = await createApp().request(`/api/series/${SERIES.id}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('reports the switch on /api/health', async () => {
    const on = await createApp({ series: { series: fakeSeriesService().service } }).request(
      '/api/health',
    );
    const off = await createApp({ series: { series: disabledSeriesService } }).request(
      '/api/health',
    );

    expect(((await on.json()) as { series: boolean }).series).toBe(true);
    expect(((await off.json()) as { series: boolean }).series).toBe(false);
  });
});

describe('PUT /api/jobs/:jobId/series for an editor', () => {
  // The answer is a job; an editor's carries no money (C41). The route is mounted alone, with the
  // viewer the app's middleware would have put there.
  const paid = makeJob({
    id: JOB_ID,
    state: 'held',
    delivery: { deliveredAt: '2026-10-21T09:00:00.000Z', price: 40, currency: 'ILS', paidOn: null },
  });

  async function putAs(role: 'admin' | 'editor') {
    const fake = fakeSeriesService({ setJobSeries: async () => seriesOk(paid) });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('viewer', { email: 'x@example.com', name: 'X', role, via: 'tailscale' });
      await next();
    });
    app.route('/', createSeriesRoutes({ series: fake.service }));
    const res = await app.request(`/jobs/${JOB_ID}/series`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seriesId: null }),
    });
    return (await res.json()) as typeof paid;
  }

  it('leaves the price, currency and pay date out', async () => {
    expect((await putAs('editor')).delivery).toEqual({ deliveredAt: '2026-10-21T09:00:00.000Z' });
  });

  it('keeps them for the admin', async () => {
    expect((await putAs('admin')).delivery).toEqual(paid.delivery);
  });
});
