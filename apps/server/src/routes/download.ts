// Serving files from disk with byte ranges. The export download (`serveExport`, the file-side half
// of `GET /api/jobs/:id/download`) and, through `serveFile`, the live preview (preview.ts) and the
// voice-note audio use it.
//
// Kept apart from the routes so the parts with edge cases (byte ranges, Hebrew file names, paths
// that must stay inside a folder) can be tested on their own.

import type { FileHandle } from 'node:fs/promises';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';

/** An inclusive byte range, as `Content-Range` counts: `start` to `end`, both included. */
export interface ByteRange {
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
 * Reads a `Range` header (RFC 9110 §14).
 *
 * - No header, a unit other than `bytes`, or several ranges at once: the whole file. A server may
 *   ignore a Range header, and the clients that matter ask for one range at a time.
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

/** `text` with any lone surrogate replaced by U+FFFD (`encodeURIComponent` throws on those). */
function wellFormed(text: string): string {
  return text.replace(/\p{Surrogate}/gu, '\uFFFD');
}

/** Percent-encodes `text` for `filename*=` (RFC 5987 / RFC 8187): UTF-8, only attr-chars left. */
export function encodeRFC5987(text: string): string {
  return encodeURIComponent(wellFormed(text)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The `Content-Disposition` value for downloading `fileName`. `filename*` carries the real name in
 * UTF-8, so Hebrew arrives intact; `filename` is the plain-ASCII fallback for clients that do not
 * read `filename*`. The header is always pure ASCII, which `Headers` requires.
 */
export function contentDisposition(fileName: string): string {
  // Control characters, path separators and quotes have no business in a name the browser saves.
  const name = wellFormed(fileName).replace(/[\p{Cc}/\\]/gu, '_');
  const ascii = name
    .replace(/[^\x20-\x7e]+/g, '_')
    .replace(/["%]/g, '_')
    .trim();
  const fallback = /[A-Za-z0-9]/.test(ascii.replace(/\.mp4$/i, '')) ? ascii : 'export.mp4';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(name)}`;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * The real path of `fileName` (relative to `root`), or `null` when it is missing or would leave
 * `root`: through `..`, an absolute name, or a symlink that points outside.
 */
export async function resolveInside(root: string, fileName: string): Promise<string | null> {
  const rootPath = resolve(root);
  const target = resolve(rootPath, fileName);
  if (!isInside(rootPath, target)) return null;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(rootPath), realpath(target)]);
    return isInside(realRoot, realTarget) ? realTarget : null;
  } catch {
    // Missing, or a name the file system refuses (a NUL byte).
    return null;
  }
}

export interface ExportFile {
  /** Absolute path, already checked to be inside the exports folder. */
  path: string;
  /** The name the browser saves it under, e.g. `Spring menu.mp4`. */
  downloadName: string;
}

export interface ServedFile {
  /** Absolute path, already checked with resolveInside. */
  path: string;
  /** The Content-Type header, e.g. 'video/mp4' or 'text/html; charset=utf-8'. */
  contentType: string;
  /** 'inline' sends `Content-Disposition: inline`; { attachment } sends contentDisposition(name). */
  disposition: 'inline' | { attachment: string };
  /** The { error } text of the 404 when the file is gone or is not a file. */
  missingMessage: string;
  /**
   * 'revalidate': Cache-Control: no-cache, and 304 for a matching If-None-Match.
   * Left out: no Cache-Control, and If-None-Match is ignored (the download, as it always was).
   */
  cache?: 'revalidate';
}

/** If-None-Match (RFC 9110 §13.1.2): `*`, or a list of tags compared weakly (W/"x" matches "x"). */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = header.trim();
  if (value === '*') return true;
  return value.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

/**
 * Answers a GET or HEAD for one file: 200 with the whole file, 206 for one byte range, 304 when
 * the client's copy is current (`cache: 'revalidate'` only), 416 for a range the file cannot
 * satisfy, 404 when the file is gone or is not a file. The file is opened once and every decision
 * is made on that handle, so it cannot change between the checks and the first byte.
 */
export async function serveFile(c: Context, file: ServedFile): Promise<Response> {
  let handle: FileHandle;
  try {
    handle = await open(file.path, 'r');
  } catch {
    return c.json({ error: file.missingMessage }, 404);
  }

  let streaming = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return c.json({ error: file.missingMessage }, 404);

    const size = info.size;
    const etag = `"${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const lastModified = info.mtime.toUTCString();
    const headers = new Headers({
      'Content-Type': file.contentType,
      'Content-Disposition':
        file.disposition === 'inline' ? 'inline' : contentDisposition(file.disposition.attachment),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified,
    });

    if (file.cache === 'revalidate') {
      headers.set('Cache-Control', 'no-cache');
      // Before the Range decision: a current copy is 304 whatever part was asked for.
      if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' },
        });
      }
    }

    // If-Range: the client only wants a part if the file is still the one it started on.
    const ifRange = c.req.header('If-Range');
    const rangeHeader =
      ifRange === undefined || ifRange === etag || ifRange === lastModified
        ? c.req.header('Range')
        : undefined;

    const decision = decideRange(rangeHeader, size);
    if (decision.kind === 'unsatisfiable') {
      return c.json({ error: 'Range not satisfiable.' }, 416, {
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
      });
    }

    const range =
      decision.kind === 'partial' ? decision.range : { start: 0, end: Math.max(size - 1, 0) };
    const length = size === 0 ? 0 : range.end - range.start + 1;
    headers.set('Content-Length', String(length));
    if (decision.kind === 'partial') {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    }
    const status = decision.kind === 'partial' ? 206 : 200;

    if (c.req.method === 'HEAD' || length === 0) return new Response(null, { status, headers });

    streaming = true; // the stream closes the handle when it ends, fails or is cancelled
    const stream = handle.createReadStream({ start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
  } finally {
    if (!streaming) await handle.close().catch(() => {});
  }
}

/**
 * Answers a GET or HEAD for the export: 200 with the whole file, 206 for one byte range, 416 for
 * a range the file cannot satisfy, 404 when the file is gone. See `serveFile` for how the file is
 * read.
 */
export async function serveExport(
  c: Context,
  { path, downloadName }: ExportFile,
): Promise<Response> {
  return serveFile(c, {
    path,
    contentType: 'video/mp4',
    disposition: { attachment: downloadName },
    missingMessage: 'The export file is missing.',
  });
}
