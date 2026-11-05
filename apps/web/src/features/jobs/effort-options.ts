import {
  DEFAULT_EFFORT,
  EFFORT_LABELS,
  EFFORT_LEVELS,
  type Effort,
  effortLabel,
  effortSchema,
  type ReviewEffortChoice,
} from '@studio/shared';

// The choices of an effort menu, shared by the row's "Effort ▸" and the review dialog's Effort
// button, so both say the same words (design canvas, page "Effort").

/** One choice: Default, or a level, with a muted hint of how it compares with its neighbours. */
export interface EffortOption {
  id: string;
  label: string;
  hint: string;
  /** A line goes under this option. */
  separatorAfter?: boolean;
  /** A second muted line under the label (Auto's). */
  sub?: string;
}

/** The id of the "no level" choice. */
export const EFFORT_DEFAULT_ID = 'default';

/** The words after each level: how it compares with the ones around it. */
const EFFORT_HINTS: Readonly<Record<Effort, string>> = {
  medium: 'quickest',
  high: 'slower',
  xhigh: 'slowest',
};

/** Default (which says the level it runs at), a line, then the levels from Medium to Extra high. */
export const EFFORT_OPTIONS: readonly EffortOption[] = [
  {
    id: EFFORT_DEFAULT_ID,
    label: 'Default',
    hint: effortLabel(DEFAULT_EFFORT),
    separatorAfter: true,
  },
  ...EFFORT_LEVELS.map((level) => ({
    id: level,
    label: EFFORT_LABELS[level],
    hint: EFFORT_HINTS[level],
  })),
];

/** The id of a choice for a job's effort: the level, or Default for none. */
export function optionIdOf(effort: Effort | null): string {
  return effort ?? EFFORT_DEFAULT_ID;
}

/** The effort a choice stands for: the level, or `null` for Default. */
export function effortOfOption(id: string): Effort | null {
  return id === EFFORT_DEFAULT_ID ? null : effortSchema.parse(id);
}

// --- Review's levels, with Auto (Quick fixes) -----------------------------------------------------
//
// With the Quick fixes switch on, the effort of a job's review rounds (`Job.reviewEffort`) starts
// with Auto, which is `null`: the Effort button in Review, the phone's Effort sheet and the row's
// Effort ▸ for a job in Review offer Auto and the three levels. Words of the design canvas, page
// "Quick fixes", board "Effort with Auto" (QFEffort) and the `levels` of QFReview.

/** The words of the Effort menus with Auto. */
export const REVIEW_EFFORT_WORDS = {
  auto: 'Auto',
  /** On the right of Auto: it is what a job has until a level is chosen. */
  autoHint: 'Default',
  /** Under Auto in Review's menu and the phone's sheet. */
  autoSub:
    'Text, font and title notes are fixed here at once. The rest runs at the level it needs.',
  /** On the right of each level in Review's menu and the phone's sheet: a chosen level holds every note for Send. */
  levelHint: 'waits for Send',
} as const;

/** One choice of the Effort menu with Auto: its id is the choice the server takes (`ReviewEffortRequest`). */
export interface ReviewEffortOption extends EffortOption {
  id: ReviewEffortChoice;
}

/** Auto, then a line, then the levels from Medium to Extra high with `hint` after each. */
function reviewOptions(
  auto: Pick<EffortOption, 'sub'>,
  hint: string,
): readonly ReviewEffortOption[] {
  return [
    {
      id: 'auto',
      label: REVIEW_EFFORT_WORDS.auto,
      hint: REVIEW_EFFORT_WORDS.autoHint,
      separatorAfter: true,
      ...auto,
    },
    ...EFFORT_LEVELS.map((level) => ({ id: level, label: EFFORT_LABELS[level], hint })),
  ];
}

/**
 * Review's Effort button and the phone's Effort sheet: Auto (Default, with its line of help), a
 * line, then Medium, High and Extra high, each saying it waits for Send.
 */
export const REVIEW_EFFORT_OPTIONS = reviewOptions(
  { sub: REVIEW_EFFORT_WORDS.autoSub },
  REVIEW_EFFORT_WORDS.levelHint,
);

/** The row's Effort ▸ for a job in Review: the same choices, as short as the board shows them (no hints on the levels, no line of help). */
export const REVIEW_ROW_EFFORT_OPTIONS = reviewOptions({}, '');

/** The choice a job's review effort stands for: the level, or Auto for `null`. */
export function reviewChoiceOf(effort: Effort | null): ReviewEffortChoice {
  return effort ?? 'auto';
}

/** The review effort a choice stands for: the level, or `null` for Auto. */
export function reviewEffortOf(choice: string): Effort | null {
  return choice === 'auto' ? null : effortSchema.parse(choice);
}

/**
 * The level a job's effort mark and menus show: with Quick fixes on, a job in Review shows the
 * level of its review rounds (`null` is Auto), any other job the level of its edit.
 */
export function shownEffort(
  job: { state: string; effort: Effort | null; reviewEffort: Effort | null },
  quickFixes: boolean,
): Effort | null {
  return quickFixes && job.state === 'review' ? job.reviewEffort : job.effort;
}
