import { Slider as SliderPrimitive } from 'radix-ui';
import type * as React from 'react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

// shadcn's new-york (v4) slider, plus these Studio Engine additions:
// - trackClassName, rangeClassName and thumbClassName, merged with cn into Track, Range and Thumb
//   (the player's timeline and volume are a thinner, white version of the stock blue slider).
// - children render inside Root, between the Track and the Thumbs: that is the layer for the
//   review notes' dots, and this order keeps the thumb painted on top of them.
// - aria-label goes on each Thumb (role="slider"), where assistive tech looks for it, not on Root.
// - Root gets cursor-pointer, and data-[disabled]:cursor-default: Tailwind v4 dropped the pointer
//   cursor on its own, and a disabled control keeps the plain arrow.
function Slider({
  className,
  trackClassName,
  rangeClassName,
  thumbClassName,
  defaultValue,
  value,
  min = 0,
  max = 100,
  'aria-label': ariaLabel,
  children,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  trackClassName?: string;
  rangeClassName?: string;
  thumbClassName?: string;
}) {
  const values = useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        'relative flex w-full cursor-pointer touch-none items-center select-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          'relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5',
          trackClassName,
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            'absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full',
            rangeClassName,
          )}
        />
      </SliderPrimitive.Track>
      {children}
      {Array.from({ length: values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          // biome-ignore lint/suspicious/noArrayIndexKey: one thumb per value, in order
          key={index}
          data-slot="slider-thumb"
          aria-label={ariaLabel}
          className={cn(
            'block size-4 shrink-0 rounded-full border border-primary bg-white shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50',
            thumbClassName,
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
