import { CONTROLS_HEIGHT, fitPlayer, type PlayerBox } from './fit-player';

// The review dialog's size (spec: Phase 3 architecture §8, board P3Review). The video box is the
// largest that fits the window minus 1 rem on each side and the fixed parts around it; the dialog is
// exactly that box plus those parts.

export const REVIEW_HEADER_HEIGHT = 60;
export const REVIEW_FOOTER_HEIGHT = 64;
export const NOTES_PANEL_WIDTH = 360;
/** The job's chat in place of the notes (Draft & chat, board DCDialog). */
export const CHAT_PANEL_WIDTH = 440;
/** The dialog's border, on each side. */
export const REVIEW_DIALOG_BORDER = 1;
/** Space left free around the dialog on each side: the spec's "viewport − 2rem". */
export const REVIEW_DIALOG_MARGIN = 16;
/** The smallest video box laid out, so a very small window still shows a player. */
export const MIN_VIDEO_BOX = 160;
/** Used where there is no window to measure (a server render) or it reports nothing usable. */
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;

export interface ReviewDialogLayoutInput {
  viewportWidth: number;
  viewportHeight: number;
  /** The composition's size. Only the ratio matters. */
  videoWidth: number;
  videoHeight: number;
  /** The column on the right: the notes (360, the default) or the chat (440). */
  panelWidth?: number;
}

export interface ReviewDialogLayout {
  /** PreviewPlayer's maxWidth / maxHeight: the video box only (the controls come below, outside maxHeight). */
  maxVideoWidth: number;
  maxVideoHeight: number;
  /** The video box: fitPlayer of the above (the player computes the same one). */
  video: PlayerBox;
  /** The dialog's outer size, borders included (border-box). */
  width: number;
  height: number;
}

function usable(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The dialog for a window and a video. The player column is exactly as wide as the video (no bars):
 * `fitPlayer` fits it by height, and by width when the video plus the 360 px notes panel does not
 * fit. A non-finite or non-positive window side uses `DEFAULT_VIEWPORT`'s; the video box is never
 * smaller than `MIN_VIDEO_BOX`.
 */
export function reviewDialogLayout({
  viewportWidth,
  viewportHeight,
  videoWidth,
  videoHeight,
  panelWidth = NOTES_PANEL_WIDTH,
}: ReviewDialogLayoutInput): ReviewDialogLayout {
  const chromeW = panelWidth + 2 * REVIEW_DIALOG_BORDER;
  const chromeH =
    REVIEW_HEADER_HEIGHT + CONTROLS_HEIGHT + REVIEW_FOOTER_HEIGHT + 2 * REVIEW_DIALOG_BORDER;
  const vw = usable(viewportWidth, DEFAULT_VIEWPORT.width);
  const vh = usable(viewportHeight, DEFAULT_VIEWPORT.height);
  const maxVideoWidth = Math.max(
    MIN_VIDEO_BOX,
    Math.floor(vw - 2 * REVIEW_DIALOG_MARGIN - chromeW),
  );
  const maxVideoHeight = Math.max(
    MIN_VIDEO_BOX,
    Math.floor(vh - 2 * REVIEW_DIALOG_MARGIN - chromeH),
  );
  const video = fitPlayer({
    videoW: videoWidth,
    videoH: videoHeight,
    maxW: maxVideoWidth,
    maxH: maxVideoHeight,
  });
  return {
    maxVideoWidth,
    maxVideoHeight,
    video,
    width: video.width + chromeW,
    height: video.height + chromeH,
  };
}

/**
 * The dialog of a job with two or more formats (Generated videos): the same window rules, and a
 * video box as big as the largest format's, so switching the format never changes the dialog's size
 * (the switch sits in the header and would move under the pointer). Each format's own box is
 * `fitPlayer` of its size in `maxVideoWidth` × `maxVideoHeight`; the smaller one sits in the middle
 * of the black stage. With one video it is {@link reviewDialogLayout}.
 */
export function reviewDialogLayoutOfFormats({
  viewportWidth,
  viewportHeight,
  videos,
  panelWidth,
}: {
  viewportWidth: number;
  viewportHeight: number;
  videos: readonly { width: number; height: number }[];
  panelWidth?: number;
}): ReviewDialogLayout {
  const layouts = videos.map((video) =>
    reviewDialogLayout({
      viewportWidth,
      viewportHeight,
      videoWidth: video.width,
      videoHeight: video.height,
      panelWidth,
    }),
  );
  const first =
    layouts[0] ??
    reviewDialogLayout({
      viewportWidth,
      viewportHeight,
      videoWidth: 0,
      videoHeight: 0,
      panelWidth,
    });
  const box = {
    width: Math.max(...layouts.map((layout) => layout.video.width), 0),
    height: Math.max(...layouts.map((layout) => layout.video.height), 0),
  };
  return {
    ...first,
    video: box,
    width: first.width - first.video.width + box.width,
    height: first.height - first.video.height + box.height,
  };
}
