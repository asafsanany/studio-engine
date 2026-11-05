// The style run component (Phase 2 plan §5): what the style worker hands one pass to. The Claude
// run (claude-style.ts) is a short headless Sonnet session; the fake one (fake-style.ts, under
// `STUDIO_RUNNER=fake`) writes a canned style for dev, tests and e2e. Both only write
// `_Style/style.md.new`: checking it and putting it in place is the worker's (style-install.ts).
// `createStyleRunner` (create-style-runner.ts) picks one.
//
// Both also run the series passes (Series plan §3) as a `SeriesRunner`: they write
// `_Series/<name>/series.md.new`, and for a Start a series that rewrites the style also
// `_Style/style.md.new`. The worker runs a series pass on any style runner that has `runSeries`.

import type { SeriesFile, SeriesPass, StylePass } from './style-pass.js';

/** How every style failure starts, as `client_styles.error` shows it. */
export const STYLE_STOPPED = 'Style stopped:';

/** How every series failure starts, as `series.error` shows it. */
export const SERIES_STOPPED = 'Series stopped:';

/** What a Learn pass runs on, besides the pass itself. */
export interface LearnContext {
  /** The finished job's folder, `<inbox>/<Client>/<Job>`: the run's working directory. */
  jobDir: string;
  /**
   * What the engine copied into `_Style/kit/` before the run: the job's slot folders, or
   * `composition` for an edit built as one composition (C14). None when the job has neither; the
   * client's kit is then as it was.
   */
  kit: readonly string[];
}

export interface StyleRunRequest {
  clientId: string;
  /** The client folder's name. */
  client: string;
  /** The client's `_Style` folder, where style.md.new goes. */
  styleDir: string;
  /** What to do, its mode already settled against the folder. */
  pass: StylePass;
  /** Given for a Learn pass, and only then. */
  learn?: LearnContext;
  /** Aborted when the engine shuts down (reason `'shutdown'`): stop, leave the style as it is. */
  signal: AbortSignal;
}

/** `ok` once style.md.new is written; otherwise why not ("Style stopped: …"). */
export type StyleRunOutcome = { ok: true } | { ok: false; error: string };

export interface StyleRunner {
  run(request: StyleRunRequest): Promise<StyleRunOutcome>;
}

/**
 * What `_Style/kit/` holds once a Start a series that rewrites the style is in place (C23), so the
 * run writes style.md's ## Kit for it:
 *
 *   keep     the kit did not come from this series: it stays, and so does ## Kit
 *   restore  it came from this series and goes to it, and the kit it replaced comes back from style
 *            history: its top folders (`names`), the job it came from (`job`, null when unknown)
 *            and the ## Kit lines of the style it went with (`section`, null when it had none)
 *   none     it came from this series and goes to it, with no earlier kit to put back
 */
export type StartStyleKit =
  | { kind: 'keep' }
  | {
      kind: 'restore';
      names: readonly string[];
      job: string | null;
      section: string | null;
    }
  | { kind: 'none' };

/**
 * What a `replace` from an approved episode with review notes marked Series runs on, besides the
 * episode (C26): the notes and what the episode's revise runs did with them.
 */
export interface SeriesNotesContext {
  /** The notes files of the series folder that are still there (`pass.notes`, settled). */
  files: readonly SeriesFile[];
  /** The `## Round N` sections of the episode's edit/project.md as they are, or null when it has none. */
  rounds: string | null;
}

/** What one series pass runs on (Series plan §3). */
export interface SeriesRunRequest {
  clientId: string;
  /** The client folder's name. */
  client: string;
  /** The series folder, `<inbox>/<Client>/_Series/<name>`, where series.md.new goes. */
  seriesDir: string;
  /** The client's `_Style` folder: where style.md.new goes when `writesStyle`. */
  styleDir: string;
  /** What to do. */
  pass: SeriesPass;
  /** The episode's folder, `<inbox>/<Client>/<job>` (the run's working directory). */
  jobDir: string;
  /** Whether the run also writes `_Style/style.md.new`: a `start` while the client has a style.md. */
  writesStyle: boolean;
  /** Given with `writesStyle`: what `_Style/kit/` holds once the start is in place. */
  styleKit?: StartStyleKit;
  /** Given for a pass with `notes` whose files are still there (C26). */
  notes?: SeriesNotesContext;
  /** Aborted when the engine shuts down (`'shutdown'`) or Undo cancels the pass (`'undo'`). */
  signal: AbortSignal;
}

/** Writes series.md.new (and style.md.new when asked): the Claude run or the fake one. */
export interface SeriesRunner {
  runSeries(request: SeriesRunRequest): Promise<StyleRunOutcome>;
}

/** Whether a style runner can also run series passes. */
export function isSeriesRunner(runner: unknown): runner is SeriesRunner {
  return (
    typeof runner === 'object' &&
    runner !== null &&
    typeof (runner as Partial<SeriesRunner>).runSeries === 'function'
  );
}
