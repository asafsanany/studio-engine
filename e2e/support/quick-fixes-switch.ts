// What the specs that go through Review need to know about the Quick fixes switch: it is on in the
// engine since QF9, and `E2E_QUICK_FIXES=0` in the environment of a run turns it off for every engine
// that does not say (support/engine.ts), so review, music, fonts-preview and the phone's review specs
// can still be run both ways. With it on, Review's Effort starts with Auto, and a level chosen there
// is the job's `reviewEffort`, not its `effort` (the edit's).

/** Whether the Quick fixes switch is on for this run. */
export const QUICK_FIXES_ON = process.env.E2E_QUICK_FIXES !== '0';

/** What a job on its default level is called in Review's Effort: Auto with Quick fixes on, else Default. */
export const EFFORT_DEFAULT = QUICK_FIXES_ON ? 'Auto' : 'Default';

/** The words of the Effort button of a job on its default level ("Effort: Auto"). */
export const EFFORT_BUTTON_DEFAULT = `Effort: ${EFFORT_DEFAULT}`;

/** The field of the job that Review's Effort writes: `reviewEffort` with Quick fixes on, else `effort`. */
export const REVIEW_EFFORT_FIELD = QUICK_FIXES_ON ? 'reviewEffort' : 'effort';
