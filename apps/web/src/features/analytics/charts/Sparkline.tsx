import { Area, AreaChart, XAxis, YAxis } from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { ChartTooltipRow } from './ChartTooltipRow';
import { CHART_BACKGROUND, CHART_BLUE, MARKER_LINE } from './chart-colors';
import { sparklineDomain, sparklineDotRadius } from './sparkline-layout';

/** One point of a sparkline: the week (day) it is for, in words, and its value. */
export interface SparkRow {
  id: string;
  /** What the hover card calls it: "This week", "3 weeks ago". */
  title: string;
  /** `null` for a week with nothing to say: a break in the line. */
  value: number | null;
  /** A dot on this point, like the latest one's (a tile that marks some weeks); left out: none. */
  marked?: boolean;
}

/**
 * A tile's small line over its values (weekly; daily in the week period), oldest first, with a tint
 * under it and a dot on the latest one (and on the points a row `marked`). A value with no data
 * (`null`) is a break in the line. It takes the width of its tile and is 32 px high; with no data
 * at all it draws nothing but keeps its height, so a tile does not change size when its numbers
 * arrive. Hovering it says which week (day) the point is and its value.
 */
export function Sparkline({
  rows,
  label,
  formatValue,
  color = CHART_BLUE,
}: {
  rows: readonly SparkRow[];
  /** The tile's name, for the hover card. */
  label: string;
  /** Writes a value as the hover card says it. */
  formatValue: (value: number) => string;
  color?: string;
}) {
  const config = { value: { label, color } } satisfies ChartConfig;
  const domain = sparklineDomain(rows.map((row) => row.value));
  return (
    <ChartContainer
      config={config}
      aria-hidden="true"
      className="h-8 w-full flex-none aspect-auto justify-start"
    >
      <AreaChart
        accessibilityLayer={false}
        data={[...rows]}
        margin={{ top: 3, right: 3, bottom: 3, left: 3 }}
      >
        <XAxis dataKey="id" hide padding={{ left: 0, right: 0 }} />
        <YAxis hide domain={domain} />
        <ChartTooltip
          cursor={{ stroke: MARKER_LINE, strokeWidth: 1 }}
          // Under the line, not over it, and free to leave the 32 px the chart has.
          position={{ y: 38 }}
          allowEscapeViewBox={{ x: true, y: true }}
          wrapperStyle={{ zIndex: 50 }}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_, payload) => (payload[0]?.payload as SparkRow | undefined)?.title}
              formatter={(value) => (
                <ChartTooltipRow color={color} label={label} value={formatValue(Number(value))} />
              )}
            />
          }
        />
        <Area
          dataKey="value"
          type="linear"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          fill={color}
          fillOpacity={0.15}
          connectNulls={false}
          isAnimationActive={false}
          dot={(props: { cx?: number; cy?: number; index?: number; value?: unknown }) => {
            const { cx, cy, index = 0, value } = props;
            // The latest week and a marked one have a dot; a week alone between gaps gets its own.
            const radius = sparklineDotRadius(rows, index);
            return value != null && radius > 0 && cx !== undefined && cy !== undefined ? (
              <circle key={rows[index]?.id} cx={cx} cy={cy} r={radius} fill={color} />
            ) : (
              <g key={rows[index]?.id} />
            );
          }}
          activeDot={{ r: 3, fill: color, stroke: CHART_BACKGROUND, strokeWidth: 1.5 }}
        />
      </AreaChart>
    </ChartContainer>
  );
}
