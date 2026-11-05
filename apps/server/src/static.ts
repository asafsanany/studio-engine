import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { logger } from './logger.js';

const ASSET_PREFIX = '/assets/';
// Vite fingerprints everything under /assets, so a URL never changes content.
const IMMUTABLE = 'public, max-age=31536000, immutable';
// The app icons sit at the root under fixed names (iOS asks for /apple-touch-icon.png by itself),
// so they can't be fingerprinted; they almost never change, so a month is long enough.
const ICON_CACHE = 'public, max-age=2592000';
const ICON_PATH = /^\/(?:apple-touch-icon|icon-[a-z0-9-]+)\.png$/;
// index.html and every other root file (the web app manifest too) must be revalidated on each load.
const REVALIDATE = 'no-cache';

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

// A last path segment such as `x-abc123.js` or `logo.png`. Client-side routes have none.
const FILE_EXTENSION = /\.[A-Za-z0-9]+$/;

// A URL that names a file (everything under /assets, or any last segment with an extension).
// If it isn't on disk it must 404: answering with index.html would hand HTML to a <script> tag.
function isFilePath(path: string): boolean {
  return path.startsWith(ASSET_PREFIX) || FILE_EXTENSION.test(path);
}

function cacheControlFor(path: string): string {
  if (path.startsWith(ASSET_PREFIX)) return IMMUTABLE;
  return ICON_PATH.test(path) ? ICON_CACHE : REVALIDATE;
}

const noop = async (): Promise<void> => {};

/**
 * Serves the built web app from `webDist`. Real files come first, then index.html for any
 * extension-less GET so client-side routes such as /jobs/123 load the SPA. Missing files (anything
 * under /assets, or with an extension) and /api paths are never answered with the shell, so a
 * stale hashed chunk gets a 404 and unknown API routes keep their JSON 404.
 */
export function mountWebApp(app: Hono, webDist: string): void {
  const indexFile = join(webDist, 'index.html');
  if (!existsSync(indexFile)) {
    logger.warn({ indexFile }, 'web app is not built, serving /api only (run `pnpm build` first)');
    return;
  }

  // `root` resolves files under webDist; `path` pins the SPA shell regardless of the URL.
  const serveFile = serveStatic({ root: webDist });
  const serveIndex = serveStatic({ path: indexFile });

  app.use('*', async (c, next) => {
    const { path } = c.req;
    if (isApiPath(path)) return next();

    const file = await serveFile(c, noop);
    if (file) {
      file.headers.set('Cache-Control', cacheControlFor(path));
      return file;
    }

    if (c.req.method !== 'GET' || isFilePath(path)) return next();
    const index = await serveIndex(c, noop);
    if (!index) return next();
    index.headers.set('Cache-Control', REVALIDATE);
    return index;
  });
}
