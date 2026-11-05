import type { AnalyticsClaudeUse, AnalyticsPeriod } from '@studio/shared';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { AnalyticsCard } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { cardCopy } from './analytics-copy';
import { BudgetLegend } from './BudgetParts';
import { type BudgetsRow, budgetsChartView, type EndMark } from './budgets-chart-view';
import { usdText } from './budgets-view';
import { ChartTooltipRow } from './charts/ChartTooltipRow';
import {
  AMBER,
  AXIS_TEXT,
  CHART_BACKGROUND,
  CHART_BLUE,
  CHART_ORANGE,
  GRID_BASE,
  GRID_LINE,
  MARKER_LINE,
  WHITE,
} from './charts/chart-colors';

const CONFIG = {
  credits: { label: 'API credits', color: CHART_BLUE },
  plan: { label: 'Max plan', color: CHART_ORANGE },
} satisfies ChartConfig;

const CREDITS = 'API credits';
const PLAN = 'Max plan';

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** How far a label sits from its dot, by where it goes: above (default), below, or well above. */
const LABEL_DY: Record<EndMark['placement'], number> = { above: -9, below: 16, high: -24 };

/** The dot at the end of a line, with its label to the left of it. */
function End({ mark, color }: { mark: EndMark; color: string }) {
  return (
    <ReferenceDot
      x={mark.x}
      y={mark.y}
      r={4}
      fill={color}
      stroke={CHART_BACKGROUND}
      strokeWidth={0}
      ifOverflow="visible"
      label={(props: { viewBox?: { x?: number; y?: number } }) => (
        <text
          x={(props.viewBox?.x ?? 0) - 6}
          y={(props.viewBox?.y ?? 0) + LABEL_DY[mark.placement]}
          textAnchor="end"
          fontSize={11}
          fill={color}
          // A halo in the page's colour keeps the label readable where a line runs behind it.
          stroke={CHART_BACKGROUND}
          strokeWidth={3}
          paintOrder="stroke"
        >
          {mark.label}
        </text>
      )}
    />
  );
}

/**
 * "API credits and plan through the month": both budgets on one scale, the share used. Blue is the
 * app's spend added up day by day as a solid line, with a dashed line from now for where the pace
 * takes it and a mark and a date where it reaches the credits; orange is the plan's weekly limit,
 * a line for each week since it starts again at 0. The page's period switch decides the span: the
 * whole month, or, in the week period, the last 7 days. The chart is the width and the height of
 * its card, and hovering a day says what each budget stood at.
 */
export function CreditsThroughMonthCard({
  credits,
  plan,
  period = 'month',
}: {
  credits: AnalyticsClaudeUse['credits'];
  plan: AnalyticsClaudeUse['plan'];
  period?: AnalyticsPeriod;
}) {
  const view = budgetsChartView(credits, plan, period);
  const labelOf = new Map(view.xTicks.map((tick) => [tick.x, tick.label]));
  return (
    <AnalyticsCard
      {...cardCopy(period).creditsThroughMonth}
      aside={<BudgetLegend />}
      className={ANALYTICS_LAYOUT.creditsThroughMonth}
    >
      <div className="flex h-full flex-col gap-1.5">
        <div className="relative min-h-[240px] flex-1">
          <ChartContainer
            config={CONFIG}
            className="absolute inset-0 aspect-auto justify-start"
            role="img"
            aria-label={
              period === 'week'
                ? 'Share of the API credits and of the plan’s weekly limit used, for the last 7 days'
                : 'Share of the API credits and of the plan’s weekly limit used through the month'
            }
          >
            <ComposedChart
              accessibilityLayer={false}
              data={view.rows}
              margin={{ top: 8, right: 14, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} syncWithTicks stroke={GRID_LINE} />
              <XAxis
                type="number"
                dataKey="x"
                domain={view.xDomain}
                ticks={view.xTicks.map((tick) => tick.x)}
                tickFormatter={(x: number) => labelOf.get(x) ?? ''}
                tickLine={false}
                axisLine={{ stroke: GRID_BASE }}
                tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                tickMargin={6}
              />
              <YAxis
                type="number"
                domain={[0, view.yMax]}
                ticks={view.yTicks}
                tickFormatter={percent}
                tickLine={false}
                axisLine={false}
                width={44}
                tick={{ fill: AXIS_TEXT, fontSize: 11 }}
              />
              <ReferenceLine
                y={1}
                stroke={WHITE}
                strokeDasharray="3 3"
                label={{
                  value: 'All of it',
                  position: 'insideTopLeft',
                  fill: '#d4d4d8',
                  fontSize: 11,
                }}
              />
              {view.nowX !== null && (
                <ReferenceLine x={view.nowX} stroke="rgba(255,255,255,0.14)" />
              )}
              <ChartTooltip
                cursor={{ stroke: MARKER_LINE, strokeWidth: 1 }}
                content={(tooltip) => (
                  <ChartTooltipContent
                    active={tooltip.active}
                    label={tooltip.label}
                    // The credits' line first, then the plan's.
                    payload={[...(tooltip.payload ?? [])].sort(
                      (a, b) => Number(b.name === CREDITS) - Number(a.name === CREDITS),
                    )}
                    hideIndicator
                    labelFormatter={(_, payload) =>
                      (payload[0]?.payload as BudgetsRow | undefined)?.title
                    }
                    formatter={(value, name, item) => {
                      const row = item.payload as BudgetsRow;
                      return name === CREDITS ? (
                        <ChartTooltipRow
                          color={CHART_BLUE}
                          label={CREDITS}
                          value={`${usdText(row.creditsUsd ?? 0)} · ${percent(Number(value))}`}
                          note="of the month’s credits"
                        />
                      ) : (
                        <ChartTooltipRow
                          color={CHART_ORANGE}
                          label={PLAN}
                          value={percent(Number(value))}
                          note="of the weekly limit"
                        />
                      );
                    }}
                  />
                )}
              />
              {Array.from({ length: view.runs }, (_, run) => (
                <Line
                  // biome-ignore lint/suspicious/noArrayIndexKey: a week's line is its place in the month
                  key={run}
                  name={PLAN}
                  dataKey={(row: BudgetsRow) => (row.run === run ? row.plan : null)}
                  stroke={CHART_ORANGE}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  dot={false}
                  activeDot={{ r: 4, fill: CHART_ORANGE, stroke: CHART_BACKGROUND, strokeWidth: 2 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
              <Line
                name={CREDITS}
                dataKey="credits"
                stroke={CHART_BLUE}
                strokeWidth={2.5}
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 4, fill: CHART_BLUE, stroke: CHART_BACKGROUND, strokeWidth: 2 }}
                connectNulls
                isAnimationActive={false}
              />
              {view.pace !== null && (
                <ReferenceLine
                  segment={[view.pace.from, view.pace.to]}
                  stroke={CHART_BLUE}
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  ifOverflow="hidden"
                />
              )}
              {view.runOut !== null && (
                <ReferenceDot
                  x={view.runOut.x}
                  y={view.runOut.y}
                  r={4}
                  fill={AMBER}
                  strokeWidth={0}
                  ifOverflow="visible"
                  label={(props: { viewBox?: { x?: number; y?: number } }) => (
                    <text
                      x={(props.viewBox?.x ?? 0) - 6}
                      y={(props.viewBox?.y ?? 0) + 16}
                      textAnchor="end"
                      fontSize={11}
                      fill={AMBER}
                    >
                      {view.runOut?.label}
                    </text>
                  )}
                />
              )}
              {view.plan.end !== null && <End mark={view.plan.end} color={CHART_ORANGE} />}
              <End mark={view.credits.end} color={CHART_BLUE} />
            </ComposedChart>
          </ChartContainer>
        </div>
        <p className="text-xs text-muted-foreground">{view.footnote}</p>
      </div>
    </AnalyticsCard>
  );
}
