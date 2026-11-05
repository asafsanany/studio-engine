import { type PointerEvent, useEffect, useRef } from 'react';
import { swipeIntent, swipeOffset, swipeShouldClose } from '@/lib/swipe-close';
import { cn } from '@/lib/utils';

/**
 * The grab handle of a bottom sheet (the pill above its title), and what it is for: drag the sheet
 * down and it follows the finger; let go far enough or fast enough and `onClose` runs (the sheet's
 * own closing animation then slides it out from where it is), otherwise it springs back.
 *
 * - **A finger** drags the sheet from anywhere on it, as in iOS: the grabber listens to the touches
 *   of its whole sheet. A touch that goes down while the list under it is scrolled to the top
 *   moves the sheet; any other touch scrolls as usual (`swipeIntent`). A touch that starts in a
 *   text field, or in anything marked `data-no-swipe`, is left alone.
 * - **A mouse or a pen** drags the grabber itself.
 *
 * The handle is a picture for a screen reader: the sheet also closes with its × button, Back and
 * Esc. Its touch area reaches a little above and well below the pill. Must sit inside a Radix
 * dialog's content (the sheet it moves is its closest `role="dialog"`).
 */
export function SheetGrabber({ onClose, className }: { onClose: () => void; className?: string }) {
  const self = useRef<HTMLDivElement>(null);
  // Read when a swipe ends, so the touch listeners need not be put on again for a new `onClose`.
  const close = useRef(onClose);
  close.current = onClose;
  // A ref, not a variable: the sheet re-renders under the finger when a job event arrives.
  const drag = useRef<{ startY: number; startAt: number; sheet: HTMLElement | null } | null>(null);

  // A finger, anywhere on the sheet.
  useEffect(() => {
    const sheet = self.current?.closest<HTMLElement>('[role="dialog"]');
    if (!sheet) return;
    let touch: {
      id: number;
      x: number;
      y: number;
      at: number;
      atTop: boolean;
      intent: ReturnType<typeof swipeIntent>;
    } | null = null;

    const onStart = (event: TouchEvent) => {
      const first = event.touches[0];
      if (event.touches.length !== 1 || first === undefined || startsInField(event.target)) {
        touch = null;
        return;
      }
      touch = {
        id: first.identifier,
        x: first.clientX,
        y: first.clientY,
        at: performance.now(),
        atTop: !scrolledDown(event.target, sheet),
        intent: 'pending',
      };
    };
    const onMove = (event: TouchEvent) => {
      const current = touch;
      const point = current && findTouch(event.touches, current.id);
      if (!current || !point) return;
      const dy = point.clientY - current.y;
      if (current.intent === 'pending') {
        current.intent = swipeIntent({ dx: point.clientX - current.x, dy, atTop: current.atTop });
        if (current.intent === 'drag') sheet.style.transition = 'none';
      }
      if (current.intent !== 'drag') return;
      // The sheet moves, not the page or the list under it.
      event.preventDefault();
      sheet.style.transform = `translateY(${swipeOffset(dy)}px)`;
    };
    const onEnd = (event: TouchEvent, cancelled: boolean) => {
      const current = touch;
      touch = null;
      if (current?.intent !== 'drag') return;
      const point = findTouch(event.changedTouches, current.id);
      const dy = point ? point.clientY - current.y : 0;
      if (!cancelled && swipeShouldClose({ dy, ms: performance.now() - current.at })) {
        sheet.style.removeProperty('transition');
        close.current();
        return;
      }
      springBack(sheet);
    };
    const onTouchEnd = (event: TouchEvent) => onEnd(event, false);
    const onTouchCancel = (event: TouchEvent) => onEnd(event, true);

    sheet.addEventListener('touchstart', onStart, { passive: true });
    // Not passive: a drag of the sheet stops the scroll it would otherwise be.
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onTouchEnd);
    sheet.addEventListener('touchcancel', onTouchCancel);
    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onTouchEnd);
      sheet.removeEventListener('touchcancel', onTouchCancel);
    };
  }, []);

  // A mouse or a pen, on the grabber. A finger is the sheet's (above), wherever it lands.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const sheet = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
    drag.current = { startY: event.clientY, startAt: performance.now(), sheet };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (sheet) sheet.style.transition = 'none';
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.sheet) {
      current.sheet.style.transform = `translateY(${swipeOffset(event.clientY - current.startY)}px)`;
    }
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    const dy = event.clientY - current.startY;
    const ms = performance.now() - current.startAt;
    if (!cancelled && swipeShouldClose({ dy, ms })) {
      current.sheet?.style.removeProperty('transition');
      onClose();
      return;
    }
    if (current.sheet) springBack(current.sheet);
  };

  return (
    <div
      ref={self}
      aria-hidden="true"
      data-slot="sheet-grabber"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      className={cn(
        'relative flex flex-none touch-none justify-center before:absolute before:inset-x-0 before:-top-2 before:-bottom-4 before:content-[""]',
        className,
      )}
    >
      <span className="h-[5px] w-9 rounded-full bg-zinc-700" />
    </div>
  );
}

/** The sheet slides back to where it was. */
function springBack(sheet: HTMLElement): void {
  sheet.style.transition = 'transform 200ms ease-in-out';
  sheet.style.transform = '';
  window.setTimeout(() => sheet.style.removeProperty('transition'), 220);
}

/** The touch with this id, if it is still on the screen (or just left it). */
function findTouch(touches: TouchList, id: number): Touch | undefined {
  for (const touch of Array.from(touches)) if (touch.identifier === id) return touch;
  return undefined;
}

/** A touch in a text field (or anything marked `data-no-swipe`) is the field's, never a swipe. */
function startsInField(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable="true"], [data-no-swipe]') !== null
  );
}

/** Whether anything from the touch's target up to the sheet is scrolled down. */
function scrolledDown(target: EventTarget | null, sheet: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true;
    if (node === sheet) break;
  }
  return false;
}
