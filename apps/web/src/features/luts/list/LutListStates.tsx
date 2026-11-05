import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { LUT_ROW_LAYOUT } from './LutRow';
import { LUT_LIST_TEXT } from './lut-list';

// What the LUTs list shows besides rows (boards LUPage and LUStates): the section headings, the
// hints under them, the no-match line, "Can't reach the engine." and the skeleton rows. Each is a
// quiet block with no border.

/** Rows of skeleton while the first answer is on its way. */
export const LUT_SKELETON_ROWS = 8;

/** "Yours 3" / "Built in 19": a small muted heading that starts a section. */
export function SectionHead({ title, count }: { title: string; count?: number }) {
  return (
    <li className="px-3 pt-3 pb-1">
      <h2 className="text-xs font-medium tracking-[0.02em] text-muted-foreground">
        {title}
        {count !== undefined && <span className="ml-1.5 text-zinc-500 tabular-nums">{count}</span>}
      </h2>
    </li>
  );
}

/** A line of muted text under a heading, in the rows' list. */
export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <li className="px-3 py-2">
      <p className="text-muted-foreground">{children}</p>
    </li>
  );
}

/**
 * "Nothing imported yet. Drop .cube files anywhere on this page, or use Import LUTs.": the empty
 * Yours section. "Import LUTs" opens the import dialog, like the page's button; it waits while the
 * engine cannot be reached.
 */
export function EmptyYoursHint({
  onImport,
  disabled,
}: {
  onImport: () => void;
  disabled: boolean;
}) {
  return (
    <Hint>
      {LUT_LIST_TEXT.emptyYours}{' '}
      <Button
        type="button"
        variant="link"
        disabled={disabled}
        onClick={onImport}
        className="h-auto p-0 font-normal text-foreground underline underline-offset-2"
      >
        {LUT_LIST_TEXT.emptyYoursLink}
      </Button>
      .
    </Hint>
  );
}

/** "No LUT matches “q”." under the headings when the tab and the search leave nothing. */
export function NoMatchingLuts({ text }: { text: string }) {
  return <p className="mt-2 pl-3 text-muted-foreground">{text}</p>;
}

/**
 * "Can't reach the engine." with a "Try again" link, where the list would be, when the first
 * answer never came (same block as the Jobs and Graphics lists').
 */
export function UnreachableLuts({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-24 items-center justify-center gap-1 px-3 text-center text-muted-foreground">
      <span role="alert">{LUT_LIST_TEXT.unreachable}</span>
      <Button
        type="button"
        variant="link"
        onClick={onRetry}
        className="h-auto p-0 text-blue-300 underline hover:text-blue-200"
      >
        {LUT_LIST_TEXT.tryAgain}
      </Button>
    </div>
  );
}

/** Widths of the name bar, varied row by row so the block does not look stamped. */
const NAME_BAR = ['w-44', 'w-32', 'w-52', 'w-36'] as const;

/** A skeleton block that stands still for people who asked for less motion. */
function Bone({ className }: { className: string }) {
  return <Skeleton className={cn('motion-reduce:animate-none', className)} />;
}

/**
 * Skeleton rows on the same grid as the real ones: the icon, the name, the kind, the used label and
 * the time. Screen readers get one "Loading LUTs…" instead of eight rows of nothing.
 */
export function LoadingLutRows() {
  return Array.from({ length: LUT_SKELETON_ROWS }, (_, row) => (
    // The rows are identical and never reorder, so the index is the right key.
    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
    <li key={row} data-skeleton-row="" className={LUT_ROW_LAYOUT}>
      {row === 0 && (
        <span role="status" className="sr-only">
          {LUT_LIST_TEXT.loading}
        </span>
      )}
      <Bone className="size-4 rounded-full" />
      <Bone className={cn('h-4', NAME_BAR[row % NAME_BAR.length])} />
      <Bone className="h-4 w-16" />
      <Bone className="h-4 w-20" />
      <Bone className="h-4 w-14 justify-self-end" />
    </li>
  ));
}
