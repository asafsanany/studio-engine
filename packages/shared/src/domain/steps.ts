import { z } from 'zod';

/** The eight edit steps, in the order the engine runs them (architecture §6). */
export const STEP_IDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const stepIdSchema = z.literal(STEP_IDS);
/** A step number, 1 (Brief) to 8 (Render). */
export type StepId = z.infer<typeof stepIdSchema>;

/** The approved step labels. `STEPS[i].id === i + 1`. */
export const STEPS = [
  { id: 1, label: 'Brief' },
  { id: 2, label: 'Transcribe' },
  { id: 3, label: 'Scan' },
  { id: 4, label: 'Plan' },
  { id: 5, label: 'Cut' },
  { id: 6, label: 'Preview' },
  { id: 7, label: 'Check' },
  { id: 8, label: 'Render' },
] as const satisfies readonly { id: StepId; label: string }[];

export type StepLabel = (typeof STEPS)[number]['label'];

/** Label by step id, for lookups that should not deal with `undefined`. */
export const STEP_LABELS = Object.fromEntries(STEPS.map((step) => [step.id, step.label])) as Record<
  StepId,
  StepLabel
>;

/** The last step: the render, which writes the export. A finished job sits here. */
export const RENDER_STEP = 8 satisfies StepId;

/** The Preview step. A review job whose composition is gone fails here (PREVIEW_MISSING). */
export const PREVIEW_STEP = 6 satisfies StepId;

/** The Check step. An edit or revise run that ends in Review stays here (PREVIEW_READY). */
export const CHECK_STEP = 7 satisfies StepId;
