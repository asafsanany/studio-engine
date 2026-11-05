// A LUT named in a note reaches the grade (LUTs build 2, LU9). OWNER: LU9.
//
//   a run starts (an edit: the job's note; a revise: edit/review/round-N.md)
//     ─▶ parseLibraryTokens: any @luts/… or @graphics/… in the text?   no ─▶ the run is as before
//     ─▶ resolveLibraryRefs (LU7) against Yours, the built-in catalog and the Graphics library
//     ─▶ each LUT with a file is copied whole into <job>/edit/luts/<slug>.cube (a stale copy is
//        replaced); the Cinematic look has no file, it is the wrapper's own `--look cinematic`
//     ─▶ the uses are noted as pending: a Yours LUT by its id, a built-in one by its slug
//     ─▶ RunLibraryRefs on the run's context: the Claude runner puts it in the prompt (luts-use.md),
//        the fake runner records it, and the editor applies the files with the colour-grade
//        wrapper's `--look-lut` (the wrapper is scripts/color-grade/grade_batch.py)
//     ─▶ the run ends: only when it succeeded (`ok: true`, the job goes to Review) are the pending
//        uses written to lut_uses (LUT, job, round) and `lut.changed` sent
//
// The hook is a Runner that wraps the engine's (`withLutRefs`), like `withGraphicUses`; the engine
// wraps only while the lutsInEdits switch is on, so with it off nothing here runs and an `@luts/…`
// in a note is plain text, as it always was.
//
// Nothing here can fail a run. A token that points at nothing, a file that cannot be copied and a
// graphic the job has no copy of are answered as `missing` (the prompt then says so); an error of
// any other kind is logged and the run starts without references.
//
// A use is counted only once the run it was made for has succeeded (C54): a run that fails or is
// cancelled before editing leaves no row and sends no event. A retry or a resume of the same round
// counts once, when it finally succeeds (the row is keyed by LUT, job and round).

import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  BUILTIN_LUTS,
  type Job,
  type LutChangedEvent,
  type LutSummary,
  parseLibraryTokens,
} from '@studio/shared';
import type { GraphicRepository, LutRepository, StoredLut } from '../db/index.js';
import { toLutSummary } from '../db/lut-repository.js';
import { resolveLibraryRefs } from '../library/library-refs.js';
import type { RunCameraLuts, RunLibraryRefs, RunMissingRef, Runner } from '../pipeline/runner.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { roundFilePath } from '../review/review-files.js';
import type { BuiltInLuts } from './lut-service.js';

/** The job's copies of the LUTs its notes named, inside `edit/`: `edit/luts/<slug>.cube`. */
export const EDIT_LUTS_DIR = 'edit/luts';

/** Where the job's copies of library graphics are (the Brief step makes them), inside `edit/`. */
const EDIT_GRAPHICS_DIR = 'edit/graphics';

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

/** Looks at a job's footage for camera log (LU10, luts/camera-luts.ts) and hands over the matching LUT. */
export type CameraPreparer = (args: {
  job: Job;
  /** The job's folder in the inbox. */
  jobDir: string;
  /** A note already names a Camera LUT, which wins: nothing is matched. */
  byNote: boolean;
  /** Where the preparer notes the matched LUT's use, counted if the run succeeds. */
  pending: PendingLutUse[];
}) => Promise<RunCameraLuts>;

export interface LutJobFilesOptions {
  /** The LUT rows (Yours) and the use counts. */
  luts: Pick<LutRepository, 'list' | 'addUse' | 'usedCount' | 'usedCounts'>;
  /**
   * The Graphics library's rows, given only while edits use it (`graphicsInEdits`). Without it a
   * `@graphics/…` token is left alone: the run says nothing about it.
   */
  graphics?: Pick<GraphicRepository, 'list'>;
  /** The built-in catalog: its availability and the files in the colour-grade skill. */
  builtIn: Pick<BuiltInLuts, 'available' | 'cubePath' | 'list'>;
  /** `Config.inboxPath`: Yours are in `<inboxPath>/_LUTs`. */
  inboxPath: string;
  /** Camera log (LU10): given, an edit run also gets what its footage says about log. */
  camera?: CameraPreparer;
  /** Told a LUT's summary again after a job used it (`lut.changed`, the list's "Used" column). */
  publish?: (event: LutChangedEvent) => void;
  logger?: WorkerLogger;
  clock?: () => Date;
}

/** A LUT use noted when the files are handed to a run, written only if that run succeeds. */
export interface PendingLutUse {
  /** The `lut_uses` key: a Yours LUT's id, a built-in one's slug. */
  key: string;
  slug: string;
  owner: 'yours' | 'builtIn';
  /** 0 for the edit, n for review round n. */
  round: number;
}

/** What one run's notes are: the texts to look for tokens in, and the round the use belongs to. */
export interface LutRunNotes {
  jobId: string;
  /** The job's folder in the inbox. */
  jobDir: string;
  /** 0 for the edit, n for review round n (the `round` of `lut_uses`). */
  round: number;
  /** Every text of this run that can name something. */
  texts: readonly string[];
}

/** Copies `from` over `to` whole (an APFS clone where it can): a temp file in the folder, then a move. */
export async function copyWhole(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const temporary = join(dirname(to), `.${basename(to)}.part`);
  try {
    await copyFile(from, temporary, constants.COPYFILE_FICLONE);
    const [source, copy] = await Promise.all([stat(from), stat(temporary)]);
    if (source.size !== copy.size) throw new Error('the copy is not the whole file');
    await rename(temporary, to);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Looks for library tokens in the run's texts and, when there are any, copies the LUT files into
 * the job, notes the uses in `pending` (counted by {@link countUses} when the run succeeds) and
 * answers what the run is told. `null` when the texts name nothing
 * the run can act on or say anything about (no token, or only graphics tokens while edits do not
 * use the Graphics library).
 */
export async function prepareLutJobFiles(
  options: LutJobFilesOptions,
  notes: LutRunNotes,
  pending: PendingLutUse[],
): Promise<RunLibraryRefs | null> {
  const { luts, builtIn, inboxPath, logger = SILENT } = options;
  const text = notes.texts.join('\n');
  if (parseLibraryTokens(text).length === 0) return null;

  const refs = resolveLibraryRefs(text, {
    luts: luts.list(),
    graphics: options.graphics?.list() ?? [],
    builtIn: (await builtIn.available()) ? BUILTIN_LUTS : [],
  });

  const result: RunLibraryRefs = { luts: [], graphics: [], missing: [] };
  const missing = (ref: RunMissingRef): void => {
    result.missing.push(ref);
  };

  for (const lut of refs.luts) {
    const base = { slug: lut.slug, name: lut.row.name, kind: lut.kind, owner: lut.owner };
    if (lut.look !== null) {
      // The Cinematic look: the wrapper makes it itself, there is no file to copy.
      result.luts.push({ ...base, path: null, look: lut.look });
      pending.push({ key: lut.slug, slug: lut.slug, owner: lut.owner, round: notes.round });
      continue;
    }
    try {
      const source =
        lut.owner === 'yours'
          ? join(inboxPath, '_LUTs', lut.file ?? '')
          : await builtIn.cubePath(lut.slug);
      if (source === null || lut.file === null) throw new Error('the LUT has no file');
      const path = `${EDIT_LUTS_DIR}/${lut.slug}.cube`;
      await copyWhole(source, join(notes.jobDir, path));
      result.luts.push({ ...base, path, look: null });
      pending.push({
        key: lut.owner === 'yours' ? (lut.row as StoredLut).id : lut.slug,
        slug: lut.slug,
        owner: lut.owner,
        round: notes.round,
      });
    } catch (err) {
      logger.warn(
        { err, jobId: notes.jobId, lut: lut.slug },
        'could not copy a LUT a note names into the job',
      );
      missing({ library: 'luts', slug: lut.slug, reason: 'noFile' });
    }
  }

  for (const graphic of refs.graphics) {
    const path = `${EDIT_GRAPHICS_DIR}/${graphic.id}`;
    if (await isDirectory(join(notes.jobDir, path))) {
      result.graphics.push({ slug: graphic.slug, id: graphic.id, name: graphic.name, path });
    } else {
      missing({ library: 'graphics', slug: graphic.slug, reason: 'notInJob' });
    }
  }

  for (const ref of refs.missing) {
    // Without the Graphics library in edits a graphics token is not this run's business.
    if (ref.library === 'graphics' && options.graphics === undefined) continue;
    missing({ library: ref.library, slug: ref.slug, reason: 'notInLibrary' });
  }

  if (result.luts.length + result.graphics.length + result.missing.length === 0) return null;
  return result;
}

/**
 * One `lut_uses` row per pending use, written once the run succeeded; a LUT's summary goes out
 * again when its count really moved (a row it already had changes nothing).
 */
export async function countUses(
  options: LutJobFilesOptions,
  jobId: string,
  used: readonly PendingLutUse[],
): Promise<void> {
  const { luts, builtIn, logger = SILENT } = options;
  const clock = options.clock ?? (() => new Date());
  for (const { key, slug, owner, round } of used) {
    try {
      const before = luts.usedCount(key);
      luts.addUse(key, jobId, round);
      const count = luts.usedCount(key);
      if (count === before || options.publish === undefined) continue;
      const summary: LutSummary | undefined =
        owner === 'yours'
          ? yoursSummary(options, key, count, clock())
          : (await builtIn.list(luts.usedCounts())).find((row) => row.slug === slug);
      if (summary !== undefined) options.publish({ type: 'lut.changed', lut: summary });
    } catch (err) {
      logger.warn({ err, jobId, lut: slug }, 'could not count a LUT use');
    }
  }
}

function yoursSummary(
  options: LutJobFilesOptions,
  id: string,
  used: number,
  now: Date,
): LutSummary | undefined {
  const row = options.luts.list().find((lut) => lut.id === id);
  return row === undefined ? undefined : toLutSummary(row, used, now);
}

/**
 * The texts of this run that can name a LUT: the round file for a revise run, the job's note for
 * an edit run. A render run edits nothing and has none. A round file that cannot be read is no
 * text (the run itself fails on it, as it always did).
 */
export async function lutRunNotes(job: Job, jobDir: string): Promise<LutRunNotes | null> {
  if (job.runKind === 'revise') {
    let text: string;
    try {
      text = await readFile(join(jobDir, roundFilePath(job.round)), 'utf8');
    } catch {
      return null;
    }
    return { jobId: job.id, jobDir, round: job.round, texts: [text] };
  }
  if (job.runKind === 'edit') {
    const note = (job.note ?? '').trim();
    return note === '' ? null : { jobId: job.id, jobDir, round: 0, texts: [note] };
  }
  return null;
}

/**
 * The runner with the library tokens of its notes resolved first (LU9): when the run's notes name
 * a LUT or a graphic, the files are copied, the uses counted and the answer goes on the run's
 * context (`libraryRefs`) to the runner it wraps. Whatever goes wrong here only costs the run its
 * references: it is logged and the run starts as it would have without the switch.
 */
export function withLutRefs(
  runner: Runner,
  options: LutJobFilesOptions,
  logger: WorkerLogger = SILENT,
): Runner {
  return {
    async start(job, mode, context) {
      let libraryRefs: RunLibraryRefs | null = null;
      // Noted while the files are handed over, written only if the run succeeds (C54).
      const pending: PendingLutUse[] = [];
      const jobDir = join(options.inboxPath, job.relPath);
      try {
        const notes = await lutRunNotes(job, jobDir);
        if (notes !== null) libraryRefs = await prepareLutJobFiles(options, notes, pending);
      } catch (err) {
        logger.warn({ err, jobId: job.id }, 'could not look at the library tokens of the notes');
      }
      // Camera log (LU10): an edit run is also told what its footage says about log, and given the
      // one Camera LUT that matches. A note that names a Camera LUT wins, so nothing is matched then.
      if (job.runKind === 'edit' && options.camera !== undefined) {
        try {
          const byNote = libraryRefs?.luts.some((lut) => lut.kind === 'camera') ?? false;
          const camera = await options.camera({ job, jobDir, byNote, pending });
          libraryRefs = { luts: [], graphics: [], missing: [], ...libraryRefs, camera };
        } catch (err) {
          logger.warn({ err, jobId: job.id }, 'could not look at the camera log of the footage');
        }
      }
      const outcome = await runner.start(
        job,
        mode,
        libraryRefs === null ? context : { ...context, libraryRefs },
      );
      // A run that failed, was cancelled or threw (the await above) before reaching Review counts
      // nothing: the retry that finally succeeds will.
      if (outcome.ok && pending.length > 0) await countUses(options, job.id, pending);
      return outcome;
    },
  };
}
