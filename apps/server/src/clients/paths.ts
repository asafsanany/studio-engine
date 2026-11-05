// Where a client's style and its series live on disk (Phase 2 plan §4, Series plan §2):
//
//   <inbox>/<Client>/_Style/              style.md, the files it was made from, kit/
//   <dataDir>/clients/<clientId>/history/ the style.md files it replaced, and their kits
//   <dataDir>/instagram/photos/<clientId>.jpg  its Instagram profile picture
//   <logsDir>/clients/<clientId>.log      what the style runs (and the series passes) printed
//   <inbox>/<Client>/_Series/<name>/      a series: series.md, kit/ and its review-note files
//   <inbox>/<Client>/_Shared/             files every job of the client can use (logo, b-roll)
//   <dataDir>/clients/<clientId>/series/<seriesId>/history/
//                                         the series.md files it replaced, and their kits
//
// The roots come in as arguments (`Config.inboxPath`, `Config.dataDir`, `Config.logsDir`), so tests
// point them at temp folders. Nothing here touches the file system.

import { join } from 'node:path';
import { SERIES_DIR_NAME, SHARED_DIR_NAME, STYLE_DIR_NAME } from '../inbox/classify.js';

/** The style document inside the style folder. */
export const STYLE_FILE_NAME = 'style.md';

/** What a style run writes next to style.md; the engine checks it and renames it (plan §5). */
export const STYLE_NEW_FILE_NAME = 'style.md.new';

/** The graphics a Learn pass keeps, inside the style folder. */
export const KIT_DIR_NAME = 'kit';

/** The client's folder, `<inbox>/<Client>`: what Show in Finder opens. */
export function clientDirFor(inboxPath: string, client: string): string {
  return join(inboxPath, client);
}

/** The client's style folder, `<inbox>/<Client>/_Style`. */
export function styleDirFor(inboxPath: string, client: string): string {
  return join(clientDirFor(inboxPath, client), STYLE_DIR_NAME);
}

/** The client's shared files, `<inbox>/<Client>/_Shared`: copied into each job's edit/shared/. */
export function sharedDirFor(inboxPath: string, client: string): string {
  return join(clientDirFor(inboxPath, client), SHARED_DIR_NAME);
}

/** The client's `style.md`, `<inbox>/<Client>/_Style/style.md`. */
export function styleFileFor(inboxPath: string, client: string): string {
  return join(styleDirFor(inboxPath, client), STYLE_FILE_NAME);
}

/** Where a replaced `style.md` is kept: `<dataDir>/clients/<clientId>/history`. */
export function historyDirFor(dataDir: string, clientId: string): string {
  return join(dataDir, 'clients', clientId, 'history');
}

/** The copy kept of the `style.md` that was at `version`: `history/<version>.md`. */
export function historyFileFor(dataDir: string, clientId: string, version: number): string {
  return join(historyDirFor(dataDir, clientId), `${version}.md`);
}

/**
 * The kit that went with the `style.md` at `version`, kept when a Learn pass or an Undo replaced
 * the kit: `history/<version>-kit/`. Empty when that style had no kit.
 */
export function historyKitDirFor(dataDir: string, clientId: string, version: number): string {
  return join(historyDirFor(dataDir, clientId), `${version}-kit`);
}

/** The job the `style.md` at `version` was learned from, when it was: `history/<version>.json`. */
export function historySourceFileFor(dataDir: string, clientId: string, version: number): string {
  return join(historyDirFor(dataDir, clientId), `${version}.json`);
}

/** The client's kit, `<inbox>/<Client>/_Style/kit`: the graphics a Learn pass copied. */
export function kitDirFor(inboxPath: string, client: string): string {
  return join(styleDirFor(inboxPath, client), KIT_DIR_NAME);
}

/** A job's folder, `<inbox>/<Client>/<Job>`: where a Learn pass runs. */
export function jobDirFor(inboxPath: string, client: string, job: string): string {
  return join(clientDirFor(inboxPath, client), job);
}

/** Where the Instagram profile pictures are, `<dataDir>/instagram/photos`. */
export function instagramPhotosDirFor(dataDir: string): string {
  return join(dataDir, 'instagram', 'photos');
}

/**
 * The client's Instagram profile picture, `<dataDir>/instagram/photos/<clientId>.jpg`. Instagram's
 * picture links expire, so a scan saves the file and the engine serves it. It moves with a renamed
 * client and goes with a deleted one.
 */
export function instagramPhotoFor(dataDir: string, clientId: string): string {
  return join(instagramPhotosDirFor(dataDir), `${clientId}.jpg`);
}

/** The log of a client's style runs, `<logsDir>/clients/<clientId>.log`. */
export function clientLogPath(logsDir: string, clientId: string): string {
  return join(logsDir, 'clients', `${clientId}.log`);
}

/** The series document inside a series folder. */
export const SERIES_FILE_NAME = 'series.md';

/** What a series pass writes next to series.md; the engine checks it and renames it (Series plan §3). */
export const SERIES_NEW_FILE_NAME = 'series.md.new';

/** The client's series folder, `<inbox>/<Client>/_Series`: one folder per series. */
export function seriesRootFor(inboxPath: string, client: string): string {
  return join(clientDirFor(inboxPath, client), SERIES_DIR_NAME);
}

/** One series' folder, `<inbox>/<Client>/_Series/<name>`. */
export function seriesDirFor(inboxPath: string, client: string, name: string): string {
  return join(seriesRootFor(inboxPath, client), name);
}

/** A series' `series.md`, `<inbox>/<Client>/_Series/<name>/series.md`. */
export function seriesFileFor(inboxPath: string, client: string, name: string): string {
  return join(seriesDirFor(inboxPath, client, name), SERIES_FILE_NAME);
}

/** A series' kit, `<inbox>/<Client>/_Series/<name>/kit`: the format job's composition. */
export function seriesKitDirFor(inboxPath: string, client: string, name: string): string {
  return join(seriesDirFor(inboxPath, client, name), KIT_DIR_NAME);
}

/** Where a series' replaced `series.md` is kept: `<dataDir>/clients/<clientId>/series/<seriesId>/history`. */
export function seriesHistoryDirFor(dataDir: string, clientId: string, seriesId: string): string {
  return join(dataDir, 'clients', clientId, 'series', seriesId, 'history');
}

/** The copy kept of the `series.md` that was at `version`: `history/<version>.md`. */
export function seriesHistoryFileFor(
  dataDir: string,
  clientId: string,
  seriesId: string,
  version: number,
): string {
  return join(seriesHistoryDirFor(dataDir, clientId, seriesId), `${version}.md`);
}

/** The kit that went with the `series.md` at `version`: `history/<version>-kit/`. */
export function seriesHistoryKitDirFor(
  dataDir: string,
  clientId: string,
  seriesId: string,
  version: number,
): string {
  return join(seriesHistoryDirFor(dataDir, clientId, seriesId), `${version}-kit`);
}
