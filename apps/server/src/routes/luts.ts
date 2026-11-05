// The LUTs API (LUTs plan, "API"), mounted at /api/luts while the LUTs switch is on. OWNER: LU1.
//
//   GET    /                       { yours, builtIn, builtInAvailable }     200 LutListResponse
//   GET    /:slug                  one LUT                                  200 LutDetail
//   PATCH  /:slug                  { name?, kind? }  (Yours only)           200 LutDetail
//   DELETE /:slug                  to the Trash (Yours only)                200 { ok, where }
//   POST   /:slug/duplicate        Yours: "X (2)"; Built in: a copy in Yours 201 LutDetail
//   POST   /:slug/reveal           Show in Finder                           200 { ok: true }
//   POST   /stage                  multipart files[] → one verdict per file 200 LutStageResponse
//   DELETE /stage/:stageId         throws the upload away                   200 { ok: true }
//   POST   /import                 { stageId, items[] }                     201 LutImportResponse
//
// The rules live in the LUTs service (luts/lut-service.ts); this file is HTTP only, bodies checked
// with the shared schemas and every error `{ error }` from LUT_MESSAGES. The preview stills are
// routes/lut-previews.ts (LU2). While the switch is off app.ts mounts neither and answers 404
// "LUTs are off.".

import { LUT_MESSAGES, lutImportRequestSchema, updateLutRequestSchema } from '@studio/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { LutOutcome, LutService } from '../luts/lut-service.js';
import {
  LUT_UPLOAD_MAX_BYTES,
  LUT_UPLOAD_TOO_MUCH,
  LutUploadError,
  receiveLutFiles,
} from '../luts/lut-upload.js';

/** What the multipart framing adds to the files' own bytes: boundaries and headers, with room. */
const FORM_OVERHEAD_BYTES = 1024 * 1024;

export interface LutsRouteOptions {
  service: LutService;
}

/** A LUTs answer as the response: the body with its status, or `{ error }` with the refusal's. */
function answer<Body>(c: Context, outcome: LutOutcome<Body>): Response {
  return outcome.ok
    ? c.json(outcome.body, outcome.status)
    : c.json({ error: outcome.error }, outcome.status);
}

export function createLutsRoutes({ service }: LutsRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/', async (c) => answer(c, await service.list()));

  // The files are streamed into `service.beginStage()`'s folder (up to 60, 40 MB each, 400 MB in
  // all) and handed to `service.stage(...)`, which answers one verdict per file. A stage that
  // fails is thrown away at once.
  routes.post(
    '/stage',
    bodyLimit({
      maxSize: LUT_UPLOAD_MAX_BYTES + FORM_OVERHEAD_BYTES,
      onError: (c) => c.json({ error: LUT_UPLOAD_TOO_MUCH }, 413),
    }),
    async (c) => {
      const stage = await service.beginStage();
      let outcome: LutOutcome<unknown> | null = null;
      try {
        const files = await receiveLutFiles(c.req.raw, { stageDir: stage.dir });
        outcome = await service.stage(stage, files);
        return answer(c, outcome);
      } catch (err) {
        if (err instanceof LutUploadError) return c.json({ error: err.message }, err.status);
        throw err;
      } finally {
        if (outcome === null || !outcome.ok) await service.cancelStage(stage.stageId);
      }
    },
  );

  routes.delete('/stage/:stageId', async (c) =>
    answer(c, await service.cancelStage(c.req.param('stageId'))),
  );

  routes.post('/import', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const request = lutImportRequestSchema.safeParse(body);
    if (!request.success) {
      const tooMany = request.error.issues.some(
        (issue) => issue.path[0] === 'items' && issue.code === 'too_big',
      );
      return c.json(
        { error: tooMany ? LUT_MESSAGES.tooManyFiles : LUT_MESSAGES.badImport },
        tooMany ? 413 : 400,
      );
    }
    return answer(c, await service.importStaged(request.data));
  });

  routes.get('/:slug', async (c) => answer(c, await service.get(c.req.param('slug'))));

  routes.patch('/:slug', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const patch = updateLutRequestSchema.safeParse(body);
    if (!patch.success) return c.json({ error: LUT_MESSAGES.badUpdate }, 400);
    return answer(c, await service.update(c.req.param('slug'), patch.data));
  });

  routes.delete('/:slug', async (c) => answer(c, await service.remove(c.req.param('slug'))));

  routes.post('/:slug/duplicate', async (c) =>
    answer(c, await service.duplicate(c.req.param('slug'))),
  );

  routes.post('/:slug/reveal', async (c) => answer(c, await service.reveal(c.req.param('slug'))));

  return routes;
}
