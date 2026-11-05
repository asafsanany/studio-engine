// The staging folder of an import and the upload that fills it (Fonts plan, "Import"). OWNER: FN4.
//
//   multipart body (`files[]`, many; a folder pick sends each file under its path inside the folder)
//     ─▶ each file streamed to `<data>/font-staging/<stageId>/f<n>.upload`, every byte counted
//     ─▶ font-import.ts checks and groups them, then copies the chosen ones into `_Fonts`
//
// The name a file arrives under (`Fonts/Heebo/Heebo-Bold.ttf`, kept whole by busboy's
// `preservePath`) is read for two things only: to know whether the file came from a folder, and to
// show in a verdict. It never builds a path: every file is stored under a name of the engine's own.
//
//   - .DS_Store, `._` copies and any other dot name are thrown away without a word, and so is a
//     file that is not a font inside a folder (a licence .txt). A lone file that is not a font is
//     kept in the list, so the check can say so.
//   - A font over the per-file limit is counted but not kept: the size alone is its verdict.
//   - More files than the limit, or more bytes than the limit in all, end the upload (413).
//
// A stage is reaped at boot and after FONT_LIMITS.stageLifetimeMs (1 hour). Only the parser's
// buffers are held in memory, so 400 MB costs disk, not memory.

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { FONT_EXTENSIONS, FONT_LIMITS, FONT_MESSAGES } from '@studio/shared';
import busboy from 'busboy';
import { cleanFileName } from '../clients/style-upload.js';
import { isIgnoredName } from '../inbox/classify.js';
import { errorText } from '../pipeline/claude-process.js';
import type { WorkerLogger } from '../pipeline/worker.js';

// --- the staging folders -------------------------------------------------------------------------

/** `<data>/font-staging`: where every stage's folder is made. */
export function fontStagingRoot(dataDir: string): string {
  return join(dataDir, 'font-staging');
}

/** A stage: its id and its folder. */
export interface FontStage {
  stageId: string;
  dir: string;
}

export interface FontStaging {
  /** Makes an empty stage folder `<data>/font-staging/<stageId>/` for an upload to write into. */
  create(): Promise<FontStage>;
  /** The stage's folder, or `null` for an id the engine does not know (or one that was reaped). */
  find(stageId: string): Promise<FontStage | null>;
  /** Removes the stage's folder. Whether there was one. */
  remove(stageId: string): Promise<boolean>;
  /**
   * Removes the stages older than FONT_LIMITS.stageLifetimeMs at `now` (every stage, when `all`:
   * at boot nothing is waiting any more). Answers how many it removed.
   */
  reap(options?: { now?: Date; all?: boolean }): Promise<number>;
}

export interface FontStagingOptions {
  /** The engine's data folder; the stages are in {@link fontStagingRoot} of it. */
  dataDir: string;
  clock?: () => Date;
}

/** A stage id is 12 hex characters; anything else never names a folder (no `..`, no `/`). */
const STAGE_ID = /^[0-9a-f]{12}$/;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The staging folders of this engine. */
export function createFontStaging({
  dataDir,
  clock = () => new Date(),
}: FontStagingOptions): FontStaging {
  const root = fontStagingRoot(dataDir);
  return {
    async create() {
      await mkdir(root, { recursive: true });
      for (;;) {
        const stageId = randomBytes(6).toString('hex');
        const dir = join(root, stageId);
        try {
          await mkdir(dir); // not recursive: an id that exists fails and another is drawn
          return { stageId, dir };
        } catch (err) {
          if ((err as { code?: string }).code !== 'EEXIST') throw err;
        }
      }
    },
    async find(stageId) {
      if (!STAGE_ID.test(stageId)) return null;
      const dir = join(root, stageId);
      return (await isDirectory(dir)) ? { stageId, dir } : null;
    },
    async remove(stageId) {
      if (!STAGE_ID.test(stageId)) return false;
      const dir = join(root, stageId);
      if (!(await isDirectory(dir))) return false;
      await rm(dir, { recursive: true, force: true });
      return true;
    },
    async reap({ now = clock(), all = false } = {}) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return 0; // no staging folder yet
      }
      let removed = 0;
      for (const name of names) {
        if (!STAGE_ID.test(name)) continue;
        const dir = join(root, name);
        try {
          const info = await stat(dir);
          if (!info.isDirectory()) continue;
          if (!all && now.getTime() - info.mtimeMs < FONT_LIMITS.stageLifetimeMs) continue;
          await rm(dir, { recursive: true, force: true });
          removed += 1;
        } catch {
          // gone already, or not removable now: the next pass tries again
        }
      }
      return removed;
    },
  };
}

/** How often the engine looks for stages to reap while it runs. */
export const FONT_STAGE_REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Reaps every stage now (nothing waits across a restart) and then the old ones every hour. Answers
 * the function that stops it. The Fonts service calls it from `start()`.
 */
export function startFontStagingReaper(
  staging: FontStaging,
  logger: WorkerLogger,
  intervalMs: number = FONT_STAGE_REAP_INTERVAL_MS,
): () => void {
  const run = (all: boolean): void => {
    staging.reap({ all }).then(
      (removed) => {
        if (removed > 0) logger.info({ removed }, 'fonts: removed old uploads');
      },
      (err: unknown) => logger.warn({ err }, 'fonts: could not remove old uploads'),
    );
  };
  run(true);
  const timer = setInterval(() => run(false), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// --- the names an upload carries -----------------------------------------------------------------

/** A file an upload received: its name as sent (cleaned), where it was stored, its size. */
export interface ReceivedFontFile {
  /**
   * The name the browser sent, relative path included (`Fonts/Heebo/Heebo-Bold.ttf`), cleaned. For
   * the verdict and for grouping only: never to build a path.
   */
  name: string;
  /**
   * In the stage's folder. Not written for a file that is over the per-file limit or is not a font
   * file (see {@link isFontFileName}): there the size and the name are the verdict.
   */
  path: string;
  bytes: number;
}

/** The two collection extensions: kept, so the check can say "A font collection (.ttc) …". */
const COLLECTION_EXTENSIONS: ReadonlySet<string> = new Set(['.ttc', '.otc']);

/**
 * Whether a name is one the check reads: a font's extension, or a collection's (.ttc, .otc, which
 * the check answers with its own sentence).
 */
export function isFontFileName(name: string): boolean {
  const extension = extname(name).toLowerCase();
  return (
    (FONT_EXTENSIONS as readonly string[]).includes(extension) ||
    COLLECTION_EXTENSIONS.has(extension)
  );
}

/** The last part of a received name: the file's own name. */
export function baseNameOf(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** What the upload does with a name it was sent. */
export type UploadName =
  | { kind: 'ignore' }
  | { kind: 'file'; name: string; inFolder: boolean; candidate: boolean };

/** The longest relative name kept (code points): longer ones lose their front. */
const NAME_MAX = 300;

/**
 * Reads the name a file arrived under. A name with a dot part anywhere (`.DS_Store`, `._Heebo.ttf`,
 * `.git/…`), a partial download, or nothing left is ignored without a word; so is a file that is not
 * a font inside a folder (a licence .txt). A lone file that is not a font stays: it becomes a
 * `bad` item.
 */
export function readUploadName(raw: string): UploadName {
  const parts = raw
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: file names can hold them
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..');
  const last = parts.at(-1);
  if (last === undefined || parts.some((part) => isIgnoredName(part))) return { kind: 'ignore' };
  const inFolder = parts.length > 1;
  const candidate = isFontFileName(last);
  if (inFolder && !candidate) return { kind: 'ignore' };
  const base = cleanFileName(last);
  const name = [...parts.slice(0, -1), base].join('/');
  const kept = Array.from(name);
  return {
    kind: 'file',
    name: kept.length > NAME_MAX ? kept.slice(kept.length - NAME_MAX).join('') : name,
    inFolder,
    candidate,
  };
}

// --- the upload ----------------------------------------------------------------------------------

/** The body of an upload is a stage's files and the framing around them: this much room for it. */
export const FONT_UPLOAD_FORM_OVERHEAD_BYTES = 1024 * 1024;

/** A request the upload can't take: 400 (unreadable) or 413 (too many files or too many bytes). */
export class FontUploadError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = 'FontUploadError';
    this.status = status;
  }
}

export interface ReceiveFontOptions {
  /** The stage's folder (empty). The caller removes it when the stage fails. */
  stageDir: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

/** What an upload brought: the files that need a verdict, and how many it threw away unseen. */
export interface ReceivedFonts {
  files: ReceivedFontFile[];
  /** Files dropped without a word (dot names, non-fonts inside a folder). */
  ignored: number;
}

function asUploadError(error: unknown): Error {
  if (error instanceof FontUploadError) return error;
  return new FontUploadError(`${FONT_MESSAGES.badImport} (${errorText(error)})`, 400);
}

/**
 * Streams the files of a multipart request into `stageDir`. Rejects with a `FontUploadError` when
 * the body is not multipart or can't be read (400), has more than `maxFiles` files to check or
 * more than `maxTotalBytes` in all (413).
 */
export async function receiveFontFiles(
  request: Request,
  {
    stageDir,
    maxFiles = FONT_LIMITS.filesPerImport,
    maxFileBytes = FONT_LIMITS.fileMaxBytes,
    maxTotalBytes = FONT_LIMITS.stageMaxBytes,
  }: ReceiveFontOptions,
): Promise<ReceivedFonts> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data/i.test(contentType) || request.body === null) {
    throw new FontUploadError(FONT_MESSAGES.badImport, 400);
  }
  let parser: busboy.Busboy;
  try {
    // Browsers send file names as raw UTF-8; busboy would read them as Latin-1. `preservePath`
    // keeps the folders of a folder pick in the name (busboy would cut them off).
    parser = busboy({
      headers: { 'content-type': contentType },
      defParamCharset: 'utf8',
      preservePath: true,
    });
  } catch (error) {
    throw asUploadError(error);
  }
  const input = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>);

  const files: ReceivedFontFile[] = [];
  const writes: Promise<void>[] = [];
  const abortWrites = new AbortController();
  let ignored = 0;
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

    // Every byte counts toward the total, kept or not.
    const countOnly = (stream: Readable): void => {
      const counter = new Writable({
        write(chunk: Buffer, _encoding, done) {
          total += chunk.length;
          done(
            total > maxTotalBytes ? new FontUploadError(FONT_MESSAGES.stageTooLarge, 413) : null,
          );
        },
      });
      writes.push(
        pipeline(stream, counter, { signal: abortWrites.signal }).catch((error: unknown) =>
          fail(asUploadError(error)),
        ),
      );
    };

    parser.on('file', (_field, stream, info) => {
      if (failure !== null || !info.filename) {
        stream.on('error', () => undefined);
        stream.resume();
        return;
      }
      const read = readUploadName(info.filename);
      if (read.kind === 'ignore') {
        ignored += 1;
        countOnly(stream);
        return;
      }
      if (files.length >= maxFiles) {
        stream.on('error', () => undefined);
        stream.resume();
        fail(new FontUploadError(FONT_MESSAGES.tooManyFiles, 413));
        return;
      }
      const file: ReceivedFontFile = {
        name: read.name,
        path: join(stageDir, `f${files.length}.upload`),
        bytes: 0,
      };
      files.push(file);
      const keep = read.candidate;
      // Counts every byte; passes on only what a font file within the limit needs on disk.
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          file.bytes += chunk.length;
          total += chunk.length;
          if (total > maxTotalBytes) {
            done(new FontUploadError(FONT_MESSAGES.stageTooLarge, 413));
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
        pipeline(stream, counter, sink, { signal: abortWrites.signal })
          // A font over the limit was written up to the limit: that part is of no use to anyone.
          .then(() =>
            keep && file.bytes > maxFileBytes ? rm(file.path, { force: true }) : undefined,
          )
          .catch((error: unknown) => fail(asUploadError(error))),
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
  return { files, ignored };
}
