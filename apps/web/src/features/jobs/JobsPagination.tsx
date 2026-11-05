import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import { pageItems, rangeText } from './pagination';

interface JobsPaginationProps {
  /** Zero-based current page. */
  pageIndex: number;
  pageCount: number;
  pageSize: number;
  /** Rows across all pages (after the tab and search). */
  total: number;
  onPageChange: (pageIndex: number) => void;
  /** What the rows are, said after the range ("1–25 of 40 clients"). The Jobs table says nothing. */
  unit?: string;
}

/**
 * Under the table: which rows are showing ("11–12 of 12") on the left, Previous / page numbers /
 * Next on the right. The controls are buttons (`PaginationLink` is an anchor, which would need a
 * fake href), styled as the Pagination component styles its links.
 */
export function JobsPagination({
  pageIndex,
  pageCount,
  pageSize,
  total,
  onPageChange,
  unit,
}: JobsPaginationProps) {
  const current = pageIndex + 1;
  const first = pageIndex <= 0;
  const last = pageIndex >= pageCount - 1;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-muted-foreground tabular-nums" aria-live="polite">
        {rangeText(pageIndex, pageSize, total)}
        {unit && ` ${unit}`}
      </span>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <Button
              type="button"
              variant="ghost"
              aria-label="Go to previous page"
              disabled={first}
              onClick={() => onPageChange(pageIndex - 1)}
              className="gap-1 has-[>svg]:pr-2.5 has-[>svg]:pl-2"
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
              className="gap-1 has-[>svg]:pr-2 has-[>svg]:pl-2.5"
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
