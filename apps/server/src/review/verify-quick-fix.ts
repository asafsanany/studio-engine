// The engine's checks after a quick fix run (quick fixes plan, section 2; QF2). The run told the model
// what it may touch and the permission rules enforce most of it, but a rule can miss a way (a
// `cp` onto a file, a program that opens a file itself), and the model's own word is not a check.
// So, with a listing of the job folder taken before the run and one after it:
//
//   1. reply.json is there and valid (`quickFixReplySchema`);
//   2. cut.mp4, every video and audio file and every file over 5 MB of edit/preview/ has the same
//      size and modified time as before (nothing of the media is touched, added or removed);
//   3. nothing outside edit/preview/, edit/project.md and the fix's own folder changed (what the
//      engine itself writes while a fix runs is ignored: voice notes, the phone's small preview
//      video, dot-named temporary files);
//   4. done: false → `escalated` with the run's why (the composition may have been touched: the fix
//      service puts its clone of edit/preview/ back for every outcome but `fixed`);
//   5. done: true → at least one composition file (HTML, CSS, JS, JSON, SVG) of edit/preview/ changed,
//      else `escalated` "nothing changed";
//   6. the engine's own `npx hyperframes lint` passes;
//   7. then `fixed` with the run's sentence.
//
// A broken rule (1–3, 6) is `failed`. Whatever the outcome, the two stills of the note's moment the run
// wrote (stills/before, stills/after) become before.png and after.png, and `hasCompare` says whether
// both exist.

import type { Dirent } from 'node:fs';
import { copyFile, lstat, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { trimMessage } from '../pipeline/failure.js';
import {
  FIX_PREVIEW_PATH,
  FIX_PROJECT_PATH,
  FIX_REPLY_FILE,
  FIX_STILLS,
  fixDirPath,
  type QuickFixReply,
  quickFixReplySchema,
  snapshotFileName,
} from './quick-fix-files.js';
import type { QuickFixOutcome } from './quick-fix-run.js';

/** What a check compares of a file: its size and modified time. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}

/** Every file of the job folder (forward-slash path relative to it → its stamp). Folders and symlinks are not files here. */
export type Listing = ReadonlyMap<string, FileStamp>;

/** Lists every file under `jobDir`; a folder that cannot be read has no files. Never throws. */
export async function listJobFolder(jobDir: string): Promise<Listing> {
  const listing = new Map<string, FileStamp>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), rel);
        } else if (entry.isFile()) {
          try {
            const info = await lstat(join(dir, entry.name));
            listing.set(rel, { size: info.size, mtimeMs: info.mtimeMs });
          } catch {
            // Gone since it was listed: not a file of this listing.
          }
        }
      }),
    );
  };
  await walk(jobDir, '');
  return listing;
}

/** A file over this many bytes in edit/preview/ is media whatever its name says (5 MB). */
export const BIG_FILE_BYTES = 5 * 1024 * 1024;

/** Video and audio files: `cut.mp4`, the clips, the music. A fix never touches, adds or removes one. */
const MEDIA_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'm4v',
  'webm',
  'mkv',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'flac',
]);

/** The files of the composition itself: what a fix is there to change. */
const COMPOSITION_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg']);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * What the engine, or a tool, writes to the job folder while a fix may be running: not the run's
 * doing. That includes the HyperFrames CLI's own state, which `snapshot` and `lint` keep inside the
 * project (`edit/preview/.hyperframes/`): a dot-named folder.
 */
function isEngineOwned(path: string): boolean {
  if (path.startsWith('edit/review/voice/')) return true;
  // The files made from the preview: the phone's small video, its poster and Export MP4. A request
  // can start one while a fix runs (QF3 only holds back a new Export MP4, not one under way).
  if (path === 'edit/preview-lite.mp4') return true;
  // Export MP4 of an extra format (C65) is `edit/review-export-1x1.mp4` beside the main one's.
  if (path === 'edit/poster.jpg' || /^edit\/review-export(-\d+x\d+)?\.mp4$/.test(path)) return true;
  // Temporary files and folders (`.x.tmp`, `.preview-<id>.tmp/`, `.DS_Store`): a dot-named segment.
  return path.split('/').some((part) => part.startsWith('.') && part !== '.');
}

export interface FileChange {
  path: string;
  kind: 'added' | 'modified' | 'removed';
}

/** The files that are new, gone or different (size or modified time) in `after` compared with `before`, sorted by path. */
export function listingChanges(before: Listing, after: Listing): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, stamp] of after) {
    const was = before.get(path);
    if (was === undefined) changes.push({ path, kind: 'added' });
    else if (was.size !== stamp.size || was.mtimeMs !== stamp.mtimeMs) {
      changes.push({ path, kind: 'modified' });
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, kind: 'removed' });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The first media rule a change breaks, or null: a file of edit/preview/ that is media (by its name, or by size before the run) and is not as it was. */
function mediaViolation(change: FileChange, before: Listing): string | null {
  if (!change.path.startsWith(`${FIX_PREVIEW_PATH}/`)) return null;
  const wasBig = (before.get(change.path)?.size ?? 0) > BIG_FILE_BYTES;
  const isMedia = MEDIA_EXTENSIONS.has(extensionOf(change.path)) || wasBig;
  if (!isMedia) return null;
  const name = change.path.slice(FIX_PREVIEW_PATH.length + 1);
  return `it ${change.kind === 'added' ? 'added' : change.kind === 'removed' ? 'removed' : 'changed'} ${name}, which it must not touch`;
}

/** Whether a change is to a file the fix may make: inside edit/preview/, edit/project.md or its own folder. */
function isAllowedPlace(path: string, fixId: string): boolean {
  return (
    path.startsWith(`${FIX_PREVIEW_PATH}/`) ||
    path === FIX_PROJECT_PATH ||
    path.startsWith(`${fixDirPath(fixId)}/`)
  );
}

/** The result of the engine's own lint of edit/preview/. */
export type LintResult = { ok: true } | { ok: false; why: string };

/** Lints the job's edit/preview/ (the default is `npx hyperframes lint`, lint-preview.ts). */
export type LintPreview = (jobDir: string, signal?: AbortSignal) => Promise<LintResult>;

export interface VerifyQuickFixInput {
  jobDir: string;
  fixId: string;
  /** The note's moment, for the file names of the stills. */
  atSec: number;
  /** `listJobFolder(jobDir)` taken before the run started. */
  before: Listing;
  /** The engine's lint of the composition. */
  lint: LintPreview;
  signal?: AbortSignal;
  /** Paths (relative to the job folder) that are not the run's doing and are left out of every check: tests, and files the fix service writes itself. */
  ignore?: (path: string) => boolean;
}

type Verdict = { status: 'fixed'; said: string } | { status: 'escalated' | 'failed'; why: string };

/** A short plain fragment for the line under the note, a few words: no trailing full stop. */
function why(text: string): string {
  return trimMessage(text.replace(/[.\s]+$/, ''), 160);
}

async function readReply(
  jobDir: string,
  fixId: string,
): Promise<{ ok: true; reply: QuickFixReply } | { ok: false; why: string }> {
  let text: string;
  try {
    text = await readFile(join(jobDir, fixDirPath(fixId), FIX_REPLY_FILE), 'utf8');
  } catch {
    return { ok: false, why: 'it finished without writing its answer' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, why: 'its answer was not readable' };
  }
  const parsed = quickFixReplySchema.safeParse(data);
  return parsed.success
    ? { ok: true, reply: parsed.data }
    : { ok: false, why: 'its answer was not in the right form' };
}

async function judge(input: VerifyQuickFixInput, after: Listing): Promise<Verdict> {
  const replied = await readReply(input.jobDir, input.fixId);
  if (!replied.ok) return { status: 'failed', why: replied.why };

  const changes = listingChanges(input.before, after).filter(
    (change) => !isEngineOwned(change.path) && input.ignore?.(change.path) !== true,
  );
  for (const change of changes) {
    const media = mediaViolation(change, input.before);
    if (media !== null) return { status: 'failed', why: why(media) };
  }
  for (const change of changes) {
    if (!isAllowedPlace(change.path, input.fixId)) {
      return { status: 'failed', why: why(`it changed ${change.path}, outside the composition`) };
    }
  }

  const { reply } = replied;
  if (!reply.done) return { status: 'escalated', why: why(reply.why) };

  const changed = changes.some(
    (change) =>
      change.path.startsWith(`${FIX_PREVIEW_PATH}/`) &&
      COMPOSITION_EXTENSIONS.has(extensionOf(change.path)),
  );
  if (!changed) return { status: 'escalated', why: 'nothing changed' };

  const lint = await input.lint(input.jobDir, input.signal);
  if (!lint.ok) return { status: 'failed', why: why(lint.why) };
  return { status: 'fixed', said: trimMessage(reply.said, 300) };
}

/** The still `hyperframes snapshot` wrote into `dir` for the note's moment, or the only PNG there; null when there is none. */
async function stillIn(dir: string, atSec: number): Promise<string | null> {
  const named = join(dir, snapshotFileName(atSec));
  try {
    if ((await stat(named)).isFile()) return named;
  } catch {
    // Not at the name the prompt expects: the only PNG in the folder is it.
  }
  try {
    const pngs = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.png'));
    return pngs.length === 1 ? join(dir, pngs[0] as string) : null;
  } catch {
    return null;
  }
}

async function nonEmpty(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Turns the two stills the run wrote into the fix's before.png and after.png, removes stills/, and
 * says whether both exist. Never throws.
 */
export async function collectCompareStills(
  jobDir: string,
  fixId: string,
  atSec: number,
): Promise<boolean> {
  const fixDir = join(jobDir, fixDirPath(fixId));
  for (const [name, folder] of [
    ['before.png', FIX_STILLS.before],
    ['after.png', FIX_STILLS.after],
  ] as const) {
    const still = await stillIn(join(fixDir, folder), atSec);
    if (still !== null) await copyFile(still, join(fixDir, name)).catch(() => undefined);
  }
  await rm(join(fixDir, 'stills'), { recursive: true, force: true }).catch(() => undefined);
  return (
    (await nonEmpty(join(fixDir, 'before.png'))) && (await nonEmpty(join(fixDir, 'after.png')))
  );
}

/** The engine's checks after a quick fix run, see the header: the outcome the run gets. */
export async function verifyQuickFix(input: VerifyQuickFixInput): Promise<QuickFixOutcome> {
  const after = await listJobFolder(input.jobDir);
  const verdict = await judge(input, after);
  const hasCompare = await collectCompareStills(input.jobDir, input.fixId, input.atSec);
  return verdict.status === 'fixed'
    ? { status: 'fixed', said: verdict.said, hasCompare }
    : { status: verdict.status, why: verdict.why, hasCompare };
}
