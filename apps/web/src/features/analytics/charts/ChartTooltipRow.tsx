import type { ReactNode } from 'react';

/**
 * One line of a chart's hover card, for the `formatter` of the shadcn `ChartTooltipContent`: a
 * square in the series' colour, its name, the figure at the right and, under them, a muted note.
 */
export function ChartTooltipRow({
  color,
  label,
  value,
  note,
}: {
  color: string;
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex w-full items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-[2px]"
          style={{ background: color }}
        />
        <span className="text-muted-foreground">{label}</span>
        <span className="ml-auto pl-4 font-mono font-medium text-foreground tabular-nums">
          {value}
        </span>
      </div>
      {note !== undefined && <span className="pl-[18px] text-muted-foreground">{note}</span>}
    </div>
  );
}
