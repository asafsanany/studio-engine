// The job chat's routes (Draft & chat, DR3), mounted at /api/jobs only while the draftChat switch is
// on (app.ts answers every such path 404 "Draft & chat is off." otherwise):
//
//   GET /:id/feed             { jobId, rev, items }: the job's chat, built from its log up to now
//                             (FeedService). A job whose log is not there yet has `items: []`.
//                             404 for an unknown job
//   GET /:id/feed/img/:name   one picture of the chat, as Claude saw it. The name is one the chat
//                             made; anything else, and a picture that is gone, is 404. A picture
//                             never changes, so it is revalidated cheaply (ETag)
//
// Every error answers `{ error: string }` (the shared `apiErrorSchema`).

import { extname } from 'node:path';
import { FEED_MESSAGES, type JobFeedResponse } from '@studio/shared';
import { Hono } from 'hono';
import type { JobRepository } from '../db/index.js';
import type { FeedService } from '../feed/feed-service.js';
import { serveFile } from './download.js';

export interface FeedRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  feed: Pick<FeedService, 'feed' | 'picturePath'>;
}

const PICTURE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function createFeedRoutes({ jobs, feed }: FeedRouteOptions): Hono {
  const routes = new Hono();
  const notFound = (id: string) => ({ error: `Job ${id} not found` });

  routes.get('/:id/feed', async (c) => {
    const id = c.req.param('id');
    if (jobs.get(id) === null) return c.json(notFound(id), 404);
    const body: JobFeedResponse = await feed.feed(id);
    return c.json(body);
  });

  routes.get('/:id/feed/img/:name', async (c) => {
    const id = c.req.param('id');
    if (jobs.get(id) === null) return c.json(notFound(id), 404);
    const name = c.req.param('name');
    const path = feed.picturePath(id, name);
    if (path === null) return c.json({ error: FEED_MESSAGES.noPicture }, 404);
    return serveFile(c, {
      path,
      contentType: PICTURE_TYPES[extname(name)] ?? 'application/octet-stream',
      disposition: 'inline',
      missingMessage: FEED_MESSAGES.noPicture,
      cache: 'revalidate',
    });
  });

  return routes;
}
