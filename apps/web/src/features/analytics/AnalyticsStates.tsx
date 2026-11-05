import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * How long the Analytics page waits before it draws grey placeholders for a first load. A local
 * answer usually takes a few tens of milliseconds, and placeholders that blink in and out for that
 * long look like a flash; after this long the wait is real.
 */
export const ANALYTICS_SKELETON_DELAY_MS = 300;

/**
 * How long after the page opens it asks once more when the Max plan's last reading was stale: the
 * engine reads the plan's limits in the background when the page is asked for, and takes a few
 * seconds over it.
 */
export const PLAN_PROBE_RELOAD_MS = 20_000;

/**
 * Where the page puts each card, and how tall it is. A card and the placeholder that stands in
 * for it take the same classes, so the page does not jump when the numbers arrive. The grids are
 * two columns of tiles / one column of cards below 1000 px, and 5 / 6 columns from there.
 *
 * Claude use is three rows of two, the API credits on the left and the Max plan on the right: the
 * two gauge cards, the two lists (the lists are as tall as they need, so their row lines them up at
 * the top), then the two charts, which show both budgets each. One column below 1000 px.
 *
 * The cards of the board are fixed in height. Those that hold text that can wrap (the typical job
 * with its legend, the three of Claude use with their subtitles, legends and sentences) are a
 * minimum height instead, so a narrow card grows rather than cutting its last line off. Cards with
 * a chart cap the chart's own height (see the cards), so a wide card never makes a tall chart.
 */
export const ANALYTICS_LAYOUT = {
  tilesGrid: 'grid grid-cols-2 gap-4 min-[1000px]:grid-cols-5',
  cardsGrid: 'grid grid-cols-1 gap-6 min-[1000px]:grid-cols-6',
  listsGrid: 'grid grid-cols-1 items-start gap-6 min-[1000px]:grid-cols-6',
  tile: 'min-h-[180px]',
  rerunsPerApproved: 'h-[340px] min-[1000px]:col-span-6',
  deliveredPerDay: 'h-[340px] min-[1000px]:col-span-3',
  footagePerWeek: 'h-[340px] min-[1000px]:col-span-3',
  typicalJob: 'min-h-[470px] min-[1000px]:col-span-6',
  approvedFirstTime: 'h-[500px] min-[1000px]:col-span-3',
  noteTopics: 'h-[500px] min-[1000px]:col-span-3',
  apiCredits: 'min-h-[300px] min-[1000px]:col-span-3',
  maxPlan: 'min-h-[300px] min-[1000px]:col-span-3',
  creditsPaidFor: 'min-h-[300px] min-[1000px]:col-span-3',
  planUsage: 'min-h-[300px] min-[1000px]:col-span-3',
  creditsThroughMonth: 'min-h-[400px] min-[1000px]:col-span-3',
  busiestWeek: 'min-h-[400px] min-[1000px]:col-span-3',
  services: 'min-h-[300px] min-[1000px]:col-span-6',
} as const;

/**
 * "Can't reach the engine." with "Try again", the way the Money page says it: the first load
 * failed, and nothing is on screen to keep showing.
 */
export function AnalyticsUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[196px] items-center justify-center rounded-[12px] border text-center text-muted-foreground">
      <p>
        <span role="alert">Can't reach the engine.</span>{' '}
        <Button
          type="button"
          variant="link"
          onClick={onRetry}
          className="h-auto p-0 text-blue-300 underline hover:text-blue-200"
        >
          Try again
        </Button>
      </p>
    </div>
  );
}

/**
 * A card that has not arrived. Grey while the wait is real (`visible`), and an empty space of the
 * same size before that, so the page keeps its shape.
 */
export function CardPlaceholder({ visible, className }: { visible: boolean; className: string }) {
  if (!visible) return <div aria-hidden="true" className={className} />;
  return (
    <div
      data-skeleton-card=""
      className={cn('flex flex-col gap-2 rounded-[12px] border p-5', className)}
    >
      <Skeleton className="h-4 w-40 motion-reduce:animate-none" />
      <Skeleton className="h-3.5 w-56 max-w-full motion-reduce:animate-none" />
    </div>
  );
}
