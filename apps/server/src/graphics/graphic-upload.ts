// The multipart body of `POST /api/graphics` and `POST /api/graphics/:id/messages` (Graphics plan,
// "API"), from the request into a staging folder, as clients/style-upload.ts does for a style:
//
//   multipart body ─▶ the fields `text` and `effort`, and each file streamed to `<staging>/<n>`,
//     every byte counted (the files that follow the limit, or are not images, videos, fonts or
//     PDFs, end the upload: 413, 415)
//   ─▶ the service moves each file into the graphic's refs/ under its own cleaned name
//
// Only the parser's buffers are held in memory, so a 500 MB clip costs disk, not memory.

import { createWriteStream } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { GRAPHIC_LIMITS, GRAPHIC_MESSAGES } from '@studio/shared';
import busboy from 'busboy';
import { cleanFileName } from '../clients/style-upload.js';
import { errorText } from '../pipeline/claude-process.js';
import type { ReceivedGraphicFile } from './graphic-folders.js';

/** A request the upload can't take: 400 (unreadable), 413 (too many or too large) or 415 (a file of the wrong kind). */
export class GraphicUploadError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.name = 'GraphicUploadError';
    this.status = status;
  }
}

/** The extensions of the files a message may carry: images, video, fonts and PDF. */
const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.heic',
  '.heif',
  '.bmp',
  '.tif',
  '.tiff',
  // video
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.avi',
  // fonts
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  // documents
  '.pdf',
]);

/** Browsers send a font as many things; these are the types of the other three kinds. */
const ATTACHMENT_MIME = /^(image\/|video\/|font\/|application\/pdf$|application\/(x-)?font-)/i;

/** Whether a file may be attached: by its extension, or by the type the browser gave it. */
export function isAttachable(name: string, mimeType: string): boolean {
  return ATTACHMENT_EXTENSIONS.has(extname(name).toLowerCase()) || ATTACHMENT_MIME.test(mimeType);
}

/** A message as the body carried it, before it is checked. */
export interface ReceivedGraphicMessage {
  /** The `text` field as sent, or `null` when there was none. */
  text: string | null;
  /** The `effort` field as sent (empty is none), or `null`. */
  effort: string | null;
  files: ReceivedGraphicFile[];
}

export interface ReceiveGraphicOptions {
  /** An empty folder for the files. The caller removes it. */
  stagingDir: string;
  maxFiles?: number;
  maxBytes?: number;
}

/** The largest value a text field may have: the text's limit in the longest characters, with room. */
const FIELD_MAX_BYTES = GRAPHIC_LIMITS.textMax * 4 + 1024;

function asUploadError(error: unknown): Error {
  if (error instanceof GraphicUploadError) return error;
  return new GraphicUploadError(`${GRAPHIC_MESSAGES.badMessage} (${errorText(error)})`, 400);
}

/**
 * Streams the body of a multipart request: its text fields, and its files into `stagingDir`,
 * counting bytes. Files without a name (an empty file input) are skipped. Rejects with a
 * `GraphicUploadError` when the body is not multipart or can't be read (400), has more than
 * `maxFiles` files or more than `maxBytes` (413), or carries a file that is not an image, a
 * video, a font or a PDF (415); files already staged stay for the caller to remove with the folder.
 */
export async function receiveGraphicMessage(
  request: Request,
  {
    stagingDir,
    maxFiles = GRAPHIC_LIMITS.refsMaxFiles,
    maxBytes = GRAPHIC_LIMITS.refsMaxBytes,
  }: ReceiveGraphicOptions,
): Promise<ReceivedGraphicMessage> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data/i.test(contentType) || request.body === null) {
    throw new GraphicUploadError(GRAPHIC_MESSAGES.badMessage, 400);
  }
  let parser: busboy.Busboy;
  try {
    // Browsers send file names as raw UTF-8; busboy would read them as Latin-1.
    parser = busboy({
      headers: { 'content-type': contentType },
      defParamCharset: 'utf8',
      limits: { fieldSize: FIELD_MAX_BYTES, fields: 10 },
    });
  } catch (error) {
    throw asUploadError(error);
  }
  const input = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>);

  const files: ReceivedGraphicFile[] = [];
  const writes: Promise<void>[] = [];
  // Aborts every file's pipeline (all of its streams) when the upload fails. Destroying only a file's
  // source stream is not enough: one that already ended but was not yet read would never tell the
  // pipeline, which would wait for it forever.
  const abortWrites = new AbortController();
  const fields: { text: string | null; effort: string | null } = { text: null, effort: null };
  let total = 0;
  let failure: Error | null = null;

  await new Promise<void>((resolve) => {
    const fail = (error: Error): void => {
      if (failure !== null) return;
      failure = error;
      abortWrites.abort();
      input.unpipe(parser);
      input.destroy();
      parser.destroy();
      resolve();
    };

    parser.on('field', (name, value, info) => {
      if (failure !== null) return;
      if (info.valueTruncated) {
        fail(new GraphicUploadError(GRAPHIC_MESSAGES.textTooLong, 400));
        return;
      }
      if (name === 'text') fields.text = value;
      else if (name === 'effort') fields.effort = value.trim() === '' ? null : value.trim();
    });
    // A file that is not kept is read and thrown away; destroying the parser while it is open makes
    // it emit an error nobody else would hear.
    const discard = (stream: Readable): void => {
      stream.on('error', () => undefined);
      stream.resume();
    };
    parser.on('file', (_field, stream, info) => {
      if (failure !== null || !info.filename) {
        discard(stream);
        return;
      }
      if (files.length >= maxFiles) {
        discard(stream);
        fail(new GraphicUploadError(GRAPHIC_MESSAGES.tooManyFiles, 413));
        return;
      }
      if (!isAttachable(info.filename, info.mimeType)) {
        discard(stream);
        fail(new GraphicUploadError(GRAPHIC_MESSAGES.badUploadType, 415));
        return;
      }
      const file: ReceivedGraphicFile = {
        name: cleanFileName(info.filename),
        path: join(stagingDir, String(files.length)),
        size: 0,
      };
      files.push(file);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          file.size += chunk.length;
          total += chunk.length;
          if (total > maxBytes) done(new GraphicUploadError(GRAPHIC_MESSAGES.tooLarge, 413));
          else done(null, chunk);
        },
      });
      writes.push(
        pipeline(stream, counter, createWriteStream(file.path), {
          signal: abortWrites.signal,
        }).catch((error: unknown) => fail(asUploadError(error))),
      );
    });
    parser.on('error', (error) => fail(asUploadError(error)));
    parser.on('close', () => resolve());
    input.on('error', (error) => fail(asUploadError(error)));
    input.pipe(parser);
  });

  // Every write has finished or stopped before the caller removes the folder.
  await Promise.allSettled(writes);
  if (failure !== null) throw failure;
  return { ...fields, files };
}
