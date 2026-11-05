// A client's style history (Phase 2 plan §4) and Undo (§5, "Undo, retry and stills").
//
//   <dataDir>/clients/<clientId>/history/
//     <version>.md      the style.md that was at that version, kept when it was replaced
//     <version>-kit/    the kit that went with it, kept when a Learn pass, an Undo or Start a series
//                       replaced the kit (empty: that style had no kit). No folder: the kit did not
//                       change then
//     <version>.json    { "sourceJobId": "…" } when that style was learned from a job
//
// Undo puts the newest kept style back: the current style.md is kept first, like any style that
// is replaced, then `<newest>.md` becomes style.md and, when there is a `<newest>-kit/`, that kit
// replaces the current one (which is kept too). History is only ever added to, so a second Undo
// goes back to the style the first one replaced.
//
// A series keeps its history the same way (Series plan §2), apart from the style's:
//
//   <dataDir>/clients/<clientId>/series/<seriesId>/
//     history/<version>.md      the series.md that was at that version, kept when it was replaced
//     history/<version>-kit/    the kit that went with it, kept when a `series` pass replaced it
//     history/undone-<time>/    the whole series folder, as it was when Undo of its start took it
//     start.json                { "styleVersion": n | null }: the style version whose style.md
//                               Start a series replaced (null: it left the style alone), so its
//                               Undo knows which kept style to put back
//
// Undo of Start a series (§3), once it installed: the style kept at `styleVersion` comes back the
// way any Undo brings one back (`undoStyle`), with the kit the start took for the series, and the
// series folder goes to its history (`moveSeriesToHistory`). `_Series` goes too when nothing is
// left in it, so the client folder is as it was before the first series.
//
// When Start a series takes the style's kit for the series, the kit that kit replaced comes back
// (C23): the newest one kept below the current version (`newestKeptKit`), copied into `_Style/kit/`
// (`restoreHistoryKit`). History keeps it too, so nothing of it is lost, and the kit the start took
// goes to `history/<version>-kit/` (an empty one when there was none), so Undo of the start brings
// the style's kit back as it was.

import { constants } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDotName } from '../inbox/classify.js';
import {
  historyDirFor,
  historyFileFor,
  historyKitDirFor,
  historySourceFileFor,
  KIT_DIR_NAME,
  STYLE_FILE_NAME,
  seriesHistoryDirFor,
} from './paths.js';
import { moveFolder } from './style-kit.js';

/** A kept style.md: `<version>.md`. */
const HISTORY_FILE = /^(\d+)\.md$/;

/** A kept kit: `<version>-kit`. */
const HISTORY_KIT = /^(\d+)-kit$/;

/** What Undo writes style.md through, in the style folder (a dot file: the watcher never sees it). */
const UNDO_TEMP_NAME = '.style.md.undo';

/** What a kit put back from history is copied through, in the style folder (a dot folder). */
const RESTORE_KIT_TEMP_NAME = '.kit-restoring';

/** The lines under a style.md's `## Kit`, up to the next section. */
const KIT_SECTION = /^## Kit[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The newest version kept in the client's history, or null when nothing was ever kept. */
export async function newestHistoryVersion(
  dataDir: string,
  clientId: string,
): Promise<number | null> {
  let names: string[];
  try {
    names = await readdir(historyDirFor(dataDir, clientId));
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const name of names) {
    const match = HISTORY_FILE.exec(name);
    if (match === null) continue;
    const version = Number(match[1]);
    if (Number.isSafeInteger(version) && (newest === null || version > newest)) newest = version;
  }
  return newest;
}

/** The job the kept style at `version` was learned from, or null. */
export async function readHistorySource(
  dataDir: string,
  clientId: string,
  version: number,
): Promise<string | null> {
  try {
    const text = await readFile(historySourceFileFor(dataDir, clientId, version), 'utf8');
    const value: unknown = JSON.parse(text);
    const source =
      typeof value === 'object' && value !== null && 'sourceJobId' in value
        ? (value as { sourceJobId: unknown }).sourceJobId
        : null;
    return typeof source === 'string' && source !== '' ? source : null;
  } catch {
    return null;
  }
}

/** Records the job the style kept at `version` was learned from. Nothing for a style made from files. */
export async function writeHistorySource(
  dataDir: string,
  clientId: string,
  version: number,
  sourceJobId: string | null,
): Promise<void> {
  if (sourceJobId === null) return;
  const path = historySourceFileFor(dataDir, clientId, version);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ sourceJobId })}\n`);
}

export interface UndoStyleOptions {
  dataDir: string;
  clientId: string;
  /** The client's `_Style` folder. */
  styleDir: string;
  /** The kept version to put back (`newestHistoryVersion`). */
  restore: number;
  /** The version the current style.md and kit are kept under: above every kept one. */
  keepAs: number;
  /** The job the current style was learned from, kept with it. */
  sourceJobId: string | null;
}

/**
 * Puts the style kept at `restore` back in `_Style` (see the top of this file). Returns the job
 * that style was learned from, or null. Rejects when the file system fails; the style folder may
 * then hold the old style.md or the restored one, never a half-written file.
 */
export async function undoStyle(
  options: UndoStyleOptions,
): Promise<{ sourceJobId: string | null }> {
  const { dataDir, clientId, styleDir, restore, keepAs, sourceJobId } = options;
  const current = join(styleDir, STYLE_FILE_NAME);
  const kit = join(styleDir, KIT_DIR_NAME);

  // The current style is kept like any style that is replaced.
  if (await isFile(current)) {
    const kept = historyFileFor(dataDir, clientId, keepAs);
    await mkdir(dirname(kept), { recursive: true });
    await copyFile(current, kept);
    await writeHistorySource(dataDir, clientId, keepAs, sourceJobId);
  }

  // The kit, only when it changed after the restored style: then that style's kit comes back.
  const restoredKit = historyKitDirFor(dataDir, clientId, restore);
  if (await isDirectory(restoredKit)) {
    const keptKit = historyKitDirFor(dataDir, clientId, keepAs);
    if (await isDirectory(kit)) await moveFolder(kit, keptKit);
    else {
      await rm(kit, { recursive: true, force: true });
      await rm(keptKit, { recursive: true, force: true });
      await mkdir(keptKit, { recursive: true });
    }
    if ((await readdir(restoredKit)).length > 0) {
      await cp(restoredKit, kit, { recursive: true, mode: constants.COPYFILE_FICLONE });
    }
  }

  const temporary = join(styleDir, UNDO_TEMP_NAME);
  await copyFile(historyFileFor(dataDir, clientId, restore), temporary);
  await rename(temporary, current);
  return { sourceJobId: await readHistorySource(dataDir, clientId, restore) };
}

/** The lines under the `## Kit` of a style.md, trimmed, or null when it has none (or nothing in it). */
export function kitSectionLines(markdown: string): string | null {
  const lines = KIT_SECTION.exec(markdown)?.[1]?.replace(/\r/g, '').trim() ?? '';
  return lines === '' ? null : lines;
}

/** A kit kept in history, as Start a series puts it back (see the top of this file). */
export interface KeptKit {
  /** The version it went with: `history/<version>-kit/`. */
  version: number;
  /** What is at its top (dot files left out), sorted. None: that style had no kit. */
  names: string[];
  /** The job the style it went with was learned from, or null. */
  sourceJobId: string | null;
  /** The lines under that style's `## Kit`, or null when it had none (or is not kept). */
  section: string | null;
}

/**
 * The newest kit kept in the client's history below `below` (the current version): the kit the one
 * in place replaced. Null when no kit was kept below it.
 */
export async function newestKeptKit(
  dataDir: string,
  clientId: string,
  below: number,
): Promise<KeptKit | null> {
  let names: string[];
  try {
    names = await readdir(historyDirFor(dataDir, clientId));
  } catch {
    return null;
  }
  let version: number | null = null;
  for (const name of names) {
    const match = HISTORY_KIT.exec(name);
    if (match === null) continue;
    const kept = Number(match[1]);
    if (!Number.isSafeInteger(kept) || kept >= below || (version !== null && kept <= version)) {
      continue;
    }
    if (await isDirectory(historyKitDirFor(dataDir, clientId, kept))) version = kept;
  }
  if (version === null) return null;
  const entries = await readdir(historyKitDirFor(dataDir, clientId, version));
  const markdown = await readFile(historyFileFor(dataDir, clientId, version), 'utf8').catch(
    () => null,
  );
  return {
    version,
    names: entries.filter((name) => !isDotName(name)).sort(),
    sourceJobId: await readHistorySource(dataDir, clientId, version),
    section: markdown === null ? null : kitSectionLines(markdown),
  };
}

/**
 * Copies the kit kept at `version` into `_Style/kit/`, in place of whatever is there, through a
 * dot folder, so `kit/` is never half copied. History keeps its copy.
 */
export async function restoreHistoryKit(
  dataDir: string,
  clientId: string,
  version: number,
  styleDir: string,
): Promise<void> {
  const temporary = join(styleDir, RESTORE_KIT_TEMP_NAME);
  const kit = join(styleDir, KIT_DIR_NAME);
  await rm(temporary, { recursive: true, force: true });
  try {
    await cp(historyKitDirFor(dataDir, clientId, version), temporary, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await rm(kit, { recursive: true, force: true });
    await rename(temporary, kit);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** What Start a series did to the client's style (see the top of this file). */
export interface SeriesStartRecord {
  /** The style version whose style.md the start replaced (kept at `history/<n>.md`), or null. */
  styleVersion: number | null;
}

/** `<dataDir>/clients/<clientId>/series/<seriesId>/start.json`. */
export function seriesStartFileFor(dataDir: string, clientId: string, seriesId: string): string {
  return join(dirname(seriesHistoryDirFor(dataDir, clientId, seriesId)), 'start.json');
}

/** Records what Start a series did to the style, once it installed. */
export async function writeSeriesStart(
  dataDir: string,
  clientId: string,
  seriesId: string,
  record: SeriesStartRecord,
): Promise<void> {
  const path = seriesStartFileFor(dataDir, clientId, seriesId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record)}\n`);
}

/** What Start a series did to the style, or null when nothing was recorded (it never installed). */
export async function readSeriesStart(
  dataDir: string,
  clientId: string,
  seriesId: string,
): Promise<SeriesStartRecord | null> {
  try {
    const value: unknown = JSON.parse(
      await readFile(seriesStartFileFor(dataDir, clientId, seriesId), 'utf8'),
    );
    if (typeof value !== 'object' || value === null || !('styleVersion' in value)) return null;
    const { styleVersion } = value as { styleVersion: unknown };
    if (styleVersion === null) return { styleVersion: null };
    return typeof styleVersion === 'number' &&
      Number.isSafeInteger(styleVersion) &&
      styleVersion >= 0
      ? { styleVersion }
      : null;
  } catch {
    return null;
  }
}

/** Forgets what Start a series did (after its Undo). */
export async function removeSeriesStart(
  dataDir: string,
  clientId: string,
  seriesId: string,
): Promise<void> {
  await rm(seriesStartFileFor(dataDir, clientId, seriesId), { force: true });
}

/** Removes `_Series` (the series folder's parent) when nothing is left in it. */
async function removeEmptySeriesRoot(seriesDir: string): Promise<void> {
  const root = dirname(seriesDir);
  try {
    if ((await readdir(root)).length === 0) await rm(root, { recursive: true, force: true });
  } catch {
    // Not there, or not readable: nothing to tidy.
  }
}

/**
 * Takes a series folder away after Undo of its start, before anything of it was installed: what
 * is there (a folder a cancelled run made) is removed, and `_Series` with it when it is empty.
 */
export async function removeSeriesFolder(seriesDir: string): Promise<void> {
  await rm(seriesDir, { recursive: true, force: true });
  await removeEmptySeriesRoot(seriesDir);
}

export interface MoveSeriesOptions {
  dataDir: string;
  clientId: string;
  seriesId: string;
  /** The series folder, `<inbox>/<Client>/_Series/<name>`. */
  seriesDir: string;
  /** Now, for the name of the kept folder. */
  at: Date;
}

/**
 * Undo of an installed Start a series: the series folder goes whole to
 * `history/undone-<time>/`, and `_Series` goes when it is empty. Returns where it went, or null
 * when there was no folder.
 */
export async function moveSeriesToHistory(options: MoveSeriesOptions): Promise<string | null> {
  const { dataDir, clientId, seriesId, seriesDir, at } = options;
  if (!(await isDirectory(seriesDir))) {
    await removeEmptySeriesRoot(seriesDir);
    return null;
  }
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const target = join(seriesHistoryDirFor(dataDir, clientId, seriesId), `undone-${stamp}`);
  await moveFolder(seriesDir, target);
  await removeEmptySeriesRoot(seriesDir);
  return target;
}
