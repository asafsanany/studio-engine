import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import { pageItems } from '../jobs/pagination';
import { type PagerUnit, pagerRangeText } from './format';

interface MoneyPagerProps {
  /** The name of the page buttons' navigation ("Ledger pages", "Expense pages"). */
  label: string;
  /** What the rows are, said after the range: `{ one: 'job', many: 'jobs' }`. */
  unit: PagerUnit;
  /** Zero-based current page. */
  pageIndex: number;
  pageCount: number;
  pageSize: number;
  /** Rows across all pages. */
  total: number;
  onPageChange: (pageIndex: number) => void;
}

/**
 * Under every table of the Money page (the Ledger and both Expenses lists): "Showing 1–10 of 26
 * jobs" on the left, Previous / page numbers / Next on the right. It is the Jobs pagination's
 * buttons (the same page buttons, the same Previous and Next) with the Money board's wording: the
 * Jobs pager says the range without "Showing", and the board of the Money page says it with. The
 * Jobs pager itself is left as it is.
 */
export function MoneyPager({
  label,
  unit,
  pageIndex,
  pageCount,
  pageSize,
  total,
  onPageChange,
}: MoneyPagerProps) {
  const current = pageIndex + 1;
  const first = pageIndex <= 0;
  const last = pageIndex >= pageCount - 1;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-muted-foreground tabular-nums" aria-live="polite">
        {pagerRangeText(pageIndex, pageSize, total, unit)}
      </span>
      <Pagination aria-label={label} className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <Button
              type="button"
              variant="ghost"
              aria-label="Go to previous page"
              disabled={first}
              onClick={() => onPageChange(pageIndex - 1)}
              // The board's 10 px either side of the icon and the label.
              className="gap-1 has-[>svg]:px-2.5"
            >
              <ChevronLeftIcon />
              Previous
            </Button>
          </PaginationItem>
          {pageItems(current, pageCount).map((item) =>
            typeof item === 'number' ? (
              <PaginationItem key={item}>
                <Button
                  type="button"
                  variant={item === current ? 'outline' : 'ghost'}
                  size="icon"
                  aria-label={`Go to page ${item}`}
                  aria-current={item === current ? 'page' : undefined}
                  onClick={() => onPageChange(item - 1)}
                  className="tabular-nums"
                >
                  {item}
                </Button>
              </PaginationItem>
            ) : (
              <PaginationItem key={item} aria-hidden>
                <span className="flex size-9 items-center justify-center">
                  <MoreHorizontalIcon className="size-4" />
                </span>
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <Button
              type="button"
              variant="ghost"
              aria-label="Go to next page"
              disabled={last}
              onClick={() => onPageChange(pageIndex + 1)}
              className="gap-1 has-[>svg]:px-2.5"
            >
              Next
              <ChevronRightIcon />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
