import { type ReactNode, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Whether an element's text is wider than the element itself, so its ellipsis is showing. */
export function isCutOff(element: Pick<Element, 'scrollWidth' | 'clientWidth'> | null): boolean {
  return element !== null && element.scrollWidth > element.clientWidth;
}

interface FullTextTipProps {
  /** The whole text, as the tooltip shows it. */
  text: string;
  /** The truncating element (a `<Bidi>`): the tooltip opens only while it is cut off. */
  children: ReactNode;
  className?: string;
}

/**
 * Gives a truncated name a tooltip with the full name, and only while the column really cuts it
 * (a name that fits would just be repeated). The tooltip text carries `dir="auto"`, so a Hebrew
 * or mixed name reads in its own direction there too. The name is plain text in the page whether
 * or not it is cut, so screen readers get all of it and the tooltip is a sighted-mouse extra.
 */
export function FullTextTip({ text, children, className }: FullTextTipProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => setOpen(next && isCutOff(wrapper.current?.firstElementChild ?? null))}
    >
      <TooltipTrigger asChild>
        <div ref={wrapper} className={cn('min-w-0', className)}>
          {children}
        </div>
      </TooltipTrigger>
      <TooltipContent wide dir="auto" side="top" align="start" sideOffset={6}>
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
