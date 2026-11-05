import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface TipProps {
  /** What the tooltip says; `null` shows none. */
  tip: string | null;
  /** The child is disabled: it gets no pointer events, so the tooltip hangs on a span around it. */
  disabled?: boolean;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  /** The sentence is long (an engine message): it wraps at 300 px. */
  wide?: boolean;
  children: ReactElement;
}

/** A tooltip around one button, also while the button is disabled (then the span takes the hover and the focus). */
export function Tip({ tip, disabled = false, side, align, wide, children }: TipProps) {
  if (tip === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the disabled button can't take focus, so the tooltip opens from this wrapper
            tabIndex={0}
            className="inline-flex rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
          >
            {children}
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent side={side} align={align} sideOffset={6} wide={wide}>
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}
