// What the pane's "On a frame" view decides, apart from how it looks (Fonts plan, "The page (web)";
// board FOPage, `start=frame`): the three test frames and their chips, whose photo each is, where
// the picture comes from, and the words. Plain values and functions, so the tests need no browser.

import {
  FONT_FRAME_CREDITS,
  FONT_FRAME_LABELS,
  FONT_FRAMES,
  type FontFrame,
  fontFrameSchema,
  HEBREW_FALLBACK_FONT,
} from '@studio/shared';

/** The frame on a fresh visit. */
export const DEFAULT_FONT_FRAME: FontFrame = 'person';

/** The frame is 9:16, shown at this size in pixels (the board). */
export const FONT_PANE_FRAME = { width: 252, height: 448 } as const;

/** The words of the view. */
export const FONT_FRAME_TEXT = {
  /** The label of the chips as a group. */
  chips: 'Frame',
  /** What the picture is, for a screen reader. */
  alt: 'A frame from a video',
} as const;

/** The caption's shadow: it keeps the white letters readable on a bright photo (the board). */
export const FONT_FRAME_CAPTION_SHADOW = '0 2px 10px rgba(0,0,0,0.75)';

/** The line under the frame of a font with no Hebrew letters. */
export function frameNoHebrewNote(fallback: string = HEBREW_FALLBACK_FONT): string {
  return `No Hebrew letters in this font, so the Hebrew line is in ${fallback}.`;
}

/** Whether `value` names one of the frames. */
export function isFontFrame(value: unknown): value is FontFrame {
  return fontFrameSchema.safeParse(value).success;
}

/** The chips, in order, with their words: Person, Street, Interior. */
export const FONT_FRAME_CHIPS: readonly { frame: FontFrame; label: string }[] = FONT_FRAMES.map(
  (frame) => ({ frame, label: FONT_FRAME_LABELS[frame] }),
);

/**
 * `GET /api/fonts/frame/<frame>.jpg`: the photo, served for good (the LUTs' test frames). The
 * address never changes for a frame, so an `<img src>` is all the page needs.
 */
export function fontFrameUrl(frame: FontFrame): string {
  return `/api/fonts/frame/${frame}.jpg`;
}

/** "Photo: Benjamin Combs, Unsplash". */
export function fontFrameCredit(frame: FontFrame): string {
  return `Photo: ${FONT_FRAME_CREDITS[frame]}`;
}
