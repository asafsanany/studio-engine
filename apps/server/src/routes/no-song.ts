// The job's second export, the file without the song (Songs, SG8), mounted at /api/jobs next to the
// jobs routes. Only while the Songs switch is on (and Soundtrack); off, it does not exist and
// the path answers the ordinary 404, as before Songs.
//
//   GET  /:id/no-song   { state, ... } (`noSongStatusSchema`): where the second file stands. It never
//                       starts a render. `none` when the job has no such file (it is not ready, its
//                       music is not the song, it has no preview); `idle`, `making`, `failed` with
//                       its `message`, `ready` with `file` and `at`
//   POST /:id/no-song   Try again: starts making the file when it is `idle` or `failed`, answers the
//                       status (`making`; `ready` when a current one exists). 409 for a job that has
//                       no such file to make
//
// The file itself is `GET /api/jobs/:id/download?file=no-song` (routes/jobs.ts). 404 for an unknown
// job. Every error is `{ error: string }`.

import { NO_SONG_MESSAGES, type NoSongStatus } from '@studio/shared';
import { Hono } from 'hono';
import type { NoSongExportStatus, NoSongExports } from '../clients/no-song-export.js';
import type { JobRepository } from '../db/index.js';

export interface NoSongRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  noSong: Pick<NoSongExports, 'statusFor' | 'start'>;
}

/** The status as the wire has it: where the file is on this Mac is not told. */
function wire(status: NoSongExportStatus): NoSongStatus {
  return status.state === 'ready' ? { state: 'ready', file: status.file, at: status.at } : status;
}

export function createNoSongRoutes({ jobs, noSong }: NoSongRouteOptions): Hono {
  const routes = new Hono();
  const noStore = { 'Cache-Control': 'no-store' };

  routes.get('/:id/no-song', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    return c.json(wire(await noSong.statusFor(job)), 200, noStore);
  });

  routes.post('/:id/no-song', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const status = await noSong.start(job);
    if (status.state === 'none') return c.json({ error: NO_SONG_MESSAGES.nothingToMake }, 409);
    return c.json(wire(status), 200, noStore);
  });

  return routes;
}
