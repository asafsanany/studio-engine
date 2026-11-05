// Moving things to the Trash, for every library that deletes (Graphics, Fonts). The way Finder
// does it: into `~/.Trash` under the thing's own name, numbered when the Trash already has one
// ("Alpha", "Alpha 2", "Alpha 3"; a file is "logo.png", "logo (1).png"). When macOS will not take
// it (the engine has no permission for the Trash, another volume), it is moved into a folder of the
// library's own in the data folder instead, and the answer says so. When neither can take it, the
// call throws and nothing has moved.
//
// This file also holds the small move helpers (a rename that survives another volume, the first
// free name in a folder) that the libraries share.

import { constants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, rename, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { errorText } from './pipeline/claude-process.js';

/** The `code` of a Node file system error, if it is one. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Whether something is at `path` (a link counts, whether or not it points anywhere). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Whether `target` is a place a file can be moved to from `source`: `missing` (nothing there, or it
 * is `source` itself under another spelling of its case, which is how macOS renames a folder to the
 * same name in other letters) or `taken` (another file or folder is there).
 */
export async function sameOrMissing(source: string, target: string): Promise<'missing' | 'taken'> {
  let there: Awaited<ReturnType<typeof lstat>>;
  try {
    there = await lstat(target);
  } catch {
    return 'missing';
  }
  try {
    const here = await lstat(source);
    return here.ino === there.ino && here.dev === there.dev ? 'missing' : 'taken';
  } catch {
    return 'taken';
  }
}

/** "name", else "name 2", "name 3", … : the first that `dir` does not have (Finder's way in the Trash). */
export async function freeNameIn(dir: string, name: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    if (!(await pathExists(join(dir, candidate)))) return candidate;
  }
}

/** "logo.png", else "logo (1).png", "logo (2).png", … : the first that `dir` does not have. */
export async function freeFileNameIn(dir: string, name: string): Promise<string> {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let n = 0; ; n += 1) {
    const candidate = n === 0 ? name : `${stem} (${n})${extension}`;
    if (!(await pathExists(join(dir, candidate)))) return candidate;
  }
}

/** Moves a file: a rename, or a copy and a remove when `to` is on another volume. */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Moves a folder: a rename, or a clone-copy and a remove when `to` is on another volume. */
export async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE });
    await rm(from, { recursive: true, force: true });
  }
}

/** Where something that was deleted went. */
export interface TrashedPath {
  /** Where it is now: in `~/.Trash`, or in the library's own folder in the data folder. */
  where: string;
  /** False when macOS would not take it to the Trash and it was kept in the library's own folder. */
  trashed: boolean;
  /** Why the Trash would not take it (only when `trashed` is false). */
  reason?: string;
}

export interface TrashOptions {
  /** The home folder, for `~/.Trash`. Default: the user's. Tests pass a temp folder. */
  home?: string;
  /**
   * Where things go when the Trash will not take them (`<data>/deleted-graphics`, …). Left out or
   * `null`: nowhere, and a refusal of the Trash is thrown.
   */
  asideDir?: string | null;
  /** The name it gets there (numbered the same way when taken). Default: its own. */
  name?: string;
}

/**
 * A name that is one name in a folder: no slash, no colon (Finder shows it as a slash), no control
 * characters, never starting with a dot. Empty becomes `fallback`.
 */
export function safeTrashName(name: string, fallback = 'Deleted'): string {
  const cleaned = Array.from(name)
    .map((char) => (char === '/' || char === '\\' || char === ':' || char < ' ' ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

/**
 * Moves a file or a folder into `~/.Trash/<its name>` ("<name> 2" when the Trash has one by that
 * name). When macOS will not take it, it goes to `<asideDir>/<name>` instead and `trashed` is
 * false. Throws when neither works.
 */
export async function trashPath(from: string, options: TrashOptions = {}): Promise<TrashedPath> {
  const home = options.home ?? homedir();
  const name = options.name ?? basename(from);
  const directory = (await lstat(from)).isDirectory();
  const freeName = directory ? freeNameIn : freeFileNameIn;
  const trashDir = join(home, '.Trash');
  let reason: string;
  try {
    await mkdir(trashDir, { recursive: true, mode: 0o700 });
    const to = join(trashDir, await freeName(trashDir, name));
    await rename(from, to);
    return { where: to, trashed: true };
  } catch (error) {
    reason = errorText(error);
  }
  if (options.asideDir === undefined || options.asideDir === null) throw new Error(reason);
  await mkdir(options.asideDir, { recursive: true });
  const to = join(options.asideDir, await freeName(options.asideDir, name));
  await (directory ? moveDir : moveFile)(from, to);
  return { where: to, trashed: false, reason };
}

/**
 * Moves several files into ONE new folder, `~/.Trash/<folderName>` ("<folderName> 2" when the Trash
 * has one by that name), each under its own name ("name (1).ext" when two share one). A file that
 * is not there any more is passed over. When macOS will not take them, they go to
 * `<asideDir>/<folderName>` instead and `trashed` is false. Either all the files that are there
 * move or none does: a failure part-way puts back what was moved before trying the other place,
 * and throws when neither works.
 */
export async function trashFiles(
  files: readonly string[],
  folderName: string,
  options: TrashOptions = {},
): Promise<TrashedPath> {
  const home = options.home ?? homedir();
  const name = safeTrashName(folderName);

  /** Fills a new folder of `parent` with the files; undoes itself when one cannot be moved. */
  const fill = async (
    parent: string,
    move: (from: string, to: string) => Promise<void>,
    mode?: number,
  ): Promise<string> => {
    await mkdir(parent, { recursive: true, ...(mode === undefined ? {} : { mode }) });
    const folder = join(parent, await freeNameIn(parent, name));
    await mkdir(folder);
    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const from of files) {
        const to = join(folder, await freeFileNameIn(folder, basename(from)));
        try {
          await move(from, to);
        } catch (error) {
          if (errorCode(error) === 'ENOENT' && !(await pathExists(from))) continue;
          throw error;
        }
        moved.push({ from, to });
      }
    } catch (error) {
      for (const { from, to } of moved.reverse()) await moveFile(to, from).catch(() => undefined);
      await rmdir(folder).catch(() => undefined);
      throw error;
    }
    return folder;
  };

  const trashDir = join(home, '.Trash');
  let reason: string;
  try {
    return { where: await fill(trashDir, rename, 0o700), trashed: true };
  } catch (error) {
    reason = errorText(error);
  }
  if (options.asideDir === undefined || options.asideDir === null) throw new Error(reason);
  return { where: await fill(options.asideDir, moveFile), trashed: false, reason };
}
