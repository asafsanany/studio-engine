import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncer } from './use-debounced-value';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncer', () => {
  it('gives the value only after the delay has passed', () => {
    const seen: string[] = [];
    const debouncer = createDebouncer<string>(300, (value) => seen.push(value));

    debouncer.push('a');
    vi.advanceTimersByTime(299);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(['a']);
  });

  it('waits again for each new value, and gives only the last of a burst', () => {
    const seen: string[] = [];
    const debouncer = createDebouncer<string>(300, (value) => seen.push(value));

    debouncer.push('d');
    vi.advanceTimersByTime(200);
    debouncer.push('da');
    vi.advanceTimersByTime(200);
    debouncer.push('dan');
    vi.advanceTimersByTime(299);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(['dan']);
  });

  it('gives a value once, and each pause its own', () => {
    const seen: string[] = [];
    const debouncer = createDebouncer<string>(300, (value) => seen.push(value));

    debouncer.push('a');
    vi.advanceTimersByTime(1000);
    debouncer.push('b');
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(['a', 'b']);
  });

  it('gives nothing after it is disposed', () => {
    const seen: string[] = [];
    const debouncer = createDebouncer<string>(300, (value) => seen.push(value));

    debouncer.push('a');
    debouncer.dispose();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
    // Disposing twice, or with nothing pending, is harmless.
    debouncer.dispose();
  });
});
