import { Plus, Shapes, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { GRAPHIC_ROW_LAYOUT } from './GraphicRow';
import { GRAPHICS_TEXT, makingText, offlineBannerText } from './graphic-list';

// What the Graphics list shows besides rows (boards GRLibrary and GRStates 1 and 9). Each is a quiet
// block with no border, where the list would be, except the offline banner above the page.

/** Rows of skeleton while the first answer is on its way. */
export const GRAPHIC_SKELETON_ROWS = 8;

/** "No graphics yet": nothing has been made. A circle with the shapes, one line of what to do, and New graphic. */
export function EmptyGraphics({
  onNew,
  disabled = false,
}: {
  onNew: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-3 pb-20 text-center">
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-full border bg-card"
      >
        <Shapes className="size-5 text-muted-foreground" strokeWidth={1.8} />
      </span>
      <h2 className="text-base font-semibold">{GRAPHICS_TEXT.emptyTitle}</h2>
      <p className="max-w-100 text-muted-foreground">{GRAPHICS_TEXT.emptyBody}</p>
      <Button type="button" disabled={disabled} onClick={onNew} className="mt-1">
        <Plus aria-hidden="true" />
        {GRAPHICS_TEXT.newGraphic}
      </Button>
    </div>
  );
}

/** "No graphic matches “q”." under the toolbar when the search leaves nothing. */
export function NoMatchingGraphics({ query }: { query: string }) {
  return (
    <p className="mt-2 pl-3 text-muted-foreground">
      No graphic matches “<bdi>{query.trim()}</bdi>”.
    </p>
  );
}

/**
 * "Can't reach the engine." with a "Try again" link, where the list would be, when the first
 * answer never came (same block as the Jobs list's).
 */
export function UnreachableGraphics({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-24 items-center justify-center gap-1 px-3 text-center text-muted-foreground">
      <span role="alert">{GRAPHICS_TEXT.unreachable}</span>
      <Button
        type="button"
        variant="link"
        onClick={onRetry}
        className="h-auto p-0 text-blue-300 underline hover:text-blue-200"
      >
        {GRAPHICS_TEXT.tryAgain}
      </Button>
    </div>
  );
}

/** Widths of the name bar, varied row by row so the block does not look stamped. */
const NAME_BAR = ['w-48', 'w-36', 'w-56', 'w-40'] as const;

/** A skeleton block that stands still for people who asked for less motion. */
function Bone({ className }: { className: string }) {
  return <Skeleton className={cn('motion-reduce:animate-none', className)} />;
}

/**
 * Skeleton rows on the same grid as the real ones: the mark, the name, the detail and the time.
 * Screen readers get one "Loading graphics…" instead of eight rows of nothing.
 */
export function LoadingGraphicRows() {
  return Array.from({ length: GRAPHIC_SKELETON_ROWS }, (_, row) => (
    // The rows are identical and never reorder, so the index is the right key.
    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
    <li key={row} data-skeleton-row="" className={GRAPHIC_ROW_LAYOUT}>
      {row === 0 && (
        <span role="status" className="sr-only">
          {GRAPHICS_TEXT.loading}
        </span>
      )}
      <Bone className="size-4 rounded-full" />
      <Bone className={cn('h-4', NAME_BAR[row % NAME_BAR.length])} />
      <Bone className="h-4 w-28" />
      <Bone className="h-4 w-16 justify-self-end" />
      <span />
    </li>
  ));
}

/**
 * The bar above the page while the engine can't be reached (board GRStates 9): the list below is
 * as it was, and New graphic waits. It bleeds to the page's edges, under the header, like the
 * board (the shell's page area has 24 px of room around it). A status, so it is read out when it
 * appears.
 */
export function OfflineGraphicsBanner({ heardAt }: { heardAt: number | null }) {
  return (
    <div
      role="status"
      className="-mx-6 -mt-6 mb-2 flex items-center gap-2.5 border-b bg-card px-6 py-2.5 text-[13px] text-card-foreground"
    >
      <WifiOff aria-hidden="true" className="size-4 flex-none text-status-held" />
      {offlineBannerText(heardAt)}
    </div>
  );
}

/** "● 2 being made": the blue dot and how many graphics are being made. */
export function MakingSummary({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-status-editing" />
      {makingText(count)}
    </span>
  );
}
