// The shared fonts (CVP-201): `<inbox>/_Fonts`, fonts every client's jobs can use. Before every
// edit run (start, resume and retry) the Brief step copies the font files in it into the job's
// edit/fonts/, fresh each time, so a font added before a Retry is there; brief.md lists them.
//
// A font file is a .ttf, .otf, .woff or .woff2 anywhere in the folder, in folders or not. Dot names
// and partial downloads are left out wherever they are, and so is every other file.

import { constants, type Dirent } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { FONTS_DIR_NAME, isIgnoredName } from '../inbox/classify.js';

/** The job's copy of the shared fonts, relative to the job folder. */
export const FONTS_COPY_PATH = 'edit/fonts';

/** The extensions of a font file, lower case. */
const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['.ttf', '.otf', '.woff', '.woff2']);

/** The shared fonts folder, `<inbox>/_Fonts`. */
export function fontsDirFor(inboxPath: string): string {
  return join(inboxPath, FONTS_DIR_NAME);
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The font files in `dir` and the folders below it, as paths inside it ('/' between folders),
 * sorted (code point order). A folder that isn't there has none. A link to a file counts (what is
 * copied is the file it points to); links to folders are not followed.
 */
export async function listFonts(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .filter((entry) => FONT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep))
    .filter((segments) => !segments.some((segment) => isIgnoredName(segment)))
    .map((segments) => segments.join('/'))
    .sort(byCodePoint);
}

/**
 * Makes `target` a copy of the shared font files, at the same paths, in place of what was there.
 * With no fonts there is no `target`. The copy is made next to its place (in a dot-folder named
 * after it, `.fonts-copying` for `…/fonts`) and renamed, so one cut short never passes for the
 * fonts and the old copy stays when the new one fails. `COPYFILE_FICLONE` makes an APFS clone
 * where the volume can and a plain copy where it can't. Answers the fonts copied.
 *
 * A job's edit/fonts/ ({@link copySharedFonts}) and a graphic's fonts/ (the Graphics library, which
 * copies them before each of its runs) are made this way.
 */
export async function copyFontsTo(inboxPath: string, target: string): Promise<string[]> {
  const source = fontsDirFor(inboxPath);
  const fonts = await listFonts(source);
  const staging = join(dirname(target), `.${basename(target)}-copying`);

  await rm(staging, { recursive: true, force: true });
  try {
    for (const font of fonts) {
      const to = join(staging, font);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(join(source, font), to, constants.COPYFILE_FICLONE);
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await rm(target, { recursive: true, force: true });
  if (fonts.length > 0) await rename(staging, target);
  return fonts;
}

/**
 * Makes the job's edit/fonts/ a copy of the shared font files ({@link copyFontsTo}). Answers the
 * fonts copied.
 */
export async function copySharedFonts(inboxPath: string, jobDir: string): Promise<string[]> {
  return copyFontsTo(inboxPath, join(jobDir, FONTS_COPY_PATH));
}
