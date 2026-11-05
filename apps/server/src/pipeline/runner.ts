// The contract between the queue worker (E2) and whatever does the editing: the real `claude -p`
// runner (E3) or the fake one used in development and tests (E7). The worker owns the job's state;
// a runner only edits, reports where it is, and says how it ended.

import type { CameraCurveId, Job, JobPreview, LibraryName, LutKind, StepId } from '@studio/shared';

/**
 * Why the runner is being started:
 * - `start`: a job that has never run (its `step` is still `null`).
 * - `retry`: the job failed and the user pressed Retry; carry on from the failed step.
 * - `resume`: the job was cancelled and the user pressed Resume, or the engine crashed or was
 *   stopped mid-edit and found the job still `editing`; carry on from the step it was at.
 *
 * `retry` and `resume` both mean "the workspace in `<job>/edit/` already has work in it". How the
 * worker chooses between them is `runModeFor` in run-mode.ts.
 */
export const RUN_MODES = ['start', 'resume', 'retry'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/**
 * Why the worker aborted a run: the user cancelled the job, or the engine is shutting down.
 * The worker passes it as the reason of the abort (`controller.abort(reason)`), so a runner reads
 * it from `signal.reason` with {@link abortReasonOf}.
 */
export type AbortReason = 'cancel' | 'shutdown';

/**
 * Why `signal` was aborted. Only the worker's `'shutdown'` counts as one; an abort with no reason
 * (the default `AbortError`) or any other reason is a cancel, as it always was. Meaningless until
 * the signal has aborted.
 */
export function abortReasonOf(signal: AbortSignal): AbortReason {
  return signal.reason === 'shutdown' ? 'shutdown' : 'cancel';
}

/** A LUT a note of this run names, found, and where the run finds it (LUTs build 2, LU9). */
export interface RunLut {
  slug: string;
  name: string;
  kind: LutKind;
  owner: 'yours' | 'builtIn';
  /**
   * The job's copy, relative to the job folder (`edit/luts/<slug>.cube`); `null` for the built-in
   * Cinematic look, which is the wrapper's own `--look cinematic` and has no file.
   */
  path: string | null;
  /** `'cinematic'` for that look, else `null`. */
  look: 'cinematic' | null;
}

/** A library graphic a note of this run names, found: its copy is `edit/graphics/<id>/`. */
export interface RunGraphic {
  slug: string;
  id: string;
  name: string;
  /** The job's copy, relative to the job folder (`edit/graphics/<id>`). */
  path: string;
}

/**
 * A font a note of this run names, found and in the job's `edit/fonts/` (Fonts build 2, FN15). A
 * face, not a family: `Heebo Bold` is one file.
 */
export interface RunFont {
  /** The face's name as the library has it (`Heebo Bold`): what the note's `@` names. */
  face: string;
  family: string;
  /** 100 to 900. */
  weight: number;
  italic: boolean;
  /** The job's copy, relative to the job folder (`edit/fonts/Hebrew + English/Heebo/Heebo-Bold.ttf`). */
  path: string;
  /** Whether the file has the Hebrew letters; a font without them is never used for Hebrew words. */
  he: boolean;
}

/**
 * A token of a note that the run cannot use: `notInLibrary` (never made, misspelled, deleted, or
 * a built-in LUT while the colour grade is not installed), `noFile` (the LUT is there but its file
 * could not be copied into the job) or `notInJob` (a graphic the job has no copy of: its "Edits
 * can use it" was off when the edit began).
 */
export interface RunMissingRef {
  library: LibraryName;
  slug: string;
  reason: 'notInLibrary' | 'noFile' | 'notInJob';
}

/**
 * What a run's notes point at in the library (LUTs build 2, LU9): the note of an edit run, the
 * round file of a revise run, each token resolved, the LUT files copied into the job. Each item
 * once, in the order the text first names it.
 */
export interface RunLibraryRefs {
  luts: RunLut[];
  graphics: RunGraphic[];
  missing: RunMissingRef[];
  /**
   * The fonts the notes name, each face once, in the order the text first names them (FN15). Left
   * out unless the fontsInNotes switch is on and a note names one. Their files are in `edit/fonts/`.
   */
  fonts?: RunFont[];
  /**
   * The font names the notes write that the library does not have (`Gotham Bold`), each once
   * (FN16). The prompt tells the run to use the closest font that is there and say which, and the
   * engine has written a `font_requests` row for each. Left out when there are none.
   */
  unresolvedFonts?: string[];
  /**
   * What the footage says about camera log, for an edit run (LUTs build 2, LU10): given on every
   * edit run while lutsInEdits is on, empty when no file names a curve. Left out for a revise run.
   */
  camera?: RunCameraLuts;
}

/**
 * Footage that says which log curve it was shot in (a tag or the file's name), and what the library
 * has for it. The editor applies a matched LUT only to a source the colour grade's report calls log.
 */
export interface RunCameraLuts {
  /** One entry per curve the job's files name, in the order the files are listed. */
  curves: RunCameraCurve[];
  /** A note already names a Camera LUT (`@luts/…`), which wins: nothing is matched on its own. */
  byNote: boolean;
}

export interface RunCameraCurve {
  /** `CameraCurveId` from @studio/shared. */
  curve: CameraCurveId;
  /** "Sony S-Log3". */
  label: string;
  /** The job's files that name it (paths relative to the job folder), at most 5. */
  files: string[];
  /** The library's answer: the one matching Camera LUT, more than one (none is chosen), or none. */
  match:
    | { kind: 'one'; lut: RunLut & { path: string } }
    | { kind: 'several'; names: string[] }
    | { kind: 'none' };
}

/** What the worker gives the runner for one run. */
export interface RunContext {
  /**
   * Aborted when the user cancels the job or the engine shuts down; `abortReasonOf(signal)` says
   * which, so the runner can record the two differently. The runner must stop its work
   * (E3: SIGTERM to the process group, SIGKILL after 10 s) and then settle. The worker waits for
   * that, and starts nothing else meanwhile, so a runner that never settles blocks the queue.
   * Whatever the runner returns after an abort is not treated as a failure. If it waits before
   * it listens for the `abort` event, it must check `signal.aborted` first.
   */
  readonly signal: AbortSignal;

  /**
   * Reports that the edit is at `step`, with free text for the count inside it (`6/14`,
   * `graphics 2/5`; `null` or left out for none). Cheap to call often: the worker ignores a
   * report that repeats the current step and text, and one that arrives after the run ended or
   * was aborted. It never throws.
   */
  progress(step: StepId, sub?: string | null): void;

  /**
   * How many files the edit transcribes (Transcribe's N), when the job's brief says: the audio
   * and video files it calls footage (see `transcribeTotal`). Voice notes (`instructions`) and
   * ignored clips are not in it, since the edit never transcribes them. Left out when the worker
   * has no brief (no Brief step), and the runner counts the job's audio and video files instead.
   */
  readonly transcribeTotal?: number;

  /**
   * What the notes of this run name in the library (`withLutRefs`, LU9, and `withFontRefs`, FN15),
   * when the lutsInEdits or fontsInNotes switch is on and a note names anything; left out
   * otherwise. The LUT files are already in `edit/luts/`, the fonts' in `edit/fonts/`. The Claude
   * runner tells the editor; the fake runner records it.
   */
  readonly libraryRefs?: RunLibraryRefs;
}

/**
 * How a run ended. A runner reports this by resolving; it does not rely on the worker watching
 * its output. For the Claude runner: success = the process exited 0 AND the run left what it was
 * to leave (a blocked run also exits 0 with a `success` result, so the exit code alone is not
 * enough): a non-empty `edit/final.mp4` for a run that delivers a video, or a valid
 * `edit/preview/index.html` for a run that ends in Review.
 */
export type RunOutcome =
  /**
   * The run is finished. A run that delivers a video has left a non-empty `edit/final.mp4`, which
   * the worker then exports. A run that ends in Review (an edit run with the Review switch on, a
   * revise run) reports the composition it left in `edit/preview/` as `preview`, and the worker
   * applies PREVIEW_READY with it; nothing is exported.
   */
  | { ok: true; preview?: JobPreview }
  /**
   * The edit failed. `step` is where, when the runner knows better than the last `progress`
   * report; `error` is the text shown to the user.
   */
  | { ok: false; error: string; step?: StepId };

export interface Runner {
  /**
   * Edits one job and resolves when the run has ended, never before the work has actually
   * stopped (no process left running). `job` is in the `editing` state, and its `runKind` says
   * which run this is. A run that delivers a video leaves a non-empty `edit/final.mp4` (the worker
   * exports it); a run that ends in Review leaves a live composition in `edit/preview/` and
   * reports it as `preview` (the worker applies PREVIEW_READY). Rejecting counts as a failure
   * with the error's message.
   */
  start(job: Job, mode: RunMode, context: RunContext): Promise<RunOutcome>;
}
