import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ROW_LAYOUT_CLASSES } from './JobRow';

// What the Jobs list shows when there are no job rows. Each one is a quiet block with no border,
// centred where the list would be (or, for loading, ten placeholder rows in its place).

/** Rows of skeleton while the first answer is on its way: a full page. */
export const SKELETON_ROW_COUNT = 10;

/** "No jobs yet." Nothing has ever arrived (Jobs · empty board): a 160 px block, centred. */
export function EmptyJobs() {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-1 px-3 text-center">
      <p className="font-medium">No jobs yet.</p>
      <p className="text-muted-foreground">
        Drop a folder into{' '}
        <code className="font-mono text-[13px] text-foreground">
          Studio Inbox/&lt;Client&gt;/&lt;Job&gt;
        </code>{' '}
        to start.
      </p>
    </div>
  );
}

/** "No matching jobs." There are jobs, but the tab and the search hide them all: a 96 px block. */
export function NoMatchingJobs() {
  return (
    <div className="flex h-24 items-center justify-center px-3 text-center text-muted-foreground">
      No matching jobs.
    </div>
  );
}

/**
 * "Can't reach the engine." with a "Try again" link, in the same 96 px block as "No matching
 * jobs.". The link is a button (it runs the retry, it goes nowhere) dressed as the canvas's links.
 */
export function UnreachableJobs({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-24 items-center justify-center gap-1 px-3 text-center text-muted-foreground">
      <span role="alert">Can't reach the engine.</span>
      <Button
        type="button"
        variant="link"
        onClick={onRetry}
        className="h-auto p-0 text-blue-300 underline hover:text-blue-200"
      >
        Try again
      </Button>
    </div>
  );
}

/** Widths of the job-name bar, varied row by row so the block does not look stamped. */
const NAME_BAR = ['w-40', 'w-32', 'w-44', 'w-36'] as const;

/** A skeleton block that stands still for people who asked for less motion. */
function Bone({ className }: { className: string }) {
  return <Skeleton className={cn('motion-reduce:animate-none', className)} />;
}

/**
 * Ten skeleton rows, 44 px high and on the same grid as the real ones: a round status icon, the
 * name, the detail, the time on the right and the square of the next-step button. Screen readers
 * get one "Loading jobs…" instead of ten rows of nothing.
 */
export function LoadingJobRows() {
  return Array.from({ length: SKELETON_ROW_COUNT }, (_, row) => (
    // The rows are identical and never reorder, so the index is the right key.
    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
    <li key={row} data-skeleton-row="" className={ROW_LAYOUT_CLASSES}>
      {row === 0 && (
        <span role="status" className="sr-only">
          Loading jobs…
        </span>
      )}
      <Bone className="size-4 rounded-full" />
      <Bone className={cn('h-4', NAME_BAR[row % NAME_BAR.length])} />
      <Bone className="h-4 w-24" />
      <Bone className="h-4 w-14 justify-self-end" />
      <Bone className="size-8 rounded-lg" />
    </li>
  ));
}
