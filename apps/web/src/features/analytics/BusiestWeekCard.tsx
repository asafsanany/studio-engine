import type { AnalyticsClaudeUse, AnalyticsPeriod } from '@studio/shared';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { AnalyticsCard, NoDataYet } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { cardCopy } from './analytics-copy';
import { BudgetLegend } from './BudgetParts';
import { usdText } from './budgets-view';
import { type BusiestRow, busiestWeekView } from './busiest-week-view';
import { ChartTooltipRow } from './charts/ChartTooltipRow';
import {
  AXIS_TEXT,
  CHART_BLUE,
  CHART_ORANGE,
  CHART_RED,
  GRID_BASE,
  GRID_LINE,
} from './charts/chart-colors';

const CONFIG = {
  api: { label: 'API credits', color: CHART_BLUE },
  plan: { label: 'Max plan', color: CHART_ORANGE },
} satisfies ChartConfig;

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * "Busiest week, last 8 weeks": a pair of bars for each of the last 8 weekly windows on a 0 to
 * 100% scale. Blue is the API credits, what the app spent in the week as a share of the month's
 * credits; orange is the plan, the highest use of the weekly limit in the window. The window that
 * is not over yet is lighter and the week the limit was hit is red, with a line under the chart
 * that names that week. A window with no reading is a gap on the plan's side. In the week period
 * it is "Busiest day, last 14 days": what the app spent on each of the last 14 days, and the
 * highest use of the five-hour window, the day the limit was hit in red. The chart is the width
 * and the height of its card, and hovering a pair says its dates and both figures.
 */
export function BusiestWeekCard({
  weeks,
  budgetUsd = null,
  period = 'month',
}: {
  weeks: AnalyticsClaudeUse['busiest'];
  /** The month's credits in dollars, for the dollars the app spent in each window. */
  budgetUsd?: number | null;
  period?: AnalyticsPeriod;
}) {
  const view = busiestWeekView(weeks, period, budgetUsd);
  const byDay = period === 'week';
  return (
    <AnalyticsCard
      {...cardCopy(period).busiestWeek}
      aside={<BudgetLegend />}
      className={ANALYTICS_LAYOUT.busiestWeek}
    >
      {view.hasData ? (
        <div className="flex h-full flex-col gap-1.5">
          <div className="relative min-h-[240px] flex-1">
            <ChartContainer
              config={CONFIG}
              className="absolute inset-0 aspect-auto justify-start"
              role="img"
              aria-label={
                byDay
                  ? 'What the app spent of the credits and the plan’s peak five-hour use, for the last 14 days'
                  : 'What the app spent of the credits and the plan’s peak weekly use, for the last 8 weeks'
              }
            >
              <BarChart
                accessibilityLayer={false}
                data={view.rows}
                margin={{ top: 8, right: 14, bottom: 0, left: 0 }}
                barGap={2}
                barCategoryGap="22%"
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
                  domain={[0, 1]}
                  ticks={[0, 0.5, 1]}
                  tickFormatter={percent}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                />
                <ChartTooltip
                  cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                  content={
                    <ChartTooltipContent
                      hideIndicator
                      labelFormatter={(_, payload) =>
                        (payload[0]?.payload as BusiestRow | undefined)?.title
                      }
                      formatter={(value, name, item) => {
                        const row = item.payload as BusiestRow;
                        return name === 'api' ? (
                          <ChartTooltipRow
                            color={CHART_BLUE}
                            label="API credits"
                            value={
                              row.apiUsd === null
                                ? percent(Number(value))
                                : `${usdText(row.apiUsd)} · ${percent(Number(value))}`
                            }
                            note="of the month’s credits"
                          />
                        ) : (
                          <ChartTooltipRow
                            color={row.planColor}
                            label="Max plan"
                            value={percent(Number(value))}
                            note={
                              <>
                                {byDay ? 'peak five-hour use' : 'peak weekly use'}
                                {row.hitLimit && (
                                  <span style={{ color: CHART_RED }}> · hit the limit</span>
                                )}
                              </>
                            }
                          />
                        );
                      }}
                    />
                  }
                />
                <Bar
                  dataKey="api"
                  fill={CHART_BLUE}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                >
                  {view.rows.map((row) => (
                    <Cell key={row.id} fill={CHART_BLUE} fillOpacity={row.opacity} />
                  ))}
                </Bar>
                <Bar
                  dataKey="plan"
                  fill={CHART_ORANGE}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive={false}
                >
                  {view.rows.map((row) => (
                    <Cell key={row.id} fill={row.planColor} fillOpacity={row.opacity} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </div>
          <p className="text-xs text-muted-foreground">{view.footer}</p>
        </div>
      ) : (
        <NoDataYet />
      )}
    </AnalyticsCard>
  );
}
