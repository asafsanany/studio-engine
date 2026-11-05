// Test helpers for the Fonts engine: build a tiny font file with exactly the tables the reader
// reads (name, OS/2, head, cmap, and an fvar when asked), and wrap it as .woff or .woff2. The real
// fixtures in fixtures/fonts/ cover real files; this covers what no small real file has (variable
// fonts, a Lato-style name table, a weight class of 250, every cmap format, Mac names).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, deflateSync } from 'node:zlib';

/** The folder of the real test fonts (fixtures/fonts/) at the root of the repo. */
export const FIXTURE_FONTS = fileURLToPath(new URL('../../../../fixtures/fonts/', import.meta.url));

export const fixtureFont = (name: string): Buffer => readFileSync(join(FIXTURE_FONTS, name));

export interface NameRecord {
  platform: number;
  encoding: number;
  language: number;
  id: number;
  /** A string (UTF-16BE on platform 0 and 3, Mac Roman on platform 1 for the bytes given). */
  value: string | Buffer;
}

export interface TestFontOptions {
  /** The name IDs 1, 2, 16, 17 as Windows English records (null or absent: no record). */
  id1?: string | null;
  id2?: string | null;
  id16?: string | null;
  id17?: string | null;
  /** Records added as they are, after the four above. */
  names?: NameRecord[];
  weightClass?: number;
  /** OS/2 fsSelection bit 0. */
  italic?: boolean;
  /** head macStyle bit 1 (italic) and bit 0 (bold). */
  macItalic?: boolean;
  macBold?: boolean;
  panose?: number[];
  /** Which code points the cmap maps (default: A–Z). */
  codePoints?: number[];
  /** Hebrew letters U+05D0–U+05EA added to the code points: all 27, or 26 ("partial"). */
  hebrew?: boolean | 'partial';
  cmap?: 'format4' | 'format12' | 'format6' | 'format13';
  /** The cmap record's platform: Windows (3, the default) or Unicode (0). */
  cmapPlatform?: 'windows' | 'unicode';
  /** Map the code points to glyph 0 (.notdef) in a format 12 cmap: present but no glyph. */
  notdef?: boolean;
  /** The first four bytes (default a TrueType font). */
  magic?: '\x00\x01\x00\x00' | 'OTTO' | 'true';
  /** Table tags to leave out. */
  omit?: string[];
  fvar?: {
    axes: Array<{ tag: string; name: string; min: number; default: number; max: number }>;
    instances?: Array<{ name: string; coordinates: number[] }>;
  };
}

const u16 = (value: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
};
const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};
const fixed = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeInt32BE(Math.round(value * 65536));
  return out;
};
const utf16be = (value: string): Buffer => {
  const out = Buffer.alloc(value.length * 2);
  for (let i = 0; i < value.length; i++) out.writeUInt16BE(value.charCodeAt(i), i * 2);
  return out;
};
const pad4 = (buf: Buffer): Buffer =>
  Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);

function nameTable(records: NameRecord[]): Buffer {
  const strings: Buffer[] = [];
  const entries: Buffer[] = [];
  let offset = 0;
  for (const record of records) {
    const raw =
      typeof record.value !== 'string'
        ? record.value
        : record.platform === 1
          ? Buffer.from(record.value, 'latin1')
          : utf16be(record.value);
    entries.push(
      Buffer.concat([
        u16(record.platform),
        u16(record.encoding),
        u16(record.language),
        u16(record.id),
        u16(raw.length),
        u16(offset),
      ]),
    );
    strings.push(raw);
    offset += raw.length;
  }
  return Buffer.concat([
    u16(0),
    u16(records.length),
    u16(6 + records.length * 12),
    ...entries,
    ...strings,
  ]);
}

/** Runs of consecutive code points: [[start, end], ...]. */
function runs(codePoints: number[]): Array<[number, number]> {
  const sorted = [...new Set(codePoints)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const cp of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === cp - 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
}

function cmapTable(options: TestFontOptions): Buffer {
  const points = [...(options.codePoints ?? Array.from({ length: 26 }, (_, i) => 0x41 + i))];
  if (options.hebrew) {
    const count = options.hebrew === 'partial' ? 26 : 27;
    for (let i = 0; i < count; i++) points.push(0x05d0 + i);
  }
  const groups = runs(points);
  const format = options.cmap ?? 'format4';
  let sub: Buffer;
  const platform = options.cmapPlatform === 'unicode' ? 0 : 3;
  let encoding = 1;
  if (format === 'format12' || format === 'format13') {
    let glyph = 1;
    const body = groups.map(([start, end]) => {
      const startGlyph = options.notdef ? 0 : glyph;
      glyph += end - start + 1;
      return Buffer.concat([u32(start), u32(end), u32(startGlyph)]);
    });
    sub = Buffer.concat([
      u16(format === 'format12' ? 12 : 13),
      u16(0),
      u32(16 + body.length * 12),
      u32(0),
      u32(body.length),
      ...body,
    ]);
    encoding = 10;
  } else if (format === 'format6') {
    const first = points.length > 0 ? Math.min(...points) : 0;
    const last = points.length > 0 ? Math.max(...points) : 0;
    const set = new Set(points);
    const glyphs: Buffer[] = [];
    for (let cp = first; cp <= last; cp++) glyphs.push(u16(set.has(cp) ? cp - first + 1 : 0));
    sub = Buffer.concat([
      u16(6),
      u16(10 + glyphs.length * 2),
      u16(0),
      u16(first),
      u16(glyphs.length),
      ...glyphs,
    ]);
  } else {
    // Format 4, one segment per run (idDelta maps each code point to its own glyph), then 0xFFFF.
    const segments = [...groups.filter(([, end]) => end < 0xffff), [0xffff, 0xffff]] as Array<
      [number, number]
    >;
    let glyph = 1;
    const deltas: number[] = [];
    for (const [start, end] of segments) {
      if (start === 0xffff) {
        deltas.push(1);
      } else {
        deltas.push((glyph - start) & 0xffff);
        glyph += end - start + 1;
      }
    }
    const count = segments.length;
    sub = Buffer.concat([
      u16(4),
      u16(16 + count * 8),
      u16(0),
      u16(count * 2),
      u16(0),
      u16(0),
      u16(0),
      ...segments.map(([, end]) => u16(end)),
      u16(0),
      ...segments.map(([start]) => u16(start)),
      ...deltas.map((delta) => u16(delta)),
      ...segments.map(() => u16(0)),
    ]);
  }
  return Buffer.concat([
    u16(0),
    u16(1),
    u16(platform),
    u16(platform === 0 ? (encoding === 10 ? 4 : 3) : encoding),
    u32(12),
    sub,
  ]);
}

function os2Table(options: TestFontOptions): Buffer {
  const out = Buffer.alloc(96);
  out.writeUInt16BE(4, 0);
  out.writeUInt16BE(options.weightClass ?? 400, 4);
  out.writeUInt16BE(5, 6);
  Buffer.from(options.panose ?? new Array(10).fill(0)).copy(out, 32);
  out.writeUInt16BE(options.italic ? 1 : 0x40, 62);
  return out;
}

function headTable(options: TestFontOptions): Buffer {
  const out = Buffer.alloc(54);
  out.writeUInt32BE(0x00010000, 0);
  out.writeUInt32BE(0x5f0f3cf5, 12);
  out.writeUInt16BE(1000, 18);
  out.writeUInt16BE((options.macBold ? 1 : 0) | (options.macItalic ? 2 : 0), 44);
  return out;
}

/** Builds a font file with the tables the reader reads. */
export function buildFont(options: TestFontOptions = {}): Buffer {
  const english = (id: number, value: string | null | undefined): NameRecord[] =>
    value ? [{ platform: 3, encoding: 1, language: 0x409, id, value }] : [];
  const records: NameRecord[] = [
    ...english(1, options.id1),
    ...english(2, options.id2),
    ...english(16, options.id16),
    ...english(17, options.id17),
    ...(options.names ?? []),
  ];

  const tables = new Map<string, Buffer>();
  if (options.fvar) {
    let id = 256;
    const axisNames = options.fvar.axes.map((axis) => {
      records.push({ platform: 3, encoding: 1, language: 0x409, id, value: axis.name });
      return id++;
    });
    const instances = options.fvar.instances ?? [];
    const instanceNames = instances.map((instance) => {
      records.push({ platform: 3, encoding: 1, language: 0x409, id, value: instance.name });
      return id++;
    });
    const count = options.fvar.axes.length;
    tables.set(
      'fvar',
      Buffer.concat([
        u16(1),
        u16(0),
        u16(16),
        u16(2),
        u16(count),
        u16(20),
        u16(instances.length),
        u16(4 + count * 4),
        ...options.fvar.axes.map((axis, i) =>
          Buffer.concat([
            Buffer.from(axis.tag, 'latin1'),
            fixed(axis.min),
            fixed(axis.default),
            fixed(axis.max),
            u16(0),
            u16(axisNames[i] as number),
          ]),
        ),
        ...instances.map((instance, i) =>
          Buffer.concat([
            u16(instanceNames[i] as number),
            u16(0),
            ...instance.coordinates.map((coordinate) => fixed(coordinate)),
          ]),
        ),
      ]),
    );
  }
  tables.set('name', nameTable(records));
  tables.set('OS/2', os2Table(options));
  tables.set('head', headTable(options));
  tables.set('cmap', cmapTable(options));
  for (const tag of options.omit ?? []) tables.delete(tag);
  return sfnt(options.magic ?? '\x00\x01\x00\x00', tables);
}

function sfnt(magic: string, tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort();
  let offset = 12 + tags.length * 16;
  const entries: Buffer[] = [];
  const bodies: Buffer[] = [];
  for (const tag of tags) {
    const body = tables.get(tag) as Buffer;
    entries.push(
      Buffer.concat([Buffer.from(tag, 'latin1'), u32(0), u32(offset), u32(body.length)]),
    );
    bodies.push(pad4(body));
    offset += pad4(body).length;
  }
  return Buffer.concat([
    Buffer.from(magic, 'latin1'),
    u16(tags.length),
    u16(0),
    u16(0),
    u16(0),
    ...entries,
    ...bodies,
  ]);
}

/** The tables of an sfnt file by tag. */
function tablesOf(font: Buffer): Array<{ tag: string; data: Buffer }> {
  const count = font.readUInt16BE(4);
  return Array.from({ length: count }, (_, i) => {
    const at = 12 + i * 16;
    return {
      tag: font.toString('latin1', at, at + 4),
      data: font.subarray(
        font.readUInt32BE(at + 8),
        font.readUInt32BE(at + 8) + font.readUInt32BE(at + 12),
      ),
    };
  });
}

/** Wraps an sfnt file as .woff (each table deflated when that makes it smaller). */
export function toWoff(font: Buffer): Buffer {
  const tables = tablesOf(font);
  let offset = 44 + tables.length * 20;
  const entries: Buffer[] = [];
  const bodies: Buffer[] = [];
  for (const { tag, data } of tables) {
    const packed = deflateSync(data);
    const stored = packed.length < data.length ? packed : data;
    entries.push(
      Buffer.concat([
        Buffer.from(tag, 'latin1'),
        u32(offset),
        u32(stored.length),
        u32(data.length),
        u32(0),
      ]),
    );
    bodies.push(pad4(stored));
    offset += pad4(stored).length;
  }
  const header = Buffer.concat([
    Buffer.from('wOFF', 'latin1'),
    font.subarray(0, 4),
    u32(offset),
    u16(tables.length),
    u16(0),
    u32(font.length),
    Buffer.alloc(24),
  ]);
  return Buffer.concat([header, ...entries, ...bodies]);
}

const WOFF2_KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post'];

/** Wraps an sfnt file (without glyf/loca) as .woff2: one brotli stream, no table transformed. */
export function toWoff2(font: Buffer): Buffer {
  const tables = tablesOf(font);
  const base128 = (value: number): Buffer => {
    const bytes = [value & 0x7f];
    for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift((rest & 0x7f) | 0x80);
    return Buffer.from(bytes);
  };
  const directory = Buffer.concat(
    tables.map(({ tag, data }) => {
      const known = WOFF2_KNOWN.indexOf(tag);
      return Buffer.concat([
        known >= 0
          ? Buffer.from([known])
          : Buffer.concat([Buffer.from([63]), Buffer.from(tag, 'latin1')]),
        base128(data.length),
      ]);
    }),
  );
  const stream = brotliCompressSync(Buffer.concat(tables.map(({ data }) => data)));
  const length = 48 + directory.length + stream.length;
  const header = Buffer.concat([
    Buffer.from('wOF2', 'latin1'),
    font.subarray(0, 4),
    u32(length),
    u16(tables.length),
    u16(0),
    u32(font.length),
    u32(stream.length),
    Buffer.alloc(24),
  ]);
  return Buffer.concat([header, directory, stream]);
}
