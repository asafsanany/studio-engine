// What Review reads about a generated video's clips and voice lines (Generated videos, GN8),
// mounted at /api/jobs while the Generate switch is on:
//
//   GET /:id/generate/review-plan    the plan for the note hints (`GenerateNotePlan`): the clips of
//                                    the cut with their windows and what their kept take cost, and
//                                    the voice lines with their windows
//
//   404 the job is unknown, or has no hand-off yet (no valid edit/generate/shots.json)
//
// The files themselves stay agent-only; this answers only the numbers a hint line needs. With the
// switch off the route does not exist. Every error answers `{ error: string }`.

import { join } from 'node:path';
import type { GenerateNotePlan } from '@studio/shared';
import { GENERATE_MESSAGES } from '@studio/shared';
import { Hono } from 'hono';
import type { JobRepository } from '../db/index.js';
import { readReviewPlan } from '../generate/review-plan.js';

export interface GenerateReviewRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  /** A job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
}

export function createGenerateReviewRoutes({ jobs, inboxPath }: GenerateReviewRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/:id/generate/review-plan', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const plan = await readReviewPlan(join(inboxPath, job.relPath));
    if (plan === null) return c.json({ error: GENERATE_MESSAGES.notGenerated }, 404);
    const body: GenerateNotePlan = plan;
    return c.json(body);
  });

  return routes;
}
