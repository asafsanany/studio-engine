import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { NO_DATA_YET } from './analytics-copy';

/**
 * The shell every card of the Analytics page shares: a bordered, rounded box with its title and
 * its one-line subtitle, and room for what the card shows below them. The page lays the cards out
 * (their width and height are the `className` of the cell they sit in). `aside` sits at the right
 * of the title: a status chip.
 */
export function AnalyticsCard({
  title,
  subtitle,
  aside,
  className,
  children,
}: {
  title: string;
  subtitle: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        'flex min-w-0 flex-col gap-3.5 overflow-hidden rounded-[12px] border p-5',
        className,
      )}
    >
      {aside === undefined ? (
        <TitleBlock title={title} subtitle={subtitle} />
      ) : (
        <div className="flex items-start justify-between gap-3">
          <TitleBlock title={title} subtitle={subtitle} />
          {aside}
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function TitleBlock({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="font-medium">{title}</h3>
      <p className="text-[13px] text-muted-foreground">{subtitle}</p>
    </div>
  );
}

/**
 * A card with nothing to show yet (no job finished, no usage logged): muted, in the middle of the
 * room the card has.
 */
export function NoDataYet() {
  return (
    <div className="flex h-full min-h-16 items-center justify-center">
      <p className="text-sm text-muted-foreground">{NO_DATA_YET}</p>
    </div>
  );
}

/**
 * The shell of one tile of the top row: the title and the line under it, then the number, the
 * sparkline and the change. Smaller than a card (16 px padding, a 12 px radius all the same).
 */
export function AnalyticsTileCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-h-[180px] min-w-0 flex-col gap-2.5 rounded-[12px] border p-4"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="font-medium">{title}</h3>
        <p className="truncate text-[13px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
