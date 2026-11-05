import { Switch as SwitchPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * shadcn's stock Switch, with one addition for touch screens: `size="lg"` is a 44 × 26 px track
 * with a 20 px knob, 3 px from the track's edge on both sides, which the phone's View sheet uses.
 * The track is the primary blue when on.
 */
function Switch({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: 'default' | 'lg';
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 data-[size=lg]:h-[26px] data-[size=lg]:w-11 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground',
          'group-data-[size=lg]/switch:size-5 group-data-[size=lg]/switch:data-[state=checked]:translate-x-5 group-data-[size=lg]/switch:data-[state=unchecked]:translate-x-0.5',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
