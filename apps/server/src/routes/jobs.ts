// The jobs API (architecture §7), mounted at /api/jobs:
//
//   GET  /                      every job, with the derived placeInLine / settlesAt / etaSec (an editor
//                               gets the jobs of their clients only)
//   POST /archive              body { ids: string[] }, 1-200 ids, none twice: archives the jobs (hidden
//   POST /unarchive            from the lists, nothing else about them changes; `unarchive` shows them
//                               again); { jobs } are the named jobs afterwards, in the order of the
//                               request. All or nothing: 404 an unknown id, 409 (archive only) a job
//                               that is arriving, queued or editing, 400 a body that is not { ids }.
//                               A job event is published for each job that changed. Registered before
//                               the /:id routes, which have another number of segments anyway
//   POST /:id/start|hold|release|cancel|resume|retry|send-notes|approve|unapprove
//                               the job after the action; 404 unknown job, 409 the state machine
//                               refuses (or the job moved on while cancelling). `start` is Start
//                               now: arriving -> queued at once, 409 for any other state.
//                               `release?restore=1` puts a job that was queued when it was held
//                               back at the place it had in line, not at the back of it (the note
//                               dialog's release); `restore` means nothing to the other actions.
//                               `send-notes` (Send notes) and `approve` (Approve) work on a job in
//                               review and queue its revise or render run; 409 in any other state,
//                               and `send-notes` also 409s without unsent notes (or when every note is
//                               already fixed in Review) or while a voice note is being transcribed,
//                               `approve` while unsent notes exist that were not fixed in Review
//                               `unapprove` takes an approved video back to Review (the composition
//                               kept, no export pointed at); 409 for a job that is not ready, was
//                               never approved, or was delivered (Not delivered yet comes first)
//   PUT  /:id/note              body { note: string }; the job with its note saved (trimmed, empty
//                               clears it); 404 unknown job, 409 the job's state forbids editing
//                               the note, 400 a body that is not { note: string } or a note over
//                               4000 characters
//   PUT  /:id/effort            body { effort: "medium"|"high"|"xhigh"|null }; the job with
//                               its effort saved (null is Default: its runs use Extra high); 404
//                               unknown job, 409 while the job is editing or ready (open before a run
//                               and in review, where Send notes asks for the fixes at that level), 400
//                               a body that is not { effort } with one of those values
//   PUT  /:id/review-effort     body { effort: "auto"|"medium"|"high"|"xhigh" } (Quick fixes, QF4); the job
//                               with its review effort saved ("auto" is null: a small pass sorts each
//                               note and the quick ones are fixed in Review). 404 "Quick fixes are
//                               off." while the switch is off, 404 unknown job, 409 unless the job is
//                               in review, 400 a body that is not { effort } with one of those values.
//                               `job.upsert` is published; the first edit's effort is not touched
//   POST /:id/review-time       body { sec: 1-60 }: adds the seconds the owner spent in the Review dialog to
//                               the job's review time; { reviewSec } is the new total. 404 unknown job,
//                               409 unless the job is in review, 400 a body that is not { sec } with a
//                               whole number of seconds from 1 to 60. The job itself does not change,
//                               so no job event is published; the Money page's numbers do (the route
//                               tells `onReviewTime`, which the engine turns into `money.changed`)
//   PUT  /:id/name              body { name }; renames the job: its folder in the inbox, its export
//                               files (and the one without the song) and every row about it move
//                               to the new name, and so does its id (a hash of the folder's path).
//                               The job under its new id; 400 a name a folder cannot have, 404
//                               unknown job, 409 while the job is arriving, queued or editing, while
//                               a quick fix, its music or the file without the song is being made,
//                               or when a folder or an export of that name already exists
//   DELETE /:id                 deletes the job for good: stops its edit, removes its folder in the inbox,
//                               its export and its log, and every row about it (notes, timings,
//                               graphics used, delivery and payment). { id } when done; 404 when there
//                               is neither a job nor a delivery of that id. A delivered video whose
//                               folder is already gone can be deleted too
//   GET  /:id/download          the export of a `ready` job, as an attachment, with byte ranges.
//                               With `?file=no-song` (Songs on, SG8): the file without the song,
//                               "<Job> · no song.mp4", when the engine has made it; 404 until then.
//                               With `?format=<id>` (Formats, GN7, a job with two or more): that
//                               format's export, "<Job> (1x1).mp4" for an extra one; 404 for a
//                               format the job does not have. Without it: the main format's
//
// Every error answers `{ error: string }` (the shared `apiErrorSchema`). The state machine is the
// only judge of what is allowed: an action is applied through `JobRepository.applyTransition` and
// an `InvalidTransition` becomes the 409. `cancel` is the one action that also has to stop
// something, so it goes through the queue worker first.

import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  ARCHIVE_MAX_IDS,
  type ArchiveJobsResponse,
  archiveJobsRequestSchema,
  canRename,
  eventForAction,
  FIX_MESSAGES,
  InvalidTransition,
  JOB_ACTIONS,
  type Job,
  type JobAction,
  type JobActionOptions,
  jobActionPath,
  jobNameProblem,
  NO_SONG_MESSAGES,
  normalizeJobName,
  type ReviewTimeResponse,
  renameBlockedReason,
  renameJobRequestSchema,
  reviewEffortRequestSchema,
  reviewTimeRequestSchema,
  saveEffortRequestSchema,
  saveNoteRequestSchema,
} from '@studio/shared';
import { Hono } from 'hono';
import type { NoSongExports } from '../clients/no-song-export.js';
import {
  ArchiveRefusedError,
  type ArchiveResult,
  EffortNotEditableError,
  JobNotFoundError,
  JobRenameConflictError,
  type JobRepository,
  NoteNotEditableError,
  NoteTooLongError,
  ReviewTimeRefusedError,
} from '../db/index.js';
import { isIgnoredName, isReservedJobName } from '../inbox/classify.js';
import { jobIdFor, jobRelPath } from '../inbox/scan.js';
import { logger } from '../logger.js';
import { exportFileNamePart } from '../pipeline/finalize.js';
import { jobLogPath } from '../pipeline/job-log.js';
import { ReviewError, type ReviewService } from '../review/review-service.js';
import { type CanSee, clientFilter, jobFor } from '../team/viewer-scope.js';
import { sameOrMissing } from '../trash-path.js';
import { resolveInside, serveExport } from './download.js';

/** The part of the queue worker (E2) the routes use. Absent when no runner is available. */
export interface ActionWorker {
  /**
   * Stops the job's run and waits until it has really stopped. `null` means the worker has
   * nothing to stop for this job, so the route applies CANCEL itself.
   */
  cancel(jobId: string): Promise<Job | null>;
  /** A job may have become queued. */
  notify(): void;
}

export interface JobsRouteOptions {
  jobs: JobRepository;
  /** Omit when edits are paused: every action still works through the repository. */
  worker?: ActionWorker | null;
  /** Where the finished exports live; `Job.output.fileName` is relative to it. */
  exportsDir: string;
  /**
   * Called with the job after every action that changed it, before the worker is told about it.
   * The boot wiring publishes it as `job.upsert`. A listener that throws is logged and ignored.
   */
  onJobChanged?: (job: Job) => void;
  /**
   * Called after review time was added to a job (`POST /:id/review-time`). The boot wiring
   * publishes `money.changed`: review time is part of the Money page. A listener that throws is
   * logged and ignored.
   */
  onReviewTime?: () => void;
  /**
   * Called after archive or unarchive changed a job that has a delivery. The boot wiring
   * publishes `money.changed`: the Money page's "not paid yet" leaves archived jobs out (CVP-210).
   * A listener that throws is logged and ignored.
   */
  onMoneyChanged?: () => void;
  /**
   * Send notes and Approve with the note guards and the Send steps (W5). The engine always gives it.
   * Left out (the route tests), the two actions are plain state transitions, as W1 made them.
   */
  review?: Pick<ReviewService, 'sendNotes' | 'approve'> | null;
  /**
   * Stops what the engine runs for a job's music (Soundtrack: Make another, Pick), awaited before a
   * job is deleted, so nothing writes into its folder afterwards. (A job that is cancelled has its
   * music stopped by the music service, which follows the bus.) Left out while the Soundtrack
   * switch is off.
   */
  stopMusic?: (jobId: string) => Promise<void>;
  /**
   * Stops the quick fixes of a job (QF3: the running one is stopped and its copy put back, the
   * queued ones cancelled), awaited before a job is deleted for the same reason. Left out while the
   * Quick fixes switch is off.
   */
  stopFixes?: (jobId: string) => Promise<void>;
  /**
   * The second export, the file without the song (Songs, SG8): `?file=no-song` of the download
   * serves it, and a job that is deleted has its render stopped (awaited, so nothing writes into
   * its folder afterwards) and the file removed with its export. Left out while Songs is off.
   */
  noSong?: Pick<NoSongExports, 'statusFor' | 'stopJob' | 'relPathFor'>;
  /**
   * Why the engine is working in a job's folder right now (a quick fix, its music, the file without
   * the song), in words for the 409 of a rename, or `null` when it is not. Left out, nothing is.
   */
  inUse?: (job: Job) => Promise<string | null> | string | null;
  /** The inbox the job folders are in. Left out, `DELETE /:id` and `PUT /:id/name` leave the files alone. */
  inboxPath?: string;
  /** Where the job logs are (`<logsDir>/jobs/<id>.log`). */
  logsDir?: string;
  /** Called with the job's id after it was deleted; the boot wiring publishes `job.remove`. */
  onJobRemoved?: (id: string) => void;
  /** Which clients a viewer sees (Team plan); the app passes it. An editor's list holds only theirs. */
  canSee?: CanSee;
  /**
   * The Quick fixes switch (QF4): `PUT /:id/review-effort` exists only while it is on, else it
   * answers 404 "Quick fixes are off.". The app passes its own `quickFixes`. Default off.
   */
  quickFixes?: boolean;
}

/** The action was understood and is not allowed right now, for a reason other than the state. */
class ActionRefused extends Error {}

/** How a 409 names the action: "Cannot <words> a job that is queued." */
const ACTION_WORDS = {
  start: 'start',
  hold: 'hold',
  release: 'release',
  cancel: 'cancel',
  resume: 'resume',
  retry: 'retry',
  send_notes: 'send the notes of',
  approve: 'approve',
  unapprove: 'unapprove',
} as const satisfies Record<JobAction, string>;

export function createJobsRoutes({
  jobs,
  worker = null,
  exportsDir,
  onJobChanged,
  onReviewTime,
  onMoneyChanged,
  review = null,
  stopMusic,
  stopFixes,
  noSong,
  inUse,
  inboxPath,
  logsDir,
  onJobRemoved,
  canSee,
  quickFixes = false,
}: JobsRouteOptions): Hono {
  const routes = new Hono();

  /** Never fails the delete: a music call that cannot be stopped is logged. */
  async function stopMusicOf(id: string): Promise<void> {
    try {
      await stopMusic?.(id);
    } catch (err) {
      logger.error({ err, jobId: id }, 'could not stop the music of a job');
    }
  }

  /** Never fails the delete: a quick fix that cannot be stopped is logged. */
  async function stopFixesOf(id: string): Promise<void> {
    try {
      await stopFixes?.(id);
    } catch (err) {
      logger.error({ err, jobId: id }, 'could not stop the quick fixes of a job');
    }
  }

  /** Never fails the delete: a render that cannot be stopped is logged. */
  async function stopNoSongOf(id: string): Promise<void> {
    try {
      await noSong?.stopJob(id);
    } catch (err) {
      logger.error({ err, jobId: id }, 'could not stop the file without the song of a job');
    }
  }

  /** Applies `action` and returns the job as it is then. Throws what the routes turn into 404/409. */
  async function perform(id: string, action: JobAction, options: JobActionOptions): Promise<Job> {
    if (action === 'cancel' && worker !== null) {
      const stopped = await worker.cancel(id);
      if (stopped !== null) {
        // The run can end on its own while it is being stopped: the cancel did not happen then.
        if (stopped.state !== 'cancelled') {
          throw new ActionRefused(`Cannot cancel this job: it is ${stopped.state}.`);
        }
        return stopped;
      }
      // Nothing running to stop: CANCEL is applied below, which refuses states that forbid it.
    }
    if (action === 'unapprove') {
      // Money keeps the delivery of a job that leaves ready, so the way back is Not delivered yet first.
      const current = jobs.get(id);
      if (current?.state === 'ready' && current.delivery !== null) {
        throw new ActionRefused(
          'Cannot unapprove a video that was delivered. Mark it not delivered first.',
        );
      }
    }
    try {
      if (review !== null && action === 'send_notes') return await review.sendNotes(id);
      if (review !== null && action === 'approve') return await review.approve(id);
      return jobs.applyTransition(id, eventForAction(action, options));
    } catch (err) {
      if (err instanceof InvalidTransition) {
        throw new ActionRefused(`Cannot ${ACTION_WORDS[action]} a job that is ${err.state}.`);
      }
      throw err;
    }
  }

  function publish(job: Job): void {
    try {
      onJobChanged?.(job);
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'onJobChanged listener threw');
    }
  }

  routes.get('/', (c) => {
    // An editor's list holds the jobs of their clients only (Team plan, TM2).
    const visible = clientFilter(c, canSee);
    const all = jobs.getAll();
    const mine = visible === null ? all : all.filter((job) => visible(job.clientId));
    // An editor's jobs carry no money (the delivery keeps only its date).
    return c.json(mine.map((job) => jobFor(c, job)));
  });

  // Archive and unarchive many jobs at once. The two paths are one segment long and every /:id
  // route has a second one, so no job id can swallow them; they are registered first all the same.
  for (const [path, run] of [
    ['archive', (ids: string[]) => jobs.archive(ids)],
    ['unarchive', (ids: string[]) => jobs.unarchive(ids)],
  ] as const) {
    routes.post(`/${path}`, async (c) => {
      const badBody = {
        error: `Send the jobs as JSON: { "ids": ["<job id>", ...] }, from 1 to ${ARCHIVE_MAX_IDS} jobs, each named once.`,
      };
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(badBody, 400);
      }
      const parsed = archiveJobsRequestSchema.safeParse(body);
      if (!parsed.success) return c.json(badBody, 400);

      let result: ArchiveResult;
      try {
        result = run(parsed.data.ids);
      } catch (err) {
        if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
        if (err instanceof ArchiveRefusedError) return c.json({ error: err.message }, 409);
        throw err;
      }

      // Archiving changes nothing the worker waits for, so it is not woken.
      for (const job of result.changed) publish(job);
      // An archived delivery is not "not paid yet" on the Money page, so its numbers moved.
      if (result.changed.some((job) => job.delivery !== null)) {
        try {
          onMoneyChanged?.();
        } catch (err) {
          logger.error({ err }, 'onMoneyChanged listener threw');
        }
      }
      return c.json({
        jobs: result.jobs.map((job) => jobFor(c, job)),
      } satisfies ArchiveJobsResponse);
    });
  }

  // One route per action, so any other word after the id is an ordinary JSON 404.
  for (const action of JOB_ACTIONS) {
    routes.post(`/:id/${jobActionPath(action)}`, async (c) => {
      let job: Job;
      try {
        job = await perform(c.req.param('id'), action, {
          restorePlace: c.req.query('restore') === '1',
        });
      } catch (err) {
        if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
        if (err instanceof ActionRefused) return c.json({ error: err.message }, 409);
        if (err instanceof ReviewError) return c.json({ error: err.message }, err.status);
        throw err;
      }

      publish(job);
      // Start now, Release, Retry, Resume, Send notes and Approve put a job in the queue (Release
      // may also leave it `arriving`). Unapprove puts it in Review, which the worker does not wait for.
      if (job.state === 'queued') worker?.notify();
      return c.json(jobFor(c, job));
    });
  }

  routes.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null && !jobs.hasDelivery(id)) {
      return c.json({ error: `There is no job ${id}.` }, 404);
    }
    // Stop the edit first: the files must not change under it.
    if (job !== null) await stopMusicOf(id);
    if (job !== null) await stopFixesOf(id);
    if (job !== null) await stopNoSongOf(id);
    if (job !== null && worker !== null) {
      try {
        await worker.cancel(id);
      } catch (err) {
        logger.error({ err, jobId: id }, 'could not stop the edit of a job being deleted');
      }
    }
    // The database first, so the watcher finds no job when the folder disappears.
    jobs.purge(id);
    try {
      onJobRemoved?.(id);
    } catch (err) {
      logger.error({ err, jobId: id }, 'onJobRemoved listener threw');
    }
    try {
      onMoneyChanged?.();
    } catch (err) {
      logger.error({ err }, 'onMoneyChanged listener threw');
    }
    if (job !== null) {
      const doomed: string[] = [];
      if (inboxPath !== undefined && !job.relPath.split(/[\\/]/).includes('..')) {
        doomed.push(join(inboxPath, job.relPath));
      }
      if (job.output !== null) {
        // Formats (GN7): a job with more than one export deletes every one of them.
        const names = new Set([
          job.output.fileName,
          ...(job.output.outputs ?? []).map((output) => output.fileName),
        ]);
        for (const name of names) {
          const file = await resolveInside(exportsDir, name);
          if (file !== null) doomed.push(file);
        }
      }
      // The file without the song goes with the export it sits next to (Songs, SG8).
      const second = noSong?.relPathFor(job) ?? null;
      if (second !== null) {
        const file = await resolveInside(exportsDir, second);
        if (file !== null) doomed.push(file);
      }
      if (logsDir !== undefined) doomed.push(jobLogPath(logsDir, id));
      for (const path of doomed) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch (err) {
          logger.error({ err, path }, 'could not delete a file of a deleted job');
        }
      }
    }
    return c.json({ id });
  });

  routes.put('/:id/name', async (c) => {
    const badBody = { error: 'Send the name as JSON: { "name": "New name" }.' };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(badBody, 400);
    }
    const parsed = renameJobRequestSchema.safeParse(body);
    if (!parsed.success) return c.json(badBody, 400);
    const problem = jobNameProblem(parsed.data.name);
    if (problem !== null) return c.json({ error: problem }, 400);
    const name = normalizeJobName(parsed.data.name);
    if (isReservedJobName(name) || isIgnoredName(name)) {
      return c.json({ error: `“${name}” cannot be the name of a video. Pick another.` }, 400);
    }

    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `There is no job ${id}.` }, 404);
    if (!canRename(job)) return c.json({ error: renameBlockedReason(job) }, 409);
    // Same name (in NFC): nothing to move.
    if (job.name.normalize('NFC') === name) return c.json(jobFor(c, job));
    const busy = await inUse?.(job);
    if (busy !== undefined && busy !== null) return c.json({ error: busy }, 409);

    const relPath = jobRelPath(job.client, name);
    const newId = jobIdFor(relPath);
    const taken = jobs.getByRelPath(relPath);
    if (taken !== null && taken.id !== id) {
      return c.json({ error: new JobRenameConflictError(name).message }, 409);
    }

    // The export files follow the name: `Client/<Job>.mp4`, an extra format's `Client/<Job> (1x1).mp4`
    // and the file without the song. Only the files the job records are moved.
    const from = exportFileNamePart(job.name);
    const to = exportFileNamePart(name);
    const moved = new Map<string, string>();
    const track = (fileName: string | null): void => {
      if (fileName === null) return;
      const slash = fileName.lastIndexOf('/');
      const base = fileName.slice(slash + 1);
      if (!base.startsWith(from)) return;
      moved.set(fileName, `${fileName.slice(0, slash + 1)}${to}${base.slice(from.length)}`);
    };
    if (job.output !== null) {
      track(job.output.fileName);
      for (const file of job.output.outputs ?? []) track(file.fileName);
    }
    const noSongBefore = noSong?.relPathFor(job) ?? null;
    if (noSongBefore !== null) {
      const noSongAfter = noSong?.relPathFor({ ...job, name }) ?? null;
      if (noSongAfter !== null) moved.set(noSongBefore, noSongAfter);
    }
    const moves: { from: string; to: string }[] = [];
    for (const [before, after] of moved) {
      const source = await resolveInside(exportsDir, before);
      if (source === null) continue;
      const target = resolve(exportsDir, after);
      if ((await sameOrMissing(source, target)) === 'taken') {
        return c.json({ error: `A file called “${after}” is already in the exports.` }, 409);
      }
      moves.push({ from: source, to: target });
    }

    const oldDir = inboxPath === undefined ? null : join(inboxPath, job.relPath);
    const newDir = inboxPath === undefined ? null : join(inboxPath, relPath);
    if (oldDir !== null && newDir !== null && (await sameOrMissing(oldDir, newDir)) === 'taken') {
      return c.json({ error: `There is already a folder called “${name}” for this client.` }, 409);
    }

    // The folder first, then the exports, then the rows: each step that fails puts back the ones
    // before it, so a refusal leaves the video exactly as it was. The inbox watcher waits for the
    // folder to be quiet (500 ms), by which time the job is under its new id.
    const undo: (() => Promise<void>)[] = [];
    const rollBack = async (): Promise<void> => {
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch (err) {
          logger.error({ err, jobId: id }, 'could not put back a step of a rename');
        }
      }
    };
    let renamed: Job;
    try {
      if (oldDir !== null && newDir !== null) {
        await rename(oldDir, newDir);
        undo.push(() => rename(newDir, oldDir));
      }
      for (const move of moves) {
        await mkdir(dirname(move.to), { recursive: true });
        await rename(move.from, move.to);
        undo.push(() => rename(move.to, move.from));
      }
      const output =
        job.output === null
          ? null
          : {
              ...job.output,
              fileName: moved.get(job.output.fileName) ?? job.output.fileName,
              ...(job.output.outputs === undefined
                ? {}
                : {
                    outputs: job.output.outputs.map((file) => ({
                      ...file,
                      fileName: moved.get(file.fileName) ?? file.fileName,
                    })),
                  }),
            };
      renamed = jobs.rename(id, { name, relPath, newId, output });
    } catch (err) {
      await rollBack();
      if (err instanceof JobRenameConflictError) return c.json({ error: err.message }, 409);
      if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (
        code !== undefined &&
        ['EEXIST', 'ENOTEMPTY', 'ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(code)
      ) {
        logger.warn({ err, jobId: id }, 'could not rename the folder of a job');
        return c.json({ error: `Could not rename the folder: ${(err as Error).message}` }, 409);
      }
      throw err;
    }

    // The log follows the id. Never fails the rename: a job without a log has none to move.
    if (logsDir !== undefined) {
      try {
        await rename(jobLogPath(logsDir, id), jobLogPath(logsDir, newId));
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
          logger.error({ err, jobId: id }, 'could not move the log of a renamed job');
        }
      }
    }
    try {
      onJobRemoved?.(id);
    } catch (err) {
      logger.error({ err, jobId: id }, 'onJobRemoved listener threw');
    }
    publish(renamed);
    // The Money page lists the delivery by its name.
    if (renamed.delivery !== null) {
      try {
        onMoneyChanged?.();
      } catch (err) {
        logger.error({ err }, 'onMoneyChanged listener threw');
      }
    }
    return c.json(jobFor(c, renamed));
  });

  routes.put('/:id/note', async (c) => {
    const badBody = { error: 'Send the note as JSON: { "note": "text" }.' };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(badBody, 400);
    }
    const parsed = saveNoteRequestSchema.safeParse(body);
    if (!parsed.success) return c.json(badBody, 400);

    let job: Job;
    try {
      job = jobs.setNote(c.req.param('id'), parsed.data.note);
    } catch (err) {
      if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof NoteNotEditableError) return c.json({ error: err.message }, 409);
      if (err instanceof NoteTooLongError) return c.json({ error: err.message }, 400);
      throw err;
    }

    // A note changes nothing the worker waits for, so it is not woken.
    publish(job);
    return c.json(jobFor(c, job));
  });

  routes.put('/:id/effort', async (c) => {
    const badBody = {
      error: 'Send the effort as JSON: { "effort": "medium" | "high" | "xhigh" | null }.',
    };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(badBody, 400);
    }
    const parsed = saveEffortRequestSchema.safeParse(body);
    if (!parsed.success) return c.json(badBody, 400);

    let job: Job;
    try {
      job = jobs.setEffort(c.req.param('id'), parsed.data.effort);
    } catch (err) {
      if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof EffortNotEditableError) return c.json({ error: err.message }, 409);
      throw err;
    }

    // The effort changes nothing the worker waits for, so it is not woken.
    publish(job);
    return c.json(jobFor(c, job));
  });

  // The effort of the Review dialog's notes (Quick fixes, QF4). `jobs.effort`, the first edit's, stays
  // with PUT /:id/effort. Unknown job and job not in review are told apart, in that order.
  routes.put('/:id/review-effort', async (c) => {
    if (!quickFixes) return c.json({ error: FIX_MESSAGES.off }, 404);
    const badBody = {
      error: 'Send the effort as JSON: { "effort": "auto" | "medium" | "high" | "xhigh" }.',
    };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(badBody, 400);
    }
    const parsed = reviewEffortRequestSchema.safeParse(body);
    if (!parsed.success) return c.json(badBody, 400);

    const id = c.req.param('id');
    const current = jobs.get(id);
    if (current === null) return c.json({ error: `Job ${id} not found` }, 404);
    if (current.state !== 'review') return c.json({ error: FIX_MESSAGES.effortNotInReview }, 409);

    let job: Job;
    try {
      job = jobs.setReviewEffort(id, parsed.data.effort === 'auto' ? null : parsed.data.effort);
    } catch (err) {
      if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
      throw err;
    }

    // The effort changes nothing the worker waits for, so it is not woken. The fix service follows
    // the job.upsert: a job that left Auto loses its queued fixes.
    publish(job);
    return c.json(jobFor(c, job));
  });

  // The Review dialog's heartbeat (M3). Same order of answers as the notes routes: unknown job,
  // then a job that is not in review, then a body that cannot be used. The beacon sent when the
  // page closes is `text/plain` or `application/json`; the body is read as JSON either way.
  routes.post('/:id/review-time', async (c) => {
    const id = c.req.param('id');
    const job = jobs.get(id);
    if (job === null) return c.json({ error: `Job ${id} not found` }, 404);
    if (job.state !== 'review') {
      return c.json({ error: new ReviewTimeRefusedError(job).message }, 409);
    }

    const badBody = {
      error: 'Send the time as JSON: { "sec": 15 }, a whole number of seconds from 1 to 60.',
    };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(badBody, 400);
    }
    const parsed = reviewTimeRequestSchema.safeParse(body);
    if (!parsed.success) return c.json(badBody, 400);

    try {
      const reviewSec = jobs.addReviewSec(id, parsed.data.sec);
      try {
        onReviewTime?.();
      } catch (err) {
        logger.error({ err, jobId: id }, 'onReviewTime listener threw');
      }
      return c.json({ reviewSec } satisfies ReviewTimeResponse);
    } catch (err) {
      // The job left review, or was removed, between the check above and the write.
      if (err instanceof JobNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof ReviewTimeRefusedError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  // Hono answers HEAD with the GET handler; `serveExport` sends the headers and no body.
  routes.get('/:id/download', async (c) => {
    const job = jobs.get(c.req.param('id'));
    if (job === null) return c.json({ error: `Job ${c.req.param('id')} not found` }, 404);
    if (job.state !== 'ready' || job.output === null) {
      return c.json({ error: 'This job has no export yet.' }, 404);
    }

    // The second file, the one without the song (Songs, SG8).
    if (noSong !== undefined && c.req.query('file') === 'no-song') {
      const status = await noSong.statusFor(job);
      if (status.state !== 'ready') return c.json({ error: NO_SONG_MESSAGES.noFile }, 404);
      return serveExport(c, { path: status.path, downloadName: status.file });
    }

    // Formats (GN7): one file of a job with more than one; the main one is the file as before.
    const format = c.req.query('format');
    let fileName = job.output.fileName;
    let downloadName = `${job.name}.mp4`;
    if (format !== undefined) {
      const index = (job.output.outputs ?? []).findIndex((output) => output.format === format);
      const output = job.output.outputs?.[index];
      if (output === undefined)
        return c.json({ error: 'This job has no export in that format.' }, 404);
      fileName = output.fileName;
      if (index > 0) downloadName = `${job.name} (${format}).mp4`;
    }
    const path = await resolveInside(exportsDir, fileName);
    if (path === null) return c.json({ error: 'The export file is missing.' }, 404);
    return serveExport(c, { path, downloadName });
  });

  return routes;
}
