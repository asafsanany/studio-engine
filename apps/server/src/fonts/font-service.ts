// The Fonts service (Fonts plan, "API"): the rules behind /api/fonts, which routes/fonts.ts turns
// into HTTP. FN1 made the shape; the bodies are built by the items named on each method, side by
// side, and each changes only its own:
//
//   list, get, file          FN3  the index of `<inbox>/_Fonts`: the families, one family's pane,
//                                 a font file by its id (a client never sends a path)
//   stage, cancelStage, importStaged
//                            FN4  the three steps of an import
//   reveal, remove           FN5  Show in Finder, and a family to the Trash
//   dismissRequest           C52  "Not a font" on a bar for a name a note wrote (not a font at all)
//
// The files in `_Fonts` are the only truth: the service keeps no copy of a font in the database
// (the two small tables, `font_uses` and `font_requests`, are the repository's). While the Fonts
// switch is off the engine mounts no Fonts route (app.ts answers 404 "Fonts are off." for all of
// them) and uses `createDisabledFontService()`, which refuses everything the same way. While it is
// on, the engine uses `createFontService()`.
//
// `start()` / `stop()` are the engine's: `start()` builds the font index and watches `_Fonts`
// (a switch that is off starts nothing), `stop()` lets go of the watcher.
//
// Every change goes out on the bus as `font.changed` / `font.removed` (shared events.ts), and a
// dismissed request as `font.request.dismissed`.
//
// A note that asked for a font the library did not have is answered the moment a family or a face
// of that name appears (C46): the index tells the service which names are new in each refresh, and
// this is the only place that settles the requests. An import (FN4), a font dropped into `_Fonts`
// in Finder (the watcher) and a hand-copied one noticed by the next upload all go through it, so a
// name is settled once, by the refresh that first sees it, and a font that was already there never
// settles a request.

import { rm, stat } from 'node:fs/promises';
import {
  type CancelFontStageResponse,
  type DeleteFontResponse,
  type DismissFontRequestResponse,
  FONT_LIMITS,
  FONT_MESSAGES,
  type FontChangedEvent,
  type FontFaceInfo,
  type FontFamilyDetail,
  type FontFamilySummary,
  type FontFormat,
  type FontImportResponse,
  type FontRemovedEvent,
  type FontRequest,
  type FontRequestDismissedEvent,
  type FontStageResponse,
  type FontsListResponse,
  fontNameKey,
  fontUsedLabel,
  isNewFont,
  type RevealFontResponse,
  weightsLabel,
} from '@studio/shared';
import type { FontRepository } from '../db/font-repository.js';
import { fontsDirFor } from '../pipeline/shared-fonts.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import type { FolderOpener } from '../routes/clients.js';
import { createFamilyFiles } from './font-family-files.js';
import {
  cloneCopy,
  copyItemIntoLibrary,
  type FontCopy,
  judgeUpload,
  type StagedFontItem,
} from './font-import.js';
import {
  type AppearedFontNames,
  createFontIndex,
  type FontIndex,
  type FontIndexChange,
  type IndexedFace,
  type IndexedFamily,
} from './font-index.js';
import {
  createFontStaging,
  type FontStage,
  type FontStaging,
  type ReceivedFontFile,
  startFontStagingReaper,
} from './font-staging.js';
import type { FontCatalog } from './font-tokens.js';
import { createFontWatcher, type FontWatcher, type FontWatcherOptions } from './font-watcher.js';

export type { FontStage, ReceivedFontFile } from './font-staging.js';

/** A refusal: the status to answer with and the words for the person, sent as `{ error }`. */
export interface FontRefusal {
  ok: false;
  status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500;
  error: string;
}

/** What a Fonts method answers: the body to send and its status, or a refusal. */
export type FontOutcome<Body> = { ok: true; status: 200 | 201; body: Body } | FontRefusal;

/**
 * A font file the index knows, for `GET /api/fonts/file/:fileId`. FN3 owns this shape: `path` comes
 * from the index only, `mtimeMs` is what the `?v=` of the address is compared with.
 */
export interface FontFileAnswer {
  /** The file inside `<inbox>/_Fonts`. */
  path: string;
  format: FontFormat;
  /** Its modified time in milliseconds. */
  mtimeMs: number;
}

export interface FontService {
  /** Whether Fonts are on: false for {@link createDisabledFontService}. */
  readonly enabled: boolean;
  /** FN3, the engine's boot: builds the font index and starts watching `_Fonts`. Never throws. */
  start(): Promise<void>;
  /** FN3, the engine's shutdown: stops the watcher. */
  stop(): Promise<void>;
  /**
   * FN3: every face the engine knows, in the shape the note parser asks for (FN12's
   * `resolveNoteFonts(text, await fonts.catalog())`). Waits for the first build of the index.
   */
  catalog(): Promise<FontCatalog>;
  /** FN3: every family A to Z, every face (the catalog) and the open requests for a missing font. */
  list(): Promise<FontOutcome<FontsListResponse>>;
  /** FN3: one family with everything its pane shows. 404 for an unknown slug. */
  get(slug: string): Promise<FontOutcome<FontFamilyDetail>>;
  /** FN3: a font file by the id the index gave it. 404 for an unknown id. */
  file(fileId: string): Promise<FontOutcome<FontFileAnswer>>;
  /** FN5: Show in Finder: the family's folder. */
  reveal(slug: string): Promise<FontOutcome<RevealFontResponse>>;
  /** FN5: the whole family to the Trash. The jobs already made keep their own copy. */
  remove(slug: string): Promise<FontOutcome<DeleteFontResponse>>;
  /**
   * C52, "Not a font": the request is dismissed (with the other open ones of the same job for the
   * same name), and the browsers are told. 404 for a request the engine does not know, and for
   * every request while notes cannot name a font (none is listed then).
   */
  dismissRequest(requestId: string): Promise<FontOutcome<DismissFontRequestResponse>>;
  /** FN4, import step 1: an empty stage folder for the upload to write its files into. */
  beginStage(): Promise<FontStage>;
  /** FN4: the uploaded files, checked and grouped by the family inside them. */
  stage(
    stage: FontStage,
    files: readonly ReceivedFontFile[],
  ): Promise<FontOutcome<FontStageResponse>>;
  /** FN4: throws a stage away. */
  cancelStage(stageId: string): Promise<FontOutcome<CancelFontStageResponse>>;
  /** FN4, import step 3: copies the chosen items into `_Fonts` and answers the families as they are. */
  importStaged(stageId: string, items: readonly string[]): Promise<FontOutcome<FontImportResponse>>;
}

/**
 * What the service tells the bus: `font.changed` / `font.removed` / `font.request.dismissed`
 * (shared events.ts).
 */
export type FontEvent = FontChangedEvent | FontRemovedEvent | FontRequestDismissedEvent;

const OFF: FontRefusal = { ok: false, status: 404, error: FONT_MESSAGES.off };

/** The service while the Fonts switch is off: every method refuses 404 "Fonts are off.". */
export function createDisabledFontService(): FontService {
  const off = async (): Promise<FontRefusal> => OFF;
  return {
    enabled: false,
    start: async () => {},
    stop: async () => {},
    catalog: async () => ({ faces: [] }),
    list: off,
    get: off,
    file: off,
    reveal: off,
    remove: off,
    dismissRequest: off,
    beginStage: async () => {
      throw new Error(FONT_MESSAGES.off);
    },
    stage: off,
    cancelStage: off,
    importStaged: off,
  };
}

export interface FontServiceOptions {
  /** The two small tables: which jobs used a family, and the fonts a note asked for that are not here. */
  repo: FontRepository;
  /** The inbox, whose `_Fonts/` holds the font files. */
  inboxPath: string;
  /** FN4: the data folder, where `font-staging/<stageId>/` holds the uploads waiting to be imported. */
  dataDir?: string;
  /** FN4: copies one font file into `_Fonts`. Default: an APFS clone where the volume can, else a copy. Tests pass one that fails. */
  copy?: FontCopy;
  /** Every change: the engine publishes it on the bus. */
  publish: (event: FontEvent) => void;
  /** The fontsInNotes switch: off, a family's detail has `usedIn: null`. */
  usedIn: boolean;
  /** FN3, FN16: the name of a job for the "a note asked for a font you don't have" banner ("Client · Job"); `null` for a job that is gone. */
  jobName?: (jobId: string) => string | null;
  /** FN3: the `_Fonts` watcher's source, debounce and timers. Tests pass fakes. */
  watcher?: Pick<FontWatcherOptions, 'source' | 'debounceMs' | 'timers'>;
  /** FN5: shows a folder in Finder with it selected (Show in Finder). Default: macOS `open -R`. Tests pass a fake. */
  openFolder?: FolderOpener;
  /** FN5: the home folder, for `~/.Trash`. Default: the user's. Tests pass a temp folder. */
  home?: string;
  logger: WorkerLogger;
  clock?: () => Date;
}

// --- FN3: the list, a family, a file -------------------------------------------------------------

/** A family as the list shows it, with the number of jobs that used it (0 while uses are not recorded). */
function summaryOf(family: IndexedFamily, used: number, now: Date): FontFamilySummary {
  const addedAt = new Date(family.addedAt).toISOString();
  return {
    slug: family.slug,
    name: family.name,
    he: family.he,
    style: family.style,
    weights: family.weights,
    weightsLabel: weightsLabel(family.weights),
    used,
    usedLabel: fontUsedLabel(used),
    addedAt,
    isNew: isNewFont(addedAt, now),
  };
}

/** A face on the wire: the index keeps the file's path and its own Hebrew flag besides. */
function wireFace(face: IndexedFace): FontFaceInfo {
  const { name, family, weight, italic, fileId, bytes, format, version } = face;
  return { name, family, weight, italic, fileId, bytes, format, version };
}

const notFound = (error: string): FontRefusal => ({ ok: false, status: 404, error });

/**
 * The service while the Fonts switch is on. FN3 built the index side (`start`, `stop`, `catalog`,
 * `list`, `get`, `file`); `reveal` and `remove` are FN5's (fonts/font-family-files.ts); the import
 * (`beginStage`, `stage`, `cancelStage`, `importStaged`) is FN4's (fonts/font-staging.ts and
 * fonts/font-import.ts do the file work).
 */
export function createFontService(options: FontServiceOptions): FontService {
  const { repo, logger, publish } = options;
  const clock = options.clock ?? (() => new Date());
  const dir = fontsDirFor(options.inboxPath);

  // --- FN3: the index ---------------------------------------------------------------------

  /** How many jobs used each family (by `fontNameKey`): nothing is recorded while fontsInNotes is off. */
  const usedCounts = (): ReadonlyMap<string, number> =>
    options.usedIn ? repo.usedCounts() : new Map();

  /**
   * A note that asked for a font the library did not have is answered by a font of that name: each
   * family name and face name that is new in the library settles the open requests for it. Settling
   * is harmless while fontsInNotes is off (nothing makes a request then) and never fails a refresh.
   */
  const resolveRequests = (names: Iterable<string>): void => {
    const seen = new Set<string>();
    for (const name of names) {
      const key = fontNameKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        repo.resolveRequests(name);
      } catch (err) {
        logger.warn({ err, name }, 'fonts: could not resolve the requests for a new font');
      }
    }
  };

  /**
   * What a refresh found different goes out on the bus, after the requests its new names answer
   * are settled, so a browser that asks for the list on `font.changed` finds the banner gone.
   */
  const announce = (change: FontIndexChange, appeared: AppearedFontNames): void => {
    resolveRequests(appeared);
    const now = clock();
    const used = usedCounts();
    for (const slug of change.removed) publish({ type: 'font.removed', slug });
    for (const family of change.changed) {
      publish({
        type: 'font.changed',
        family: summaryOf(family, used.get(fontNameKey(family.name)) ?? 0, now),
      });
    }
  };

  const index: FontIndex = createFontIndex({ dir, logger, onChange: announce });
  let watcher: FontWatcher | null = null;
  let stopped = false;

  // --- FN4: import ------------------------------------------------------------------------

  /** The uploads waiting to be imported; without a data folder there is no import. */
  const staging: FontStaging | null =
    options.dataDir === undefined
      ? null
      : createFontStaging({ dataDir: options.dataDir, clock: options.clock });
  let stopReaper: (() => void) | null = null;
  /**
   * The items of each stage that can still be imported (item id → what the import copies), and the
   * ids of those that failed, which keep the stage alive for a retry.
   */
  interface WaitingStage {
    items: Map<string, StagedFontItem>;
    failed: Set<string>;
  }
  const stages = new Map<string, WaitingStage>();

  const needStaging = (): FontStaging => {
    if (staging === null) throw new Error('fonts: no data folder for the uploads');
    return staging;
  };

  /** A stage's items that are still there, or `null` (reaped, cancelled, or never made). */
  const waitingStage = async (stageId: string): Promise<WaitingStage | null> => {
    const waiting = stages.get(stageId);
    if ((await needStaging().find(stageId)) === null) {
      stages.delete(stageId);
      return null;
    }
    return waiting ?? null;
  };

  /** Drops what the map remembers of stages whose folder is gone (reaped). */
  const forgetGoneStages = async (): Promise<void> => {
    for (const stageId of [...stages.keys()]) {
      if ((await needStaging().find(stageId)) === null) stages.delete(stageId);
    }
  };

  /** Imports run one at a time: two at once could both place the same new family. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    enabled: true,

    // --- FN3: the index ---------------------------------------------------------------------
    async start() {
      stopped = false;
      // FN4: nothing waits in the staging folder across a restart, and old uploads go every hour.
      if (staging !== null && stopReaper === null)
        stopReaper = startFontStagingReaper(staging, logger);
      await index.ready();
      if (stopped || watcher !== null) return;
      watcher = createFontWatcher({
        dir,
        logger,
        onChange: () => {
          // The index never rejects; it logs what it cannot read.
          void index.refresh();
        },
        ...options.watcher,
      });
      await watcher.start();
    },

    async stop() {
      stopped = true;
      stopReaper?.();
      stopReaper = null;
      const running = watcher;
      watcher = null;
      await running?.stop();
    },

    async catalog() {
      await index.ready();
      return index.catalog();
    },

    async list() {
      await index.ready();
      const now = clock();
      const used = usedCounts();
      const families = index.families();
      // The banner for a font a note asked for belongs to notes that can name a font: with
      // fontsInNotes off nothing makes a request, and one made earlier is not shown (FN16).
      const requests: FontRequest[] = [];
      const open = options.usedIn
        ? repo.openRequests(now.getTime() - FONT_LIMITS.missingBannerMs)
        : [];
      for (const request of open) {
        const jobName = options.jobName?.(request.jobId) ?? null;
        // A request of a job that is gone has nobody to tell.
        if (jobName === null) continue;
        requests.push({
          id: request.id,
          name: request.name,
          jobId: request.jobId,
          jobName,
          round: request.round,
          at: request.at,
        });
      }
      return {
        ok: true,
        status: 200,
        body: {
          families: families.map((family) =>
            summaryOf(family, used.get(fontNameKey(family.name)) ?? 0, now),
          ),
          catalog: families.flatMap((family) => family.faces.map(wireFace)),
          requests,
        },
      };
    },

    async get(slug) {
      await index.ready();
      const family = index.family(slug);
      if (family === undefined) return notFound(FONT_MESSAGES.notFound);
      const used = options.usedIn ? repo.usedCount(family.name) : null;
      return {
        ok: true,
        status: 200,
        body: {
          ...summaryOf(family, used ?? 0, clock()),
          faces: family.faces.map(wireFace),
          files: family.files,
          bytes: family.bytes,
          usedIn: used,
        },
      };
    },

    async file(fileId) {
      await index.ready();
      const known = index.file(fileId);
      if (known === undefined) return notFound(FONT_MESSAGES.fileNotFound);
      // The modified time is asked of the file now, so `?v=` is judged against the file as it is.
      let mtimeMs: number;
      try {
        mtimeMs = Math.trunc((await stat(known.path)).mtimeMs);
      } catch {
        return notFound(FONT_MESSAGES.fileNotFound);
      }
      return { ok: true, status: 200, body: { path: known.path, format: known.format, mtimeMs } };
    },

    // --- C52: "Not a font" ------------------------------------------------------------------
    async dismissRequest(requestId) {
      // With notes unable to name a font no request is listed, so none can be dismissed either.
      const dismissed = options.usedIn ? repo.dismissRequest(requestId) : null;
      if (dismissed === null) return notFound(FONT_MESSAGES.requestNotFound);
      // Nothing changed for a request that was settled already (an import answered it, or a
      // second click): the answer is the same and nobody is told again.
      if (dismissed > 0) publish({ type: 'font.request.dismissed', id: requestId });
      return { ok: true, status: 200, body: { ok: true as const } };
    },

    // --- FN4: import ------------------------------------------------------------------------
    async beginStage() {
      await forgetGoneStages();
      return needStaging().create();
    },

    async stage(stage, files) {
      await index.ready();
      // What the owner dropped into the folder in Finder a moment ago counts too.
      await index.refresh();
      const { items, importable } = await judgeUpload(
        files,
        { dir, families: () => index.families() },
        logger,
      );
      stages.set(stage.stageId, { items: importable, failed: new Set() });
      return { ok: true, status: 200, body: { stageId: stage.stageId, items } };
    },

    async cancelStage(stageId) {
      stages.delete(stageId);
      const removed = await needStaging().remove(stageId);
      return removed
        ? { ok: true, status: 200, body: { ok: true as const } }
        : notFound(FONT_MESSAGES.stageNotFound);
    },

    importStaged(stageId, ids) {
      return serial(async () => {
        const waiting = await waitingStage(stageId);
        if (waiting === null) return notFound(FONT_MESSAGES.stageNotFound);
        await index.ready();
        await index.refresh();

        const done: { id: string; family: string; faces: string[] }[] = [];
        const failed: { id: string; error: string }[] = [];
        for (const id of new Set(ids)) {
          const item = waiting.items.get(id);
          if (item === undefined) {
            failed.push({ id, error: FONT_MESSAGES.badImportItem });
            continue;
          }
          const copied = await copyItemIntoLibrary({
            library: { dir, families: () => index.families() },
            item,
            copy: options.copy ?? cloneCopy,
            logger,
          });
          if (!copied.ok) {
            failed.push({ id, error: copied.error });
            // A failed item stays in the stage, whatever the reason, so the page can try again.
            waiting.failed.add(id);
            continue;
          }
          waiting.items.delete(id);
          waiting.failed.delete(id);
          done.push({ id, family: copied.family, faces: copied.faces });
          // The upload's copy of what was placed is of no use any more.
          for (const file of item.files)
            await rm(file.path, { force: true }).catch(() => undefined);
        }

        // Read what was placed: the bus hears `font.changed` from this, and the notes that asked
        // for the family or a new face are settled by it (`announce`), once, whoever saw the files
        // first (this refresh or the watcher's).
        await index.refresh();
        const now = clock();
        const used = usedCounts();
        const imported: FontFamilySummary[] = [];
        for (const { family } of done) {
          const found = index.families().find((f) => fontNameKey(f.name) === fontNameKey(family));
          if (found !== undefined && !imported.some((one) => one.slug === found.slug)) {
            imported.push(summaryOf(found, used.get(fontNameKey(found.name)) ?? 0, now));
          }
        }

        // Nothing left to retry: the stage goes. Otherwise it stays, with only what is left.
        if (waiting.failed.size === 0) {
          stages.delete(stageId);
          await needStaging()
            .remove(stageId)
            .catch((err: unknown) => {
              logger.warn({ err, stageId }, 'fonts: could not remove the upload');
            });
        }
        return {
          ok: true,
          status: imported.length > 0 ? 201 : 200,
          body: { imported, failed },
        };
      });
    },

    // --- FN5: Finder and the Trash ----------------------------------------------------------
    ...createFamilyFiles({
      index,
      dir,
      openFolder: options.openFolder,
      home: options.home,
      dataDir: options.dataDir,
      logger,
    }),
  };
}
