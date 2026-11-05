import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';
import type * as React from 'react';
import { type Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function Pagination({ className, ...props }: React.ComponentProps<'nav'>) {
  return (
    <nav
      aria-label="pagination"
      data-slot="pagination"
      className={cn('mx-auto flex w-full justify-center', className)}
      {...props}
    />
  );
}

function PaginationContent({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn('flex flex-row items-center gap-1', className)}
      {...props}
    />
  );
}

function PaginationItem({ ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="pagination-item" {...props} />;
}

type PaginationLinkProps = {
  isActive?: boolean;
  // Greyed out and not clickable (e.g. Previous on the first page).
  disabled?: boolean;
} & Pick<React.ComponentProps<typeof Button>, 'size'> &
  React.ComponentProps<'a'>;

// The active page uses the outline button style, every other link is ghost.
function PaginationLink({
  className,
  isActive,
  disabled,
  size = 'icon',
  ...props
}: PaginationLinkProps) {
  return (
    <a
      aria-current={isActive ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
      data-slot="pagination-link"
      data-active={isActive}
      className={cn(
        buttonVariants({
          variant: isActive ? 'outline' : 'ghost',
          size,
        }),
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function PaginationPrevious({ className, ...props }: React.ComponentProps<typeof PaginationLink>) {
  return (
    <PaginationLink
      aria-label="Go to previous page"
      size="default"
      className={cn('gap-1 has-[>svg]:pr-2.5 has-[>svg]:pl-2', className)}
      {...props}
    >
      <ChevronLeftIcon />
      Previous
    </PaginationLink>
  );
}

function PaginationNext({ className, ...props }: React.ComponentProps<typeof PaginationLink>) {
  return (
    <PaginationLink
      aria-label="Go to next page"
      size="default"
      className={cn('gap-1 has-[>svg]:pr-2 has-[>svg]:pl-2.5', className)}
      {...props}
    >
      Next
      <ChevronRightIcon />
    </PaginationLink>
  );
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn('flex size-9 items-center justify-center', className)}
      {...props}
    >
      <MoreHorizontalIcon className="size-4" />
      <span className="sr-only">More pages</span>
    </span>
  );
}

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
};
