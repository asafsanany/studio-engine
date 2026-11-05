// The preview's files (Graphics plan, "Preview"), mounted at /api/graphics while the Graphics
// switch is on. OWNER: GR3.
//
//   GET|HEAD /assets/:file           a sample frame (apps/server/assets/graphics/sample-*.svg)
//   GET|HEAD /:id/v/:n/host.html     the preview host (graphics/graphic-host.ts), ?size=&bg=&vars=
//   GET|HEAD /:id/v/:n/<path>        a file of the graphic's version n: versions/vN/<path>, read-only
//
// The host is made on the way out and never written to disk. Its size, background and text values
// come from the address (`size` 9x16 | 16x9 | 1x1, `bg` frame | checker | black, `vars` the values
// as the shared encodeGraphicVars writes them); each defaults (9x16, frame, no values) when left
// out, and an address that says something else is a 400. The length of the graphic is the one
// the version's own about.json says, so an older version plays for its own length; the graphic's
// row is the fallback.
//
// The version's files are served by the same rules as the Review preview (composition-files.ts):
// a name is decoded once, refused when it is unsafe or leaves the version's folder (a symlink that
// points out too), sent with `no-cache` and an ETag, with byte ranges. The host is the only page
// that gets a body of its own; everything else is the file as it is on disk (the version's own
// index.html gets the timeline registry, like every root composition).

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeGraphicVars,
  GRAPHIC_ID_PATTERN,
  GRAPHIC_MESSAGES,
  type GraphicBackground,
  type GraphicSize,
  type GraphicVars,
  graphicAboutSchema,
  graphicBackgroundSchema,
  graphicSizeSchema,
} from '@studio/shared';
import { Hono } from 'hono';
import type { GraphicRepository, StoredGraphic } from '../db/index.js';
import { graphicsRoot } from '../graphics/graphic-folders.js';
import { renderGraphicHost } from '../graphics/graphic-host.js';
import { serveCompositionFile } from './composition-files.js';
import { matchesIfNoneMatch, resolveInside, serveFile } from './download.js';

export interface GraphicFilesRouteOptions {
  /** Which graphics exist, their folders, versions and lengths. */
  graphics: GraphicRepository;
  /** The inbox, whose `_Graphics/<folder>/versions/vN/` the files come from. */
  inboxPath: string;
  /** apps/server/assets/graphics (graphic-assets.ts's GRAPHICS_ASSETS_DIR). */
  assetsDir: string;
}

/** 404, a file the version does not have, or a name that is refused. */
export const GRAPHIC_FILE_MISSING_MESSAGE = 'The graphic file is missing.';
/** 404, a sample frame that is not there. */
export const SAMPLE_FRAME_MISSING_MESSAGE = 'The sample frame is missing.';
/** 400, a host address whose size, background or values cannot be read. */
export const HOST_ADDRESS_MESSAGE = 'The preview address could not be read.';

/** The host's defaults: what an address that leaves a part out gets. */
export const HOST_DEFAULT_SIZE: GraphicSize = '9x16';
export const HOST_DEFAULT_BACKGROUND: GraphicBackground = 'frame';

/** A sample frame's name: letters, digits, dashes and dots, ending in .svg. No folders. */
const SAMPLE_FRAME_NAME = /^[A-Za-z0-9._-]+\.svg$/;
/** A version number as the address writes it: no sign, no leading zero. */
const VERSION_NUMBER = /^[1-9][0-9]{0,5}$/;

interface HostAddress {
  size: GraphicSize;
  background: GraphicBackground;
  values: GraphicVars;
}

/** `?size=&bg=&vars=` as the host takes it, or null when a part cannot be read. */
function readHostAddress(query: (name: string) => string | undefined): HostAddress | null {
  const size = graphicSizeSchema.safeParse(query('size') ?? HOST_DEFAULT_SIZE);
  const background = graphicBackgroundSchema.safeParse(query('bg') ?? HOST_DEFAULT_BACKGROUND);
  if (!size.success || !background.success) return null;
  const vars = query('vars');
  const values = vars === undefined || vars === '' ? {} : decodeGraphicVars(vars);
  if (values === null) return null;
  return { size: size.data, background: background.data, values };
}

/** The real path of `versions/v<n>` inside the graphic's folder, or null when it is not a folder. */
async function findVersionRoot(
  inboxPath: string,
  graphic: StoredGraphic,
  version: number,
): Promise<string | null> {
  const dir = await resolveInside(graphicsRoot(inboxPath), graphic.folder);
  if (dir === null) return null;
  const root = await resolveInside(dir, join('versions', `v${version}`));
  if (root === null) return null;
  try {
    return (await stat(root)).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/**
 * How long the version plays: its own about.json's `lengthSec`, else the graphic's row. `null`
 * when neither says (the graphic has no length yet).
 */
async function versionLengthSec(root: string, graphic: StoredGraphic): Promise<number | null> {
  try {
    const about = await resolveInside(root, 'about.json');
    if (about !== null) {
      const parsed = graphicAboutSchema.shape.lengthSec.safeParse(
        (JSON.parse(await readFile(about, 'utf8')) as { lengthSec?: unknown }).lengthSec,
      );
      if (parsed.success) return parsed.data;
    }
  } catch {
    // No about.json, or not JSON: the row's length below.
  }
  return graphic.lengthSec;
}

/** The sample frames, the preview host and the version files. */
export function createGraphicFilesRoutes({
  graphics,
  inboxPath,
  assetsDir,
}: GraphicFilesRouteOptions): Hono {
  const routes = new Hono();

  // The sample frames. A flat name that ends in .svg, resolved inside the assets folder.
  routes.get('/assets/:file', async (c) => {
    const name = c.req.param('file');
    const path = SAMPLE_FRAME_NAME.test(name) ? await resolveInside(assetsDir, name) : null;
    if (path === null) return c.json({ error: SAMPLE_FRAME_MISSING_MESSAGE }, 404);
    return serveFile(c, {
      path,
      contentType: 'image/svg+xml',
      disposition: 'inline',
      missingMessage: SAMPLE_FRAME_MISSING_MESSAGE,
      cache: 'revalidate',
    });
  });

  /** The graphic and the folder of its version `:n`, or the 404 to send. */
  async function find(
    id: string,
    n: string,
  ): Promise<
    { graphic: StoredGraphic; version: number; root: string } | { error: string; status: 404 }
  > {
    const graphic = GRAPHIC_ID_PATTERN.test(id) ? graphics.get(id) : null;
    if (graphic === null) return { error: GRAPHIC_MESSAGES.notFound, status: 404 };
    const version = VERSION_NUMBER.test(n) ? Number(n) : 0;
    const root = version > 0 ? await findVersionRoot(inboxPath, graphic, version) : null;
    if (root === null) return { error: GRAPHIC_MESSAGES.versionNotFound, status: 404 };
    return { graphic, version, root };
  }

  // Before the version's files: `host.html` is the page made here, not a file.
  routes.get('/:id/v/:n/host.html', async (c) => {
    const found = await find(c.req.param('id'), c.req.param('n'));
    if ('error' in found) return c.json({ error: found.error }, found.status);

    const address = readHostAddress((name) => c.req.query(name));
    if (address === null) return c.json({ error: HOST_ADDRESS_MESSAGE }, 400);

    const lengthSec = await versionLengthSec(found.root, found.graphic);
    if (lengthSec === null) return c.json({ error: GRAPHIC_MESSAGES.versionNotFound }, 404);

    const body = Buffer.from(
      renderGraphicHost({
        id: found.graphic.id,
        lengthSec,
        size: address.size,
        background: address.background,
        values: address.values,
      }),
      'utf8',
    );
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 27)}"`;
    if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': 'no-cache' },
      });
    }
    return new Response(c.req.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Content-Length': String(body.length),
      },
    });
  });

  // `:path{.+}` is the rest of the URL, slashes included, percent-decoded once by Hono.
  routes.get('/:id/v/:n/:path{.+}', async (c) => {
    const found = await find(c.req.param('id'), c.req.param('n'));
    if ('error' in found) return c.json({ error: found.error }, found.status);
    return serveCompositionFile(c, {
      root: found.root,
      name: c.req.param('path'),
      missingMessage: GRAPHIC_FILE_MISSING_MESSAGE,
    });
  });

  return routes;
}
