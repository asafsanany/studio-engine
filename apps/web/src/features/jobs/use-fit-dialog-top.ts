import { useEffect } from 'react';

/** From 640 px wide up (Tailwind's `sm:`), where the dialog is placed by its top and not centred. */
const PLACED_BY_TOP = '(min-width: 640px)';

/** The least room left above a dialog that was moved up, and below it. */
const MARGIN_PX = 16;

/**
 * Where the top of a dialog `height` tall goes in a window `windowHeight` tall: `topPx` when it all
 * fits below that, else as far up as keeps `MARGIN_PX` below it, and never above `MARGIN_PX`.
 */
export function fittedTop(topPx: number, height: number, windowHeight: number): number {
  return Math.max(MARGIN_PX, Math.min(topPx, windowHeight - height - MARGIN_PX));
}

/**
 * Keeps a dialog that sits a fixed distance from the top (`top`, 288 px for the note's @ picker,
 * which opens above the box and needs that room) inside the window when it grows: a picture
 * attached to the note makes the dialog some 190 px taller, which would run its Save button off
 * the bottom of a window that is not tall. Its top moves up by what is missing, and goes back when
 * the room is there again (a picture taken off, the window made taller). Never above 16 px.
 *
 * It sets `top` on the element itself (above `sm:` only; below it the dialog is centred and the
 * browser keeps it in view), and gives it back to the class when `enabled` turns off. The picker,
 * when it is open on a dialog that was moved up, has less room above the box: it is the price of a
 * dialog that does not fit.
 */
export function useFitDialogTop(
  element: HTMLElement | null,
  enabled: boolean,
  topPx: number,
): void {
  useEffect(() => {
    if (element === null || !enabled || typeof window.matchMedia !== 'function') return;

    const fit = () => {
      if (!window.matchMedia(PLACED_BY_TOP).matches) {
        element.style.removeProperty('top');
        return;
      }
      element.style.top = `${fittedTop(topPx, element.offsetHeight, window.innerHeight)}px`;
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      element.style.removeProperty('top');
    };
  }, [element, enabled, topPx]);
}
