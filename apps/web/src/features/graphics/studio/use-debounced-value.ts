import { useEffect, useState } from 'react';

export interface Debouncer<T> {
  /** The latest value; `onChange` gets it once `delayMs` pass with no newer one. */
  push(value: T): void;
  /** Cancels a pending value (the component went away). */
  dispose(): void;
}

/**
 * Calls `onChange(value)` only after `delayMs` with no newer value: a value that is followed by
 * another within the delay is never given. Plain timers, no React, so a test can drive it with
 * fake ones.
 */
export function createDebouncer<T>(delayMs: number, onChange: (value: T) => void): Debouncer<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    push(value) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onChange(value);
      }, delayMs);
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * `value`, `delayMs` after it last changed. The first render gives `value` as it is, so nothing
 * waits on mount.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const debouncer = createDebouncer<T>(delayMs, setDebounced);
    debouncer.push(value);
    return () => debouncer.dispose();
  }, [value, debounced, delayMs]);
  return debounced;
}
