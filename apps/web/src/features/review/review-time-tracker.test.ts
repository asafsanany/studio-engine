import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_THROTTLE_MS,
  createReviewTimeTracker,
  type ReviewTimeTrackerOptions,
  type SendResult,
  sendResultOfError,
} from './review-time-tracker';
import { HEARTBEAT_MS } from './review-timer';

const T0 = 5_000_000;
const SEC = 1000;

/** A tracker on a clock the test moves, and the sends it made, in order. */
function setup(options: Partial<ReviewTimeTrackerOptions> = {}) {
  let clock = T0;
  const sent: number[] = [];
  const last: number[] = [];
  const send = vi.fn(async (sec: number): Promise<SendResult> => {
    sent.push(sec);
    return 'sent';
  });
  const sendLast = vi.fn((sec: number) => {
    last.push(sec);
  });
  const tracker = createReviewTimeTracker({
    now: () => clock,
    visible: true,
    playing: false,
    send,
    sendLast,
    ...options,
  });
  return {
    tracker,
    sent,
    last,
    send,
    sendLast,
    /** Moves the clock forward. */
    advance(ms: number) {
      clock += ms;
    },
    /** Moves the clock to `ms` after the opening. */
    at(ms: number) {
      clock = T0 + ms;
    },
  };
}

/** Lets the promises of the sends settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the heartbeat', () => {
  it('sends the seconds counted since the last send', () => {
    const t = setup();
    t.at(HEARTBEAT_MS);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([15]);
    expect(t.last).toEqual([]);
  });

  it('sends only what is new each time', () => {
    const t = setup();
    t.at(15 * SEC);
    t.tracker.heartbeat();
    t.at(30 * SEC);
    t.tracker.heartbeat();
    t.at(45 * SEC);
    t.tracker.heartbeat();

    expect(t.sent).toEqual([15, 15, 15]);
  });

  it('sends nothing when nothing was counted: an idle dialog sends no empty requests', () => {
    const t = setup();
    t.at(60 * SEC);
    t.tracker.heartbeat();
    t.at(75 * SEC);
    t.tracker.heartbeat();
    t.at(90 * SEC);
    t.tracker.heartbeat();

    // Only the first minute after opening counted.
    expect(t.sent).toEqual([60]);
  });

  it('keeps a fraction of a second for the next send', () => {
    const t = setup();
    t.at(15_700);
    t.tracker.heartbeat();
    t.at(31_400);
    t.tracker.heartbeat();

    expect(t.sent).toEqual([15, 16]);
  });

  it('splits more than a minute into sends of at most 60 s', () => {
    const t = setup({ playing: true });
    t.at(150 * SEC);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([60, 60, 30]);
  });

  it('sends nothing for a hidden tab', () => {
    const t = setup();
    t.tracker.setVisible(false);
    t.at(15 * SEC);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([]);
  });

  it('counts a video that plays, with nothing else going on, for as long as it plays', () => {
    const t = setup();
    t.tracker.setPlaying(true);
    t.at(5 * 60 * SEC);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([60, 60, 60, 60, 60]);
  });
});

describe('recording a voice note', () => {
  it('counts for as long as it records, past the idle cut-off', () => {
    const t = setup();
    t.tracker.setRecording(true);
    t.at(150 * SEC);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([60, 60, 30]);
  });

  it('counts a recording that is on as the dialog opens', () => {
    const t = setup({ recording: true });
    t.at(90 * SEC);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([60, 30]);
  });

  it('stopping it is activity: the 60 s window starts again', () => {
    const t = setup();
    t.tracker.setRecording(true);
    t.at(200 * SEC);
    t.tracker.setRecording(false);
    t.at(400 * SEC);

    t.tracker.close();

    expect(t.tracker.getState().lastActiveAt).toBe(T0 + 200 * SEC);
    expect(t.last).toEqual([60, 60, 60, 60, 20]);
  });
});

describe('activity', () => {
  it('keeps the dialog counting past the idle cut-off', () => {
    const t = setup();
    t.at(50 * SEC);
    t.tracker.activity();
    t.at(100 * SEC);
    t.tracker.activity();
    t.at(150 * SEC);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([60, 60, 30]);
  });

  it('is counted from the moment it happens, without a send', () => {
    const t = setup();
    t.at(200 * SEC);
    t.tracker.activity();

    expect(t.tracker.getState().lastActiveAt).toBe(T0 + 200 * SEC);
    expect(t.sent).toEqual([]);
  });

  it('treats events within a quarter of a second as one', () => {
    const t = setup();
    t.at(100 * SEC);
    t.tracker.activity();
    const first = t.tracker.getState();
    t.advance(ACTIVITY_THROTTLE_MS - 1);

    t.tracker.activity();

    expect(t.tracker.getState()).toBe(first);

    t.advance(1);
    t.tracker.activity();

    expect(t.tracker.getState().lastActiveAt).toBe(T0 + 100 * SEC + ACTIVITY_THROTTLE_MS);
  });
});

describe('a send that fails', () => {
  it('keeps its seconds for the next one', async () => {
    const outcomes: SendResult[] = ['retry', 'sent'];
    const t = setup();
    t.send.mockImplementation(async (sec) => {
      t.sent.push(sec);
      return outcomes.shift() ?? 'sent';
    });
    t.at(15 * SEC);
    t.tracker.heartbeat();
    await settle();
    t.at(30 * SEC);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([15, 30]);
  });

  it('keeps them when the send rejects too', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error('offline'));
    t.at(15 * SEC);
    t.tracker.heartbeat();
    await settle();
    t.at(30 * SEC);

    t.tracker.heartbeat();

    expect(t.send).toHaveBeenLastCalledWith(30);
  });

  it('keeps them when the send throws at once', async () => {
    const t = setup();
    t.send.mockImplementationOnce(() => {
      throw new Error('no fetch');
    });
    t.at(15 * SEC);
    t.tracker.heartbeat();
    await settle();
    t.at(30 * SEC);

    t.tracker.heartbeat();

    expect(t.send).toHaveBeenLastCalledWith(30);
  });

  it('does not repeat seconds the server took, or refused for good', async () => {
    const t = setup();
    t.at(15 * SEC);
    t.tracker.heartbeat();
    await settle();
    t.at(30 * SEC);
    t.tracker.heartbeat();
    await settle();

    expect(t.sent).toEqual([15, 15]);
  });

  it('hands the seconds over by the last send if the dialog closed before the failure came back', async () => {
    const t = setup();
    const pending: { fail?: () => void } = {};
    t.send.mockImplementationOnce(
      (sec) =>
        new Promise<SendResult>((resolve) => {
          t.sent.push(sec);
          pending.fail = () => resolve('retry');
        }),
    );
    t.at(15 * SEC);
    t.tracker.heartbeat();
    t.at(20 * SEC);
    t.tracker.close();
    expect(t.last).toEqual([5]);

    pending.fail?.();
    await settle();

    expect(t.last).toEqual([5, 15]);
  });

  it('does not loop on a send that throws at once: it is tried once, and its seconds wait', async () => {
    const t = setup();
    t.send.mockImplementation(() => {
      throw new Error('no fetch');
    });
    t.at(15 * SEC);

    t.tracker.flush();
    await settle();

    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.tracker.getState().unsentMs).toBe(15 * SEC);
  });

  it('never throws, whatever the sends do', async () => {
    const t = setup({
      send: () => {
        throw new Error('boom');
      },
      sendLast: () => {
        throw new Error('boom');
      },
    });
    t.at(15 * SEC);

    expect(() => t.tracker.heartbeat()).not.toThrow();
    expect(() => t.tracker.flush()).not.toThrow();
    expect(() => t.tracker.pageHide()).not.toThrow();
    expect(() => t.tracker.close()).not.toThrow();
    await settle();
  });
});

describe('flush', () => {
  it('sends everything counted so far, the last fraction rounded', () => {
    const t = setup();
    t.at(22_600);

    t.tracker.flush();

    expect(t.sent).toEqual([23]);
    expect(t.last).toEqual([]);
  });

  it('goes on counting afterwards', () => {
    const t = setup();
    t.at(10 * SEC);
    t.tracker.flush();
    t.at(15 * SEC);

    t.tracker.heartbeat();

    expect(t.sent).toEqual([10, 5]);
  });

  it('sends nothing when there is nothing', () => {
    const t = setup();

    t.tracker.flush();

    expect(t.sent).toEqual([]);
  });
});

describe('closing', () => {
  it('hands the remainder over by the last send', () => {
    const t = setup();
    t.at(15 * SEC);
    t.tracker.heartbeat();
    t.at(21_300);

    t.tracker.close();

    expect(t.sent).toEqual([15]);
    expect(t.last).toEqual([6]);
  });

  it('counts up to the close and no further', () => {
    const t = setup();
    t.at(10 * SEC);
    t.tracker.close();
    t.at(40 * SEC);
    t.tracker.activity();
    t.tracker.heartbeat();
    t.tracker.close();

    expect(t.last).toEqual([10]);
    expect(t.sent).toEqual([]);
    expect(t.tracker.getState().open).toBe(false);
  });

  it('sends nothing for a dialog closed at once', () => {
    const t = setup();

    t.tracker.close();

    expect(t.last).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('splits a long remainder into sends of at most 60 s', () => {
    const t = setup({ playing: true });
    t.at(130 * SEC);

    t.tracker.close();

    expect(t.last).toEqual([60, 60, 10]);
  });

  it('drops a fraction under half a second', () => {
    const t = setup();
    t.at(10_400);

    t.tracker.close();

    expect(t.last).toEqual([10]);
  });
});

describe('the page being hidden or closed', () => {
  it('hands everything over by the last send, and goes on counting', () => {
    const t = setup();
    t.at(20 * SEC);

    t.tracker.pageHide();
    t.at(30 * SEC);
    t.tracker.heartbeat();

    expect(t.last).toEqual([20]);
    expect(t.sent).toEqual([10]);
    expect(t.tracker.getState().open).toBe(true);
  });

  it('does not count the seconds again at the close that follows', () => {
    const t = setup();
    t.at(20 * SEC);

    t.tracker.pageHide();
    t.tracker.close();

    expect(t.last).toEqual([20]);
  });
});

describe('a session, start to finish', () => {
  it('sends every counted second once: heartbeats, a pause to think, a note, a close', () => {
    const t = setup();
    const total = () => [...t.sent, ...t.last].reduce((sum, sec) => sum + sec, 0);

    // 40 s of watching: the video plays for 25 s, then a pause.
    t.tracker.setPlaying(true);
    t.at(15 * SEC);
    t.tracker.heartbeat();
    t.at(25 * SEC);
    t.tracker.setPlaying(false);
    t.at(30 * SEC);
    t.tracker.heartbeat();
    // A note is typed at 50 s: the keyboard is activity.
    t.at(50 * SEC);
    t.tracker.activity();
    t.at(60 * SEC);
    t.tracker.heartbeat();
    // Then 5 minutes away from the keyboard with the dialog open: only the 60 s window counts.
    t.at(60 * SEC + 5 * 60 * SEC);
    t.tracker.heartbeat();
    t.tracker.close();

    // 25 s of playback, 60 s window after the pause (to 85 s), then the note at 50 s restarts the
    // window to 110 s: counted up to 110 s in all.
    expect(total()).toBe(110);
  });
});

describe('sendResultOfError', () => {
  it.each([0, 500, 502, 503, 408, 429])('retries after status %d', (status) => {
    expect(sendResultOfError({ status })).toBe('retry');
  });

  it.each([400, 404, 409])(
    'does not retry after status %d: the server will never take it',
    (status) => {
      expect(sendResultOfError({ status })).toBe('sent');
    },
  );

  it('retries after anything that is not a response: a plain error, null, a string', () => {
    expect(sendResultOfError(new Error('offline'))).toBe('retry');
    expect(sendResultOfError(null)).toBe('retry');
    expect(sendResultOfError('boom')).toBe('retry');
    expect(sendResultOfError(undefined)).toBe('retry');
  });
});
