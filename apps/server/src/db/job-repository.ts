import {
  canArchive,
  canEditEffort,
  canEditNote,
  canvasesOfFormats,
  type Effort,
  episodeFrom,
  type InputCounts,
  inputCountsSchema,
  type Job,
  type JobEvent,
  type JobOutput,
  type JobPreview,
  type JobState,
  jobFormatsOf,
  NOTE_MAX_LENGTH,
  normalizeNote,
  type ReviseMinutes,
  type ReviseTier,
  SETTLE_MS,
  settleTime,
  transition,
} from '@studio/shared';
import { asc, count, desc, eq, inArray, isNotNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { clientIdFor, jobIdFor, jobRelPath, seriesIdFor } from '../inbox/scan.js';
import type { StudioDb } from './database.js';
import { DeliveryRepository } from './delivery-repository.js';
import { GenerateRepository } from './generate-repository.js';
import { InstagramRepository } from './instagram-repository.js';
import {
  applyBookkeeping,
  deliveryToJobDelivery,
  type JobMeta,
  relKeyOf,
  rowToJob,
  rowToMeta,
  rowToStored,
  type StoredJob,
  sameInputs,
  storedToColumns,
  toIso,
  toMs,
} from './mapping.js';
import { type FixSummary, NO_FIX_SUMMARY, QuickFixRepository } from './quick-fix-repository.js';
import {
  clientStyles,
  deliveries,
  fontRequests,
  fontUses,
  graphicUses,
  instagramAccounts,
  instagramReelReads,
  instagramReels,
  instagramScans,
  type JobRow,
  jobGenerate,
  jobs,
  lutUses,
  quickFixes,
  reviewNotes,
  seriesTable,
  stepRuns,
} from './schema.js';
import { StepRunRepository } from './step-run-repository.js';

/**
 * What one scan of a job folder reports (W1's `ScannedJob` has these fields and more, so a scan
 * result can be passed in as it is). Defined here so the database does not import the scanner.
 */
export interface ScanResult {
  /** `sha1(NFC(relPath))[0..12)`: the same for every spelling of one folder. */
  id: string;
  client: string;
  name: string;
  /** `Client/Job`, spelled as the file system lists it (not normalised). */
  relPath: string;
  inputs: InputCounts;
  sizeBytes: number;
  /** Seconds of video and audio; stored for the ETA, not part of the wire `Job`. */
  footageSec: number;
  /** Accepted so a whole `ScannedJob` fits, never stored: settle timers use event times. */
  newestMtimeMs?: number;
}

const scanResultSchema = z.object({
  id: z.string().min(1),
  client: z.string().min(1),
  name: z.string().min(1),
  relPath: z.string().min(1),
  inputs: inputCountsSchema,
  sizeBytes: z.number().int().nonnegative(),
  footageSec: z.number().nonnegative(),
  newestMtimeMs: z.number().nonnegative().optional(),
});

export type UpsertOutcome =
  /** A new job, `arriving`. */
  | 'created'
  /** Something the web app shows changed: the files (so the state machine ran) or the spelling. */
  | 'updated'
  /** Nothing visible changed (a footage length may still have been filled in). */
  | 'unchanged';

export interface UpsertResult {
  job: Job;
  outcome: UpsertOutcome;
}

/** What `archive` and `unarchive` answer: every named job afterwards, and the ones that changed. */
export interface ArchiveResult {
  /** The named jobs as they are now, in the order of the request, each once. */
  jobs: Job[];
  /** The ones this call changed (an archived job archived again, or a job that was not archived and is unarchived, is not). */
  changed: Job[];
}

/** Thrown when a rename would give a job the id of another one. The API answers 409. */
export class JobRenameConflictError extends Error {
  constructor(name: string) {
    super(`There is already a video called “${name}” for this client.`);
    this.name = 'JobRenameConflictError';
  }
}

/** What a rename changes about a job: its name and folder, so its id, and the names of its export files. */
export interface JobRename {
  /** The job's new name, the new name of its folder. */
  name: string;
  /** The new `Client/Job`, as the file system spells it. */
  relPath: string;
  /** `jobIdFor(relPath)`. */
  newId: string;
  /** The output with its file names rewritten (`Client/<new name>.mp4`); `null` for a job without one. */
  output: JobOutput | null;
}

/** Thrown when a client rename would give the client the id of one the engine knows. The API answers 409. */
export class ClientRenameConflictError extends Error {
  constructor(name: string) {
    super(`There is already a client called “${name}”.`);
    this.name = 'ClientRenameConflictError';
  }
}

/** What `renameClient` moved. */
export interface ClientRenameResult {
  /** The client's jobs under their new ids. */
  jobs: Job[];
  /** Each id that moved, the jobs' and those of deliveries whose folder was deleted: old and new. */
  movedIds: { from: string; to: string }[];
  /** Each series of the client: its old id and its new one. */
  movedSeries: { from: string; to: string }[];
  /** How many deliveries now carry the new name (the Money page lists them by it). */
  deliveries: number;
}

/** What `purgeClient` deleted. */
export interface ClientPurgeResult {
  /** The ids that went: the client's jobs' and those of deliveries whose folder was deleted. */
  jobIds: string[];
  /** The ids of the client's series. */
  seriesIds: string[];
  /** How many deliveries went (paid or not): the Money page lost them. */
  deliveries: number;
}

/** Thrown when an id has no job. The API answers 404. */
export class JobNotFoundError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job ${jobId} not found`);
    this.name = 'JobNotFoundError';
    this.jobId = jobId;
  }
}

/** Thrown by `setNote` for a note longer than `NOTE_MAX_LENGTH` once trimmed. The API answers 400. */
export class NoteTooLongError extends Error {
  readonly length: number;

  constructor(length: number) {
    super(`The note can be at most ${NOTE_MAX_LENGTH} characters.`);
    this.name = 'NoteTooLongError';
    this.length = length;
  }
}

/** Thrown by `setNote` for a job whose state forbids editing the note. The API answers 409. */
export class NoteNotEditableError extends Error {
  readonly jobId: string;
  readonly state: JobState;

  constructor(job: Pick<Job, 'id' | 'state'>) {
    super(`Cannot edit the note of a job that is ${job.state}.`);
    this.name = 'NoteNotEditableError';
    this.jobId = job.id;
    this.state = job.state;
  }
}

/** Thrown by `setEffort` for a job whose state forbids changing its effort. The API answers 409. */
export class EffortNotEditableError extends Error {
  readonly jobId: string;
  readonly state: JobState;

  constructor(job: Pick<Job, 'id' | 'state'>) {
    super(`Cannot change the effort of a job that is ${job.state}.`);
    this.name = 'EffortNotEditableError';
    this.jobId = job.id;
    this.state = job.state;
  }
}

/**
 * Thrown by `archive` for a job the engine is working on or about to work on (`canArchive` says
 * no: arriving, queued or editing). The message is plain words the owner can read. The API answers 409.
 */
export class ArchiveRefusedError extends Error {
  readonly jobId: string;
  readonly jobName: string;
  readonly state: JobState;

  constructor(job: Pick<Job, 'id' | 'name' | 'state'>) {
    super(`Can't archive "${job.name}" while it is ${job.state}.`);
    this.name = 'ArchiveRefusedError';
    this.jobId = job.id;
    this.jobName = job.name;
    this.state = job.state;
  }
}

/** Thrown by `addReviewSec` for a job that is not in review. The API answers 409. */
export class ReviewTimeRefusedError extends Error {
  readonly jobId: string;
  readonly state: JobState;

  constructor(job: Pick<Job, 'id' | 'state'>) {
    super(
      `Review time can only be counted while the job is in Review, and this job is ${job.state}.`,
    );
    this.name = 'ReviewTimeRefusedError';
    this.jobId = job.id;
    this.state = job.state;
  }
}

/**
 * Hook for the ETA estimator (E5): returns the seconds left for `job`, or `null` when there is
 * not enough history. Called at read time for queued and editing jobs, never stored, so the
 * answer changing does not touch `updatedAt`.
 */
export type EtaEstimator = (job: Job, footageSec: number) => number | null;

export interface JobRepositoryOptions {
  /** The clock for every timestamp the repository writes. Tests pass a fake. */
  clock?: () => Date;
  /** Defaults to "no estimate yet" (`etaSec` is always `null`). */
  estimateEtaSec?: EtaEstimator;
  /**
   * How long a job's folder must be quiet before it settles, `Config.settleMs` (default 60 s).
   * It decides the derived `settlesAt` and whether RELEASE sends a job back to `arriving` or on
   * to `queued`, so it must be the value the inbox watcher settles with.
   */
  settleMs?: number;
  /**
   * The Review switch (`Config.review`, W2). On: an edit run ends in Review and only a render run
   * may SUCCEED. Off (the default): an edit run SUCCEEDs to ready as before.
   */
  review?: boolean;
  /**
   * Manual start. On: a job the inbox finds is created `held` and waits for Start (Release);
   * nothing queues it by itself. Off (the default): it is created `arriving` and settles by
   * itself once its folder has been quiet for `settleMs`.
   */
  startHeld?: boolean;
  /**
   * The Quick fixes switch (`Config.quickFixes`). On: a job in Review carries `fixing` and
   * `fixedCount`, read from the `quick_fixes` table, so the Jobs list can say a note is being fixed
   * without asking for every job's fixes, and `reviseMinutes`, read from its `step_runs`, so the
   * Review footer can say how long a round of notes has taken on this job. Off (the default): they
   * are always `null`, 0 and `null`.
   */
  quickFixes?: boolean;
  /**
   * The Generate switch (`Config.generate`). On: a job that has a Generate stage carries
   * `generate` (read from `job_generate`), so the Jobs list can show it without asking for every
   * job's. Off (the default): no job carries it, whatever the table holds.
   */
  generate?: boolean;
}

// The queue runs the job that joined it first. `addedAt` and `id` only break exact ties, so the
// order is the same on every read.
const QUEUE_ORDER = [asc(jobs.settledAt), asc(jobs.addedAt), asc(jobs.id)] as const;

/**
 * Durable storage for jobs (architecture §5). This is the only code that maps rows to `Job`s and
 * the only writer of the `jobs` table; state changes go through the shared `transition`.
 *
 * Every method returns plain wire `Job`s. `placeInLine`, `settlesAt` and `etaSec` are computed
 * as the job is read and are never stored, and `delivery` is read from the `deliveries` table
 * (the job row has no column for it), so a change in them (another job joining the queue,
 * a new ETA) cannot change `updatedAt`. `fixing` and `fixedCount` (Quick fixes, only while the
 * switch is on) are read from the `quick_fixes` table the same way, for a job in Review, and so is
 * `reviseMinutes` from its `step_runs`. `generate` (Generated videos, only while the switch is on)
 * is read from `job_generate` the same way, and only a job with a row carries it. A delivery's
 * `uploadedAt` and `reelUrl` come from the `instagram_reels` row that links the job, if any.
 * `updatedAt` moves only when a write changes the job's
 * state, step/sub-progress, error, output or inputs/size, and it is set by `transition`.
 */
export class JobRepository {
  private readonly db: StudioDb;
  private readonly deliveries: DeliveryRepository;
  /** Read for the reel that links each delivered job (`delivery.uploadedAt` and `reelUrl`). */
  private readonly instagram: InstagramRepository;
  /** Read for the `fixing` and `fixedCount` of the jobs in Review; `null` while the Quick fixes switch is off. */
  private readonly fixSummaries: QuickFixRepository | null;
  /** Read for the `reviseMinutes` of the jobs in Review; `null` while the Quick fixes switch is off. */
  private readonly stepTimes: StepRunRepository | null;
  /** Read for the `generate` of the jobs that have a Generate stage; `null` while the Generate switch is off. */
  private readonly generates: GenerateRepository | null;
  private readonly clock: () => Date;
  private readonly estimateEtaSec: EtaEstimator;
  private readonly settleMs: number;
  private readonly review: boolean;
  private readonly startHeld: boolean;

  constructor(
    db: StudioDb,
    {
      clock = () => new Date(),
      estimateEtaSec = () => null,
      settleMs = SETTLE_MS,
      review = false,
      startHeld = false,
      quickFixes: quickFixesOn = false,
      generate: generateOn = false,
    }: JobRepositoryOptions = {},
  ) {
    this.db = db;
    this.deliveries = new DeliveryRepository(db);
    this.instagram = new InstagramRepository(db);
    this.fixSummaries = quickFixesOn ? new QuickFixRepository(db) : null;
    this.stepTimes = quickFixesOn ? new StepRunRepository(db) : null;
    this.generates = generateOn ? new GenerateRepository(db) : null;
    this.clock = clock;
    this.estimateEtaSec = estimateEtaSec;
    this.settleMs = settleMs;
    this.review = review;
    this.startHeld = startHeld;
  }

  /** Every job, most recently updated first. */
  getAll(): Job[] {
    const rows = this.db.orm.select().from(jobs).orderBy(desc(jobs.updatedAt), asc(jobs.id)).all();
    return this.hydrate(rows);
  }

  get(id: string): Job | null {
    const row = this.selectById(id);
    return row === undefined ? null : (this.hydrate([row])[0] ?? null);
  }

  /**
   * The job for `Client/Job`. Spellings compare in Unicode NFC, so the decomposed (NFD) and
   * precomposed (NFC) forms macOS can return for one folder find the same job.
   */
  getByRelPath(relPath: string): Job | null {
    const row = this.db.orm
      .select()
      .from(jobs)
      .where(eq(jobs.relKey, relKeyOf(relPath)))
      .get();
    return row === undefined ? null : (this.hydrate([row])[0] ?? null);
  }

  /**
   * The client folder names of all jobs, each as the latest scan of one of its jobs spelled it,
   * sorted. A client whose jobs were scanned in both NFC and NFD spellings appears twice; both
   * have the same `clientIdFor`.
   */
  clientNames(): string[] {
    return this.db.orm
      .selectDistinct({ client: jobs.client })
      .from(jobs)
      .orderBy(asc(jobs.client))
      .all()
      .map((row) => row.client);
  }

  /**
   * How many jobs each client folder name has and when the newest was added (ISO), sorted by name.
   * A client whose jobs were scanned in both NFC and NFD spellings has a line for each, like
   * {@link clientNames}: fold them with `clientIdFor`.
   */
  clientJobStats(): { client: string; jobs: number; lastAddedAt: string }[] {
    return this.db.orm
      .select({ client: jobs.client, jobs: count(), lastAddedAt: max(jobs.addedAt) })
      .from(jobs)
      .groupBy(jobs.client)
      .orderBy(asc(jobs.client))
      .all()
      .map((row) => ({
        client: row.client,
        jobs: row.jobs,
        // A group has at least one job, and every job has a time.
        lastAddedAt: toIso(row.lastAddedAt ?? 0),
      }));
  }

  /**
   * Jobs in the `editing` state. Nothing leaves `editing` on its own: after a crash this is the
   * list of jobs that were running, for startup recovery (E2/W3).
   */
  getEditing(): Job[] {
    const rows = this.db.orm
      .select()
      .from(jobs)
      .where(eq(jobs.state, 'editing'))
      .orderBy(asc(jobs.startedAt), asc(jobs.id))
      .all();
    return this.hydrate(rows);
  }

  /** The bookkeeping the web app does not see: footage length, attempt, start and finish times. */
  getMeta(id: string): JobMeta | null {
    const row = this.selectById(id);
    return row === undefined ? null : rowToMeta(row);
  }

  /** The queued job that joined the queue first (`placeInLine` 1), or `null` if none waits. */
  nextQueued(): Job | null {
    const row = this.db.orm
      .select()
      .from(jobs)
      .where(eq(jobs.state, 'queued'))
      .orderBy(...QUEUE_ORDER)
      .limit(1)
      .get();
    return row === undefined ? null : (this.hydrate([row])[0] ?? null);
  }

  /**
   * Records what a scan of a job folder found.
   *
   * - Unknown id: a new `arriving` job (`held` with `startHeld`); `addedAt` and `lastChangeAt` are now.
   * - Changed inputs or size: `FILES_CHANGED` goes through the state machine and its result is
   *   saved. States that ignore file changes (editing, review, ready, failed, cancelled) keep their
   *   stored inputs and size, so a scan can keep reporting the difference without any write.
   * - A different spelling of client, name or relPath (NFC vs NFD) is stored without touching
   *   `updatedAt`, as is a footage length when none was known or when the files changed.
   * - Anything else: no write.
   *
   * Jobs are matched by `id`, never by `relPath`.
   */
  upsertFromScan(input: ScanResult): UpsertResult {
    const scan = scanResultSchema.parse(input);
    return this.inTransaction(() => {
      const now = this.clock();
      const row = this.selectById(scan.id);

      if (row === undefined) {
        const at = now.toISOString();
        const created: StoredJob = {
          id: scan.id,
          clientId: clientIdFor(scan.client),
          client: scan.client,
          name: scan.name,
          relPath: scan.relPath,
          state: this.startHeld ? 'held' : 'arriving',
          step: null,
          subProgress: null,
          etaSec: null,
          placeInLine: null,
          settlesAt: this.startHeld ? null : settleTime(at, this.settleMs),
          failedAt: null,
          error: null,
          stoppedAt: null,
          inputs: scan.inputs,
          sizeBytes: scan.sizeBytes,
          addedAt: at,
          lastChangeAt: at,
          settledAt: null,
          heldSettledAt: null,
          updatedAt: at,
          output: null,
          note: null,
          runKind: 'edit',
          round: 0,
          preview: null,
          approvedAt: null,
          delivery: null,
          effort: null,
          reviewEffort: null,
          reviseTier: null,
          fixing: null,
          fixedCount: 0,
          reviseMinutes: null,
          seriesId: null,
          episode: null,
          archivedAt: null,
          footageSec: scan.footageSec,
          startedAt: null,
          finishedAt: null,
          attempt: 1,
          reviewSec: 0,
          seriesPinned: false,
        };
        this.db.orm
          .insert(jobs)
          .values({ id: created.id, ...storedToColumns(created) })
          .run();
        return { job: this.mustGet(scan.id), outcome: 'created' };
      }

      const stored = rowToStored(row, this.settleMs);
      let next: StoredJob = stored;
      let visible = false;

      let filesApplied = false;
      if (!sameInputs(stored.inputs, scan.inputs) || stored.sizeBytes !== scan.sizeBytes) {
        const after = transition(stored, { type: 'FILES_CHANGED' }, now, {
          settleMs: this.settleMs,
          review: this.review,
        });
        if (after !== stored) {
          next = { ...after, inputs: scan.inputs, sizeBytes: scan.sizeBytes };
          filesApplied = true;
          visible = true;
        }
      }

      if (
        scan.relPath !== stored.relPath ||
        scan.client !== stored.client ||
        scan.name !== stored.name
      ) {
        next = { ...next, relPath: scan.relPath, client: scan.client, name: scan.name };
        visible = true;
      }

      // A repeated scan of unchanged files can report 0 for a file ffprobe failed to read once;
      // only a first reading or a change in the files replaces a known length.
      if (scan.footageSec !== stored.footageSec && (filesApplied || stored.footageSec === 0)) {
        next = { ...next, footageSec: scan.footageSec };
      }

      if (next === stored) return { job: this.mustGet(scan.id), outcome: 'unchanged' };
      this.save(next);
      return { job: this.mustGet(scan.id), outcome: visible ? 'updated' : 'unchanged' };
    });
  }

  /**
   * Loads the job, runs `event` through the shared `transition` and saves the result, all in one
   * transaction, and returns the new job. An event the machine ignores or an invalid one writes
   * nothing: `InvalidTransition` propagates (the API answers 409) and the row is untouched.
   * Throws `JobNotFoundError` for an unknown id.
   *
   * Besides what the machine tracks: `START` sets `startedAt` (and clears `finishedAt`),
   * `PREVIEW_READY`/`SUCCEED`/`FAIL`/`CANCEL` set `finishedAt`, `RETRY` adds one to `attempt`, and
   * `SEND_NOTES`/`APPROVE` put `attempt` back to 1 (a new kind of run is a first attempt).
   * Whether an edit run may `SUCCEED` depends on the Review switch (`JobRepositoryOptions.review`).
   */
  applyTransition(id: string, event: JobEvent): Job {
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);

      const now = this.clock();
      const stored = rowToStored(row, this.settleMs);
      const next = transition(stored, event, now, {
        settleMs: this.settleMs,
        review: this.review,
      });
      if (next === stored) return this.mustGet(id);

      this.save(applyBookkeeping(next, event, now.toISOString()));
      return this.mustGet(id);
    });
  }

  /**
   * Saves the owner's note for the editor and returns the job. The note is trimmed and replaces the old
   * one; text that is empty once trimmed clears it (`null`). Allowed where `canEditNote` says so
   * (arriving, queued, held, failed, cancelled). `updatedAt` moves to now, whether or not the text
   * changed; nothing else about the job does (state, settle timer and queue place stay).
   *
   * Throws `NoteTooLongError` for more than `NOTE_MAX_LENGTH` characters (the API answers 400),
   * `JobNotFoundError` for an unknown id and `NoteNotEditableError` for a state that forbids it
   * (409). The job is read, checked and written in one transaction, so it cannot start editing in
   * between. Nothing is written when it throws.
   */
  setNote(id: string, note: string): Job {
    const text = normalizeNote(note);
    if (text !== null && text.length > NOTE_MAX_LENGTH) throw new NoteTooLongError(text.length);

    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);
      if (!canEditNote(row)) throw new NoteNotEditableError(row);

      this.db.orm
        .update(jobs)
        .set({ note: text, updatedAt: toMs(this.clock().toISOString()) })
        .where(eq(jobs.id, id))
        .run();
      return this.mustGet(id);
    });
  }

  /**
   * Saves the effort level of the job's edit and revise runs and returns the job; `null` is Default
   * (Extra high). Allowed where `canEditEffort` says so (arriving, queued, held, review, failed,
   * cancelled): in review, the fixes round that Send notes queues uses the level set here.
   * `updatedAt` moves to now, whether or not the level changed; nothing else about the job does
   * (state, settle timer and queue place stay).
   *
   * Throws `JobNotFoundError` for an unknown id and `EffortNotEditableError` for a state that
   * forbids it (409). The job is read, checked and written in one transaction, so it cannot start
   * editing in between. Nothing is written when it throws.
   */
  setEffort(id: string, effort: Effort | null): Job {
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);
      if (!canEditEffort(row)) throw new EffortNotEditableError(row);

      this.db.orm
        .update(jobs)
        .set({ effort, updatedAt: toMs(this.clock().toISOString()) })
        .where(eq(jobs.id, id))
        .run();
      return this.mustGet(id);
    });
  }

  /**
   * Saves the effort of the Review dialog's notes and returns the job (quick fixes): `null` is
   * Auto, a level makes every note wait for Send at that level. `jobs.effort`, the level of the
   * first edit, is not touched. `updatedAt` moves to now. Throws `JobNotFoundError` for an unknown
   * id; the route checks the job is in Review.
   */
  setReviewEffort(id: string, effort: Effort | null): Job {
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);

      this.db.orm
        .update(jobs)
        .set({ reviewEffort: effort, updatedAt: toMs(this.clock().toISOString()) })
        .where(eq(jobs.id, id))
        .run();
      return this.mustGet(id);
    });
  }

  /**
   * Saves the tier of the revise run a Send with Auto queued, the biggest among the notes it sent
   * (`revise` or `full`; `null` clears it), and returns the job (quick fixes). `updatedAt` moves to
   * now. Throws `JobNotFoundError` for an unknown id; the Send flow has checked the state.
   */
  setReviseTier(id: string, tier: ReviseTier | null): Job {
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);

      this.db.orm
        .update(jobs)
        .set({ reviseTier: tier, updatedAt: toMs(this.clock().toISOString()) })
        .where(eq(jobs.id, id))
        .run();
      return this.mustGet(id);
    });
  }

  /**
   * Saves the preview of the job's live composition (its length and frame size) and returns the
   * job. Restore calls it after it puts an earlier version back (VE1): the job stays in Review and
   * its round does not change. `updatedAt` moves to now. Throws `JobNotFoundError` for an unknown
   * id; the caller has checked the state.
   */
  setPreview(id: string, preview: JobPreview): Job {
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);

      this.db.orm
        .update(jobs)
        .set({ preview, updatedAt: toMs(this.clock().toISOString()) })
        .where(eq(jobs.id, id))
        .run();
      return this.mustGet(id);
    });
  }

  /**
   * Saves the sizes the job's brief asked for (Formats, GN7): `canvases` as the brief lists them,
   * the main one first. Only two or more different sizes count (`jobFormatsOf`); anything else
   * clears them, so a note that no longer asks for a second format takes it away again. The Brief
   * step calls it each time the brief is ready. `changed` says whether the job's formats are not
   * what they were (the caller then publishes the job); `updatedAt` does not move. Throws
   * `JobNotFoundError` for an unknown id.
   */
  setFormats(
    id: string,
    canvases: readonly string[] | null | undefined,
  ): { job: Job; changed: boolean } {
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);

      const next = canvasesOfFormats(jobFormatsOf(canvases));
      if (JSON.stringify(next) === JSON.stringify(row.formats ?? null)) {
        return { job: this.mustGet(id), changed: false };
      }
      this.db.orm.update(jobs).set({ formats: next }).where(eq(jobs.id, id)).run();
      return { job: this.mustGet(id), changed: true };
    });
  }

  /**
   * Archives the jobs: they stay exactly as they are, but are hidden from the lists (the web app
   * filters on `archivedAt`). Allowed where `canArchive` says so: not while a job is arriving,
   * queued or editing. A job that is already archived keeps its first date.
   *
   * All or nothing, in one transaction: an unknown id throws `JobNotFoundError` and a job that
   * cannot be archived throws `ArchiveRefusedError` (the API answers 404 and 409), and then no job
   * has changed. `updatedAt` does not move, so a job keeps its place in the list.
   *
   * `jobs` are all the named jobs as they are afterwards, in the order of `ids` (each once);
   * `changed` are the ones this call really changed.
   */
  archive(ids: readonly string[]): ArchiveResult {
    return this.inTransaction(() => {
      const rows = this.selectAll(ids);
      for (const row of rows) if (!canArchive(row)) throw new ArchiveRefusedError(row);

      const at = toMs(this.clock().toISOString());
      const changed = rows.filter((row) => row.archivedAt === null).map((row) => row.id);
      if (changed.length > 0) {
        this.db.orm.update(jobs).set({ archivedAt: at }).where(inArray(jobs.id, changed)).run();
      }
      return this.archiveResult(rows, changed);
    });
  }

  /**
   * Takes the jobs out of the archive: they show in the lists again, with nothing else changed.
   * A job that is not archived is left as it is (that includes one that left the archive on its
   * own, so there is no state that refuses). All or nothing, like {@link archive}: an unknown id
   * throws `JobNotFoundError` and then no job has changed. `updatedAt` does not move.
   */
  unarchive(ids: readonly string[]): ArchiveResult {
    return this.inTransaction(() => {
      const rows = this.selectAll(ids);
      const changed = rows.filter((row) => row.archivedAt !== null).map((row) => row.id);
      if (changed.length > 0) {
        this.db.orm.update(jobs).set({ archivedAt: null }).where(inArray(jobs.id, changed)).run();
      }
      return this.archiveResult(rows, changed);
    });
  }

  /**
   * The ids of the jobs that are archived now. The Money page reads it: an archived delivery is
   * not "not paid yet" (archived means paid already or not needed, CVP-210).
   */
  archivedIds(): Set<string> {
    const rows = this.db.orm
      .select({ id: jobs.id })
      .from(jobs)
      .where(isNotNull(jobs.archivedAt))
      .all();
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Adds `sec` whole seconds to the time the owner has spent in the Review dialog for the job (M3) and
   * returns the new total. Allowed only while the job is in review. Read, checked and written in
   * one transaction, so a job that leaves review in between is not counted. Nothing about the job
   * the web app shows changes, so `updatedAt` stays where it was and no event is published.
   *
   * Throws `RangeError` unless `sec` is a positive integer, `JobNotFoundError` for an unknown id
   * and `ReviewTimeRefusedError` for a job that is not in review (the API answers 409).
   */
  addReviewSec(id: string, sec: number): number {
    if (!Number.isInteger(sec) || sec < 1) {
      throw new RangeError(`Review time to add must be a whole number of seconds, got ${sec}.`);
    }
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);
      if (row.state !== 'review') throw new ReviewTimeRefusedError(row);

      const reviewSec = row.reviewSec + sec;
      this.db.orm.update(jobs).set({ reviewSec }).where(eq(jobs.id, id)).run();
      return reviewSec;
    });
  }

  /**
   * Puts the job in a series or takes it out (Series plan §2): `seriesId` (`null` for none), the
   * `episode` number and whether the owner picked it by hand (`pinned`, which the name rule then
   * respects), and returns the job. Nothing else changes, `updatedAt` included: joining a series
   * does not move a job in the Jobs list. The callers decide when a job may change series
   * (`canChangeSeries`, and the job a series starts from); this only writes it.
   *
   * Throws `JobNotFoundError` for an unknown id, and `RangeError` for an episode that is not a
   * whole number of 0 or more.
   */
  setSeries(
    id: string,
    {
      seriesId,
      episode,
      pinned,
    }: { seriesId: string | null; episode: number | null; pinned: boolean },
  ): Job {
    if (episode !== null && (!Number.isSafeInteger(episode) || episode < 0)) {
      throw new RangeError(`An episode must be a whole number of 0 or more, got ${episode}.`);
    }
    return this.inTransaction(() => {
      if (this.selectById(id) === undefined) throw new JobNotFoundError(id);
      this.db.orm
        .update(jobs)
        .set({ seriesId, episode, seriesPinned: pinned })
        .where(eq(jobs.id, id))
        .run();
      return this.mustGet(id);
    });
  }

  /** Deletes the job, its review notes and its Generate row (Phase 3 §1). Its step timings stay for the ETA. Returns whether the job existed. */
  remove(id: string): boolean {
    return this.inTransaction(() => {
      this.db.orm.delete(reviewNotes).where(eq(reviewNotes.jobId, id)).run();
      this.db.orm.delete(quickFixes).where(eq(quickFixes.jobId, id)).run();
      this.db.orm.delete(jobGenerate).where(eq(jobGenerate.jobId, id)).run();
      return this.db.orm.delete(jobs).where(eq(jobs.id, id)).run().changes > 0;
    });
  }

  /**
   * Deletes everything the database holds about the job `id`: the job, its notes and their quick
   * fixes, its step timings, the graphics it used and its delivery with the payment (the Money page loses the income). The
   * job may already be gone while its delivery is not (a deleted folder). Returns whether any row went.
   */
  purge(id: string): boolean {
    return this.inTransaction(() => this.purgeRows(id));
  }

  /**
   * Deletes everything the database holds about a client (`DELETE /api/clients/:clientId`): each
   * of its jobs as `purge` deletes one (the deliveries whose folder was deleted too, so the Money
   * page loses their income), its series, its stored style and its Instagram rows (account, scans,
   * reels and what they read), in one transaction. Returns what went, for the events. The caller
   * moves the folders and removes the files, the Instagram photo among them.
   */
  purgeClient(client: string): ClientPurgeResult {
    const clientId = clientIdFor(client);
    return this.inTransaction(() => {
      const orm = this.db.orm;
      const ids = new Set(
        orm
          .select()
          .from(jobs)
          .all()
          .filter((row) => clientIdFor(row.client) === clientId)
          .map((row) => row.id),
      );
      for (const delivery of orm
        .select()
        .from(deliveries)
        .where(eq(deliveries.clientId, clientId))
        .all()) {
        ids.add(delivery.jobId);
      }
      let gone = 0;
      for (const id of ids) {
        gone += orm.delete(deliveries).where(eq(deliveries.jobId, id)).run().changes;
        this.purgeRows(id);
      }
      const series = orm.select().from(seriesTable).where(eq(seriesTable.clientId, clientId)).all();
      orm.delete(seriesTable).where(eq(seriesTable.clientId, clientId)).run();
      orm.delete(clientStyles).where(eq(clientStyles.clientId, clientId)).run();
      // The Instagram rows of the client: its account, its scans, its reels and what they read.
      const reels = orm
        .select({ shortcode: instagramReels.shortcode })
        .from(instagramReels)
        .where(eq(instagramReels.clientId, clientId))
        .all()
        .map((reel) => reel.shortcode);
      const scans = orm
        .select({ id: instagramScans.id })
        .from(instagramScans)
        .where(eq(instagramScans.clientId, clientId))
        .all()
        .map((scan) => scan.id);
      // In slices: SQLite takes a limited number of variables in one statement.
      for (let at = 0; at < reels.length; at += 500) {
        orm
          .delete(instagramReelReads)
          .where(inArray(instagramReelReads.shortcode, reels.slice(at, at + 500)))
          .run();
      }
      for (let at = 0; at < scans.length; at += 500) {
        orm
          .delete(instagramReelReads)
          .where(inArray(instagramReelReads.scanId, scans.slice(at, at + 500)))
          .run();
      }
      orm.delete(instagramReels).where(eq(instagramReels.clientId, clientId)).run();
      orm.delete(instagramScans).where(eq(instagramScans.clientId, clientId)).run();
      orm.delete(instagramAccounts).where(eq(instagramAccounts.clientId, clientId)).run();
      return { jobIds: [...ids], seriesIds: series.map((one) => one.id), deliveries: gone };
    });
  }

  /**
   * `purge` without its transaction: the caller's. Whether any row went. The Instagram reel that
   * links the job stays, the client's own again: the job it linked is gone.
   */
  private purgeRows(id: string): boolean {
    const orm = this.db.orm;
    orm
      .update(instagramReels)
      .set({ jobId: null, linkedAt: null })
      .where(eq(instagramReels.jobId, id))
      .run();
    const gone = [
      orm.delete(reviewNotes).where(eq(reviewNotes.jobId, id)).run().changes,
      orm.delete(quickFixes).where(eq(quickFixes.jobId, id)).run().changes,
      orm.delete(jobGenerate).where(eq(jobGenerate.jobId, id)).run().changes,
      orm.delete(stepRuns).where(eq(stepRuns.jobId, id)).run().changes,
      orm.delete(graphicUses).where(eq(graphicUses.jobId, id)).run().changes,
      orm.delete(deliveries).where(eq(deliveries.jobId, id)).run().changes,
      orm.delete(jobs).where(eq(jobs.id, id)).run().changes,
    ];
    return gone.some((changes) => changes > 0);
  }

  /**
   * Gives the job a new name, and with it a new id (the id is a hash of the folder's path): the
   * job's row, and every row that points at it by id (notes and their quick fixes, step timings,
   * graphics, LUTs and fonts it used, its Generate row, its delivery with the payment, the client
   * style learned from it and the series started from it) move together, in one transaction. The
   * payment, the notes and the timings are kept; `updatedAt` is not touched, so the job keeps its
   * place in the list. An episode's number is read again from the new name. Returns the job under
   * its new id. Throws `JobNotFoundError` for an unknown id and `JobRenameConflictError` when a
   * job already has the new id. The caller moves the folder and the exports.
   */
  rename(id: string, change: JobRename): Job {
    const { newId } = change;
    return this.inTransaction(() => {
      const row = this.selectById(id);
      if (row === undefined) throw new JobNotFoundError(id);
      if (newId !== id && this.selectById(newId) !== undefined) {
        throw new JobRenameConflictError(change.name);
      }

      const orm = this.db.orm;
      this.moveJobRows(id, newId);
      orm
        .update(deliveries)
        .set({ name: change.name, relPath: change.relPath })
        .where(eq(deliveries.jobId, newId))
        .run();
      orm
        .update(seriesTable)
        .set({ formatJob: change.name })
        .where(eq(seriesTable.formatJobId, newId))
        .run();

      orm
        .update(jobs)
        .set({
          id: newId,
          name: change.name,
          relPath: change.relPath,
          relKey: relKeyOf(change.relPath),
          output: change.output,
          episode: row.seriesId === null ? null : episodeFrom(change.name),
        })
        .where(eq(jobs.id, id))
        .run();
      return this.mustGet(newId);
    });
  }

  /**
   * Gives a client a new name (`PUT /api/clients/:clientId/name`). Every id that is a hash of the
   * name is new too: the client's, each of its jobs' (`Client/Job`) and each of its series'. So,
   * in one transaction, the client's jobs move to the new name and their new ids, with every row
   * that points at them (as `rename` moves one job); its deliveries follow, those whose folder was
   * deleted too; its stored style, its series and its Instagram account, scans and reels move to
   * the new client id (a reel's link follows its job's new id), and the episodes to the new
   * series ids. Export file names that start with the client's folder (`Client/Job.mp4`)
   * start with the new one. Nothing else changes: states, payments, notes and `updatedAt` stay.
   * Throws `ClientRenameConflictError` when the engine already has anything under the new client
   * id. The caller moves the folders and files.
   */
  renameClient(from: string, to: string): ClientRenameResult {
    const fromId = clientIdFor(from);
    const toId = clientIdFor(to);
    const result: ClientRenameResult = { jobs: [], movedIds: [], movedSeries: [], deliveries: 0 };
    if (fromId === toId) return result;
    // The export files of a job are `<Client>/…` inside the exports.
    const moveFile = (fileName: string): string => {
      const slash = fileName.indexOf('/');
      return slash > 0 && clientIdFor(fileName.slice(0, slash)) === fromId
        ? `${to}${fileName.slice(slash)}`
        : fileName;
    };

    return this.inTransaction(() => {
      const orm = this.db.orm;
      const all = orm.select().from(jobs).all();
      const ofClient = (client: string, id: string) => clientIdFor(client) === id;
      if (
        all.some((row) => ofClient(row.client, toId)) ||
        orm.select().from(clientStyles).where(eq(clientStyles.clientId, toId)).get() !==
          undefined ||
        orm.select().from(seriesTable).where(eq(seriesTable.clientId, toId)).get() !== undefined ||
        orm.select().from(deliveries).where(eq(deliveries.clientId, toId)).get() !== undefined ||
        orm.select().from(instagramAccounts).where(eq(instagramAccounts.clientId, toId)).get() !==
          undefined ||
        orm.select().from(instagramScans).where(eq(instagramScans.clientId, toId)).get() !==
          undefined ||
        orm.select().from(instagramReels).where(eq(instagramReels.clientId, toId)).get() !==
          undefined
      ) {
        throw new ClientRenameConflictError(to);
      }

      const seriesIds = new Map<string, string>();
      for (const series of orm
        .select()
        .from(seriesTable)
        .where(eq(seriesTable.clientId, fromId))
        .all()) {
        const newSeriesId = seriesIdFor(toId, series.name);
        orm
          .update(seriesTable)
          .set({ id: newSeriesId, clientId: toId, client: to })
          .where(eq(seriesTable.id, series.id))
          .run();
        seriesIds.set(series.id, newSeriesId);
        result.movedSeries.push({ from: series.id, to: newSeriesId });
      }

      const moved: string[] = [];
      for (const row of all.filter((candidate) => ofClient(candidate.client, fromId))) {
        const relPath = jobRelPath(to, row.name);
        const newId = jobIdFor(relPath);
        if (this.selectById(newId) !== undefined) throw new ClientRenameConflictError(to);
        this.moveJobRows(row.id, newId);
        const output =
          row.output === null
            ? null
            : {
                ...row.output,
                fileName: moveFile(row.output.fileName),
                ...(row.output.outputs === undefined
                  ? {}
                  : {
                      outputs: row.output.outputs.map((file) => ({
                        ...file,
                        fileName: moveFile(file.fileName),
                      })),
                    }),
              };
        orm
          .update(jobs)
          .set({
            id: newId,
            client: to,
            relPath,
            relKey: relKeyOf(relPath),
            output,
            seriesId: row.seriesId === null ? null : (seriesIds.get(row.seriesId) ?? row.seriesId),
          })
          .where(eq(jobs.id, row.id))
          .run();
        result.movedIds.push({ from: row.id, to: newId });
        moved.push(newId);
      }

      // What is left under the old client id are the deliveries whose folder was deleted: their
      // ids follow the new name as well, so one is still the job's if its folder comes back.
      for (const delivery of orm
        .select()
        .from(deliveries)
        .where(eq(deliveries.clientId, fromId))
        .all()) {
        const newId = jobIdFor(jobRelPath(to, delivery.name));
        if (newId === delivery.jobId) continue;
        this.moveJobRows(delivery.jobId, newId);
        result.movedIds.push({ from: delivery.jobId, to: newId });
      }
      for (const { to: newId } of result.movedIds) {
        const delivery = orm.select().from(deliveries).where(eq(deliveries.jobId, newId)).get();
        if (delivery === undefined) continue;
        orm
          .update(deliveries)
          .set({ clientId: toId, client: to, relPath: jobRelPath(to, delivery.name) })
          .where(eq(deliveries.jobId, newId))
          .run();
        result.deliveries += 1;
      }

      orm
        .update(clientStyles)
        .set({ clientId: toId, client: to })
        .where(eq(clientStyles.clientId, fromId))
        .run();
      // The Instagram rows follow the client id; the reels' links follow the jobs' new ids above.
      orm
        .update(instagramAccounts)
        .set({ clientId: toId, client: to })
        .where(eq(instagramAccounts.clientId, fromId))
        .run();
      orm
        .update(instagramScans)
        .set({ clientId: toId })
        .where(eq(instagramScans.clientId, fromId))
        .run();
      orm
        .update(instagramReels)
        .set({ clientId: toId })
        .where(eq(instagramReels.clientId, fromId))
        .run();

      result.jobs = moved.map((id) => this.mustGet(id));
      return result;
    });
  }

  /**
   * Points every row about job `id` at `newId`: its notes and their quick fixes, step timings,
   * graphics, LUTs and fonts it used, its Generate row, its delivery, the Instagram reel that links
   * it, the client style learned from it, the series started from it and the series notes waiting
   * for it. The job's own row is the caller's. Runs inside the caller's transaction.
   */
  private moveJobRows(id: string, newId: string): void {
    const orm = this.db.orm;
    orm.update(reviewNotes).set({ jobId: newId }).where(eq(reviewNotes.jobId, id)).run();
    orm.update(quickFixes).set({ jobId: newId }).where(eq(quickFixes.jobId, id)).run();
    orm.update(jobGenerate).set({ jobId: newId }).where(eq(jobGenerate.jobId, id)).run();
    orm.update(stepRuns).set({ jobId: newId }).where(eq(stepRuns.jobId, id)).run();
    orm.update(graphicUses).set({ jobId: newId }).where(eq(graphicUses.jobId, id)).run();
    orm.update(lutUses).set({ jobId: newId }).where(eq(lutUses.jobId, id)).run();
    orm.update(fontUses).set({ jobId: newId }).where(eq(fontUses.jobId, id)).run();
    orm.update(fontRequests).set({ jobId: newId }).where(eq(fontRequests.jobId, id)).run();
    orm.update(deliveries).set({ jobId: newId }).where(eq(deliveries.jobId, id)).run();
    orm.update(instagramReels).set({ jobId: newId }).where(eq(instagramReels.jobId, id)).run();
    orm
      .update(clientStyles)
      .set({ sourceJobId: newId })
      .where(eq(clientStyles.sourceJobId, id))
      .run();
    orm
      .update(seriesTable)
      .set({ formatJobId: newId })
      .where(eq(seriesTable.formatJobId, id))
      .run();
    // The review-note files that wait for an episode's approval name the episode by id.
    for (const series of orm
      .select()
      .from(seriesTable)
      .where(isNotNull(seriesTable.waitingNotes))
      .all()) {
      const waiting = series.waitingNotes ?? [];
      if (!waiting.some((note) => note.jobId === id)) continue;
      orm
        .update(seriesTable)
        .set({
          waitingNotes: waiting.map((note) =>
            note.jobId === id ? { ...note, jobId: newId } : note,
          ),
        })
        .where(eq(seriesTable.id, series.id))
        .run();
    }
  }

  /** Whether a delivery (paid or not) is recorded for this job id, whether or not the job exists. */
  hasDelivery(id: string): boolean {
    return (
      this.db.orm.select().from(deliveries).where(eq(deliveries.jobId, id)).get() !== undefined
    );
  }

  // better-sqlite3's own transaction wraps drizzle's synchronous queries (same connection), and
  // `immediate` takes the write lock up front. A throw rolls everything back and propagates.
  private inTransaction<T>(work: () => T): T {
    return this.db.sqlite.transaction(work).immediate();
  }

  private selectById(id: string): JobRow | undefined {
    return this.db.orm.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  /** The rows of the named jobs, each once, in the order named. Throws for the first unknown id. */
  private selectAll(ids: readonly string[]): JobRow[] {
    const unique = [...new Set(ids)];
    const found = new Map<string, JobRow>();
    if (unique.length > 0) {
      for (const row of this.db.orm.select().from(jobs).where(inArray(jobs.id, unique)).all()) {
        found.set(row.id, row);
      }
    }
    return unique.map((id) => {
      const row = found.get(id);
      if (row === undefined) throw new JobNotFoundError(id);
      return row;
    });
  }

  /** The named jobs read again as `Job`s, in the order named, with the ones whose ids are `changedIds`. */
  private archiveResult(rows: JobRow[], changedIds: readonly string[]): ArchiveResult {
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return { jobs: [], changed: [] };
    const after = this.db.orm.select().from(jobs).where(inArray(jobs.id, ids)).all();
    const byId = new Map(this.hydrate(after).map((job) => [job.id, job]));
    const all = ids.flatMap((id) => byId.get(id) ?? []);
    return { jobs: all, changed: all.filter((job) => changedIds.includes(job.id)) };
  }

  private mustGet(id: string): Job {
    const job = this.get(id);
    if (job === null) throw new JobNotFoundError(id);
    return job;
  }

  private save(job: StoredJob): void {
    this.db.orm.update(jobs).set(storedToColumns(job)).where(eq(jobs.id, job.id)).run();
  }

  /** Queued job ids in queue order. */
  private queueIds(): string[] {
    return this.db.orm
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.state, 'queued'))
      .orderBy(...QUEUE_ORDER)
      .all()
      .map((row) => row.id);
  }

  /** Rows to `Job`s, with the fields that are derived rather than stored filled in. */
  private hydrate(rows: JobRow[]): Job[] {
    const place = new Map<string, number>();
    if (rows.some((row) => row.state === 'queued')) {
      this.queueIds().forEach((id, index) => {
        place.set(id, index + 1);
      });
    }
    // `Job.delivery` is read from the deliveries table, which holds a row per delivered job.
    const delivered = this.deliveries.getMany(rows.map((row) => row.id));
    // ...and a delivery of a job that a reel links says where the video went on Instagram: one
    // read for all of them, never stored (Clients × Instagram, IG5). A linked job stays Uploaded
    // while the Instagram switch is off, so this does not look at the switch.
    const reels = this.instagram.reelLinksOfJobs([...delivered.keys()]);
    // `Job.fixing` and `fixedCount`: the fixes of the round being written, for the jobs in Review.
    const fixed =
      this.fixSummaries?.summaries(
        rows
          .filter((row) => row.state === 'review')
          .map((row) => ({ id: row.id, round: row.round + 1 })),
      ) ?? new Map<string, FixSummary>();
    // `Job.reviseMinutes`: how long the earlier revise runs of a job in Review took (C61).
    const revised =
      this.stepTimes?.reviseMinutes(
        rows.filter((row) => row.state === 'review').map((row) => row.id),
      ) ?? new Map<string, ReviseMinutes>();
    // `Job.generate`: the Generate stage of a generated job, only while the Generate switch is on.
    const generated = this.generates?.states(rows.map((row) => row.id)) ?? new Map();
    return rows.map((row) => {
      const delivery = delivered.get(row.id);
      const { fixing, fixedCount } = fixed.get(row.id) ?? NO_FIX_SUMMARY;
      const job = rowToJob(
        row,
        {
          placeInLine: place.get(row.id) ?? null,
          etaSec: null,
          delivery:
            delivery === undefined
              ? null
              : deliveryToJobDelivery(delivery, reels.get(row.id) ?? null),
          fixing,
          fixedCount,
          reviseMinutes: revised.get(row.id) ?? null,
        },
        this.settleMs,
      );
      const state = generated.get(row.id);
      // Only a job with a Generate stage carries the key: every other job's shape is unchanged.
      const withGenerate = state === undefined ? job : { ...job, generate: state };
      if (row.state !== 'queued' && row.state !== 'editing') return withGenerate;
      const etaSec = this.estimateEtaSec(withGenerate, row.footageSeconds);
      return etaSec === null ? withGenerate : { ...withGenerate, etaSec };
    });
  }
}
