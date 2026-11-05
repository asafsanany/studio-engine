/** Height of the controls bar under the video (the board's 76 px), in CSS px. */
export const CONTROLS_HEIGHT = 76;

export interface FitPlayerInput {
  /** The composition's size. Only the ratio matters. */
  videoW: number;
  videoH: number;
  /** The largest box the video may take, in CSS px. */
  maxW: number;
  maxH: number;
}

export interface PlayerBox {
  width: number;
  height: number;
}

/**
 * The largest box with the video's aspect ratio that fits in `maxW` × `maxH`, as whole pixels. The
 * player column is exactly this wide, so there are no bars at the sides of a 9:16 video and none
 * above or below a 16:9 one.
 *
 * `maxW` and `maxH` are floored first. The box never exceeds them, and its ratio is the video's to
 * within one pixel. Anything that is not a finite number above 0 gives 0 × 0.
 */
export function fitPlayer({ videoW, videoH, maxW, maxH }: FitPlayerInput): PlayerBox {
  for (const value of [videoW, videoH, maxW, maxH]) {
    if (!Number.isFinite(value) || value <= 0) return { width: 0, height: 0 };
  }
  const boxW = Math.floor(maxW);
  const boxH = Math.floor(maxH);
  if (boxW * videoH <= boxH * videoW) {
    // Width-bound: the width is what runs out first.
    return { width: boxW, height: Math.round((boxW * videoH) / videoW) };
  }
  return { width: Math.round((boxH * videoW) / videoH), height: boxH };
}
