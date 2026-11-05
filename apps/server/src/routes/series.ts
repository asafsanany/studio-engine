// The series API (Series plan §5), mounted at /api:
//
//   GET  /clients/:clientId/series   the client's series                         200 { series }
//   GET  /series/:seriesId           the series and its series.md                200 { series, markdown }
//   POST /jobs/:jobId/series         body { name }: Start a series               202 { series }
//   POST /series/:seriesId/format    body { jobId }: Use as the series format    202 { series }
//   PUT  /jobs/:jobId/series         body { seriesId | null }: the job's series  200 job
//   POST /series/:seriesId/undo      Undo of Start a series                      200 { ok: true }
//   POST /series/:seriesId/retry     the failed series pass again                202 { series }
//
// The rules live in the series service (clients/series-service.ts), whose answers carry their
// status; this file is HTTP only. 400 for a body that is not JSON of the right shape
// (SERIES_MESSAGES.startBody, formatBody, setBody). While the Series switch is off the service
// refuses everything with 404 "Series are off.". Every error is `{ error: string }`.

import {
  SERIES_MESSAGES,
  seriesFormatRequestSchema,
  setJobSeriesRequestSchema,
  startSeriesRequestSchema,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import type { SeriesOutcome, SeriesService } from '../clients/series-service.js';
import { jobFor } from '../team/viewer-scope.js';

export interface SeriesRouteOptions {
  series: SeriesService;
}

/** The request's JSON body, or `undefined` when it is not JSON. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** A series answer as the response: the body with its status, or `{ error }` with the refusal's. */
function send<Body>(c: Context, outcome: SeriesOutcome<Body>): Response {
  return outcome.ok
    ? c.json(outcome.body, outcome.status)
    : c.json({ error: outcome.error }, outcome.status);
}

export function createSeriesRoutes({ series }: SeriesRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/clients/:clientId/series', async (c) =>
    send(c, await series.list(c.req.param('clientId'))),
  );

  routes.get('/series/:seriesId', async (c) => send(c, await series.get(c.req.param('seriesId'))));

  routes.post('/jobs/:jobId/series', async (c) => {
    const body = startSeriesRequestSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: SERIES_MESSAGES.startBody }, 400);
    return send(c, await series.start(c.req.param('jobId'), body.data.name));
  });

  routes.post('/series/:seriesId/format', async (c) => {
    const body = seriesFormatRequestSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: SERIES_MESSAGES.formatBody }, 400);
    return send(c, await series.useAsFormat(c.req.param('seriesId'), body.data.jobId));
  });

  routes.put('/jobs/:jobId/series', async (c) => {
    const body = setJobSeriesRequestSchema.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: SERIES_MESSAGES.setBody }, 400);
    const outcome = await series.setJobSeries(c.req.param('jobId'), body.data.seriesId);
    // The answer is a job: an editor's carries no money.
    return send(c, outcome.ok ? { ...outcome, body: jobFor(c, outcome.body) } : outcome);
  });

  routes.post('/series/:seriesId/undo', async (c) =>
    send(c, await series.undoStart(c.req.param('seriesId'))),
  );

  routes.post('/series/:seriesId/retry', async (c) =>
    send(c, await series.retry(c.req.param('seriesId'))),
  );

  return routes;
}
