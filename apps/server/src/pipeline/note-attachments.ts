// The pictures attached to a job's note (Songs, SG5): a screenshot of a reel that the owner pastes,
// drops or chooses in "Note for the editor" (the phone's Add photo, SG6, uses the same routes). They
// are kept in the job folder, in edit/brief/from-you/ (`NOTE_ATTACHMENTS.dir`, next to
// edit/brief/transcripts/), where the Brief run reads them: the Brief step lists them with the
// job's files and counts them in its fingerprint (brief-step.ts).
//
// This file is the folder's rules and nothing else (routes/note-attachments.ts is the HTTP half):
//
//   - a name is kept as it came, made safe: one plain file name, no folders, no control characters,
//     no leading dot, with one of the allowed extensions; a name that is taken gets " 2", " 3" …
//     before its extension ("IMG_4412.PNG", "IMG_4412 2.PNG"), so two pastes both called
//     "image.png" are both kept;
//   - at most `maxFiles` pictures, each at most `maxBytes`, of the allowed types;
//   - a picture is written next to its place and linked into it, so a reader (the listing, the
//     Brief run) never sees half of one, and two uploads at once never take the same name or pass
//     the limit together (one job's changes go one after the other).
//
//   - a HEIC (a phone's Photos or Files app can hand one over) is kept as a JPEG: the Brief run reads
//     pictures with Claude's Read tool, which does not take HEIC (heic-to-jpeg.ts). The kept name
//     says so ("IMG_4412.HEIC" is kept as "IMG_4412.jpg").
//
// Dot files in the folder (an upload on its way is `.upload-….tmp`, `.upload-….heic`, `.upload-….jpg`)
// are not pictures: they are never listed.

import { randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { link, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isNoteAttachmentName,
  NOTE_ATTACHMENTS,
  type NoteAttachment,
  noteAttachmentType,
} from '@studio/shared';
import type { HeicToJpeg } from './heic-to-jpeg.js';

/** The words of every refusal. The routes answer them with the status of the error that carries them. */
export const NOTE_ATTACHMENT_MESSAGES = {
  form: 'Send the picture as multipart/form-data, in the field “file”.',
  type: 'Only a picture can be attached: PNG, JPG, HEIC, WEBP or GIF.',
  empty: 'That picture is empty.',
  tooBig: `That picture is over ${NOTE_ATTACHMENTS.maxBytes / (1024 * 1024)} MB.`,
  tooMany: `A note takes at most ${NOTE_ATTACHMENTS.maxFiles} pictures.`,
  /** A HEIC that could not be turned into a JPEG (not a picture after all, or the converter failed). */
  unreadable: 'That picture couldn’t be read. Try a screenshot saved as PNG or JPG.',
  missing: 'There is no such picture on this note.',
} as const;

/** A refusal the routes turn into its status and `{ error }`. */
export class NoteAttachmentError extends Error {
  readonly status: 400 | 404;

  constructor(status: 400 | 404, message: string) {
    super(message);
    this.name = 'NoteAttachmentError';
    this.status = status;
  }
}

/** A picture kept in the folder, as the Brief step and the routes read it. */
export interface StoredNoteAttachment extends NoteAttachment {
  absPath: string;
  /** The file's modification time in ms, the fingerprint's number. */
  mtimeMs: number;
}

/** Where a job's pictures are: `<jobDir>/edit/brief/from-you`. */
export function noteAttachmentsDir(jobDir: string): string {
  return join(jobDir, 'edit', NOTE_ATTACHMENTS.dir);
}

/** The path of a picture inside the job folder, with forward slashes (the Brief's `relPath`). */
export function noteAttachmentRelPath(name: string): string {
  return `edit/${NOTE_ATTACHMENTS.dir}/${name}`;
}

const NAME_MAX_CHARS = 200;

/**
 * `raw` as a file name that can be kept: the last part of a path (either slash), control characters
 * and runs of blanks turned into one space, no leading dots, trimmed, and not longer than 200
 * characters (the stem is cut, the extension stays). `null` when what is left is not a note
 * attachment name (no allowed extension, nothing before it).
 */
export function cleanNoteAttachmentName(raw: string): string | null {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const spaced = last
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what goes
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trim();
  const dot = spaced.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = spaced.slice(dot);
  const stem = spaced
    .slice(0, dot)
    .slice(0, NAME_MAX_CHARS - extension.length)
    .trim();
  const name = `${stem}${extension}`;
  return stem === '' || !isNoteAttachmentName(name) ? null : name;
}

/** `IMG_4412.PNG` taken: `IMG_4412 2.PNG`, then `IMG_4412 3.PNG`. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf('.');
  return `${name.slice(0, dot)} ${n}${name.slice(dot)}`;
}

/** Whether an error is the file system saying the file (or folder) is not there. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The pictures of a job, oldest first (then by name). Nothing for a job that has none or whose
 * folder is not there. Anything that is not a plain picture file is left out.
 */
export async function listNoteAttachments(jobDir: string): Promise<StoredNoteAttachment[]> {
  const dir = noteAttachmentsDir(jobDir);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const found: StoredNoteAttachment[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isNoteAttachmentName(entry.name)) continue;
    const absPath = join(dir, entry.name);
    let info: Stats;
    try {
      info = await stat(absPath);
    } catch (error) {
      if (isMissing(error)) continue; // removed while we looked
      throw error;
    }
    found.push({
      name: entry.name,
      bytes: info.size,
      addedAt: new Date(info.mtimeMs).toISOString(),
      absPath,
      mtimeMs: info.mtimeMs,
    });
  }
  return found.sort((a, b) =>
    a.mtimeMs !== b.mtimeMs
      ? a.mtimeMs - b.mtimeMs
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0,
  );
}

/** What the routes show of a stored picture. */
export function noteAttachmentOf({ name, bytes, addedAt }: StoredNoteAttachment): NoteAttachment {
  return { name, bytes, addedAt };
}

// One job's changes go one after the other: the count of pictures and the names taken are read
// and used in the same turn.
const queues = new Map<string, Promise<unknown>>();

function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

export interface SaveNoteAttachment {
  /** The name the picture came with (the browser's), kept as far as it is safe. */
  name: string;
  bytes: Uint8Array;
}

export interface SaveNoteAttachmentOptions {
  /**
   * Turns a HEIC into a JPEG, which is then what is kept (under the same name with `.jpg`). Left
   * out, a HEIC is kept as it came (the real engine passes `sipsHeicToJpeg`).
   */
  heicToJpeg?: HeicToJpeg;
}

/** `IMG_4412.HEIC` as the name of its JPEG: `IMG_4412.jpg`. */
export function jpegNameOf(name: string): string {
  return `${name.slice(0, name.lastIndexOf('.'))}.jpg`;
}

/**
 * The JPEG made from a HEIC's bytes. Both files live in the picture folder as dot files (so no
 * listing ever shows them, and nothing is written outside the job) and are gone when it is done.
 * Throws a `NoteAttachmentError` (400) when the converter cannot read it, or when the JPEG is over
 * the size limit.
 */
async function heicBytesAsJpeg(
  dir: string,
  bytes: Uint8Array,
  convert: HeicToJpeg,
): Promise<Uint8Array> {
  const stem = join(dir, `.upload-${randomUUID()}`);
  const source = `${stem}.heic`;
  const target = `${stem}.jpg`;
  try {
    await writeFile(source, bytes);
    await convert(source, target);
    const jpeg = await readFile(target);
    if (jpeg.byteLength === 0) {
      throw new NoteAttachmentError(400, NOTE_ATTACHMENT_MESSAGES.unreadable);
    }
    if (jpeg.byteLength > NOTE_ATTACHMENTS.maxBytes) {
      throw new NoteAttachmentError(400, NOTE_ATTACHMENT_MESSAGES.tooBig);
    }
    return jpeg;
  } catch (error) {
    if (error instanceof NoteAttachmentError) throw error;
    throw new NoteAttachmentError(400, NOTE_ATTACHMENT_MESSAGES.unreadable);
  } finally {
    await Promise.all([unlink(source), unlink(target)].map((gone) => gone.catch(() => undefined)));
  }
}

/**
 * Keeps a picture in the job's folder and answers it as kept (its name may have a number in it, or
 * `.jpg` for a HEIC that was converted). Throws a `NoteAttachmentError` (400): a name without an
 * allowed extension, an empty or too big picture, a HEIC that cannot be read, or a note that has
 * all `maxFiles` pictures already. Nothing is kept then.
 */
export function saveNoteAttachment(
  jobDir: string,
  { name, bytes }: SaveNoteAttachment,
  { heicToJpeg }: SaveNoteAttachmentOptions = {},
): Promise<NoteAttachment> {
  const clean = cleanNoteAttachmentName(name);
  if (clean === null) {
    return Promise.reject(new NoteAttachmentError(400, NOTE_ATTACHMENT_MESSAGES.type));
  }
  if (bytes.byteLength === 0) {
    return Promise.reject(new NoteAttachmentError(400, NOTE_ATTACHMENT_MESSAGES.empty));
  }
  if (bytes.byteLength > NOTE_ATTACHMENTS.maxBytes) {
    return Promise.reject(new NoteAttachmentError(400, NOTE_ATTACHMENT_MESSAGES.tooBig));
  }

  return inTurn(jobDir, async () => {
    const taken = await listNoteAttachments(jobDir);
    if (taken.length >= NOTE_ATTACHMENTS.maxFiles) {
      throw new NoteAttachmentError(400, NOTE_ATTACHMENT_MESSAGES.tooMany);
    }
    const dir = noteAttachmentsDir(jobDir);
    await mkdir(dir, { recursive: true });

    let keptName = clean;
    let keptBytes = bytes;
    if (heicToJpeg !== undefined && noteAttachmentType(clean) === 'heic') {
      keptBytes = await heicBytesAsJpeg(dir, bytes, heicToJpeg);
      keptName = jpegNameOf(clean);
    }

    // Written whole next to its place, then linked into it: `link` refuses a name that is taken
    // (the volume ignores case, so IMG.PNG and img.png are one name), and then the next number is
    // tried.
    const partial = join(dir, `.upload-${randomUUID()}.tmp`);
    await writeFile(partial, keptBytes);
    try {
      const used = new Set(taken.map((picture) => picture.name.toLowerCase()));
      for (let n = 1; ; n += 1) {
        const candidate = numberedName(keptName, n);
        if (used.has(candidate.toLowerCase())) continue;
        try {
          await link(partial, join(dir, candidate));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        const info = await stat(join(dir, candidate));
        return {
          name: candidate,
          bytes: info.size,
          addedAt: new Date(info.mtimeMs).toISOString(),
        };
      }
    } finally {
      await unlink(partial).catch(() => undefined);
    }
  });
}

/**
 * Takes a picture off the note. Throws a `NoteAttachmentError` (404) for a name that is not one of
 * the job's pictures.
 */
export function deleteNoteAttachment(jobDir: string, name: string): Promise<void> {
  return inTurn(jobDir, async () => {
    if (!isNoteAttachmentName(name)) {
      throw new NoteAttachmentError(404, NOTE_ATTACHMENT_MESSAGES.missing);
    }
    const kept = (await listNoteAttachments(jobDir)).find((picture) => picture.name === name);
    if (kept === undefined) throw new NoteAttachmentError(404, NOTE_ATTACHMENT_MESSAGES.missing);
    try {
      await unlink(kept.absPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      throw new NoteAttachmentError(404, NOTE_ATTACHMENT_MESSAGES.missing);
    }
  });
}

/** The path of a picture of the job, or `null` when the job has no picture of that name. */
export async function noteAttachmentPath(jobDir: string, name: string): Promise<string | null> {
  if (!isNoteAttachmentName(name)) return null;
  const kept = (await listNoteAttachments(jobDir)).find((picture) => picture.name === name);
  return kept?.absPath ?? null;
}
