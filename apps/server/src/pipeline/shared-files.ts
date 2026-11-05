// A client's shared files: `<inbox>/<Client>/_Shared`, footage, logos, b-roll and music that every
// job of the client can use, so the owner drops them in once instead of into each job. Before every edit
// run (start, resume and retry) the Brief step lists them in brief.md, so a file added before a
// Retry is there. Nothing is copied ahead: the edit run reads `_Shared` (its Read rules leave the
// client's own `_Shared` open, readDenyRulesOutsideJob) and copies only the files it uses into the
// job's edit/shared/, as APFS clones (`cp -c`), and uses them from there. So each job keeps what
// its cut is made of, even after the file leaves `_Shared`, and `_Shared` stays safe from a run
// that changes a file in place.
//
// A shared file is any file in the folder, in folders or not. Dot names and partial downloads are
// left out wherever they are, and so are macOS packages (a Keynote deck is no use to an edit).

import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isIgnoredName, isPackageName } from '../inbox/classify.js';

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The files in `dir` and the folders below it, as paths inside it ('/' between folders), sorted
 * (code point order). A folder that isn't there has none. A link to a file counts (what is copied
 * is the file it points to); links to folders are not followed.
 */
export async function listSharedFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const segments = relative(dir, join(entry.parentPath, entry.name)).split(sep);
    if (segments.some((segment) => isIgnoredName(segment))) continue;
    if (segments.slice(0, -1).some((segment) => isPackageName(segment))) continue;
    if (!entry.isFile() && !(entry.isSymbolicLink() && (await isFile(join(dir, ...segments))))) {
      continue;
    }
    files.push(segments.join('/'));
  }
  return files.sort(byCodePoint);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
