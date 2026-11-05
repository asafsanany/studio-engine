import { z } from 'zod';
import type { StepId } from './steps.ts';

/**
 * The three runs of a job (Phase 3 §1), in the order they happen: `edit` makes the edit,
 * `revise` applies a round of the owner's review notes (after Send notes), and `render` renders the
 * approved preview (after Approve). A job's `runKind` is the run it is on, or the last one it ran.
 */
export const RUN_KINDS = ['edit', 'revise', 'render'] as const;

export const runKindSchema = z.enum(RUN_KINDS);
export type RunKind = z.infer<typeof runKindSchema>;

/** The step each kind of run starts at: Brief, Plan (no Brief, no transcription), Render. */
export const FIRST_STEP_BY_RUN_KIND = {
  edit: 1,
  revise: 4,
  render: 8,
} as const satisfies Record<RunKind, StepId>;

/** Where a run of `kind` begins when the job has no step yet (the START rule). */
export function firstStepOf(kind: RunKind): StepId {
  return FIRST_STEP_BY_RUN_KIND[kind];
}
