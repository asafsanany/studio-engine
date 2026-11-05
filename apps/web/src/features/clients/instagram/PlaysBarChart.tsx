import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from 'recharts';
import { type ChartConfig, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { ChartFrame } from '@/features/analytics/charts/ChartFrame';
import { ChartTooltipRow } from '@/features/analytics/charts/ChartTooltipRow';
import {
  AXIS_TEXT,
  CHART_BACKGROUND,
  GRID_BASE,
  GRID_LINE,
} from '@/features/analytics/charts/chart-colors';
import { OURS, THEIRS } from './instagram-colors';
import { compactText, countText } from './instagram-text';
import type { PlaysChartView, PlaysRow } from './plays-view';

/**
 * The room recharts leaves on each side of a bar, as a share of its slot. The board's bars are 65%
 * of their slot (32 px of 49 at 22 reels and 1440 px): 17% on each side leaves 66%, which recharts
 * rounds down to whole pixels (17.5% would draw 31 px). Not "30%" for a 30% gap: that is the room
 * on each side, which left bars of 40% of the slot (19 px).
 */
export const BAR_CATEGORY_GAP = '17%';

/** The widest a bar gets, so that a client with few reels does not have a few huge ones. */
export const MAX_BAR_WIDTH = 40;

/**
 * One bar for each reel of the range, oldest first, on a grid drawn with the shadcn chart (the same
 * as the Analytics page's): ours in blue, theirs in grey, the month's name under the first reel of
 * it, a dashed line at the typical reel of each side with its words at the right, and a hover card
 * that says which reel it is (its caption) and its plays. It is as wide as its card and 240 px high.
 */
export function PlaysBarChart({ view }: { view: PlaysChartView }) {
  const config = { plays: { label: 'Plays', color: OURS } } satisfies ChartConfig;
  return (
    <ChartFrame config={config} ariaLabel={view.ariaLabel}>
      <BarChart
        accessibilityLayer={false}
        data={view.rows}
        margin={{ top: 8, right: 14, bottom: 0, left: 0 }}
        barCategoryGap={BAR_CATEGORY_GAP}
      >
        <CartesianGrid vertical={false} syncWithTicks stroke={GRID_LINE} />
        <XAxis
          dataKey="id"
          interval={0}
          tickFormatter={(_, index: number) => view.labels[index] ?? ''}
          tickLine={false}
          axisLine={{ stroke: GRID_BASE }}
          tick={{ fill: AXIS_TEXT, fontSize: 11 }}
          tickMargin={6}
        />
        <YAxis
          domain={[0, view.scale.max]}
          ticks={view.scale.ticks}
          tickFormatter={compactText}
          tickLine={false}
          axisLine={false}
          width={40}
          tick={{ fill: AXIS_TEXT, fontSize: 11 }}
        />
        <ChartTooltip
          cursor={{ fill: 'rgba(255,255,255,0.06)' }}
          content={
            <ChartTooltipContent
              hideIndicator
              className="max-w-[320px]"
              labelFormatter={(_, payload) => {
                const row = payload[0]?.payload as PlaysRow | undefined;
                return row === undefined ? undefined : <span dir="auto">{row.title}</span>;
              }}
              formatter={(value, _name, item) => {
                const row = item.payload as PlaysRow;
                return (
                  <ChartTooltipRow
                    color={row.ours ? OURS : THEIRS}
                    label="Plays"
                    value={countText(Number(value))}
                    note={row.note}
                  />
                );
              }}
            />
          }
        />
        <Bar
          dataKey="plays"
          name="plays"
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
          maxBarSize={MAX_BAR_WIDTH}
        >
          {view.rows.map((row) => (
            <Cell key={row.id} fill={row.ours ? OURS : THEIRS} />
          ))}
        </Bar>
        {view.lines.map((line) => (
          <ReferenceLine
            key={line.text}
            y={line.value}
            stroke={line.color}
            strokeWidth={1.5}
            strokeDasharray="4 4"
            ifOverflow="extendDomain"
            label={{
              value: line.text,
              position: 'insideTopRight',
              fill: line.color,
              fontSize: 11,
              // A halo in the page's colour keeps the words readable over the bars they cross.
              stroke: CHART_BACKGROUND,
              strokeWidth: 3,
              paintOrder: 'stroke',
            }}
          />
        ))}
      </BarChart>
    </ChartFrame>
  );
}
