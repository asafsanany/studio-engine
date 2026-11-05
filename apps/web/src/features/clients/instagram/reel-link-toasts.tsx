import type { CSSProperties } from 'react';
import { toast } from 'sonner';
import { ACTION_ERROR_MS } from '@/features/jobs/cells/ActionError';
import { UNDO_BUTTON_CLASS } from '@/features/jobs/use-look/use-look-toasts';
import { instantDayText, type TextOptions } from './instagram-text';

/** How long a message about a link stays: long enough to read it and reach for Undo. */
export const REEL_LINK_TOAST_MS = 7000;

/**
 * The messages about a link are 420 px wide, like the archive's: "Linked “<name>” to the reel of
 * Tue 20 Oct" then fits on one line, with Undo beside it. Sonner draws a toast `var(--width)` wide,
 * so this widens just these, and a toast is anchored to the right edge, so it grows to the left.
 */
export const REEL_LINK_TOAST_STYLE = { '--width': '420px' } as CSSProperties;

/** What a message needs to know about the video: its id and its name. */
export interface ReelLinkToastJob {
  id: string;
  name: string;
}

/** What a message needs to know about the reel: which one, and when it was posted. */
export interface ReelLinkToastReel {
  shortcode: string;
  postedAt: string;
}

/**
 * The toast id of one kind of message about a reel's link: the newest replaces the one before (so
 * Undo is always the newest change's). Each kind has its own id: Undo closes its message when it is
 * pressed, and a message that reuses the id of one that is closing is swallowed by it.
 */
export const reelLinkToastId = (
  kind: 'linked' | 'unlinked' | 'refused' | 'undo-refused',
  shortcode: string,
) => `reel-link:${kind}:${shortcode}`;

/** A message that lasts 7 s, 420 px wide, and has Undo, a quiet outlined button (the archive's). */
function withUndo(onUndo: () => void) {
  return {
    duration: REEL_LINK_TOAST_MS,
    style: REEL_LINK_TOAST_STYLE,
    action: { label: 'Undo', onClick: onUndo },
    classNames: { actionButton: UNDO_BUTTON_CLASS },
  };
}

/** After Link to job: `Linked “<name>” to the reel of Tue 20 Oct`, with Undo (Unlink). The name keeps its direction. */
export function announceReelLinked(
  reel: ReelLinkToastReel,
  job: ReelLinkToastJob,
  onUndo: () => void,
  options: TextOptions = {},
): void {
  toast(
    <>
      Linked “<bdi>{job.name}</bdi>” to the reel of {instantDayText(reel.postedAt, options)}
    </>,
    { id: reelLinkToastId('linked', reel.shortcode), ...withUndo(onUndo) },
  );
}

/** After Unlink: `Unlinked “<name>” from the reel of Tue 20 Oct`, with Undo (Link again). */
export function announceReelUnlinked(
  reel: ReelLinkToastReel,
  job: ReelLinkToastJob,
  onUndo: () => void,
  options: TextOptions = {},
): void {
  toast(
    <>
      Unlinked “<bdi>{job.name}</bdi>” from the reel of {instantDayText(reel.postedAt, options)}
    </>,
    { id: reelLinkToastId('unlinked', reel.shortcode), ...withUndo(onUndo) },
  );
}

/**
 * The server refused a link or an unlink (409: the video is another client's, is not delivered, or
 * is linked already, or the reel is) or could not be reached: `Couldn't link “<name>”` or
 * `Couldn't unlink “<name>”`, then the server's own words. The row is back as it was.
 */
export function announceReelLinkRefused(
  kind: 'link' | 'unlink',
  reel: ReelLinkToastReel,
  job: ReelLinkToastJob,
  message: string,
): void {
  toast.error(
    <>
      Couldn&apos;t {kind} “<bdi>{job.name}</bdi>”
    </>,
    {
      id: reelLinkToastId('refused', reel.shortcode),
      description: message,
      duration: ACTION_ERROR_MS,
    },
  );
}

/** The server refused an Undo, or could not be reached: `Couldn't undo`, then the server's own words. */
export function announceReelUndoRefused(reel: ReelLinkToastReel, message: string): void {
  toast.error("Couldn't undo", {
    id: reelLinkToastId('undo-refused', reel.shortcode),
    description: message,
    duration: ACTION_ERROR_MS,
  });
}
