// The job sheet's routes (Job sheet plan §4), mounted at /api/jobs next to the jobs routes:
//
//   GET  /:id/steps       { jobId, runs }: the job's timed step runs, oldest first (the order they
//                         were written in). A run still open, or left open by a crash, a failure
//                         or a cancel, has endedAt null. Each run says its review round, numbered
//                         like Job.round (see roundsOfRuns). A job that has not started has `[]`
//   POST /:id/reveal      { ok: true, revealed }: Finder shows the job's export MP4 selected
//                         (`open -R`, revealed "file") when the job has an output and the file is
//                         on disk, else opens the job's folder (revealed "folder"). 404 unknown
//                         job or a folder that is gone, 500 when Finder could not be asked
//   GET  /:id/sent-notes  { jobId, notes }: the review notes the job's rounds were sent with, by
//                         round and then in the Review dialog's order. Answers in every state of
//                         the job (GET /:id/notes is the unsent notes, and only in Review)
//
//   GET  /:id/stock       { jobId, items }: the sound effects and photos the job's runs took
//                         (edit/stock/stock.json, Stock media), oldest first; `items: []` for a job
//                         that took none, or whose record cannot be read. Answers in every state of
//                         the job and with the Stock switch off, since a credit stays true
//   GET  /:id/reel        { jobId, reel }: the reel linked to the job with the numbers its last
//                         scan read (the sheet's "On Instagram" line, Clients × Instagram), or
//                         `reel: null` for a job none links. 404 for an unknown job, and while the
//                         `instagram` switch is off (the route is given no reels then)
//
// All five are read-only or only ask Finder, so they work whether the Job sheet switch is on or
// off. Every error answers `{ error: string }` (the shared `apiErrorSchema`).

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  INSTAGRAM_MESSAGES,
  JOB_REVEAL_MESSAGES,
  type JobReelResponse,
  type JobStepsResponse,
  type RevealJobResponse,
  type SentNotesResponse,
  STOCK_FILES,
  type StockResponse,
  stockRecordSchema,
} from '@studio/shared';
import { Hono } from 'hono';
import type {
  InstagramRepository,
  JobRepository,
  NoteRepository,
  StepRunRepository,
} from '../db/index.js';
import { toIso } from '../db/mapping.js';
import { logger } from '../logger.js';
import type { FolderOpener } from './clients.js';
import { resolveInside } from './download.js';

/** Shows a file selected in a Finder window. Injected, so tests never open Finder. */
export type FileRevealer = (path: string) => Promise<void>;

const execFileAsync = promisify(execFile);

/** The real revealer: macOS `open -R <file>`, which opens the file's folder with it selected. */
export const revealInFinder: FileRevealer = async (path) => {
  await execFileAsync('open', ['-R', path]);
};

export interface JobSheetRouteOptions {
  jobs: Pick<JobRepository, 'get'>;
  steps: Pick<StepRunRepository, 'listForJob'>;
  notes: Pick<NoteRepository, 'listSent'>;
  /** The inbox root, `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** The exports folder, `Config.exportsDir`: `job.output.fileName` is relative to it. */
  exportsDir: string;
  /** Opens the job's folder. Required, like the client reveal's, so nothing builds these routes with a real Finder behind them by accident. */
  openFolder: FolderOpener;
  /** Shows the export file selected. Required for the same reason. */
  revealFile: FileRevealer;
  /**
   * The reels, given only while the `instagram` switch is on (Clients × Instagram): `GET /:id/reel`
   * reads the reel that links the job. Without it that route answers 404 "Clients × Instagram is
   * off." like every other Instagram route.
   */
  instagram?: Pick<InstagramRepository, 'reelOfJob'>;
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

export function createJobSheetRoutes({
  jobs,
  steps,
  notes,
  inboxPath,
  exportsDir,
  openFolder,
  revealFile,
  instagram,
}: JobSheetRouteOptions): Hono {
  const routes = new Hono();
  const notFound = (id: string) => ({ error: `Job ${id} not found` });

  routes.get('/:id/steps', (c) => {
    const id = c.req.param('id');
    if (jobs.get(id) === null) return c.json(notFound(id), 404);
    const body: JobStepsResponse = { jobId: id, runs: steps.listForJob(id) };
    return c.json(body);
  });

  routes.get('/:id/sent-notes', (c) => {
    const id = c.req.param('id');
    if (jobs.get(id) === null) return c.json(notFound(id), 404);
    const body: SentNotesResponse = { jobId: id, notes: notes.listSent(id) };
    return c.json(body);
  });

  routes.get('/:id/stock', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json(notFound(id), 404);
    let items: StockResponse['items'] = [];
    try {
      const text = await readFile(join(inboxPath, job.relPath, 'edit', STOCK_FILES.record), 'utf8');
      const record = stockRecordSchema.safeParse(JSON.parse(text));
      if (record.success) items = record.data.items;
      else logger.warn({ jobId: id }, 'the job’s stock.json does not fit the contract');
    } catch {
      // No record: the job took nothing.
    }
    const body: StockResponse = { jobId: id, items };
    return c.json(body);
  });

  routes.get('/:id/reel', (c) => {
    const id = c.req.param('id');
    if (instagram === undefined) return c.json({ error: INSTAGRAM_MESSAGES.off }, 404);
    if (jobs.get(id) === null) return c.json(notFound(id), 404);
    const reel = instagram.reelOfJob(id);
    const body: JobReelResponse = {
      jobId: id,
      reel:
        reel === null
          ? null
          : {
              shortcode: reel.shortcode,
              url: reel.url,
              postedAt: toIso(reel.postedAt),
              plays: reel.plays,
              likes: reel.likes,
              comments: reel.comments,
              shares: reel.shares,
            },
    };
    return c.json(body);
  });

  routes.post('/:id/reveal', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json(notFound(id), 404);

    // The export, when the job has one and it is still there.
    const exported =
      job.output === null ? null : await resolveInside(exportsDir, job.output.fileName);
    if (exported !== null && (await isFile(exported))) {
      try {
        await revealFile(exported);
      } catch (err) {
        logger.error({ err, jobId: id, file: exported }, 'could not show the job export in Finder');
        return c.json({ error: JOB_REVEAL_MESSAGES.couldNotOpen }, 500);
      }
      const body: RevealJobResponse = { ok: true, revealed: 'file' };
      return c.json(body);
    }

    // Otherwise the job folder, which has to be there.
    const folder = join(inboxPath, job.relPath);
    if (!(await isDirectory(folder))) {
      return c.json({ error: JOB_REVEAL_MESSAGES.folderMissing }, 404);
    }
    try {
      await openFolder(folder);
    } catch (err) {
      logger.error({ err, jobId: id, folder }, 'could not open the job folder');
      return c.json({ error: JOB_REVEAL_MESSAGES.couldNotOpen }, 500);
    }
    const body: RevealJobResponse = { ok: true, revealed: 'folder' };
    return c.json(body);
  });

  return routes;
}
