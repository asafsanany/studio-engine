// The multipart body of `POST /api/luts/stage` (LUTs plan, "Import"), from the request into the
// stage's folder, as graphics/graphic-upload.ts does for a message:
//
//   multipart body (`files[]`, many) ─▶ each file streamed to `<stage>/f<n>.upload`, every byte
//   counted. A name with folders (a folder pick) is flattened to its base name. A file that is not
//   .cube/.3dl, or is over the per-file limit, is read and thrown away: the check gives it a
//   verdict, it is not a failure of the request. Only too many files (413), too many bytes in all
//   (413) or a body that is not multipart (400) end the upload.
//
// Only the parser's buffers are held in memory, so 400 MB costs disk, not memory.

import { createWriteStream } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { LUT_LIMITS, LUT_MESSAGES } from '@studio/shared';
import busboy from 'busboy';
import { cleanFileName } from '../clients/style-upload.js';
import { errorText } from '../pipeline/claude-process.js';

/** What all the files of one import may add up to. */
export const LUT_UPLOAD_MAX_BYTES = 400 * 1024 * 1024;

/** 413, an upload over {@link LUT_UPLOAD_MAX_BYTES} in all. */
export const LUT_UPLOAD_TOO_MUCH = 'That is too much to import at once: 400 MB at most.';

/** A file an upload received: its name as sent (flattened), where it was stored, its size. */
export interface ReceivedLutFile {
  name: string;
  /** In the stage's folder. Not written for a file that is not .cube/.3dl or is over the limit. */
  path: string;
  bytes: number;
}

/** A request the upload can't take: 400 (unreadable) or 413 (too many files or too many bytes). */
export class LutUploadError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = 'LutUploadError';
    this.status = status;
  }
}

export interface ReceiveLutOptions {
  /** The stage's folder (empty). The caller removes it when the stage fails. */
  stageDir: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/** Whether a name is one the check reads: .cube or .3dl. */
export function isLutFileName(name: string): boolean {
  const extension = extname(name).toLowerCase();
  return extension === '.cube' || extension === '.3dl';
}

function asUploadError(error: unknown): Error {
  if (error instanceof LutUploadError) return error;
  return new LutUploadError(`${LUT_MESSAGES.badImport} (${errorText(error)})`, 400);
}

/**
 * Streams the files of a multipart request into `stageDir`. Rejects with a `LutUploadError` when
 * the body is not multipart or can't be read (400), or has more than `maxFiles` files or more than
 * `maxTotalBytes` (413).
 */
export async function receiveLutFiles(
  request: Request,
  {
    stageDir,
    maxFiles = LUT_LIMITS.filesPerImport,
    maxFileBytes = LUT_LIMITS.fileMaxBytes,
    maxTotalBytes = LUT_UPLOAD_MAX_BYTES,
  }: ReceiveLutOptions,
): Promise<ReceivedLutFile[]> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data/i.test(contentType) || request.body === null) {
    throw new LutUploadError(LUT_MESSAGES.badImport, 400);
  }
  let parser: busboy.Busboy;
  try {
    // Browsers send file names as raw UTF-8; busboy would read them as Latin-1.
    parser = busboy({ headers: { 'content-type': contentType }, defParamCharset: 'utf8' });
  } catch (error) {
    throw asUploadError(error);
  }
  const input = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>);

  const files: ReceivedLutFile[] = [];
  const writes: Promise<void>[] = [];
  const abortWrites = new AbortController();
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
        fail(new LutUploadError(LUT_MESSAGES.tooManyFiles, 413));
        return;
      }
      const name = cleanFileName(info.filename);
      const file: ReceivedLutFile = {
        name,
        path: join(stageDir, `f${files.length}.upload`),
        bytes: 0,
      };
      files.push(file);
      const keep = isLutFileName(name);
      // Counts every byte; passes on only what a LUT file within the limit needs on disk.
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          file.bytes += chunk.length;
          total += chunk.length;
          if (total > maxTotalBytes) {
            done(new LutUploadError(LUT_UPLOAD_TOO_MUCH, 413));
          } else if (keep && file.bytes <= maxFileBytes) {
            done(null, chunk);
          } else {
            done();
          }
        },
      });
      const sink = keep
        ? createWriteStream(file.path)
        : new Writable({ write: (_chunk, _encoding, done) => done() });
      writes.push(
        pipeline(stream, counter, sink, { signal: abortWrites.signal }).catch((error: unknown) =>
          fail(asUploadError(error)),
        ),
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
  return files;
}
