import { cva, type VariantProps } from 'class-variance-authority';
import { Tabs as TabsPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn('group/tabs flex gap-2 data-[orientation=horizontal]:flex-col', className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        default: 'bg-muted',
        line: 'gap-1 bg-transparent',
        // The quiet filter row (Jobs page): no track, no padding, a 32 px row of text tabs.
        ghost: 'gap-0.5 bg-transparent p-0 group-data-[orientation=horizontal]/tabs:h-8',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function TabsList({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

// `count` renders a trailing count badge: zinc-600 on the active tab, zinc-700 otherwise. In a ghost
// list it is plain muted text instead, and the tab itself is a 32 px text button: muted, a faint
// background on hover, the muted fill when active.
//
// Focus ring: grey and keyboard-only. Radix moves focus to the clicked tab with a script call, and
// Chrome treats that as keyboard focus, so a plain `focus-visible:` ring showed up after every
// mouse click. A pointer press marks the tab (`data-pointer`), which switches the ring off until
// focus leaves it or a key is pressed.
function TabsTrigger({
  className,
  children,
  count,
  onPointerDown,
  onKeyDown,
  onBlur,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  count?: number | string;
}) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "group/tabs-trigger relative inline-flex h-full items-center justify-center gap-1.5 rounded-[7px] border border-transparent px-2.5 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground outline-none not-data-pointer:focus-visible:border-ring not-data-pointer:focus-visible:ring-[3px] not-data-pointer:focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent',
        'data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground',
        // Ghost: no border and no shadow, muted text that brightens on hover (a faint fill) and
        // takes the muted fill when active. The `dark:` line beats the default tab's own dark fill.
        'group-data-[variant=ghost]/tabs-list:h-8 group-data-[variant=ghost]/tabs-list:rounded-lg group-data-[variant=ghost]/tabs-list:border-0 group-data-[variant=ghost]/tabs-list:text-muted-foreground group-data-[variant=ghost]/tabs-list:hover:bg-muted/50 group-data-[variant=ghost]/tabs-list:hover:text-foreground group-data-[variant=ghost]/tabs-list:data-[state=active]:bg-muted group-data-[variant=ghost]/tabs-list:data-[state=active]:text-foreground group-data-[variant=ghost]/tabs-list:data-[state=active]:shadow-none dark:group-data-[variant=ghost]/tabs-list:data-[state=active]:bg-muted',
        'after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100',
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        event.currentTarget.dataset.pointer = '';
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        delete event.currentTarget.dataset.pointer;
      }}
      onBlur={(event) => {
        onBlur?.(event);
        delete event.currentTarget.dataset.pointer;
      }}
      {...props}
    >
      {children}
      {count !== undefined && (
        <span
          data-slot="tabs-trigger-count"
          className={cn(
            'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-700 px-1.5 text-xs text-foreground tabular-nums group-data-[state=active]/tabs-trigger:bg-zinc-600',
            // Ghost: no pill, just the number in muted text at the label's size.
            'group-data-[variant=ghost]/tabs-list:h-auto group-data-[variant=ghost]/tabs-list:min-w-0 group-data-[variant=ghost]/tabs-list:rounded-none group-data-[variant=ghost]/tabs-list:bg-transparent group-data-[variant=ghost]/tabs-list:px-0 group-data-[variant=ghost]/tabs-list:text-sm group-data-[variant=ghost]/tabs-list:text-muted-foreground group-data-[variant=ghost]/tabs-list:group-data-[state=active]/tabs-trigger:bg-transparent',
          )}
        >
          {count}
        </span>
      )}
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
