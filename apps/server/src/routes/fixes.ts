// The quick fixes of a job (quick fixes plan, section 3; QF3), mounted at /api/jobs while the
// `quickFixes` switch is on:
//
//   GET  /:id/fixes                       the fixes of the job's next round (job.round + 1), oldest
//                                         first: { fixes } (JobFixesResponse). Works in any state
//   POST /:id/fixes/:fixId/undo           takes the fix back: 200 { fix, job } (UndoFixResponse),
//                                         the fix now `undone`, its files put back and its note
//                                         waiting for Send again. 409 unless the job is in Review,
//                                         nothing is queued or running for it (FIX_MESSAGES.busy)
//                                         and the fix is the newest fixed one (FIX_MESSAGES.notNewest);
//                                         404 for a fix the job does not have
//   GET|HEAD /:id/fixes/:fixId/compare/:file
//                                         before.png or after.png: the fix's still of its note's
//                                         moment, image/png (FIX_COMPARE_FILES). 404 for any other
//                                         name, for a fix the job does not have and for a still that
//                                         is not there
//
// While the switch is off none of these exist and every /api/jobs/:id/fixes path answers 404
// "Quick fixes are off." (app.ts). Every error answers `{ error: string }`. The rules live in the
// fix service (review/fix-service.ts); this file is HTTP.

import { fixCompareFileSchema, type JobFixesResponse, type UndoFixResponse } from '@studio/shared';
import { Hono } from 'hono';
import type { JobRepository } from '../db/index.js';
import type { FixService } from '../review/fix-service.js';
import { jobFor } from '../team/viewer-scope.js';
import { serveFile } from './download.js';

export interface FixRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  fixes: FixService;
}

/** What the compare route answers when the still is not there. */
export const NO_FIX_STILL_MESSAGE = 'This fix has no still to compare.';

export function createFixRoutes({ jobs, fixes }: FixRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/:id/fixes', (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const body: JobFixesResponse = { fixes: fixes.list(job) };
    return c.json(body, 200, { 'Cache-Control': 'no-store' });
  });

  routes.post('/:id/fixes/:fixId/undo', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const result = await fixes.undo(job, c.req.param('fixId'));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const body: UndoFixResponse = { fix: result.fix, job: jobFor(c, jobs.get(id) ?? job) };
    return c.json(body);
  });

  // Hono answers HEAD with this GET handler; serveFile then sends the headers only.
  routes.get('/:id/fixes/:fixId/compare/:file', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const file = fixCompareFileSchema.safeParse(c.req.param('file'));
    if (!file.success) return c.json({ error: NO_FIX_STILL_MESSAGE }, 404);
    const path = await fixes.comparePath(id, c.req.param('fixId'), file.data);
    if (path === null) return c.json({ error: NO_FIX_STILL_MESSAGE }, 404);
    return serveFile(c, {
      path,
      contentType: 'image/png',
      disposition: 'inline',
      missingMessage: NO_FIX_STILL_MESSAGE,
      cache: 'revalidate',
    });
  });

  return routes;
}
