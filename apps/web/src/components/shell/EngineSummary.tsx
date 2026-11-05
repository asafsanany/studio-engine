import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { StatusTab } from '@/stores/jobs-ui';
import { countEngine, SUMMARY_ITEMS, type SummaryJob } from './engine-summary';

/**
 * "1 editing · 2 queued · 1 in review · 3 need attention" in the header. Presentational: it takes the jobs and
 * reports which status tab the user asked for; the header connects it to the Jobs UI store.
 *
 * Without a list (`jobs` is `undefined`: the first load is running, or the engine cannot be
 * reached) it renders nothing. A 0 there would be a lie, and dots with no numbers are not a
 * summary; the Jobs page's toolbar leaves its counts out in the same situation.
 */
export function EngineSummary({
  jobs,
  onSelectTab,
  className,
}: {
  jobs: ReadonlyArray<SummaryJob> | undefined;
  onSelectTab: (tab: StatusTab) => void;
  className?: string;
}) {
  if (jobs === undefined) return null;
  const counts = countEngine(jobs);

  return (
    <fieldset
      aria-label="Engine summary"
      className={cn('flex min-w-0 items-center gap-1', className)}
    >
      {SUMMARY_ITEMS.map((item) => {
        const count = counts[item.key];
        return (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            size="sm"
            // The canvas keeps the muted label colour on hover; only the background changes.
            className="h-7 gap-1.5 rounded-sm px-2 text-[13px] font-normal text-muted-foreground hover:text-muted-foreground dark:hover:bg-accent"
            onClick={() => onSelectTab(item.tab)}
          >
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', item.dot)} />
            <span className="font-medium text-foreground tabular-nums">{count}</span>
            {/* On a phone only the dot and the count stay visible (the label is still read out). */}
            <span className="max-sm:sr-only">{item.label(count)}</span>
          </Button>
        );
      })}
    </fieldset>
  );
}
