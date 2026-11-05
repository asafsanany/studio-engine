import type { ReactNode } from 'react';
import type { Chip, ChipTone, Stat } from './budgets-view';
import { AMBER, CHART_BLUE, CHART_ORANGE, TRACK, WHITE } from './charts/chart-colors';
import { Gauge } from './charts/Gauge';

// The parts the two gauge cards share: the status chip, the gauge with the line under it, and the
// column of figures beside it.

const CHIP_COLORS: Record<ChipTone, { color: string; background: string }> = {
  warn: { color: AMBER, background: 'rgba(245,158,11,0.14)' },
  bad: { color: '#f87171', background: 'rgba(248,113,113,0.14)' },
  good: { color: '#34d399', background: 'rgba(52,211,153,0.14)' },
};

/** The small tinted word at the right of a card's title: "Spending fast", "Near the limit". */
export function StatusChip({ chip }: { chip: Chip }) {
  const colors = CHIP_COLORS[chip.tone];
  return (
    <span
      data-tone={chip.tone}
      className="inline-flex h-[22px] flex-none items-center rounded-md px-2 text-xs font-medium"
      style={colors}
    >
      {chip.label}
    </span>
  );
}

/** The gauge with "79% of the month gone" and its white tick under it. */
export function GaugeWithTick({
  gauge,
  color,
}: {
  gauge: {
    percent: string;
    caption: string;
    used: number;
    tick: number | null;
    tickLabel: string | null;
    ariaLabel: string;
  };
  color: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Gauge
        used={gauge.used}
        tick={gauge.tick}
        color={color}
        percent={gauge.percent}
        caption={gauge.caption}
        ariaLabel={gauge.ariaLabel}
      />
      {gauge.tickLabel !== null && (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className="h-3 w-[3px] rounded-[2px]"
            style={{ background: WHITE }}
          />
          {gauge.tickLabel}
        </span>
      )}
    </div>
  );
}

/** A figure beside a gauge: its small label, the figure in semibold and a note under it. */
export function StatRow({ stat }: { stat: Stat }) {
  return (
    <div className="flex flex-col gap-px border-t py-2">
      <span className="text-xs text-muted-foreground">{stat.label}</span>
      <span className="font-semibold tabular-nums" style={{ color: stat.warn ? AMBER : undefined }}>
        {stat.value}
      </span>
      {stat.note !== null && stat.note !== '' && (
        <span className="text-xs text-muted-foreground">{stat.note}</span>
      )}
    </div>
  );
}

/** The five-hour window: its name and figure, and a bar under them. */
export function FiveHourBar({
  percent,
  share,
  color,
}: {
  percent: string;
  share: number;
  color: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-t py-2">
      <div className="flex justify-between">
        <span className="text-xs text-muted-foreground">Five-hour window</span>
        <span className="text-xs tabular-nums">{percent}</span>
      </div>
      <div
        role="img"
        aria-label={`Five-hour window used: ${percent}`}
        className="h-1.5 rounded-[3px]"
        style={{ background: TRACK }}
      >
        <div
          className="h-1.5 min-w-[3px] rounded-[3px]"
          style={{ width: `${Math.min(100, Math.max(0, share * 100))}%`, background: color }}
        />
      </div>
    </div>
  );
}

/**
 * The key of a chart that draws both budgets: a blue dot for the API credits, an orange one for the
 * Max plan, the same colours as the gauges and the lists.
 */
export function BudgetLegend() {
  return (
    <ul className="flex flex-none items-center gap-3.5 text-xs text-muted-foreground">
      {[
        { label: 'API credits', color: CHART_BLUE },
        { label: 'Max plan', color: CHART_ORANGE },
      ].map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2 rounded-full"
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** The gauge on the left and its figures on the right; one under the other when the card is narrow. */
export function GaugeLayout({ gauge, stats }: { gauge: ReactNode; stats: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-6 min-[640px]:grid-cols-[240px_minmax(0,1fr)] min-[1000px]:max-[1199px]:grid-cols-1 [&>*]:min-w-0">
      {gauge}
      <div className="flex flex-col">{stats}</div>
    </div>
  );
}
