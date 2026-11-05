import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { type ChartConfig, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import type { AxisScale } from './axis';
import { ChartFrame } from './ChartFrame';
import { ChartTooltipRow } from './ChartTooltipRow';
import {
  AXIS_TEXT,
  CHART_BACKGROUND,
  CHART_BLUE,
  GRID_BASE,
  GRID_LINE,
  MARKER_LINE,
} from './chart-colors';

/** One point of a line: the week (day) it is for, what the hover card calls it, and its value. */
export interface LineRow {
  /** The week's (day's) first day; the row's name. */
  id: string;
  /** The hover card's heading: "Week of Oct 12 · so far". */
  title: string;
  /** `null` for a week with no data: a break in the line. */
  value: number | null;
  /** What the hover card says under the figure ("4 of 5 jobs"), if anything. */
  note?: string;
}

/**
 * A line over weeks (days) on a grid, drawn with the shadcn chart: grid lines with their values on
 * the left, the labels of the columns under it, the line (broken where a value is missing, with a
 * tint under it if asked) and a dot on each value, with a hover card that says which week it is
 * and what the value was. It is the width and the height of its card.
 */
export function ValueLineChart({
  rows,
  labels,
  scale,
  formatTick,
  formatValue,
  seriesLabel,
  ariaLabel,
  color = CHART_BLUE,
  area = false,
  dots = true,
  edges = false,
  yAxisWidth = 40,
}: {
  rows: readonly LineRow[];
  /** The text under each point; an empty string leaves that point unlabelled. Same length as `rows`. */
  labels: readonly string[];
  /** The grid lines: 0 to `max` in round steps. */
  scale: AxisScale;
  /** Writes a grid line's value as its label. */
  formatTick: (value: number) => string;
  /** Writes a value as the hover card says it. */
  formatValue: (value: number) => string;
  /** The line's name in the hover card: "Footage". */
  seriesLabel: string;
  ariaLabel: string;
  color?: string;
  /** A tint under the line. Default off. */
  area?: boolean;
  /** A dot on every value. Default on; off, a value standing alone still gets its own. */
  dots?: boolean;
  /** The first and last point sit on the edges of the plot instead of in the middle of their slots. */
  edges?: boolean;
  yAxisWidth?: number;
}) {
  const config = { value: { label: seriesLabel, color } } satisfies ChartConfig;
  const alone = (index: number) =>
    rows[index]?.value != null &&
    (rows[index - 1]?.value ?? null) === null &&
    (rows[index + 1]?.value ?? null) === null;
  return (
    <ChartFrame config={config} ariaLabel={ariaLabel}>
      <AreaChart
        accessibilityLayer={false}
        data={[...rows]}
        margin={{ top: 8, right: 14, bottom: 0, left: 0 }}
      >
        <CartesianGrid vertical={false} syncWithTicks stroke={GRID_LINE} />
        <XAxis
          dataKey="id"
          interval={0}
          padding={edges ? { left: 0, right: 0 } : undefined}
          tickFormatter={(_, index: number) => labels[index] ?? ''}
          tickLine={false}
          axisLine={{ stroke: GRID_BASE }}
          tick={{ fill: AXIS_TEXT, fontSize: 11 }}
          tickMargin={6}
        />
        <YAxis
          domain={[0, scale.max]}
          ticks={scale.ticks}
          tickFormatter={formatTick}
          tickLine={false}
          axisLine={false}
          width={yAxisWidth}
          tick={{ fill: AXIS_TEXT, fontSize: 11 }}
        />
        <ChartTooltip
          cursor={{ stroke: MARKER_LINE, strokeWidth: 1 }}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_, payload) => (payload[0]?.payload as LineRow | undefined)?.title}
              formatter={(value, _name, item) => (
                <ChartTooltipRow
                  color={color}
                  label={seriesLabel}
                  value={formatValue(Number(value))}
                  note={(item.payload as LineRow).note}
                />
              )}
            />
          }
        />
        <Area
          dataKey="value"
          type="linear"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill={color}
          fillOpacity={area ? 0.18 : 0}
          connectNulls={false}
          isAnimationActive={false}
          dot={(props: { cx?: number; cy?: number; index?: number; value?: unknown }) => {
            const { cx, cy, index = 0, value } = props;
            const shown = value != null && (dots || alone(index));
            return shown && cx !== undefined && cy !== undefined ? (
              <circle
                key={rows[index]?.id}
                cx={cx}
                cy={cy}
                r={3}
                fill={color}
                stroke={CHART_BACKGROUND}
                strokeWidth={2}
              />
            ) : (
              <g key={rows[index]?.id} />
            );
          }}
          activeDot={{ r: 4, fill: color, stroke: CHART_BACKGROUND, strokeWidth: 2 }}
        />
      </AreaChart>
    </ChartFrame>
  );
}
