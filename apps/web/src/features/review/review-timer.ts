import { REVIEW_TIME_MAX_SEC } from '@studio/shared';

// How long the owner spends in the Review dialog (Phase 4 §2, "Review time"), counted honestly: only
// while the dialog is open, the tab is visible and they are actually there. Pure state and a reducer
// driven by a clock (every action carries the time it happened at); the tracker
// (review-time-tracker.ts) feeds it and sends what it counts, the hook (use-review-timer.ts) wires
// it to the page.
//
//   counting  =  open  AND  visible  AND  (playing  OR  recording  OR  something was done in the last 60 s)
//
// "Something was done" is a pointer, key or wheel event inside the dialog; starting or stopping the
// video, or a voice note, counts too. Opening the dialog is the first such thing. Talking into a
// voice note is being there, however long it takes without a click, just like watching the video. The count is exact, not sampled:
// every action first adds the time since the last one, using the flags as they were until now, and
// the 60 s cut-off is worked out from the last activity, so no tick has to land on the cut-off.

/** After this long with nothing done in the dialog (and no video playing, no voice note recording) the clock stops. */
export const IDLE_CUTOFF_MS = 60_000;

/** How often the counted seconds are sent while the dialog is open. */
export const HEARTBEAT_MS = 15_000;

/** The most seconds one send carries (the server refuses more); the same limit as the API. */
export const MAX_SEND_SEC = REVIEW_TIME_MAX_SEC;

export interface ReviewTimerState {
  /** The dialog is open. Closing is for good: a new opening starts a new timer. */
  open: boolean;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** The player is playing. */
  playing: boolean;
  /** A voice note is being recorded (W11's recorder is starting or recording). */
  recording: boolean;
  /** When something was last done in the dialog, or the video or a recording last started or stopped (ms). */
  lastActiveAt: number;
  /** The time up to which counting has been done (ms). */
  countedUpTo: number;
  /** Milliseconds counted and not sent yet; a fraction of a second carries over to the next send. */
  unsentMs: number;
}

export type ReviewTimerAction =
  /** Nothing happened; add the time that has passed. */
  | { type: 'tick'; at: number }
  /** Pointer, key or wheel inside the dialog. */
  | { type: 'activity'; at: number }
  /** The player started or stopped playing. */
  | { type: 'playing'; playing: boolean; at: number }
  /** A voice note started or stopped being recorded. */
  | { type: 'recording'; recording: boolean; at: number }
  /** The tab became visible or hidden. */
  | { type: 'visibility'; visible: boolean; at: number }
  /** The dialog closed. */
  | { type: 'close'; at: number }
  /** A send of `sec` seconds did not get through: they are owed again. */
  | { type: 'send-failed'; sec: number };

/** The timer of a dialog that has just opened at `at`: the opening is the first activity. */
export function startReviewTimer({
  at,
  visible,
  playing,
  recording = false,
}: {
  at: number;
  visible: boolean;
  playing: boolean;
  recording?: boolean;
}): ReviewTimerState {
  return {
    open: true,
    visible,
    playing,
    recording,
    lastActiveAt: at,
    countedUpTo: at,
    unsentMs: 0,
  };
}

/**
 * Adds the time from `countedUpTo` to `at` that counts: none unless the dialog is open and the tab
 * visible; all of it while the video plays or a voice note is being recorded; otherwise up to 60 s
 * after the last activity. A clock
 * that went backwards counts nothing and is followed.
 */
function catchUp(state: ReviewTimerState, at: number): ReviewTimerState {
  if (at < state.countedUpTo) {
    return { ...state, countedUpTo: at, lastActiveAt: Math.min(state.lastActiveAt, at) };
  }
  if (at === state.countedUpTo) return state;
  let counted = 0;
  if (state.open && state.visible) {
    const present = state.playing || state.recording;
    const until = present ? at : Math.min(at, state.lastActiveAt + IDLE_CUTOFF_MS);
    counted = Math.max(0, until - state.countedUpTo);
  }
  return { ...state, countedUpTo: at, unsentMs: state.unsentMs + counted };
}

/** The reducer: the state after `action`. A closed timer counts nothing and ignores everything but a failed send. */
export function reviewTimer(state: ReviewTimerState, action: ReviewTimerAction): ReviewTimerState {
  if (action.type === 'send-failed') {
    return { ...state, unsentMs: state.unsentMs + action.sec * 1000 };
  }
  const now = catchUp(state, action.at);
  switch (action.type) {
    case 'tick':
      return now;
    case 'activity':
      return { ...now, lastActiveAt: action.at };
    case 'playing':
      // Starting and stopping the video are both something done: after Pause the 60 s begin.
      return now.playing === action.playing
        ? now
        : { ...now, playing: action.playing, lastActiveAt: action.at };
    case 'recording':
      // Like the video: starting and stopping a recording are both something done.
      return now.recording === action.recording
        ? now
        : { ...now, recording: action.recording, lastActiveAt: action.at };
    case 'visibility':
      return { ...now, visible: action.visible };
    case 'close':
      return { ...now, open: false };
  }
}

/** The seconds to send now and the state without them. */
export interface TakenSeconds {
  state: ReviewTimerState;
  /** A whole number from 1 to {@link MAX_SEND_SEC}, or 0 when there is nothing to send. */
  sec: number;
}

/**
 * Takes whole seconds out of what is unsent, at most {@link MAX_SEND_SEC}; call it again for more.
 * A heartbeat leaves the fraction of a second to the next send. `last` is for the final send (the
 * dialog closing, the page going away, Send or Approve): the remainder is rounded to the nearest
 * second, and when nothing is left to send a fraction under half a second is dropped.
 */
export function takeSeconds(state: ReviewTimerState, { last }: { last: boolean }): TakenSeconds {
  const whole = last ? Math.round(state.unsentMs / 1000) : Math.floor(state.unsentMs / 1000);
  if (whole < 1) return { state: last ? { ...state, unsentMs: 0 } : state, sec: 0 };
  const sec = Math.min(whole, MAX_SEND_SEC);
  return { state: { ...state, unsentMs: Math.max(0, state.unsentMs - sec * 1000) }, sec };
}
