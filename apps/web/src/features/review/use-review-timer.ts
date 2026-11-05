import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { api, sendReviewTimeLast } from '@/data';
import {
  createReviewTimeTracker,
  type ReviewTimeTracker,
  sendResultOfError,
} from './review-time-tracker';
import { HEARTBEAT_MS } from './review-timer';

// Counts the time the owner spends in the Review dialog and sends it to the engine (Phase 4 · M3), so the
// Money page can show "Review and notes N min" and "Per hour of your time". The rules are in
// review-timer.ts, the sending in review-time-tracker.ts; this is the part that touches the page.

/** What counts as being there: these events, anywhere inside the dialog. */
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;

interface UseReviewTimerOptions {
  jobId: string;
  /** The dialog is open. It is counted from the opening to the close, a fade-out not included. */
  open: boolean;
  /** The player is playing: playing counts as being there, however long since the last click. */
  playing: boolean;
  /** A voice note is being recorded: also counts as being there, however long without a click. */
  recording: boolean;
  /** The dialog's element: only events inside it are activity. */
  contentRef: RefObject<HTMLElement | null>;
}

/**
 * Times the open dialog and sends the seconds counted: every 15 s, and the rest when the dialog
 * closes and when the page is hidden or closed (`navigator.sendBeacon`). It counts while the tab is
 * visible and something happened in the dialog in the last 60 s, or the video plays, or a voice note
 * is being recorded.
 *
 * Nothing it does is ever shown: a send that fails keeps its seconds for the next one, and the
 * dialog does not know. Returns `flush`, which sends everything counted so far: call it just before
 * Send notes or Approve, because once the job leaves Review the engine takes no more time for it.
 */
export function useReviewTimer({
  jobId,
  open,
  playing,
  recording,
  contentRef,
}: UseReviewTimerOptions): {
  flush: () => void;
} {
  const tracker = useRef<ReviewTimeTracker | null>(null);
  const playingNow = useRef(playing);
  playingNow.current = playing;
  const recordingNow = useRef(recording);
  recordingNow.current = recording;

  useEffect(() => {
    if (!open) return;
    const timer = createReviewTimeTracker({
      visible: document.visibilityState === 'visible',
      playing: playingNow.current,
      recording: recordingNow.current,
      send: async (sec) => {
        try {
          await api.addReviewTime(jobId, sec);
          return 'sent';
        } catch (error) {
          return sendResultOfError(error);
        }
      },
      sendLast: (sec) => sendReviewTimeLast(jobId, sec),
    });
    tracker.current = timer;

    function onActivity(event: Event): void {
      const dialog = contentRef.current;
      if (dialog !== null && event.target instanceof Node && dialog.contains(event.target)) {
        timer.activity();
      }
    }
    const onVisibility = () => timer.setVisible(document.visibilityState === 'visible');
    const onPageHide = () => timer.pageHide();

    // On the document, in the capture phase: the player and the dialog stop some of these events
    // before they could bubble, and the dialog's own props are the shortcuts' and the player's.
    for (const type of ACTIVITY_EVENTS) {
      document.addEventListener(type, onActivity, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    const heartbeat = window.setInterval(timer.heartbeat, HEARTBEAT_MS);

    return () => {
      window.clearInterval(heartbeat);
      for (const type of ACTIVITY_EVENTS) {
        document.removeEventListener(type, onActivity, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      timer.close();
      if (tracker.current === timer) tracker.current = null;
    };
  }, [jobId, open, contentRef]);

  // The player started or stopped. (After the effect above, so a timer that has just been made is
  // already told; telling it what it knows is a no-op.)
  useEffect(() => {
    tracker.current?.setPlaying(playing);
  }, [playing]);

  useEffect(() => {
    tracker.current?.setRecording(recording);
  }, [recording]);

  const flush = useCallback(() => tracker.current?.flush(), []);
  return { flush };
}
