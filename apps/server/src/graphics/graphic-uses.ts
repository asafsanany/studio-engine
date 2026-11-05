// "Used in" (Graphics plan, build 2). OWNER: GR9.
//
// After an edit or revise run succeeds, this finds the library graphics the edit mounted and
// records them in `graphic_uses`, so a graphic's page can say how many videos used it.
//
//   edit/preview/**/*.html and edit/animations/**/*.html
//     ─▶ the ids named as `compositions/lib-<id>.html` (a graphic the edit mounts)
//     ─▶ for each live graphic: the version of its copy in edit/graphics/<id>/
//     ─▶ graphic_uses (graphic, job, version, at) upserted ─▶ graphic.changed with `usedIn`
//
// The hook is a Runner that wraps the engine's (`withGraphicUses`): the run is over when the runner
// says it succeeded, whatever the worker does with the result after (a Review, an export that
// fails and is retried without a run). Nothing here can fail a run: every error is logged and the
// run's outcome goes through as it was.
//
// Which version? The Brief step copies a whole version folder to edit/graphics/<id>/ (GR8), and
// its about.json carries no version number. The copy is the thing the video was made from, so its
// files say which version it is: the version folder of the graphic whose composition and assets
// are byte for byte the copy's. A version never changes once made, so this stays true however
// long the edit takes and whatever happens to the graphic meanwhile. Only if no version folder
// matches (the graphic's folder was moved away, say) does the graphic's current version stand in.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { GraphicChangedEvent, Job } from '@studio/shared';
import type { GraphicRepository } from '../db/index.js';
import type { Runner } from '../pipeline/runner.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { graphicDir, graphicVersionDir } from './graphic-folders.js';

/** A graphic's mount in an edit's HTML: `compositions/lib-<id>.html` (12 hex characters). */
const MOUNT = /compositions\/lib-([0-9a-f]{12})\.html/g;
/** The graphic's own file, which is never a mount of itself. */
const OWN_FILE = /^lib-[0-9a-f]{12}\.html$/;

/** Where an edit keeps its compositions, inside `edit/`. */
const SCANNED_DIRS = ['preview', 'animations'] as const;

/** A project is a handful of files; this keeps a runaway folder from making the scan slow. */
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** The folder an edit keeps its copies of the library in (GR8), inside `edit/`. */
export const EDIT_GRAPHICS_DIR = 'graphics';

async function listDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

/** The `.html` files under `dir`, folders first-found first: no symlinks, no hidden or node_modules. */
async function htmlFilesUnder(dir: string, found: string[]): Promise<void> {
  for (const entry of await listDir(dir)) {
    if (found.length >= MAX_FILES) return;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await htmlFilesUnder(path, found);
    else if (entry.isFile() && entry.name.endsWith('.html') && !OWN_FILE.test(entry.name)) {
      found.push(path);
    }
  }
}

/**
 * The ids of the library graphics the edit mounts: every `compositions/lib-<id>.html` named in an
 * HTML file under `<editDir>/preview` or `<editDir>/animations`, each id once, sorted. A graphic's
 * own file (a copy of it in the project) names nothing, so a copy nobody mounts is not a use.
 */
export async function scanGraphicMounts(editDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of SCANNED_DIRS) await htmlFilesUnder(join(editDir, name), files);
  const ids = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) continue;
      // Latin-1 reads every byte as one character: the ids are ASCII and nothing is decoded.
      text = (await readFile(file)).toString('latin1');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const match of text.matchAll(MOUNT)) ids.add(match[1] as string);
  }
  return [...ids].sort();
}

/** Every file under `dir` (relative paths, `/`-separated, hidden ones left out); none for a folder that is not there. */
async function filesUnder(dir: string, base: string = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await listDir(dir)) {
    // Finder's .DS_Store and the like are not part of a graphic.
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path, base)));
    else if (entry.isFile()) found.push(relative(base, path).split(sep).join('/'));
  }
  return found;
}

/**
 * What makes a version of the graphic `id` that version: its composition and everything it loads
 * (`lib/<id>/`), as paths from the version's root. Empty when `root` has no such composition.
 */
async function definingFiles(root: string, id: string): Promise<string[]> {
  const composition = `compositions/lib-${id}.html`;
  const files = await filesUnder(join(root, 'lib', id));
  const own = files.map((file) => `lib/${id}/${file}`);
  try {
    if (!(await stat(join(root, composition))).isFile()) return [];
  } catch {
    return [];
  }
  return [composition, ...own.sort()];
}

/** Whether `candidate` has each of `files` with the same bytes as `copy`. */
async function sameFiles(
  copy: string,
  candidate: string,
  files: readonly string[],
  read: (path: string) => Promise<Buffer>,
): Promise<boolean> {
  for (const file of files) {
    const [mine, theirs] = [join(copy, file), join(candidate, file)];
    try {
      if ((await stat(mine)).size !== (await stat(theirs)).size) return false;
      if (!(await read(mine)).equals(await readFile(theirs))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The version numbers in the graphic's `versions/` folder, as asked: `first` (if there) leading, then newest first. */
async function versionNumbers(versionsDir: string, first: number | null): Promise<number[]> {
  const numbers = (await listDir(versionsDir))
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^v(\d+)$/.exec(entry.name)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
  return first !== null && numbers.includes(first)
    ? [first, ...numbers.filter((n) => n !== first)]
    : numbers;
}

/** How a copy's version was told. */
export interface CopyVersion {
  version: number;
  /** `false` when a version folder holds exactly these files; `true` when the graphic's current version stood in. */
  guessed: boolean;
}

/**
 * The version of the copy of graphic `id` in `copyDir` (`edit/graphics/<id>`): the version folder
 * of the graphic (`graphicFolder`) whose composition and assets are the copy's, the graphic's
 * current version first when two versions are the same (a version used again is a copy of an older
 * one). With no match the current version is the answer, marked `guessed`. `null` when `copyDir`
 * holds no copy of the graphic, or there is no version to name.
 */
export async function copyVersion(
  copyDir: string,
  graphicFolder: string,
  id: string,
  current: number | null,
): Promise<CopyVersion | null> {
  const files = await definingFiles(copyDir, id);
  if (files.length === 0) return null;
  const cache = new Map<string, Buffer>();
  const read = async (path: string): Promise<Buffer> => {
    const known = cache.get(path);
    if (known !== undefined) return known;
    const bytes = await readFile(path);
    cache.set(path, bytes);
    return bytes;
  };
  for (const version of await versionNumbers(join(graphicFolder, 'versions'), current)) {
    if (await sameFiles(copyDir, graphicVersionDir(graphicFolder, version), files, read)) {
      return { version, guessed: false };
    }
  }
  return current === null ? null : { version: current, guessed: true };
}

/** What `recordGraphicUses` needs from the engine. */
export interface GraphicUsesOptions {
  repo: Pick<GraphicRepository, 'get' | 'summary' | 'addUse' | 'usesCount'>;
  /** `Config.inboxPath`: a graphic's folder is `<inboxPath>/_Graphics/<folder>`. */
  inboxPath: string;
  /** The engine's bus: every graphic found is published as `graphic.changed`. */
  publish: (event: GraphicChangedEvent) => void;
  logger?: WorkerLogger;
}

/** A use that was recorded. */
export interface RecordedUse {
  graphicId: string;
  version: number;
  guessed: boolean;
}

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

/**
 * Records the library graphics the finished edit of `job` mounted (`jobDir` is the job's folder in
 * the inbox): one `graphic_uses` row for each live graphic, at the version of the edit's copy,
 * replacing the one an earlier run of the job left. Each one is then published as
 * `graphic.changed`, with how many videos have used it. Mounts of a graphic that is not in the
 * library (or was deleted), or that the edit has no copy of, record nothing. Returns the uses it
 * recorded. One graphic that cannot be recorded is logged and does not stop the others.
 */
export async function recordGraphicUses(
  options: GraphicUsesOptions,
  job: Pick<Job, 'id'>,
  jobDir: string,
): Promise<RecordedUse[]> {
  const { repo, inboxPath, publish, logger = SILENT } = options;
  const editDir = join(jobDir, 'edit');
  const recorded: RecordedUse[] = [];
  for (const id of await scanGraphicMounts(editDir)) {
    try {
      const graphic = repo.get(id);
      if (graphic === null) continue;
      const copy = join(editDir, EDIT_GRAPHICS_DIR, id);
      const told = await copyVersion(
        copy,
        graphicDir(inboxPath, graphic.folder),
        id,
        graphic.version,
      );
      if (told === null) {
        logger.warn(
          { jobId: job.id, graphicId: id },
          'a graphic is mounted but the edit has no copy of it',
        );
        continue;
      }
      if (told.guessed) {
        logger.warn(
          { jobId: job.id, graphicId: id, version: told.version },
          'no version of the graphic matches the edit’s copy: recorded its current version',
        );
      }
      repo.addUse(id, job.id, told.version);
      recorded.push({ graphicId: id, version: told.version, guessed: told.guessed });
      const summary = repo.summary(id);
      if (summary !== null) {
        publish({ type: 'graphic.changed', graphic: summary, usedIn: repo.usesCount(id) });
      }
    } catch (err) {
      logger.warn({ err, jobId: job.id, graphicId: id }, 'could not record a graphic use');
    }
  }
  return recorded;
}

/**
 * The runner with the "Used in" scan after it: when an edit or revise run succeeds, `record` is
 * called with the job (after the run, before the worker hears of its outcome). A render run edits
 * nothing, and a failed or stopped run is not a use. The outcome is the runner's own, whatever
 * `record` does; it is awaited, and a rejection is only logged.
 */
export function withGraphicUses(
  runner: Runner,
  record: (job: Job) => Promise<unknown>,
  logger: WorkerLogger = SILENT,
): Runner {
  return {
    async start(job, mode, context) {
      const outcome = await runner.start(job, mode, context);
      if (outcome.ok && (job.runKind === 'edit' || job.runKind === 'revise')) {
        try {
          await record(job);
        } catch (err) {
          logger.warn({ err, jobId: job.id }, 'could not record the graphics the edit used');
        }
      }
      return outcome;
    },
  };
}
