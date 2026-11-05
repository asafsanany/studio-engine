// The preview versions of a job (Plane item VE1), mounted at /api/jobs:
//
//   GET  /:id/versions                     the job's versions, newest first: { versions }
//   POST /:id/versions/:n/restore          puts version n back as the live preview, the music
//                                          record, the EDL and the project notes; 200 with the Job.
//                                          Restoring the current version changes nothing.
//   GET|HEAD /:id/versions/:n/preview/<path>
//                                          the file <job>/edit/versions/v<n>/preview/<path>,
//                                          read-only, served exactly like the live preview
//
// Every route answers 404 for an unknown job. Restore and the file route then answer 404 for a
// version the job does not have (never made, pruned, or a number that is not one). Restore then
// answers 409 unless the job is in Review, is not archived, has no unsent notes ("Send or delete
// your notes first."; when every one of them was fixed in Review, which Send would turn down, "Approve
// or undo your fixes first.") and has no music pick or quick fix under way (the review block). Every
// error is `{ error: string }`.
//
// The files of a version are served by `serveCompositionFile`, with the same safety as the live
// preview (routes/preview.ts): nothing outside the version's preview/ folder can be read.
//
// The rules live in the version service (versions/version-service.ts); this file is HTTP, the
// checks that a job may go back, and saving the job's new preview.

import { join } from 'node:path';
import { type Job, VERSION_MESSAGES, versionDirName } from '@studio/shared';
import { Hono } from 'hono';
import type { JobRepository } from '../db/index.js';
import { REVIEW_MESSAGES } from '../review/review-service.js';
import { jobFor } from '../team/viewer-scope.js';
import { VersionError, type VersionService } from '../versions/version-service.js';
import { COMPOSITION_INDEX, serveCompositionFile } from './composition-files.js';
import { resolveInside } from './download.js';
import { PREVIEW_FILE_MISSING_MESSAGE } from './preview.js';

export interface VersionRouteOptions {
  jobs: Pick<JobRepository, 'get' | 'setPreview'>;
  versions: VersionService;
  /** Config.inboxPath: a job's folder is <inboxPath>/<job.relPath>. */
  inboxPath: string;
  /** How many notes of the job are not sent yet (`NoteRepository.countUnsent`). */
  countUnsentNotes: (jobId: string) => number;
  /** How many of those were fixed in Review (QF4). Default: none, so the message is always "Send or delete your notes first.". */
  countFixedNotes?: (jobId: string) => number;
  /** Why the job cannot change now, or `null` (a music pick is under way: `ReviewServiceOptions.reviewBlock`). Default: never. */
  reviewBlock?: (job: Job) => string | null;
  /** Called with the job a restore changed; the boot wiring publishes `job.upsert`. */
  onJobChanged?: (job: Job) => void;
}

/** The version number in the URL, or null when it is not a positive whole number. */
function versionNumber(param: string): number | null {
  return /^[1-9]\d{0,8}$/.test(param) ? Number(param) : null;
}

export function createVersionRoutes({
  jobs,
  versions,
  inboxPath,
  countUnsentNotes,
  countFixedNotes,
  reviewBlock,
  onJobChanged = () => {},
}: VersionRouteOptions): Hono {
  const routes = new Hono();

  routes.get('/:id/versions', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    return c.json({ versions: await versions.list(job) }, 200, { 'Cache-Control': 'no-store' });
  });

  routes.post('/:id/versions/:n/restore', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const n = versionNumber(c.req.param('n'));
    if (n === null) return c.json({ error: VERSION_MESSAGES.notFound }, 404);

    if (job.state !== 'review') return c.json({ error: VERSION_MESSAGES.notInReview }, 409);
    if (job.archivedAt !== null) return c.json({ error: VERSION_MESSAGES.archived }, 409);
    const unsent = countUnsentNotes(id);
    if (unsent > 0) {
      // Notes that all wait for nothing but Approve (they were fixed here) cannot be sent.
      const allFixed = (countFixedNotes?.(id) ?? 0) >= unsent;
      const message = allFixed
        ? REVIEW_MESSAGES.approveOrUndoFirst
        : REVIEW_MESSAGES.sendOrDeleteFirst;
      return c.json({ error: message }, 409);
    }
    const blocked = reviewBlock?.(job);
    if (blocked !== null && blocked !== undefined) return c.json({ error: blocked }, 409);

    try {
      const restored = await versions.restore(job, n);
      const saved = jobs.setPreview(id, {
        durationSec: restored.durationSec,
        width: restored.width,
        height: restored.height,
      });
      onJobChanged(saved);
      return c.json(jobFor(c, saved));
    } catch (err) {
      if (err instanceof VersionError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // `:path{.+}` is the rest of the URL, slashes included, percent-decoded once by Hono.
  routes.get('/:id/versions/:n/preview/:path{.+}', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    const n = versionNumber(c.req.param('n'));
    if (n === null || !(await versions.list(job)).some((version) => version.n === n)) {
      return c.json({ error: VERSION_MESSAGES.notFound }, 404);
    }

    const root = await resolveInside(
      join(inboxPath, job.relPath),
      join('edit', 'versions', versionDirName(n), 'preview'),
    );
    if (root === null || (await resolveInside(root, COMPOSITION_INDEX)) === null) {
      return c.json({ error: VERSION_MESSAGES.notFound }, 404);
    }
    return serveCompositionFile(c, {
      root,
      name: c.req.param('path'),
      missingMessage: PREVIEW_FILE_MISSING_MESSAGE,
    });
  });

  return routes;
}
