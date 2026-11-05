// The runner contract of a quick fix (quick fixes plan, section 2 "The quick fix run"; QF2): what
// the fix service (fix-service.ts, QF3) asks of "a run that changes one note's worth of the live
// composition, and the engine's checks after it". The real one is the headless Sonnet run
// (claude-quick-fix.ts); STUDIO_RUNNER=fake gets the stand-in (fake-quick-fix.ts);
// createQuickFixRunner (create-quick-fix-runner.ts) picks one. Tests of the service give it a
// stand-in of their own.
//
// The service has already cloned edit/preview/ (and project.md) for Undo, and it is the one that puts
// that clone back when the outcome is anything but `fixed`: the runner never snapshots or restores.
// `run` is the plan's `runQuickFix(job, note, fix, signal) → outcome`: the run and the checks
// (verify-quick-fix.ts) in one, resolving once nothing of the run is left running.

import type { Job, QuickFix, ReviewNote } from '@studio/shared';

/** The four steps of a run, as `QuickFix.step` counts them. */
export type QuickFixStep = 0 | 1 | 2 | 3;

/** What each step says, in the order the run goes through them. Step 1 is the note's kind, see `quickFixStepLabel`. */
export const QUICK_FIX_STEP_LABELS = [
  'Reading the edit',
  'Changing the edit',
  'Checking it',
  'Looking at the frames',
] as const;

/**
 * The words of a step (`QuickFix.stepLabel`). Step 1 says what the note asks for, in the router's
 * words ("Changing the caption font"), and falls back to "Changing the edit" when the note has none.
 */
export function quickFixStepLabel(step: QuickFixStep, kind: string | null | undefined): string {
  if (step === 1) {
    const what = (kind ?? '').trim();
    return what === '' ? QUICK_FIX_STEP_LABELS[1] : what;
  }
  return QUICK_FIX_STEP_LABELS[step];
}

export interface QuickFixRequest {
  job: Pick<Job, 'id' | 'client' | 'name' | 'relPath'>;
  /**
   * The note to fix: its moment, its words (a voice note's transcript) and the router's answer, whose
   * `kind` names step 1. `text` null (a voice note without a transcript) cannot be fixed here.
   */
  note: Pick<ReviewNote, 'id' | 'atSec' | 'text' | 'route'>;
  /** The fix: its id names the folder `edit/review/fixes/<id>/`, its round is the one the note will be stamped with. */
  fix: Pick<QuickFix, 'id' | 'round'>;
  /** Aborted by a delete of the note, by Undo and by the engine shutting down: the run's process tree stops. */
  signal: AbortSignal;
  /** Told when the run starts (step 0) and each time it moves on, with the words of the step. */
  onStep?: (step: QuickFixStep, label: string) => void;
}

/**
 * How a fix ended. `fixed`: the composition changed and every check passed; `said` is the run's
 * sentence for the owner. `escalated`: it could not be done in the composition alone (the run said so, or
 * nothing changed); `why` is a few words and the note goes with Send. `failed`: the run or a check
 * failed (it crashed, ran out of time, answered badly, broke the lint or a file it must not touch);
 * `why` says what, and the preview must be put back. `hasCompare` is whether before.png and
 * after.png both exist in the fix's folder.
 */
export type QuickFixOutcome =
  | { status: 'fixed'; said: string; hasCompare: boolean }
  | { status: 'escalated'; why: string; hasCompare: boolean }
  | { status: 'failed'; why: string; hasCompare: boolean };

export interface QuickFixRunner {
  /** `claude` for the headless Sonnet run, `fake` for the stand-in of STUDIO_RUNNER=fake. */
  readonly kind: 'claude' | 'fake';
  /** Runs one fix. Resolves once the run has ended, also when it failed or was aborted; never rejects for a run that went wrong. */
  run(request: QuickFixRequest): Promise<QuickFixOutcome>;
}
