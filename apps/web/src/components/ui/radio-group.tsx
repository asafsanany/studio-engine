import { CircleIcon } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

// shadcn's new-york (v4) radio group, plus: a white dot (the board's radio; stock is the primary blue),
// a pointer cursor on the item (Tailwind v4 dropped it)
// and the neutral focus ring every control in the app uses.
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('grid gap-3', className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'aspect-square size-4 shrink-0 cursor-pointer rounded-full border border-input text-foreground shadow-xs data-[state=checked]:border-foreground transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-foreground" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
