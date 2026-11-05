import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_MS,
  IDLE_CUTOFF_MS,
  MAX_SEND_SEC,
  type ReviewTimerAction,
  type ReviewTimerState,
  reviewTimer,
  startReviewTimer,
  takeSeconds,
} from './review-timer';

// The clock is a plain number of milliseconds that every action carries.
const T0 = 1_000_000;
const SEC = 1000;

function opened(
  options: { visible?: boolean; playing?: boolean; recording?: boolean } = {},
): ReviewTimerState {
  return startReviewTimer({
    at: T0,
    visible: options.visible ?? true,
    playing: options.playing ?? false,
    recording: options.recording ?? false,
  });
}

/** Runs the actions in order from `state`. */
function run(state: ReviewTimerState, ...actions: ReviewTimerAction[]): ReviewTimerState {
  return actions.reduce(reviewTimer, state);
}

/** The seconds counted so far, as the time that would be sent if everything were taken now. */
function counted(state: ReviewTimerState): number {
  return state.unsentMs / SEC;
}

describe('constants', () => {
  it('cuts off after 60 s idle, sends every 15 s and at most 60 s a time', () => {
    expect(IDLE_CUTOFF_MS).toBe(60_000);
    expect(HEARTBEAT_MS).toBe(15_000);
    expect(MAX_SEND_SEC).toBe(60);
  });
});

describe('opening', () => {
  it('starts with nothing counted, open, and the opening as the first activity', () => {
    expect(opened()).toEqual({
      open: true,
      visible: true,
      playing: false,
      recording: false,
      lastActiveAt: T0,
      countedUpTo: T0,
      unsentMs: 0,
    });
  });
});

describe('counting while the dialog is in use', () => {
  it('counts the time that passes after opening', () => {
    const state = run(opened(), { type: 'tick', at: T0 + 15 * SEC });

    expect(counted(state)).toBe(15);
  });

  it('counts exactly, not in steps: any ticks add up to the same time', () => {
    const once = run(opened(), { type: 'tick', at: T0 + 40 * SEC });
    const many = run(
      opened(),
      { type: 'tick', at: T0 + 7 * SEC },
      { type: 'tick', at: T0 + 7_001 },
      { type: 'tick', at: T0 + 33 * SEC },
      { type: 'tick', at: T0 + 40 * SEC },
    );

    expect(counted(once)).toBe(40);
    expect(counted(many)).toBe(40);
  });

  it('keeps counting as long as there is activity within 60 s of the last', () => {
    const state = run(
      opened(),
      { type: 'activity', at: T0 + 50 * SEC },
      { type: 'activity', at: T0 + 100 * SEC },
      { type: 'activity', at: T0 + 150 * SEC },
      { type: 'tick', at: T0 + 180 * SEC },
    );

    expect(counted(state)).toBe(180);
  });

  it('does not change what was counted when nothing has passed', () => {
    const state = run(opened(), { type: 'tick', at: T0 }, { type: 'activity', at: T0 });

    expect(state.unsentMs).toBe(0);
  });
});

describe('the idle cut-off', () => {
  it('stops counting 60 s after the last activity', () => {
    const state = run(opened(), { type: 'tick', at: T0 + 5 * 60 * SEC });

    expect(counted(state)).toBe(60);
  });

  it('counts right up to the cut-off even when the next event comes much later', () => {
    const state = run(
      opened(),
      { type: 'activity', at: T0 + 20 * SEC },
      { type: 'tick', at: T0 + 10 * 60 * SEC },
    );

    // 20 s until the activity, then 60 s after it.
    expect(counted(state)).toBe(80);
  });

  it('does not count the idle stretch, and starts again at the next activity', () => {
    const state = run(
      opened(),
      { type: 'activity', at: T0 + 200 * SEC },
      { type: 'tick', at: T0 + 230 * SEC },
    );

    // 60 s after opening, nothing for 140 s, then 30 s after the activity.
    expect(counted(state)).toBe(90);
  });

  it('counts 59 s of a 59 s idle stretch, and not the 61st', () => {
    const justUnder = run(opened(), { type: 'tick', at: T0 + 59 * SEC });
    const justOver = run(opened(), { type: 'tick', at: T0 + 61 * SEC });

    expect(counted(justUnder)).toBe(59);
    expect(counted(justOver)).toBe(60);
  });

  it('counts a fresh 60 s each time something is done', () => {
    let state = opened();
    for (let n = 1; n <= 5; n += 1) {
      state = run(state, { type: 'activity', at: T0 + n * 100 * SEC });
    }
    state = run(state, { type: 'tick', at: T0 + 700 * SEC });

    // Opening and each of the five activities start a 60 s window: 6 x 60 s.
    expect(counted(state)).toBe(360);
  });
});

describe('a hidden tab', () => {
  it('counts nothing while the tab is hidden, however recent the activity', () => {
    const state = run(
      opened(),
      { type: 'visibility', visible: false, at: T0 + 10 * SEC },
      { type: 'activity', at: T0 + 20 * SEC },
      { type: 'tick', at: T0 + 50 * SEC },
    );

    expect(counted(state)).toBe(10);
  });

  it('counts the time up to the moment the tab was hidden', () => {
    const state = run(opened(), { type: 'visibility', visible: false, at: T0 + 25 * SEC });

    expect(counted(state)).toBe(25);
  });

  it('starts again when the tab is visible and the last activity is under 60 s old', () => {
    const state = run(
      opened(),
      { type: 'visibility', visible: false, at: T0 + 10 * SEC },
      { type: 'visibility', visible: true, at: T0 + 30 * SEC },
      { type: 'tick', at: T0 + 100 * SEC },
    );

    // 10 s before hiding; after coming back, until 60 s after opening (the last activity): 30 s.
    expect(counted(state)).toBe(40);
  });

  it('needs new activity after a long time away: returning to the tab is not activity', () => {
    const state = run(
      opened(),
      { type: 'visibility', visible: false, at: T0 + 10 * SEC },
      { type: 'visibility', visible: true, at: T0 + 10 * 60 * SEC },
      { type: 'tick', at: T0 + 11 * 60 * SEC },
    );

    expect(counted(state)).toBe(10);
  });

  it('counts a tab that is hidden from the start only once it is shown', () => {
    const state = run(
      opened({ visible: false }),
      { type: 'tick', at: T0 + 30 * SEC },
      { type: 'visibility', visible: true, at: T0 + 30 * SEC },
      { type: 'activity', at: T0 + 30 * SEC },
      { type: 'tick', at: T0 + 40 * SEC },
    );

    expect(counted(state)).toBe(10);
  });

  it('does not count a video that keeps playing in a hidden tab', () => {
    const state = run(
      opened({ playing: true }),
      { type: 'visibility', visible: false, at: T0 + 5 * SEC },
      { type: 'tick', at: T0 + 600 * SEC },
    );

    expect(counted(state)).toBe(5);
  });
});

describe('playback', () => {
  it('counts a video that plays for longer than the idle cut-off, with no other activity', () => {
    const state = run(
      opened(),
      { type: 'playing', playing: true, at: T0 + 2 * SEC },
      { type: 'tick', at: T0 + 300 * SEC },
    );

    expect(counted(state)).toBe(300);
  });

  it('gives a fresh 60 s after the video stops', () => {
    const state = run(
      opened(),
      { type: 'playing', playing: true, at: T0 + 2 * SEC },
      { type: 'playing', playing: false, at: T0 + 200 * SEC },
      { type: 'tick', at: T0 + 400 * SEC },
    );

    // 200 s up to the pause, then 60 s of idle window.
    expect(counted(state)).toBe(260);
  });

  it('counts the 60 s before the video starts only up to the cut-off', () => {
    const state = run(
      opened(),
      { type: 'playing', playing: true, at: T0 + 100 * SEC },
      { type: 'tick', at: T0 + 110 * SEC },
    );

    // 60 s after opening, a gap, then the 10 s of playback.
    expect(counted(state)).toBe(70);
  });

  it('counts a video that is playing as the dialog opens', () => {
    const state = run(opened({ playing: true }), { type: 'tick', at: T0 + 120 * SEC });

    expect(counted(state)).toBe(120);
  });

  it('ignores being told the video is playing when it already is', () => {
    const playing = run(opened(), { type: 'playing', playing: true, at: T0 + 10 * SEC });
    const again = run(playing, { type: 'playing', playing: true, at: T0 + 500 * SEC });

    // The second message is not activity: still playing the whole time, so nothing is lost either.
    expect(again.lastActiveAt).toBe(T0 + 10 * SEC);
    expect(counted(again)).toBe(500);
  });
});

describe('recording a voice note', () => {
  it('keeps counting past the idle cut-off, with no other activity, for as long as it records', () => {
    const state = run(
      opened(),
      { type: 'recording', recording: true, at: T0 + 5 * SEC },
      { type: 'tick', at: T0 + 300 * SEC },
    );

    // 5 s before the recording, then every second of the 295 s of it, far past 60 s idle.
    expect(counted(state)).toBe(300);
  });

  it('counts a recording that is on as the dialog opens', () => {
    const state = run(opened({ recording: true }), { type: 'tick', at: T0 + 120 * SEC });

    expect(counted(state)).toBe(120);
  });

  it('counts the stretch before the recording only up to the idle cut-off', () => {
    const state = run(
      opened(),
      { type: 'recording', recording: true, at: T0 + 100 * SEC },
      { type: 'tick', at: T0 + 110 * SEC },
    );

    // 60 s after opening, a gap, then the 10 s of recording.
    expect(counted(state)).toBe(70);
  });

  it('counts stopping a recording as activity: a fresh 60 s starts at the stop', () => {
    const state = run(
      opened(),
      { type: 'recording', recording: true, at: T0 + 2 * SEC },
      { type: 'recording', recording: false, at: T0 + 200 * SEC },
      { type: 'tick', at: T0 + 400 * SEC },
    );

    expect(state.lastActiveAt).toBe(T0 + 200 * SEC);
    // 200 s up to the stop, then the 60 s window after it.
    expect(counted(state)).toBe(260);
  });

  it('counts starting a recording as activity too', () => {
    const state = run(opened(), { type: 'recording', recording: true, at: T0 + 100 * SEC });

    expect(state.lastActiveAt).toBe(T0 + 100 * SEC);
  });

  it('ignores being told it is recording when it already is', () => {
    const recording = run(opened(), { type: 'recording', recording: true, at: T0 + 10 * SEC });
    const again = run(recording, { type: 'recording', recording: true, at: T0 + 500 * SEC });

    expect(again.lastActiveAt).toBe(T0 + 10 * SEC);
    expect(counted(again)).toBe(500);
  });

  it('does not count a recording in a hidden tab', () => {
    const state = run(
      opened({ recording: true }),
      { type: 'visibility', visible: false, at: T0 + 5 * SEC },
      { type: 'tick', at: T0 + 600 * SEC },
    );

    expect(counted(state)).toBe(5);
  });

  it('keeps counting while the video plays after the recording has stopped', () => {
    const state = run(
      opened(),
      { type: 'recording', recording: true, at: T0 + 10 * SEC },
      { type: 'playing', playing: true, at: T0 + 20 * SEC },
      { type: 'recording', recording: false, at: T0 + 100 * SEC },
      // The video is still playing: still counted, though the recording stopped.
      { type: 'tick', at: T0 + 400 * SEC },
    );

    expect(counted(state)).toBe(400);
  });

  it('counts when the video and the recording both stop together: 60 s from the last of them', () => {
    const state = run(
      opened({ playing: true, recording: true }),
      { type: 'playing', playing: false, at: T0 + 100 * SEC },
      { type: 'recording', recording: false, at: T0 + 120 * SEC },
      { type: 'tick', at: T0 + 500 * SEC },
    );

    // 120 s of recording (the video stopping at 100 s changes nothing), then 60 s after the stop.
    expect(counted(state)).toBe(180);
  });
});

describe('closing', () => {
  it('counts the time up to the close and nothing after it', () => {
    const state = run(
      opened(),
      { type: 'close', at: T0 + 20 * SEC },
      { type: 'activity', at: T0 + 30 * SEC },
      { type: 'tick', at: T0 + 100 * SEC },
    );

    expect(state.open).toBe(false);
    expect(counted(state)).toBe(20);
  });

  it('counts nothing for a dialog that is closed at once', () => {
    expect(counted(run(opened(), { type: 'close', at: T0 }))).toBe(0);
  });
});

describe('a clock that goes backwards', () => {
  it('counts nothing for the jump and follows the clock from there', () => {
    const state = run(
      opened(),
      { type: 'tick', at: T0 + 30 * SEC },
      { type: 'tick', at: T0 - 3_600 * SEC },
      { type: 'activity', at: T0 - 3_600 * SEC },
      { type: 'tick', at: T0 - 3_600 * SEC + 10 * SEC },
    );

    expect(counted(state)).toBe(40);
  });
});

describe('taking seconds to send', () => {
  const withMs = (unsentMs: number): ReviewTimerState => ({ ...opened(), unsentMs });

  it('takes the whole seconds of a heartbeat and leaves the fraction', () => {
    const { state, sec } = takeSeconds(withMs(15_400), { last: false });

    expect(sec).toBe(15);
    expect(state.unsentMs).toBe(400);
  });

  it('takes nothing under a second on a heartbeat', () => {
    const start = withMs(999);

    expect(takeSeconds(start, { last: false })).toEqual({ state: start, sec: 0 });
  });

  it('carries the fractions over, so no second is lost across heartbeats', () => {
    let state = opened();
    let sent = 0;
    for (let n = 1; n <= 8; n += 1) {
      state = run(state, { type: 'tick', at: T0 + n * 7_300 });
      const taken = takeSeconds(state, { last: false });
      state = taken.state;
      sent += taken.sec;
    }

    // 8 x 7.3 s = 58.4 s, of which 58 whole seconds were sent and 0.4 s is waiting.
    expect(sent).toBe(58);
    expect(state.unsentMs).toBeCloseTo(400, 6);
  });

  it('rounds the remainder at the end: up from half a second, down below it', () => {
    expect(takeSeconds(withMs(14_500), { last: true }).sec).toBe(15);
    expect(takeSeconds(withMs(14_499), { last: true }).sec).toBe(14);
  });

  it('empties the timer at the end, dropping a fraction under half a second', () => {
    expect(takeSeconds(withMs(400), { last: true })).toEqual({
      state: { ...opened(), unsentMs: 0 },
      sec: 0,
    });
    expect(takeSeconds(withMs(14_600), { last: true }).state.unsentMs).toBe(0);
  });

  it('takes at most 60 s at a time and the rest on the next call', () => {
    const first = takeSeconds(withMs(150 * SEC), { last: false });
    const second = takeSeconds(first.state, { last: false });
    const third = takeSeconds(second.state, { last: false });
    const fourth = takeSeconds(third.state, { last: false });

    expect([first.sec, second.sec, third.sec, fourth.sec]).toEqual([60, 60, 30, 0]);
  });

  it('sends 0 for a dialog that counted nothing', () => {
    expect(takeSeconds(opened(), { last: true }).sec).toBe(0);
  });
});

describe('a send that failed', () => {
  it('keeps its seconds for the next send', () => {
    let state = run(opened(), { type: 'tick', at: T0 + 15 * SEC });
    const first = takeSeconds(state, { last: false });
    state = first.state;
    expect(first.sec).toBe(15);

    state = run(
      state,
      { type: 'send-failed', sec: first.sec },
      { type: 'tick', at: T0 + 30 * SEC },
    );
    const second = takeSeconds(state, { last: false });

    expect(second.sec).toBe(30);
  });

  it('is owed even by a closed timer, which the tracker then sends one last time', () => {
    const closed = run(opened(), { type: 'close', at: T0 + 10 * SEC });

    expect(reviewTimer(closed, { type: 'send-failed', sec: 15 }).unsentMs).toBe(
      10 * SEC + 15 * SEC,
    );
  });
});
