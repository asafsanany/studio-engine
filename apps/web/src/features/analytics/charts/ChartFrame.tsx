import type { ComponentProps } from 'react';
import { type ChartConfig, ChartContainer } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

/**
 * The room a chart of the Analytics page draws in: as wide as its card and as tall as the card has
 * left (at least `min-h-[240px]`, or what `className` says). The shadcn chart is absolutely placed
 * in a box that takes the rest of the card's height, so it fills the card whatever the card's own
 * height is made of (a fixed height, or a minimum one).
 */
export function ChartFrame({
  config,
  ariaLabel,
  className,
  children,
}: {
  config: ChartConfig;
  /** What a screen reader hears. */
  ariaLabel: string;
  className?: string;
  children: ComponentProps<typeof ChartContainer>['children'];
}) {
  return (
    <div className={cn('relative min-h-[240px] flex-1', className)}>
      <ChartContainer
        config={config}
        className="absolute inset-0 aspect-auto justify-start"
        role="img"
        aria-label={ariaLabel}
      >
        {children}
      </ChartContainer>
    </div>
  );
}
