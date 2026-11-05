import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  useXAxisScale,
  useYAxisScale,
  XAxis,
  YAxis,
} from 'recharts';
import { type ChartConfig, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { ChartFrame } from '@/features/analytics/charts/ChartFrame';
import { ChartTooltipRow } from '@/features/analytics/charts/ChartTooltipRow';
import { AXIS_TEXT, GRID_BASE, GRID_LINE } from '@/features/analytics/charts/chart-colors';
import {
  ENGAGEMENT_CAP,
  ENGAGEMENT_SERIES,
  ENGAGEMENT_TICKS,
  type EngagementChartView,
  type EngagementKey,
  type EngagementRow,
  engagementFigure,
  spreadNames,
} from './engagement-view';
import { OURS, OURS_BAND_OPACITY, USUAL_LINE } from './instagram-colors';

/** How far apart two names at the line ends are at least: a line of 12 px text. */
const NAME_GAP = 13;

/**
 * The series' names at the right ends of their lines, on the last reel, each on its line's end
 * and pushed apart where lines end close together. A series with no multiple there has none.
 */
function EndNames({ row }: { row: EngagementRow | undefined }) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  if (row === undefined || xScale === undefined || yScale === undefined) return null;
  const x = xScale(row.id, { position: 'middle' });
  if (x === undefined) return null;
  const ends = ENGAGEMENT_SERIES.flatMap((series) => {
    const value = row[series.key];
    const y = value === null ? undefined : yScale(value);
    return y === undefined ? [] : [{ ...series, y }];
  });
  const placed = spreadNames(
    ends.map((end) => end.y),
    NAME_GAP,
  );
  return (
    <g>
      {ends.map(({ key, label, color }, index) => (
        <text
          key={key}
          x={x + 10}
          y={(placed[index] ?? 0) + 4}
          fontSize={12}
          fill={color}
          data-series={key}
        >
          {label}
        </text>
      ))}
    </g>
  );
}

/**
 * Views, likes, comments and shares of every reel as a multiple of their usual reel, on one axis
 * (0, 1, 5, 10 and 15 times), drawn with the shadcn chart: a line for each, their names at the line
 * ends, a dashed line at 1× ("their usual reel = 1×") and a pale blue band behind each of our
 * reels. A reel with no multiple (no usual to divide by) is a break in the line. The hover card
 * says the reel (its caption) and, for each of the four, the multiple and the count. It is as wide
 * as its card and 300 px high.
 */
export function EngagementChart({ view }: { view: EngagementChartView }) {
  const config = Object.fromEntries(
    ENGAGEMENT_SERIES.map(({ key, label, color }) => [key, { label, color }]),
  ) satisfies ChartConfig;
  return (
    <ChartFrame config={config} ariaLabel={view.ariaLabel} className="min-h-[300px]">
      <ComposedChart
        accessibilityLayer={false}
        data={view.rows}
        margin={{ top: 8, right: 84, bottom: 0, left: 0 }}
        barCategoryGap={0}
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
          domain={[0, ENGAGEMENT_CAP]}
          ticks={[...ENGAGEMENT_TICKS]}
          // 0× and 1× are close together: keep both labels.
          interval={0}
          tickFormatter={(value: number) => `${value}×`}
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
                const row = payload[0]?.payload as EngagementRow | undefined;
                if (row === undefined) return undefined;
                return (
                  <span className="flex flex-col gap-0.5">
                    <span dir="auto">{row.title}</span>
                    <span className="font-normal text-muted-foreground">{row.note}</span>
                  </span>
                );
              }}
              formatter={(_value, name, item) => {
                const key = String(name) as EngagementKey;
                const series = ENGAGEMENT_SERIES.find((one) => one.key === key);
                const figure = series && engagementFigure(item.payload as EngagementRow, key);
                if (!series || !figure) return null;
                return (
                  <ChartTooltipRow
                    color={series.color}
                    label={series.label}
                    value={figure.value}
                    note={figure.note}
                  />
                );
              }}
            />
          }
        />
        {/* The bands first: a bar the height of the axis behind each of our reels. */}
        <Bar
          dataKey="band"
          name="band"
          fill={OURS}
          fillOpacity={OURS_BAND_OPACITY}
          isAnimationActive={false}
          tooltipType="none"
          legendType="none"
        />
        <ReferenceLine
          y={1}
          stroke={USUAL_LINE}
          strokeDasharray="4 4"
          label={{
            value: 'their usual reel = 1×',
            position: 'insideTopLeft',
            fill: AXIS_TEXT,
            fontSize: 11,
          }}
        />
        {ENGAGEMENT_SERIES.map(({ key, color }) => (
          <Line
            key={key}
            dataKey={key}
            name={key}
            type="linear"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            connectNulls={false}
            isAnimationActive={false}
            dot={{ r: 2.5, fill: color, stroke: color }}
            activeDot={{ r: 4, fill: color, stroke: color }}
          />
        ))}
        <EndNames row={view.rows.at(-1)} />
      </ComposedChart>
    </ChartFrame>
  );
}
