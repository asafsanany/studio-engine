import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The box every tile and chart of the Instagram section sits in (board CLPage): a 12 px rounded
 * border, 16 px of room, the title in medium weight and the one line under it in muted 13 px. The
 * section lays the boxes out; `className` is the box's own height or span (or `overflow-visible`
 * for a tile whose sparkline hover card hangs out under it). `action` (the Reels
 * list's filter) sits at the right of the title.
 */
export function InstagramCard({
  title,
  subtitle,
  className,
  gap = 'gap-3',
  action,
  children,
}: {
  title: string;
  subtitle: string;
  className?: string;
  /** The space between the title block and what is under it. */
  gap?: string;
  /** A control at the right of the title block; the two wrap when the box is narrow. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="font-medium">{title}</h3>
      <p className="text-[13px] text-muted-foreground">{subtitle}</p>
    </div>
  );
  return (
    <section
      aria-label={title}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-[12px] border p-4',
        gap,
        className,
      )}
    >
      {action === undefined ? (
        heading
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {heading}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** The little dot and name of a chart's legend (the colour of a series, or of the bar of ours). */
export function LegendRow({ items }: { items: readonly { color: string; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
