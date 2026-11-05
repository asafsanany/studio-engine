import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { reviewFrameUrl } from '@/data/luts-api';
import type { LibraryFrame } from '@/features/library-picker/library-frame';
import { useLibraryItems } from '@/features/library-picker/use-library-items';
import { PausedLook } from './PausedLook';
import { PAUSED_LOOK_SETTLE_MS, pausedLookShows, pausedLookTarget, tenthsOf } from './paused-look';
import { formatPlayhead } from './player-state';

interface UsePausedLookOptions {
  jobId: string;
  /** The job's round and the music's rev: the preview changes with them, so a frame of the last is stale. */
  round: number;
  musicRev: number | null | undefined;
  /** The note box's text. */
  text: string;
  /** The playhead, in seconds, and the video's length. */
  currentSec: number;
  durationSec: number;
  playing: boolean;
  /** The player is up. */
  ready: boolean;
  /** A voice note has the place of the note box. */
  busy: boolean;
  /** The note box has had the focus: someone is writing, so the picker may ask for the frame. */
  writing: boolean;
}

export interface PausedLookResult {
  /** The still over the video, with its pill and Compare; `null` when nothing is to show. Give it to the player. */
  overlay: ReactNode;
  /** The frame the @ picker shows its LUTs on: the paused frame, once the server has made it; else `undefined` (the test frame). */
  frame: LibraryFrame | undefined;
}

/** How often a frame that was not there yet is asked for again, and how long to wait between asks. */
const PROBE_RETRIES = 2;
const PROBE_RETRY_MS = 4000;

/**
 * Whether the server answers a frame at `src`: loaded once as an image, so the picker's pictures
 * (which hide themselves when they cannot load) are not shown from a frame that is not there.
 * A frame that is not there yet (the preview video is still being made) is asked for again a few
 * times. Not asked while `src` is `null`.
 */
function useFrameAnswers(src: string | null): boolean {
  const [state, setState] = useState<{ src: string; ok: boolean } | null>(null);
  // Which ask this is, for the address it was counted for.
  const [asks, setAsks] = useState<{ src: string | null; n: number }>({ src: null, n: 0 });
  const attempt = asks.src === src ? asks.n : 0;

  useEffect(() => {
    if (src === null) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const image = new Image();
    image.onload = () => {
      if (!gone) setState({ src, ok: true });
    };
    image.onerror = () => {
      if (gone) return;
      setState({ src, ok: false });
      if (attempt < PROBE_RETRIES) {
        timer = setTimeout(() => setAsks({ src, n: attempt + 1 }), PROBE_RETRY_MS);
      }
    };
    image.src = src;
    return () => {
      gone = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
    };
  }, [src, attempt]);

  return src !== null && state?.src === src && state.ok;
}

/**
 * The look on the paused frame in Review (board LUReview, states chip and sent). While the note box
 * names a LUT and the video is paused, `overlay` is that frame with the look on it (the server takes
 * it from the round's preview video: routes/review-frame.ts), with the pill and Compare; playing,
 * seeking, dragging the timeline or taking the token out hides it. `frame` is what the @ picker
 * (and a chip's card) shows its LUTs on, so they preview on the video's own frame; until the first
 * frame has come, or if it cannot, it is `undefined` and the picker keeps the LUTs page's test
 * frame. With `lutsInEdits` off everything here is inert and asks the server nothing.
 */
export function usePausedLook({
  jobId,
  round,
  musicRev,
  text,
  currentSec,
  durationSec,
  playing,
  ready,
  busy,
  writing,
}: UsePausedLookOptions): PausedLookResult {
  const { enabled, items } = useLibraryItems();
  const target = useMemo(
    () => (enabled ? pausedLookTarget(text, items) : null),
    [enabled, text, items],
  );
  const tenths = tenthsOf(currentSec);

  // The playhead has stood still for a moment: only then is a frame asked for.
  const [settledTenths, setSettledTenths] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || playing) {
      setSettledTenths(null);
      return;
    }
    const timer = setTimeout(() => setSettledTenths(tenths), PAUSED_LOOK_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [enabled, playing, tenths]);

  const standing = settledTenths === tenths;
  const options = useMemo(() => ({ round, musicRev }), [round, musicRev]);
  const at = tenths / 10;
  const plainSrc = enabled ? reviewFrameUrl(jobId, at, null, options) : '';

  const shows = pausedLookShows({
    enabled,
    ready,
    playing,
    busy,
    target,
    tenths,
    settledTenths,
  });
  const overlay: ReactNode =
    shows && target !== null ? (
      <PausedLook
        target={target}
        plainSrc={plainSrc}
        lutSrc={reviewFrameUrl(jobId, at, target.slug, options)}
        timeLabel={formatPlayhead(at, durationSec)}
      />
    ) : null;

  // The picker's frame: only while someone writes with the video standing still.
  const probe = enabled && writing && ready && !playing && !busy && standing ? plainSrc : null;
  const answers = useFrameAnswers(probe);
  const frame = useMemo<LibraryFrame | undefined>(
    () =>
      answers && probe !== null
        ? {
            beforeSrc: probe,
            afterSrc: (slug) => reviewFrameUrl(jobId, at, slug, options),
          }
        : undefined,
    [answers, probe, jobId, at, options],
  );

  return { overlay, frame };
}
