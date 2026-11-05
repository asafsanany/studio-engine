// How the engine serves the files of a HyperFrames composition to the player in the browser. It is
// shared by the two places that do: the Review preview of a job (routes/preview.ts, the files of
// edit/preview/) and the Graphics preview (routes/graphic-files.ts, the files of one version).
//
// The rules are the same for both:
//
// - The name is percent-decoded exactly once (by Hono), refused when it is empty, has a NUL byte, is
//   absolute or has a `..` segment, and then resolved against the real path of the folder, so a
//   symlink that points out is refused too. Every refusal answers the same 404 text, so the answer
//   does not reveal what exists outside.
// - Every file is sent with `Cache-Control: no-cache` and an ETag, so new files are fetched again
//   and unchanged ones are answered 304. Byte ranges work as in the download, so video seeks.
// - Every file is sent as it is on disk, except two kinds of page. The root `index.html` is sent
//   with the timeline registry put first in its head (`injectTimelineRegistry`), because the player
//   loads the HyperFrames runtime after the page's own scripts. And every page (the root and the
//   sub-compositions under it) has `playsinline webkit-playsinline` added to each <video> tag that
//   lacks them (`injectPlaysInline`, PH9), or iPhone Safari plays the video in its own full-screen
//   player instead of in the preview. Such a page has an ETag made from the bytes it sends, since
//   they differ from the file's; a sub-composition that needs no change is sent as a file, like
//   the rest. The changes happen only on the way out and are never written to disk, so lint judges
//   the run's own file.

import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { extname, isAbsolute, join, posix } from 'node:path';
import type { Context } from 'hono';
import { matchesIfNoneMatch, resolveInside, serveFile } from './download.js';

/** A composition's root file. It is the only page `serveCompositionFile` adds the registry to. */
export const COMPOSITION_INDEX = 'index.html';

/** Content types by lower-case extension, without the dot. A Map, so "constructor" is not a key. */
export const PREVIEW_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['json', 'application/json'],
  ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
  ['m4a', 'audio/mp4'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['woff2', 'font/woff2'],
  ['woff', 'font/woff'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
]);

/** What the route puts first in the head of every root composition it serves (W9's finding). */
export const TIMELINE_REGISTRY_SCRIPT =
  '<script>window.__timelines = window.__timelines || {};</script>';

/** Where in `html` a tag matching `tag` starts and ends, outside HTML comments; null if none. */
function tagOutsideComments(html: string, tag: RegExp): { end: number } | null {
  const comments = [...html.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map(
    (comment) => [comment.index, comment.index + comment[0].length] as const,
  );
  for (const match of html.matchAll(new RegExp(tag.source, 'gi'))) {
    const at = match.index;
    if (!comments.some(([start, stop]) => at >= start && at < stop)) {
      return { end: at + match[0].length };
    }
  }
  return null;
}

/**
 * index.html with HyperFrames' timeline registry created before any of its own scripts run. The
 * player loads the runtime after the page's scripts, so a composition that registers its timeline
 * first throws "Cannot set properties of undefined (setting 'main')"; the player still fires
 * `ready`, and nothing animates. The `||` keeps a registry the page makes itself. Pure.
 *
 * The script goes right after the head tag (`\b` keeps `<header>` from counting as the head); with
 * no head, right after the html tag (the browser puts it in the head it makes); with no html tag
 * either, right after the doctype; otherwise at the very start. A page that already has the exact
 * script comes back unchanged, so this is idempotent.
 */
export function injectTimelineRegistry(html: string): string {
  if (html.includes(TIMELINE_REGISTRY_SCRIPT)) return html;
  for (const tag of [/<head\b[^>]*>/, /<html\b[^>]*>/, /<!doctype\b[^>]*>/]) {
    const found = tagOutsideComments(html, tag);
    if (found !== null) {
      return `${html.slice(0, found.end)}${TIMELINE_REGISTRY_SCRIPT}${html.slice(found.end)}`;
    }
  }
  return `${TIMELINE_REGISTRY_SCRIPT}${html}`;
}

/** What iPhone Safari needs on a <video> to play it in the page: today's name, and the one before iOS 10. */
export const PLAYS_INLINE_ATTRIBUTES = ['playsinline', 'webkit-playsinline'] as const;

/** Where `html` has a comment, a script or a style element: no tag inside them is a real one. */
function opaqueRanges(html: string): Array<readonly [number, number]> {
  const opaque = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
  return [...html.matchAll(opaque)].map((match) => [match.index, match.index + match[0].length]);
}

/**
 * `html` with `playsinline webkit-playsinline` on every <video> tag that lacks them (PH9). Without
 * `playsinline`, iPhone Safari takes a video out of the page into its own full-screen player as
 * soon as it plays, and the phone's Review would lose its preview; video-use writes the tags by
 * hand and may leave it out. Only the missing attribute is added, before the tag's end, so the
 * page's own attributes stay as they are. Tags inside comments, scripts and styles are left alone
 * (a script's text is not HTML), and so is an attribute's value that only mentions the words. A
 * page whose videos already have both comes back unchanged, so this is idempotent. Pure.
 */
export function injectPlaysInline(html: string): string {
  const opaque = opaqueRanges(html);
  return html.replace(
    /<video(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
    (tag: string, at: number) => {
      if (opaque.some(([start, stop]) => at >= start && at < stop)) return tag;
      // The attribute names, with every quoted value emptied so its words don't count.
      const names = tag
        .slice('<video'.length, -1)
        .replace(/"[^"]*"|'[^']*'/g, '""')
        .toLowerCase();
      const missing = PLAYS_INLINE_ATTRIBUTES.filter(
        (name) => !new RegExp(`(?:^|[\\s/])${name}(?=[\\s=/]|$)`).test(names),
      );
      if (missing.length === 0) return tag;
      const end = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;
      const before = tag.slice(0, end);
      const gap = /\s$/.test(before) ? '' : ' ';
      return `${before}${gap}${missing.join(' ')}${tag.slice(end)}`;
    },
  );
}

/** The Content-Type for a file name: by its extension, else application/octet-stream. */
export function previewContentType(fileName: string): string {
  const extension = extname(fileName).slice(1).toLowerCase();
  return PREVIEW_CONTENT_TYPES.get(extension) ?? 'application/octet-stream';
}

/** A decoded name the route may look up: not empty, no NUL, not absolute, no `..` segment. */
export function isSafePreviewPath(path: string): boolean {
  if (path === '' || path.includes('\0') || isAbsolute(path)) return false;
  return !path.split('/').includes('..');
}

/** A page read from disk, or null when it is gone or is not a file. */
async function readPage(path: string): Promise<{ html: string; lastModified: string } | null> {
  try {
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      return { html: await handle.readFile('utf8'), lastModified: info.mtime.toUTCString() };
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

/**
 * Answers a GET or HEAD with a page as it was changed on the way out: 200 with `html`, 304 when
 * the client's copy of those bytes is current. The ETag is a hash of the bytes sent. Ranges are
 * ignored (a page is small and the player never asks for a part), so it answers 200 with the
 * whole body and no Accept-Ranges.
 */
function sendPage(c: Context, html: string, lastModified: string): Response {
  const body = Buffer.from(html, 'utf8');
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 27)}"`;
  if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' },
    });
  }
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': lastModified,
    'Content-Length': String(body.length),
  });
  return new Response(c.req.method === 'HEAD' ? null : body, { status: 200, headers });
}

/**
 * Answers a GET or HEAD for the root composition: the page with the timeline registry in its head
 * and `playsinline` on its videos (`sendPage`), or 404 when the file is gone or is not a file.
 */
export async function serveComposition(
  c: Context,
  path: string,
  missingMessage: string,
): Promise<Response> {
  const page = await readPage(path);
  if (page === null) return c.json({ error: missingMessage }, 404);
  return sendPage(c, injectPlaysInline(injectTimelineRegistry(page.html)), page.lastModified);
}

export interface CompositionFileRequest {
  /** The real path of the folder the files come from; the caller has already checked it. */
  root: string;
  /** The name asked for: percent-decoded, relative to `root`. */
  name: string;
  /** The `{ error }` text of the 404 for a name that is refused, missing or not a file. */
  missingMessage: string;
}

/**
 * Answers a GET or HEAD for one file of a composition's folder: refuses an unsafe name or one that
 * leaves `root`, adds the timeline registry to the root index.html and `playsinline` to the videos
 * of every page, and sends everything else as it is, with its content type, `no-cache`, an ETag
 * and byte ranges.
 */
export async function serveCompositionFile(
  c: Context,
  { root, name, missingMessage }: CompositionFileRequest,
): Promise<Response> {
  const path = isSafePreviewPath(name) ? await resolveInside(root, name) : null;
  if (path === null) return c.json({ error: missingMessage }, 404);

  // The root composition (also as ./index.html) gets the timeline registry, and every page
  // `playsinline` on its videos; nothing else changes.
  if (posix.normalize(name) === COMPOSITION_INDEX || path === join(root, COMPOSITION_INDEX)) {
    return serveComposition(c, path, missingMessage);
  }
  if (previewContentType(name).startsWith('text/html')) {
    const page = await readPage(path);
    if (page !== null) {
      const html = injectPlaysInline(page.html);
      if (html !== page.html) return sendPage(c, html, page.lastModified);
    }
  }

  return serveFile(c, {
    path,
    contentType: previewContentType(name),
    disposition: 'inline',
    missingMessage,
    cache: 'revalidate',
  });
}
