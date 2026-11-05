import { useSyncExternalStore } from 'react';

// One timer per tick length, shared by every component that asks for the time. The Jobs table can
// have dozens of rows with two RelativeTime cells each; they all subscribe to the same 30 s store
// instead of running 60 intervals, and they all re-render together on the same tick.

export interface Clock {
  /** For `useSyncExternalStore`: starts the interval with the first subscriber, stops with the last. */
  subscribe(listener: () => void): () => void;
  /** The time of the last tick, as epoch milliseconds. The same value until the next tick. */
  getSnapshot(): number;
}

/**
 * A clock that ticks every `intervalMs` while somebody is listening. `readNow` is a parameter so
 * tests can drive it with fake timers; the app uses `Date.now`.
 *
 * Between the last unsubscribe and the next subscribe nothing ticks, so the stored time goes
 * stale. `getSnapshot` therefore re-reads it when it is older than one interval and nobody is
 * subscribed yet, which makes the first render of a newly mounted component show the right time
 * instead of the one from when the previous component unmounted.
 */
export function createClock(intervalMs: number, readNow: () => number = Date.now): Clock {
  const listeners = new Set<() => void>();
  let current = readNow();
  let timer: ReturnType<typeof setInterval> | undefined;

  function tick() {
    current = readNow();
    // Copy first: a listener may unsubscribe while we notify.
    for (const listener of [...listeners]) listener();
  }

  return {
    subscribe(listener) {
      if (listeners.size === 0) {
        // The first subscriber after a quiet period: catch up now, then keep time from here.
        current = readNow();
        timer = setInterval(tick, intervalMs);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot() {
      if (listeners.size === 0) {
        const now = readNow();
        if (now - current >= intervalMs) current = now;
      }
      return current;
    },
  };
}

const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createClock(intervalMs);
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/** How often relative times ("12 min ago") are refreshed. */
export const RELATIVE_TIME_TICK_MS = 30_000;

/**
 * The current time as epoch milliseconds, refreshed every `intervalMs` (30 s by default). Pass it
 * to the D3 formatters, which never read the clock themselves. Use 1000 for a countdown such as
 * "settles in 0:42".
 */
export function useNow(intervalMs: number = RELATIVE_TIME_TICK_MS): number {
  const clock = clockFor(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
