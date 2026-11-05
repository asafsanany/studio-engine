// Getting the files of a pick or a drop, for the Import LUTs dialog. A folder, picked or dropped,
// is flattened to the .cube and .3dl files inside it (and everything below it); files chosen one by
// one are all kept, so the engine can say why a .txt is not a LUT. Plain functions over the shape
// of the browser's objects, so tests call them with stand-ins.

import type { TransferLike } from '@/features/style/drop-target';

/** The extensions the engine imports. */
const LUT_NAME = /\.(cube|3dl)$/i;

/** Whether a file name is a LUT's (.cube or .3dl, in any case). */
export function isLutFileName(name: string): boolean {
  return LUT_NAME.test(name);
}

/** The LUT files among `files`: what a folder gives (a README or a .DS_Store beside them is not an error). */
export function lutFilesOf(files: readonly File[]): File[] {
  return files.filter((file) => isLutFileName(file.name));
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

/** A directory's reader gives its entries in batches; keep asking until it answers with none. */
async function readDirectory(entry: EntryLike): Promise<File[]> {
  const reader = entry.createReader?.();
  if (reader === undefined) return [];
  const found: File[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) return found;
    for (const child of batch) found.push(...(await readEntry(child, true)));
  }
}

async function readEntry(entry: EntryLike, inFolder: boolean): Promise<File[]> {
  if (entry.isDirectory) return readDirectory(entry);
  if (!entry.isFile) return [];
  const file = await readFile(entry);
  if (file === undefined) return [];
  return inFolder && !isLutFileName(file.name) ? [] : [file];
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
      files: await readEntry(entry, false),
    })),
  );
  return {
    files: found.flatMap((one) => one.files),
    sawFolder: found.some((one) => one.folder),
  };
}
