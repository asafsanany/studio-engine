// Whether a job's `edit/` folder already holds the edit's own work (CVP-132). The worker asks
// before it picks the prompt of an edit run for a job that sits at Brief (1): a job whose fresh
// brief failed or was stopped there, after the edit had got further, goes back to step 1 with
// everything the edit made still in edit/. Such a job carries on (resume or retry); only one with
// nothing of the edit starts over.
//
// The evidence is the one the progress tracker reads, so the two agree: the folder is scanned the
// way `EditWatcher` scans it and replayed through the same reducer. Anything that moves the edit
// past Transcribe counts (takes_packed.md, edl.json, animations/, preview*.mp4, final*.mp4 and what
// follows from them), and so do transcripts/*.json and project.md. The Brief's own files
// (brief.json, brief.md, brief/) are not the edit's work and never count.
//
// The same replay says which step the work reached (CVP-138). The stored step of such a job is 1
// (the brief that failed), and the resume and retry prompts name the step the run carries on from,
// so they use the replayed one: "step 5 of 8 (Cut)", not "step 1 of 8 (Brief)".

import type { StepId } from '@studio/shared';
import { initialProgress, reduceProgress, TRANSCRIBE_STEP } from './progress-reducer.js';
import { diffSnapshots, type EditSnapshot, scanEditDir } from './progress-watcher.js';
import type { RunFinish } from './run-finish.js';

/**
 * The step the edit's own work in a look at edit/ (see `scanEditDir`) reached, 2 to 8, or `null`
 * when there is no such work. `finish` is how the run ends: for a run that ends in a preview
 * (W2), edit/preview/index.html counts as its Preview. Pure.
 */
export function snapshotEditStep(
  snapshot: EditSnapshot,
  finish: RunFinish = 'final',
  options: EvidenceOptions = {},
): StepId | null {
  let state = initialProgress({ finish });
  for (const signal of diffSnapshots(new Map(), snapshot)) {
    state = reduceProgress(state, signal);
  }
  // project.md alone is not proof the plan was made (the reducer waits for takes_packed.md), but
  // it is the edit's file, written by an edit run, and a carry-on prompt is the safe one for it.
  // A generated job's project.md may be the Generate run's assumptions, written before the edit
  // began (Generated videos, GN5): there it proves nothing.
  const worked =
    (snapshot.has('project.md') && options.generated !== true) ||
    state.step > TRANSCRIBE_STEP ||
    state.transcripts.length > 0;
  return worked ? state.step : null;
}

/** How `snapshotEditStep` reads a look at edit/. */
export interface EvidenceOptions {
  /**
   * The job is a generated one (Generated videos): its Generate run writes its assumptions to
   * edit/project.md, so that file alone is not the edit's work. Everything that moves the edit past
   * Transcribe still counts.
   */
  generated?: boolean;
}

/** Whether a look at edit/ (see `scanEditDir`) shows work of the edit run. Pure. */
export function snapshotHasEditProgress(
  snapshot: EditSnapshot,
  options: EvidenceOptions = {},
): boolean {
  return snapshotEditStep(snapshot, 'final', options) !== null;
}

/**
 * The step `<job>/edit` shows the edit reached, or `null` when it holds no work of the edit run
 * (a missing folder is empty). It is the step the progress tracker reports first when it replays
 * the folder. Rejects when the folder cannot be read (other than "not there").
 */
export async function editProgressStep(
  editDir: string,
  finish: RunFinish = 'final',
  options: EvidenceOptions = {},
): Promise<StepId | null> {
  return snapshotEditStep(await scanEditDir(editDir), finish, options);
}

/**
 * Whether `<job>/edit` holds work of the edit run. A missing folder is empty. Rejects when the
 * folder cannot be read (other than "not there"); the caller decides what that means.
 */
export async function hasEditProgress(
  editDir: string,
  options: EvidenceOptions = {},
): Promise<boolean> {
  return snapshotHasEditProgress(await scanEditDir(editDir), options);
}
