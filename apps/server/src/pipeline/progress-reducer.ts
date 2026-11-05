// The progress tracker's brain (E4): a pure reducer `(state, signal) -> state` that turns what a
// video-use run leaves behind into one of the steps 2-8 and a count inside it. No filesystem, no
// clock, no stream: progress-watcher.ts and progress-signals.ts turn those into signals, and
// progress.ts reports the result to the worker.
//
// How each step is recognised (the evidence comes from E1's runs, fixtures/stream/README.md):
//
//   1 Brief       never inferred here: the engine reports it itself, from its own Brief run
//   2 Transcribe  the start of every fresh run    sub "n/N": transcripts/*.json / audio+video sources
//   3 Scan        takes_packed.md is written
//   4 Plan        project.md is written AFTER takes_packed.md (it can come first: in the blocked
//                 run it is the only file written, before any transcript, so on its own it is not
//                 proof the plan was made)
//   5 Cut         edl.json, or anything under animations/   sub "graphics r/p": slot renders done /
//                 graphics planned (animations/slot_* folders, or the overlays edl.json places)
//   6 Preview     a preview render is started (stream: render.py --preview or -o preview*.mp4) or
//                 preview*.mp4 shows
//   7 Check       verify/ frames once a preview exists, or a critic sub-agent   sub "pass n/3"
//   8 Render      a final render is started (stream: render.py -o final*.mp4) or final*.mp4
//
// A run that ends in Review (`finish: 'preview'`: an edit run with the Review switch on, W2) has
// no render. It finishes as a live composition in edit/preview/, so steps 6 to 8 read that:
//
//   6 Preview     edit/preview/index.html is written, or a hyperframes snapshot or preview command
//                 runs (stream)
//   7 Check       hyperframes lint or check (stream), verify/ frames once the composition exists,
//                 or a critic sub-agent   sub "pass n/3"; the composition changing after a check
//                 starts the next pass, as a new preview render does
//   8 Render      never reached: final*.mp4 and a final render are ignored
//
// These rules apply only to a run that ends in a preview (`state.finish`); a run that delivers
// final.mp4 reads exactly what it read before Phase 3.
//
// Making the music (Soundtrack, SD3). While the run waits on the music script's `make` (a Bash
// call, from the stream), the current step's text is "making the music", in place of its count.
// The next signal clears it: edit/preview/music.mp3 showing (the script puts the new version
// there once it is made) or anything else the run does after it. Only the script's own folder,
// edit/music/, which it may make as it starts, does not count. The step itself does not move.
//
// The step never moves backwards within a run: the model often goes back to fix things (E1
// re-rendered its graphics after the critic pass, with final.mp4 already written) and the step
// stays where it got to. A run starts at `floor`, the job's step when it started (Transcribe for
// a fresh run; the failed or stopped step for a retry or resume), so it never goes below that
// either. A job at Brief starts at Transcribe: the edit run has nothing to say about step 1.
// Steps can be skipped when one command does several (write the plan and the EDL, then render a
// preview): the step jumps, and the skipped ones get no timing for that run.
//
// Self-check passes (Check): video-use checks a render, fixes, re-renders and checks again, at
// most 3 times. A pass ends when the preview is rendered again after something was checked, so
// the pass count goes up on a new preview render that follows check activity (verify/ frames or a
// critic). File names in verify/ are the model's own, so they cannot be counted as passes.
// A replay of an earlier run's files (a resume, a retry, a job back at Brief) has no such
// history, and the stored `pass n/3` is gone (every START, RESUME and RETRY clears it), so the
// watcher hands it an estimate made from the times of the frames in verify/ (`estimateCheckPass`,
// the `pass` signal): one pass at least, more only where the files show an earlier round.

import { type Brief, RENDER_STEP, type StepId } from '@studio/shared';
import { classifyFile } from '../inbox/classify.js';
import type { RunFinish } from './run-finish.js';

// The steps this reducer can reach. Brief (1) is not one of them.
/** The first step of an edit run: where a fresh run starts and the lowest step the reducer reports. */
export const TRANSCRIBE_STEP = 2 satisfies StepId;
const SCAN_STEP = 3 satisfies StepId;
const PLAN_STEP = 4 satisfies StepId;
const CUT_STEP = 5 satisfies StepId;
const PREVIEW_STEP = 6 satisfies StepId;
/** The step with the self-check passes (`pass n/3`). */
export const CHECK_STEP = 7 satisfies StepId;

/** Upstream's cap on self-eval passes (video-use SKILL.md, step 7 of the process). */
export const SELF_CHECK_PASSES = 3;

export type FileChange = 'add' | 'change' | 'unlink';

/** The HyperFrames commands on a composition that tell where a run is (`hyperframes <tool>`). */
export type CompositionTool = 'lint' | 'check' | 'snapshot' | 'preview';

export type ProgressSignal =
  /**
   * A file or folder in `edit/` appeared, changed or went away. `path` is relative to `edit/`
   * with `/` separators; a folder ends in `/`. Anything with a dot-named part is ignored
   * (`.hyperframes/`, HyperFrames' `.render.hf-transaction-*`, the fake runner's `.x.partial`).
   */
  | { type: 'file'; path: string; change: FileChange }
  /** edl.json was read: how many overlays it places (the graphics planned so far). */
  | { type: 'edl'; overlays: number }
  /** A render was started (from the stream): a preview, or the final (by the file it writes). */
  | { type: 'render'; target: 'preview' | 'final' }
  /** A review sub-agent (the critic pass) was started. */
  | { type: 'review' }
  /** A HyperFrames command on the composition (from the stream); only a run that ends in a preview reads it. */
  | { type: 'composition'; tool: CompositionTool }
  /**
   * A replay's estimate of the self-check pass the earlier run was at (`estimateCheckPass`). It
   * only raises the pass of a run that is at Check, and never lowers one.
   */
  | { type: 'pass'; n: number }
  /**
   * The run started making music (Soundtrack): a Bash call to the music script's `make` (from the
   * stream). Until the next signal the step's text is "making the music".
   */
  | { type: 'music' };

export interface ProgressState {
  /** The step the run started at. The step is never below it. */
  readonly floor: StepId;
  readonly step: StepId;
  /**
   * What video-use transcribes (Transcribe's N): the brief's footage files, or every audio and
   * video file in the job folder when there is no brief (see `transcribeTotal`).
   */
  readonly sources: number;
  /** Transcript names (file name without `.json`) in `edit/transcripts/`. */
  readonly transcripts: readonly string[];
  /** takes_packed.md has been written: the transcripts are packed. */
  readonly packed: boolean;
  /** Graphics slots (`animations/slot_*`) seen. */
  readonly slots: readonly string[];
  /** Slots with a render (`render.mov`, or `render.mp4` / `render.webm`). */
  readonly rendered: readonly string[];
  /** Overlays edl.json places, as last read. */
  readonly edlOverlays: number;
  /** A preview video exists, so verify/ frames are frames of a render, not of the sources. */
  readonly preview: boolean;
  /** The self-check pass, from 1 once Check is reached (0 before). */
  readonly pass: number;
  /** Something was checked since the last preview render: the next one starts a new pass. */
  readonly checkedSinceRender: boolean;
  /**
   * How the run ends. `preview`: a live composition in edit/preview/, read as the Preview and Check
   * of the run, with no Render. `final`: edit/final.mp4, as before Phase 3.
   */
  readonly finish: RunFinish;
  /**
   * The music is being made: the run called the music script's `make` and nothing else has been
   * seen since. The step's text is then "making the music".
   */
  readonly music: boolean;
}

/** What the worker is told: the step and the text inside it (`progress(step, sub)`). */
export interface ProgressReport {
  readonly step: StepId;
  readonly sub: string | null;
}

export interface InitialProgress {
  /** The job's step when the run started (`null`, and Brief, count as Transcribe). */
  floor?: StepId | null;
  /** What the edit transcribes: `transcribeTotal(brief)`, or the audio and video files of the job. */
  sources?: number;
  /** The pass a run resumed at Check was at (from its `pass n/3`); ignored below Check. */
  pass?: number;
  /** How the run ends. Default `final`. */
  finish?: RunFinish;
}

export function initialProgress({
  floor,
  sources = 0,
  pass = 0,
  finish = 'final',
}: InitialProgress = {}): ProgressState {
  const step: StepId = floor == null || floor < TRANSCRIBE_STEP ? TRANSCRIBE_STEP : floor;
  return {
    floor: step,
    step,
    sources: Math.max(0, Math.floor(sources)),
    transcripts: [],
    packed: false,
    slots: [],
    rendered: [],
    edlOverlays: 0,
    preview: false,
    pass: step === CHECK_STEP ? Math.max(1, Math.floor(pass)) : 0,
    checkedSinceRender: false,
    finish,
    music: false,
  };
}

/**
 * Transcribe's N for a job with a brief (CVP-134): the audio and video files the brief calls
 * `footage`. Those are the ones the edit puts in `edit/transcripts/`. The others never get a
 * transcript there:
 * - `instructions` (voice notes, chats) get their transcripts in a folder of their own
 *   (`edit/brief/transcripts/` from the Brief run, `edit/instructions/transcripts/` in B8's run),
 *   never in `edit/transcripts/`;
 * - `ignore` files are left out of the edit, and so are `logo` and `reference` files;
 * - `music` is not transcribed either: video-use's `transcribe_batch.py` takes videos only, and
 *   its SKILL.md has a music bed go in untranscribed.
 * An image is never transcribed, whatever its role (a photo used as footage has no speech). The
 * kind is the file's extension, as the inbox scanner classifies it.
 */
export function transcribeTotal(brief: Pick<Brief, 'files'>): number {
  return brief.files.filter((file) => {
    if (file.role !== 'footage') return false;
    const kind = classifyFile(file.path);
    return kind === 'video' || kind === 'audio';
  }).length;
}

// --- small helpers ------------------------------------------------------------------------------

function withItem(list: readonly string[], item: string): readonly string[] {
  return list.includes(item) ? list : [...list, item].sort();
}

function withoutItem(list: readonly string[], item: string): readonly string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : list;
}

/** Moves forward to `target` (never back). Entering Check starts pass 1. */
function advance(state: ProgressState, target: StepId): ProgressState {
  if (target <= state.step) return state;
  return {
    ...state,
    step: target,
    pass: target === CHECK_STEP ? Math.max(state.pass, 1) : state.pass,
  };
}

/** Evidence that a render is being checked. Reaches Check from Preview; after Render it is moot. */
function checkActivity(state: ProgressState): ProgressState {
  if (state.step < PREVIEW_STEP || state.step > CHECK_STEP) return state;
  const next = advance(state, CHECK_STEP);
  return next.checkedSinceRender ? next : { ...next, checkedSinceRender: true };
}

/**
 * A preview render. Reaches Preview; during Check it starts the next pass, but only after
 * something was checked (two renders in a row are one pass).
 */
function previewRender(state: ProgressState, startsPass: boolean): ProgressState {
  if (state.step < PREVIEW_STEP) {
    return { ...advance(state, PREVIEW_STEP), checkedSinceRender: false };
  }
  if (state.step === CHECK_STEP && startsPass && state.checkedSinceRender) {
    return { ...state, pass: state.pass + 1, checkedSinceRender: false };
  }
  return state;
}

const SLOT_DIR = /^slot_/;
const SLOT_RENDER = /^render\.(mov|mp4|webm)$/i;
const PREVIEW_VIDEO = /^preview.*\.mp4$/i;

/** Whether `name`, a file at the top of edit/, is a preview render. */
export function isPreviewVideo(name: string): boolean {
  return PREVIEW_VIDEO.test(name);
}
const FINAL_VIDEO = /^final.*\.mp4$/i;

function onFile(state: ProgressState, path: string, change: FileChange): ProgressState {
  const isDir = path.endsWith('/');
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part.startsWith('.'))) return state;
  const present = change !== 'unlink';
  const [top = '', second = '', third = ''] = parts;
  const depth = parts.length;

  if (top === 'transcripts' && depth === 2 && !isDir && second.toLowerCase().endsWith('.json')) {
    const name = second.slice(0, -'.json'.length);
    const transcripts = present
      ? withItem(state.transcripts, name)
      : withoutItem(state.transcripts, name);
    return transcripts === state.transcripts ? state : { ...state, transcripts };
  }

  if (top === 'animations') {
    // Anything under animations/ means the graphics are being built: Cut.
    let next = present ? advance(state, CUT_STEP) : state;
    if (depth >= 2 && SLOT_DIR.test(second)) {
      if (present) {
        const slots = withItem(next.slots, second);
        if (slots !== next.slots) next = { ...next, slots };
      } else if (depth === 2 && isDir) {
        next = {
          ...next,
          slots: withoutItem(next.slots, second),
          rendered: withoutItem(next.rendered, second),
        };
      }
      if (depth === 3 && !isDir && SLOT_RENDER.test(third)) {
        const rendered = present
          ? withItem(next.rendered, second)
          : withoutItem(next.rendered, second);
        if (rendered !== next.rendered) next = { ...next, rendered };
      }
    }
    return next;
  }

  if (top === 'verify' && depth === 2 && !isDir) {
    // verify/ also holds filmstrips of the sources from the first look (src_full.png in E1),
    // so it is check activity only once a preview exists.
    return present && state.preview ? checkActivity(state) : state;
  }

  if (top === 'preview' && depth === 2 && !isDir && second === 'index.html') {
    // The composition of a run that ends in Review is its Preview, as preview.mp4 is a render's.
    if (state.finish !== 'preview' || !present) return state;
    const next = previewRender(state, change === 'change');
    return next.preview ? next : { ...next, preview: true };
  }

  if (depth !== 1 || isDir || !present) return state;

  if (top === 'takes_packed.md') {
    const next = advance(state, SCAN_STEP);
    return next.packed ? next : { ...next, packed: true };
  }
  if (top === 'project.md') return state.step >= SCAN_STEP ? advance(state, PLAN_STEP) : state;
  if (top === 'edl.json') return advance(state, CUT_STEP);
  if (PREVIEW_VIDEO.test(top)) {
    // `add` is the first sight of a render; `change` of an existing preview is a re-render (the
    // stream usually says so first, and then this is a no-op).
    const next = previewRender(state, change === 'change');
    return next.preview ? next : { ...next, preview: true };
  }
  if (FINAL_VIDEO.test(top))
    return state.finish === 'preview' ? state : advance(state, RENDER_STEP);
  return state;
}

/** The music script's own folder (edit/music/): the script may make it as a make starts. */
const MUSIC_DIR = /^music(\/|$)/;

/** Folds one signal into the state. Pure: the same state and signal always give the same result. */
export function reduceProgress(state: ProgressState, signal: ProgressSignal): ProgressState {
  const next = reduceSignal(state, signal);
  if (signal.type === 'music') return next.music ? next : { ...next, music: true };
  // Anything after the make clears "making the music", except the script's own folder showing.
  if (!next.music || (signal.type === 'file' && MUSIC_DIR.test(signal.path))) return next;
  return { ...next, music: false };
}

function reduceSignal(state: ProgressState, signal: ProgressSignal): ProgressState {
  switch (signal.type) {
    case 'file':
      return onFile(state, signal.path, signal.change);
    case 'edl': {
      const overlays = Math.max(0, Math.floor(signal.overlays));
      const next = advance(state, CUT_STEP);
      return next.edlOverlays === overlays ? next : { ...next, edlOverlays: overlays };
    }
    case 'render':
      if (signal.target === 'preview') return previewRender(state, true);
      // A run that ends in a preview renders no final video; if it does, that is not its Render.
      return state.finish === 'preview' ? state : advance(state, RENDER_STEP);
    case 'review':
      return checkActivity(state);
    case 'composition': {
      if (state.finish !== 'preview') return state;
      if (signal.tool === 'lint' || signal.tool === 'check') return checkActivity(state);
      const next = previewRender(state, false);
      return next.preview ? next : { ...next, preview: true };
    }
    case 'pass': {
      if (state.step !== CHECK_STEP) return state;
      const pass = Math.min(Math.max(state.pass, Math.floor(signal.n)), SELF_CHECK_PASSES);
      return pass === state.pass ? state : { ...state, pass };
    }
    case 'music':
      // The step stays where it is; `reduceProgress` sets `music`, and the report says so.
      return state;
  }
}

/**
 * Frames in verify/ this far apart (ms) belong to different check rounds; it is also how long
 * verify/ must have been quiet before the last preview render for a round to count as an earlier
 * pass. A render and the fix that comes before it take longer than this, and the frames of one
 * check land within seconds of each other.
 */
export const CHECK_ROUND_GAP_MS = 30_000;

/**
 * The self-check pass an earlier run was at, estimated from what it left in edit/ (CVP-138), for
 * a replay that has no `pass n/3` to go on. It needs only when the preview was last rendered
 * (`previewMs`, the newest preview*.mp4) and when each file in verify/ was written (`checkMs`).
 *
 * Frames are grouped into rounds (a check, a burst of frames). A round that ended well before the
 * preview was last rendered was followed by a re-render, so it belongs to an earlier pass. The very
 * first round is not counted: it is nearly always the first look at the sources (a filmstrip made
 * before any preview exists), and the file names, which are the model's own, cannot tell it apart.
 * So the estimate is 1 plus the earlier rounds after the first. It can be low (a run that never
 * made that first filmstrip, or whose passes ran closer together than the gap) and, rarely, high
 * (several filmstrips of the sources, far apart); it is never below 1.
 */
export function estimateCheckPass(previewMs: number | null, checkMs: readonly number[]): number {
  if (previewMs === null) return 1;
  const times = [...checkMs].sort((a, b) => a - b);
  const ends: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const time of times) {
    if (time - last > CHECK_ROUND_GAP_MS) ends.push(time);
    else ends[ends.length - 1] = time;
    last = time;
  }
  const earlier = ends.filter((end) => previewMs - end > CHECK_ROUND_GAP_MS).length;
  return 1 + Math.max(0, earlier - 1);
}

/** The text inside the current step while the run makes its music (Soundtrack). */
export const MAKING_MUSIC = 'making the music';

/**
 * The step and the count inside it, as the Jobs page shows them ("Cut · graphics 2/5"). While the
 * music is being made, the text is "making the music" instead ("Cut · making the music").
 */
export function progressReport(state: ProgressState): ProgressReport {
  if (state.music) return { step: state.step, sub: MAKING_MUSIC };
  switch (state.step) {
    case TRANSCRIBE_STEP: {
      const done = state.transcripts.length;
      const total = Math.max(state.sources, done);
      return { step: TRANSCRIBE_STEP, sub: total > 0 ? `${done}/${total}` : null };
    }
    case CUT_STEP: {
      const planned = Math.max(state.slots.length, state.edlOverlays);
      const done = Math.min(state.rendered.length, planned);
      return { step: CUT_STEP, sub: planned > 0 ? `graphics ${done}/${planned}` : null };
    }
    case CHECK_STEP: {
      const pass = Math.min(Math.max(state.pass, 1), SELF_CHECK_PASSES);
      return { step: CHECK_STEP, sub: `pass ${pass}/${SELF_CHECK_PASSES}` };
    }
    default:
      return { step: state.step, sub: null };
  }
}

/** The pass in a `pass n/3` text (a job's `subProgress` at Check), or 0. */
export function passFromSub(sub: string | null | undefined): number {
  const match = /\bpass (\d+)\b/.exec(sub ?? '');
  return match ? Number(match[1]) : 0;
}
