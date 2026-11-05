// The Instagram DMs page's API, mounted at /api/dms (the admin's only, route-policies.ts):
//
//   GET  /               the connection and every item, newest first   200 DmsResponse
//   POST /check          reads the DMs now, then the same answer      200 DmsResponse
//   GET  /file/:name     a downloaded file, with ranges for the player 200|206 the file
//   POST /:id/reveal     Finder shows the item's file                  200 { ok: true }
//
// The inbox (instagram-dms/dm-inbox.ts) does the work; this file is HTTP only.

import { DM_MESSAGES } from '@studio/shared';
import { Hono } from 'hono';
import type { DmInbox } from '../instagram-dms/dm-inbox.js';
import { resolveInside, serveFile } from './download.js';
import type { FileRevealer } from './job-sheet.js';

export interface DmsRouteOptions {
  inbox: Pick<DmInbox, 'read' | 'check' | 'item' | 'filesDir'>;
  /** Shows a file in Finder. Required, so nothing builds these routes with a real Finder by accident. */
  revealFile: FileRevealer;
}

export function createDmsRoutes({ inbox, revealFile }: DmsRouteOptions): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(inbox.read()));

  app.post('/check', async (c) => c.json(await inbox.check()));

  app.get('/file/:name', async (c) => {
    const name = c.req.param('name');
    const item = inbox.read().items.find((known) => known.file?.name === name);
    const path = item ? await resolveInside(inbox.filesDir, name) : null;
    if (item?.file == null || path === null) return c.json({ error: DM_MESSAGES.fileGone }, 404);
    return serveFile(c, {
      path,
      contentType: item.file.contentType,
      disposition: 'inline',
      missingMessage: DM_MESSAGES.fileGone,
      cache: 'revalidate',
    });
  });

  app.post('/:id/reveal', async (c) => {
    const item = inbox.item(c.req.param('id'));
    if (item === undefined) return c.json({ error: DM_MESSAGES.notFound }, 404);
    if (item.file === null) return c.json({ error: DM_MESSAGES.noFile }, 404);
    const path = await resolveInside(inbox.filesDir, item.file.name);
    if (path === null) return c.json({ error: DM_MESSAGES.fileGone }, 404);
    await revealFile(path);
    return c.json({ ok: true as const });
  });

  return app;
}
