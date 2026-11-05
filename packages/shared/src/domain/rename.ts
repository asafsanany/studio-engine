import { z } from 'zod';
import { type Job, jobSchema } from './job.ts';
import type { JobState } from './status.ts';

/**
 * The states in which a job cannot be renamed: the engine is working in its folder, or is about to
 * (the render after Approve runs as `queued`, then `editing`). Every other state can be renamed:
 * held, failed, cancelled, in review and ready.
 */
export const RENAME_BLOCKED_STATES = [
  'arriving',
  'queued',
  'editing',
] as const satisfies readonly JobState[];

/** Whether the job can be renamed right now (`PUT /api/jobs/:id/name` answers 409 if not). */
export function canRename(job: Pick<Job, 'state'>): boolean {
  return !(RENAME_BLOCKED_STATES as readonly JobState[]).includes(job.state);
}

/** Why a job in this state cannot be renamed: the words a 409 and a disabled menu item say. */
export function renameBlockedReason(job: Pick<Job, 'state'>): string {
  return job.state === 'arriving'
    ? 'Wait until the files have arrived to rename this video.'
    : 'Wait until the edit is done to rename this video.';
}

/** The longest job name: a folder name in the inbox, and a file name in the exports. */
export const JOB_NAME_MAX_LENGTH = 120;

/**
 * What is stored for what was typed: trimmed, in Unicode NFC (the form the exports use). The folder
 * is renamed to this, so it is what Finder shows too.
 */
export function normalizeJobName(text: string): string {
  return text.trim().normalize('NFC');
}

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why `text` cannot be a job's name, in words for the person typing, or `null` when it can. A name
 * is a folder name: it cannot be empty, hold a slash or a colon (macOS shows a colon as a slash), a
 * control character, or start with a dot (the engine never looks at those folders), and it is not
 * longer than {@link JOB_NAME_MAX_LENGTH}. Whether a video of that name already exists, and the
 * client's own folders (`_Style`, `_Series`), are for the server to say.
 */
export function jobNameProblem(text: string): string | null {
  const name = normalizeJobName(text);
  if (name === '') return 'Type a name.';
  if (name.length > JOB_NAME_MAX_LENGTH) {
    return `Use ${JOB_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (/[/\\:]/.test(name)) return 'A name cannot have a slash or a colon.';
  if (hasControlCharacter(name)) return 'A name cannot have a line break or a control character.';
  if (name.startsWith('.')) return 'A name cannot start with a dot.';
  return null;
}

/** `PUT /api/jobs/:id/name` body: the job's new name, which is the new name of its folder. */
export const renameJobRequestSchema = z.object({ name: z.string() });
export type RenameJobRequest = z.infer<typeof renameJobRequestSchema>;

/**
 * `PUT /api/jobs/:id/name`: the job under its new name. Its `id` is new too (it is a hash of the
 * folder's path), so the caller follows it: the old id is gone from the list.
 */
export const renameJobResponseSchema = jobSchema;
export type RenameJobResponse = z.infer<typeof renameJobResponseSchema>;
