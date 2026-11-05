import { WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { FONT_CELL_NARROW, fontRowLayout } from './FontRow';
import { FONT_LIST_TEXT, offlineBannerText } from './font-list';

// What the Fonts list shows besides rows (boards FOPage and FOStates): the hint of an empty
// library, the no-match line, "Can't reach the engine." and the skeleton rows, and the bar above
// the page while the engine is away. Each is a quiet block with no border.

/** Rows of skeleton while the first answer is on its way. */
export const FONT_SKELETON_ROWS = 10;

/** A line of muted text in the rows' list. */
export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <li className="px-3 py-2">
      <p className="text-muted-foreground">{children}</p>
    </li>
  );
}

/**
 * "No fonts yet. Drop .ttf or .otf files anywhere on this page, or use Import fonts.": the empty
 * library. "Import fonts" opens the import dialog, like the page's button; it waits while the
 * engine cannot be reached.
 */
export function EmptyLibraryHint({
  onImport,
  disabled,
}: {
  onImport: () => void;
  disabled: boolean;
}) {
  return (
    <Hint>
      {FONT_LIST_TEXT.emptyLibrary}{' '}
      <Button
        type="button"
        variant="link"
        disabled={disabled}
        onClick={onImport}
        className="h-auto p-0 font-normal text-foreground underline underline-offset-2"
      >
        {FONT_LIST_TEXT.emptyLibraryLink}
      </Button>
      .
    </Hint>
  );
}

/** "No font matches “q”." under the tabs when the tab and the search leave nothing. */
export function NoMatchingFonts({ text }: { text: string }) {
  return <p className="mt-2 pl-3 text-muted-foreground">{text}</p>;
}

/**
 * "Can't reach the engine." with a "Try again" link, where the list would be, when the first
 * answer never came (same block as the Jobs, Graphics and LUTs lists').
 */
export function UnreachableFonts({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-24 items-center justify-center gap-1 px-3 text-center text-muted-foreground">
      <span role="alert">{FONT_LIST_TEXT.unreachable}</span>
      <Button
        type="button"
        variant="link"
        onClick={onRetry}
        className="h-auto p-0 text-blue-300 underline hover:text-blue-200"
      >
        {FONT_LIST_TEXT.tryAgain}
      </Button>
    </div>
  );
}

/** Widths of the name bar, varied row by row so the block does not look stamped. */
const NAME_BAR = ['w-40', 'w-28', 'w-48', 'w-32'] as const;

/** A skeleton block that stands still for people who asked for less motion. */
function Bone({ className }: { className: string }) {
  return <Skeleton className={cn('motion-reduce:animate-none', className)} />;
}

/**
 * Skeleton rows on the same grid as the real ones: the icon, the name, the script, the weights, the
 * used label (only while notes can name a font) and the time. Screen readers get one "Loading
 * fonts…" instead of ten rows of nothing.
 */
export function LoadingFontRows({ inNotes }: { inNotes: boolean }) {
  return Array.from({ length: FONT_SKELETON_ROWS }, (_, row) => (
    // The rows are identical and never reorder, so the index is the right key.
    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
    <li key={row} data-skeleton-row="" className={fontRowLayout(inNotes)}>
      {row === 0 && (
        <span role="status" className="sr-only">
          {FONT_LIST_TEXT.loading}
        </span>
      )}
      <Bone className="size-4 rounded-full" />
      <Bone className={cn('h-4', NAME_BAR[row % NAME_BAR.length])} />
      <Bone className={cn('h-4 w-24', FONT_CELL_NARROW.script)} />
      <Bone className={cn('h-4 w-16', FONT_CELL_NARROW.weights)} />
      {inNotes && <Bone className={cn('h-4 w-14', FONT_CELL_NARROW.used)} />}
      <Bone className={cn('h-4 w-14 justify-self-end', FONT_CELL_NARROW.added)} />
    </li>
  ));
}

/**
 * The bar under the page's header while the engine can't be reached (board FOStates 10): the list
 * below is as it was, and importing waits. Full width with a hairline under it, like the LUTs and
 * Graphics pages' (the Fonts page draws it above its two columns). A status, so it is read out when
 * it appears.
 */
export function OfflineFontsBanner({ heardAt }: { heardAt: number | null }) {
  return (
    <div
      role="status"
      data-slot="fonts-offline-banner"
      className="flex flex-none items-center gap-2.5 border-b bg-card px-6 py-2.5 text-[13px] text-card-foreground"
    >
      <WifiOff aria-hidden="true" className="size-4 flex-none text-status-held" />
      {offlineBannerText(heardAt)}
    </div>
  );
}
