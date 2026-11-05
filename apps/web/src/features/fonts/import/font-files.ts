// Getting the files of a pick or a drop, for the Import fonts dialog. A folder, picked or dropped,
// is flattened to the font files inside it (and everything below it); files chosen one by one are
// all kept, so the engine can say why a .txt is not a font. A file that came out of a folder keeps
// its path inside that folder as its name (`Fonts/Heebo/Heebo-Bold.ttf`), as a picked folder's
// files do (`webkitRelativePath`), so two `Regular.ttf` of two families do not meet. Plain
// functions over the shape of the browser's objects, so tests call them with stand-ins.

import type { TransferLike } from '@/features/style/drop-target';

/** What the files input offers first. The engine still says why any other file is not a font. */
export const FONT_PICK_ACCEPT = '.ttf,.otf,.woff,.woff2';

/**
 * The names a folder's files are cut down to: the four formats, and a .ttc / .otc collection, which
 * is a font file too, so the engine can say it holds several fonts and how to import them.
 */
const FONT_NAME = /\.(ttf|otf|woff2?|ttc|otc)$/i;

/** Whether a file name is a font file's (.ttf, .otf, .woff, .woff2 or a collection, in any case). */
export function isFontFileName(name: string): boolean {
  return FONT_NAME.test(name);
}

/** The font files among a folder's `files`: a .DS_Store, a licence .txt or a `._` copy beside them is not an error. */
export function fontFilesOf(files: readonly File[]): File[] {
  return files.filter((file) => isFontFileName(file.name) && !file.name.startsWith('.'));
}

/** The part of `FileSystemEntry` that is read here. */
export interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: EntryLike[]) => void,
      failure?: (error: unknown) => void,
    ) => void;
  };
}

/** What was read from a drop: the files, and whether any of what was dropped was a folder. */
export interface DroppedFiles {
  files: File[];
  sawFolder: boolean;
}

function readFile(entry: EntryLike): Promise<File | undefined> {
  const read = entry.file;
  if (read === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    read.call(
      entry,
      (file) => resolve(file),
      () => resolve(undefined),
    );
  });
}

/** The same bytes under another name: a file of a dropped folder, named by its path inside it. */
function namedByPath(file: File, path: string): File {
  return new File([file], path, { type: file.type, lastModified: file.lastModified });
}

/**
 * A directory's reader gives its entries in batches; keep asking until it answers with none.
 * `prefix` is the path of the directory, ending in a slash.
 */
async function readDirectory(entry: EntryLike, prefix: string): Promise<File[]> {
  const reader = entry.createReader?.();
  if (reader === undefined) return [];
  const found: File[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) return found;
    for (const child of batch) found.push(...(await readEntry(child, prefix)));
  }
}

/** `prefix` is the path of the folder `entry` is in, or `null` for something dropped on its own. */
async function readEntry(entry: EntryLike, prefix: string | null): Promise<File[]> {
  if (entry.isDirectory) return readDirectory(entry, `${prefix ?? ''}${entry.name}/`);
  if (!entry.isFile) return [];
  const file = await readFile(entry);
  if (file === undefined) return [];
  if (prefix === null) return [file];
  return fontFilesOf([file]).map((one) => namedByPath(one, `${prefix}${one.name}`));
}

/**
 * The files of a drop, folders opened. The entries are taken from the items at once, because the
 * browser forgets them when the event handler returns; reading them takes a moment longer. Without
 * `webkitGetAsEntry` the plain file list is the answer.
 */
export async function readDroppedFiles(transfer: TransferLike): Promise<DroppedFiles> {
  const items = transfer.items === undefined ? [] : Array.from(transfer.items);
  const entries = items.map((item) => {
    const get = (item as { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry;
    return get === undefined ? null : (get.call(item) ?? null);
  });
  if (entries.length === 0 || entries.some((entry) => entry === null)) {
    return { files: Array.from(transfer.files), sawFolder: false };
  }
  const found = await Promise.all(
    (entries as EntryLike[]).map(async (entry) => ({
      folder: entry.isDirectory,
      files: await readEntry(entry, null),
    })),
  );
  return {
    files: found.flatMap((one) => one.files),
    sawFolder: found.some((one) => one.folder),
  };
}
