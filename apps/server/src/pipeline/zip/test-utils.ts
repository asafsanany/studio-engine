// A tiny zip writer for the tests of the Brief step's unpacking (GN4). It can make the archives
// the real tools refuse to: `../x` names, absolute paths, symlinks, junk entries, an entry that
// claims to be small and inflates big. Not part of the server build (see tsconfig.build.json).

import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  /** The name exactly as it goes in the zip (a trailing `/` makes a folder). */
  name: string;
  data?: Buffer | string;
  /** Default `deflate`; empty data and folders are stored. */
  method?: 'store' | 'deflate';
  /** The Unix mode (type and permissions) in the external attributes, e.g. 0o120755 for a link. Default 0o100644. */
  mode?: number;
  /** The general-purpose flags, e.g. 1 for "encrypted". */
  flags?: number;
  /** The entry's date; default 2026-10-25 12:52. */
  date?: Date;
  /** What the headers CLAIM the uncompressed size is (a zip bomb says less than the truth). */
  claimedSize?: number;
  /** Replaces the compression method number in the headers (e.g. 99 for AES). */
  methodNumber?: number;
}

const u16 = (value: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
};
const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
};

function dos(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function buildZip(entries: readonly ZipEntrySpec[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const folder = entry.name.endsWith('/');
    const raw = Buffer.from(entry.data ?? '');
    const stored = folder || raw.length === 0 || entry.method === 'store';
    const body = stored ? raw : deflateRawSync(raw);
    const method = entry.methodNumber ?? (stored ? 0 : 8);
    const when = dos(entry.date ?? new Date(2026, 9, 25, 12, 52, 0));
    const flags = (entry.flags ?? 0) | 0x800; // names are UTF-8
    const size = entry.claimedSize ?? raw.length;
    const crc = raw.length === 0 ? 0 : crc32(raw);
    const mode = entry.mode ?? (folder ? 0o040755 : 0o100644);

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(when.time),
      u16(when.date),
      u32(crc),
      u32(body.length),
      u32(size),
      u16(name.length),
      u16(0),
      name,
      body,
    ]);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16((3 << 8) | 20), // made by Unix
        u16(20),
        u16(flags),
        u16(method),
        u16(when.time),
        u16(when.date),
        u32(crc),
        u32(body.length),
        u32(size),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(mode * 0x10000),
        u32(offset),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const note = Buffer.from(comment);
  return Buffer.concat([
    ...locals,
    central,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(note.length),
    note,
  ]);
}
