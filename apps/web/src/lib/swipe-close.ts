/**
 * When a swipe down on a bottom sheet closes it, on its grabber or anywhere on the sheet. Plain
 * functions, so the rules are tested without a touch screen.
 *
 * Far enough closes it (96 px), and so does a quick flick that has only gone a little way (24 px at
 * half a pixel per millisecond or faster). Anything else lets the sheet spring back, and so does
 * a swipe up.
 */

/** A swipe that goes at least this far down closes the sheet, however slowly. */
export const SWIPE_CLOSE_DISTANCE_PX = 96;

/** A flick closes it after only this much, if it is fast enough. */
export const SWIPE_FLICK_DISTANCE_PX = 24;

/** How fast a flick is, in pixels per millisecond. */
export const SWIPE_FLICK_SPEED = 0.5;

/** How far the sheet follows the finger: down only (a swipe up leaves it where it is). */
export function swipeOffset(dy: number): number {
  return dy > 0 ? dy : 0;
}

/** Whether a swipe that moved `dy` px down (negative: up) in `ms` milliseconds closes the sheet. */
export function swipeShouldClose({ dy, ms }: { dy: number; ms: number }): boolean {
  if (dy <= 0) return false;
  if (dy >= SWIPE_CLOSE_DISTANCE_PX) return true;
  return dy >= SWIPE_FLICK_DISTANCE_PX && ms > 0 && dy / ms >= SWIPE_FLICK_SPEED;
}

/** How far a finger moves on the sheet before the touch counts as a drag, so a tap stays a tap. */
export const SWIPE_START_PX = 6;

/**
 * What a touch on a bottom sheet's body becomes once the finger moves: `pending` until it has gone
 * `SWIPE_START_PX`; then `drag` (the sheet follows the finger and may close) when it goes down more
 * than sideways and nothing under the finger is scrolled down (`atTop`, read when the touch began),
 * else `scroll`, and the page or the list scrolls as usual. A sheet scrolled down scrolls back up
 * first; a second swipe from the top closes it, as in iOS.
 */
export function swipeIntent({
  dx,
  dy,
  atTop,
}: {
  dx: number;
  dy: number;
  atTop: boolean;
}): 'pending' | 'drag' | 'scroll' {
  if (Math.hypot(dx, dy) < SWIPE_START_PX) return 'pending';
  return atTop && dy > 0 && dy > Math.abs(dx) ? 'drag' : 'scroll';
}
