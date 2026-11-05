// The runner contract of the Graphics library (Graphics plan, "The run"; GR0, finished): what the
// graphic worker (graphic-worker.ts, GR1) asks of "a run that makes one version of a graphic". The
// real one is the headless Claude run (claude-graphic.ts, GR2); STUDIO_RUNNER=fake gets the fake
// (fake-graphic-runner.ts, GR2); createGraphicRunner (create-graphic-runner.ts) picks one. Tests
// of the worker give it a stand-in.
//
// Before a run the worker has reset `<dir>/work/` from the newest version (or made it, for v1),
// written work/index.html and work/vendor/gsap.min.js, and copied _Fonts into `<dir>/fonts/`. The
// run works in `<dir>/work/` and is done when work/about.json exists and lint passes. After it the
// worker checks work/ (graphic-check.ts) and only then makes it versions/v<version>/.

import type { Effort, GraphicMessage, GraphicStep } from '@studio/shared';

export interface GraphicRunRequest {
  graphic: {
    /** 12 hex characters: the graphic's sub-composition is compositions/lib-<id>.html. */
    id: string;
    /** Its name now ("New graphic …" until v1 names it). */
    name: string;
    /** Absolute path of its folder, `<inbox>/_Graphics/<folder>`. The run works in `<dir>/work`. */
    dir: string;
  };
  /** The owner's message this run answers. */
  message: {
    id: string;
    text: string;
    /** The files they attached: names inside `<dir>/refs/` (the prompt gives them as ../refs/<name>). */
    refs: readonly string[];
    /** The level to run at: the message's own, or the default (`runEffort`). */
    effort: Effort;
  };
  /** The version this run makes. */
  version: number;
  /** True for v1 (graphic-make.md); false for a change (graphic-change.md). */
  first: boolean;
  /** The chat before `message`, oldest first: what the run is told was said so far. */
  conversation: readonly GraphicMessage[];
  /** Aborted by Stop, by a delete and by the engine shutting down: the run's process tree stops. */
  signal: AbortSignal;
  /** Told each time the run moves on to another step (0 reading, 1 building, 2 checking). */
  onStep: (step: GraphicStep) => void;
}

export type GraphicRunOutcome =
  | { ok: true }
  /** `error` is one plain sentence for the chat ("It took longer than 20 minutes."). */
  | { ok: false; error: string };

export interface GraphicRunner {
  /** `claude` for the headless Claude run, `fake` for the stand-in of STUDIO_RUNNER=fake. */
  readonly kind: 'claude' | 'fake';
  /**
   * Makes one version in `<dir>/work/`. Resolves once the run has ended, also when it failed or
   * was aborted; never rejects for a run that went wrong.
   */
  run(request: GraphicRunRequest): Promise<GraphicRunOutcome>;
}
