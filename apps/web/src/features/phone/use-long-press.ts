import { useEffect, useRef, useState } from 'react';

// Press and hold: the phone's right-click (the owner, 31 Oct: Approve is in the row's menu only). A
// finger that stays on a row opens its sheet, whose list is the row's right-click menu, even where a
// tap opens something else (a job in Review opens its chat with Draft & chat on). A right-click
// does the same in the phone layout, and so does Android's own long press (`contextmenu`).

/** How long a finger stays still before it counts as press and hold (about iOS's own). */
export const LONG_PRESS_MS = 500;

/** A finger that moves further than this, in px, is scrolling the list, not holding a row. */
export const LONG_PRESS_SLOP_PX = 10;

/** What the handlers read of a pointer event. */
interface PointerLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}

export interface LongPress {
  /** Spread on the element that is held. */
  handlers: {
    onPointerDown: (event: PointerLike) => void;
    onPointerMove: (event: PointerLike) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerLeave: () => void;
    onContextMenu: (event: { preventDefault: () => void }) => void;
  };
  /**
   * True once after a hold: the click that comes with lifting the finger is not a tap, and the
   * element's `onClick` returns on it.
   */
  takeHold: () => boolean;
  /** Forgets a finger that is down (the element is going). */
  cancel: () => void;
}

/** Calls `onHold` when a finger stays on the element for `LONG_PRESS_MS`, or on a right-click. */
export function longPress(onHold: () => void): LongPress {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  let held = false;

  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    start = null;
  }

  function hold() {
    cancel();
    if (held) return;
    held = true;
    onHold();
  }

  return {
    handlers: {
      onPointerDown(event) {
        held = false;
        // A mouse has its right button for this; only a finger or a pen waits.
        if (event.pointerType === 'mouse') return;
        cancel();
        start = { x: event.clientX, y: event.clientY };
        timer = setTimeout(hold, LONG_PRESS_MS);
      },
      onPointerMove(event) {
        if (start === null) return;
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved > LONG_PRESS_SLOP_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onContextMenu(event) {
        // No browser menu on a row: Android's long press and a right-click both open the sheet.
        event.preventDefault();
        hold();
      },
    },
    takeHold() {
      const was = held;
      held = false;
      return was;
    },
    cancel,
  };
}

/** `longPress` for a component: one per mount, calling the latest `onHold`. */
export function useLongPress(onHold: () => void): LongPress {
  const latest = useRef(onHold);
  latest.current = onHold;
  const [press] = useState(() => longPress(() => latest.current()));
  useEffect(() => () => press.cancel(), [press]);
  return press;
}
