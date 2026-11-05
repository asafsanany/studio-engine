// "Used in" for fonts (Fonts plan, build 2). OWNER: FN17.
//
// After an edit or revise run succeeds, the fonts the finished edit uses are recorded in
// `font_uses`, so a font's page can say "Used in 14 jobs". The scan itself is font-scan.ts; this
// file is what runs it and what it leaves behind:
//
//   a run succeeds (`withFontUses`, the hook on the engine's runner)
//     ─▶ the families of the library, asked of the font index (`fonts.catalog()`: the files are
//        not read again)
//     ─▶ `scanJobFonts(<job>, families)`: the families the compositions name
//     ─▶ font_uses (family, weight 0 = any, job, round, source `composition`), once per family per
//        job per round ─▶ `font.changed` with the new count, while "Used in" shows
//
//   the first boot with Fonts on (`backfillFontUses`)
//     ─▶ the same, round 0, for each job that finished before this existed (Review, Approved,
//        Delivered, Paid) ─▶ a marker file in the data dir, so it never runs twice
//
// The round is 0 for the edit and n for the nth round of review notes (a revise run). A run that
// is repeated records the same rows again, which the repository ignores.
//
// Nothing here writes into a job's folder, and nothing here can fail a run: every error is logged
// and the run's outcome goes through as it was.

import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FontChangedEvent, fontNameKey, type Job } from '@studio/shared';
import { FONT_USE_ANY_WEIGHT, type FontRepository } from '../db/font-repository.js';
import type { JobRepository } from '../db/index.js';
import type { Runner } from '../pipeline/runner.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import { scanJobFonts } from './font-scan.js';
import type { FontService } from './font-service.js';

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

/** The file in the data dir that says the backfill has run. */
export const FONT_USES_BACKFILL_MARKER = 'font-uses-backfill.json';

/** What the recording needs from the engine. */
export interface FontUsesOptions {
  repo: Pick<FontRepository, 'addUse'>;
  /** The font index's view: its families (`catalog`) and, to tell the browsers, the page's list. */
  fonts: Pick<FontService, 'catalog' | 'list'>;
  /** `Config.fontsInNotes`: whether "Used in" shows. Only then is a new count told to the browsers. */
  usedIn?: boolean;
  /** The engine's bus: a family with a new count is published as `font.changed`. */
  publish?: (event: FontChangedEvent) => void;
  logger?: WorkerLogger;
}

/** The families of the library, each once, as the index spells them. */
export async function libraryFamilies(fonts: Pick<FontService, 'catalog'>): Promise<string[]> {
  const catalog = await fonts.catalog();
  return [...new Set(catalog.faces.map((face) => face.family))];
}

/** The round a run's uses belong to: 0 is the edit, n is review round n. */
export function fontUseRound(job: Pick<Job, 'runKind' | 'round'>): number {
  return job.runKind === 'revise' ? job.round : 0;
}

/** Scans the job's compositions and writes what it finds; answers the families it found. */
async function scanAndRecord(
  options: Pick<FontUsesOptions, 'repo' | 'logger'>,
  families: readonly string[],
  jobId: string,
  round: number,
  jobDir: string,
): Promise<{ found: string[]; added: string[] }> {
  const { repo, logger = SILENT } = options;
  const found = await scanJobFonts(jobDir, families, logger);
  const added: string[] = [];
  for (const family of found) {
    try {
      const wasAdded = repo.addUse({
        family,
        weight: FONT_USE_ANY_WEIGHT,
        italic: false,
        jobId,
        round,
        source: 'composition',
      });
      if (wasAdded) added.push(family);
    } catch (err) {
      logger.warn({ err, jobId, family }, 'could not record a font use');
    }
  }
  return { found, added };
}

/**
 * Records the library fonts the finished edit of `job` uses (`jobDir` is the job's folder in the
 * inbox): one `font_uses` row for each family its compositions name, in this run's round. Then,
 * while "Used in" shows, each family that gained a use is published as `font.changed` with its new
 * count. Answers the families found. One that cannot be recorded is logged and does not stop the
 * others; a library with no fonts records nothing.
 */
export async function recordFontUses(
  options: FontUsesOptions,
  job: Pick<Job, 'id' | 'runKind' | 'round'>,
  jobDir: string,
): Promise<string[]> {
  const { fonts, usedIn = false, publish, logger = SILENT } = options;
  const families = await libraryFamilies(fonts);
  if (families.length === 0) return [];
  const { found, added } = await scanAndRecord(
    options,
    families,
    job.id,
    fontUseRound(job),
    jobDir,
  );
  if (added.length > 0 && usedIn && publish !== undefined) {
    try {
      const listed = await fonts.list();
      if (listed.ok) {
        for (const family of added) {
          const key = fontNameKey(family);
          const summary = listed.body.families.find((item) => fontNameKey(item.name) === key);
          if (summary !== undefined) publish({ type: 'font.changed', family: summary });
        }
      }
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'could not tell the browsers about the new font uses');
    }
  }
  return found;
}

/**
 * The runner with the "Used in" scan after it: when an edit or revise run succeeds, `record` is
 * called with the job (after the run, before the worker hears of its outcome). A render run edits
 * nothing, and a failed or stopped run is not a use. The outcome is the runner's own, whatever
 * `record` does; it is awaited, and a rejection is only logged.
 */
export function withFontUses(
  runner: Runner,
  record: (job: Job) => Promise<unknown>,
  logger: WorkerLogger = SILENT,
): Runner {
  return {
    async start(job, mode, context) {
      const outcome = await runner.start(job, mode, context);
      if (outcome.ok && (job.runKind === 'edit' || job.runKind === 'revise')) {
        try {
          await record(job);
        } catch (err) {
          logger.warn({ err, jobId: job.id }, 'could not record the fonts the edit used');
        }
      }
      return outcome;
    },
  };
}

// --- the backfill --------------------------------------------------------------------------------

/** What the backfill needs from the engine. */
export interface BackfillFontUsesOptions {
  jobs: Pick<JobRepository, 'getAll'>;
  repo: Pick<FontRepository, 'addUse'>;
  fonts: Pick<FontService, 'catalog'>;
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** `Config.dataDir`: where the marker file goes. */
  dataDir: string;
  /** Asked before each job: true stops the pass (the engine is shutting down) without a marker. */
  shouldStop?: () => boolean;
  logger?: WorkerLogger;
}

/** What one backfill pass did. */
export interface FontUsesBackfill {
  /** The finished jobs it looked at. */
  jobs: number;
  /** Those whose folder (or `edit/` folder) is gone. */
  skipped: number;
  /** The `font_uses` rows it added. */
  uses: number;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Records, once, the fonts of the jobs that finished before the scan existed: each job in Review
 * or ready (Approved, Delivered, Paid) is scanned like a finished edit, in round 0. Run at boot
 * with Fonts on, after the font index is built. A job whose folder is gone is skipped.
 *
 * Once means once: when the pass has been through every job it writes {@link
 * FONT_USES_BACKFILL_MARKER} in the data dir, and a marker that is there ends every later call at
 * once (answering `null`). No marker is written when there is nothing to match against yet (the
 * library has no fonts) or when `shouldStop` ends the pass early: the next boot tries again, and
 * the repository ignores a use it already has. Reads the inbox; writes only the marker.
 */
export async function backfillFontUses(
  options: BackfillFontUsesOptions,
): Promise<FontUsesBackfill | null> {
  const { jobs, fonts, inboxPath, dataDir, shouldStop, logger = SILENT } = options;
  const marker = join(dataDir, FONT_USES_BACKFILL_MARKER);
  if (await isFile(marker)) return null;
  const families = await libraryFamilies(fonts);
  if (families.length === 0) {
    logger.info({}, 'no fonts in the library yet: the font uses of finished jobs are not read');
    return null;
  }

  const result: FontUsesBackfill = { jobs: 0, skipped: 0, uses: 0 };
  for (const job of jobs.getAll()) {
    if (job.state !== 'review' && job.state !== 'ready') continue;
    if (shouldStop?.() === true) return null;
    result.jobs += 1;
    const jobDir = join(inboxPath, job.relPath);
    try {
      if (!(await isDirectory(join(jobDir, 'edit')))) {
        result.skipped += 1;
        continue;
      }
      const { added } = await scanAndRecord(options, families, job.id, 0, jobDir);
      result.uses += added.length;
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'could not read the fonts of a finished job');
    }
  }

  await mkdir(dataDir, { recursive: true });
  const body = `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`;
  const temp = `${marker}.tmp`;
  await writeFile(temp, body);
  await rename(temp, marker);
  logger.info(result, 'read the fonts of the jobs that finished before "Used in" existed (once)');
  return result;
}
