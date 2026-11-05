// Unpacking the zips of a job folder for the Brief step (Generated videos, GN4 · CVP-413).
//
// A client sends a references zip with the brief (photos of the equipment, a logo, a clip). While
// the Generate switch is on, the Brief step unpacks every `.zip` in the job folder into
// `edit/brief/unzipped/<zip name>/` before the Brief run, so the run reads the files inside like
// any other. Only `edit/` is written: the job folder stays read-only.
//
// The reader is plain Node (no library): it reads the zip's central directory, checks every entry
// BEFORE a byte is written, then streams each file through zlib into a staging folder that is
// renamed into place once whole. What it refuses (the whole zip, with a plain message, so a
// half-unpacked archive never passes for the client's references):
//   - a name that climbs out of the folder (`../x`), or an absolute one (`/x`, `C:\x`);
//   - a link or any file that is not a plain file or folder (zip entries can be symlinks);
//   - a password-protected entry, or a compression other than stored/deflate, or a zip64 archive;
//   - more than 500 files, or more than 200 MB once unpacked, counted over all the job's zips and
//     taken from the central directory first, then enforced again on the bytes actually written
//     (an entry that inflates past its declared size is a zip bomb and stops there).
// What it skips quietly: `__MACOSX/`, `.DS_Store`, `._*` and every other dot-name, and partial
// downloads: the same names the scanner never sees. They do not count toward the caps.
//
// Retry and Resume run this again. A zip whose central directory is unchanged and whose unpacked
// files are all still there is not unpacked a second time (a small marker, `.unzipped.json`, in
// its folder says what was unpacked and from which central directory). The CRC-32 of every entry,
// read from the central directory, is the "content" of the zip for the brief's fingerprint.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import { isIgnoredName } from '../inbox/classify.js';

/** Where the unpacked zips go, relative to the job folder: `edit/brief/unzipped/<zip name>/`. */
export const UNZIPPED_PATH = 'edit/brief/unzipped';

/** The most files (over all the job's zips) the Brief reads out of them. */
export const UNZIP_MAX_FILES = 500;
/** The most bytes (over all the job's zips) once unpacked: 200 MB. */
export const UNZIP_MAX_BYTES = 200_000_000;

/** The marker in each unpacked folder (a dot-name, so it is never one of the zip's files). */
const MARKER_NAME = '.unzipped.json';
const MARKER_VERSION = 1;

/** A zip with more entries than this (junk included) is not even read: it is far past the file cap. */
const MAX_ENTRIES_READ = 5_000;
/** A central directory bigger than this holds more entries than the cap above allows. */
const MAX_CENTRAL_BYTES = 8_000_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** A zip that cannot be unpacked. `message` is a plain sentence about "the zip “name”", no prefix. */
export class UnzipError extends Error {
  override readonly name = 'UnzipError';
}

/** One file of a zip, as the central directory gives it. */
interface ZipFile {
  /** The path inside the zip, cleaned: segments joined by `/`, no `.`/empty parts. */
  readonly path: string;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  /** The entry's own date (DOS time, read as local time); 0 when the entry has none. */
  readonly mtimeMs: number;
}

/** What reading a zip's central directory found. */
interface ZipIndex {
  readonly files: readonly ZipFile[];
  /** sha1 of the central directory: it changes when any name, size, CRC or offset does. */
  readonly digest: string;
  readonly fileSize: number;
}

/** A file unpacked from a zip. */
export interface UnpackedFile {
  /** Relative to the job folder: `edit/brief/unzipped/<zip name>/<path in the zip>`. */
  readonly relPath: string;
  readonly absPath: string;
  readonly size: number;
  /** The CRC-32 of its content, 8 hex digits, from the zip's central directory. */
  readonly crc: string;
  readonly mtimeMs: number;
  /** The zip it came from, relative to the job folder. */
  readonly fromZip: string;
}

export interface UnpackedArchives {
  /** The zips found in the job folder (relative paths), sorted. */
  readonly zips: readonly string[];
  /** Every file unpacked from them, sorted by `relPath`. */
  readonly files: readonly UnpackedFile[];
}

/** The part of a scanned file this module needs. */
export interface ArchiveCandidate {
  readonly relPath: string;
  readonly absPath: string;
}

/** True for a file called `*.zip`, in any case. */
export function isZipName(name: string): boolean {
  return extname(name).toLowerCase() === '.zip';
}

// --- reading the central directory ------------------------------------------------------------

function decodeName(raw: Buffer): string {
  const text = raw.toString('utf8');
  return text.includes('\ufffd') ? raw.toString('latin1') : text;
}

/** A DOS date and time (local time, two-second steps) as milliseconds since the epoch; 0 when unset. */
function dosToMs(date: number, time: number): number {
  if (date === 0) return 0;
  const year = 1980 + (date >> 9);
  const month = ((date >> 5) & 0xf) - 1;
  const day = date & 0x1f;
  const ms = new Date(
    year,
    month,
    day,
    time >> 11,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  ).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Tells apart the cases a name can fail on, so each gets its own plain sentence. */
type NameProblem = 'outside' | 'absolute' | 'bad';

/** The cleaned path of an entry name and whether it is a folder, or what is wrong with it. */
function cleanName(raw: string): { path: string; directory: boolean } | { problem: NameProblem } {
  const name = raw.replace(/\\/g, '/');
  if (name.includes('\0')) return { problem: 'bad' };
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return { problem: 'absolute' };
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return { problem: 'outside' };
  return { path: segments.join('/'), directory: name.endsWith('/') };
}

/** `__MACOSX/…`, `.DS_Store`, `._x`, any dot-name or partial download anywhere in the path. */
function isJunk(path: string): boolean {
  const segments = path.split('/');
  return segments[0] === '__MACOSX' || segments.some((segment) => isIgnoredName(segment));
}

const quote = (name: string): string => `“${name}”`;

/**
 * Reads and checks a zip's central directory. Throws {@link UnzipError} for everything the header
 * says is not allowed (see the top of the file). The caps over several zips are the caller's.
 */
async function readIndex(zipPath: string, zipName: string): Promise<ZipIndex> {
  const label = `the zip ${quote(zipName)}`;
  const damaged = new UnzipError(`${label} is damaged or isn’t a zip.`);
  const handle = await open(zipPath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const tailLength = Math.min(fileSize, EOCD_MIN + MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, fileSize - tailLength);

    let at = tailLength - EOCD_MIN;
    while (at >= 0 && tail.readUInt32LE(at) !== EOCD_SIGNATURE) at -= 1;
    if (at < 0) throw damaged;

    const total = tail.readUInt16LE(at + 10);
    const centralSize = tail.readUInt32LE(at + 12);
    const centralOffset = tail.readUInt32LE(at + 16);
    if (total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new UnzipError(`${label} is too big to open here (it needs the zip64 format).`);
    }
    if (total > MAX_ENTRIES_READ || centralSize > MAX_CENTRAL_BYTES) {
      throw new UnzipError(`${label} has too many files (${UNZIP_MAX_FILES} is the most).`);
    }
    if (centralOffset + centralSize > fileSize) throw damaged;

    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);

    const files: ZipFile[] = [];
    const seen = new Set<string>();
    let position = 0;
    for (let index = 0; index < total; index += 1) {
      if (position + 46 > central.length || central.readUInt32LE(position) !== CENTRAL_SIGNATURE) {
        throw damaged;
      }
      const madeBy = central.readUInt16LE(position + 4);
      const flags = central.readUInt16LE(position + 8);
      const method = central.readUInt16LE(position + 10);
      const time = central.readUInt16LE(position + 12);
      const date = central.readUInt16LE(position + 14);
      const crc = central.readUInt32LE(position + 16);
      const compressedSize = central.readUInt32LE(position + 20);
      const size = central.readUInt32LE(position + 24);
      const nameLength = central.readUInt16LE(position + 28);
      const extraLength = central.readUInt16LE(position + 30);
      const commentLength = central.readUInt16LE(position + 32);
      const attributes = central.readUInt32LE(position + 38);
      const localOffset = central.readUInt32LE(position + 42);
      const nameEnd = position + 46 + nameLength;
      if (nameEnd + extraLength + commentLength > central.length) throw damaged;
      const rawName = decodeName(central.subarray(position + 46, nameEnd));
      position = nameEnd + extraLength + commentLength;

      const cleaned = cleanName(rawName);
      if ('problem' in cleaned) {
        throw new UnzipError(
          cleaned.problem === 'outside'
            ? `${label} has a file that would land outside its folder (${quote(rawName)}).`
            : cleaned.problem === 'absolute'
              ? `${label} has a file with an absolute path (${quote(rawName)}).`
              : `${label} has a file with a name that can’t be used (${quote(rawName)}).`,
        );
      }

      // The type bits of a Unix entry (`madeBy` high byte 3): a link or a device is not a file.
      const mode = madeBy >> 8 === 3 ? (attributes >>> 16) & 0xf000 : 0;
      if (mode === 0xa000) {
        throw new UnzipError(
          `${label} has a link inside (${quote(rawName)}), which isn’t unpacked.`,
        );
      }
      if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) {
        throw new UnzipError(
          `${label} has something that isn’t a plain file (${quote(rawName)}), which isn’t unpacked.`,
        );
      }

      if (cleaned.directory || cleaned.path === '' || isJunk(cleaned.path)) continue;

      if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
        throw new UnzipError(`${label} is password protected.`);
      }
      if (method !== 0 && method !== 8) {
        throw new UnzipError(
          `${label} uses a compression this app can’t unpack (${quote(cleaned.path)}).`,
        );
      }
      if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
        throw new UnzipError(
          `${label} is bigger than ${UNZIP_MAX_BYTES / 1_000_000} MB once unpacked (${UNZIP_MAX_BYTES / 1_000_000} MB is the most).`,
        );
      }
      // Two entries that land on one file (a case-insensitive disk makes `A.jpg` and `a.jpg` one).
      const key = cleaned.path.normalize('NFC').toLowerCase();
      if (seen.has(key))
        throw new UnzipError(`${label} has the file ${quote(cleaned.path)} twice.`);
      seen.add(key);

      files.push({
        path: cleaned.path,
        method,
        crc,
        compressedSize,
        size,
        localOffset,
        mtimeMs: dosToMs(date, time),
      });
    }
    return { files, digest: createHash('sha1').update(central).digest('hex'), fileSize };
  } finally {
    await handle.close();
  }
}

// --- unpacking ---------------------------------------------------------------------------------

/** Passes bytes through while counting them against the entry's declared size and CRC-32. */
function verify(file: ZipFile, damaged: UnzipError): Transform {
  let bytes = 0;
  let crc = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      // An entry that inflates past what it declared is a zip bomb: stop at the first byte over.
      if (bytes > file.size) return done(damaged);
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
    flush(done) {
      done(bytes !== file.size || crc !== file.crc ? damaged : null);
    },
  });
}

/** Writes one entry into `target`. The caller has made sure `target` is inside the staging folder. */
async function extractFile(
  zipPath: string,
  fileSize: number,
  file: ZipFile,
  target: string,
  damaged: UnzipError,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  if (file.size === 0) {
    await writeFile(target, '', { flag: 'wx' });
    return;
  }

  const handle = await open(zipPath, 'r');
  let start: number;
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, file.localOffset);
    if (bytesRead < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw damaged;
    start = file.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  if (file.compressedSize === 0 || start + file.compressedSize > fileSize) throw damaged;
  if (file.method === 0 && file.compressedSize !== file.size) throw damaged;

  try {
    await pipeline(
      createReadStream(zipPath, { start, end: start + file.compressedSize - 1 }),
      file.method === 8 ? createInflateRaw() : new PassThrough(),
      verify(file, damaged),
      createWriteStream(target, { flags: 'wx' }),
    );
  } catch (error) {
    // zlib says "invalid stored block lengths" and the like for a damaged entry.
    throw error instanceof UnzipError ? error : damaged;
  }
  if (file.mtimeMs > 0) {
    const when = new Date(file.mtimeMs);
    await utimes(target, when, when);
  }
}

interface Marker {
  readonly version: typeof MARKER_VERSION;
  /** The zip this folder was unpacked from, relative to the job folder. */
  readonly zip: string;
  /** The central-directory digest it was unpacked from. */
  readonly digest: string;
  readonly files: readonly { path: string; size: number; crc: string; mtimeMs: number }[];
}

const hex = (crc: number): string => crc.toString(16).padStart(8, '0');

async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MARKER_NAME), 'utf8')) as Marker;
    return parsed.version === MARKER_VERSION && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every file the marker lists is still there with its size. */
async function isIntact(dir: string, marker: Marker): Promise<boolean> {
  for (const file of marker.files) {
    try {
      if ((await stat(join(dir, ...file.path.split('/')))).size !== file.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** `Chat refs.zip` → `Chat refs`; the folder's name for a zip, never empty and never a dot-name. */
function folderNameOf(zipRelPath: string): string {
  const name = basename(zipRelPath, extname(zipRelPath)).trim();
  if (name === '') return 'archive';
  return name.startsWith('.') ? `_${name}` : name;
}

/**
 * Unpacks every zip of the job folder into `edit/brief/unzipped/<zip name>/` and answers the files
 * that came out, each with the zip it came from. `candidates` are the files the scanner lists
 * (those called `*.zip` are the zips). Throws {@link UnzipError} (a plain message about the zip) for a
 * zip that is refused; nothing of that zip is left half-written.
 *
 * Idempotent: a zip already unpacked from the same central directory is read from its marker and
 * left as it is. Folders of zips that are gone are removed. A job without a zip gets no folder.
 */
export async function unpackJobArchives(
  jobDir: string,
  candidates: readonly ArchiveCandidate[],
): Promise<UnpackedArchives> {
  const root = join(jobDir, UNZIPPED_PATH);
  const zips = candidates
    .filter((candidate) => isZipName(candidate.relPath))
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  if (zips.length === 0) {
    await rm(root, { recursive: true, force: true });
    return { zips: [], files: [] };
  }

  // 1. Read and check every central directory, and the caps over all of them, before writing.
  const indexed: { zip: ArchiveCandidate; name: string; index: ZipIndex; folder: string }[] = [];
  const taken = new Set<string>();
  let count = 0;
  let bytes = 0;
  for (const zip of zips) {
    const name = basename(zip.relPath);
    const index = await readIndex(zip.absPath, name).catch((error: unknown) => {
      if (error instanceof UnzipError) throw error;
      throw new UnzipError(`the zip ${quote(name)} couldn’t be read.`);
    });
    count += index.files.length;
    bytes += index.files.reduce((sum, file) => sum + file.size, 0);
    const lone = zips.length === 1;
    if (count > UNZIP_MAX_FILES) {
      throw new UnzipError(
        `${lone ? `the zip ${quote(name)} has` : 'the zips in this folder have'} more than ${UNZIP_MAX_FILES} files${lone ? '' : ' together'} (${UNZIP_MAX_FILES} is the most).`,
      );
    }
    if (bytes > UNZIP_MAX_BYTES) {
      throw new UnzipError(
        `${lone ? `the zip ${quote(name)} is` : 'the zips in this folder are'} bigger than ${UNZIP_MAX_BYTES / 1_000_000} MB once unpacked${lone ? '' : ' together'} (${UNZIP_MAX_BYTES / 1_000_000} MB is the most).`,
      );
    }
    // Two zips with one name (`a.zip` in two folders) get `a`, `a 2`.
    let folder = folderNameOf(zip.relPath);
    for (let n = 2; taken.has(folder.normalize('NFC').toLowerCase()); n += 1) {
      folder = `${folderNameOf(zip.relPath)} ${n}`;
    }
    taken.add(folder.normalize('NFC').toLowerCase());
    indexed.push({ zip, name, index, folder });
  }

  // 2. Folders of zips that are gone (and staging left by a stopped run) go.
  await mkdir(root, { recursive: true });
  const wanted = new Set(indexed.map((entry) => entry.folder));
  for (const existing of await readdir(root)) {
    if (!wanted.has(existing)) await rm(join(root, existing), { recursive: true, force: true });
  }

  // 3. Unpack each zip that is not unpacked yet, into staging, then rename it into place.
  const files: UnpackedFile[] = [];
  for (const { zip, name, index, folder } of indexed) {
    const target = join(root, folder);
    const marker = await readMarker(target);
    let kept: Marker | null =
      marker !== null &&
      marker.zip === zip.relPath &&
      marker.digest === index.digest &&
      (await isIntact(target, marker))
        ? marker
        : null;

    if (kept === null) {
      const staging = join(root, `.${folder}.unzipping`);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      const damaged = new UnzipError(`the zip ${quote(name)} is damaged.`);
      try {
        for (const file of index.files) {
          const destination = resolve(staging, ...file.path.split('/'));
          // The names were cleaned already; this is the second lock.
          if (!destination.startsWith(`${resolve(staging)}${sep}`)) {
            throw new UnzipError(
              `the zip ${quote(name)} has a file that would land outside its folder (${quote(file.path)}).`,
            );
          }
          await extractFile(zip.absPath, index.fileSize, file, destination, damaged);
        }
        kept = {
          version: MARKER_VERSION,
          zip: zip.relPath,
          digest: index.digest,
          files: index.files.map((file) => ({
            path: file.path,
            size: file.size,
            crc: hex(file.crc),
            mtimeMs: file.mtimeMs,
          })),
        };
        await writeFile(join(staging, MARKER_NAME), `${JSON.stringify(kept)}\n`);
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof UnzipError) throw error;
        throw new UnzipError(`the zip ${quote(name)} couldn’t be unpacked.`);
      }
    }

    for (const file of kept.files) {
      const relPath = `${UNZIPPED_PATH}/${folder}/${file.path}`;
      files.push({
        relPath,
        absPath: join(jobDir, ...relPath.split('/')),
        size: file.size,
        crc: file.crc,
        mtimeMs: file.mtimeMs > 0 ? file.mtimeMs : (await stat(zip.absPath)).mtimeMs,
        fromZip: zip.relPath,
      });
    }
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { zips: zips.map((zip) => zip.relPath), files };
}
