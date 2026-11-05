import { useEffect, useState } from 'react';
import { type KeyboardFrame, keyboardFrame } from './phone-review';

const NO_KEYBOARD: KeyboardFrame = { keyboardOpen: false, box: null };

/** What is read of `window.visualViewport`. */
export interface VisualViewportLike {
  readonly height: number;
  readonly offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
}

function sameFrame(a: KeyboardFrame, b: KeyboardFrame): boolean {
  return (
    a.keyboardOpen === b.keyboardOpen &&
    a.box?.top === b.box?.top &&
    a.box?.height === b.box?.height
  );
}

/**
 * Follows the keyboard through `viewport`: tells `onFrame` where the page is visible now, and again
 * whenever that changes (the keyboard comes up or goes down, Safari scrolls what is visible).
 * `layoutHeight` is the page's own height, which the keyboard does not change. Returns the stop.
 */
export function watchKeyboardFrame(
  viewport: VisualViewportLike,
  layoutHeight: () => number,
  onFrame: (frame: KeyboardFrame) => void,
): () => void {
  let last: KeyboardFrame | null = null;
  function measure() {
    const next = keyboardFrame({
      layoutHeight: layoutHeight(),
      viewportHeight: viewport.height,
      offsetTop: viewport.offsetTop,
    });
    if (last !== null && sameFrame(last, next)) return;
    last = next;
    onFrame(next);
  }
  measure();
  viewport.addEventListener('resize', measure);
  viewport.addEventListener('scroll', measure);
  return () => {
    viewport.removeEventListener('resize', measure);
    viewport.removeEventListener('scroll', measure);
  };
}

/**
 * Where the keyboard leaves the page visible, while `enabled` (the note box is open). Without
 * `visualViewport`, or while not enabled, there is no keyboard to follow.
 */
export function useKeyboardFrame(enabled: boolean): KeyboardFrame {
  const [frame, setFrame] = useState<KeyboardFrame>(NO_KEYBOARD);

  useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport;
    if (!enabled || viewport === null) {
      setFrame(NO_KEYBOARD);
      return;
    }
    return watchKeyboardFrame(viewport, () => document.documentElement.clientHeight, setFrame);
  }, [enabled]);

  return enabled ? frame : NO_KEYBOARD;
}
