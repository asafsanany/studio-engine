// The font index (Fonts plan, "Reading the font files"): what the engine knows about the fonts in
// `<inbox>/_Fonts`, built from the files themselves. OWNER: FN3.
//
//   listFonts(_Fonts)  ─▶  stat + readFont (only what is new or changed)  ─▶  faces  ─▶  families
//
// The files are the only truth: nothing here is stored. The index reads the folder (any depth, the
// folder names are the owner's own filing and mean nothing), keeps a parse cache keyed by path, modified
// time and size so a refresh reads only the files that are new or changed, and groups the faces by
// the family inside the files (name table, compared without regard to case).
//
//   family   `name` as written in the files (the spelling most of them use), a `slug` that is its
//            address and never changes while the family is here, its faces, `he` (true only when
//            every face has the Hebrew letters), `style`, `addedAt` (the earliest file time), the
//            number of different `files`, their `bytes`, and the `folder` most of them are in
//   face     one weight (and upright or italic) of a family: `name` is what is typed after `@`, and
//            `fileId` a short hash of the file's path inside `_Fonts` (looked up here only: a client
//            never sends a path). A variable font becomes several faces with one `fileId`.
//
// `refresh()` re-lists the folder and tells `onChange` which families are new or different and which
// slugs are gone, and (second argument) the family and face names the library did not have before
// (`appeared`: the names a note's request for a missing font is answered by); the very first build
// is the starting point and tells nobody. A file that cannot
// be read is left out and logged once (until it changes), never thrown. `catalog()` gives the same
// faces in the shape FN12's note parser asks for (`FontCatalog`), so `resolveNoteFonts(text,
// index.catalog())` works on the engine's own library.

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FONT_DEFAULT_STYLE,
  FONT_LIMITS,
  type FontFaceInfo,
  type FontFormat,
  type FontStyle,
  type FontWeight,
  faceName,
  familySlug,
  fontNameKey,
  fontStyleFor,
  normalizeFontWeight,
} from '@studio/shared';
import { listFonts } from '../pipeline/shared-fonts.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { type FontInfo, faceWeights, readFont } from './font-reader.js';
import type { FontCatalog } from './font-tokens.js';

// --- shapes --------------------------------------------------------------------------------------

/** One face of a family, with the file it lives in. */
export interface IndexedFace extends FontFaceInfo {
  /** The file as a path inside `_Fonts` ('/' between folders): also its path in a job's `edit/fonts/`. */
  file: string;
  /** Whether that file has the Hebrew letters (U+05D0–U+05EA). */
  he: boolean;
  /** The file's modified time in milliseconds, as text ({@link fontVersion}). */
  version: string;
}

/** One family: everything the list and the pane need, without the numbers that come from the jobs. */
export interface IndexedFamily {
  /** The family's address (`heebo`): never typed in a note, unique among the families here. */
  slug: string;
  /** As written in the files (the spelling most of them use). */
  name: string;
  /** True only when every face has the Hebrew letters. */
  he: boolean;
  style: FontStyle;
  /** Every weight the family has, once each, lowest first (an italic of the same weight counts once). */
  weights: FontWeight[];
  /** One face per weight and upright/italic, lowest weight first, upright before italic. */
  faces: IndexedFace[];
  /** How many different files the family has (a variable font's faces count once). */
  files: number;
  /** The size of those files together. */
  bytes: number;
  /** The earliest modified time of its files, in milliseconds since the epoch. */
  addedAt: number;
  /** The folder inside `_Fonts` that holds most of its files ('' is `_Fonts` itself). */
  folder: string;
  /**
   * Every file of the family inside `_Fonts`, in path order: the faces' files, plus any file that
   * repeats a face another file already gives (it is listed here so a delete takes it too).
   */
  paths: string[];
}

/** What a refresh found different. */
export interface FontIndexChange {
  /** Families that are new, or whose faces, size, script, style or added time changed. */
  changed: IndexedFamily[];
  /** Slugs of the families that are gone. */
  removed: string[];
}

/**
 * What {@link FontIndexOptions.onChange} is told besides the change: the family names and face
 * names ("Gotham", "Gotham Bold") that were not in the library before this refresh and are now,
 * each once, as the files write it: a family's name, then its faces'. A font that was there never
 * appears again, and a name that leaves and comes back in a later refresh appears again.
 */
export type AppearedFontNames = readonly string[];

/** A font file as the file route needs it. */
export interface IndexedFile {
  /** The file inside `_Fonts` (relative, '/' between folders). */
  file: string;
  /** Its absolute path. */
  path: string;
  /** What its first bytes say it is. */
  format: FontFormat;
  /** Its modified time at the last refresh, whole milliseconds. */
  mtimeMs: number;
  bytes: number;
}

export interface FontIndex {
  /** Resolves when the first build is done (starts it if nobody has). Never rejects. */
  ready(): Promise<void>;
  /**
   * Re-lists the folder, re-reads what is new or changed, and answers what differs. The first
   * call of an index is its starting point: it answers everything as changed and tells `onChange`
   * nothing. Calls queue; a call never throws.
   */
  refresh(): Promise<FontIndexChange>;
  /** Every family, A to Z without regard to case, as of the last refresh. */
  families(): IndexedFamily[];
  /** One family by slug. */
  family(slug: string): IndexedFamily | undefined;
  /** Every face in the same shape the note parser wants (`resolveNoteFonts(text, index.catalog())`). */
  catalog(): FontCatalog;
  /** A file by the id the index gave it: the only way a client names a file. */
  file(fileId: string): IndexedFile | undefined;
}

export interface FontIndexOptions {
  /** The shared fonts folder, `<inbox>/_Fonts`. */
  dir: string;
  logger?: WorkerLogger;
  /**
   * Told, after a refresh that is not the first and found something different, what differs and
   * which family and face names are new in the library. A throw is logged, not passed on.
   */
  onChange?: (change: FontIndexChange, appeared: AppearedFontNames) => void;
  /** How many files are read at once. Default 8. */
  concurrency?: number;
}

// --- small rules ---------------------------------------------------------------------------------

/**
 * A file's version in an address (`?v=`): its modified time in whole milliseconds, as text. The
 * file route compares the `v` it is given with the same rule.
 */
export function fontVersion(mtimeMs: number): string {
  return String(Math.trunc(mtimeMs));
}

/**
 * The names of two families compare A to Z without regard to case (the page sorts new families the
 * same way, so the list does not jump).
 */
export function compareFamilyNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b);
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A style guessed from a font's OS/2 PANOSE numbers, for a family that is not in the table of the 40
 * known ones; `null` when the numbers say nothing (the caller then uses the default). Family kind
 * (byte 0): handwritten → Handwriting, decorative or symbol → Display; for Latin text a condensed
 * proportion (byte 3) → Condensed, else the serif style (byte 1): square → Slab, the serifed ones
 * → Serif, the sans ones → Sans, rounded → Rounded.
 */
export function panoseStyle(panose: readonly number[] | null): FontStyle | null {
  if (panose === null || panose.length < 4) return null;
  const [kind, serif, , proportion] = panose;
  if (kind === 3) return 'Handwriting';
  if (kind === 4 || kind === 5) return 'Display';
  if (kind !== 2) return null;
  if (proportion === 6 || proportion === 8) return 'Condensed';
  if (serif === 6) return 'Slab';
  if (serif !== undefined && [2, 3, 4, 5, 7, 8, 9, 10].includes(serif)) return 'Serif';
  if (serif !== undefined && [11, 12, 13, 14].includes(serif)) return 'Sans';
  if (serif === 15) return 'Rounded';
  return null;
}

/** The style of a family: the table of the known ones, else a guess from panose, else Sans. */
function styleOf(name: string, info: FontInfo): FontStyle {
  return fontStyleFor(name) ?? panoseStyle(info.panose) ?? FONT_DEFAULT_STYLE;
}

/** The id of a file: the start of a hash of its path inside `_Fonts`, longer if two paths share it. */
function fileIdFor(file: string, taken: ReadonlyMap<string, string>): string {
  const hash = createHash('sha1').update(file).digest('hex');
  for (let length = 12; length < hash.length; length += 4) {
    const id = hash.slice(0, length);
    const owner = taken.get(id);
    if (owner === undefined || owner === file) return id;
  }
  return hash;
}

/** The folder of a file inside `_Fonts`: everything before the last '/', '' for a file in `_Fonts`. */
function folderOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash < 0 ? '' : file.slice(0, slash);
}

// --- the parse cache -----------------------------------------------------------------------------

type ParseResult = { ok: true; info: FontInfo } | { ok: false; error: string };

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: ParseResult;
}

/** A file after stat and parse: everything the grouping needs. */
interface FileRecord {
  file: string;
  path: string;
  size: number;
  mtimeMs: number;
  info: FontInfo;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next;
      next += 1;
      if (at >= items.length) return;
      results[at] = await work(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// --- the index -----------------------------------------------------------------------------------

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

interface Snapshot {
  families: IndexedFamily[];
  bySlug: Map<string, IndexedFamily>;
  files: Map<string, IndexedFile>;
  /** What each family looked like, by slug: a different text means "changed". */
  signatures: Map<string, string>;
}

const EMPTY: Snapshot = {
  families: [],
  bySlug: new Map(),
  files: new Map(),
  signatures: new Map(),
};

/** The family names and face names of `families`, each once (compared with {@link fontNameKey}), as written. */
function namesOf(families: readonly IndexedFamily[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const family of families) {
    for (const name of [family.name, ...family.faces.map((face) => face.name)]) {
      const key = fontNameKey(name);
      if (!names.has(key)) names.set(key, name);
    }
  }
  return names;
}

/** The names `after` has that `before` did not: each family's name, then its faces' names. */
export function appearedFontNames(
  before: readonly IndexedFamily[],
  after: readonly IndexedFamily[],
): string[] {
  const had = namesOf(before);
  return [...namesOf(after)].filter(([key]) => !had.has(key)).map(([, name]) => name);
}

function signatureOf(family: IndexedFamily): string {
  return JSON.stringify([
    family.name,
    family.he,
    family.style,
    family.addedAt,
    family.files,
    family.bytes,
    family.folder,
    family.paths,
    family.faces.map((face) => [
      face.fileId,
      face.name,
      face.weight,
      face.italic,
      face.bytes,
      face.format,
      face.version,
      face.he,
    ]),
  ]);
}

export function createFontIndex(options: FontIndexOptions): FontIndex {
  const { dir, onChange, concurrency = 8 } = options;
  const logger = options.logger ?? SILENT;

  let snapshot: Snapshot = EMPTY;
  let built = false;
  let initial: Promise<void> | null = null;
  /** Refreshes run one after the other. */
  let queue: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, CacheEntry>();
  /** The slug each family key was given, kept while the family is here so its address never moves. */
  const slugs = new Map<string, string>();

  /** The file's parse: from the cache when its time and size are the same, else read. `null` = gone. */
  async function parse(file: string): Promise<FileRecord | null> {
    const path = join(dir, file);
    let stats: Stats;
    try {
      stats = await stat(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A file that vanished between the listing and now is just gone.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        logger.warn({ err, file }, 'a font file could not be looked at; it is left out');
      }
      return null;
    }
    if (!stats.isFile()) return null;
    const { mtimeMs, size } = stats;

    let entry = cache.get(file);
    if (entry === undefined || entry.mtimeMs !== mtimeMs || entry.size !== size) {
      let result: ParseResult;
      if (size > FONT_LIMITS.fileMaxBytes) {
        result = { ok: false, error: 'it is over 30 MB' };
      } else {
        let bytes: Buffer;
        try {
          bytes = await readFile(path);
        } catch (err) {
          // Not remembered: the next refresh tries again.
          logger.warn({ err, file }, 'a font file could not be read; it is left out');
          return null;
        }
        const read = readFont(bytes);
        result = read.ok ? { ok: true, info: read } : { ok: false, error: read.error };
      }
      entry = { mtimeMs, size, result };
      cache.set(file, entry);
      if (!entry.result.ok) {
        logger.warn(
          { file, reason: entry.result.error },
          'a font file is not a readable font; it is left out',
        );
      }
    }
    return entry.result.ok ? { file, path, size, mtimeMs, info: entry.result.info } : null;
  }

  /** Gives each family key a slug that no other family has, keeping the ones it already had. */
  function assignSlugs(
    keys: readonly { key: string; name: string; addedAt: number }[],
  ): Map<string, string> {
    const present = new Set(keys.map((entry) => entry.key));
    for (const key of [...slugs.keys()]) if (!present.has(key)) slugs.delete(key);
    const used = new Set(slugs.values());
    // Families that have no slug yet take one in a fixed order, so a restart gives the same ones.
    const fresh = keys
      .filter((entry) => !slugs.has(entry.key))
      .sort((a, b) => a.addedAt - b.addedAt || byCodePoint(a.key, b.key));
    for (const entry of fresh) {
      const base = familySlug(entry.name);
      let slug = base;
      for (let n = 2; used.has(slug); n += 1) {
        const suffix = `-${n}`;
        slug = `${base.slice(0, 60 - suffix.length).replace(/-+$/, '')}${suffix}`;
      }
      used.add(slug);
      slugs.set(entry.key, slug);
    }
    return slugs;
  }

  function group(records: readonly FileRecord[]): Snapshot {
    // The files in path order, so every choice below (the spelling, which file wins a repeated
    // face) is the same on every run.
    const sorted = [...records].sort((a, b) => byCodePoint(a.file, b.file));

    const fileIds = new Map<string, string>();
    for (const record of sorted) fileIds.set(fileIdFor(record.file, fileIds), record.file);
    const idOf = new Map([...fileIds].map(([id, file]) => [file, id]));

    const byFamily = new Map<string, FileRecord[]>();
    for (const record of sorted) {
      const key = fontNameKey(record.info.family);
      const list = byFamily.get(key);
      if (list === undefined) byFamily.set(key, [record]);
      else list.push(record);
    }

    const named = [...byFamily].map(([key, list]) => {
      // The spelling most of the files use; a tie goes to the first by path.
      const spellings = new Map<string, number>();
      for (const record of list) {
        spellings.set(record.info.family, (spellings.get(record.info.family) ?? 0) + 1);
      }
      let name = list[0]?.info.family ?? key;
      let best = 0;
      for (const [spelling, count] of spellings) {
        if (count > best) {
          best = count;
          name = spelling;
        }
      }
      const addedAt = Math.min(...list.map((record) => Math.trunc(record.mtimeMs)));
      return { key, name, list, addedAt };
    });
    const slugOf = assignSlugs(named);

    const families: IndexedFamily[] = [];
    const files = new Map<string, IndexedFile>();
    for (const { key, name, list, addedAt } of named) {
      const faces = new Map<string, IndexedFace>();
      for (const record of list) {
        const fileId = idOf.get(record.file) as string;
        const version = fontVersion(record.mtimeMs);
        for (const weight of faceWeights(record.info)) {
          const slot = `${weight}|${record.info.italic ? 'i' : 'u'}`;
          if (faces.has(slot)) continue;
          faces.set(slot, {
            name: faceName(name, weight, record.info.italic),
            family: name,
            weight,
            italic: record.info.italic,
            fileId,
            bytes: record.size,
            format: record.info.format,
            version,
            file: record.file,
            he: record.info.he,
          });
        }
        files.set(fileId, {
          file: record.file,
          path: record.path,
          format: record.info.format,
          mtimeMs: Math.trunc(record.mtimeMs),
          bytes: record.size,
        });
      }
      const ordered = [...faces.values()].sort(
        (a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic),
      );

      // The style comes from the face nearest to Regular (upright first).
      const regular = list
        .map((record) => ({ record, weights: faceWeights(record.info) }))
        .map(({ record, weights }) => ({
          record,
          distance: Math.min(...weights.map((weight) => Math.abs(weight - 400))),
        }))
        .sort(
          (a, b) =>
            a.distance - b.distance || Number(a.record.info.italic) - Number(b.record.info.italic),
        )[0];

      const perFolder = new Map<string, number>();
      for (const record of list) {
        const folder = folderOf(record.file);
        perFolder.set(folder, (perFolder.get(folder) ?? 0) + 1);
      }
      let folder = folderOf(list[0]?.file ?? '');
      let most = 0;
      for (const [candidate, count] of perFolder) {
        if (count > most) {
          most = count;
          folder = candidate;
        }
      }

      families.push({
        slug: slugOf.get(key) as string,
        name,
        he: ordered.every((face) => face.he),
        style: regular === undefined ? FONT_DEFAULT_STYLE : styleOf(name, regular.record.info),
        weights: [...new Set(ordered.map((face) => normalizeFontWeight(face.weight)))],
        faces: ordered,
        files: list.length,
        bytes: list.reduce((sum, record) => sum + record.size, 0),
        addedAt,
        folder,
        paths: list.map((record) => record.file),
      });
    }

    families.sort((a, b) => compareFamilyNames(a.name, b.name) || byCodePoint(a.slug, b.slug));
    return {
      families,
      bySlug: new Map(families.map((family) => [family.slug, family])),
      files,
      signatures: new Map(families.map((family) => [family.slug, signatureOf(family)])),
    };
  }

  async function run(): Promise<FontIndexChange> {
    let listed: string[];
    try {
      listed = await listFonts(dir);
    } catch (err) {
      // Keep what we know: a folder that cannot be listed for a moment must not empty the page.
      logger.error(
        { err, dir },
        'the fonts folder could not be listed; the index keeps what it had',
      );
      built = true;
      return { changed: [], removed: [] };
    }

    const parsed = await mapLimit(listed, concurrency, parse);
    const records = parsed.filter((record): record is FileRecord => record !== null);
    const listedSet = new Set(listed);
    for (const file of [...cache.keys()]) if (!listedSet.has(file)) cache.delete(file);

    const before = snapshot;
    const after = group(records);
    snapshot = after;

    const changed = after.families.filter(
      (family) => before.signatures.get(family.slug) !== after.signatures.get(family.slug),
    );
    const removed = [...before.signatures.keys()].filter((slug) => !after.bySlug.has(slug));
    const change: FontIndexChange = { changed, removed };

    const first = !built;
    built = true;
    if (!first && (changed.length > 0 || removed.length > 0)) {
      try {
        onChange?.(change, appearedFontNames(before.families, after.families));
      } catch (err) {
        logger.error({ err }, 'a listener of the font index failed');
      }
    }
    return change;
  }

  function refresh(): Promise<FontIndexChange> {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next.catch((err: unknown) => {
      logger.error({ err, dir }, 'the font index could not be refreshed');
      return { changed: [], removed: [] };
    });
  }

  return {
    ready() {
      if (built) return Promise.resolve();
      initial ??= refresh().then(() => undefined);
      return initial;
    },
    refresh,
    families: () => snapshot.families,
    family: (slug) => snapshot.bySlug.get(slug),
    catalog() {
      return {
        faces: snapshot.families.flatMap((family) =>
          family.faces.map((face) => ({
            name: face.name,
            family: face.family,
            weight: face.weight,
            italic: face.italic,
            file: face.file,
            he: face.he,
          })),
        ),
      };
    },
    file: (fileId) => snapshot.files.get(fileId),
  };
}
