// One pill at a time on the video (Quick fixes, QF7): three things can put a pill at the bottom left
// of the player, and this is the one place that says which of them wins.
//
//   1. the font preview pill (FN19: "Previewing @Heebo Bold"), while the note box names a font;
//   2. the fix pill (QF7: "Fixing at 0:12…", "Changed at 0:12"), while a fix runs or has just landed;
//   3. the paused-look pill (LU11: "Previewing luts/cinematic"), while the note box names a LUT.
//
// The pill that loses is not drawn at all: a font preview restyles the live page, a fix puts its
// before frame over the video and the look puts its own still over it, so two of them would fight
// over the picture as well as over the corner.

/** Which pill is on the video. */
export type PillKind = 'font' | 'fix' | 'look';

/** What each pill would show right now if it were alone. */
export interface PillWants {
  font: boolean;
  fix: boolean;
  look: boolean;
}

/** The pill to draw, or `null` when none wants to be there. */
export function choosePill(wants: PillWants): PillKind | null {
  if (wants.font) return 'font';
  if (wants.fix) return 'fix';
  if (wants.look) return 'look';
  return null;
}
