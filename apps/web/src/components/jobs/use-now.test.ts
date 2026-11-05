import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClock } from './use-now';

describe('createClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T13:42:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds one value until the next tick, then notifies every subscriber', () => {
    const clock = createClock(30_000);
    const a = vi.fn();
    const b = vi.fn();
    clock.subscribe(a);
    clock.subscribe(b);
    const first = clock.getSnapshot();

    vi.advanceTimersByTime(29_999);
    expect(clock.getSnapshot()).toBe(first);
    expect(a).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(clock.getSnapshot()).toBe(first + 30_000);

    vi.advanceTimersByTime(30_000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(clock.getSnapshot()).toBe(first + 60_000);
  });

  it('runs a single interval however many subscribers there are', () => {
    const clock = createClock(30_000);
    clock.subscribe(() => {});
    clock.subscribe(() => {});
    clock.subscribe(() => {});
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops the interval with the last unsubscribe and restarts it with the next subscriber', () => {
    const clock = createClock(30_000);
    const stopA = clock.subscribe(() => {});
    const stopB = clock.subscribe(() => {});
    stopA();
    expect(vi.getTimerCount()).toBe(1);
    stopB();
    expect(vi.getTimerCount()).toBe(0);

    clock.subscribe(() => {});
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops notifying a subscriber that has unsubscribed', () => {
    const clock = createClock(1000);
    const gone = vi.fn();
    const kept = vi.fn();
    const stop = clock.subscribe(gone);
    clock.subscribe(kept);
    stop();
    vi.advanceTimersByTime(1000);
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('catches up to the real time when subscribing after a quiet period', () => {
    const clock = createClock(30_000);
    const before = clock.getSnapshot();
    vi.advanceTimersByTime(10 * 60_000);
    clock.subscribe(() => {});
    expect(clock.getSnapshot()).toBe(before + 10 * 60_000);
  });

  it('gives a fresh value to a component rendering while nobody is subscribed', () => {
    const clock = createClock(30_000);
    const before = clock.getSnapshot();
    vi.advanceTimersByTime(10_000);
    // Less than one interval old: still the same value, so React sees a stable snapshot.
    expect(clock.getSnapshot()).toBe(before);
    vi.advanceTimersByTime(25_000);
    const refreshed = clock.getSnapshot();
    expect(refreshed).toBe(before + 35_000);
    // ...and then it is stable again.
    expect(clock.getSnapshot()).toBe(refreshed);
  });

  it('survives a listener unsubscribing during a tick', () => {
    const clock = createClock(1000);
    const second = vi.fn();
    const stopFirst = clock.subscribe(() => stopFirst());
    clock.subscribe(second);
    vi.advanceTimersByTime(1000);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
