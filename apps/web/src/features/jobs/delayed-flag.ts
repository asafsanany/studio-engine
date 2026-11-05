import { useEffect, useState } from 'react';

/**
 * How long the table waits before it draws skeleton rows. A reload usually answers in a few tens
 * of milliseconds, and skeleton rows that blink in and out for that long look like a flash; after
 * this long the wait is real and the placeholders earn their place.
 */
export const SKELETON_DELAY_MS = 250;

export interface DelayedFlag {
  /** Tells it whether the thing being waited for is happening. Idempotent while it stays the same. */
  set(active: boolean): void;
  /** Cancels a pending timer (the component went away). */
  dispose(): void;
}

/**
 * A flag that turns on only after `active` has stayed true for `delayMs`, and off as soon as it is
 * false again. `onChange` is called with each new value of the flag, never with the same one twice.
 * Plain timers, no React, so a test can drive it with fake ones.
 */
export function createDelayedFlag(delayMs: number, onChange: (on: boolean) => void): DelayedFlag {
  let on = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function change(next: boolean) {
    if (next === on) return;
    on = next;
    onChange(on);
  }

  return {
    set(active) {
      if (!active) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        change(false);
        return;
      }
      if (timer !== undefined || on) return;
      if (delayMs <= 0) {
        change(true);
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        change(true);
      }, delayMs);
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * `true` once `active` has been true for `delayMs`. With a zero delay it is true on the very first
 * render (also on the server), so tests and the like can see the settled markup.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const flag = createDelayedFlag(delayMs, setOn);
    flag.set(active);
    return () => {
      flag.dispose();
      // The flag is per effect run: a changed `active` starts again from "not yet".
      setOn(false);
    };
  }, [active, delayMs]);
  return active && (delayMs <= 0 || on);
}
