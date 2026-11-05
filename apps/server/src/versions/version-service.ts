// The preview versions of a job (Plane item VE0, shared contract: domain/versions.ts). Every run
// that ends in Review leaves a version of the live composition, so the owner can go back to an earlier
// cut.
//
//   capture(job, preview)  the worker calls it just before PREVIEW_READY is applied: copies
//                          edit/preview/ (without .hyperframes/ and .DS_Store) and, for a job with
//                          more than one format, edit/preview-<id>/ of every extra format, edit/music/
//                          music.json, edit/edl.json and edit/project.md to edit/versions/v<n>/,
//                          writes meta.json, updates edit/versions/index.json, then prunes
//   list(job)              the job's versions, newest first; a job from before versions has none
//   restore(job, n)        VE1: puts version n back as the live one (below)
//
// The store is files in the job folder, no database. A version is built in a temporary folder and
// renamed into place, and the index is written last and in one move, so a crash leaves either the
// old list or the new one, never a half version in the list.
//
// Copies are APFS clones where the volume has them (`COPYFILE_FICLONE`): an unchanged cut.mp4
// costs no extra bytes, and a clone is its own file, so ffmpeg rewriting the live one in place
// leaves the snapshot alone. Never hardlinks: `ffmpeg -y` truncates the same inode, which would
// corrupt every version sharing it. Where cloning is not possible the copy is a plain one.
//
// Formats (GN7, C63): a job with two or more formats has a composition per format, edit/preview/
// for the main one and edit/preview-<id>/ for each other. One version holds all of them and a
// restore puts all of them back together, so the formats never go out of step. A version made
// before this (only preview/) restores the main composition and leaves the others as they are. A
// job with one format has nothing but preview/, and everything below is as it was.
//
// Restore swaps each live folder for a clone of the version's in four steps, so a crash leaves a
// usable preview:
//
//   1. clone v<n>/<dir> to edit/.<dir>-restore.tmp, for every composition folder <dir>
//   2. rename each edit/<dir> to edit/.<dir>-replaced
//   3. rename each tmp folder to edit/<dir>
//   4. remove the edit/.<dir>-replaced folders
//
// A crash after 2 and before 3 leaves a missing edit/<dir>; the next restore or list puts every
// replaced folder back (`recoverPreview`: the old cut, in all formats), and a crash after 3 leaves
// leftovers that are removed then. Then the music record, the EDL and the project notes of the
// version are put back (the notes get a "## Restored to Cut n" section, so the next revise run is
// not confused), the index says which version is current, and the index.html of every restored
// composition is touched so the small MP4, the poster and the exported MP4, which are made newer
// than it, are made again. The job's round does not change, and the round files and the sent
// notes stay as history. The caller has checked that the job may go back (routes/versions.ts) and
// saves the new `job.preview`.
//
// Retention: the newest `VERSION_LIMITS.keep` versions stay, and the current one always does.
// Rendered MP4s, the phone's small MP4 and the poster are not part of a version.

import { constants } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  extraFormatsOf,
  extraPreviewDirName,
  type Job,
  type JobPreview,
  type JobVersion,
  VERSION_FILES,
  VERSION_LIMITS,
  VERSION_MESSAGES,
  type VersionIndex,
  type VersionMeta,
  versionDirName,
  versionIndexSchema,
  versionMetaSchema,
} from '@studio/shared';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import { PREVIEW_DIR_PATH } from '../pipeline/preview-files.js';
import { writeFileAtomic } from '../review/review-files.js';

/** The single files a version keeps next to the preview, relative to edit/. Missing ones are skipped. */
const STATE_FILES = ['music/music.json', 'edl.json', 'project.md'] as const;

/** The main format's composition folder, relative to edit/ and to a version's folder: "preview". */
const MAIN_DIR = basename(PREVIEW_DIR_PATH);

/**
 * The composition folders of a job, relative to edit/ and to a version's folder: the main format's
 * "preview", then "preview-<id>" of every extra format. A job with one format has only the first.
 */
function compositionDirsOf(job: Job): string[] {
  return [MAIN_DIR, ...extraFormatsOf(job.formats).map((format) => extraPreviewDirName(format.id))];
}

/** The folders a restore works in, relative to edit/, for a composition folder `dir`: the clone being made, and the folder it replaces. */
const restoreTmpOf = (dir: string): string => `.${dir}-restore.tmp`;
const replacedOf = (dir: string): string => `.${dir}-replaced`;

/** A leftover of a swap in edit/: ".preview-replaced", ".preview-1x1-restore.tmp". Group 1 is the folder, group 2 which leftover. */
const SWAP_LEFTOVER = /^\.(preview(?:-\d+x\d+)?)-(replaced|restore\.tmp)$/;

/** A restore the rules refuse. The route answers `status` with `{ error: message }`. */
export class VersionError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'VersionError';
  }
}

/** What the preview folder holds that a version leaves out: the render cache and Finder's litter. */
const LEFT_OUT = new Set(['.hyperframes', '.DS_Store']);

/**
 * Clones a file or a folder (`directory`) to `target`, leaving out the render cache and Finder's
 * litter ({@link LEFT_OUT}): an APFS clone where the volume has them, a plain copy where it has
 * not (an unsupported volume, or a clone refused midway). Never a hardlink. Rejects with ENOENT
 * when `source` is missing. The preview versions use it, and so do the quick fixes' copies of the
 * preview (review/fix-service.ts), which Undo puts back.
 */
export async function cloneTree(
  source: string,
  target: string,
  directory: boolean,
  logger: Pick<RunnerLogger, 'warn'> = SILENT_LOGGER,
): Promise<void> {
  const filter = (path: string): boolean => !LEFT_OUT.has(basename(path));
  try {
    await cp(source, target, {
      recursive: directory,
      filter,
      mode: constants.COPYFILE_FICLONE,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    logger.warn({ source, err }, 'could not clone, copying instead');
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: directory, filter });
  }
}

export interface VersionServiceOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  logger?: RunnerLogger;
  /** Versions kept per job. Defaults to `VERSION_LIMITS.keep`. */
  keep?: number;
  clock?: () => Date;
}

export interface VersionService {
  capture(job: Job, preview: JobPreview): Promise<JobVersion>;
  list(job: Job): Promise<JobVersion[]>;
  /**
   * Puts version `n` back as the live one and returns it (`current`). Throws `VersionError` 404
   * for a version the job does not have. Restoring the current version changes nothing. Restores
   * of one job wait for each other.
   */
  restore(job: Job, n: number): Promise<JobVersion>;
}

/**
 * The versions to remove: everything older than the newest `keep`, except `current`. `versions`
 * can be in any order.
 */
export function versionsToPrune(
  versions: readonly Pick<VersionMeta, 'n'>[],
  current: number | null,
  keep: number,
): number[] {
  return versions
    .map((version) => version.n)
    .sort((a, b) => b - a)
    .slice(keep)
    .filter((n) => n !== current);
}

export function createVersionService(options: VersionServiceOptions): VersionService {
  const {
    inboxPath,
    logger = SILENT_LOGGER,
    keep = VERSION_LIMITS.keep,
    clock = () => new Date(),
  } = options;

  const jobDirOf = (job: Job): string => join(inboxPath, job.relPath);
  const editDirOf = (job: Job): string => join(jobDirOf(job), 'edit');

  /** The index; a job from before versions (no file) has an empty one, and so does a file that cannot be read. */
  async function readIndex(job: Job): Promise<VersionIndex> {
    const file = join(editDirOf(job), VERSION_FILES.index);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ jobId: job.id, err }, 'could not read the versions index');
      }
      return { current: null, versions: [] };
    }
    try {
      return versionIndexSchema.parse(JSON.parse(text));
    } catch (err) {
      logger.warn({ jobId: job.id, err }, 'the versions index does not fit, starting a new one');
      return { current: null, versions: [] };
    }
  }

  const copyPath = (source: string, target: string, directory: boolean): Promise<void> =>
    cloneTree(source, target, directory, logger);

  async function capture(job: Job, preview: JobPreview): Promise<JobVersion> {
    const editDir = editDirOf(job);
    const versionsDir = join(editDir, VERSION_FILES.dir);
    const index = await readIndex(job);

    // Only goes up; a job that already had rounds before versions started at round + 1.
    const latest = index.versions.reduce((most, version) => Math.max(most, version.n), 0);
    const n = Math.max(latest + 1, job.round + 1);
    const meta: VersionMeta = versionMetaSchema.parse({
      n,
      round: job.round,
      createdAt: clock().toISOString(),
      preview: {
        durationSec: preview.durationSec,
        width: preview.width,
        height: preview.height,
      },
    });

    const finalDir = join(versionsDir, versionDirName(n));
    const buildDir = join(versionsDir, `.${versionDirName(n)}.tmp`);
    await mkdir(versionsDir, { recursive: true });
    await rm(buildDir, { recursive: true, force: true });
    try {
      await mkdir(buildDir);
      // Every format's composition, or none: a missing one fails the capture like a missing main one.
      for (const dir of compositionDirsOf(job)) {
        await copyPath(join(editDir, dir), join(buildDir, dir), true);
      }
      for (const file of STATE_FILES) {
        try {
          await copyPath(join(editDir, file), join(buildDir, basename(file)), false);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      await writeFile(join(buildDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
      // A folder of this number the index does not list is left over from an interrupted capture.
      await rm(finalDir, { recursive: true, force: true });
      await rename(buildDir, finalDir);
    } catch (err) {
      await rm(buildDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const versions = [meta, ...index.versions];
    const removed = versionsToPrune(versions, n, keep);
    const next: VersionIndex = {
      current: n,
      versions: versions.filter((version) => !removed.includes(version.n)),
    };
    await writeFileAtomic(join(editDir, VERSION_FILES.index), `${JSON.stringify(next, null, 2)}\n`);
    // After the index no longer lists them; a failure leaves a folder nothing refers to.
    for (const gone of removed) {
      await rm(join(versionsDir, versionDirName(gone)), { recursive: true, force: true }).catch(
        (err) => logger.warn({ jobId: job.id, n: gone, err }, 'could not remove an old version'),
      );
    }
    logger.info({ jobId: job.id, n, removed }, 'kept a version of the preview');
    return toJobVersion(meta, n);
  }

  /** Jobs whose restore is under way: the next one for the job waits its turn. */
  const restoring = new Map<string, Promise<unknown>>();

  function exclusive<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const result = (restoring.get(jobId) ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => {},
      () => {},
    );
    restoring.set(jobId, tail);
    void tail.then(() => {
      if (restoring.get(jobId) === tail) restoring.delete(jobId);
    });
    return result;
  }

  async function exists(path: string): Promise<boolean> {
    return access(path).then(
      () => true,
      () => false,
    );
  }

  /**
   * Puts back every folder of `dirs` that a swap set aside (`.<dir>-replaced`), dropping what was
   * swapped in for it, and removes the swap's clones. A folder the swap never reached is left as
   * it is.
   */
  async function rollBack(editDir: string, dirs: readonly string[]): Promise<void> {
    for (const dir of dirs) {
      const replaced = join(editDir, replacedOf(dir));
      if (await exists(replaced)) {
        await rm(join(editDir, dir), { recursive: true, force: true });
        await rename(replaced, join(editDir, dir));
      }
      await rm(join(editDir, restoreTmpOf(dir)), { recursive: true, force: true });
    }
  }

  /**
   * Finishes or undoes a restore that was interrupted. When any composition folder is missing while
   * its replaced one is there, the restore died between the renames: every format goes back to the
   * replaced folders (the old cut, all of it, never a mix). Otherwise the swap was complete and
   * only leftovers remain. Either way the leftovers are removed. Only for a job whose restore is
   * not running.
   */
  async function recoverPreview(job: Job): Promise<void> {
    const editDir = editDirOf(job);
    let names: string[];
    try {
      names = await readdir(editDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const leftovers = names.flatMap((name) => {
      const match = SWAP_LEFTOVER.exec(name);
      return match?.[1] === undefined
        ? []
        : [{ name, dir: match[1], replaced: match[2] === 'replaced' }];
    });
    const replacedDirs = leftovers.filter((one) => one.replaced).map((one) => one.dir);
    let interrupted = false;
    for (const dir of replacedDirs) {
      if (!(await exists(join(editDir, dir)))) interrupted = true;
    }
    if (interrupted) {
      logger.warn({ jobId: job.id }, 'a restore was interrupted, putting the preview back');
      await rollBack(editDir, replacedDirs);
    }
    for (const { name } of leftovers) {
      await rm(join(editDir, name), { recursive: true, force: true });
    }
  }

  async function restoreNow(job: Job, n: number): Promise<JobVersion> {
    const editDir = editDirOf(job);
    await recoverPreview(job);
    const index = await readIndex(job);
    const meta = index.versions.find((version) => version.n === n);
    const source = join(editDir, VERSION_FILES.dir, versionDirName(n));
    if (meta === undefined || !(await exists(join(source, MAIN_DIR)))) {
      throw new VersionError(404, VERSION_MESSAGES.notFound);
    }
    if (index.current === n) return toJobVersion(meta, n);

    // The compositions to put back: the job's formats that this version kept. A version from before
    // formats kept only the main one, and the other formats stay as they are.
    const dirs: string[] = [];
    for (const dir of compositionDirsOf(job)) {
      if (await exists(join(source, dir))) dirs.push(dir);
      else if (dir !== MAIN_DIR) {
        logger.warn(
          { jobId: job.id, n, dir },
          'the version has no such format, leaving it as it is',
        );
      }
    }

    // 1-4. The swap, all formats together. Until the first rename in 2 nothing has changed.
    try {
      for (const dir of dirs) {
        await copyPath(join(source, dir), join(editDir, restoreTmpOf(dir)), true);
      }
      for (const dir of dirs) {
        if (await exists(join(editDir, dir))) {
          await rename(join(editDir, dir), join(editDir, replacedOf(dir)));
        }
      }
      for (const dir of dirs) {
        await rename(join(editDir, restoreTmpOf(dir)), join(editDir, dir));
      }
    } catch (err) {
      await rollBack(editDir, dirs).catch((undoErr) =>
        logger.error({ jobId: job.id, err: undoErr }, 'could not put the preview back'),
      );
      throw err;
    }
    for (const dir of dirs) {
      await rm(join(editDir, replacedOf(dir)), { recursive: true, force: true }).catch((err) =>
        logger.warn({ jobId: job.id, err }, 'could not remove the replaced preview'),
      );
    }

    // 5. The state around the preview. One a version does not have (it had none then) stays as it is.
    for (const file of STATE_FILES.filter((name) => name !== 'project.md')) {
      const from = join(source, basename(file));
      if (!(await exists(from))) continue;
      const target = join(editDir, file);
      const temporary = `${target}.restore.tmp`;
      await mkdir(dirname(target), { recursive: true });
      await copyPath(from, temporary, false);
      await rename(temporary, target);
    }
    await writeProjectNotes(editDir, source, n);

    // 6.
    await writeFileAtomic(
      join(editDir, VERSION_FILES.index),
      `${JSON.stringify({ ...index, current: n } satisfies VersionIndex, null, 2)}\n`,
    );

    // 7. Newer than the files the small MP4, the poster and the exported MP4 are checked against.
    const now = clock();
    for (const dir of dirs) {
      const touched = utimes(join(editDir, dir, 'index.html'), now, now);
      if (dir === MAIN_DIR) await touched;
      else
        await touched.catch((err) =>
          logger.warn({ jobId: job.id, n, dir, err }, 'could not touch the composition'),
        );
    }
    logger.info({ jobId: job.id, n }, 'restored a version of the preview');
    return toJobVersion(meta, n);
  }

  /** The version's project.md (else the live one) with a section that says the job went back. */
  async function writeProjectNotes(editDir: string, source: string, n: number): Promise<void> {
    let text = '';
    for (const path of [join(source, 'project.md'), join(editDir, 'project.md')]) {
      try {
        text = await readFile(path, 'utf8');
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    const note = `## Restored to Cut ${n}\n\nThe edit was put back to Cut ${n}. Cuts made after it are not part of the live edit; continue from this one.\n`;
    await writeFileAtomic(
      join(editDir, 'project.md'),
      text === '' ? note : `${text.replace(/\s*$/, '')}\n\n${note}`,
    );
  }

  async function list(job: Job): Promise<JobVersion[]> {
    // A restore that is running has its own half-way state, which is not a crash.
    if (!restoring.has(job.id)) {
      await recoverPreview(job).catch((err) =>
        logger.warn({ jobId: job.id, err }, 'could not recover an interrupted restore'),
      );
    }
    const index = await readIndex(job);
    return [...index.versions]
      .sort((a, b) => b.n - a.n)
      .map((meta) => toJobVersion(meta, index.current));
  }

  return {
    capture,
    list,
    restore: (job, n) => exclusive(job.id, () => restoreNow(job, n)),
  };
}

function toJobVersion(meta: VersionMeta, current: number | null): JobVersion {
  return {
    n: meta.n,
    round: meta.round,
    createdAt: meta.createdAt,
    durationSec: meta.preview.durationSec,
    width: meta.preview.width,
    height: meta.preview.height,
    current: meta.n === current,
  };
}
