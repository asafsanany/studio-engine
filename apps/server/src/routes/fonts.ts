// The Fonts API (Fonts plan, "API"), mounted at /api/fonts while the Fonts switch is on. FN1 wrote
// every route as a stub that calls the service; each region below is finished by the item named on
// it, which changes only its own region (and its own service methods, fonts/font-service.ts).
//
//   GET    /                    { families, catalog, requests }          200 FontsListResponse   FN3
//   GET    /file/:fileId        the font file                            200 font/ttf|otf|woff|woff2   FN3
//   GET    /:slug               one family with its faces                200 FontFamilyDetail    FN3
//   POST   /stage               multipart files[] → one verdict per item 200 FontStageResponse   FN4
//   DELETE /stage/:stageId      throws the upload away                   200 { ok: true }        FN4
//   POST   /import              { stageId, items[] }                     200|201 FontImportResponse    FN4
//   POST   /:slug/reveal        Show in Finder (the family's folder)     200 { ok: true }        FN5
//   DELETE /:slug               the family to the Trash                  200 { ok, where }       FN5
//   DELETE /requests/:id        "Not a font": a bar's request dismissed  200 { ok: true }        C52
//
// The rules live in the Fonts service (fonts/font-service.ts); this file is HTTP only, bodies
// checked with the shared schemas and every error `{ error }` from FONT_MESSAGES. While the switch
// is off app.ts mounts nothing and answers 404 "Fonts are off.".
//
// The fixed paths (`file`, `stage`, `import`, `requests`) are registered before the `:slug` ones.

import { readFile } from 'node:fs/promises';
import {
  FONT_LIMITS,
  FONT_MESSAGES,
  FONT_MIME_TYPES,
  fontImportRequestSchema,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { fontVersion } from '../fonts/font-index.js';
import type { FontOutcome, FontService } from '../fonts/font-service.js';
import {
  FONT_UPLOAD_FORM_OVERHEAD_BYTES,
  FontUploadError,
  receiveFontFiles,
} from '../fonts/font-staging.js';

/** The `Cache-Control` of a font file asked for by its own version: it never changes at that address. */
export const FONT_FILE_CACHE_FOREVER = 'public, max-age=31536000, immutable';

export interface FontsRouteOptions {
  service: FontService;
}

/** A Fonts answer as the response: the body with its status, or `{ error }` with the refusal's. */
function answer<Body>(c: Context, outcome: FontOutcome<Body>): Response {
  return outcome.ok
    ? c.json(outcome.body, outcome.status)
    : c.json({ error: outcome.error }, outcome.status);
}

export function createFontsRoutes({ service }: FontsRouteOptions): Hono {
  const routes = new Hono();

  // --- FN3: the list, a font file ----------------------------------------------------------------

  routes.get('/', async (c) => answer(c, await service.list()));

  // The file as it is, with its type. The page puts the file's modified time in the address
  // (`?v=<ms>`, FontFaceInfo.version): when it is the file's own, the browser may keep the font for
  // good (a replaced file has another time, so another address); any other `v` (or none) is
  // answered with the file but told to ask again next time.
  routes.get('/file/:fileId', async (c) => {
    const outcome = await service.file(c.req.param('fileId'));
    if (!outcome.ok) return answer(c, outcome);
    const { path, format, mtimeMs } = outcome.body;
    const headers = {
      'Content-Type': FONT_MIME_TYPES[format],
      'Cache-Control':
        c.req.query('v') === fontVersion(mtimeMs) ? FONT_FILE_CACHE_FOREVER : 'no-cache',
    };
    try {
      return c.body(await readFile(path), 200, headers);
    } catch (err) {
      // The file went away since the index last looked.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: FONT_MESSAGES.fileNotFound }, 404);
      }
      throw err;
    }
  });

  // --- FN4: import -------------------------------------------------------------------------------

  // The files are streamed into `service.beginStage()`'s folder (up to 400 files, 30 MB each, 400 MB
  // in all) and handed to `service.stage(...)`, which answers one verdict per family or bad file.
  // A stage that fails is thrown away at once; one that is fine but holds nothing to check (a
  // folder of only .DS_Store and licence texts) is kept for the page to delete.
  routes.post(
    '/stage',
    bodyLimit({
      maxSize: FONT_LIMITS.stageMaxBytes + FONT_UPLOAD_FORM_OVERHEAD_BYTES,
      onError: (c) => c.json({ error: FONT_MESSAGES.stageTooLarge }, 413),
    }),
    async (c) => {
      const stage = await service.beginStage();
      let outcome: FontOutcome<unknown> | null = null;
      try {
        const received = await receiveFontFiles(c.req.raw, { stageDir: stage.dir });
        // A form with no file at all is not an upload; one whose files were all thrown away is.
        outcome =
          received.files.length === 0 && received.ignored === 0
            ? { ok: false, status: 400, error: FONT_MESSAGES.badImport }
            : await service.stage(stage, received.files);
        return answer(c, outcome);
      } catch (err) {
        if (err instanceof FontUploadError) return c.json({ error: err.message }, err.status);
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
    const request = fontImportRequestSchema.safeParse(body);
    if (!request.success) {
      const tooMany = request.error.issues.some(
        (issue) => issue.path[0] === 'items' && issue.code === 'too_big',
      );
      return c.json(
        { error: tooMany ? FONT_MESSAGES.tooManyFiles : FONT_MESSAGES.badImport },
        tooMany ? 413 : 400,
      );
    }
    return answer(c, await service.importStaged(request.data.stageId, request.data.items));
  });

  // --- C52: "Not a font" -------------------------------------------------------------------------

  // A note wrote `@Falcon` and nobody asked for a font: the bar on the Fonts page lets it go. Two
  // segments, so it never meets `DELETE /:slug`.
  routes.delete('/requests/:id', async (c) =>
    answer(c, await service.dismissRequest(c.req.param('id'))),
  );

  // --- FN3: one family ---------------------------------------------------------------------------

  routes.get('/:slug', async (c) => answer(c, await service.get(c.req.param('slug'))));

  // --- FN5: Finder and the Trash -----------------------------------------------------------------

  routes.post('/:slug/reveal', async (c) => answer(c, await service.reveal(c.req.param('slug'))));

  routes.delete('/:slug', async (c) => answer(c, await service.remove(c.req.param('slug'))));

  return routes;
}
