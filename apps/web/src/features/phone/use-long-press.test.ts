import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, longPress } from './use-long-press';

const finger = (x = 100, y = 200) => ({ pointerType: 'touch', clientX: x, clientY: y });

describe('longPress: press and hold, the phone’s right-click', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds once a finger stays still for 500 ms, and the click that follows is not a tap', () => {
    const onHold = vi.fn();
    const press = longPress(onHold);
    press.handlers.onPointerDown(finger());
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    press.handlers.onPointerUp();
    expect(press.takeHold()).toBe(true);
    // Only that one click.
    expect(press.takeHold()).toBe(false);
  });

  it('is a tap when the finger lifts sooner', () => {
    const onHold = vi.fn();
    const press = longPress(onHold);
    press.handlers.onPointerDown(finger());
    vi.advanceTimersByTime(200);
    press.handlers.onPointerUp();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onHold).not.toHaveBeenCalled();
    expect(press.takeHold()).toBe(false);
  });

  it('lets the list scroll: a finger that moves past 10 px is not holding', () => {
    const onHold = vi.fn();
    const press = longPress(onHold);
    press.handlers.onPointerDown(finger(100, 200));
    press.handlers.onPointerMove(finger(100, 200 + LONG_PRESS_SLOP_PX));
    vi.advanceTimersByTime(100);
    press.handlers.onPointerMove(finger(100, 200 + LONG_PRESS_SLOP_PX + 1));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('stops when the browser takes the pointer (scrolling) or it leaves the row', () => {
    for (const end of ['onPointerCancel', 'onPointerLeave'] as const) {
      const onHold = vi.fn();
      const press = longPress(onHold);
      press.handlers.onPointerDown(finger());
      press.handlers[end]();
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(onHold, end).not.toHaveBeenCalled();
    }
  });

  it('does not wait on a mouse: its right button is the way', () => {
    const onHold = vi.fn();
    const press = longPress(onHold);
    press.handlers.onPointerDown({ pointerType: 'mouse', clientX: 0, clientY: 0 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('holds on a right-click or Android’s long press, with no browser menu', () => {
    const onHold = vi.fn();
    const press = longPress(onHold);
    const preventDefault = vi.fn();
    press.handlers.onContextMenu({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('holds once when the timer and Android’s contextmenu both come', () => {
    const onHold = vi.fn();
    const press = longPress(onHold);
    press.handlers.onPointerDown(finger());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    press.handlers.onContextMenu({ preventDefault: () => {} });
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('starts again with the next finger', () => {
    const onHold = vi.fn();
    const press = longPress(onHold);
    press.handlers.onPointerDown(finger());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    press.handlers.onPointerDown(finger());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('forgets a finger that is down when cancelled (the row is going)', () => {
    const onHold = vi.fn();
    const press = longPress(onHold);
    press.handlers.onPointerDown(finger());
    press.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onHold).not.toHaveBeenCalled();
  });
});
