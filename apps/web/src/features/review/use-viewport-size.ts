import { useEffect, useState } from 'react';
import { DEFAULT_VIEWPORT } from './dialog-layout';

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Whether an element is full screen, from `document.fullscreenElement`. Safari on iPhone has no
 * element full screen, and there the property is `undefined`, not `null`: a check against `null`
 * alone would read that as "something is full screen" for ever, and the size would never follow
 * the window.
 */
export function fullscreenActive(fullscreenElement: unknown): boolean {
  return fullscreenElement != null;
}

function currentSize(): ViewportSize {
  return typeof window === 'undefined'
    ? { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height }
    : { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The window's inner size, following resizes. While something is full screen the window grows to the
 * whole screen, and the dialog behind it must not jump, so the size is left as it was until full
 * screen ends. Without a window (a server render) it is `DEFAULT_VIEWPORT`.
 */
export function useViewportSize(): ViewportSize {
  const [size, setSize] = useState(currentSize);

  useEffect(() => {
    function update() {
      if (fullscreenActive(document.fullscreenElement)) return;
      const next = currentSize();
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    }
    // The window may have been resized between the first render and now.
    update();
    window.addEventListener('resize', update);
    document.addEventListener('fullscreenchange', update);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('fullscreenchange', update);
    };
  }, []);

  return size;
}
