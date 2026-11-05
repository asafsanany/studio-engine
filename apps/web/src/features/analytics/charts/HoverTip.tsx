import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * A hover card on one element of a chart that is plain HTML (a day of the calendar, a bar of a
 * list), in the same look as the shadcn chart's own. Comes up as soon as the pointer is on it, as
 * a chart's does, not after the 300 ms the page's other tooltips wait. `children` is the element
 * itself and takes the pointer.
 */
export function HoverTip({
  text,
  wide = false,
  children,
}: {
  text: string;
  /** For a long line: it wraps at 300 px instead of staying on one line. */
  wide?: boolean;
  children: ReactElement;
}) {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent wide={wide}>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
