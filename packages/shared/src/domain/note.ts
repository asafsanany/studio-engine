import type { Job } from './job.ts';
import type { JobState } from './status.ts';

/** The longest note the engine stores, counted in UTF-16 code units like an HTML `maxlength`. */
export const NOTE_MAX_LENGTH = 4000;

/**
 * The states in which the note can be written. Not while the job is `editing` (the edit already
 * read the note), not once it is `ready` (the note can no longer change anything), and not in
 * review (the review dialog takes notes instead).
 */
export const NOTE_EDITABLE_STATES = [
  'arriving',
  'queued',
  'held',
  'failed',
  'cancelled',
] as const satisfies readonly JobState[];

/** Whether the job's note can be saved right now (`PUT /api/jobs/:id/note` answers 409 if not). */
export function canEditNote(job: Pick<Job, 'state'>): boolean {
  return (NOTE_EDITABLE_STATES as readonly JobState[]).includes(job.state);
}

/** What is stored for what was typed: trimmed, and `null` when nothing but whitespace is left. */
export function normalizeNote(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}
