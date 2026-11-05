// What the quick-fix router may not decide on its own (Generated videos, GN6; formats, GN7).
//
// A quick fix changes only the live composition (edit/preview/): the layer on top of the cut. Two
// kinds of job cannot take one:
//
//   - A generated video. A note about what is IN a clip (a hand, a face, the logo, the water) needs a
//     new take of that clip from Higgsfield, and a note about the voice (stress, a pause) needs that
//     line made again by ElevenLabs. Only a revise run, started by Send, can make either, so such a
//     note is never quick and never the Revise tier's small change: it is `full`. Decided in code, by
//     the same word lists (and the same clock) as the hint under the note in Review
//     (`generateNoteHint`, shared), before the Haiku router is asked at all; the router's prompt has
//     one more line for the notes the words do not catch (fix-generated.md).
//   - A job with two or more formats. The second format has a composition of its own
//     (edit/preview-<id>/) that a quick fix does not touch, so a note the router calls quick would
//     leave the 1:1 as it was until a later round. It waits for Send instead (`revise`, which keeps
//     every format in step).
//
// `GuardedNoteRouter` wraps whichever router the engine uses (the Haiku one, the fake one of the
// dev seeds and the e2e engine, or a test's), so the rules hold for all of them. Any other job's
// note goes straight through, unchanged.

import { join } from 'node:path';
import {
  type GenerateNotePlan,
  generateNoteHint,
  type Job,
  type NoteRoute,
  noteMentionsClip,
  noteMentionsVoice,
  type ReviewNote,
} from '@studio/shared';
import { readGeneratedJob } from '../generate/generated-job.js';
import { readReviewPlan } from '../generate/review-plan.js';
import type { NoteRouter } from './fix-router.js';

/** Why a note on a job with two formats waits for Send. */
export const BOTH_FORMATS_WHY = 'it has to change both formats';

/** The route of a clip note on a generated video. */
export function clipNoteRoute(clipId: string | undefined): NoteRoute {
  return {
    tier: 'full',
    kind: clipId === undefined ? 'New take of a clip' : `New take of clip ${clipId}`,
    why: 'it needs a new take of a clip',
  };
}

/** The route of a voice note on a generated video. */
export const VOICE_NOTE_ROUTE: NoteRoute = {
  tier: 'full',
  kind: 'Remaking a voice line',
  why: 'it needs the voice line made again',
};

/**
 * The route a note on a generated video must have, or `null` when it is an ordinary edit note that
 * the router may sort. With the plan (the clips of the cut and the lines of the voice, as Review
 * has them), the note is read exactly as the hint under it reads it: a clip word with a clip on
 * screen, or a voice word. Without a plan (no valid hand-off on disk), the words alone decide: a
 * note that mentions either is held back from a quick fix.
 */
export function generatedNoteRoute(
  text: string,
  atSec: number,
  plan: GenerateNotePlan | null,
): NoteRoute | null {
  if (plan !== null) {
    const hint = generateNoteHint(text, Math.round(Math.max(0, atSec) * 1000), plan);
    if (hint.kind === 'clip') return clipNoteRoute(hint.clipId);
    if (hint.kind === 'voice') return VOICE_NOTE_ROUTE;
    return null;
  }
  if (noteMentionsClip(text)) return clipNoteRoute(undefined);
  if (noteMentionsVoice(text)) return VOICE_NOTE_ROUTE;
  return null;
}

/** A quick route on a job with two or more formats is raised to `revise`: it waits for Send, which keeps every format in step. */
export function raiseForFormats(job: Pick<Job, 'formats'>, route: NoteRoute): NoteRoute {
  if (route.tier !== 'quick' || (job.formats?.length ?? 0) < 2) return route;
  return { tier: 'revise', kind: route.kind, why: BOTH_FORMATS_WHY };
}

export interface GuardedNoteRouterOptions {
  /** A job's folder is `<inboxPath>/<job.relPath>`: its brief says whether it is generated, its edit/generate/ has the plan. */
  inboxPath: string;
}

/** A router with the two rules above in front of and behind it. */
export class GuardedNoteRouter implements NoteRouter {
  private readonly inner: NoteRouter;
  private readonly inboxPath: string;

  constructor(inner: NoteRouter, options: GuardedNoteRouterOptions) {
    this.inner = inner;
    this.inboxPath = options.inboxPath;
  }

  async route(job: Job, note: ReviewNote, signal?: AbortSignal): Promise<NoteRoute> {
    signal?.throwIfAborted();
    const text = note.text?.trim() ?? '';
    if (text !== '') {
      const jobDir = join(this.inboxPath, job.relPath);
      if ((await readGeneratedJob(jobDir)) !== null) {
        const guarded = generatedNoteRoute(text, note.atSec, await readReviewPlan(jobDir));
        if (guarded !== null) return guarded;
      }
    }
    // The reads above took a moment: a router that listens for the abort only once it is called
    // would never hear one that came in meanwhile, and the engine's stop would wait for it forever.
    signal?.throwIfAborted();
    return raiseForFormats(job, await this.inner.route(job, note, signal));
  }
}
