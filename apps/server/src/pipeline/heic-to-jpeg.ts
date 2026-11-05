// HEIC to JPEG for the pictures attached to a note (Songs, SG6). A phone's Photos or Files app can
// hand over a HEIC (Safari turns most into JPEG on the way, but a file picked from Files stays
// HEIC), and the Brief run reads pictures through Claude's Read tool, which takes PNG, JPG, GIF and
// WEBP but not HEIC. So a HEIC is turned into a JPEG when it is attached, with the Mac's own `sips`,
// and the JPEG is what is kept (and listed, and shown as a thumbnail).
//
// This file is the converter only. The folder's rules (the name, the limits, where the temporary
// files go) are pipeline/note-attachments.ts's.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';

/**
 * Writes `to` (a JPEG) from `from` (a HEIC). Rejects when it cannot: a file that is not a picture,
 * a converter that is not there, or one that finished without writing anything. Both paths are
 * files the caller owns; nothing else is touched.
 */
export type HeicToJpeg = (from: string, to: string) => Promise<void>;

/** A phone photo is a few MB; sips does it in well under a second. This only stops a stuck one. */
export const SIPS_TIMEOUT_MS = 30_000;

/**
 * `sips -s format jpeg <from> --out <to>`: macOS's own image tool (always on the Mac the engine runs
 * on). It reads by content, not by the file's extension. It exits 0 with a warning for a path that
 * is not there, so the result is checked to exist and not be empty.
 */
export const sipsHeicToJpeg: HeicToJpeg = async (from, to) => {
  await new Promise<void>((resolve, reject) => {
    execFile(
      'sips',
      ['-s', 'format', 'jpeg', from, '--out', to],
      { timeout: SIPS_TIMEOUT_MS },
      (error) => (error === null ? resolve() : reject(error)),
    );
  });
  const info = await stat(to);
  if (info.size === 0) throw new Error('sips wrote an empty file');
};
