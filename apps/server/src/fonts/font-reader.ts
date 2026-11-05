// The font reader and the static file check (Fonts plan, "Reading the font files"). OWNER: FN2.
//
// `readFont(bytes)` says what a font file is: its family, weight, italic, whether it has Hebrew
// letters, and whether it is a variable font. `checkFontFile(name, bytes)` is the static check that
// runs before it (extension, size, magic bytes, table directory, required tables). Every verdict is
// a FONT_MESSAGES sentence and nothing here throws.
//
// There is no font library: only five small tables are needed (name, OS/2, head, cmap, fvar), so
// this reads them itself. A .ttf/.otf is read in place; a .woff is zlib per table; a .woff2 is one
// brotli stream (node's own zlib has both), and none of those five tables is transformed in WOFF2
// (only glyf, loca and hmtx are), so they are cut straight out of the decompressed stream.
//
// What is read from the real library (237 files) and not from the plan's one-line rule:
// - Family is name ID 16, else ID 1. But about 20 files have no ID 16 and carry the weight inside ID
//   1 ("Lato Black", subfamily "Regular"). When the subfamily is Regular/Italic and ID 1 ends in a
//   weight word that agrees with the OS/2 weight, the word is the weight and the rest the family.
// - Weight is the OS/2 class when that is a clean 100, 200 … 900. Fonts also use 250 for Thin and
//   for ExtraLight, and 275 for ExtraLight; snapping those to the nearest hundred puts three faces
//   on 300. A class like that is decided by the style word (Thin 100, ExtraLight 200 …) and only
//   snapped (normalizeFontWeight) when there is no word.
// - Script is the cmap: Hebrew when every letter U+05D0–U+05EA has a glyph (never the folder).

import { brotliDecompressSync, inflateSync } from 'node:zlib';
import {
  FONT_LIMITS,
  FONT_MESSAGES,
  FONT_WEIGHTS,
  type FontFormat,
  type FontWeight,
  fontFormatOf,
  normalizeFontWeight,
} from '@studio/shared';

// --- results -------------------------------------------------------------------------------------

/** One axis of a variable font (fvar): its tag (`wght`), its name when the file gives one, and range. */
export interface FontAxis {
  tag: string;
  name: string | null;
  min: number;
  default: number;
  max: number;
}

/** What a readable font file is. */
export interface FontInfo {
  ok: true;
  /** The family: name ID 16, else ID 1 (with a weight word taken off, see the header). */
  family: string;
  /** The style text of the file ("Bold Italic", "Regular"): shown, never used to name a face. */
  subfamily: string;
  /** 100 … 900. For a variable font, the weight of its default instance. */
  weight: FontWeight;
  /** OS/2 fsSelection bit 0 or head macStyle bit 1. */
  italic: boolean;
  /** The cmap covers all 27 Hebrew letters U+05D0–U+05EA. */
  he: boolean;
  /** The 10 OS/2 panose numbers, or null when the file has none (or all zeros: "any"). */
  panose: number[] | null;
  /** The file has an fvar table with at least one axis. */
  variable: boolean;
  /** Every axis of a variable font, else null. */
  axes: FontAxis[] | null;
  /**
   * The weights a variable font with a weight axis stands for: its named instances inside the
   * axis range, or the standard hundreds inside the range when it has none. Null for a static font
   * and for a variable font with no weight axis (one weight, `weight`).
   */
  namedInstances: FontWeight[] | null;
  /** What the file's first bytes say it is (not what its extension says). */
  format: FontFormat;
}

export type FontReadResult = FontInfo | { ok: false; error: string };

/** The static check: the format of a file that looks like a font, or the one sentence why not. */
export type FontCheck = { ok: true; format: FontFormat } | { ok: false; error: string };

// --- errors --------------------------------------------------------------------------------------

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A refusal with its sentence. Thrown inside, turned into `{ ok: false, error }` at the edge. */
class BadFont extends Error {}

const cutShort = (): BadFont => new BadFont(FONT_MESSAGES.cutShort);
const notAFont = (): BadFont => new BadFont(FONT_MESSAGES.notFontFile);

/** Any failure as one of the sentences: a read past the end is "cut short", the rest "not a font". */
function sentenceOf(error: unknown): string {
  if (error instanceof BadFont) return error.message;
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : '';
  if (code === 'ERR_OUT_OF_RANGE' || code === 'Z_BUF_ERROR') return FONT_MESSAGES.cutShort;
  return FONT_MESSAGES.notFontFile;
}

// --- the file: format, table directory, tables ---------------------------------------------------

const REQUIRED_TABLES = ['name', 'cmap', 'OS/2', 'head'] as const;

/** The most a decompressed table (WOFF) or stream (WOFF2) may be: far above any real font. */
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/** An opened file: its format, which tables it has, and a way to get one table's bytes. */
interface OpenFont {
  format: FontFormat;
  has(tag: string): boolean;
  table(tag: string): Buffer | null;
}

const text = (buf: Buffer, start: number, end: number): string =>
  buf.toString('latin1', start, end);

function openSfnt(buf: Buffer, format: FontFormat): OpenFont {
  if (buf.length < 12) throw cutShort();
  const count = buf.readUInt16BE(4);
  if (12 + count * 16 > buf.length) throw cutShort();
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const offset = buf.readUInt32BE(at + 8);
    const length = buf.readUInt32BE(at + 12);
    if (offset + length > buf.length) throw cutShort();
    const tag = text(buf, at, at + 4);
    if (!tables.has(tag)) tables.set(tag, { offset, length });
  }
  return {
    format,
    has: (tag) => tables.has(tag),
    table(tag) {
      const entry = tables.get(tag);
      return entry ? buf.subarray(entry.offset, entry.offset + entry.length) : null;
    },
  };
}

function openWoff(buf: Buffer): OpenFont {
  if (buf.length < 44) throw cutShort();
  if (buf.readUInt32BE(8) > buf.length) throw cutShort();
  const count = buf.readUInt16BE(12);
  if (44 + count * 20 > buf.length) throw cutShort();
  const tables = new Map<string, { offset: number; stored: number; original: number }>();
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    const offset = buf.readUInt32BE(at + 4);
    const stored = buf.readUInt32BE(at + 8);
    const original = buf.readUInt32BE(at + 12);
    if (offset + stored > buf.length) throw cutShort();
    if (stored > original) throw notAFont();
    const tag = text(buf, at, at + 4);
    if (!tables.has(tag)) tables.set(tag, { offset, stored, original });
  }
  return {
    format: 'woff',
    has: (tag) => tables.has(tag),
    table(tag) {
      const entry = tables.get(tag);
      if (!entry) return null;
      const bytes = buf.subarray(entry.offset, entry.offset + entry.stored);
      if (entry.stored === entry.original) return bytes;
      if (entry.original === 0 || entry.original > MAX_INFLATED_BYTES) throw notAFont();
      const table = inflateSync(bytes, { maxOutputLength: entry.original });
      if (table.length !== entry.original) throw notAFont();
      return table;
    },
  };
}

/** The 63 table tags a WOFF2 directory entry can name by number (WOFF2 spec, 5.1). */
// biome-ignore format: twelve tags to a row read better than one per line
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

function openWoff2(buf: Buffer): OpenFont {
  if (buf.length < 48) throw cutShort();
  if (buf.readUInt32BE(8) > buf.length) throw cutShort();
  const count = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);

  let at = 48;
  const readBase128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (at >= buf.length) throw cutShort();
      const byte = buf[at++] as number;
      if (i === 0 && byte === 0x80) throw notAFont();
      if (value > 0x1fffffff) throw notAFont();
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw notAFont();
  };

  // The directory: where each table sits in the decompressed stream, in directory order.
  const tables = new Map<string, { offset: number; length: number; transformed: boolean }>();
  let streamLength = 0;
  for (let i = 0; i < count; i++) {
    if (at >= buf.length) throw cutShort();
    const flags = buf[at++] as number;
    const index = flags & 0x3f;
    const version = flags >> 6;
    let tag: string;
    if (index === 63) {
      if (at + 4 > buf.length) throw cutShort();
      tag = text(buf, at, at + 4);
      at += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[index] as string;
    }
    const original = readBase128();
    // glyf and loca are transformed unless version 3; every other table only when version is not 0.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? readBase128() : original;
    if (!tables.has(tag)) tables.set(tag, { offset: streamLength, length, transformed });
    streamLength += length;
    if (streamLength > MAX_INFLATED_BYTES) throw notAFont();
  }
  if (at + compressedSize > buf.length) throw cutShort();

  let stream: Buffer | null = null;
  return {
    format: 'woff2',
    has: (tag) => tables.has(tag),
    table(tag) {
      const entry = tables.get(tag);
      if (!entry) return null;
      if (entry.transformed) throw notAFont();
      stream ??= brotliDecompressSync(buf.subarray(at, at + compressedSize), {
        maxOutputLength: Math.max(1, streamLength),
      });
      if (entry.offset + entry.length > stream.length) throw cutShort();
      return stream.subarray(entry.offset, entry.offset + entry.length);
    },
  };
}

/** Opens a font file by its first four bytes and checks its table directory and required tables. */
function openFont(buf: Buffer): OpenFont {
  if (buf.length < 4) throw notAFont();
  const magic = text(buf, 0, 4);
  let font: OpenFont;
  if (magic === '\x00\x01\x00\x00' || magic === 'true') font = openSfnt(buf, 'ttf');
  else if (magic === 'OTTO') font = openSfnt(buf, 'otf');
  else if (magic === 'wOFF') font = openWoff(buf);
  else if (magic === 'wOF2') font = openWoff2(buf);
  else if (magic === 'ttcf') throw new BadFont(FONT_MESSAGES.collection);
  else throw notAFont();
  for (const tag of REQUIRED_TABLES) if (!font.has(tag)) throw notAFont();
  return font;
}

const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// --- the static check ----------------------------------------------------------------------------

/**
 * The static check of one font file, with no reader needed first: the extension is one of
 * FONT_EXTENSIONS; the size is at most 30 MB (`size` is the size on disk when the caller has not
 * read it all, else `bytes.length`); the first bytes are a font's (`00 01 00 00`, `OTTO`, `true`,
 * `wOFF`, `wOF2`; `ttcf` is a collection); the table directory does not run past the end of the
 * file; and name, cmap, OS/2 and head are there. A `.ttc`/`.otc` that starts with `ttcf` is the
 * collection sentence. It never throws.
 */
export function checkFontFile(name: string, bytes: Uint8Array, size = bytes.length): FontCheck {
  try {
    if (fontFormatOf(name) === null) {
      const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
      const isCollection =
        (extension === '.ttc' || extension === '.otc') &&
        bytes.length >= 4 &&
        text(asBuffer(bytes), 0, 4) === 'ttcf';
      return fail(isCollection ? FONT_MESSAGES.collection : FONT_MESSAGES.badExtension);
    }
    if (size > FONT_LIMITS.fileMaxBytes) return fail(FONT_MESSAGES.tooLarge);
    return { ok: true, format: openFont(asBuffer(bytes)).format };
  } catch (error) {
    return fail(sentenceOf(error));
  }
}

// --- the name table ------------------------------------------------------------------------------

const utf16 = new TextDecoder('utf-16be');
const macRoman = new TextDecoder('macintosh');

/** How good a name record is for us: lower is better. Windows English first, then the rest. */
function nameScore(platform: number, language: number): number {
  if (platform === 3) return language === 0x409 ? 0 : (language & 0xff) === 9 ? 1 : 4;
  if (platform === 0) return 2;
  if (platform === 1) return language === 0 ? 3 : 5;
  return 6;
}

/** The strings of a name table by ID: the English Windows one if there is one, else the best other. */
function readNames(table: Buffer): (id: number) => string | null {
  if (table.length < 6) throw cutShort();
  const count = table.readUInt16BE(2);
  const stringsAt = table.readUInt16BE(4);
  const best = new Map<
    number,
    { score: number; platform: number; encoding: number; start: number; end: number }
  >();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > table.length) break;
    const platform = table.readUInt16BE(at);
    const encoding = table.readUInt16BE(at + 2);
    const language = table.readUInt16BE(at + 4);
    const id = table.readUInt16BE(at + 6);
    const start = stringsAt + table.readUInt16BE(at + 10);
    const end = start + table.readUInt16BE(at + 8);
    if (end > table.length || end === start) continue;
    const score = nameScore(platform, language);
    const known = best.get(id);
    if (!known || score < known.score) best.set(id, { score, platform, encoding, start, end });
  }
  return (id) => {
    const record = best.get(id);
    if (!record) return null;
    const raw = table.subarray(record.start, record.end);
    const decoded =
      record.platform === 0 || record.platform === 3
        ? utf16.decode(raw)
        : record.platform === 1 && record.encoding === 0
          ? macRoman.decode(raw)
          : raw.toString('latin1');
    // Some old names are padded with NUL characters.
    const clean = decoded.split('\u0000').join('').normalize('NFC').trim();
    return clean === '' ? null : clean;
  };
}

// --- weight --------------------------------------------------------------------------------------

/** Style words → weight. Longer words first ("extrabold" before "bold"). "Heavy" is Black. */
const WEIGHT_WORDS: ReadonlyArray<readonly [string, FontWeight]> = [
  ['extralight', 200],
  ['ultralight', 200],
  ['extrabold', 800],
  ['ultrabold', 800],
  ['semibold', 600],
  ['demibold', 600],
  ['hairline', 100],
  ['thin', 100],
  ['light', 300],
  ['medium', 500],
  ['regular', 400],
  ['normal', 400],
  ['book', 400],
  ['roman', 400],
  ['heavy', 900],
  ['black', 900],
  ['bold', 700],
  ['demi', 600],
];

/** The weight a style text names ("Extra Light Italic" → 200), or null when it names none. */
function weightWord(styleText: string): FontWeight | null {
  const key = styleText.toLowerCase().replace(/[^a-z]/g, '');
  for (const [word, weight] of WEIGHT_WORDS) if (key.includes(word)) return weight;
  return null;
}

/** A weight class that is exactly one of the nine (100, 200 … 900). */
const isCleanWeight = (value: number): value is FontWeight =>
  (FONT_WEIGHTS as readonly number[]).includes(value);

/**
 * The weight of a face from a number (OS/2 class, an fvar coordinate) and the style words that go
 * with it: a clean number is the weight; any other number (250, 275, 450 …) is decided by the style
 * word and only snapped to the nearest hundred when there is none. No number at all: Bold when the
 * file says bold, else Regular.
 */
function pickWeight(value: number, words: readonly string[], bold: boolean): FontWeight {
  if (isCleanWeight(value)) return value;
  for (const word of words) {
    const found = weightWord(word);
    // A plain "Regular" is only filler when the number is far from 400: it does not outvote 250.
    if (found && !(found === 400 && value >= 1 && Math.abs(value - 400) > 100)) return found;
  }
  if (value >= 1) return normalizeFontWeight(value);
  return bold ? 700 : 400;
}

/** "Lato Black", "Foo Extra Light Italic": the family, the weight word and an optional Italic. */
const TRAILING_WEIGHT =
  /^(.*?\S)\s+((?:thin|hairline|extra[ -]?light|ultra[ -]?light|light|medium|semi[ -]?bold|demi[ -]?bold|extra[ -]?bold|ultra[ -]?bold|heavy|black|bold))(?:\s+(italic|oblique))?$/i;

/** The family and the style text of a file: name IDs 16 and 17, else 1 and 2 (see the header). */
function familyAndStyle(
  names: (id: number) => string | null,
  weightClass: number,
): { family: string; style: string } {
  const id16 = names(16);
  const id1 = names(1);
  const id2 = names(2) ?? '';
  if (id16) return { family: id16, style: names(17) ?? id2 };
  const family = id1 ?? names(4) ?? names(6);
  if (!family) throw notAFont();
  if (id1 && /^(regular|italic|oblique|normal|)$/i.test(id2)) {
    const match = TRAILING_WEIGHT.exec(id1);
    const word = match?.[2] ? weightWord(match[2]) : null;
    if (
      match?.[1] &&
      word &&
      word !== 400 &&
      weightClass >= 1 &&
      weightClass !== 400 &&
      Math.abs(weightClass - word) <= 150
    ) {
      return { family: match[1], style: match[3] ? `${match[2]} ${match[3]}` : (match[2] ?? '') };
    }
  }
  return { family, style: id2 };
}

// --- cmap: does the font have the Hebrew letters -------------------------------------------------

const HEBREW_LETTERS = Array.from({ length: 27 }, (_, i) => 0x05d0 + i); // U+05D0–U+05EA

/** Binary search of sorted fixed-size records: the index of the last one whose key is <= value. */
function lastAtMost(count: number, keyAt: (i: number) => number, value: number): number {
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (keyAt(mid) <= value) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** A Unicode cmap subtable as "does this code point have a glyph (not .notdef)". Null: not one we read. */
function subtableLookup(sub: Buffer): ((codePoint: number) => boolean) | null {
  const format = sub.readUInt16BE(0);
  if (format === 4) {
    const segments = sub.readUInt16BE(6) / 2;
    const ends = 14;
    const starts = 16 + segments * 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    return (cp) => {
      if (cp > 0xffff) return false;
      const i = lastAtMost(segments, (s) => sub.readUInt16BE(starts + s * 2), cp);
      if (i < 0 || cp > sub.readUInt16BE(ends + i * 2)) return false;
      const delta = sub.readUInt16BE(deltas + i * 2);
      const range = sub.readUInt16BE(ranges + i * 2);
      if (range === 0) return ((cp + delta) & 0xffff) !== 0;
      const at = ranges + i * 2 + range + (cp - sub.readUInt16BE(starts + i * 2)) * 2;
      if (at + 2 > sub.length) return false;
      const glyph = sub.readUInt16BE(at);
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    };
  }
  if (format === 12 || format === 13) {
    const groups = Math.min(sub.readUInt32BE(12), Math.floor((sub.length - 16) / 12));
    return (cp) => {
      const i = lastAtMost(groups, (g) => sub.readUInt32BE(16 + g * 12), cp);
      if (i < 0 || cp > sub.readUInt32BE(16 + i * 12 + 4)) return false;
      const glyph =
        sub.readUInt32BE(16 + i * 12 + 8) +
        (format === 12 ? cp - sub.readUInt32BE(16 + i * 12) : 0);
      return glyph !== 0;
    };
  }
  if (format === 6) {
    const first = sub.readUInt16BE(6);
    const entries = sub.readUInt16BE(8);
    return (cp) =>
      cp >= first && cp < first + entries && sub.readUInt16BE(10 + (cp - first) * 2) !== 0;
  }
  if (format === 10) {
    const first = sub.readUInt32BE(12);
    const entries = sub.readUInt32BE(16);
    return (cp) =>
      cp >= first && cp < first + entries && sub.readUInt16BE(20 + (cp - first) * 2) !== 0;
  }
  return null;
}

/** True when the cmap has a glyph for every Hebrew letter in some Unicode subtable. */
function coversHebrew(cmap: Buffer): boolean {
  if (cmap.length < 4) throw cutShort();
  const count = cmap.readUInt16BE(2);
  const lookups: Array<(codePoint: number) => boolean> = [];
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8;
    if (at + 8 > cmap.length) throw cutShort();
    const platform = cmap.readUInt16BE(at);
    const encoding = cmap.readUInt16BE(at + 2);
    const unicode =
      platform === 0 ? encoding !== 5 : platform === 3 && (encoding === 1 || encoding === 10);
    if (!unicode) continue;
    const offset = cmap.readUInt32BE(at + 4);
    if (offset + 2 > cmap.length) throw cutShort();
    const lookup = subtableLookup(cmap.subarray(offset));
    if (lookup) lookups.push(lookup);
  }
  return HEBREW_LETTERS.every((cp) => lookups.some((has) => has(cp)));
}

// --- fvar: variable fonts ------------------------------------------------------------------------

const fixed = (buf: Buffer, at: number): number =>
  Math.round((buf.readInt32BE(at) / 65536) * 100) / 100;

interface Variation {
  axes: FontAxis[];
  /** The weight coordinate and style name of each named instance, in file order. */
  instances: Array<{ coordinates: number[]; name: string | null }>;
}

function readFvar(fvar: Buffer, names: (id: number) => string | null): Variation {
  if (fvar.length < 16) throw cutShort();
  const axesAt = fvar.readUInt16BE(4);
  const axisCount = fvar.readUInt16BE(8);
  const axisSize = fvar.readUInt16BE(10);
  const instanceCount = fvar.readUInt16BE(12);
  const instanceSize = fvar.readUInt16BE(14);
  const axes: FontAxis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const at = axesAt + i * axisSize;
    if (at + 20 > fvar.length) throw cutShort();
    axes.push({
      tag: text(fvar, at, at + 4),
      name: names(fvar.readUInt16BE(at + 18)),
      min: fixed(fvar, at + 4),
      default: fixed(fvar, at + 8),
      max: fixed(fvar, at + 12),
    });
  }
  const instances: Variation['instances'] = [];
  const instancesAt = axesAt + axisCount * axisSize;
  for (let i = 0; i < instanceCount; i++) {
    const at = instancesAt + i * instanceSize;
    if (at + 4 + axisCount * 4 > fvar.length) break;
    instances.push({
      name: names(fvar.readUInt16BE(at)),
      coordinates: axes.map((_, a) => fixed(fvar, at + 4 + a * 4)),
    });
  }
  return { axes, instances };
}

/** The weights a weight-variable font offers: named instances inside the axis, else the hundreds. */
function variableWeights(variation: Variation, fallback: FontWeight): FontWeight[] | null {
  const index = variation.axes.findIndex((axis) => axis.tag === 'wght');
  const axis = variation.axes[index];
  if (!axis) return null;
  const found = new Set<FontWeight>();
  for (const instance of variation.instances) {
    const coordinate = instance.coordinates[index];
    if (coordinate === undefined || coordinate < axis.min || coordinate > axis.max) continue;
    found.add(pickWeight(coordinate, instance.name ? [instance.name] : [], false));
  }
  if (found.size === 0) {
    for (const weight of FONT_WEIGHTS)
      if (weight >= axis.min && weight <= axis.max) found.add(weight);
  }
  if (found.size === 0) found.add(fallback);
  return [...found].sort((a, b) => a - b);
}

/**
 * The weights one file stands for, which is how a variable font becomes several faces pointing at
 * one file: its named instances (or standard hundreds) for a font with a weight axis, else just
 * its own weight. A static font is always one.
 */
export function faceWeights(font: FontInfo): FontWeight[] {
  return font.namedInstances && font.namedInstances.length > 0
    ? font.namedInstances
    : [font.weight];
}

// --- readFont ------------------------------------------------------------------------------------

/**
 * Reads a font file's bytes (.ttf, .otf, .woff or .woff2) and says what it is. A file that is not
 * a readable font answers `{ ok: false, error }` with one FONT_MESSAGES sentence; it never throws.
 * It runs the same structure check as {@link checkFontFile} (without the extension and size rules).
 */
export function readFont(bytes: Uint8Array): FontReadResult {
  try {
    const font = openFont(asBuffer(bytes));
    const names = readNames(font.table('name') as Buffer);

    const os2 = font.table('OS/2') as Buffer;
    if (os2.length < 8) throw cutShort();
    const weightClass = os2.readUInt16BE(4);
    const selection = os2.length >= 64 ? os2.readUInt16BE(62) : 0;
    const head = font.table('head') as Buffer;
    if (head.length < 46) throw cutShort();
    const macStyle = head.readUInt16BE(44);

    const { family, style } = familyAndStyle(names, weightClass);
    const bold = (macStyle & 1) !== 0 || (selection & 0x20) !== 0;
    const weight = pickWeight(weightClass, [style], bold);

    let panose: number[] | null = null;
    if (os2.length >= 42) {
      const numbers = Array.from(os2.subarray(32, 42));
      if (numbers.some((n) => n !== 0)) panose = numbers;
    }

    const fvar = font.table('fvar');
    const read = fvar ? readFvar(fvar, names) : null;
    const variation = read && read.axes.length > 0 ? read : null;

    return {
      ok: true,
      family,
      subfamily: style,
      weight,
      italic: (selection & 1) !== 0 || (macStyle & 2) !== 0,
      he: coversHebrew(font.table('cmap') as Buffer),
      panose,
      variable: variation !== null,
      axes: variation ? variation.axes : null,
      namedInstances: variation ? variableWeights(variation, weight) : null,
      format: font.format,
    };
  } catch (error) {
    return fail(sentenceOf(error));
  }
}
