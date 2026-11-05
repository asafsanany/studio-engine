// The music of a job (Soundtrack plan, "Routes"), mounted at /api/jobs while the Soundtrack switch
// is on.
//
//   GET /:id/music        the MusicView: the job's music.json plus canMake, whyNot and rev, or
//                         `null` for a job without music.json. 404 for an unknown job
//   POST /:id/music       Make another, body { ask? } (makeMusicRequestSchema; blank words are no
//                         words, at most 200 characters): 202 with the MusicView, now making; the
//                         music is made in the background and the page hears `job.music` when it
//                         is done. 409 with the reason when it is not allowed (MUSIC_MESSAGES: not
//                         in review, an episode, a version is being made, no plan to make from)
//   PUT /:id/music/pick   Pick, body { id } (a version, off, file / series: the folder's or the
//                         series' music back after off, or song: the song got for the video): the
//                         MusicView with the pick made. 409 as above, 404 for a version (or a file,
//                         series music or song) the job does not have
//
// While the switch is off none of these exist and every /api/jobs/:id/music path answers 404
// "Music is off." (app.ts). Every error answers `{ error: string }` (the shared `apiErrorSchema`).

import { type MusicResponse, makeMusicRequestSchema, pickMusicRequestSchema } from '@studio/shared';
import { type Context, Hono } from 'hono';
import type { JobRepository } from '../db/index.js';
import type { MusicActionResult, MusicService } from '../music/music-service.js';

export interface MusicRouteOptions {
  jobs: JobRepository;
  music: MusicService;
}

/** What a body that cannot be read answers. */
export const BAD_MUSIC_BODY_MESSAGE = 'The request could not be read. Send it again.';

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function answer(c: Context, result: MusicActionResult, okStatus: 200 | 202) {
  return result.ok ? c.json(result.view, okStatus) : c.json({ error: result.error }, result.status);
}

export function createMusicRoutes({ jobs, music }: MusicRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/:id/music', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const view: MusicResponse = await music.view(job);
    return c.json(view);
  });

  routes.post('/:id/music', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    // An empty body is Make another without words.
    const text = await c.req.text();
    let body: unknown = {};
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: BAD_MUSIC_BODY_MESSAGE }, 400);
      }
    }
    const parsed = makeMusicRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: BAD_MUSIC_BODY_MESSAGE }, 400);
    const ask = parsed.data.ask === '' ? undefined : parsed.data.ask;
    return answer(c, await music.makeAnother(job, ask), 202);
  });

  routes.put('/:id/music/pick', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const parsed = pickMusicRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: BAD_MUSIC_BODY_MESSAGE }, 400);
    return answer(c, await music.pick(job, parsed.data.id), 200);
  });

  return routes;
}
