// The dev server's /__dev/graphic-sample/ route: a Graphics engine in miniature for the dev gallery
// (GraphicPreviewGallery on /components). Split out of vite.config.ts, like dev-preview-sample.ts
// whose file server it reuses. Dev only: `apply: 'serve'`.
//
// The real preview routes (apps/server/src/routes/graphic-files.ts) need the engine with the
// Graphics switch on, and a graphic made by a run. The gallery needs neither, so this serves the
// same addresses for one canned graphic (apps/server/src/graphics/testdata/host-sample/):
//
//   GET /assets/sample-9x16.svg              the sample frames
//   GET /<id>/v/<n>/host.html?size&bg&vars   the real renderGraphicHost, loaded from the server's
//                                            source by Vite, so the gallery plays the page the
//                                            engine would send (for any version number)
//   GET /<id>/v/<n>/vendor/gsap.min.js       GSAP, from the server's assets
//   GET /<id>/v/<n>/<path>                   the canned graphic's files (compositions/lib-<id>.html)

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { previewSampleMiddleware } from './dev-preview-sample.ts';

/** Where the canned graphic is mounted on the dev server. */
export const GRAPHIC_SAMPLE_BASE = '/__dev/graphic-sample';
/** The canned graphic's id (12 hex): the file is compositions/lib-<id>.html. */
export const GRAPHIC_SAMPLE_ID = '5a3e1c0de001';
/** How long the canned graphic plays, in seconds (its timeline ends at 3). */
export const GRAPHIC_SAMPLE_LENGTH_SEC = 3;

const SIZES = ['9x16', '16x9', '1x1'] as const;
const BACKGROUNDS = ['frame', 'checker', 'black'] as const;

/** What the server's renderGraphicHost takes (graphics/graphic-host.ts), as far as this needs. */
export interface GraphicHostRenderer {
  renderGraphicHost(options: {
    id: string;
    lengthSec: number;
    size: (typeof SIZES)[number];
    background: (typeof BACKGROUNDS)[number];
    values: Record<string, string>;
    assetsBase: string;
  }): string;
}

export interface GraphicSampleOptions {
  /** The canned graphic's folder (compositions/lib-<id>.html in it). */
  sampleDir: string;
  /** apps/server/assets/graphics: the sample frames, and vendor/gsap.min.js. */
  assetsDir: string;
  /** Loads the server's graphic-host module. */
  loadHost(): Promise<GraphicHostRenderer>;
}

function send(res: ServerResponse, status: number, type: string, body: string, head: boolean) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(head ? undefined : body);
}

/** The text values of a host address's `vars` (base64url JSON, as encodeGraphicVars writes it). */
export function readVars(vars: string | null): Record<string, string> | null {
  if (vars === null || vars === '') return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(vars, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') return null;
      values[key] = value;
    }
    return values;
  } catch {
    return null;
  }
}

const VERSION_PATH = /^\/([0-9a-f]{12})\/v\/([1-9][0-9]{0,5})\/(.+)$/;

/** Serves the canned graphic at the engine's addresses. GET and HEAD only. */
export function graphicSampleMiddleware(options: GraphicSampleOptions): Connect.NextHandleFunction {
  const samples = previewSampleMiddleware(options.sampleDir);
  const assets = previewSampleMiddleware(options.assetsDir);

  /** Hands `req` to a file server as `/<path>`. */
  function serveFrom(
    files: Connect.NextHandleFunction,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    req.url = `/${path}`;
    return files(req, res, () => {});
  }

  return async (req, res) => {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD');
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', false);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const notFound = () => send(res, 404, 'text/plain; charset=utf-8', 'Not found', head);

    if (url.pathname.startsWith('/assets/')) {
      return serveFrom(assets, url.pathname.slice('/assets/'.length), req, res);
    }

    const match = VERSION_PATH.exec(url.pathname);
    if (match === null || match[1] !== GRAPHIC_SAMPLE_ID) return notFound();
    const rest = match[3] ?? '';

    if (rest === 'host.html') {
      const size = url.searchParams.get('size') ?? '9x16';
      const background = url.searchParams.get('bg') ?? 'frame';
      const values = readVars(url.searchParams.get('vars'));
      const knownSize = SIZES.find((candidate) => candidate === size);
      const knownBackground = BACKGROUNDS.find((candidate) => candidate === background);
      if (knownSize === undefined || knownBackground === undefined || values === null) {
        return send(res, 400, 'text/plain; charset=utf-8', 'Bad preview address', head);
      }
      try {
        const { renderGraphicHost } = await options.loadHost();
        const html = renderGraphicHost({
          id: GRAPHIC_SAMPLE_ID,
          lengthSec: GRAPHIC_SAMPLE_LENGTH_SEC,
          size: knownSize,
          background: knownBackground,
          values,
          assetsBase: `${GRAPHIC_SAMPLE_BASE}/assets`,
        });
        return send(res, 200, 'text/html; charset=utf-8', html, head);
      } catch (error) {
        return send(
          res,
          500,
          'text/plain; charset=utf-8',
          `The host could not be made: ${error}`,
          head,
        );
      }
    }

    // GSAP comes from the engine's assets, as vendor/gsap.min.js does in a real version.
    if (rest.startsWith('vendor/')) return serveFrom(assets, rest, req, res);
    return serveFrom(samples, rest, req, res);
  };
}

/**
 * The dev-only plugin that mounts {@link graphicSampleMiddleware} at {@link GRAPHIC_SAMPLE_BASE}.
 * Creating it touches no file (Vitest loads vite.config.ts too). The host renderer is loaded
 * through Vite on the first request, so it is always the server's current source.
 */
export function graphicSamplePlugin(paths: {
  sampleDir: string;
  assetsDir: string;
  hostModule: string;
}): Plugin {
  return {
    name: 'studio-graphic-sample',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(
        GRAPHIC_SAMPLE_BASE,
        graphicSampleMiddleware({
          sampleDir: paths.sampleDir,
          assetsDir: paths.assetsDir,
          loadHost: async () =>
            (await server.ssrLoadModule(paths.hostModule)) as unknown as GraphicHostRenderer,
        }),
      );
    },
  };
}
