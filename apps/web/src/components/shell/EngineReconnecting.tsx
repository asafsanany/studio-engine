import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export const RECONNECTING_TEXT = 'Reconnecting to the engine…';

/**
 * The header's answer to "the engine went away while a list was on screen": a quiet line of muted
 * text with a small spinner, where the engine summary (now out of date) would be. It is not an
 * error, so it has no alarm colour, no icon of its own beyond the spinner and no button; the page
 * finds the engine again by itself. It fades in rather than popping, and the caller only mounts
 * it after the engine has been gone for a couple of seconds, so a blip never shows it.
 *
 * The status container is always in the page (and empty while everything is fine), so that screen
 * readers, which only announce changes inside a live region that was already there, say it.
 */
export function EngineReconnecting({
  reconnecting,
  className,
}: {
  reconnecting: boolean;
  className?: string;
}) {
  return (
    <div role="status" className={cn('flex min-w-0 items-center', className)}>
      {reconnecting && (
        <p className="flex min-w-0 animate-in items-center gap-2 text-[13px] text-muted-foreground duration-300 ease-in-out fade-in-0">
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 flex-none animate-spin motion-reduce:animate-none"
          />
          <span className="truncate">{RECONNECTING_TEXT}</span>
        </p>
      )}
    </div>
  );
}
