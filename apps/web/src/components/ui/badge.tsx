import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-sm border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        // Destructive tint (failed jobs), not a solid fill.
        destructive:
          'border-status-failed/40 bg-status-failed/10 text-status-failed-foreground focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-status-failed/15',
        outline:
          'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

// Small status dot, placed before the label: <BadgeDot className="bg-status-ready" />.
function BadgeDot({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="badge-dot"
      className={cn('size-1.5 shrink-0 rounded-full bg-current', className)}
      {...props}
    />
  );
}

export { Badge, BadgeDot, badgeVariants };
