import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { InputCounts } from '@studio/shared';
import {
  classifyFile,
  EDIT_DIR_NAME,
  EXPORTS_DIR_NAME,
  emptyInputCounts,
  type FileKind,
  FONTS_DIR_NAME,
  GRAPHICS_DIR_NAME,
  isDotName,
  isIgnoredName,
  isPackageName,
  isReservedJobName,
  isReservedName,
  isTimedKind,
  LUTS_DIR_NAME,
  REFERENCE_DIR_NAME,
  STYLE_DIR_NAME,
} from './classify.js';
import { isRegisteredClient } from './client-registry.js';
import { type DurationCache, type FileSignature, sharedDurationCache } from './probe.js';

/**
 * Everything the engine needs to know about one job folder, `<inbox>/<Client>/<Job>`.
 *
 * `client`, `name` and `relPath` are exactly as the file system lists them (Hebrew and emoji
 * included, no Unicode normalisation). Only `id` is derived from the NFC form of `relPath`.
 */
export interface ScannedJob {
  /** First 12 hex characters of sha1(relPath, NFC). See {@link jobIdFor}. */
  id: string;
  client: string;
  name: string;
  /** `Client/Job`, with a forward slash. */
  relPath: string;
  absPath: string;
  /** Files by kind. All four keys are always present. */
  inputs: InputCounts;
  /** Bytes of every file in the job, unknown file types included. `edit/` is not counted. */
  sizeBytes: number;
  /** Seconds of video and audio, summed over ffprobe durations. 0 for files ffprobe cannot read. */
  footageSec: number;
  /**
   * The newest modification time (ms since epoch) over the counted files, 0 for an empty job.
   * Folders are left out on purpose, since Finder and the engine itself touch them. A deletion
   * leaves no trace here, and a file copied with its dates kept (Finder does this) may be old:
   * use event times for settle timers and compare counts and size to spot removals.
   */
  newestMtimeMs: number;
}

export interface ScanOptions {
  /**
   * The configured exports folder (`Config.exportsDir`). Skipped wherever it sits in the inbox,
   * so an exports folder that is not called `_Exports` is not mistaken for a client or a job.
   */
  exportsDir?: string;
  /**
   * Where footage lengths are probed and remembered. Defaults to a cache shared by the whole
   * process that uses ffprobe from PATH. Tests pass `new DurationCache(fakeProbe)`.
   */
  durations?: DurationCache;
  /** Called when a folder cannot be read and is skipped, e.g. `EACCES`. Missing folders are silent. */
  onSkip?: (path: string, error: unknown) => void;
  /**
   * Whether `scanInbox` makes `<Client>/_Style` in every client folder it lists (default true).
   * See {@link ensureStyleDir}.
   */
  createStyleDirs?: boolean;
  /**
   * The Generate switch (`Config.generate`). On, a video or an audio file under the job's
   * `reference/` folder is style to match and never footage (Generated videos, GN4): it still
   * counts toward the job's size, but not toward its `inputs` or its `footageSec`, so a folder
   * with a script and a reference video is a job with no footage. Off (the default), `reference/`
   * is a folder like any other and the counts are exactly what they were.
   */
  generate?: boolean;
}

/** `Client/Job`, as stored in the database. */
export function jobRelPath(client: string, name: string): string {
  return `${client}/${name}`;
}

/**
 * The stable id of a job: the first 12 hex characters of sha1 of its relative path, `Client/Job`.
 *
 * The path is NFC-normalised before hashing. macOS can list the same folder name decomposed
 * (NFD) or precomposed (NFC) depending on the volume and on the app that created it, and the id
 * must not change with that. Case is not folded: a renamed folder is a new job.
 */
export function jobIdFor(relPath: string): string {
  return shortHash(relPath);
}

/**
 * The stable id of a client: the first 12 hex characters of sha1 of the client folder's name,
 * NFC-normalised like {@link jobIdFor}. The key of the client pages and of `client_styles`.
 */
export function clientIdFor(client: string): string {
  return shortHash(client);
}

/**
 * The stable id of a series: the first 12 hex characters of sha1 of `<clientId>/<name>`,
 * NFC-normalised like {@link jobIdFor} (Series plan §2). The key of the `series` table and of the
 * series page. `name` is the series' name as it was started (`normalizeSeriesName`).
 */
export function seriesIdFor(clientId: string, name: string): string {
  return shortHash(`${clientId}/${name}`);
}

function shortHash(text: string): string {
  return createHash('sha1').update(text.normalize('NFC'), 'utf8').digest('hex').slice(0, 12);
}

interface Context {
  /** The inbox as an absolute path. */
  inbox: string;
  /** The exports folder as a comparable path, or undefined. */
  exportsKey: string | undefined;
  durations: DurationCache;
  onSkip: (path: string, error: unknown) => void;
  createStyleDirs: boolean;
  generate: boolean;
}

/** A path in a form that compares equal across NFC/NFD spellings and trailing slashes. */
function pathKey(path: string): string {
  return resolve(path).normalize('NFC');
}

function createContext(inboxPath: string, options: ScanOptions): Context {
  return {
    inbox: resolve(inboxPath),
    exportsKey: options.exportsDir === undefined ? undefined : pathKey(options.exportsDir),
    durations: options.durations ?? sharedDurationCache(),
    onSkip: options.onSkip ?? (() => {}),
    createStyleDirs: options.createStyleDirs ?? true,
    generate: options.generate === true,
  };
}

function isExcluded(ctx: Context, path: string): boolean {
  return ctx.exportsKey !== undefined && pathKey(path) === ctx.exportsKey;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** The folder or file is gone, or a path component is not a folder: nothing to report. */
function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Lists a folder. One that is gone or unreadable is empty; unreadable ones are reported. */
async function readEntries(dir: string, ctx: Context): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (!isMissing(error)) ctx.onSkip(dir, error);
    return [];
  }
}

// --- levels 1 and 2: clients and jobs ---------------------------------------------------------

/**
 * Names that cannot be a client folder: dot-folders, `_Exports`, the shared `_Fonts`, the Graphics
 * library `_Graphics`, the LUTs library `_LUTs` and the configured exports folder. The caller also
 * checks that the entry is a real folder (not a file, not a symlink).
 */
function isClientName(name: string, ctx: Context): boolean {
  return (
    !isDotName(name) &&
    !isReservedName(name, EXPORTS_DIR_NAME) &&
    !isReservedName(name, FONTS_DIR_NAME) &&
    !isReservedName(name, GRAPHICS_DIR_NAME) &&
    !isReservedName(name, LUTS_DIR_NAME) &&
    !isExcluded(ctx, join(ctx.inbox, name))
  );
}

/**
 * Names that cannot be a job folder: dot-folders, the client's `_Style`, `_Series` and `_Shared`
 * folders and the configured exports folder.
 */
function isJobName(name: string, clientAbs: string, ctx: Context): boolean {
  return !isDotName(name) && !isReservedJobName(name) && !isExcluded(ctx, join(clientAbs, name));
}

/** A folder name from outside (a watcher event) that can sit directly under another folder. */
function isSingleSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\0')
  );
}

// --- inside a job: the recursive walk ---------------------------------------------------------

interface Totals {
  counts: InputCounts;
  sizeBytes: number;
  newestMtimeMs: number;
  /** Video and audio files, to be probed once the walk is done. */
  timed: { absPath: string; signature: FileSignature }[];
  /** Every file the walk counted, when the caller asked for the list (`listJobFiles`). */
  files?: { absPath: string; kind: FileKind; size: number; mtimeMs: number }[];
}

/**
 * Adds one file to `totals`. `reference` (a file under the job's `reference/` folder while the
 * Generate switch is on) keeps its bytes and its place in the file list, but a video or an audio
 * file in it is not counted and its length is not probed: it is not footage.
 */
function addFile(
  totals: Totals,
  name: string,
  absPath: string,
  size: number,
  mtimeMs: number,
  reference = false,
) {
  const kind = classifyFile(name);
  const footage = !(reference && isTimedKind(kind));
  if (kind !== 'other' && footage) totals.counts[kind] += 1;
  totals.sizeBytes += size;
  totals.newestMtimeMs = Math.max(totals.newestMtimeMs, mtimeMs);
  if (isTimedKind(kind) && footage) totals.timed.push({ absPath, signature: { mtimeMs, size } });
  totals.files?.push({ absPath, kind, size, mtimeMs });
}

/**
 * Size and newest mtime of a macOS package, taken as if it were one file. Symlinks and dotfiles
 * inside are left out. Returns undefined when the package vanished.
 */
async function measurePackage(
  dir: string,
  ctx: Context,
): Promise<{ size: number; mtimeMs: number } | undefined> {
  let own: Stats;
  try {
    own = await lstat(dir);
  } catch (error) {
    if (!isMissing(error)) ctx.onSkip(dir, error);
    return undefined;
  }

  let size = 0;
  let mtimeMs = own.mtimeMs;
  for (const entry of await readEntries(dir, ctx)) {
    if (isDotName(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await measurePackage(path, ctx);
      if (inner) {
        size += inner.size;
        mtimeMs = Math.max(mtimeMs, inner.mtimeMs);
      }
    } else if (entry.isFile()) {
      try {
        const info = await lstat(path);
        size += info.size;
        mtimeMs = Math.max(mtimeMs, info.mtimeMs);
      } catch (error) {
        if (!isMissing(error)) ctx.onSkip(path, error);
      }
    }
  }
  return { size, mtimeMs };
}

/**
 * Adds every counted file under `dir` to `totals`.
 *
 * Skipped: dotfiles and dot-folders, partial downloads, the `edit/` workspace at the job root,
 * the exports folder. A macOS package (`Brief.pages`) is one file and is not entered. Symlinked
 * folders are not followed, so a link back up the tree cannot loop. A symlinked file counts as
 * the file it points to; a broken link is ignored.
 */
async function walk(
  dir: string,
  depth: number,
  ctx: Context,
  totals: Totals,
  reference = false,
): Promise<void> {
  for (const entry of await readEntries(dir, ctx)) {
    const { name } = entry;
    if (isIgnoredName(name)) continue;
    const path = join(dir, name);
    if (isExcluded(ctx, path)) continue;

    try {
      if (entry.isSymbolicLink()) {
        const target = await stat(path);
        if (target.isFile()) addFile(totals, name, path, target.size, target.mtimeMs, reference);
      } else if (entry.isDirectory()) {
        if (depth === 0 && isReservedName(name, EDIT_DIR_NAME)) continue;
        if (isPackageName(name)) {
          const pkg = await measurePackage(path, ctx);
          if (pkg) addFile(totals, name, path, pkg.size, pkg.mtimeMs, reference);
        } else {
          const inReference =
            reference || (ctx.generate && depth === 0 && isReservedName(name, REFERENCE_DIR_NAME));
          await walk(path, depth + 1, ctx, totals, inReference);
        }
      } else if (entry.isFile()) {
        const info = await lstat(path);
        addFile(totals, name, path, info.size, info.mtimeMs, reference);
      }
    } catch (error) {
      // The file went away between listing and reading it, or cannot be read.
      if (!isMissing(error)) ctx.onSkip(path, error);
    }
  }
}

async function scanJobFolder(client: string, name: string, ctx: Context): Promise<ScannedJob> {
  const absPath = join(ctx.inbox, client, name);
  const totals: Totals = {
    counts: emptyInputCounts(),
    sizeBytes: 0,
    newestMtimeMs: 0,
    timed: [],
  };
  await walk(absPath, 0, ctx, totals);

  const seconds = await Promise.all(
    totals.timed.map(({ absPath: file, signature }) => ctx.durations.seconds(file, signature)),
  );
  const footage = seconds.reduce((sum, value) => sum + value, 0);

  const relPath = jobRelPath(client, name);
  return {
    id: jobIdFor(relPath),
    client,
    name,
    relPath,
    absPath,
    inputs: totals.counts,
    sizeBytes: totals.sizeBytes,
    // Whole milliseconds: float noise from adding many durations must not look like a change.
    footageSec: Math.round(footage * 1000) / 1000,
    newestMtimeMs: totals.newestMtimeMs,
  };
}

// --- public API -------------------------------------------------------------------------------

/**
 * The client folders of the inbox: real folders (no symlinks) that pass {@link isClientName}.
 * An inbox that does not exist has none; any other failure to read it throws.
 */
async function readClients(ctx: Context): Promise<Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(ctx.inbox, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries.filter(
    (entry) =>
      entry.isDirectory() && isClientName(entry.name, ctx) && isRegisteredClient(entry.name),
  );
}

/**
 * Makes `<client folder>/_Style` unless it is there. `mkdir` without `-p` on purpose: a client
 * folder that vanished meanwhile must not be brought back by this. An unreadable client folder is
 * reported to `onSkip` and left alone.
 */
async function makeStyleDir(clientAbs: string, ctx: Context): Promise<void> {
  const path = join(clientAbs, STYLE_DIR_NAME);
  try {
    await mkdir(path);
  } catch (error) {
    if (errorCode(error) === 'EEXIST' || isMissing(error)) return;
    ctx.onSkip(path, error);
  }
}

/**
 * Lists every job in the inbox, sorted by relPath (code point order, NFC).
 *
 * A job is any folder exactly at `<inbox>/<Client>/<Job>`. Skipped at those two levels: loose
 * files, dot-folders, symlinks, `_Exports` and `_Fonts` (level 1 only), the configured exports
 * folder and `_Style` (level 2 only: the client's style, see {@link ensureStyleDir}).
 * An inbox that does not exist has no jobs; any other failure to read it throws. Folders below it
 * that cannot be read are skipped and passed to `options.onSkip`.
 *
 * Unless `options.createStyleDirs` is false, this also makes `<Client>/_Style` in every client
 * folder it lists: the same folders the jobs are read from, so never in a folder the rules above
 * skip. Already there is fine.
 */
export async function scanInbox(
  inboxPath: string,
  options: ScanOptions = {},
): Promise<ScannedJob[]> {
  const ctx = createContext(inboxPath, options);

  const jobs: ScannedJob[] = [];
  for (const client of await readClients(ctx)) {
    const clientAbs = join(ctx.inbox, client.name);
    if (ctx.createStyleDirs) await makeStyleDir(clientAbs, ctx);
    for (const job of await readEntries(clientAbs, ctx)) {
      if (!job.isDirectory() || !isJobName(job.name, clientAbs, ctx)) continue;
      jobs.push(await scanJobFolder(client.name, job.name, ctx));
    }
  }

  return jobs.sort((a, b) => {
    const left = a.relPath.normalize('NFC');
    const right = b.relPath.normalize('NFC');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * The names of the client folders in the inbox, as the file system lists them, sorted (code point
 * order, NFC): the folders `scanInbox` reads jobs from, whether or not they hold any. Nothing is
 * created. An inbox that does not exist has none; any other failure to read it throws.
 */
export async function listClientNames(
  inboxPath: string,
  options: Pick<ScanOptions, 'exportsDir'> = {},
): Promise<string[]> {
  const clients = await readClients(createContext(inboxPath, options));
  return clients
    .map((client) => client.name)
    .sort((a, b) => {
      const left = a.normalize('NFC');
      const right = b.normalize('NFC');
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

/**
 * Whether `name` could be a client folder directly in the inbox, as far as its name goes: one
 * path segment that is not a dot-name, `_Exports`, `_Fonts`, `_Graphics`, `_LUTs` or the configured exports
 * folder.
 * Nothing is read; a folder of that name may or may not exist ({@link isClientFolder}).
 */
export function isClientFolderName(
  inboxPath: string,
  name: string,
  options: Pick<ScanOptions, 'exportsDir'> = {},
): boolean {
  return isSingleSegment(name) && isClientName(name, createContext(inboxPath, options));
}

/**
 * Whether `<inbox>/<client>` is a client folder right now: a real folder (not a file, not a
 * symlink) with a name the inbox rules let through ({@link isClientFolderName}). A folder that
 * cannot be read is reported to `options.onSkip` and is not one.
 */
export async function isClientFolder(
  inboxPath: string,
  client: string,
  options: Pick<ScanOptions, 'exportsDir' | 'onSkip'> = {},
): Promise<boolean> {
  if (!isSingleSegment(client)) return false;
  const ctx = createContext(inboxPath, options);
  if (!isClientName(client, ctx)) return false;

  const clientAbs = join(ctx.inbox, client);
  try {
    return (await lstat(clientAbs)).isDirectory();
  } catch (error) {
    if (!isMissing(error)) ctx.onSkip(clientAbs, error);
    return false;
  }
}

/**
 * Makes `<inbox>/<client>/_Style` (idempotent) for one client folder, for the watcher when it finds
 * a new one. Does nothing when `client` is not a real client folder: gone, a file or a symlink, a
 * dot-folder, `_Exports`, `_Fonts` or the configured exports folder. It never makes the client
 * folder itself. A folder that cannot be written is reported to `options.onSkip`.
 */
export async function ensureStyleDir(
  inboxPath: string,
  client: string,
  options: Pick<ScanOptions, 'exportsDir' | 'onSkip'> = {},
): Promise<void> {
  if (!(await isClientFolder(inboxPath, client, options))) return;
  await makeStyleDir(join(resolve(inboxPath), client), createContext(inboxPath, options));
}

/** One file of a job folder, as the scanner counts it (see {@link listJobFiles}). */
export interface JobFile {
  /** Path inside the job folder, with forward slashes, exactly as the file system spells it. */
  relPath: string;
  absPath: string;
  kind: FileKind;
  /** Bytes; a macOS package (`Brief.pages`) is one file, with the size of everything inside. */
  size: number;
  mtimeMs: number;
}

/**
 * Every file in one job folder that the scanner counts toward the job's size, sorted by `relPath`
 * (code point order): the same walk as `scanInbox`, so `edit/`, dotfiles, partial downloads and
 * the exports folder are left out, a macOS package is one file and symlinked folders are not
 * followed. Unknown file types (`other`) are included. Nothing is probed. A folder that does not
 * exist has no files.
 */
export async function listJobFiles(
  jobDir: string,
  options: Pick<ScanOptions, 'exportsDir' | 'onSkip'> = {},
): Promise<JobFile[]> {
  const ctx = createContext(jobDir, options);
  const totals: Totals = {
    counts: emptyInputCounts(),
    sizeBytes: 0,
    newestMtimeMs: 0,
    timed: [],
    files: [],
  };
  await walk(ctx.inbox, 0, ctx, totals);
  return (totals.files ?? [])
    .map((file) => ({ ...file, relPath: relative(ctx.inbox, file.absPath).split(sep).join('/') }))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/**
 * Scans one job folder again, for the watcher. Returns null when there is no such job any more:
 * the folder is gone, is not a real folder, or is one the inbox rules skip (`_Exports`, `_Style`,
 * dot-folders).
 */
export async function scanJob(
  inboxPath: string,
  client: string,
  name: string,
  options: ScanOptions = {},
): Promise<ScannedJob | null> {
  if (!isSingleSegment(client) || !isSingleSegment(name)) return null;
  const ctx = createContext(inboxPath, options);
  const clientAbs = join(ctx.inbox, client);

  try {
    const [clientInfo, jobInfo] = await Promise.all([
      lstat(clientAbs),
      lstat(join(clientAbs, name)),
    ]);
    if (!clientInfo.isDirectory() || !jobInfo.isDirectory()) return null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  if (!isClientName(client, ctx) || !isJobName(name, clientAbs, ctx)) return null;

  return scanJobFolder(client, name, ctx);
}
