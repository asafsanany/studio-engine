// The series service (Series plan §3 and §5): everything the series routes and Send ask of series.
// The routes (routes/series.ts, K4) only do HTTP: every method answers a `SeriesOutcome`, which is
// either the body to send with its status or a refusal with its status and words, so a route maps
// it without knowing any rule:
//
//   const outcome = await series.start(jobId, name);
//   return outcome.ok ? c.json(outcome.body, outcome.status) : c.json({ error: outcome.error }, outcome.status);
//
//   method                     route                                 ok      refusals
//   list(clientId)             GET  /api/clients/:clientId/series    200     404 off
//   get(seriesId)              GET  /api/series/:seriesId            200     404 off, unknown series
//   start(jobId, name)         POST /api/jobs/:jobId/series          202     404 off, unknown job
//                                                                            409 not ready, in a series
//                                                                                already, a series pass
//                                                                                of the client queued or
//                                                                                running
//                                                                            422 a name seriesNameProblem
//                                                                                refuses, a name taken
//   useAsFormat(seriesId, jobId) POST /api/series/:seriesId/format   202     404 off, unknown series or job
//                                                                            409 not a ready episode of it,
//                                                                                the format already, a pass
//                                                                                queued or running
//   setJobSeries(jobId, id)    PUT  /api/jobs/:jobId/series          200     404 off, unknown job or series
//                                                                            409 the job has started
//                                                                            422 another client's series
//   undoStart(seriesId)        POST /api/series/:seriesId/undo       200     404 off, unknown series
//                                                                            409 past SERIES_UNDO_MS
//   retry(seriesId)            POST /api/series/:seriesId/retry      202     404 off, unknown series
//                                                                            409 not failed, a pass queued
//                                                                                or running
//   addNotes(seriesId, jobId, files)                                 200     404 off, unknown series
//                              (Send's Add to series hook)                   422 a file outside the
//                                                                                series folder
//   approved(job)              (the queue worker's afterReady, C26)  true when it queued a pass
//
// The words are the shared SERIES_MESSAGES, seriesNotFoundMessage, seriesNameProblem's and
// JobNotFoundError's. A body that is not JSON is the route's 400, before the service is asked.
//
// `onChange` tells the engine about every change, which it publishes as `series.changed` /
// `series.removed`; an install also lets the client's waiting jobs join by name (engine.ts).
//
// While the Series switch is off the engine uses `disabledSeriesService`: nothing to read, and
// every method refuses 404 "Series are off.". When it is on, `createSeriesService` is the real one:
// it checks each request, stores the series and its jobs, and queues the series passes on the
// client's style worker (style-worker.ts), which runs them and reports every change back here.
//
// Start a series stores the series (learning), puts the job in it as its format (pinned, its
// episode from its name) and queues a `start` pass. A style pass of the client that is queued or
// running (the Learn pass that approving the format episode queued) is no reason to refuse: the
// start waits behind it on the client's queue, the series learning meanwhile (C23). Use as the
// series format queues a `replace`
// pass, Retry the series' `last_pass` again. Undo of Start a series, within SERIES_UNDO_MS of
// `createdAt`, has the worker cancel or take back the pass, then takes every job out of the series,
// deletes the row and announces `removed`.
//
// Review notes marked Series (C26). Send writes them into a file in the series folder and Add to
// series records that file as waiting for its episode (`series.waiting_notes`); nothing runs yet,
// since the revise run has still to decide what the notes mean. When that episode is approved and
// reaches ready (`approved`, from the queue worker's `afterReady`), it becomes the series' format:
// a `replace` pass from it that carries its waiting notes, which then wait no more. The run writes
// each note under ## Notes with the value the episode has. An episode that is never approved
// (cancelled, failed, taken out of the series) changes nothing: its notes files stay in the folder.

import { readFile } from 'node:fs/promises';
import {
  type ClientSeriesResponse,
  canChangeSeries,
  episodeFrom,
  type Job,
  normalizeSeriesName,
  SERIES_MESSAGES,
  SERIES_UNDO_MS,
  type Series,
  type SeriesActionResponse,
  type SeriesResponse,
  type SetJobSeriesResponse,
  seriesNameProblem,
  seriesNotFoundMessage,
  type UndoSeriesResponse,
} from '@studio/shared';
import { z } from 'zod';
import {
  type ClientStyleRepository,
  JobNotFoundError,
  type JobRepository,
  SeriesNameTakenError,
  type SeriesRepository,
  type StoredSeries,
  toSeries,
} from '../db/index.js';
import { seriesIdFor } from '../inbox/scan.js';
import { type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import { seriesFileFor } from './paths.js';
import {
  parseSeriesPass,
  type SeriesFile,
  type SeriesPass,
  seriesFileSchema,
} from './style-pass.js';
import type { SeriesRunner } from './style-run.js';
import type { StyleWorker } from './style-worker.js';

/** A refusal: the status to answer with and the words for the person, sent as `{ error }`. */
export interface SeriesRefusal {
  ok: false;
  status: 404 | 409 | 422;
  error: string;
}

/** What a series method answers: the body to send and its status, or a refusal. */
export type SeriesOutcome<Body> = { ok: true; status: 200 | 202; body: Body } | SeriesRefusal;

/** What the engine hears after a series changed, and what it publishes on the bus for it. */
export type SeriesChange =
  /**
   * The series was created or changed. `installed` is true when this change installed a new
   * series.md (a series pass finished): the client's waiting jobs may now join it by name.
   */
  | { type: 'changed'; series: Series; installed: boolean }
  /** The series is gone (Undo, or its folder was deleted). Its jobs are told apart, as job changes. */
  | { type: 'removed'; seriesId: string; clientId: string };

export type SeriesChangeListener = (change: SeriesChange) => void;

export interface SeriesService {
  /** Whether series are on: false for {@link disabledSeriesService}. `/api/health` reports it. */
  readonly enabled: boolean;
  /** The client's series, by name, with their episode counts. A client with none has `[]`. */
  list(clientId: string): Promise<SeriesOutcome<ClientSeriesResponse>>;
  /** The series and its series.md (`markdown` is `null` while there is none). */
  get(seriesId: string): Promise<SeriesOutcome<SeriesResponse>>;
  /**
   * Start a series from the Ready job `jobId`, named `name`: the series (learning) is stored, the
   * job joins it, and a `series` pass in `start` mode is queued. Answers once it is queued.
   */
  start(jobId: string, name: string): Promise<SeriesOutcome<SeriesActionResponse>>;
  /** Use as the series format: queues a `series` pass in `replace` mode from the Ready episode `jobId`. */
  useAsFormat(seriesId: string, jobId: string): Promise<SeriesOutcome<SeriesActionResponse>>;
  /**
   * Puts a job that has not started (`canChangeSeries`) in the series `seriesId`, or takes it out
   * (`null`), and pins that choice: the name rule leaves it alone from then on. Its episode comes
   * from its name (`episodeFrom`), `null` without a number or outside a series.
   */
  setJobSeries(
    jobId: string,
    seriesId: string | null,
  ): Promise<SeriesOutcome<SetJobSeriesResponse>>;
  /**
   * Undo of Start a series, within `SERIES_UNDO_MS` of it (plan §3): a pass still queued or
   * running is stopped, an installed one is undone (the style.md and kit it replaced come back),
   * the series folder goes to its history, the row is deleted and its jobs leave it.
   */
  undoStart(seriesId: string): Promise<SeriesOutcome<UndoSeriesResponse>>;
  /** Runs the failed series pass again (the series' `last_pass`). */
  retry(seriesId: string): Promise<SeriesOutcome<SeriesActionResponse>>;
  /**
   * Add to series: records `files`, already written into the series folder (Send's review-note
   * file), as notes waiting for the approval of the episode `jobId` (C26). Nothing runs now.
   */
  addNotes(
    seriesId: string,
    jobId: string,
    files: readonly SeriesFile[],
  ): Promise<SeriesOutcome<SeriesActionResponse>>;
  /**
   * The queue worker's `afterReady` for an episode (C26): when the ready job has notes waiting in
   * its series, it becomes the series' format, a `replace` pass from it that carries them, queued
   * behind whatever the client's queue holds. Resolves true when it queued one; false for a job
   * with no notes waiting, one that is not ready or in no series, and while series are off.
   */
  approved(job: Job): Promise<boolean>;
  /** Calls `listener` after every change, once it is stored. Returns the function that stops it. */
  onChange(listener: SeriesChangeListener): () => void;
}

/** An answer to send: `body` with `status` (200 unless said). */
export function seriesOk<Body>(body: Body, status: 200 | 202 = 200): SeriesOutcome<Body> {
  return { ok: true, status, body };
}

/** A refusal with its status and words. */
export function seriesRefusal(status: SeriesRefusal['status'], error: string): SeriesRefusal {
  return { ok: false, status, error };
}

/** The refusal of every method while series are off: 404 "Series are off.". */
export const SERIES_OFF: SeriesRefusal = { ok: false, status: 404, error: SERIES_MESSAGES.off };

/**
 * The service while the Series switch is off (and until K2's real one is in): `enabled` is false,
 * there is nothing to read, every method refuses with {@link SERIES_OFF}, and nothing ever changes.
 */
export const disabledSeriesService: SeriesService = {
  enabled: false,
  list: async () => SERIES_OFF,
  get: async () => SERIES_OFF,
  start: async () => SERIES_OFF,
  useAsFormat: async () => SERIES_OFF,
  setJobSeries: async () => SERIES_OFF,
  undoStart: async () => SERIES_OFF,
  retry: async () => SERIES_OFF,
  addNotes: async () => SERIES_OFF,
  approved: async () => false,
  onChange: () => () => {},
};

/** 409, Retry: the stored pass of the failed series is not one the worker can run. */
export const SERIES_NOT_RERUNNABLE = 'The failed series run cannot be run again.';

/** 422, Add to series: a file that is not inside the series folder. */
export const SERIES_BAD_FILES = 'The notes must be files inside the series folder.';

export interface SeriesServiceOptions {
  /** `Config.inboxPath`: a series folder is `<inboxPath>/<Client>/_Series/<name>`. */
  inboxPath: string;
  jobs: Pick<JobRepository, 'get' | 'getAll' | 'setSeries'>;
  seriesRepo: Pick<
    SeriesRepository,
    | 'get'
    | 'getByName'
    | 'list'
    | 'summaries'
    | 'create'
    | 'update'
    | 'remove'
    | 'addWaitingNotes'
    | 'takeWaitingNotes'
  >;
  /** A client whose style is analysing can't take a new format or Retry a series (409). */
  clientStyles: Pick<ClientStyleRepository, 'get'>;
  /** The client's style queue, which runs the series passes too. */
  worker: Pick<
    StyleWorker,
    'attachSeries' | 'enqueueSeries' | 'hasStylePass' | 'hasSeriesPass' | 'undoSeriesStart'
  >;
  /** Runs the series passes. Default: the worker's style runner, when it can. */
  runner?: SeriesRunner;
  /** Called with every job the service or a series pass changed; the engine publishes `job.upsert`. */
  onJobChanged?: (job: Job) => void;
  logger?: RunnerLogger;
  /** Now: Undo works for SERIES_UNDO_MS after `createdAt`. */
  clock?: () => Date;
}

/** The series service while the Series switch is on (see the top of this file). */
export function createSeriesService(options: SeriesServiceOptions): SeriesService {
  const { inboxPath, jobs, seriesRepo, clientStyles, worker } = options;
  const logger = options.logger ?? SILENT_LOGGER;
  const clock = options.clock ?? (() => new Date());
  const listeners = new Set<SeriesChangeListener>();

  const emit = (change: SeriesChange): void => {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (err) {
        logger.warn({ err }, 'a series change listener failed');
      }
    }
  };
  const jobChanged = (job: Job): void => {
    try {
      options.onJobChanged?.(job);
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'a job change listener failed');
    }
  };

  worker.attachSeries({
    series: seriesRepo,
    jobs,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    onChanged: (stored, installed) =>
      emit({ type: 'changed', series: toSeries(stored), installed }),
    onJobChanged: jobChanged,
    clock,
  });

  const jobNotFound = (jobId: string) => seriesRefusal(404, new JobNotFoundError(jobId).message);
  const seriesNotFound = (seriesId: string) => seriesRefusal(404, seriesNotFoundMessage(seriesId));

  /** Why a series pass of the client can't be queued now (one of its series is busy), or null. */
  const seriesBusy = (clientId: string): SeriesRefusal | null =>
    worker.hasSeriesPass(clientId) ? seriesRefusal(409, SERIES_MESSAGES.seriesBusy) : null;

  /** Why a pass of the client can't be queued now (its style or one of its series is busy), or null. */
  const busy = (clientId: string): SeriesRefusal | null => {
    if (clientStyles.get(clientId)?.state === 'analysing' || worker.hasStylePass(clientId)) {
      return seriesRefusal(409, SERIES_MESSAGES.styleBusy);
    }
    return seriesBusy(clientId);
  };

  /** Queues `pass` and answers the series as it is then, `202`. */
  const queue = (stored: StoredSeries, pass: SeriesPass) => {
    const queued = worker.enqueueSeries(stored.client, pass) ?? stored;
    return seriesOk<SeriesActionResponse>({ series: toSeries(queued) }, 202);
  };

  /** Puts the job in a series or takes it out, and tells about it when that changed it. */
  const setSeries = (job: Job, seriesId: string | null, pinned: boolean): Job => {
    const episode = seriesId === null ? null : episodeFrom(job.name);
    const updated = jobs.setSeries(job.id, { seriesId, episode, pinned });
    if (updated.seriesId !== job.seriesId || updated.episode !== job.episode) jobChanged(updated);
    return updated;
  };

  const readMarkdown = async (stored: StoredSeries): Promise<string | null> => {
    try {
      return await readFile(seriesFileFor(inboxPath, stored.client, stored.name), 'utf8');
    } catch {
      return null;
    }
  };

  return {
    enabled: true,

    async list(clientId) {
      return seriesOk({ series: seriesRepo.summaries(clientId) });
    },

    async get(seriesId) {
      const stored = seriesRepo.get(seriesId);
      if (stored === null) return seriesNotFound(seriesId);
      return seriesOk({ series: toSeries(stored), markdown: await readMarkdown(stored) });
    },

    async start(jobId, name) {
      // Checked and stored without a pause, so two requests can't both pass the checks.
      const job = jobs.get(jobId);
      if (job === null) return jobNotFound(jobId);
      if (job.state !== 'ready') return seriesRefusal(409, SERIES_MESSAGES.notFinished);
      if (job.seriesId !== null && seriesRepo.get(job.seriesId) !== null) {
        return seriesRefusal(409, SERIES_MESSAGES.alreadyInSeries);
      }
      const problem = seriesNameProblem(name);
      if (problem !== null) return seriesRefusal(422, problem);
      // A style pass of the client is not a refusal: the start waits behind it (C23).
      const refused = seriesBusy(job.clientId);
      if (refused !== null) return refused;
      const seriesName = normalizeSeriesName(name);
      if (seriesRepo.getByName(job.clientId, seriesName) !== null) {
        return seriesRefusal(422, SERIES_MESSAGES.nameTaken);
      }

      // Stored with the pass it is about to run, so queuing it changes nothing more.
      const pass: SeriesPass = {
        kind: 'series',
        mode: 'start',
        seriesId: seriesIdFor(job.clientId, seriesName),
        series: seriesName,
        jobId: job.id,
        job: job.name,
      };
      let created: StoredSeries;
      try {
        created = seriesRepo.create({
          clientId: job.clientId,
          client: job.client,
          name: seriesName,
          formatJobId: job.id,
          formatJob: job.name,
          lastPass: pass,
        });
      } catch (err) {
        if (err instanceof SeriesNameTakenError) return seriesRefusal(422, err.message);
        throw err;
      }
      // The job is the series' format from now on; Undo takes it out again.
      setSeries(job, created.id, true);
      const queued = worker.enqueueSeries(job.client, pass) ?? created;
      emit({ type: 'changed', series: toSeries(queued), installed: false });
      logger.info(
        { seriesId: created.id, client: job.client, series: created.name, jobId: job.id },
        'series started',
      );
      return seriesOk<SeriesActionResponse>({ series: toSeries(queued) }, 202);
    },

    async useAsFormat(seriesId, jobId) {
      const stored = seriesRepo.get(seriesId);
      if (stored === null) return seriesNotFound(seriesId);
      const job = jobs.get(jobId);
      if (job === null) return jobNotFound(jobId);
      if (job.seriesId !== seriesId || job.state !== 'ready') {
        return seriesRefusal(409, SERIES_MESSAGES.notReadyEpisode);
      }
      if (stored.formatJobId === jobId) return seriesRefusal(409, SERIES_MESSAGES.formatAlready);
      const refused = busy(stored.clientId);
      if (refused !== null) return refused;
      logger.info({ seriesId, client: stored.client, jobId }, 'a new format for the series');
      return queue(stored, {
        kind: 'series',
        mode: 'replace',
        seriesId,
        series: stored.name,
        jobId: job.id,
        job: job.name,
      });
    },

    async setJobSeries(jobId, seriesId) {
      const job = jobs.get(jobId);
      if (job === null) return jobNotFound(jobId);
      const stored = seriesId === null ? null : seriesRepo.get(seriesId);
      if (seriesId !== null && stored === null) return seriesNotFound(seriesId);
      if (!canChangeSeries(job)) return seriesRefusal(409, SERIES_MESSAGES.jobStarted);
      if (stored !== null && stored.clientId !== job.clientId) {
        return seriesRefusal(422, SERIES_MESSAGES.otherClient);
      }
      return seriesOk<SetJobSeriesResponse>(setSeries(job, seriesId, true));
    },

    async undoStart(seriesId) {
      const stored = seriesRepo.get(seriesId);
      if (stored === null) return seriesNotFound(seriesId);
      if (clock().getTime() - Date.parse(stored.createdAt) > SERIES_UNDO_MS) {
        return seriesRefusal(409, SERIES_MESSAGES.undoTooLate);
      }
      await worker.undoSeriesStart(seriesId);
      // Another Undo of it may have finished meanwhile.
      if (seriesRepo.get(seriesId) === null) return seriesOk<UndoSeriesResponse>({ ok: true });
      for (const job of jobs.getAll()) {
        if (job.seriesId === seriesId) setSeries(job, null, false);
      }
      seriesRepo.remove(seriesId);
      emit({ type: 'removed', seriesId, clientId: stored.clientId });
      logger.info({ seriesId, client: stored.client, series: stored.name }, 'series start undone');
      return seriesOk<UndoSeriesResponse>({ ok: true });
    },

    async retry(seriesId) {
      const stored = seriesRepo.get(seriesId);
      if (stored === null) return seriesNotFound(seriesId);
      if (stored.state !== 'failed') return seriesRefusal(409, SERIES_MESSAGES.notFailed);
      const refused = busy(stored.clientId);
      if (refused !== null) return refused;
      const pass = parseSeriesPass(stored.lastPass);
      if (pass === null || pass.seriesId !== seriesId) {
        return seriesRefusal(409, SERIES_NOT_RERUNNABLE);
      }
      logger.info({ seriesId, client: stored.client, kind: pass.kind }, 'series pass tried again');
      return queue(stored, pass);
    },

    async addNotes(seriesId, jobId, files) {
      const stored = seriesRepo.get(seriesId);
      if (stored === null) return seriesNotFound(seriesId);
      const parsed = z.array(seriesFileSchema).safeParse(files);
      if (!parsed.success) return seriesRefusal(422, SERIES_BAD_FILES);
      if (parsed.data.length === 0)
        return seriesOk<SeriesActionResponse>({ series: toSeries(stored) });
      const waiting = seriesRepo.addWaitingNotes(
        seriesId,
        parsed.data.map((file) => ({ jobId, ...file })),
      );
      if (waiting === null) return seriesNotFound(seriesId);
      logger.info(
        { seriesId, client: stored.client, jobId, files: files.length },
        'review notes wait for the episode’s approval to go into the series',
      );
      return seriesOk<SeriesActionResponse>({ series: toSeries(stored) });
    },

    async approved(job) {
      if (job.state !== 'ready' || job.seriesId === null) return false;
      const stored = seriesRepo.get(job.seriesId);
      if (stored === null) return false;
      const notes = seriesRepo.takeWaitingNotes(stored.id, job.id);
      if (notes.length === 0) return false;
      logger.info(
        { seriesId: stored.id, client: stored.client, jobId: job.id, notes: notes.length },
        'an approved episode with Series notes becomes the series format',
      );
      queue(stored, {
        kind: 'series',
        mode: 'replace',
        seriesId: stored.id,
        series: stored.name,
        jobId: job.id,
        job: job.name,
        notes: notes.map(({ name, size }) => ({ name, size })),
      });
      return true;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
