// The graphics API (Graphics plan, "API"), mounted at /api/graphics while the Graphics switch is
// on. OWNER: GR1. GR0 left the list and one graphic; GR1 adds the rest:
//
//   GET    /                                   the list                         200 GraphicSummary[]
//   GET    /:id                                one graphic                      200 GraphicDetail
//   POST   /                                   multipart text, effort?, files[] 201 GraphicDetail
//   POST   /:id/messages                       multipart text, effort?, files[] 202 GraphicDetail
//   POST   /:id/messages/:mid/stop                                              200 GraphicDetail
//   POST   /:id/messages/:mid/retry                                             202 GraphicDetail
//   POST   /:id/versions/:n/restore                                             200 GraphicDetail
//   PUT    /:id                                { name?, when?, uses? }          200 GraphicDetail
//   POST   /:id/duplicate                                                       201 GraphicDetail
//   POST   /:id/reveal                                                          200 { ok: true }
//   DELETE /:id                                                                 200 { ok, where }
//
// The rules live in the graphics service (graphics/graphic-service.ts); this file is HTTP only:
// multipart uploads (busboy, streamed like the style upload, at most GRAPHIC_LIMITS.refsMaxFiles
// files and refsMaxBytes in all), bodies checked with the shared schemas, and every error
// `{ error }` from GRAPHIC_MESSAGES. The version files and the host are routes/graphic-files.ts
// (GR3); the voice note is routes/graphic-voice.ts (GR5).
//
// A message may be only attachments: `text` can be empty when there is a file.

import { rm } from 'node:fs/promises';
import {
  GRAPHIC_LIMITS,
  GRAPHIC_MESSAGES,
  graphicMessageFieldsSchema,
  updateGraphicRequestSchema,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import type { GraphicOutcome, GraphicSend, GraphicService } from '../graphics/graphic-service.js';
import { GraphicUploadError, receiveGraphicMessage } from '../graphics/graphic-upload.js';

export interface GraphicsRouteOptions {
  service: GraphicService;
  /** The most one message's files may weigh together. Default `GRAPHIC_LIMITS.refsMaxBytes`; tests use less. */
  maxUploadBytes?: number;
}

/** A graphics answer as the response: the body with its status, or `{ error }` with the refusal's. */
function answer<Body>(c: Context, outcome: GraphicOutcome<Body>): Response {
  return outcome.ok
    ? c.json(outcome.body, outcome.status)
    : c.json({ error: outcome.error }, outcome.status);
}

/** A message that could not be read: `{ error }` with the status. */
function unreadable(c: Context, error: string, status: 400 | 413 | 415): Response {
  return c.json({ error }, status);
}

/** A version number from the address, or `null` when it is not 1, 2, 3, … */
function versionParam(text: string): number | null {
  return /^[1-9][0-9]*$/.test(text) ? Number(text) : null;
}

export function createGraphicsRoutes({
  service,
  maxUploadBytes = GRAPHIC_LIMITS.refsMaxBytes,
}: GraphicsRouteOptions): Hono {
  const routes = new Hono();

  /**
   * The message in the body of a request: its fields checked with the shared schema, its files
   * staged. Hands it to `use`, and removes the staging folder whatever happens. A body that cannot
   * be taken is answered with its refusal.
   */
  async function withMessage(
    c: Context,
    use: (send: GraphicSend) => Promise<Response>,
  ): Promise<Response> {
    const staging = await service.stagingDir();
    try {
      const received = await receiveGraphicMessage(c.req.raw, {
        stagingDir: staging,
        maxBytes: maxUploadBytes,
      });
      const fields = graphicMessageFieldsSchema.safeParse({
        text: received.text ?? '',
        ...(received.effort === null ? {} : { effort: received.effort }),
      });
      if (!fields.success) {
        const tooLong = fields.error.issues.some((issue) => issue.path[0] === 'text');
        return unreadable(
          c,
          tooLong ? GRAPHIC_MESSAGES.textTooLong : GRAPHIC_MESSAGES.badMessage,
          400,
        );
      }
      return await use({
        text: fields.data.text,
        effort: fields.data.effort ?? null,
        files: received.files,
      });
    } catch (err) {
      if (err instanceof GraphicUploadError) return unreadable(c, err.message, err.status);
      throw err;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  routes.get('/', async (c) => answer(c, await service.list()));

  routes.post('/', (c) => withMessage(c, async (send) => answer(c, await service.create(send))));

  routes.get('/:id', async (c) => answer(c, await service.get(c.req.param('id'))));

  routes.post('/:id/messages', async (c) => {
    const id = c.req.param('id');
    // Refused before the body is read, so a big upload is not taken for nothing.
    const refusal = await service.sendable(id);
    if (refusal !== null) return answer(c, refusal);
    return withMessage(c, async (send) => answer(c, await service.send(id, send)));
  });

  routes.post('/:id/messages/:mid/stop', async (c) =>
    answer(c, await service.stop(c.req.param('id'), c.req.param('mid'))),
  );

  routes.post('/:id/messages/:mid/retry', async (c) =>
    answer(c, await service.retry(c.req.param('id'), c.req.param('mid'))),
  );

  routes.post('/:id/versions/:n/restore', async (c) => {
    const version = versionParam(c.req.param('n'));
    if (version === null) {
      return c.json({ error: GRAPHIC_MESSAGES.versionNotFound }, 404);
    }
    return answer(c, await service.restore(c.req.param('id'), version));
  });

  routes.put('/:id', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const patch = updateGraphicRequestSchema.safeParse(body);
    if (!patch.success) {
      const tooLong = patch.error.issues.some((issue) => issue.path[0] === 'when');
      return c.json(
        { error: tooLong ? GRAPHIC_MESSAGES.whenTooLong : GRAPHIC_MESSAGES.badUpdate },
        400,
      );
    }
    return answer(c, await service.update(c.req.param('id'), patch.data));
  });

  routes.post('/:id/duplicate', async (c) => answer(c, await service.duplicate(c.req.param('id'))));

  routes.post('/:id/reveal', async (c) => answer(c, await service.reveal(c.req.param('id'))));

  routes.delete('/:id', async (c) => answer(c, await service.remove(c.req.param('id'))));

  return routes;
}
