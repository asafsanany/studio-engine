import {
  type ReviewTimerAction,
  type ReviewTimerState,
  reviewTimer,
  startReviewTimer,
  takeSeconds,
} from './review-timer';

// The review timer (review-timer.ts) with a clock and a way to send, and no React, no DOM: the
// hook (use-review-timer.ts) gives it the page's events and a real `send`, the tests give it fakes.
//
//   heartbeat   every 15 s: the whole seconds counted since the last send, by `send`
//   flush       the same, but everything (the last fraction rounded), when Send notes or Approve
//               is about to take the job out of Review, where the server stops counting
//   pageHide    everything, by `sendLast`; the page may be gone a moment later, so this is the
//               one that has to survive it (navigator.sendBeacon)
//   close       the dialog closed: everything, by `sendLast`, and the timer stops
//
// A failed `send` keeps its seconds for the next one. Nothing here ever throws or shows anything:
// the review time is bookkeeping, and the dialog must not notice it.

/** What became of a send: `sent` (counted, or refused for good) or `retry` (try these seconds again). */
export type SendResult = 'sent' | 'retry';

/**
 * Whether the seconds of a failed request are worth sending again. `error` is what the data layer
 * rejects with: an `ApiError`, whose `status` is 0 when the server could not be reached. A network
 * error, a timeout and a 5xx may pass next time. A 4xx (the job is not in review any more, or is
 * gone) is the server saying it will never take them: keeping them would only repeat the request
 * every 15 s.
 */
export function sendResultOfError(error: unknown): SendResult {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return status === 408 || status === 429 ? 'retry' : 'sent';
  }
  return 'retry';
}

/** Activity events closer together than this are one: pointer moves fire many times a second. */
export const ACTIVITY_THROTTLE_MS = 250;

export interface ReviewTimeTrackerOptions {
  /** The clock, in ms. Default `Date.now`; tests pass a fake. */
  now?: () => number;
  /** Whether the tab is visible as the dialog opens. */
  visible: boolean;
  /** Whether the player is playing as the dialog opens. */
  playing: boolean;
  /** Whether a voice note is being recorded as the dialog opens. Default false. */
  recording?: boolean;
  /** Sends `sec` seconds and tells how it went. It may reject: that is a `retry`. */
  send: (sec: number) => Promise<SendResult>;
  /** Hands `sec` seconds over for good, in a way that survives the page going away. Fire and forget. */
  sendLast: (sec: number) => void;
}

export interface ReviewTimeTracker {
  /** A pointer, key or wheel event inside the dialog. */
  activity(): void;
  /** The player started (`true`) or stopped playing. */
  setPlaying(playing: boolean): void;
  /** A voice note started (`true`) or stopped being recorded. */
  setRecording(recording: boolean): void;
  /** The tab became visible (`true`) or hidden. */
  setVisible(visible: boolean): void;
  /** The 15 s timer: sends the whole seconds counted since the last send. */
  heartbeat(): void;
  /** Sends everything counted now, rounded, and goes on counting. */
  flush(): void;
  /** The page is being hidden or closed: hands everything over by `sendLast`, and goes on counting. */
  pageHide(): void;
  /** The dialog closed: hands everything over by `sendLast` and stops. Calling it again does nothing. */
  close(): void;
  /** The timer's state, for tests. */
  getState(): ReviewTimerState;
}

export function createReviewTimeTracker({
  now = Date.now,
  visible,
  playing,
  recording = false,
  send,
  sendLast,
}: ReviewTimeTrackerOptions): ReviewTimeTracker {
  let state = startReviewTimer({ at: now(), visible, playing, recording });
  let lastActivityAt = state.lastActiveAt;

  function apply(action: ReviewTimerAction): void {
    state = reviewTimer(state, action);
  }

  /** Takes every whole second that is unsent (a minute at a time) and gives each batch to `give`. */
  function drain(last: boolean, give: (sec: number) => void): void {
    apply({ type: 'tick', at: now() });
    // All taken before any is given: a send that fails at once owes its seconds again, and they
    // must wait for the next drain, not be taken straight back out of this one.
    const batches: number[] = [];
    for (;;) {
      const taken = takeSeconds(state, { last });
      state = taken.state;
      if (taken.sec === 0) break;
      batches.push(taken.sec);
    }
    for (const sec of batches) give(sec);
  }

  /** The seconds did not get through: owed again, or, when the dialog is closed, one last try. */
  function owed(sec: number): void {
    if (state.open) {
      apply({ type: 'send-failed', sec });
      return;
    }
    try {
      sendLast(sec);
    } catch {
      // Closed, and the last try failed too: the seconds are lost, and nobody is told.
    }
  }

  function post(sec: number): void {
    let result: Promise<SendResult>;
    try {
      result = send(sec);
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (outcome) => {
        if (outcome === 'retry') owed(sec);
      },
      () => owed(sec),
    );
  }

  function postLast(sec: number): void {
    try {
      sendLast(sec);
    } catch {
      // Nothing to do with it: the page is going away.
    }
  }

  return {
    activity() {
      const at = now();
      if (at >= lastActivityAt && at - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
      lastActivityAt = at;
      apply({ type: 'activity', at });
    },
    setPlaying(next) {
      apply({ type: 'playing', playing: next, at: now() });
      lastActivityAt = state.lastActiveAt;
    },
    setRecording(next) {
      apply({ type: 'recording', recording: next, at: now() });
      lastActivityAt = state.lastActiveAt;
    },
    setVisible(next) {
      apply({ type: 'visibility', visible: next, at: now() });
    },
    heartbeat() {
      if (!state.open) return;
      drain(false, post);
    },
    flush() {
      if (!state.open) return;
      drain(true, post);
    },
    pageHide() {
      if (!state.open) return;
      drain(true, postLast);
    },
    close() {
      if (!state.open) return;
      // Closed first, so that the time up to now is counted and nothing after it is.
      apply({ type: 'close', at: now() });
      drain(true, postLast);
    },
    getState: () => state,
  };
}
