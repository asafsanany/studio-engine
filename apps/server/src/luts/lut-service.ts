// The LUTs service (LUTs plan, "API"): the rules behind /api/luts, which routes/luts.ts turns into
// HTTP. OWNER: LU1.
//
//   list      yours (newest first) and built in (by name), with the used counts
//   get       one LUT with everything its pane shows
//   update    rename (the name, the file and the slug follow) and mark a kind; Yours only
//   remove    Yours only: the file goes to the Trash
//   duplicate Yours: a copy named "X (2)"; Built in: a copy in Yours (not the Cinematic look: it has
//             no file, so there is nothing to copy; the answer says so with 409)
//   reveal    Show in Finder: the .cube file (`open -R`)
//   beginStage / stage / cancelStage / importStaged   the three steps of an import
//
// A built-in LUT cannot be renamed, re-kinded or deleted: 409 with LUT_MESSAGES.builtInReadOnly.
// (LU0's comment on that message said 403; the item LU1 says 409 and that is what is answered.)
//
// While the LUTs switch is off the engine mounts no LUTs route (app.ts answers 404 "LUTs are off."
// for all of them) and uses `createDisabledLutService()`, which refuses everything the same way.
// Every change goes out on the bus as `lut.changed` / `lut.removed`; a rename publishes
// `lut.removed {oldSlug}` and then `lut.changed {new}` (the event carries only the new summary).

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import {
  builtInLut,
  type CancelLutStageResponse,
  cleanLutName,
  type DeleteLutResponse,
  freeLutName,
  LUT_LIMITS,
  LUT_MESSAGES,
  type LutChangedEvent,
  type LutDetail,
  type LutImportRequest,
  type LutImportResponse,
  type LutKind,
  type LutListResponse,
  type LutRemovedEvent,
  type LutStageFile,
  type LutStageResponse,
  type LutSummary,
  lutKindGuess,
  lutNameKey,
  type RevealLutResponse,
  type UpdateLutRequest,
} from '@studio/shared';
import {
  LutNameEmptyError,
  LutNameTakenError,
  type LutRepository,
  type StoredLut,
  toLutDetail,
  toLutSummary,
} from '../db/lut-repository.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import type { FolderOpener } from '../routes/clients.js';
import { revealInFinder } from '../routes/job-sheet.js';
import { type LutProver, prepareLutFile } from './lut-check.js';
import type { LutPreviews, PreviewSource } from './lut-previews.js';
import type { LutStage, LutStaging } from './lut-staging.js';
import { isLutFileName, type ReceivedLutFile } from './lut-upload.js';

export type { ReceivedLutFile } from './lut-upload.js';

/** A refusal: the status to answer with and the words for the person, sent as `{ error }`. */
export interface LutRefusal {
  ok: false;
  status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500;
  error: string;
}

/** What a LUTs method answers: the body to send and its status, or a refusal. */
export type LutOutcome<Body> = { ok: true; status: 200 | 201; body: Body } | LutRefusal;

/**
 * The built-in catalog as the service sees it (LUTs plan, "Built in"). OWNER: LU2
 * (luts/lut-builtin.ts): the 19 rows of `BUILTIN_LUTS` read from the installed colour-grade skill,
 * `~/.claude/skills/color-grade-ai/correction_luts/`. Nothing from the skill is copied into the
 * repo.
 */
export interface BuiltInLuts {
  /** Whether the skill is installed. False: the page shows "Built-in LUTs need the colour grade …". */
  available(): Promise<boolean>;
  /**
   * The built-in rows by name, `[]` when not available. `usedCounts` is `LutRepository.usedCounts()`:
   * a row's key is its slug.
   */
  list(usedCounts: ReadonlyMap<string, number>): Promise<LutSummary[]>;
  /** One row with its pane's fields, or `null` for a slug that is not built in. */
  get(slug: string, used: number, usedIn: number | null): Promise<LutDetail | null>;
  /**
   * The row's .cube file inside the skill, or `null` for the Cinematic look (it has no file), a
   * slug that is not built in or a file that is missing. For Show in Finder, Duplicate to Yours
   * and the previews.
   */
  cubePath(slug: string): Promise<string | null>;
  /**
   * LU2: the .cube that stands for the row when it is used or copied: `cubePath`, or for the
   * Cinematic look its chain baked into one file (made once by grade_batch.py --bake-look, cached
   * in the data folder). What a copy of Cinematic is (Duplicate to Yours) and what its previews are
   * made from. `null` for a slug that is not built in or a file that is missing.
   */
  cubeFile(slug: string): Promise<string | null>;
}

export interface LutService {
  /** Whether LUTs are on: false for {@link createDisabledLutService}. */
  readonly enabled: boolean;
  /** Yours, Built in and whether the skill is there (`builtInAvailable`). */
  list(): Promise<LutOutcome<LutListResponse>>;
  get(slug: string): Promise<LutOutcome<LutDetail>>;
  /** Rename and/or mark a kind. Yours only (409 for a built-in LUT). */
  update(slug: string, patch: UpdateLutRequest): Promise<LutOutcome<LutDetail>>;
  /** To the Trash. Yours only (409 for a built-in LUT). The jobs already made keep their look. */
  remove(slug: string): Promise<LutOutcome<DeleteLutResponse>>;
  /** Yours: a copy named "X (2)". Built in: a copy in Yours. Answers the copy. */
  duplicate(slug: string): Promise<LutOutcome<LutDetail>>;
  /** Show in Finder: the .cube file (a built-in LUT's file in the skill). */
  reveal(slug: string): Promise<LutOutcome<RevealLutResponse>>;
  /** Step 1 of an import: an empty stage folder for the upload to write its files into. */
  beginStage(): Promise<LutStage>;
  /** Step 1, once the upload is stored: one verdict per file (lut-check.ts). */
  stage(stage: LutStage, files: readonly ReceivedLutFile[]): Promise<LutOutcome<LutStageResponse>>;
  /** Throws a stage away. */
  cancelStage(stageId: string): Promise<LutOutcome<CancelLutStageResponse>>;
  /** Step 3: copies each marked file into `_LUTs`, writes the rows, starts the previews. */
  importStaged(request: LutImportRequest): Promise<LutOutcome<LutImportResponse>>;
}

const OFF: LutRefusal = { ok: false, status: 404, error: LUT_MESSAGES.off };

/** 409, Duplicate to Yours on the Cinematic look (the colour grade makes it; there is no file). */
export const CINEMATIC_HAS_NO_FILE =
  'The Cinematic look is made by the colour grade and has no file.';

const refuse = (status: LutRefusal['status'], error: string): LutRefusal => ({
  ok: false,
  status,
  error,
});
const NOT_FOUND = refuse(404, LUT_MESSAGES.notFound);

/** The service while the LUTs switch is off: every method refuses 404 "LUTs are off.". */
export function createDisabledLutService(): LutService {
  const off = async (): Promise<LutRefusal> => OFF;
  return {
    enabled: false,
    list: off,
    get: off,
    update: off,
    remove: off,
    duplicate: off,
    reveal: off,
    beginStage: async () => {
      throw new Error(LUT_MESSAGES.off);
    },
    stage: off,
    cancelStage: off,
    importStaged: off,
  };
}

export interface LutServiceOptions {
  repo: LutRepository;
  /** The built-in catalog (LU2). */
  builtIn: BuiltInLuts;
  /** The staging folders of an import (LU1). */
  staging: LutStaging;
  /** Makes and starts the preview stills of a LUT (LU2). */
  previews: LutPreviews;
  /** The inbox, whose `_LUTs/` holds the imported files. */
  inboxPath: string;
  /** Every change: the engine publishes it on the bus. */
  publish: (event: LutEvent) => void;
  /** The lutsInEdits switch: off, a LUT's detail has `usedIn: null`. */
  usedIn: boolean;
  /**
   * Shows a file in Finder (Show in Finder gets the .cube file's path). Default: macOS `open -R`.
   * Tests pass a fake that records the path.
   */
  openFolder?: FolderOpener;
  /** The final proof of a file before it is imported. Default: accepts (the engine passes ffmpeg's). */
  prover?: LutProver;
  /** For `<data>/deleted-luts/`, where a deleted file goes when macOS will not take it to the Trash. */
  dataDir?: string;
  /** The home folder, for `~/.Trash`. Default: the user's. Tests pass a temp folder. */
  home?: string;
  logger: WorkerLogger;
  clock?: () => Date;
}

/** What the service tells the bus: `lut.changed` / `lut.removed` (shared events.ts). */
export type LutEvent = LutChangedEvent | LutRemovedEvent;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** The file's name without its extension: "Golden Hour.cube" → "Golden Hour". */
function stem(fileName: string): string {
  const extension = extname(fileName);
  return extension === '' ? fileName : fileName.slice(0, -extension.length);
}

/** "x.cube", else "x 2.cube", "x 3.cube", … : the first that `dir` does not have (Finder's way). */
async function freeFileNameIn(dir: string, name: string): Promise<string> {
  const extension = extname(name);
  const base = stem(name);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${base} ${n}${extension}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await rm(from, { force: true });
  }
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The real service, while the LUTs switch is on. Mutations (import, rename, duplicate, delete) go
 * one at a time, so two of them never pick the same name.
 */
export function createLutService(options: LutServiceOptions): LutService {
  const { repo, builtIn, staging, previews, logger } = options;
  const clock = options.clock ?? (() => new Date());
  const reveal = options.openFolder ?? revealInFinder;
  const prove: LutProver = options.prover ?? (async () => null);
  const home = options.home ?? homedir();
  const lutsDir = join(options.inboxPath, '_LUTs');

  /** The files of each stage that passed the check: id → what the import needs. */
  interface StagedLut {
    name: string;
    cubePath: string;
    size: number;
  }
  const stages = new Map<string, Map<string, StagedLut>>();

  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  }

  const fileOf = (lut: StoredLut): string => join(lutsDir, lut.file);

  function detailOf(lut: StoredLut): LutDetail {
    const used = repo.usedCount(lut.id);
    return toLutDetail(lut, used, options.usedIn ? used : null, clock());
  }

  function publishChanged(lut: StoredLut): void {
    options.publish({
      type: 'lut.changed',
      lut: toLutSummary(lut, repo.usedCount(lut.id), clock()),
    });
  }

  function warm(lut: StoredLut): void {
    const source: PreviewSource = {
      key: lut.id,
      kind: lut.kind,
      cubePath: fileOf(lut),
      look: null,
      sha256: lut.sha256,
    };
    try {
      previews.warm(source);
    } catch (err) {
      logger.warn({ err, lutId: lut.id }, 'luts: could not start the previews');
    }
  }

  /** A stage's files that are still there, or `null` (reaped, cancelled, or never made). */
  async function stagedFiles(stageId: string): Promise<Map<string, StagedLut> | null> {
    const stage = await staging.find(stageId);
    const files = stages.get(stageId);
    if (stage === null) {
      stages.delete(stageId);
      return null;
    }
    return files ?? null;
  }

  /** Drops what the map remembers of stages whose folder is gone (reaped). */
  async function forgetGoneStages(): Promise<void> {
    for (const stageId of [...stages.keys()]) {
      if ((await staging.find(stageId)) === null) stages.delete(stageId);
    }
  }

  /**
   * Copies `from` into `_LUTs` as the first free "<name>.cube" and writes the row, retrying with
   * another name when the name (or the slug it makes) turns out taken. The copy is removed if the row
   * cannot be written.
   */
  async function addLut(input: {
    from: string;
    baseName: string;
    kind: LutKind;
    size: number;
    sourceName: string;
  }): Promise<StoredLut> {
    await mkdir(lutsDir, { recursive: true });
    const content = await readFile(input.from);
    const hash = sha256Of(content);
    const taken = repo.takenNames();
    for (;;) {
      const name = freeLutName(input.baseName, taken);
      const file = `${name}.cube`;
      const target = join(lutsDir, file);
      try {
        await copyFile(input.from, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          taken.push(name); // a file of that name is there that no row knows
          continue;
        }
        throw error;
      }
      try {
        return repo.create({
          name,
          kind: input.kind,
          size: input.size,
          file,
          bytes: content.length,
          sha256: hash,
          sourceName: input.sourceName,
        });
      } catch (error) {
        await rm(target, { force: true });
        if (error instanceof LutNameTakenError) {
          taken.push(name); // the slug it makes is another LUT's
          continue;
        }
        throw error;
      }
    }
  }

  async function readCubeFacts(path: string): Promise<{ size: number } | null> {
    const checked = await prepareLutFile(path, `${basename(path, extname(path))}.cube`);
    return checked.ok ? { size: checked.size } : null;
  }

  return {
    enabled: true,

    async list() {
      const now = clock();
      const counts = repo.usedCounts();
      const builtInAvailable = await builtIn.available();
      return {
        ok: true,
        status: 200,
        body: {
          yours: repo.list().map((lut) => toLutSummary(lut, counts.get(lut.id) ?? 0, now)),
          builtIn: builtInAvailable ? await builtIn.list(counts) : [],
          builtInAvailable,
        },
      };
    },

    async get(slug) {
      const yours = repo.getBySlug(slug);
      if (yours !== null) return { ok: true, status: 200, body: detailOf(yours) };
      if (builtInLut(slug) === undefined) return NOT_FOUND;
      if (!(await builtIn.available())) return refuse(409, LUT_MESSAGES.builtInMissing);
      const used = repo.usedCounts().get(slug) ?? 0;
      const detail = await builtIn.get(slug, used, options.usedIn ? used : null);
      return detail === null ? NOT_FOUND : { ok: true, status: 200, body: detail };
    },

    update(slug, patch) {
      return serial(async () => {
        const lut = repo.getBySlug(slug);
        if (lut === null) {
          return builtInLut(slug) === undefined
            ? NOT_FOUND
            : refuse(409, LUT_MESSAGES.builtInReadOnly);
        }

        let current = lut;
        let renamedFrom: string | null = null;
        if (patch.name !== undefined) {
          const clean = cleanLutName(patch.name);
          if (clean === '') return refuse(422, LUT_MESSAGES.nameEmpty);
          if (clean !== lut.name) {
            if (!repo.isNameFree(clean, lut.id)) return refuse(422, LUT_MESSAGES.nameTaken);
            const file = `${clean}.cube`;
            const from = fileOf(lut);
            const to = join(lutsDir, file);
            // A file by that name that no row owns (the same name in another case is this file).
            if (lutNameKey(file) !== lutNameKey(lut.file) && (await exists(to))) {
              return refuse(422, LUT_MESSAGES.nameTaken);
            }
            let moved = false;
            try {
              await rename(from, to);
              moved = true;
            } catch (error) {
              if (errorCode(error) !== 'ENOENT') {
                logger.error({ err: error, lutId: lut.id }, 'luts: could not rename the file');
                return refuse(500, LUT_MESSAGES.fileMissing);
              }
              // The file is gone already: the row follows the name all the same.
            }
            try {
              const renamed = repo.rename(lut.id, clean, file);
              if (renamed === null) return NOT_FOUND;
              current = renamed;
              renamedFrom = lut.slug;
            } catch (error) {
              if (moved) await rename(to, from).catch(() => undefined);
              if (error instanceof LutNameTakenError) return refuse(422, LUT_MESSAGES.nameTaken);
              if (error instanceof LutNameEmptyError) return refuse(422, LUT_MESSAGES.nameEmpty);
              throw error;
            }
          }
        }
        if (patch.kind !== undefined && patch.kind !== current.kind) {
          const marked = repo.setKind(current.id, patch.kind);
          if (marked === null) return NOT_FOUND;
          current = marked;
        }

        if (renamedFrom !== null && renamedFrom !== current.slug) {
          options.publish({ type: 'lut.removed', slug: renamedFrom });
        }
        if (current !== lut) publishChanged(current);
        return { ok: true, status: 200, body: detailOf(current) };
      });
    },

    remove(slug) {
      return serial(async () => {
        const lut = repo.getBySlug(slug);
        if (lut === null) {
          return builtInLut(slug) === undefined
            ? NOT_FOUND
            : refuse(409, LUT_MESSAGES.builtInReadOnly);
        }
        const from = fileOf(lut);
        let where = from;
        if (await exists(from)) {
          try {
            const trash = join(home, '.Trash');
            await mkdir(trash, { recursive: true, mode: 0o700 });
            where = join(trash, await freeFileNameIn(trash, lut.file));
            await moveFile(from, where);
          } catch (error) {
            const aside =
              options.dataDir === undefined ? null : join(options.dataDir, 'deleted-luts');
            if (aside === null) {
              logger.error({ err: error, lutId: lut.id }, 'luts: the file could not be moved away');
              return refuse(500, LUT_MESSAGES.deleteFailed);
            }
            try {
              await mkdir(aside, { recursive: true });
              where = join(aside, await freeFileNameIn(aside, lut.file));
              await moveFile(from, where);
              logger.warn(
                { lutId: lut.id, where, err: error },
                'luts: the Trash would not take the file; it is kept in the data folder',
              );
            } catch (err) {
              logger.error({ err, lutId: lut.id }, 'luts: the file could not be moved away');
              return refuse(500, LUT_MESSAGES.deleteFailed);
            }
          }
        } else {
          logger.warn({ lutId: lut.id }, 'luts: deleted, but its file was already gone');
        }
        repo.softDelete(lut.id);
        options.publish({ type: 'lut.removed', slug: lut.slug });
        return { ok: true, status: 200, body: { ok: true as const, where } };
      });
    },

    duplicate(slug) {
      return serial(async () => {
        const lut = repo.getBySlug(slug);
        if (lut !== null) {
          const from = fileOf(lut);
          if (!(await exists(from))) return refuse(404, LUT_MESSAGES.fileMissing);
          const copy = await addLut({
            from,
            baseName: lut.name,
            kind: lut.kind,
            size: lut.size,
            sourceName: lut.sourceName,
          });
          publishChanged(copy);
          warm(copy);
          return { ok: true, status: 201, body: detailOf(copy) };
        }

        const row = builtInLut(slug);
        if (row === undefined) return NOT_FOUND;
        if (!(await builtIn.available())) return refuse(409, LUT_MESSAGES.builtInMissing);
        // `cubeFile`, not `cubePath`: the Cinematic look has no file in the skill, and its copy is
        // its chain baked into one cube (LU2); `null` only when the bake could not be made.
        const from = await builtIn.cubeFile(slug);
        if (from === null) {
          return refuse(
            409,
            row.look === null ? LUT_MESSAGES.builtInMissing : CINEMATIC_HAS_NO_FILE,
          );
        }
        const facts = await readCubeFacts(from);
        if (facts === null) return refuse(409, LUT_MESSAGES.builtInMissing);
        const copy = await addLut({
          from,
          baseName: row.name,
          kind: row.kind,
          size: facts.size,
          sourceName: basename(from),
        });
        publishChanged(copy);
        warm(copy);
        return { ok: true, status: 201, body: detailOf(copy) };
      });
    },

    async reveal(slug) {
      let path: string;
      const lut = repo.getBySlug(slug);
      if (lut !== null) {
        path = fileOf(lut);
        if (!(await exists(path))) return refuse(404, LUT_MESSAGES.fileMissing);
      } else {
        const row = builtInLut(slug);
        if (row === undefined) return NOT_FOUND;
        if (!(await builtIn.available())) return refuse(409, LUT_MESSAGES.builtInMissing);
        const found = await builtIn.cubePath(slug);
        if (found === null) {
          return refuse(404, row.look === null ? LUT_MESSAGES.fileMissing : CINEMATIC_HAS_NO_FILE);
        }
        path = found;
      }
      try {
        await reveal(path);
      } catch (err) {
        logger.error({ err, slug }, 'luts: could not show the file in Finder');
        return refuse(500, LUT_MESSAGES.revealFailed);
      }
      return { ok: true, status: 200, body: { ok: true as const } };
    },

    async beginStage() {
      await forgetGoneStages();
      return staging.create();
    },

    async stage(stage, files) {
      if (files.length === 0) return refuse(400, LUT_MESSAGES.badImport);
      const kept = new Map<string, StagedLut>();
      const verdicts: LutStageFile[] = [];
      for (const [index, file] of files.entries()) {
        const id = `f${index}`;
        const base = {
          id,
          name: file.name,
          bytes: file.bytes,
          kindGuess: lutKindGuess(file.name),
        };
        const bad = (error: string): void => {
          verdicts.push({ ...base, ok: false, error, size: null });
        };
        if (!isLutFileName(file.name)) {
          bad(LUT_MESSAGES.badExtension);
          continue;
        }
        // Over the limit the upload kept nothing worth reading: the size alone is the verdict.
        if (file.bytes > LUT_LIMITS.fileMaxBytes) {
          bad(LUT_MESSAGES.tooLarge);
          continue;
        }
        let checked: Awaited<ReturnType<typeof prepareLutFile>>;
        try {
          checked = await prepareLutFile(file.path, file.name);
        } catch (err) {
          logger.warn({ err, name: file.name }, 'luts: could not read an uploaded file');
          bad(LUT_MESSAGES.notText);
          continue;
        }
        if (!checked.ok) {
          bad(checked.error);
          continue;
        }
        const cubePath = join(stage.dir, `${id}.cube`);
        await writeFile(cubePath, checked.cube);
        kept.set(id, { name: file.name, cubePath, size: checked.size });
        verdicts.push({
          ...base,
          kindGuess: checked.kindGuess,
          ok: true,
          error: null,
          size: checked.size,
        });
      }
      stages.set(stage.stageId, kept);
      return { ok: true, status: 200, body: { stageId: stage.stageId, files: verdicts } };
    },

    async cancelStage(stageId) {
      stages.delete(stageId);
      const removed = await staging.remove(stageId);
      return removed
        ? { ok: true, status: 200, body: { ok: true as const } }
        : refuse(404, LUT_MESSAGES.stageNotFound);
    },

    importStaged(request) {
      return serial(async () => {
        const files = await stagedFiles(request.stageId);
        if (files === null) return refuse(404, LUT_MESSAGES.stageNotFound);
        const imported: LutSummary[] = [];
        const failed: { id: string; error: string }[] = [];
        for (const item of request.items) {
          const staged = files.get(item.id);
          if (staged === undefined) {
            failed.push({ id: item.id, error: LUT_MESSAGES.badImportItem });
            continue;
          }
          files.delete(item.id); // one file, one LUT: the same id twice fails the second time
          try {
            const refused = await prove(staged.cubePath);
            if (refused !== null) {
              failed.push({ id: item.id, error: refused });
              continue;
            }
            const base = cleanLutName(stem(staged.name));
            const lut = await addLut({
              from: staged.cubePath,
              baseName: base === '' ? 'LUT' : base,
              kind: item.kind,
              size: staged.size,
              sourceName: staged.name,
            });
            publishChanged(lut);
            warm(lut);
            imported.push(toLutSummary(lut, 0, clock()));
          } catch (err) {
            logger.error({ err, name: staged.name }, 'luts: could not import a file');
            failed.push({ id: item.id, error: LUT_MESSAGES.badImport });
          }
        }
        stages.delete(request.stageId);
        await staging.remove(request.stageId).catch((err: unknown) => {
          logger.warn({ err, stageId: request.stageId }, 'luts: could not remove the upload');
        });
        return {
          ok: true,
          status: imported.length > 0 ? 201 : 200,
          body: { imported, failed },
        };
      });
    },
  };
}
