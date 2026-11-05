// The Instagram routes (Clients × Instagram, IG0), mounted at /api only while the `instagram`
// switch is on (app.ts answers every such path 404 "Clients × Instagram is off." otherwise):
//
//   GET    /clients/:clientId/instagram?range=since|90|30
//                                       the client's Instagram: { account, lastScan, scanning,
//                                       nextScanAt, numbers, reels, linkableJobs }. 404 unknown
//                                       client, 400 for another range. An editor gets no scan
//                                       cost and no linkable jobs (money and linking are the
//                                       admin's). IG6
//   PUT    /clients/:clientId/instagram body { handle, since }: the account to read, as typed
//                                       (400 with the handle's problem in words). Saves it (a new
//                                       handle forgets what the old one read: name, bio, picture)
//                                       and queues its first scan at the front of the line; a
//                                       changed `since` alone queues nothing. Answers the client's
//                                       Instagram (IG4)
//   DELETE /clients/:clientId/instagram the client has no account any more: only its account row
//                                       goes (the scans and reels stay, IG1). Stops a scan of it.
//                                       { ok: true }, also when there was none (IG4)
//   POST   /clients/:clientId/instagram/scan   Scan now: queued at the front of the line, 202 with
//                                       the client's Instagram. 404 without an account, 409 while a
//                                       scan of the client runs (IG4)
//   POST   /instagram/reels/:shortcode/link    body { jobId }: link the reel to a delivered job
//                                       (409 { error, reason } when refused). routes/instagram-link.ts
//   DELETE /instagram/reels/:shortcode/link    unlink it. routes/instagram-link.ts
//   GET    /clients/:clientId/photo     the client's Instagram picture (JPEG). 404 until one is
//                                       saved and while the client has no account. ETag and
//                                       Last-Modified are the time it was saved (`photo_saved_at`);
//                                       with `?v=<that time>` it is cached for good (IG4)
//
// IG1 (tables), IG2 and IG3 (the scan), IG4 (link) and IG5 (numbers) fill these in, one at a time;
// the shapes are the shared contract (`@studio/shared`, domain/instagram.ts). Every error answers
// `{ error: string }` (the shared `apiErrorSchema`).

import { readFile, stat } from 'node:fs/promises';
import {
  type ClientInstagram,
  DEFAULT_INSTAGRAM_RANGE,
  INSTAGRAM_MESSAGES,
  type InstagramRange,
  instagramLinkRequestSchema,
  instagramRangeSchema,
  noClientInstagram,
  type ServerEvent,
  setClientInstagramRequestSchema,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import { type ClientSources, findClient } from '../clients/lookup.js';
import { instagramPhotoFor } from '../clients/paths.js';
import type { InstagramRepository } from '../db/index.js';
import { readClientInstagram } from '../instagram/client-instagram.js';
import type { InstagramScanQueue } from '../instagram/scan-queue.js';
import { isEditor } from '../team/viewer-scope.js';
import { createInstagramLinkRoutes, type InstagramLinkRouteOptions } from './instagram-link.js';
import { machineTimeZone } from './money.js';

/** The stored Instagram data the client page's GET reads (IG6), and PUT, DELETE and Scan now write (IG4). */
export interface InstagramRouteData {
  repo: InstagramRepository;
  /** The clock, for "this week" and the scan's Monday. Default: the system clock. */
  clock?: () => Date;
  /** The time zone the days are on. Default: this machine's. */
  timeZone?: () => string;
}

export interface InstagramRouteOptions {
  /** Which clients exist, so that a path of an unknown client answers 404 as the style does. */
  clients: ClientSources;
  /**
   * What linking a reel to a job needs (IG5). The boot wiring gives it; without it the two link
   * routes answer 501, as they did before they were built.
   */
  link?: InstagramLinkRouteOptions;
  /**
   * Where accounts, scans and reels are kept. Left out, the GET answers the empty shape of a client
   * with no Instagram, PUT, DELETE and Scan now answer 501 and the photo 404.
   */
  instagram?: InstagramRouteData;
  /**
   * The queue that runs the scans (IG4): whether a client is being scanned, and what PUT and Scan
   * now queue. Without it PUT, DELETE and Scan now answer 501.
   */
  scans?: Pick<InstagramScanQueue, 'enqueue' | 'restart' | 'drop' | 'isBusy' | 'isRunning'>;
  /** The data folder the pictures are in (IG4). Without it the photo is 404. */
  dataDir?: string;
  /** Where to tell the web that a client's Instagram changed (`client-instagram`). */
  publish?: (event: ServerEvent) => void;
}

/** The file a picture is, from what its first bytes say. Instagram's are JPEG; the scan keeps what it was given. */
function pictureType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  // RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/** The request's JSON body, or `undefined` when it is not JSON. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createInstagramRoutes({
  clients,
  link,
  instagram,
  scans,
  dataDir,
  publish,
}: InstagramRouteOptions): Hono {
  const routes = new Hono();

  const notFound = (clientId: string) => ({ error: `Client ${clientId} not found` });
  const notBuilt = (c: Context) => c.json({ error: INSTAGRAM_MESSAGES.notBuilt }, 501);

  const tell = (clientId: string): void => {
    publish?.({ type: 'client-instagram', clientId });
  };

  /**
   * The client's Instagram as the GET answers it: what PUT and Scan now answer too, so the page has
   * the new account and "Reading…" at once.
   */
  const read = (c: Context, clientId: string, range: InstagramRange): ClientInstagram =>
    instagram === undefined
      ? noClientInstagram()
      : readClientInstagram(instagram.repo, clientId, range, {
          now: (instagram.clock ?? (() => new Date()))().getTime(),
          timeZone: (instagram.timeZone ?? machineTimeZone)(),
          editor: isEditor(c),
          scanQueued: scans?.isBusy(clientId) ?? false,
        });

  routes.get('/clients/:clientId/instagram', (c) => {
    const clientId = c.req.param('clientId');
    if (findClient(clientId, clients) === null) return c.json(notFound(clientId), 404);
    const range = instagramRangeSchema
      .default(DEFAULT_INSTAGRAM_RANGE)
      .safeParse(c.req.query('range'));
    if (!range.success) return c.json({ error: INSTAGRAM_MESSAGES.badRange }, 400);
    return c.json(read(c, clientId, range.data));
  });

  routes.put('/clients/:clientId/instagram', async (c) => {
    const clientId = c.req.param('clientId');
    const client = findClient(clientId, clients);
    if (client === null) return c.json(notFound(clientId), 404);
    const body = setClientInstagramRequestSchema.safeParse(await readJson(c));
    if (!body.success) {
      // A handle that is no handle says why in its own words; anything else is the body's shape.
      const problem = body.error.issues.find((issue) => issue.code === 'custom');
      return c.json({ error: problem?.message ?? INSTAGRAM_MESSAGES.accountBody }, 400);
    }
    if (instagram === undefined || scans === undefined) return notBuilt(c);

    const { handle, since } = body.data;
    const before = instagram.repo.getAccount(clientId);
    const handleChanged = before !== null && before.handle !== handle;
    const saved = instagram.repo.upsertAccount({
      clientId,
      client,
      handle,
      since,
      // Another handle is another account until a scan says otherwise: nothing the old one read stays.
      ...(handleChanged
        ? {
            instagramId: null,
            fullName: null,
            biography: null,
            private: false,
            photoSavedAt: null,
          }
        : {}),
    });
    // A new account and a new handle are scanned at once (the scanner reads 90 days for both); a
    // new day to work together since is only a number the page uses.
    if (handleChanged) scans.restart(clientId);
    else if (saved.outcome === 'created') scans.enqueue(clientId, { urgent: true });
    tell(clientId);
    return c.json(read(c, clientId, DEFAULT_INSTAGRAM_RANGE));
  });

  routes.delete('/clients/:clientId/instagram', (c) => {
    const clientId = c.req.param('clientId');
    if (findClient(clientId, clients) === null) return c.json(notFound(clientId), 404);
    if (instagram === undefined || scans === undefined) return notBuilt(c);
    // The account row only: its scans and reels stay, so adding it again brings them back.
    const removed = instagram.repo.removeAccount(clientId);
    scans.drop(clientId);
    if (removed) tell(clientId);
    return c.json({ ok: true as const });
  });

  routes.post('/clients/:clientId/instagram/scan', (c) => {
    const clientId = c.req.param('clientId');
    if (findClient(clientId, clients) === null) return c.json(notFound(clientId), 404);
    if (instagram === undefined || scans === undefined) return notBuilt(c);
    if (instagram.repo.getAccount(clientId) === null) {
      return c.json({ error: INSTAGRAM_MESSAGES.noAccount }, 404);
    }
    if (scans.isRunning(clientId)) return c.json({ error: INSTAGRAM_MESSAGES.scanRunning }, 409);
    // Waiting in the weekly line, it moves to the front; not waiting, it joins at the front.
    scans.enqueue(clientId, { urgent: true });
    return c.json(read(c, clientId, DEFAULT_INSTAGRAM_RANGE), 202);
  });

  if (link !== undefined) {
    routes.route('/', createInstagramLinkRoutes(link));
  } else {
    routes.post('/instagram/reels/:shortcode/link', async (c) => {
      const body = instagramLinkRequestSchema.safeParse(await readJson(c));
      if (!body.success) return c.json({ error: INSTAGRAM_MESSAGES.linkBody }, 400);
      return notBuilt(c);
    });

    routes.delete('/instagram/reels/:shortcode/link', (c) => notBuilt(c));
  }

  routes.get('/clients/:clientId/photo', async (c) => {
    const clientId = c.req.param('clientId');
    if (findClient(clientId, clients) === null) return c.json(notFound(clientId), 404);
    const noPhoto = () => c.json({ error: INSTAGRAM_MESSAGES.noPhoto }, 404);
    if (instagram === undefined || dataDir === undefined) return noPhoto();
    // A client without an account has no photo, even though the file stays when it is removed.
    const savedAt = instagram.repo.getAccount(clientId)?.photoSavedAt ?? null;
    if (savedAt === null) return noPhoto();

    const file = instagramPhotoFor(dataDir, clientId);
    try {
      if (!(await stat(file)).isFile()) return noPhoto();
    } catch {
      return noPhoto();
    }

    const tag = `"${savedAt}"`;
    const headers: Record<string, string> = {
      ETag: tag,
      'Last-Modified': new Date(savedAt).toUTCString(),
      // Asked for by the time it was saved, the file cannot change under that address: keep it for
      // good. Otherwise the browser asks again each time (a 304 when it is the same).
      'Cache-Control':
        c.req.query('v') === String(savedAt)
          ? 'private, max-age=31536000, immutable'
          : 'private, no-cache',
    };
    const sent = (c.req.header('if-none-match') ?? '').split(',').map((entry) => entry.trim());
    if (sent.includes(tag) || sent.includes(`W/${tag}`) || sent.includes('*')) {
      return new Response(null, { status: 304, headers });
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      return noPhoto();
    }
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': pictureType(bytes),
        'Content-Length': String(bytes.length),
      },
    });
  });

  return routes;
}
