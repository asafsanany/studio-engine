// Helpers shared by the pipeline tests. Not part of the server build (see tsconfig.build.json).

import type { EtaTimers } from './eta.js';
import { realSleep, type Sleep } from './fake-runner.js';

/** Interval timers that only fire when told to (`fire`), so a test controls every tick. */
export class FakeIntervals implements EtaTimers {
  private next = 1;
  private readonly scheduled = new Map<number, { callback: () => void; ms: number }>();

  setInterval(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.scheduled.set(handle, { callback, ms });
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  /** The intervals set and not cleared, as their periods in milliseconds. */
  get active(): number[] {
    return [...this.scheduled.values()].map((timer) => timer.ms);
  }

  /** Runs every active interval's callback once, as one period passing. */
  fire(): void {
    for (const { callback } of [...this.scheduled.values()]) callback();
  }
}

/** How often a Generate test's step looks at the folder (its `pollIntervalMs`), in milliseconds. */
export const GENERATE_TEST_POLL_MS = 4;

/** How long each pause of the fake Generate run lasts in a test: longer than the poll, see `generatePauses`. */
const GENERATE_TEST_PAUSE_MS = 12;

/** Resolves once `signal` is aborted (at once when it already is). */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * The pauses of the fake Generate run for a test that watches the stage while it works (GN5, C67).
 * The fake run waits before every step; a test gives it `sleep` for those waits.
 *
 * - Every pause lasts a little longer than the step's poll (`GENERATE_TEST_POLL_MS`), and timers fire
 *   in the order they expire, so the step looks at the folder at least once in every pause, however
 *   busy the machine is: a phase that has a pause before each of its steps is always seen, and its
 *   row and text reach the page. (A pause shorter than the poll left that to luck.)
 * - `holdAt(ms, nth)` makes the run wait before the `nth` pause that was asked to last `ms` (the
 *   length the fake run uses for that part, `FAKE_GENERATE_MS`) until the run is aborted, and
 *   resolves once it waits there. No script is running at that point, so a test can stop or cancel
 *   the engine at a place it names, instead of racing a poll against a run that goes on and kills
 *   a script between the file it made and the line it wrote in spend.json.
 */
export function generatePauses(): {
  sleep: Sleep;
  holdAt: (ms: number, nth: number) => Promise<void>;
} {
  const asked = new Map<number, number>();
  let hold: { ms: number; nth: number; reached: () => void } | null = null;
  const sleep: Sleep = async (ms, signal) => {
    const nth = (asked.get(ms) ?? 0) + 1;
    asked.set(ms, nth);
    if (hold !== null && hold.ms === ms && hold.nth === nth) {
      hold.reached();
      await untilAborted(signal);
      return;
    }
    await realSleep(GENERATE_TEST_PAUSE_MS, signal);
  };
  return {
    sleep,
    holdAt: (ms, nth) =>
      new Promise<void>((resolve) => {
        hold = { ms, nth, reached: resolve };
      }),
  };
}
