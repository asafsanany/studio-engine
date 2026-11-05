import type * as React from 'react';
import { cn } from '@/lib/utils';

// shadcn new-york Textarea, with the same border, background and quiet neutral focus ring as the
// Input next to it (no blue ring: the app's --ring is zinc). The stock `field-sizing-content`
// (grows with the text) is left to the caller: a dialog wants a fixed box that scrolls.
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
