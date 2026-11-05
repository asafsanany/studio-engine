// The two things the Fonts page does to a family's files on disk (Fonts plan, "Delete" and "API";
// FN5): Show in Finder, and Delete (the whole family to the Trash). `createFontService` spreads
// these two methods in; the rest of the service never touches a family's files.
//
// A family is found through the font index only, by its slug: a client never sends a path. What
// is touched is exactly what the index says the family is made of:
//
//   Show in Finder   `open -R` on the family's folder (the folder inside `_Fonts` that holds most
//                    of its files). A family whose files lie directly in `_Fonts` has no folder of
//                    its own, so Finder selects its first file instead.
//   Delete           every file of the family goes into ONE new folder in the Trash, named after
//                    the family (`~/.Trash/Heebo`); the answer's `where` is that folder. Then the
//                    family's folder is removed if it ended up empty (a `.DS_Store` Finder left in
//                    it does not count), and so are the empty folders of the family's own inside it.
//                    Never `_Fonts` itself, never one of the two parent folders ("Hebrew + English",
//                    "English only"), never a folder above the family's, never anything that still
//                    holds a file that is not the family's. The jobs' `edit/fonts/` copies are not
//                    touched. The index is refreshed after the move; that tells the browsers
//                    (`font.removed`, from the service's own listener) so nothing is announced twice.
//
// When macOS will not take the files to the Trash (the engine has no permission), they are kept in
// `<data>/deleted-fonts/<Family>/` and the answer says so in the log; with no data folder the call
// fails with 500 and nothing has moved.

import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  type DeleteFontResponse,
  FONT_MESSAGES,
  FONT_SCRIPT_LABELS,
  fontNameKey,
} from '@studio/shared';
import type { WorkerLogger } from '../pipeline/worker.js';
import type { FolderOpener } from '../routes/clients.js';
import { revealInFinder } from '../routes/job-sheet.js';
import { trashFiles } from '../trash-path.js';
import type { FontIndex } from './font-index.js';
import type { FontOutcome, FontRefusal, FontService } from './font-service.js';

export interface FamilyFilesOptions {
  /** The font index: the only place a slug is turned into files. */
  index: Pick<FontIndex, 'ready' | 'refresh' | 'family'>;
  /** The shared fonts folder, `<inbox>/_Fonts`. */
  dir: string;
  /** Shows a path in Finder with it selected. Default: macOS `open -R`. Tests pass a fake. */
  openFolder?: FolderOpener | undefined;
  /** The home folder, for `~/.Trash`. Default: the user's. Tests pass a temp folder. */
  home?: string | undefined;
  /** The data folder, for `<data>/deleted-fonts/` when the Trash will not take the files. */
  dataDir?: string | undefined;
  logger: WorkerLogger;
}

const refuse = (status: FontRefusal['status'], error: string): FontRefusal => ({
  ok: false,
  status,
  error,
});

/** The two folders an import files families into: they hold families, they are never one. */
const PARENT_FOLDER_KEYS: ReadonlySet<string> = new Set(
  Object.values(FONT_SCRIPT_LABELS).map(fontNameKey),
);

/**
 * Whether a folder inside `_Fonts` (its path with '/' between folders; '' is `_Fonts` itself) may
 * be removed when it is empty: not `_Fonts`, not one of the two parent folders at its top. (macOS
 * folders ignore case, so "english only" is the same folder.)
 */
export function isRemovableFontFolder(folder: string): boolean {
  if (folder === '') return false;
  return folder.includes('/') || !PARENT_FOLDER_KEYS.has(fontNameKey(folder));
}

/** The absolute path of a path inside `_Fonts`, or null when it would lead outside it. */
function insideFonts(dir: string, rel: string): string | null {
  const absolute = join(dir, ...rel.split('/'));
  const from = relative(dir, absolute);
  return from === '' || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)
    ? null
    : absolute;
}

/** The folder a path inside `_Fonts` is in ('' for a file directly in `_Fonts`). */
function parentOf(rel: string): string {
  const cut = rel.lastIndexOf('/');
  return cut < 0 ? '' : rel.slice(0, cut);
}

/**
 * Removes the folder if nothing is in it but Finder's `.DS_Store`. Answers whether it is gone.
 * Never recursive: a folder with anything else in it stays.
 */
async function removeIfEmpty(path: string): Promise<boolean> {
  const names = await readdir(path);
  if (names.some((name) => name !== '.DS_Store')) return false;
  if (names.length > 0) await rm(join(path, '.DS_Store'), { force: true });
  await rmdir(path);
  return true;
}

export function createFamilyFiles(
  options: FamilyFilesOptions,
): Pick<FontService, 'reveal' | 'remove'> {
  const { index, dir, logger } = options;
  const openFolder = options.openFolder ?? revealInFinder;
  const home = options.home ?? homedir();
  const asideDir = options.dataDir === undefined ? null : join(options.dataDir, 'deleted-fonts');

  /** Deletes run one at a time, so two of the same family cannot move the same files. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job);
    queue = next.catch(() => undefined);
    return next;
  };

  /** The folders of the family's own that may be empty now: where its files were, up to its folder. */
  async function prune(folder: string, files: readonly string[], slug: string): Promise<void> {
    // A family whose files lie in `_Fonts` itself has no folder to remove.
    if (folder === '') return;
    const candidates = new Set<string>();
    for (const file of files) {
      let at = parentOf(file);
      while (at === folder || at.startsWith(`${folder}/`)) {
        candidates.add(at);
        if (at === folder) break;
        at = parentOf(at);
      }
    }
    const deepestFirst = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const rel of deepestFirst) {
      if (!isRemovableFontFolder(rel)) continue;
      const path = insideFonts(dir, rel);
      if (path === null) continue;
      try {
        if ((await lstat(path)).isDirectory()) await removeIfEmpty(path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Gone already, or something still in it: both are fine, the folder is just not ours to clear.
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
          logger.warn({ err, slug, folder: rel }, 'fonts: could not remove a folder left empty');
        }
      }
    }
  }

  return {
    async reveal(slug) {
      await index.ready();
      const family = index.family(slug);
      if (family === undefined) return refuse(404, FONT_MESSAGES.notFound);
      const rel = family.folder !== '' ? family.folder : (family.paths[0] ?? '');
      const target = rel === '' ? null : insideFonts(dir, rel);
      let there = false;
      if (target !== null) {
        try {
          await lstat(target);
          there = true;
        } catch {
          there = false;
        }
      }
      if (target === null || !there) {
        // The index is behind the disk; let the page catch up.
        await index.refresh();
        return refuse(404, FONT_MESSAGES.fileMissing);
      }
      try {
        await openFolder(target);
      } catch (err) {
        logger.error({ err, slug }, 'fonts: could not show the family in Finder');
        return refuse(500, FONT_MESSAGES.revealFailed);
      }
      return { ok: true, status: 200, body: { ok: true } };
    },

    remove(slug) {
      return serial(async (): Promise<FontOutcome<DeleteFontResponse>> => {
        await index.ready();
        // Look at the folder as it is now: a file dropped a moment ago goes with its family.
        await index.refresh();
        const family = index.family(slug);
        if (family === undefined) return refuse(404, FONT_MESSAGES.notFound);

        const present: string[] = [];
        for (const rel of family.paths) {
          const path = insideFonts(dir, rel);
          if (path === null) {
            logger.error({ slug, file: rel }, 'fonts: a path of the family leads outside _Fonts');
            continue;
          }
          try {
            if (!(await lstat(path)).isDirectory()) present.push(path);
          } catch {
            // Gone already: nothing to move.
          }
        }

        let where = insideFonts(dir, family.folder) ?? dir;
        if (present.length > 0) {
          try {
            const trashed = await trashFiles(present, family.name, { home, asideDir });
            where = trashed.where;
            if (!trashed.trashed) {
              logger.warn(
                { slug, where, reason: trashed.reason },
                'fonts: the Trash would not take the files; they are kept in the data folder',
              );
            }
          } catch (err) {
            logger.error({ err, slug }, 'fonts: the family could not be moved to the Trash');
            return refuse(500, FONT_MESSAGES.deleteFailed);
          }
        } else {
          logger.warn({ slug }, 'fonts: deleted, but its files were already gone');
        }

        await prune(family.folder, family.paths, slug);
        // The family is gone from the index now, and that goes out as `font.removed`.
        await index.refresh();
        return { ok: true, status: 200, body: { ok: true, where } };
      });
    },
  };
}
