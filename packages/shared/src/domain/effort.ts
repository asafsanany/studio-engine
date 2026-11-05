import { z } from 'zod';
import type { Job } from './job.ts';
import type { JobState } from './status.ts';

/**
 * The effort levels the owner can choose (of the ones `claude --effort` takes), lowest first. Low and
 * Max are not offered. A job with none set (`effort: null`) is "Default": it runs at
 * `DEFAULT_EFFORT`.
 */
export const EFFORT_LEVELS = ['medium', 'high', 'xhigh'] as const;

export const effortSchema = z.enum(EFFORT_LEVELS);
export type Effort = z.infer<typeof effortSchema>;

/** The level a job on Default runs at: Extra high. */
export const DEFAULT_EFFORT: Effort = 'xhigh';

/** The level the edit, resume, retry and revise runs of a job are started with: its own, or the default. */
export function runEffort(effort: Effort | null): Effort {
  return effort ?? DEFAULT_EFFORT;
}

/** The words of each level in the menu and in the tooltip of the gauge. */
export const EFFORT_LABELS: Readonly<Record<Effort, string>> = {
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

/** The label of a job's effort: its level's, or "Default" (which runs at `DEFAULT_EFFORT`) for none. */
export function effortLabel(effort: Effort | null): string {
  return effort === null ? 'Default' : EFFORT_LABELS[effort];
}

/**
 * The states in which a job's effort can be set: the ones where its next run has not started.
 * That is the note's states, so a retried or resumed job can take another level, and `review`: the
 * next run is then a revise round, which starts with the level the job has when Send notes queues
 * it, so the owner can ask for the fixes at a lower or higher level. Not while the job is `editing` (the
 * run already started with its level) or once it is `ready` (the render run takes no level).
 */
export const EFFORT_EDITABLE_STATES = [
  'arriving',
  'queued',
  'held',
  'review',
  'failed',
  'cancelled',
] as const satisfies readonly JobState[];

/** Whether the job's effort can be saved right now (`PUT /api/jobs/:id/effort` answers 409 if not). */
export function canEditEffort(job: Pick<Job, 'state'>): boolean {
  return (EFFORT_EDITABLE_STATES as readonly JobState[]).includes(job.state);
}
