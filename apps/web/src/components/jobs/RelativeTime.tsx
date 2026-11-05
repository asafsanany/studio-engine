import { absoluteTime, relativeTime, type TimeInput } from '@studio/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useNow } from './use-now';

interface RelativeTimeProps {
  /** The moment to show, as an ISO timestamp: `addedAt` or `updatedAt`. */
  iso: string;
  /** Pins the current time (tests, the dev page). Without it the text follows the clock. */
  now?: TimeInput;
  /** Pins the time zone (an IANA name). Without it the viewer's own zone is used. */
  timeZone?: string;
  className?: string;
}

/**
 * "12 min ago", "Yesterday", ... in muted text, with the exact time ("Tue 20 Oct 2026, 13:41") in
 * a tooltip on hover and keyboard focus. Re-renders every 30 s on a clock shared by all instances
 * (see useNow), so a table full of them runs one timer. Used by both Added and Last updated.
 * Renders nothing when `iso` cannot be parsed.
 */
export function RelativeTime({ iso, now, timeZone, className }: RelativeTimeProps) {
  const clock = useNow();
  const text = relativeTime(iso, now ?? clock, timeZone);
  if (text === '') return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={iso}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip must open from the keyboard
          tabIndex={0}
          className={cn(
            'rounded-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
            className,
          )}
        >
          {text}
        </time>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{absoluteTime(iso, timeZone)}</TooltipContent>
    </Tooltip>
  );
}
