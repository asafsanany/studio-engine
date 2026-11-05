import type { LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * A small muted mark after a job's name that explains itself in a tooltip: a 14 px icon that takes
 * the keyboard's focus, so the tooltip is reachable without the mouse. The note's and the effort's
 * markers are this with their own icon, name and tooltip.
 */
interface HoverMarkerProps {
  icon: LucideIcon;
  /** The marker's accessible name; the icon itself is decoration. */
  label: string;
  /** What the tooltip says. */
  children: ReactNode;
  /** Extra classes for the tooltip (the note's wraps and is cut off at half the screen). */
  tooltipClassName?: string;
  /** Reading direction of the tooltip's text; the note's reads in its own (`auto`). */
  tooltipDir?: 'auto';
}

export function HoverMarker({
  icon: Icon,
  label,
  children,
  tooltipClassName,
  tooltipDir,
}: HoverMarkerProps) {
  const marker = useRef<HTMLSpanElement>(null);
  const pointerOnMarker = useRef(false);
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState(0);

  // The Jobs table re-sorts while jobs update, and React then moves the row's element in the page.
  // Chrome sends no `pointerleave` to an element that was moved, so Radix would never learn that
  // the pointer is gone and the tooltip would stay open. While it is open, a pointer move that
  // lands outside the marker, after the marker last saw the pointer arrive and never saw it leave,
  // is that missed leave: close the tooltip. (A normal leave clears the flag first: the browser
  // sends `pointerleave` before the `pointermove`, so the tooltip's grace area still works.) Radix
  // also still believes the pointer is on the marker and would ignore the next hover, so the
  // tooltip is remounted (`key`) to start over.
  useEffect(() => {
    if (!open) return;
    function closeOnMissedLeave(event: PointerEvent) {
      if (pointerOnMarker.current && !marker.current?.contains(event.target as Node | null)) {
        pointerOnMarker.current = false;
        setOpen(false);
        setFresh((count) => count + 1);
      }
    }
    document.addEventListener('pointermove', closeOnMissedLeave);
    return () => document.removeEventListener('pointermove', closeOnMissedLeave);
  }, [open]);

  return (
    <Tooltip key={fresh} open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          ref={marker}
          onPointerEnter={() => {
            pointerOnMarker.current = true;
          }}
          onPointerLeave={() => {
            pointerOnMarker.current = false;
          }}
          role="img"
          aria-label={label}
          // A span, not a button: it does nothing when clicked (the right-click menu changes what it
          // shows). But the keyboard must reach it, because the tooltip is the only place that says it.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: see above
          tabIndex={0}
          className="inline-flex shrink-0 rounded-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
        >
          <Icon aria-hidden="true" size={14} />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        sideOffset={6}
        dir={tooltipDir}
        className={tooltipClassName}
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
