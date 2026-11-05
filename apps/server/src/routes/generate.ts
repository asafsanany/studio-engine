// The Generate stage of a job (Generated videos, GN0), mounted at /api/jobs while the Generate
// switch is on.
//
//   GET /:id/generate    the job's GenerateState (phase, counts, spendUsd, budgetUsd), or 404 for a
//                        job that has no Generate stage (GENERATE_MESSAGES.notGenerated), and 404
//                        for an unknown job
//   GET /:id/generate/history   what the stage did, `{ events: GenerateHistoryEvent[] }` oldest
//                        first (GN5; the sheet's History reads it), with the same 404s
//
// While the switch is off the route does not exist (the ordinary 404 "Not found", as before
// Generated videos). Every error answers `{ error: string }` (the shared `apiErrorSchema`).

import type { GenerateHistoryResponse, GenerateResponse } from '@studio/shared';
import { Hono } from 'hono';
import type { JobRepository } from '../db/index.js';
import type { GenerateService } from '../generate/generate-service.js';

export interface GenerateRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  generate: GenerateService;
}

export function createGenerateRoutes({ jobs, generate }: GenerateRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/:id/generate', async (c) => {
    const id = c.req.param('id');
    if (jobs.get(id) === null) return c.json({ error: `Job ${id} not found` }, 404);
    const outcome = await generate.state(id);
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    const body: GenerateResponse = outcome.state;
    return c.json(body);
  });

  routes.get('/:id/generate/history', async (c) => {
    const id = c.req.param('id');
    if (jobs.get(id) === null) return c.json({ error: `Job ${id} not found` }, 404);
    const outcome = await generate.history(id);
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
    const body: GenerateHistoryResponse = { events: outcome.events };
    return c.json(body);
  });

  return routes;
}
