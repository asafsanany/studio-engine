import { z } from 'zod';

/**
 * What a person can ask for on a job: `POST /api/jobs/:id/<action>` (see `jobActionPath` for the
 * URL segment). The first six are the row's actions, in the order of the buttons in the web app,
 * left to right; `send_notes` (Send notes) is the review dialog's footer button. `approve` (Approve)
 * is in the row's right-click menu only (the phone's: the job's sheet), never inside the job (the owner,
 * 31 Oct), and `unapprove` (Unapprove) is the way back from Approved, in that menu too.
 *
 * `start` is "Start now": an `arriving` job skips the rest of its settle wait and joins the queue.
 */
export const JOB_ACTIONS = [
  'start',
  'hold',
  'release',
  'cancel',
  'resume',
  'retry',
  'send_notes',
  'approve',
  'unapprove',
] as const;

export const jobActionSchema = z.enum(JOB_ACTIONS);
export type JobAction = z.infer<typeof jobActionSchema>;

/** The URL segment of each action: `POST /api/jobs/:id/<segment>`. Only send_notes differs from its name. */
export const JOB_ACTION_PATHS = {
  start: 'start',
  hold: 'hold',
  release: 'release',
  cancel: 'cancel',
  resume: 'resume',
  retry: 'retry',
  send_notes: 'send-notes',
  approve: 'approve',
  unapprove: 'unapprove',
} as const satisfies Record<JobAction, string>;

export function jobActionPath(action: JobAction): string {
  return JOB_ACTION_PATHS[action];
}

/** Extras some actions take; the others ignore them. */
export interface JobActionOptions {
  /**
   * `release` only: a job that was queued when it was held goes back to the place it had in line
   * instead of to the back of it (the note dialog holds a job while a note is written and
   * releases it this way). Sent as `POST /api/jobs/:id/release?restore=1`.
   */
  restorePlace?: boolean;
}
