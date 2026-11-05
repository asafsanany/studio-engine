// Files sent to `POST /api/clients/:clientId/style/files` (Phase 2 plan §5, Read pass), from the
// request body into the client's style folder:
//
//   multipart body ─▶ each file streamed to `_Style/.upload-<id>/<n>`, every byte counted
//     (a dot-folder, which the inbox watcher and the scanner skip; over the limit: 413)
//   ─▶ each file moved into `_Style` under its own name, or "name (1).ext" when that is taken
//
// Only the parser's buffers are held in memory, so a 2 GB upload costs disk, not memory. Staging
// inside the style folder keeps every move a rename on one volume.

import { createWriteStream } from 'node:fs';
import { lstat, rename, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import busboy from 'busboy';
import { isReservedName } from '../inbox/classify.js';
import { errorText } from '../pipeline/claude-process.js';
import { KIT_DIR_NAME, STYLE_FILE_NAME, STYLE_NEW_FILE_NAME } from './paths.js';
import type { StyleFile } from './style-pass.js';

/** The most one upload may carry, all files together. */
export const MAX_STYLE_UPLOAD_BYTES = 2 * 1024 ** 3;

export const UPLOAD_TOO_LARGE = 'The files are larger than 2 GB together. Send fewer at a time.';

/** Longest file name kept, in UTF-8 bytes: APFS allows 255, and " (12)" must still fit. */
const MAX_NAME_BYTES = 200;

/** Names in `_Style` that are the engine's own: an uploaded file never takes one. */
const RESERVED_NAMES = [STYLE_FILE_NAME, STYLE_NEW_FILE_NAME, KIT_DIR_NAME] as const;

/** A request the upload can't take: 400 (unreadable, not multipart) or 413 (too large). */
export class StyleUploadError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = 'StyleUploadError';
    this.status = status;
  }
}

/** One file of the upload, on disk in the staging folder. */
export interface StagedFile {
  /** The name it will get (see {@link cleanFileName}), before a taken name is numbered. */
  name: string;
  /** Where it is staged. */
  path: string;
  size: number;
}

export interface StagedUpload {
  /** The `mode` field as sent, or null when there was none. */
  mode: string | null;
  files: StagedFile[];
}

export interface ReceiveUploadOptions {
  /** An empty folder for the files, inside the style folder. The caller removes it. */
  stagingDir: string;
  /** Total bytes allowed; one more and the upload fails with 413. */
  maxBytes: number;
}

function shorten(name: string): string {
  if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const extension = extname(name);
  const stem = [...name.slice(0, name.length - extension.length)];
  while (stem.length > 1 && Buffer.byteLength(stem.join('') + extension) > MAX_NAME_BYTES) {
    stem.pop();
  }
  return stem.join('') + extension;
}

/**
 * A file name as the browser sent it, made fit for `_Style`: only its last part (no folders), in
 * NFC, without control characters or leading dots (a dotfile is hidden from the watcher and the
 * run), at most 200 bytes. "file" when nothing is left.
 */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const name = base
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: file names can hold them
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return name === '' ? 'file' : shorten(name);
}

/** "logo.png" with a number: "logo (1).png"; "README" becomes "README (1)". */
export function numberedName(name: string, n: number): string {
  const extension = extname(name);
  return `${name.slice(0, name.length - extension.length)} (${n})${extension}`;
}

async function isTaken(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `name`, or the first of "name (1)", "name (2)", … that is free in `styleDir`. The engine's own
 * names (style.md, style.md.new, kit) count as taken. The volume decides what "taken" means, so
 * on a case-insensitive one "Logo.png" is taken by "logo.png".
 */
export async function freeStyleName(styleDir: string, name: string): Promise<string> {
  for (let n = 0; ; n += 1) {
    const candidate = n === 0 ? name : numberedName(name, n);
    if (RESERVED_NAMES.some((reserved) => isReservedName(candidate, reserved))) continue;
    if (!(await isTaken(join(styleDir, candidate)))) return candidate;
  }
}

/** A failed write as the error the route answers with. */
function asUploadError(error: unknown): Error {
  if (error instanceof StyleUploadError) return error;
  return new StyleUploadError(`The upload could not be read: ${errorText(error)}`, 400);
}

/**
 * Streams the files of a multipart request into `stagingDir`, counting bytes. Files without a name
 * (an empty file input) are skipped. Rejects with a `StyleUploadError` when the body is not
 * multipart, can't be read, or carries more than `maxBytes`; files already staged stay for the
 * caller to remove with the folder.
 */
export async function receiveUpload(
  request: Request,
  { stagingDir, maxBytes }: ReceiveUploadOptions,
): Promise<StagedUpload> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data/i.test(contentType) || request.body === null) {
    throw new StyleUploadError('Send the files as multipart/form-data.', 400);
  }
  let parser: busboy.Busboy;
  try {
    // Browsers send file names as raw UTF-8; busboy would read them as Latin-1.
    parser = busboy({ headers: { 'content-type': contentType }, defParamCharset: 'utf8' });
  } catch (error) {
    throw new StyleUploadError(`The upload could not be read: ${errorText(error)}`, 400);
  }
  const input = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>);

  const files: StagedFile[] = [];
  const writes: Promise<void>[] = [];
  const open = new Set<Readable>();
  let mode: string | null = null;
  let total = 0;
  let failure: Error | null = null;

  await new Promise<void>((resolve) => {
    const fail = (error: Error): void => {
      if (failure !== null) return;
      failure = error;
      input.unpipe(parser);
      input.destroy();
      for (const stream of open) stream.destroy();
      parser.destroy();
      resolve();
    };

    parser.on('field', (name, value) => {
      if (name === 'mode') mode = value;
    });
    parser.on('file', (_field, stream, info) => {
      if (failure !== null || !info.filename) {
        stream.resume();
        return;
      }
      const file: StagedFile = {
        name: cleanFileName(info.filename),
        path: join(stagingDir, String(files.length)),
        size: 0,
      };
      files.push(file);
      open.add(stream);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          file.size += chunk.length;
          total += chunk.length;
          if (total > maxBytes) done(new StyleUploadError(UPLOAD_TOO_LARGE, 413));
          else done(null, chunk);
        },
      });
      writes.push(
        pipeline(stream, counter, createWriteStream(file.path))
          .catch((error: unknown) => fail(asUploadError(error)))
          .finally(() => open.delete(stream)),
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
  return { mode, files };
}

/** What an uploaded file looks like once it is in place. */
export interface MovedFileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Moves the staged files into `styleDir`, each under a free name (see {@link freeStyleName}), and
 * returns them as the Read pass lists them. `announce` hears of each file just before it moves.
 */
export async function moveIntoStyle(
  files: readonly StagedFile[],
  styleDir: string,
  announce?: (name: string, stat: MovedFileStat) => void,
): Promise<StyleFile[]> {
  const moved: StyleFile[] = [];
  for (const file of files) {
    const name = await freeStyleName(styleDir, file.name);
    const info = await stat(file.path);
    announce?.(name, { size: info.size, mtimeMs: info.mtimeMs });
    await rename(file.path, join(styleDir, name));
    moved.push({ name, size: info.size });
  }
  return moved;
}
