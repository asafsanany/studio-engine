import { z } from 'zod';
import { isoTimestampSchema } from './job.ts';
import { reviewNoteSchema } from './review-note.ts';
import { runKindSchema } from './run-kind.ts';
import { stepIdSchema } from './steps.ts';

// The three routes of the job sheet (Job sheet plan §4); JS1 builds them, the web reads them:
//
//   GET  /api/jobs/:id/steps       a job's timed steps, oldest first                   200 { jobId, runs }
//   POST /api/jobs/:id/reveal      Show in Finder: the export MP4, else the job folder  200 { ok, revealed }
//   GET  /api/jobs/:id/sent-notes  the review notes the owner sent, in every job state       200 { jobId, notes }
//
// All three answer 404 `{ error: "Job <id> not found" }` for an unknown job (as every job route
// does); reveal also answers 404 {@link JOB_REVEAL_MESSAGES}.folderMissing and 500 .couldNotOpen.

/**
 * One timed run of one step of a job, from the `step_runs` table. The job sheet's Steps section
 * lays them out; a step that was run again (a retry, a revise round) has one entry per run.
 */
export const jobStepRunSchema = z.object({
  step: stepIdSchema,
  /** The kind of run that timed the step: `edit`, `revise` (a round of notes) or `render`. */
  runKind: runKindSchema,
  /**
   * The job's review round the run belongs to, numbered like `Job.round`: 0 for the first edit,
   * N for the revise run that applies round N's notes and for the render that follows it.
   */
  round: z.number().int().nonnegative(),
  startedAt: isoTimestampSchema,
  /** `null` while the step is running, or when a crash left the run open. */
  endedAt: isoTimestampSchema.nullable(),
});
export type JobStepRun = z.infer<typeof jobStepRunSchema>;

/** `GET /api/jobs/:id/steps`: the job's step runs, oldest first. A job that has not started has `[]`. */
export const jobStepsResponseSchema = z.object({
  jobId: z.string().min(1),
  runs: z.array(jobStepRunSchema),
});
export type JobStepsResponse = z.infer<typeof jobStepsResponseSchema>;

/**
 * `POST /api/jobs/:id/reveal`: Finder was asked to show the job. `revealed` says what it was
 * asked for: the export MP4 selected (`file`, when the job has an output and the file exists), or
 * else the job folder (`folder`).
 */
export const revealJobResponseSchema = z.object({
  ok: z.literal(true),
  revealed: z.enum(['file', 'folder']),
});
export type RevealJobResponse = z.infer<typeof revealJobResponseSchema>;

/** The words of the reveal route's own refusals; the web shows them as the server wrote them. */
export const JOB_REVEAL_MESSAGES = {
  /** 404: the job is known, but its folder (and its export) is gone. */
  folderMissing: 'The job folder is missing.',
  /** 500: Finder could not be asked. */
  couldNotOpen: 'Could not open it in Finder.',
} as const;

/**
 * `GET /api/jobs/:id/sent-notes`: the review notes the job's rounds were sent with, by round and
 * then in the order the Review dialog shows them (where each is pinned, then when it was written).
 * `GET /api/jobs/:id/notes` is the other half: it answers the unsent notes, and only in Review. A
 * sent note is read-only and never changes, and this answers in every state of the job. A job
 * that has sent nothing has `notes: []`.
 */
export const sentNotesResponseSchema = z.object({
  jobId: z.string().min(1),
  notes: z.array(reviewNoteSchema),
});
export type SentNotesResponse = z.infer<typeof sentNotesResponseSchema>;
