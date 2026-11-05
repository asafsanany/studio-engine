// Where the player lands when a quick fix lands (Quick fixes, QF7): the player loads the changed
// composition, goes to the moment of the note the fix was for, and stops there, so the owner sees the
// change at once. Plain functions, so the tests need no browser. The hook that uses them is
// use-review-fix.ts; the player does the landing (music/SwapPlayer.tsx, `landNext`).
//
//   fix lands: job.fix (fixed) ─▶ the fixes' `rev` changes ─▶ the preview's address gets a new `&f=`
//     ─▶ a second player loads behind the one on show ─▶ it is ready: it goes to the note's time and
//        stays paused there (a music pick instead goes back to where the old player was, and plays on)
//   Undo: the same, to the undone fix's note: the files are put back, so the player loads them again

import type { FixStatus, QuickFix } from '@studio/shared';

/** Where to land for a rev: the address that carries it first is the one that lands. */
export interface FixLanding {
  /** The fixes' `rev` (`&f=<rev>` in the preview's address). */
  rev: number;
  /** The note's time, in seconds. */
  sec: number;
}

/**
 * The `rev` that goes into the preview's address: the shared hook's (the newest `endedAt` among the
 * fixes that are fixed or undone) plus one for every fix that was undone. An Undo puts the files
 * back, so the player must load them again, but it does not move any `endedAt`; counting the undone
 * fixes moves the rev at every Undo, and never moves it when nothing changed. `null` while no fix
 * has landed.
 */
export function playerRev(fixes: readonly QuickFix[], rev: number | null): number | null {
  if (rev === null) return null;
  return rev + fixes.filter((fix) => fix.status === 'undone').length;
}

/**
 * Where the player lands because a fix landed or was undone while Review was open, or `null`. It is
 * the fix this page saw in another state a moment ago (`seen`: each fix's status at the last look)
 * and that is fixed or undone now; of several, the one that ended last. A fix this page never saw in
 * another state (Review opened with it already made: the first answer holds it fixed) is not a
 * landing: opening Review must not jump to a fix. No landing either when the fix's note is gone (no
 * moment to go to) or the notes are not in.
 */
export function fixLanding(input: {
  rev: number | null;
  fixes: readonly QuickFix[];
  seen: ReadonlyMap<string, FixStatus>;
  notes: readonly { id: string; atSec: number }[] | undefined;
}): FixLanding | null {
  const { rev, fixes, seen, notes } = input;
  if (rev === null) return null;
  let landed: QuickFix | null = null;
  let landedAt = Number.NEGATIVE_INFINITY;
  for (const fix of fixes) {
    if (fix.status !== 'fixed' && fix.status !== 'undone') continue;
    const was = seen.get(fix.id);
    if (was === undefined || was === fix.status) continue;
    const at = fix.endedAt === null ? 0 : Date.parse(fix.endedAt);
    if (landed === null || at >= landedAt) {
      landed = fix;
      landedAt = at;
    }
  }
  if (landed === null) return null;
  const sec = notes?.find((note) => note.id === landed.noteId)?.atSec;
  return sec === undefined ? null : { rev, sec };
}
