import type { Job } from '@studio/shared';
import type { JobMeta } from '../db/index.js';
import type { RunMode } from './runner.js';

/**
 * Which mode a job taken from the queue runs in. Derived from stored data only, so it is the same
 * after a restart and needs no column of its own:
 *
 * - `step` is `null` -> `start`. `START` always sets a step, so a job that has run before never
 *   has `null` again; failing or cancelling keeps the step.
 * - otherwise `attempt` is above 1 -> `retry`. `RETRY` is the only event that raises `attempt`.
 * - otherwise -> `resume` (the job was cancelled and resumed, and never retried).
 *
 * Known limit: `RETRY` and `RESUME` leave the job in exactly the same state apart from `attempt`,
 * so a job that was retried, then cancelled, then resumed runs as `retry`. Both modes carry on
 * from the existing workspace, so only the wording of the prompt differs. Telling them apart
 * exactly would take a stored "last event" on the job, which needs a schema change.
 *
 * `SEND_NOTES` and `APPROVE` leave `step` null and `attempt` 1, so the first run of a new kind is
 * `start`. A retry of it is `retry`, and a resume after a cancel is `resume`. The prompt also
 * depends on `job.runKind` (W3).
 *
 * A job found still `editing` after a crash is not queued, so it never comes through here: the
 * worker runs it as `resume` directly.
 *
 * This only reads the job's stored data. A job back at step 1 (Brief) after a failed or stopped
 * brief says `retry` or `resume` here whatever the edit had reached before; the worker then looks
 * at `edit/` and keeps that mode when the edit's work is there, and runs `start` when it is not
 * (CVP-132; `editModeAtBrief` in worker.ts).
 */
export function runModeFor(job: Pick<Job, 'step'>, meta: Pick<JobMeta, 'attempt'>): RunMode {
  if (job.step === null) return 'start';
  return meta.attempt > 1 ? 'retry' : 'resume';
}
