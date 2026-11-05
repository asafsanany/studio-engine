import { type InputCounts as InputCountsData, inputTooltip } from '@studio/shared';
import { Image as ImageIcon, type LucideIcon, Mic, Video } from 'lucide-react';
import { FileText } from '@/components/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type InputType = keyof InputCountsData;

/** The four slots, always in this order, whatever the counts are. */
export const INPUT_SLOTS = [
  { type: 'video', icon: Video },
  { type: 'audio', icon: Mic },
  { type: 'image', icon: ImageIcon },
  { type: 'doc', icon: FileText },
] as const satisfies readonly { type: InputType; icon: LucideIcon }[];

export interface InputSlot {
  type: InputType;
  icon: LucideIcon;
  count: number;
  /** "14 video clips": the tooltip, and the text a screen reader gets. */
  tooltip: string;
  /** A slot with nothing in it is shown at half strength. */
  empty: boolean;
}

/** The four slots for a job's file counts, in slot order. */
export function inputSlots(inputs: InputCountsData): InputSlot[] {
  return INPUT_SLOTS.map(({ type, icon }) => ({
    type,
    icon,
    count: inputs[type],
    tooltip: inputTooltip(type, inputs[type]),
    empty: inputs[type] === 0,
  }));
}

/**
 * The Inputs cell: a fixed grid of four 40 px slots (video, audio, image, doc) so the icons line
 * up row after row. Each slot is an icon with the count after it, and a tooltip such as
 * "14 video clips". A count of 0 dims the whole slot to 50%.
 */
export function InputCounts({
  inputs,
  className,
}: {
  inputs: InputCountsData;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-[repeat(4,40px)] gap-1 text-foreground', className)}>
      {inputSlots(inputs).map(({ type, icon: Icon, count, tooltip, empty }) => (
        <Tooltip key={type}>
          <TooltipTrigger asChild>
            <span
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip must open from the keyboard
              tabIndex={0}
              data-input={type}
              className={cn(
                'inline-flex items-center gap-[5px] rounded-sm text-[13px] tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
                empty && 'opacity-50',
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span aria-hidden="true">{count}</span>
              <span className="sr-only">{tooltip}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
