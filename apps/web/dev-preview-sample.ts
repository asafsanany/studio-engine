// The dev server's /__dev/preview-sample/ route: the sample composition the review player plays on
// /components (CVP-121). Split out of vite.config.ts, like dev-proxy.ts, so it can be tested
// against a real Vite server (dev-preview-sample.test.ts). Dev only: `apply: 'serve'`.
//
// It stands in for the engine's `GET /api/jobs/:id/preview/*` (W4), so the player meets the same
// kind of server: a real content type per file, `Range` support (Chrome will not seek a <video>
// without it), no-cache, and a plain 404 for what is missing.

import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Connect, Plugin } from 'vite';

/** Where the sample composition is mounted on the dev server. */
export const PREVIEW_SAMPLE_BASE = '/__dev/preview-sample';

/** Content types by file extension (lower case, no dot); anything else is not served. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
};

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * The file `url` names under `root`, or `null` when it names nothing we may serve. `url` is
 * `req.url` after connect has stripped the mount, e.g. `/cut.mp4?x=1`.
 *
 * The query and the hash are dropped, the path is percent-decoded (a malformed escape or a NUL
 * byte gives `null`), `''` and `/` mean `index.html`, the result must stay inside `root` (so `..`
 * and `%2e%2e` get nowhere) and have an extension in {@link CONTENT_TYPES}.
 */
export function resolveSampleFile(root: string, url: string): string | null {
  const path = (url.split('#')[0] ?? '').split('?')[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const name = decoded.replace(/^\/+/, '');
  const base = resolve(root);
  const target = resolve(base, name === '' ? 'index.html' : name);
  if (!isInside(base, target)) return null;
  return extname(target).slice(1).toLowerCase() in CONTENT_TYPES ? target : null;
}

/** An inclusive byte range, as `Content-Range` counts: `start` to `end`, both included. */
interface ByteRange {
  start: number;
  end: number;
}

/** What a `Range` header means for a file of a given size. */
export type RangeDecision =
  /** No usable Range header: send the whole file with 200. */
  | { kind: 'full' }
  /** Send this part with 206. */
  | { kind: 'partial'; range: ByteRange }
  /** Nothing in the file matches: answer 416. */
  | { kind: 'unsatisfiable' };

const FULL: RangeDecision = { kind: 'full' };
const UNSATISFIABLE: RangeDecision = { kind: 'unsatisfiable' };

const RANGE_HEADER = /^\s*bytes\s*=\s*(.*?)\s*$/i;
const RANGE_SPEC = /^(\d*)-(\d*)$/;

/**
 * A copy of `decideRange` in apps/server/src/routes/download.ts (same rules, same tests): the web
 * app can't import server code. Reads a `Range` header (RFC 9110 §14).
 *
 * - No header, a unit other than `bytes`, or several ranges at once: the whole file.
 * - `bytes=a-b`, `bytes=a-` and `bytes=-n` (the last n bytes): that part, with `b` cut back to the
 *   end of the file.
 * - Starting at or after the end, `a` greater than `b`, `-0`, or text that is not a range:
 *   unsatisfiable.
 */
export function decideRange(header: string | null | undefined, size: number): RangeDecision {
  if (header === null || header === undefined) return FULL;
  const unit = RANGE_HEADER.exec(header);
  if (unit === null) return FULL;

  const spec = unit[1] ?? '';
  if (spec.includes(',')) return FULL;

  const parts = RANGE_SPEC.exec(spec);
  const first = parts?.[1] ?? '';
  const last = parts?.[2] ?? '';
  if (parts === null || (first === '' && last === '')) return UNSATISFIABLE;

  if (first === '') {
    // "-n": the last n bytes (all of them if the file is shorter).
    const count = Number(last);
    if (count === 0 || size === 0) return UNSATISFIABLE;
    return { kind: 'partial', range: { start: Math.max(0, size - count), end: size - 1 } };
  }

  const start = Number(first);
  if (start >= size) return UNSATISFIABLE;
  if (last === '') return { kind: 'partial', range: { start, end: size - 1 } };
  const end = Number(last);
  if (end < start) return UNSATISFIABLE;
  return { kind: 'partial', range: { start, end: Math.min(end, size - 1) } };
}

function sendText(res: ServerResponse, status: number, body: string, head: boolean): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(head ? undefined : body);
}

/**
 * Serves the sample composition in `root`. GET and HEAD only (405 otherwise). A path that does not
 * resolve and a file that is missing both get 404 "Not found", and `next()` is never called for a
 * path under the mount: Vite's SPA fallback would answer a missing `.html` with the app's own
 * index.html, and the player would then run the app inside its iframe.
 */
export function previewSampleMiddleware(root: string): Connect.NextHandleFunction {
  return async (req, res) => {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD');
      sendText(res, 405, 'Method not allowed', false);
      return;
    }

    const file = resolveSampleFile(root, req.url ?? '/');
    let bytes: Buffer | null = null;
    if (file !== null) {
      try {
        bytes = await readFile(file);
      } catch {
        // Missing, or a folder: 404 below.
      }
    }
    if (file === null || bytes === null) {
      sendText(res, 404, 'Not found', head);
      return;
    }

    const size = bytes.length;
    const headers: Record<string, string | number> = {
      'Content-Type':
        CONTENT_TYPES[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };

    const decision = decideRange(req.headers.range, size);
    if (decision.kind === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      res.end();
      return;
    }
    if (decision.kind === 'partial') {
      const { start, end } = decision.range;
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      res.end(head ? undefined : bytes.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    res.end(head ? undefined : bytes);
  };
}

/**
 * The dev-only plugin that mounts {@link previewSampleMiddleware} at {@link PREVIEW_SAMPLE_BASE}.
 * Creating it touches no file (Vitest loads vite.config.ts too); the folder is read per request.
 */
export function previewSamplePlugin(root: string): Plugin {
  return {
    name: 'studio-preview-sample',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(PREVIEW_SAMPLE_BASE, previewSampleMiddleware(root));
    },
  };
}
