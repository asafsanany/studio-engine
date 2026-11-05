import type { Job } from './job.ts';
import type { JobState } from './status.ts';

/**
 * The states in which a job cannot be archived: the engine is working on it, or is about to (the
 * render after Approve runs as `queued`, then `editing`). Every other state can be archived.
 *
 * A job that is saved into one of these states leaves the archive on its own (`archivedAt` becomes
 * `null`): a retry, a resume, a release, Start now, Send notes, Approve, or new files in its folder.
 */
export const ARCHIVE_BLOCKED_STATES = [
  'arriving',
  'queued',
  'editing',
] as const satisfies readonly JobState[];

/** Whether the job can be archived right now (`POST /api/jobs/archive` answers 409 if not). */
export function canArchive(job: Pick<Job, 'state'>): boolean {
  return !(ARCHIVE_BLOCKED_STATES as readonly JobState[]).includes(job.state);
}

/** Whether the job is archived: hidden from the lists, and counted everywhere else as before. */
export function isArchived(job: Pick<Job, 'archivedAt'>): boolean {
  return job.archivedAt !== null;
}
