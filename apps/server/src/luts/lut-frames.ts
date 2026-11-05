// The files the engine ships for the LUTs page (LU0): apps/server/assets/luts/. The folder sits
// next to src/ and dist/ (like graphics/ and drizzle/), so the same path works from both and the
// build has nothing to copy. OWNER: LU2 (LU0 copied the files in).
//
//   frames/<frame>.jpg        the three test photos, 396×704 (9:16): person, street, interior
//   frames/<frame>-log.jpg    the same frame flattened to stand in for log footage, the "before"
//                             of a Camera LUT
//   frames/CREDITS.md         whose photos they are (the page says "Photo: Benjamin Combs, Unsplash")

import { fileURLToPath } from 'node:url';
import {
  LUT_FRAME_CREDITS,
  type LutFrame,
  type LutKind,
  type LutPreviewSide,
} from '@studio/shared';

/** `apps/server/assets/luts/`, from `src/luts/` or `dist/luts/` alike. */
export const LUTS_ASSETS_DIR = fileURLToPath(new URL('../../assets/luts/', import.meta.url));

/** `apps/server/assets/luts/frames/`. */
export const LUT_FRAMES_DIR = fileURLToPath(new URL('../../assets/luts/frames/', import.meta.url));

/** The path of a test frame: the plain photo, or (`flat`) its flat log twin. */
export function lutFramePath(frame: LutFrame, flat = false): string {
  return `${LUT_FRAMES_DIR}${frame}${flat ? '-log' : ''}.jpg`;
}

/**
 * The photo a still starts from. Before: the plain frame, or for a Camera LUT its flat -log twin
 * (the footage that LUT is made for). After: always the plain frame; for a Camera LUT it *is* the
 * answer (the real LUT is not run on a non-log photo; the pane says "Shown on a log sample of the
 * frame."), for the rest it is the input of the ffmpeg run.
 */
export function lutFrameFile(frame: LutFrame, side: LutPreviewSide, kind: LutKind): string {
  return lutFramePath(frame, side === 'before' && kind === 'camera');
}

/** Whether the still needs an ffmpeg run: only the "after" of a LUT that is not a Camera one. */
export function lutStillNeedsGrade(side: LutPreviewSide, kind: LutKind): boolean {
  return side === 'after' && kind !== 'camera';
}

/** The line under the frame: "Photo: Benjamin Combs, Unsplash". */
export function lutFrameCredit(frame: LutFrame): string {
  return `Photo: ${LUT_FRAME_CREDITS[frame]}`;
}
