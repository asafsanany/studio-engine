import { Columns2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { compareKeyAction, PAUSED_LOOK_TEXT } from './paused-look';

interface CompareButtonProps {
  /** Compare is held: the original shows. */
  comparing: boolean;
  /** Compare is held (`true`) or let go (`false`). */
  onCompare?(on: boolean): void;
  /** The tooltip, when what is shown is not "the original" (a quick fix shows how it was before). */
  tip?: string;
  /** Classes added last, so they win: the phone's pill makes the button 32 px high (`h-8`) for a finger. */
  className?: string;
}

/**
 * The ghost "Compare" button of a preview pill on the video (the look on the paused frame, the
 * font preview): it shows the original while it is held, with the mouse or with Space or Enter.
 *
 * - A mouse down on a button would take the focus from the note box, so it is prevented.
 * - A finger holds it too, from the touch to its end (the phone's quick fix pill).
 * - Space and Enter belong to it (the pill that holds it is marked `data-own-keys`).
 * - It lets go when the pointer leaves it or it loses the focus.
 */
export function CompareButton({ comparing, onCompare, tip, className }: CompareButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-pressed={comparing}
          // A mouse down on a button would take the focus from the note box.
          onMouseDown={(event) => {
            event.preventDefault();
            onCompare?.(true);
          }}
          onMouseUp={() => onCompare?.(false)}
          onMouseLeave={() => onCompare?.(false)}
          // A finger: held from the touch to its end. A touch's mouse events come only after it has
          // ended, so without these the pill's Compare (the phone's quick fix) would only flash;
          // `preventDefault` on the end keeps those late mouse events from holding it again.
          onTouchStart={() => onCompare?.(true)}
          onTouchEnd={(event) => {
            if (event.cancelable) event.preventDefault();
            onCompare?.(false);
          }}
          onTouchCancel={() => onCompare?.(false)}
          onBlur={() => onCompare?.(false)}
          onKeyDown={(event) => {
            const hold = compareKeyAction(event.key, 'down');
            if (hold === null) return;
            event.preventDefault();
            onCompare?.(hold);
          }}
          onKeyUp={(event) => {
            const hold = compareKeyAction(event.key, 'up');
            if (hold === null) return;
            event.preventDefault();
            onCompare?.(hold);
          }}
          className={cn(
            'h-[26px] cursor-pointer gap-1.5 rounded-md px-2 text-xs font-medium text-[#FAFAFA] ease-in-out select-none [-webkit-touch-callout:none]',
            'hover:bg-[#27272A] hover:text-[#FAFAFA] dark:hover:bg-[#27272A]',
            'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(250,250,250,0.35)]',
            comparing && 'bg-[#27272A]',
            className,
          )}
        >
          <Columns2 aria-hidden="true" className="size-3.5" />
          {PAUSED_LOOK_TEXT.compare}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {tip ?? PAUSED_LOOK_TEXT.compareTip}
      </TooltipContent>
    </Tooltip>
  );
}
