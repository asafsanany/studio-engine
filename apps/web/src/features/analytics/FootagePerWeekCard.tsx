import type { AnalyticsJobs, AnalyticsPeriod } from '@studio/shared';
import { AnalyticsCard, NoDataYet } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { cardCopy } from './analytics-copy';
import { CHART_GREEN } from './charts/chart-colors';
import { ValueLineChart } from './charts/ValueLineChart';
import { footageView, tickText } from './footage-view';

/**
 * "Footage edited per week": hours of raw footage the editor went through, the last 12 weeks, as a
 * green line with a tint under it, and one plain line under it ("Doubled since August.") only when
 * it is true. In the week period it is "per day", the last 14 days. A week (day) with no data is a
 * gap in the line. The chart fills its card and hovering a week (day) says its footage. With
 * nothing recorded at all the card says "No data yet".
 */
export function FootagePerWeekCard({
  weeks,
  period = 'month',
}: {
  weeks: AnalyticsJobs['footage'];
  period?: AnalyticsPeriod;
}) {
  const view = footageView(weeks, period);
  return (
    <AnalyticsCard {...cardCopy(period).footagePerWeek} className={ANALYTICS_LAYOUT.footagePerWeek}>
      {view.hasData ? (
        <div className="flex h-full min-h-0 flex-col gap-2">
          <ValueLineChart
            rows={view.rows}
            labels={view.labels}
            scale={view.scale}
            formatTick={(value) => tickText(value, view.unit)}
            formatValue={(value) => tickText(value, view.unit)}
            seriesLabel="Footage edited"
            ariaLabel={view.ariaLabel}
            // With minutes on the axis ("40 min", "60 min") the labels are wider than "3 h".
            yAxisWidth={view.unit === 'min' ? 52 : 40}
            color={CHART_GREEN}
            area
            dots={view.dots}
            edges
          />
          {view.summary !== null && (
            <p className="shrink-0 text-xs text-muted-foreground">{view.summary}</p>
          )}
        </div>
      ) : (
        <NoDataYet />
      )}
    </AnalyticsCard>
  );
}
