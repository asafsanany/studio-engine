// Import, the two halves that read and write files (Fonts plan, "Import"). OWNER: FN4.
//
//   judgeUpload      step 1: reads every staged file (static check, then the reader), GROUPS them
//                    by the family inside the files (folder and file names mean nothing) and gives
//                    each group a verdict against the library the index knows:
//                      new       the family is not here
//                      adds      the family is here and these files add weights to it
//                      same      every file is already here, byte for byte (SHA-256): skipped
//                      conflict  the same face is here as a different file: that file is left out,
//                                the rest of the family can still be imported
//                      bad       one item per unreadable file, named by its file name
//   copyItemIntoLibrary
//                    step 3: copies one chosen `new` / `adds` item into `_Fonts` and never touches
//                    a file that is already there
//
// Where a family goes: its existing folder when it has one (anywhere in `_Fonts`), else
// `_Fonts/<Hebrew + English|English only>/<Family>/`. Files keep their own names; a name that is
// taken by a different file gets " (2)" (" (3)", …) before the extension. Each file is copied to a
// dot name in its own folder (the watcher and listFonts never see it) and then linked to its real
// name, which cannot replace a file; an item that fails half way takes back what it placed.

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  FONT_LIMITS,
  FONT_MESSAGES,
  FONT_SCRIPT_LABELS,
  type FontStageItem,
  type FontWeight,
  faceName,
  fontAddsMessage,
  fontConflictMessage,
  fontNameKey,
  fontNewMessage,
  fontSameMessage,
} from '@studio/shared';
import { cleanFileName } from '../clients/style-upload.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { compareFamilyNames, type IndexedFamily } from './font-index.js';
import { checkFontFile, type FontInfo, faceWeights, readFont } from './font-reader.js';
import { baseNameOf, isFontFileName, type ReceivedFontFile } from './font-staging.js';

// --- shapes --------------------------------------------------------------------------------------

/** A staged file that is a font: where it waits, what it is, and its SHA-256. */
export interface StagedFontFile {
  /** Its name for the copy: the file's own name, cleaned (no folders, no leading dot). */
  name: string;
  /** In the stage's folder. */
  path: string;
  bytes: number;
  sha256: string;
  info: FontInfo;
}

/** An item that can be imported (`new` or `adds`): what the import copies. */
export interface StagedFontItem {
  id: string;
  status: 'new' | 'adds';
  /** The family as written (an existing family keeps the spelling it has). */
  family: string;
  files: StagedFontFile[];
}

/** What the check made of an upload. */
export interface StageVerdicts {
  /** One line of the dialog per family, conflict or bad file. */
  items: FontStageItem[];
  /** The items the import may copy, by id. */
  importable: Map<string, StagedFontItem>;
}

/** The library the check compares an upload with: the index, and the folder its paths are in. */
export interface FontLibraryView {
  /** `<inbox>/_Fonts`. */
  dir: string;
  families(): IndexedFamily[];
}

// --- words ---------------------------------------------------------------------------------------

/** "Rubik Bold", "Rubik Bold and Rubik Light", "Rubik Bold, Rubik Light and 2 more". */
function faceList(faces: readonly string[]): string {
  if (faces.length <= 1) return faces.join('');
  if (faces.length === 2) return `${faces[0]} and ${faces[1]}`;
  const more = faces.length - 2;
  return `${faces[0]}, ${faces[1]} and ${more} more`;
}

/** The verdict `conflict` for one or more faces (the shared sentence says it for one). */
function conflictsMessage(faces: readonly string[]): string {
  const [first] = faces;
  if (faces.length === 1 && first !== undefined) return fontConflictMessage(first);
  return `You already have different files for ${faceList(faces)}. Delete them first to replace them.`;
}

/** Two files of one upload are the same face: only the first can be imported. */
function clashMessage(face: string): string {
  return `Two different files in this upload are ${face}. Only the first one is imported.`;
}

// --- reading and hashing -------------------------------------------------------------------------

const sha256Of = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The SHA-256 of a file; `null` when there is none, `''` (equal to no hash) when it cannot be read. */
async function sha256OfFile(path: string): Promise<string | null> {
  try {
    return sha256Of(await readFile(path));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : '';
  }
}

/** A hash of files on disk, asked once per path. */
function hasher(): (path: string) => Promise<string | null> {
  const known = new Map<string, Promise<string | null>>();
  return (path) => {
    let hash = known.get(path);
    if (hash === undefined) {
      hash = sha256OfFile(path);
      known.set(path, hash);
    }
    return hash;
  };
}

const EMPTY = Buffer.alloc(0);

/** The absolute path of a path inside `_Fonts` ('/' between folders). */
const absolute = (dir: string, inside: string): string => join(dir, ...inside.split('/'));

type StagedRead = { ok: true; file: StagedFontFile } | { ok: false; error: string };

/** The static check, then the reader, on one received file. A file too big or not a font is never read. */
async function readReceived(file: ReceivedFontFile, logger: WorkerLogger): Promise<StagedRead> {
  const base = baseNameOf(file.name);
  let data: Buffer = EMPTY;
  if (isFontFileName(base) && file.bytes <= FONT_LIMITS.fileMaxBytes) {
    try {
      data = await readFile(file.path);
    } catch (err) {
      logger.warn({ err, name: file.name }, 'fonts: could not read an uploaded file');
      return { ok: false, error: FONT_MESSAGES.badImport };
    }
  }
  // `file.bytes` is the size on the wire: a font over the limit was not kept, and its size says so.
  const checked = checkFontFile(base, data, file.bytes);
  if (!checked.ok) return { ok: false, error: checked.error };
  const info = readFont(data);
  if (!info.ok) return { ok: false, error: info.error };
  return {
    ok: true,
    file: {
      name: cleanFileName(base),
      path: file.path,
      bytes: file.bytes,
      sha256: sha256Of(data),
      info,
    },
  };
}

// --- the verdicts --------------------------------------------------------------------------------

/** The faces one staged file stands for: a variable font stands for several. */
function facesOf(file: StagedFontFile): { weight: FontWeight; italic: boolean }[] {
  return faceWeights(file.info).map((weight) => ({ weight, italic: file.info.italic }));
}

const faceKey = (weight: number, italic: boolean): string => `${weight}${italic ? 'i' : ''}`;

/** The files of one family, sorted by what the library says about each. */
export interface Classified {
  /** Not here yet: these are what an import copies. */
  fresh: StagedFontFile[];
  /** Already here, byte for byte. */
  same: StagedFontFile[];
  /** A face of these is here as a different file (`face` is its name). */
  conflicts: { file: StagedFontFile; face: string }[];
  /** A face of these was already taken by another file of the same upload. */
  clashes: { file: StagedFontFile; face: string }[];
}

/**
 * Sorts the staged files of one family against the library. `existing` is the family as the index
 * has it (`undefined`: not here) and `hashes` the SHA-256 of every file it has. The same bytes
 * twice in one upload count once.
 */
export function classifyFiles(
  files: readonly StagedFontFile[],
  familyName: string,
  existing: IndexedFamily | undefined,
  hashes: ReadonlySet<string>,
): Classified {
  const out: Classified = { fresh: [], same: [], conflicts: [], clashes: [] };
  const seen = new Set<string>();
  const taken = new Set<string>();
  for (const file of files) {
    if (seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    if (hashes.has(file.sha256)) {
      out.same.push(file);
      continue;
    }
    const faces = facesOf(file);
    const here = existing?.faces.find((face) =>
      faces.some(({ weight, italic }) => face.weight === weight && face.italic === italic),
    );
    if (existing !== undefined && here !== undefined) {
      out.conflicts.push({ file, face: here.name });
      continue;
    }
    const clash = faces.find(({ weight, italic }) => taken.has(faceKey(weight, italic)));
    if (clash !== undefined) {
      out.clashes.push({ file, face: faceName(familyName, clash.weight, clash.italic) });
      continue;
    }
    for (const { weight, italic } of faces) taken.add(faceKey(weight, italic));
    out.fresh.push(file);
  }
  return out;
}

/** The SHA-256 of every file the indexed family has (a file that vanished is not counted). */
async function hashesOfFamily(
  dir: string,
  family: IndexedFamily | undefined,
  hashOf: (path: string) => Promise<string | null>,
): Promise<Set<string>> {
  const hashes = new Set<string>();
  if (family === undefined) return hashes;
  for (const rel of family.paths) {
    const hash = await hashOf(absolute(dir, rel));
    if (hash !== null) hashes.add(hash);
  }
  return hashes;
}

const sumBytes = (files: readonly { bytes: number }[]): number =>
  files.reduce((total, file) => total + file.bytes, 0);

function weightsOf(files: readonly StagedFontFile[]): FontWeight[] {
  const weights = new Set<FontWeight>();
  for (const file of files) for (const { weight } of facesOf(file)) weights.add(weight);
  return [...weights].sort((a, b) => a - b);
}

/** The spelling of a family most of its files use (the first of them when it is a tie). */
function spellingOf(files: readonly StagedFontFile[]): string {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.info.family, (counts.get(file.info.family) ?? 0) + 1);
  let best = files[0]?.info.family ?? '';
  let bestCount = 0;
  for (const [spelling, count] of counts) {
    if (count > bestCount) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Step 1 of an import: the verdicts. Reads each received file (a file too big or not a font is not
 * read), groups the fonts by the family inside them, and compares each group with the library.
 * Families come A to Z, each followed by its conflicts; bad files come last, in upload order.
 */
export async function judgeUpload(
  received: readonly ReceivedFontFile[],
  library: FontLibraryView,
  logger: WorkerLogger,
): Promise<StageVerdicts> {
  const groups = new Map<string, StagedFontFile[]>();
  const bad: { name: string; bytes: number; error: string }[] = [];
  for (const file of received) {
    const read = await readReceived(file, logger);
    if (!read.ok) {
      bad.push({ name: baseNameOf(file.name), bytes: file.bytes, error: read.error });
      continue;
    }
    const key = fontNameKey(read.file.info.family);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [read.file]);
    else group.push(read.file);
  }

  const indexed = new Map(library.families().map((family) => [fontNameKey(family.name), family]));
  const hashOf = hasher();
  const items: Omit<FontStageItem, 'id'>[] = [];
  const staged: { index: number; item: Omit<StagedFontItem, 'id'> }[] = [];

  const families = [...groups.entries()]
    .map(([key, files]) => ({ files, existing: indexed.get(key), name: spellingOf(files) }))
    .sort((a, b) => compareFamilyNames(a.existing?.name ?? a.name, b.existing?.name ?? b.name));

  for (const { files, existing, name: written } of families) {
    const name = existing?.name ?? written;
    const classified = classifyFiles(
      files,
      name,
      existing,
      await hashesOfFamily(library.dir, existing, hashOf),
    );
    const { fresh, same, conflicts, clashes } = classified;
    if (fresh.length > 0) {
      const he = fresh.every((file) => file.info.he);
      const bytes = sumBytes(fresh);
      const status: 'new' | 'adds' = existing === undefined ? 'new' : 'adds';
      const newFaces = new Set(
        fresh.flatMap((file) => facesOf(file).map((f) => faceKey(f.weight, f.italic))),
      );
      staged.push({ index: items.length, item: { status, family: name, files: fresh } });
      items.push({
        name,
        files: fresh.length,
        he,
        weights: weightsOf(fresh),
        bytes,
        status,
        info:
          existing === undefined
            ? fontNewMessage(fresh.length, he, bytes)
            : fontAddsMessage(newFaces.size, name),
      });
    } else if (same.length > 0) {
      const weights = weightsOf(same);
      items.push({
        name,
        files: same.length,
        he: same.every((file) => file.info.he),
        weights,
        bytes: sumBytes(same),
        status: 'same',
        info: fontSameMessage(weights.length),
      });
    }
    if (conflicts.length > 0) {
      const own = conflicts.map(({ file }) => file);
      items.push({
        name,
        files: own.length,
        he: own.every((file) => file.info.he),
        weights: weightsOf(own),
        bytes: sumBytes(own),
        status: 'conflict',
        info: conflictsMessage(conflicts.map(({ face }) => face)),
      });
    }
    for (const { file, face } of clashes) {
      items.push({
        name,
        files: 1,
        he: file.info.he,
        weights: weightsOf([file]),
        bytes: file.bytes,
        status: 'conflict',
        info: clashMessage(face),
      });
    }
  }
  for (const { name, bytes, error } of bad) {
    items.push({ name, files: 1, he: false, weights: [], bytes, status: 'bad', info: error });
  }

  const importable = new Map<string, StagedFontItem>();
  const numbered: FontStageItem[] = items.map((item, index) => ({ ...item, id: `i${index}` }));
  for (const { index, item } of staged) {
    const id = `i${index}`;
    importable.set(id, { ...item, id });
  }
  return { items: numbered, importable };
}

// --- the copy ------------------------------------------------------------------------------------

/** How a file is copied into `_Fonts`: tests pass one that fails. */
export type FontCopy = (from: string, to: string) => Promise<void>;

/** A copy that makes an APFS clone where the volume can and a plain copy where it can't. */
export const cloneCopy: FontCopy = (from, to) => copyFile(from, to, constants.COPYFILE_FICLONE);

/**
 * The folder name of a family: the name as written inside the files, without the characters a path
 * is made of (`/`, `\`, `:`), control characters, or dots at the start (a dot folder is invisible to
 * the engine). At most 100 characters; "Fonts" when nothing is left.
 */
export function cleanFolderName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: names can hold them
    .replace(/[\u0000-\u001f\u007f/\\:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const cut = Array.from(cleaned).slice(0, 100).join('').trim();
  return cut === '' ? 'Fonts' : cut;
}

/** "Heebo-Bold.ttf" for 1 (its own name), "Heebo-Bold (2).ttf" for 2, "… (3).ttf" for 3. */
export function numberedFontName(name: string, n: number): string {
  if (n <= 1) return name;
  const extension = extname(name);
  return `${name.slice(0, name.length - extension.length)} (${n})${extension}`;
}

/** What an item that could not be copied says. */
export type CopyOutcome =
  | {
      ok: true;
      /** The family as it is written in `_Fonts` now. */
      family: string;
      /** The files this import put in `_Fonts`, as paths inside it. */
      files: string[];
      /** The names of the faces they added (what a note types after `@`). */
      faces: string[];
    }
  | { ok: false; error: string };

export interface CopyItemOptions {
  /** `<inbox>/_Fonts`. */
  library: FontLibraryView;
  item: StagedFontItem;
  copy?: FontCopy;
  logger: WorkerLogger;
}

/** A file name's hard link failed because the file system has none: rename is the way left. */
const NO_HARD_LINKS: ReadonlySet<string> = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EXDEV',
  'ENOSYS',
]);

/**
 * Gives `tmp` its real name in `folder`: the file's own name, or " (2)", " (3)" … when a different
 * file has it. Answers the name it got, or `null` when the very same file is already there. A
 * hard link cannot replace a file, so a name taken a moment ago cannot lose its file.
 */
async function place(
  tmp: string,
  folder: string,
  name: string,
  sha256: string,
): Promise<string | null> {
  for (let n = 1; n < 1000; n += 1) {
    const candidate = numberedFontName(name, n);
    const target = join(folder, candidate);
    const there = await sha256OfFile(target);
    if (there === sha256) return null;
    if (there !== null) continue;
    try {
      await link(tmp, target);
      await rm(tmp, { force: true });
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') continue;
      if (!NO_HARD_LINKS.has(code)) throw err;
      await rename(tmp, target);
      return candidate;
    }
  }
  throw new Error(`no free name for ${name}`);
}

/**
 * Step 3 for one item: puts its files that are not here yet into `_Fonts`, in the family's folder.
 * The library is looked at again (it may have changed since the upload): a file that has meanwhile
 * become a conflict or arrived by hand is left out. Nothing is ever replaced. If a copy fails the
 * files this item placed, and the folders it made, are taken back.
 */
export async function copyItemIntoLibrary({
  library,
  item,
  copy = cloneCopy,
  logger,
}: CopyItemOptions): Promise<CopyOutcome> {
  const key = fontNameKey(item.family);
  const existing = library.families().find((family) => fontNameKey(family.name) === key);
  const family = existing?.name ?? item.family;
  const hashOf = hasher();
  const { fresh, same, conflicts } = classifyFiles(
    item.files,
    family,
    existing,
    await hashesOfFamily(library.dir, existing, hashOf),
  );
  if (fresh.length === 0) {
    return {
      ok: false,
      error:
        conflicts.length > 0
          ? conflictsMessage(conflicts.map(({ face }) => face))
          : fontSameMessage(weightsOf(same).length),
    };
  }

  const he = fresh.every((file) => file.info.he);
  const inside =
    existing !== undefined
      ? existing.folder.split('/').filter((part) => part !== '')
      : [FONT_SCRIPT_LABELS[he ? 'hebrew' : 'english'], cleanFolderName(family)];
  const folder = join(library.dir, ...inside);

  const placed: string[] = [];
  let tmp: string | null = null;
  let firstMade: string | undefined;
  try {
    firstMade = await mkdir(folder, { recursive: true });
    const files: string[] = [];
    for (const file of fresh) {
      tmp = join(folder, `.font-${randomBytes(6).toString('hex')}.tmp`);
      await copy(file.path, tmp);
      const name = await place(tmp, folder, file.name, file.sha256);
      tmp = null;
      if (name !== null) {
        placed.push(join(folder, name));
        files.push([...inside, name].join('/'));
      }
    }
    return {
      ok: true,
      family,
      files,
      faces: fresh.flatMap((file) =>
        facesOf(file).map(({ weight, italic }) => faceName(family, weight, italic)),
      ),
    };
  } catch (err) {
    logger.error({ err, family }, 'fonts: could not copy a family into _Fonts');
    if (tmp !== null) await rm(tmp, { force: true }).catch(() => undefined);
    for (const path of placed) await rm(path, { force: true }).catch(() => undefined);
    if (firstMade !== undefined) {
      // The folders this item made, from the innermost out, while they are empty.
      for (let current = folder; ; current = dirname(current)) {
        try {
          await rmdir(current);
        } catch {
          break;
        }
        if (current === firstMade) break;
      }
    }
    return { ok: false, error: FONT_MESSAGES.importFailed };
  }
}
