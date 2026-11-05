import type { MoneyResponse } from '@studio/shared';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { BANNER_TONE_STYLES } from './banner-view';
import { formatIls } from './format';
import {
  LEDGER_GRID_TEMPLATE,
  LEDGER_MIN_WIDTH,
  monthSummary,
  type SummaryRow,
} from './ledger-view';

/** A row of the block: the Ledger's own columns, so Income, Expenses and Profit line up with the table. */
function GridRow({ className, style, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid items-center gap-3 px-3', className)}
      style={{ gridTemplateColumns: LEDGER_GRID_TEMPLATE, ...style }}
      {...props}
    />
  );
}

/** An amount in its column, right-aligned; a dash when the row has nothing to say there. */
function Amount({ value, className }: { value: number | null; className?: string }) {
  return value === null ? (
    <span className="text-right text-zinc-500">—</span>
  ) : (
    <span className={cn('text-right tabular-nums', className)}>{formatIls(value)}</span>
  );
}

function SummaryRowView({ row }: { row: SummaryRow }) {
  return (
    <GridRow
      data-summary-row={row.id}
      className={cn(
        row.detail === null ? 'min-h-10' : 'min-h-14 py-1',
        row.muted && 'text-muted-foreground',
      )}
    >
      <span className="col-span-4 flex flex-col">
        <span>
          {row.label}
          {row.note !== null && <span className="text-muted-foreground"> · {row.note}</span>}
        </span>
        {row.detail !== null && (
          <span dir="auto" className="text-xs text-muted-foreground">
            {row.detail}
          </span>
        )}
      </span>
      <Amount value={row.income} />
      <Amount value={row.expenses} className="text-muted-foreground" />
      <Amount value={row.profit} />
    </GridRow>
  );
}

/**
 * The block under the Ledger's pager: what the month's jobs came to, what was paid that no job
 * carries, and the profit of the month. It is its own tinted box with its own border, so it does
 * not read as more rows of the table, and its columns sit under the table's Income, Expenses and
 * Profit. The profit on its last line is the Profit banner's.
 */
export function MonthSummary({ data }: { data: MoneyResponse }) {
  const summary = monthSummary(data);
  const profitColor = BANNER_TONE_STYLES[summary.total.tone].accent;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border, padding and a legend; this is only a named block
    <div
      role="group"
      aria-label="Month summary"
      className="mt-2.5 overflow-x-auto rounded-[10px] border border-white/[0.08] bg-white/[0.035]"
    >
      <div className="py-1" style={{ minWidth: LEDGER_MIN_WIDTH }}>
        <GridRow className="h-9 text-xs font-medium tracking-[0.04em] text-muted-foreground uppercase">
          <span className="col-span-4">{summary.title}</span>
          <span className="text-right">Income</span>
          <span className="text-right">Expenses</span>
          <span className="text-right">Profit</span>
        </GridRow>
        {summary.rows.map((row) => (
          <SummaryRowView key={row.id} row={row} />
        ))}
        <GridRow className="mt-1 min-h-[53px] border-t border-white/[0.14]">
          <span className="col-span-4 text-[15px] font-semibold">Profit this month</span>
          <span className="text-right font-semibold tabular-nums">
            {formatIls(summary.total.income)}
          </span>
          <span className="text-right font-semibold text-muted-foreground tabular-nums">
            {formatIls(summary.total.expenses)}
          </span>
          <span
            data-summary-profit=""
            className={cn('text-right text-[18px] font-bold tabular-nums', profitColor)}
          >
            {formatIls(summary.total.profit)}
          </span>
        </GridRow>
      </div>
    </div>
  );
}
