import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

// Studio Engine: tooltips wait 300 ms before showing (the Components board rule).
function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

// Radix opens a tooltip on any focus. A script that hands focus back (a closing dialog returns it
// to the row's button) is not the user asking for the tip, so the tip opens on focus only when the
// browser would draw the focus ring: keyboard focus, `:focus-visible`. Hover is untouched.
function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event);
        // Radix skips its own handler (the one that opens the tip) for a prevented event.
        if (!event.currentTarget.matches(':focus-visible')) event.preventDefault();
      }}
      {...props}
    />
  );
}

// Restyled from shadcn's inverted default to the popover surface (design canvas, Components
// board): bg-popover + border, 12px text, no arrow. The canvas gives its 12 px text the page's
// 1.43 line height (17.16 px), not Tailwind's 16 px, so a one-line tip is 31 px tall, not 30.
// `wide` is for longer text such as error messages: it wraps at 300px instead of staying on one
// line.
function TooltipContent({
  className,
  sideOffset = 8,
  wide = false,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  wide?: boolean;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-wide={wide || undefined}
        sideOffset={sideOffset}
        className={cn(
          'z-50 ease-in-out w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-sm border bg-popover px-3 py-1.5 text-xs leading-[1.43] whitespace-nowrap text-popover-foreground shadow-[0_4px_12px_rgb(0_0_0/0.4)] fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          wide && 'max-w-[300px] py-2 leading-normal whitespace-normal',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
