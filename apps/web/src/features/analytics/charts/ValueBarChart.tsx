import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { type ChartConfig, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import type { AxisScale } from './axis';
import { ChartFrame } from './ChartFrame';
import { ChartTooltipRow } from './ChartTooltipRow';
import { AXIS_TEXT, CHART_BLUE, GRID_BASE, GRID_LINE } from './chart-colors';
import type { LineRow } from './ValueLineChart';

/**
 * A bar for each week (day) on a grid, drawn with the shadcn chart: grid lines with their values on
 * the left, the labels of the columns under it, the top corners of each bar rounded, and a hover
 * card that says which week it is and what the value was. A value of `null` is no bar. It is the
 * width and the height of its card.
 */
export function ValueBarChart({
  rows,
  labels,
  scale,
  formatTick,
  formatValue,
  seriesLabel,
  ariaLabel,
  color = CHART_BLUE,
  yAxisWidth = 32,
}: {
  rows: readonly LineRow[];
  /** The text under each bar; an empty string leaves that bar unlabelled. Same length as `rows`. */
  labels: readonly string[];
  /** The grid lines: 0 to `max` in round steps. */
  scale: AxisScale;
  formatTick: (value: number) => string;
  /** Writes a value as the hover card says it. */
  formatValue: (value: number) => string;
  /** The bars' name in the hover card: "Jobs delivered". */
  seriesLabel: string;
  ariaLabel: string;
  color?: string;
  yAxisWidth?: number;
}) {
  const config = { value: { label: seriesLabel, color } } satisfies ChartConfig;
  return (
    <ChartFrame config={config} ariaLabel={ariaLabel}>
      <BarChart
        accessibilityLayer={false}
        data={[...rows]}
        margin={{ top: 8, right: 14, bottom: 0, left: 0 }}
        barCategoryGap="22%"
      >
        <CartesianGrid vertical={false} syncWithTicks stroke={GRID_LINE} />
        <XAxis
          dataKey="id"
          interval={0}
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
          cursor={{ fill: 'rgba(255,255,255,0.06)' }}
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
        <Bar
          dataKey="value"
          fill={color}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
          maxBarSize={28}
        />
      </BarChart>
    </ChartFrame>
  );
}
