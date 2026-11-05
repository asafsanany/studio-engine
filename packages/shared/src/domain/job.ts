import { z } from 'zod';
import { effortSchema } from './effort.ts';
import { jobFormatSchema, jobOutputFileSchema } from './formats.ts';
import { generateStateSchema } from './generate.ts';
import { calendarDaySchema } from './money.ts';
import { runKindSchema } from './run-kind.ts';
import { type JobState, type JobStatusGroup, jobStateSchema } from './status.ts';
import { stepIdSchema } from './steps.ts';

/** A UTC timestamp as produced by `Date.prototype.toISOString()`, e.g. `2026-10-20T13:41:00.000Z`. */
export const isoTimestampSchema = z.iso.datetime();

const countSchema = z.number().int().nonnegative();

/** How many files of each kind the job folder holds. All four keys are always present. */
export const inputCountsSchema = z.object({
  video: countSchema,
  audio: countSchema,
  image: countSchema,
  doc: countSchema,
});
export type InputCounts = z.infer<typeof inputCountsSchema>;

/**
 * The kinds of revise run a Send can ask for with Auto effort (quick fixes, QF0): `revise` (one part
 * of the cut or one baked step, Sonnet at High with a slim self-check) or `full` (today's run). The
 * third tier of the difficulty index, `quick`, is fixed in Review and never runs on Send; the
 * tiers and what each runs with are in quick-fixes.ts.
 */
export const REVISE_TIERS = ['revise', 'full'] as const;
export const reviseTierSchema = z.enum(REVISE_TIERS);
export type ReviseTier = z.infer<typeof reviseTierSchema>;

/**
 * A time range in whole minutes, shortest to longest ("12 to 40 min"): how long a round of notes
 * has taken on a job (`Job.reviseMinutes`), or is expected to take (`TIER_MINUTES`). `max` is at
 * least `min`, and both are at least 1.
 */
export const reviseMinutesSchema = z
  .object({ min: z.number().int().positive(), max: z.number().int().positive() })
  .refine((range) => range.max >= range.min, { message: 'max is below min', path: ['max'] });
export type ReviseMinutes = z.infer<typeof reviseMinutesSchema>;

/** The finished export, filled in once the job is `ready`. */
export const jobOutputSchema = z.object({
  /** The export's path relative to the exports folder, e.g. `Client/Job.mp4`. */
  fileName: z.string().min(1),
  durationSec: z.number().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sizeBytes: countSchema,
  /**
   * Formats (GN7): every exported file of a job with two or more formats, the main one first (the
   * main one is `fileName` above too). Absent for a job with one format, whose output is what it
   * always was. A job is still one job: deliveries and Money count it once.
   */
  outputs: z.array(jobOutputFileSchema).min(2).optional(),
});
export type JobOutput = z.infer<typeof jobOutputSchema>;

/**
 * The live composition an edit or revise run leaves in edit/preview/: its length and frame size,
 * read from the root element's data-duration, data-width and data-height (W2).
 */
export const jobPreviewSchema = z.object({
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type JobPreview = z.infer<typeof jobPreviewSchema>;

/**
 * A job's delivery (Phase 4 §2): the row the owner's Mark delivered writes, as the job carries it.
 * `deliveredAt` is when they marked it, `price` and `currency` are frozen then, and `paidOn` is the
 * calendar day the money came in (YYYY-MM-DD), `null` while the job is not paid. `paidAmount` is
 * what the client actually paid, typed in Mark paid (it can be ₪0); `null` while the job is not
 * paid and on a job paid before it could be typed, which was paid its `price` ({@link paidAmountOf}).
 *
 * Money is the admin's alone (Team plan): the server leaves `price`, `currency`, `paidOn` and
 * `paidAmount` out of the delivery of every job it sends to an editor ({@link withoutJobMoney}),
 * who is left with `deliveredAt` and so sees the video as Delivered, never as Paid. The admin's
 * delivery always has them all, so they are optional only for that reason.
 *
 * `uploadedAt` and `reelUrl` are where the video went on Instagram (Clients × Instagram): when the
 * reel a person linked to the job was posted (ISO) and its link. Both are absent while no reel
 * links the job, which is how a job is Uploaded (`jobStage`). `reelPlays` is the linked reel's
 * plays as its latest scan read them: the Jobs page's Uploaded row says it ("27.5K plays"); it is
 * absent when the reel's plays are not known. None of them is money, so an editor keeps them.
 */
export const jobDeliverySchema = z.object({
  deliveredAt: isoTimestampSchema,
  price: z.number().nonnegative().optional(),
  currency: z.string().min(1).optional(),
  paidOn: calendarDaySchema.nullable().optional(),
  paidAmount: z.number().nonnegative().nullable().optional(),
  uploadedAt: isoTimestampSchema.optional(),
  reelUrl: z.string().min(1).optional(),
  reelPlays: countSchema.optional(),
});
export type JobDelivery = z.infer<typeof jobDeliverySchema>;

/**
 * What a delivered video earns: what the client paid once it is paid (`paidAmount`), else the price
 * it was delivered at. A paid video with no amount was paid before one could be typed: its price.
 */
export function paidAmountOf(delivery: { price: number; paidAmount?: number | null }): number {
  return delivery.paidAmount ?? delivery.price;
}

/**
 * One job as the server sends it and the web app shows it. Every field is always present; "none"
 * is `null`. `etaSec`, `placeInLine` and `settlesAt` are derived at read time, never stored.
 */
export const jobSchema = z.object({
  /** Stable hash of `relPath`. */
  id: z.string().min(1),
  /** Stable hash of the client folder name (first 12 hex characters of sha1, NFC): the key of the client pages. */
  clientId: z.string().min(1),
  client: z.string().min(1),
  name: z.string().min(1),
  /** `Client/Job`, relative to the inbox. */
  relPath: z.string().min(1),
  state: jobStateSchema,
  /** Current step while editing; kept when the job fails or is cancelled. */
  step: stepIdSchema.nullable(),
  /** Free text inside the step, e.g. `6/14`, `graphics 2/5`, `pass 2/3`. */
  subProgress: z.string().min(1).nullable(),
  /** Estimated seconds left; `null` when there is not enough history to say. */
  etaSec: z.number().nonnegative().nullable(),
  /** When the current run started; only for `editing` jobs (the Jobs page counts up from it). */
  runningSince: isoTimestampSchema.nullable().optional(),
  /** 1-based position in the queue; only for `queued` jobs. */
  placeInLine: z.number().int().positive().nullable(),
  /** When the settle timer fires; only for `arriving` jobs. */
  settlesAt: isoTimestampSchema.nullable(),
  /** The step a `failed` job stopped at. */
  failedAt: stepIdSchema.nullable(),
  error: z.string().min(1).nullable(),
  /** The step a `cancelled` job was stopped at. */
  stoppedAt: stepIdSchema.nullable(),
  inputs: inputCountsSchema,
  /** Total size of the input files. */
  sizeBytes: countSchema,
  addedAt: isoTimestampSchema,
  /**
   * When files in the job folder last changed (equals `addedAt` for a new job). The settle timer
   * runs 60 s from here, and `release` on a held job uses it to choose `arriving` or `queued`.
   */
  lastChangeAt: isoTimestampSchema,
  /**
   * When the job last joined the queue; the queue runs oldest first. `null` while the job is
   * `arriving` or `held`, and for a job that has never been queued.
   */
  settledAt: isoTimestampSchema.nullable(),
  /**
   * While `held`: when the job joined the queue before it was held (its `settledAt` then), so that
   * a release that restores the place (`restorePlace`, what the note dialog sends) can put it back
   * where it stood in line. `null` for a job that was arriving when it was held, for a job held
   * before this field existed, and in every state but `held`.
   */
  heldSettledAt: isoTimestampSchema.nullable(),
  /**
   * Last time the job's state, step/sub-progress, error, output, input files or note changed. Not bumped
   * by ETA or place-in-line changes, nor by archiving. The Jobs table sorts by this, newest first,
   * by default.
   */
  updatedAt: isoTimestampSchema,
  output: jobOutputSchema.nullable(),
  /**
   * The owner's note for the editor ("keep it under 30 seconds"), trimmed; `null` when there is none.
   * It is edited with `PUT /api/jobs/:id/note` while `canEditNote(job)`. Saving it bumps `updatedAt`.
   */
  note: z.string().min(1).nullable(),
  /**
   * The effort level the job's edit and revise runs use (`claude --effort`); `null` is Default,
   * which is `DEFAULT_EFFORT` (Extra high). It is set with `PUT /api/jobs/:id/effort` while
   * `canEditEffort(job)` (before a run, and in review, to ask for the fixes at another level), and
   * kept for every run of the job. The render run ignores it.
   */
  effort: effortSchema.nullable(),
  /**
   * The effort of the Review dialog's notes (quick fixes, QF0): `null` is Auto, where a small pass
   * sorts each note and the quick ones are fixed in Review; a level makes every note wait for Send
   * and run at that level, as before Auto. Only used while the job is in Review, and only while the
   * `quickFixes` switch is on. `effort` stays the level of the first edit.
   */
  reviewEffort: effortSchema.nullable(),
  /**
   * What the revise run that Send queued with Auto is: the biggest tier among the notes it sent
   * (`revise` or `full`). `null` before a Send with Auto, and for a Send at a chosen level.
   */
  reviseTier: reviseTierSchema.nullable(),
  /**
   * Quick fixes, for the Jobs list (C57): the note a quick fix is working on now, as the time of
   * the note in the preview (`{ atSec }`), or `null` when none is. A fix that is queued and next in
   * line counts too, so the line does not flicker between two fixes of a round. Derived at read
   * time from `quick_fixes`, never stored; `null` for a job that is not in Review, for a job with
   * no fix under way, and always while the `quickFixes` switch is off.
   */
  fixing: z.object({ atSec: z.number().nonnegative() }).nullable(),
  /**
   * Quick fixes, for the Jobs list (C57): how many notes of the round being written (`round + 1`)
   * were fixed in Review and not undone. Derived at read time like `fixing`; 0 outside Review and
   * while the `quickFixes` switch is off.
   */
  fixedCount: countSchema,
  /**
   * Quick fixes, for the Review footer (C61): how long this job's own earlier rounds of notes took,
   * shortest to longest in whole minutes, from `step_runs` (the wall time of each revise run, start
   * to back in Review). `null` when the job has fewer than two such runs; the footer then says the
   * range of the tier (`TIER_MINUTES`). Derived at read time like `fixing`, never stored; `null`
   * for a job that is not in Review and always while the `quickFixes` switch is off.
   */
  reviseMinutes: reviseMinutesSchema.nullable(),
  /**
   * When the job was archived; `null` for a job that is not. An archived job is hidden from the
   * lists (the web app filters it) and nothing else about it changes: it is still counted in Money,
   * deliveries and the client's job count. Set and cleared with `POST /api/jobs/archive` and
   * `/unarchive` (archiving keeps the first date and does not move `updatedAt`), and cleared on its
   * own when the job is saved into arriving, queued or editing (see `ARCHIVE_BLOCKED_STATES`).
   */
  archivedAt: isoTimestampSchema.nullable(),
  /** The run the job is on, or last ran: `edit`, `revise` (after Send notes) or `render` (after Approve). */
  runKind: runKindSchema,
  /** How many rounds of review notes were sent: 0 until the first Send notes, then + 1 at each. */
  round: z.number().int().nonnegative(),
  /**
   * The live composition of the last edit or revise run that ended in Review; `null` before the
   * first. Kept while the job is revised, rendered and ready.
   */
  preview: jobPreviewSchema.nullable(),
  /** When the owner approved the preview (Approve); `null` until then. */
  approvedAt: isoTimestampSchema.nullable(),
  /**
   * Read from the `deliveries` table whenever the job is read: set once the owner marked the job
   * delivered, `null` before that. A job that leaves ready (retry, new run) keeps it; whether it
   * shows is `jobStage`'s call.
   */
  delivery: jobDeliverySchema.nullable(),
  /**
   * The series the job is an episode of (Series plan §2), `null` for none. A job joins one by its
   * folder name or by hand while it has not started (`canChangeSeries`), and the job a series
   * starts from joins it too.
   */
  seriesId: z.string().min(1).nullable(),
  /** The episode number from the job's folder name ("מיתוס או אמת 6" → 6); `null` outside a series or without a number. */
  episode: z.number().int().nonnegative().nullable(),
  /**
   * Generated videos (GN0): where the Generate stage of a job with no footage stands, read from
   * `job_generate` whenever the job is read, only while the `generate` switch is on. Absent (not
   * `null`) for every job without a row, so every other job's wire shape is what it always was.
   * The Jobs row and the job sheet read it; `job.step` stays 1 (Brief) while Generate works.
   */
  generate: generateStateSchema.nullable().optional(),
  /**
   * Formats (GN7): the sizes the job is delivered in, the main one first, only when the brief or
   * The owner's note explicitly asked for more than one. Absent (not `null`, not `[]`) for every other
   * job, so its wire shape is what it always was. Each format has a live composition
   * (`previewPath`) and, once the job is ready, a file in `output.outputs`.
   */
  formats: z.array(jobFormatSchema).min(2).optional(),
});
export type Job = z.infer<typeof jobSchema>;

/**
 * The stages of a finished job, in order: Approved, then Delivered, then Uploaded (a reel on
 * Instagram is linked to it), then Paid (Phase 4 §1, Clients × Instagram).
 */
export const JOB_STAGES = ['approved', 'delivered', 'uploaded', 'paid'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

/**
 * Where a finished job stands: `approved` (its export is ready and the owner has not marked it
 * delivered), `delivered` (marked, not paid), `uploaded` (delivered, not paid, and a reel is linked
 * to it: its delivery has `uploadedAt`) or `paid`. A paid job stays `paid` when a reel is linked
 * to it. Only a ready job has a stage: every other state gives `null`, even when the job still
 * carries the delivery of an earlier run.
 */
export function jobStage(job: Pick<Job, 'state' | 'delivery'>): JobStage | null {
  if (job.state !== 'ready') return null;
  if (job.delivery === null) return 'approved';
  // No `paidOn` at all is an editor's delivery (money left out): it is delivered, never paid.
  if ((job.delivery.paidOn ?? null) !== null) return 'paid';
  return job.delivery.uploadedAt === undefined ? 'delivered' : 'uploaded';
}

/**
 * The job as an editor may see it: the delivery keeps `deliveredAt`, `uploadedAt`, `reelUrl` and
 * `reelPlays` and loses `price`, `currency`, `paidOn` and `paidAmount` (money is the admin's alone).
 * A job with no delivery comes back as it is. A new object, the input is not changed.
 */
export function withoutJobMoney<T extends { delivery: JobDelivery | null }>(job: T): T {
  if (job.delivery === null) return job;
  const { deliveredAt, uploadedAt, reelUrl, reelPlays } = job.delivery;
  return {
    ...job,
    delivery: {
      deliveredAt,
      ...(uploadedAt === undefined ? {} : { uploadedAt }),
      ...(reelUrl === undefined ? {} : { reelUrl }),
      ...(reelPlays === undefined ? {} : { reelPlays }),
    },
  };
}

// A Record keyed by every state but ready, whose group is its stage: adding a state without
// choosing its group is a type error.
const GROUP_BY_STATE: Readonly<Record<Exclude<JobState, 'ready'>, JobStatusGroup>> = {
  arriving: 'progress',
  queued: 'progress',
  editing: 'progress',
  review: 'review',
  held: 'attention',
  failed: 'attention',
  cancelled: 'attention',
};

/**
 * The status tab a job is under on the Jobs page: In progress = arriving / queued / editing;
 * Review = review; Approved, Delivered, Uploaded or Paid = a ready job, by its `jobStage`; Needs attention =
 * held / failed / cancelled. It takes the job, not just its state, because a ready job's group is
 * its stage.
 */
export function groupOf(job: Pick<Job, 'state' | 'delivery'>): JobStatusGroup {
  const stage = jobStage(job);
  if (stage !== null) return stage;
  // `jobStage` is null for every state but ready, and a ready job always has a stage.
  return job.state === 'ready' ? 'approved' : GROUP_BY_STATE[job.state];
}
