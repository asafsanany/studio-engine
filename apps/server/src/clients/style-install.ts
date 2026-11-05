// Putting a style run's work in place (Phase 2 plan §5, "Common to both"). The run wrote
// `_Style/style.md.new`; the engine checks it before anything changes:
//
//   it exists ─▶ it isn't empty ─▶ it starts with "# Style:" ─▶ the old style.md is copied to
//   `<dataDir>/clients/<clientId>/history/<version>.md` ─▶ style.md.new is renamed to style.md
//
// A check that fails leaves style.md as it was and removes the rejected file, so the next run
// starts clean; the reason becomes the client's error. The version and the state are the worker's.
//
// A series pass (Series plan §3) is put in place the same way: `_Series/<name>/series.md.new` must
// not be empty and must start with "# Series:", and the old series.md goes to the series' history
// (`installSeries`). Start a series also writes style.md.new; the worker checks both files
// (`checkNewStyle`, `checkNewSeries`) before it puts either in place, so a run that got one of
// them wrong changes neither.

import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  SERIES_FILE_NAME,
  SERIES_NEW_FILE_NAME,
  STYLE_FILE_NAME,
  STYLE_NEW_FILE_NAME,
} from './paths.js';
import { SERIES_STOPPED, STYLE_STOPPED } from './style-run.js';

/** The first line every style.md starts with. */
export const STYLE_TITLE_PREFIX = '# Style:';

export const STYLE_MISSING = `${STYLE_STOPPED} the run did not write ${STYLE_NEW_FILE_NAME}.`;
export const STYLE_EMPTY = `${STYLE_STOPPED} ${STYLE_NEW_FILE_NAME} is empty.`;
export const STYLE_BAD_TITLE = `${STYLE_STOPPED} ${STYLE_NEW_FILE_NAME} does not start with "${STYLE_TITLE_PREFIX}".`;

export interface InstallStyleOptions {
  /** The client's `_Style` folder. */
  styleDir: string;
  /** Where the replaced style.md goes: `historyFileFor(dataDir, clientId, version)`. */
  historyFile: string;
}

export type InstallOutcome = { ok: true } | { ok: false; error: string };

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Why `text` (style.md.new) can't be the style, or null when it can. */
export function newStyleProblem(text: string | null): string | null {
  if (text === null) return STYLE_MISSING;
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') return STYLE_EMPTY;
  if (!body.trimStart().startsWith(STYLE_TITLE_PREFIX)) return STYLE_BAD_TITLE;
  return null;
}

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** One of the two documents a run writes: what it is called, beside its new version, and its check. */
interface DocumentKind {
  fileName: string;
  newFileName: string;
  problem: (text: string | null) => string | null;
}

const STYLE_DOCUMENT: DocumentKind = {
  fileName: STYLE_FILE_NAME,
  newFileName: STYLE_NEW_FILE_NAME,
  problem: newStyleProblem,
};

/**
 * Why the new document in `folder` can't be put in place, or null when it can. A rejected file is
 * removed, so the next run starts clean.
 */
async function checkNew(folder: string, kind: DocumentKind): Promise<string | null> {
  const next = join(folder, kind.newFileName);
  const problem = kind.problem(await readIfThere(next));
  if (problem !== null) await rm(next, { recursive: true, force: true });
  return problem;
}

/** Keeps the current document of `folder` in `historyFile` (when there is one) and puts the new one in its place. */
async function putInPlace(folder: string, kind: DocumentKind, historyFile: string): Promise<void> {
  const current = join(folder, kind.fileName);
  if (await isFile(current)) {
    await mkdir(dirname(historyFile), { recursive: true });
    await copyFile(current, historyFile);
  }
  await rename(join(folder, kind.newFileName), current);
}

/** Why `_Style/style.md.new` can't be the style, or null when it can; a rejected file is removed. */
export function checkNewStyle(styleDir: string): Promise<string | null> {
  return checkNew(styleDir, STYLE_DOCUMENT);
}

/**
 * Puts a checked `_Style/style.md.new` in place (`checkNewStyle`), keeping the old style.md in
 * `historyFile`. Rejects when the file system fails.
 */
export function putStyleInPlace({ styleDir, historyFile }: InstallStyleOptions): Promise<void> {
  return putInPlace(styleDir, STYLE_DOCUMENT, historyFile);
}

/**
 * Checks `_Style/style.md.new` and, when it passes, keeps the old style.md in history and puts the
 * new one in its place. Rejects only when the file system fails (a folder that can't be written).
 */
export async function installStyle(options: InstallStyleOptions): Promise<InstallOutcome> {
  const problem = await checkNewStyle(options.styleDir);
  if (problem !== null) return { ok: false, error: problem };
  await putStyleInPlace(options);
  return { ok: true };
}

/** The first line every series.md starts with. */
export const SERIES_TITLE_PREFIX = '# Series:';

export const SERIES_MISSING = `${SERIES_STOPPED} the run did not write ${SERIES_NEW_FILE_NAME}.`;
export const SERIES_EMPTY = `${SERIES_STOPPED} ${SERIES_NEW_FILE_NAME} is empty.`;
export const SERIES_BAD_TITLE = `${SERIES_STOPPED} ${SERIES_NEW_FILE_NAME} does not start with "${SERIES_TITLE_PREFIX}".`;

/** Why `text` (series.md.new) can't be the series' format, or null when it can (like `newStyleProblem`). */
export function newSeriesProblem(text: string | null): string | null {
  if (text === null) return SERIES_MISSING;
  const body = text.replace(/^\uFEFF/, '');
  if (body.trim() === '') return SERIES_EMPTY;
  if (!body.trimStart().startsWith(SERIES_TITLE_PREFIX)) return SERIES_BAD_TITLE;
  return null;
}

const SERIES_DOCUMENT: DocumentKind = {
  fileName: SERIES_FILE_NAME,
  newFileName: SERIES_NEW_FILE_NAME,
  problem: newSeriesProblem,
};

export interface InstallSeriesOptions {
  /** The series folder, `<inbox>/<Client>/_Series/<name>`. */
  seriesDir: string;
  /** Where the replaced series.md goes: `seriesHistoryFileFor(dataDir, clientId, seriesId, version)`. */
  historyFile: string;
}

/** Why `series.md.new` can't be the series' format, or null when it can; a rejected file is removed. */
export function checkNewSeries(seriesDir: string): Promise<string | null> {
  return checkNew(seriesDir, SERIES_DOCUMENT);
}

/**
 * Puts a checked `series.md.new` in place (`checkNewSeries`), keeping the old series.md in
 * `historyFile`. Rejects when the file system fails.
 */
export function putSeriesInPlace({ seriesDir, historyFile }: InstallSeriesOptions): Promise<void> {
  return putInPlace(seriesDir, SERIES_DOCUMENT, historyFile);
}

/** Checks `series.md.new` and, when it passes, keeps the old series.md in history and puts the new one in place. */
export async function installSeries(options: InstallSeriesOptions): Promise<InstallOutcome> {
  const problem = await checkNewSeries(options.seriesDir);
  if (problem !== null) return { ok: false, error: problem };
  await putSeriesInPlace(options);
  return { ok: true };
}
