// The pill on the video for a quick fix (Quick fixes, QF7; board QFReview, states 3 "Fixing it now",
// 4 "Fixed" and 5 "Holding Compare"). Plain functions, so the tests need no browser. The pill itself
// is FixPill.tsx; the player asks `fixPillOf` on every render with what it knows (ready, playing,
// where the playhead is), and the Review dialog gives it the plan.
//
//   a fix runs for the note at 0:12                  ─▶ spinner + "Fixing at 0:12…", no button
//   a fix landed for the note at 0:12, paused there  ─▶ "Changed at 0:12" + Compare
//     Compare held                                   ─▶ "Before the fix", before.png over the video
//   the video plays, or the playhead is elsewhere    ─▶ no pill
//   the fix was undone                               ─▶ no pill (it is not a fixed fix any more)
//
// Where it sits depends on how wide the video is (`fixPillFit`): on the Mac it stays inside the
// video, on the phone it is as wide as its words need and may reach past the video's edge.

import type { QuickFix, ReviewNote } from '@studio/shared';
import { noteTime } from '../notes-logic';
import { FIX_PILL_TEXT } from './fix-pill-text';

/** "Within half a second of that note's time": how near the paused playhead must be to the fix's moment. */
export const FIX_PILL_NEAR_SEC = 0.5;

/** The still of a fix's moment as it was before the fix (`GET /api/jobs/:id/fixes/:fixId/compare/before.png`). */
export function fixBeforeUrl(jobId: string, fixId: string, baseUrl = ''): string {
  return `${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/fixes/${encodeURIComponent(fixId)}/compare/before.png`;
}

/** A fix that landed, and where in the video it changed something. */
export interface ChangedMoment {
  fixId: string;
  /** The note's time. */
  atSec: number;
  /** The before still; `null` for a fix without Compare (`hasCompare` false). */
  beforeSrc: string | null;
}

/** What the player needs to draw the pill: the fix that runs and the ones that landed. */
export interface FixPillPlan {
  /** The fix that runs now, with its note's time; `null` when none does. */
  running: { fixId: string; atSec: number } | null;
  /** The fixes that landed (fixed, not undone), each with its moment. */
  changed: readonly ChangedMoment[];
}

/**
 * The plan for a job's fixes and notes, or `null` when there is nothing to draw (no fix runs and none
 * is fixed). A fix whose note is not in the list (deleted, or the list is not in yet) has no moment,
 * so it is left out.
 */
export function fixPillPlan(input: {
  jobId: string;
  fixes: readonly QuickFix[];
  notes: readonly Pick<ReviewNote, 'id' | 'atSec'>[] | undefined;
}): FixPillPlan | null {
  const { jobId, fixes, notes } = input;
  if (notes === undefined || fixes.length === 0) return null;
  const atOf = (noteId: string) => notes.find((note) => note.id === noteId)?.atSec;
  let running: FixPillPlan['running'] = null;
  const changed: ChangedMoment[] = [];
  for (const fix of fixes) {
    const atSec = atOf(fix.noteId);
    if (atSec === undefined) continue;
    if (fix.status === 'running') running = { fixId: fix.id, atSec };
    if (fix.status === 'fixed') {
      changed.push({
        fixId: fix.id,
        atSec,
        beforeSrc: fix.hasCompare ? fixBeforeUrl(jobId, fix.id) : null,
      });
    }
  }
  return running === null && changed.length === 0 ? null : { running, changed };
}

/**
 * How the pill sits on the video:
 *
 * - `video`: at the bottom left, never wider than the video, its words cut with "…" when the video
 *   is narrow (the Mac's Review, where the video is wide).
 * - `corner`: at the bottom left like that, finger-sized, and as wide as its words (the phone, with
 *   a video wide enough for it).
 * - `centered`: finger-sized and as wide as its words, in the middle of the video's bottom, reaching
 *   past both edges equally onto the black stage (the phone's narrow video: the notes list is open
 *   or the keyboard is up).
 */
export type FixPillFit = 'video' | 'corner' | 'centered';

/**
 * The video (px wide) from which the phone's pill sits at the corner. The widest pill, "Changed at
 * 12:34" with Compare, is about 215 px, 10 px in from the corner and 10 px from the right edge; a
 * narrower video would have it reach far past the video's right edge, so there it is centered instead.
 */
export const FIX_PILL_CORNER_MIN_VIDEO_PX = 240;

/** The pill's fit for a video of this width (`phone`: the phone's layout, the player's `fitToStage`). */
export function fixPillFit(input: { phone: boolean; videoWidth: number }): FixPillFit {
  if (!input.phone) return 'video';
  return input.videoWidth >= FIX_PILL_CORNER_MIN_VIDEO_PX ? 'corner' : 'centered';
}

/** What the pill says and shows right now. */
export type FixPillView =
  | { kind: 'fixing'; fixId: string; time: string }
  | { kind: 'changed'; fixId: string; time: string; beforeSrc: string | null };

/**
 * The pill for where the player is, or `null`. While a fix runs it says so, whatever the video does
 * (it is the news that something is happening). After a fix it is there only while the video is
 * paused within {@link FIX_PILL_NEAR_SEC} of the fix's moment (the nearest one when two are close),
 * and goes away when the video plays or moves off it. Nothing before the player is ready.
 */
export function fixPillOf(state: {
  plan: FixPillPlan | null;
  ready: boolean;
  playing: boolean;
  currentSec: number;
}): FixPillView | null {
  const { plan, ready, playing, currentSec } = state;
  if (plan === null || !ready) return null;
  if (plan.running !== null) {
    return { kind: 'fixing', fixId: plan.running.fixId, time: noteTime(plan.running.atSec) };
  }
  if (playing) return null;
  let nearest: ChangedMoment | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (const moment of plan.changed) {
    const away = Math.abs(currentSec - moment.atSec);
    if (away <= FIX_PILL_NEAR_SEC && away < gap) {
      nearest = moment;
      gap = away;
    }
  }
  if (nearest === null) return null;
  return {
    kind: 'changed',
    fixId: nearest.fixId,
    time: noteTime(nearest.atSec),
    beforeSrc: nearest.beforeSrc,
  };
}

/** The pill's words for a view: the fixing line, "Changed at 0:12", or "Before the fix" while Compare is held. */
export function fixPillText(view: FixPillView, comparing: boolean): string {
  if (view.kind === 'fixing') return FIX_PILL_TEXT.fixing(view.time);
  return comparing ? FIX_PILL_TEXT.before : FIX_PILL_TEXT.changed(view.time);
}
