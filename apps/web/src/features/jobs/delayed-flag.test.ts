import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDelayedFlag, SKELETON_DELAY_MS } from './delayed-flag';

describe('createDelayedFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns on only after the delay has passed, not before', () => {
    const onChange = vi.fn();
    const flag = createDelayedFlag(SKELETON_DELAY_MS, onChange);
    flag.set(true);

    vi.advanceTimersByTime(SKELETON_DELAY_MS - 1);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('never turns on when the wait ends within the delay (a fast reload shows no skeleton)', () => {
    const onChange = vi.fn();
    const flag = createDelayedFlag(SKELETON_DELAY_MS, onChange);
    flag.set(true);
    vi.advanceTimersByTime(120);
    flag.set(false);
    vi.advanceTimersByTime(SKELETON_DELAY_MS * 4);

    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns off as soon as the wait is over, and can start again from "not yet"', () => {
    const onChange = vi.fn();
    const flag = createDelayedFlag(SKELETON_DELAY_MS, onChange);
    flag.set(true);
    vi.advanceTimersByTime(SKELETON_DELAY_MS);
    flag.set(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);

    flag.set(true);
    vi.advanceTimersByTime(SKELETON_DELAY_MS - 1);
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(onChange.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('does not restart the clock when told the same thing again', () => {
    const onChange = vi.fn();
    const flag = createDelayedFlag(SKELETON_DELAY_MS, onChange);
    flag.set(true);
    vi.advanceTimersByTime(200);
    flag.set(true);
    vi.advanceTimersByTime(SKELETON_DELAY_MS - 200);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    flag.set(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('turns on at once with a zero delay', () => {
    const onChange = vi.fn();
    createDelayedFlag(0, onChange).set(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('stops its timer when disposed', () => {
    const onChange = vi.fn();
    const flag = createDelayedFlag(SKELETON_DELAY_MS, onChange);
    flag.set(true);
    flag.dispose();
    vi.advanceTimersByTime(SKELETON_DELAY_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits a quarter of a second by default', () => {
    expect(SKELETON_DELAY_MS).toBe(250);
  });
});
