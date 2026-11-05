// A finished job as a client's look (Phase 2 plan §5 and §8), mounted at /api/jobs:
//
//   POST /:id/use-look   Use this look: queues a Learn pass from the job that replaces its
//                        client's style, and answers the client's ClientStyle, now analysing.
//                        404 unknown job, 409 unless the job is ready, 409 while the client is
//                        analysing
//   GET  /:id/still      one JPEG frame of the job's export, at 25% of its length and 360 px
//                        wide, kept as edit/still.jpg. 404 unknown job or no export, 500 when
//                        ffmpeg could not make it
//
// Every error answers `{ error: string }` (the shared `apiErrorSchema`).

import type { ClientStyle } from '@studio/shared';
import { Hono } from 'hono';
import { type JobStills, StillError } from '../clients/job-still.js';
import { learnPassFor } from '../clients/style-learn.js';
import type { StyleWorker } from '../clients/style-worker.js';
import { type ClientStyleRepository, type JobRepository, toClientStyle } from '../db/index.js';
import { logger } from '../logger.js';
import { serveFile } from './download.js';

export const NO_EXPORT_MESSAGE = 'This job has no export.';

export interface JobStyleRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  clientStyles: Pick<ClientStyleRepository, 'get'>;
  /** Runs the Learn pass. */
  worker: Pick<StyleWorker, 'enqueue'>;
  /** Makes the stills: `new JobStills({ inboxPath, exportsDir })`. */
  stills: Pick<JobStills, 'stillFor'>;
}

export function createJobStyleRoutes({
  jobs,
  clientStyles,
  worker,
  stills,
}: JobStyleRouteOptions): Hono {
  const routes = new Hono();
  const notFound = (id: string) => ({ error: `Job ${id} not found` });

  routes.post('/:id/use-look', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json(notFound(id), 404);
    if (job.state !== 'ready') {
      return c.json(
        { error: `Only a finished job's look can be used; this one is ${job.state}.` },
        409,
      );
    }
    if (clientStyles.get(job.clientId)?.state === 'analysing') {
      return c.json({ error: 'The style is being analysed. Try again once it is done.' }, 409);
    }
    const style = await worker.enqueue(job.client, learnPassFor(job, 'replace'));
    const body: ClientStyle = toClientStyle(style);
    return c.json(body);
  });

  // Hono answers HEAD with this GET handler; serveFile then sends the headers only.
  routes.get('/:id/still', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json(notFound(id), 404);

    let path: string | null;
    try {
      path = await stills.stillFor(job);
    } catch (err) {
      if (!(err instanceof StillError)) throw err;
      logger.warn({ err, jobId: id }, 'could not make the still of a job');
      return c.json({ error: err.message }, 500);
    }
    if (path === null) return c.json({ error: NO_EXPORT_MESSAGE }, 404);
    return serveFile(c, {
      path,
      contentType: 'image/jpeg',
      disposition: 'inline',
      missingMessage: NO_EXPORT_MESSAGE,
      cache: 'revalidate',
    });
  });

  return routes;
}
