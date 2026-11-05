import {
  clock,
  type GenerateHistoryEvent,
  type GenerateNotePlan,
  type GenerateSheetRow,
  generateFailureOf,
  generateSheetRows,
  type Job,
} from '@studio/shared';

// What the job sheet's "Generated" part says (Generated videos, GN9; board GNSheet): for a job with
// no footage, the voice, the looks, the keyframes, the clips and what was spent on Higgsfield, each
// with a bar and a line under it as the board has them. Pure: the component reads the job, the
// stage's History and the review plan, and hands them in. A job without a Generate stage has none.

/** The words of the part. */
export const GENERATED_TEXT = {
  heading: 'Generated',
  /** On the right of the heading: who made what. */
  services: 'Higgsfield · ElevenLabs',
} as const;

export interface GeneratedView {
  rows: readonly GenerateSheetRow[];
}

export interface GeneratedSources {
  /** The stage's History (`useJobGenerateHistory`): the voice's length is on its "Voice made" line. */
  history?: readonly GenerateHistoryEvent[] | undefined;
  /** The clips of the hand-off (`useGenerateReviewPlan`): names the clip below the bar and when it is on screen. */
  plan?: GenerateNotePlan | null | undefined;
}

/** "The homeowner pours water" is "the homeowner pours water" after "Clip B: "; "PINEWOOD logo" is left as it is. */
function lowerFirst(text: string): string {
  const [first, second] = text;
  if (first === undefined || second === undefined) return text;
  return first === first.toUpperCase() && second === second.toLowerCase()
    ? `${first.toLowerCase()}${text.slice(1)}`
    : text;
}

/** The seconds of speech the voice was made with, from the History's "Voice made" line. */
function voiceSecOf(history: readonly GenerateHistoryEvent[] | undefined): number | null {
  const made = history?.find((event) => event.kind === 'voice');
  return made?.kind === 'voice' ? made.seconds : null;
}

/**
 * "Clip B: the pour and the tilt up, 0:03 to 0:08." for the first clip kept below the bar; `null`
 * when the plan is not known or none is below the bar.
 */
export function belowBarNote(plan: GenerateNotePlan | null | undefined): string | null {
  const clip = plan?.clips.find((one) => one.belowBar === true);
  if (clip === undefined) return null;
  const window = clip.windows[0];
  const shows = clip.shows === undefined || clip.shows === '' ? '' : `: ${lowerFirst(clip.shows)}`;
  const when = window === undefined ? '' : `, ${clock(window.startSec)} to ${clock(window.endSec)}`;
  return `Clip ${clip.id}${shows}${when}.`;
}

/**
 * The rows of the part for a generated job, or `null` for any other. The stage's own builder
 * (`generateSheetRows`) says every word; this chooses its options from the job: the run stopped
 * (a job that failed in Generate keeps its clips and greys its bars), the estimate that was over
 * the budget (the Spend row turns red), the length of the voice and the clip below the bar.
 */
export function sheetGenerated(
  job: Pick<Job, 'state' | 'step' | 'failedAt' | 'error' | 'generate'>,
  { history, plan }: GeneratedSources = {},
): GeneratedView | null {
  const state = job.generate;
  if (state == null) return null;
  const failure = generateFailureOf(job);
  const need = failure?.error?.code === 'over_budget' ? failure.error.needUsd : undefined;
  const rows = generateSheetRows(state, {
    voiceSec: voiceSecOf(history),
    belowBarNote: belowBarNote(plan),
    stopped: failure !== null,
    ...(need === undefined ? {} : { overBudgetNeedUsd: need }),
  });
  return { rows };
}
