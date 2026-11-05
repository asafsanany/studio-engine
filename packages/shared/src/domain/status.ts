import { z } from 'zod';

/** Every state a job can be in (architecture §4), in lifecycle order. */
export const JOB_STATES = [
  'arriving',
  'queued',
  'held',
  'editing',
  'review',
  'ready',
  'failed',
  'cancelled',
] as const;

export const jobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof jobStateSchema>;

/**
 * The status tabs on the Jobs page. `all` is the unfiltered view; the other seven partition the
 * jobs (see `groupOf`): a ready job is under Approved, Delivered, Uploaded or Paid by its stage
 * (`jobStage`).
 * The web app's `STATUS_TABS` lists the same values in the same order.
 */
export const STATUS_GROUPS = [
  'all',
  'progress',
  'review',
  'approved',
  'delivered',
  'uploaded',
  'paid',
  'attention',
] as const;

export const statusGroupSchema = z.enum(STATUS_GROUPS);
export type StatusGroup = z.infer<typeof statusGroupSchema>;

/** The group a single job belongs to: every `StatusGroup` except the catch-all `all`. */
export type JobStatusGroup = Exclude<StatusGroup, 'all'>;
