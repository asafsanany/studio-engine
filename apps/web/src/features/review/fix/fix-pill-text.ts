/** The words of the pill on the video while a quick fix runs and after it (board QFReview, states 3 to 5). */
export const FIX_PILL_TEXT = {
  /** While a fix runs: the note's time. */
  fixing: (time: string) => `Fixing at ${time}…`,
  /** After a fix, while the video stands at that moment. */
  changed: (time: string) => `Changed at ${time}`,
  /** While Compare is held. */
  before: 'Before the fix',
  /** Compare's tooltip: what the held button shows. */
  compareTip: 'Hold to see it before the fix',
} as const;
