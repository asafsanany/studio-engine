import type { AnalyticsPeriod, AnalyticsReviews } from '@studio/shared';
import { AnalyticsCard, NoDataYet } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { cardCopy } from './analytics-copy';
import { approvalLabels } from './approved-first-time-view';
import { scaleFor } from './charts/axis';
import { ValueLineChart } from './charts/ValueLineChart';
import { hasReruns, rerunRows, rerunSummary, reruns } from './rerun-view';

/**
 * "Re-runs per approved job, by week": the median number of re-runs (rounds of notes) of the jobs
 * approved each week, the last 12 weeks (14 days in the week period), as a line with a dot on each
 * week and a gap where no job was approved. The chart fills its card and hovering a week (day) says
 * its median and the jobs it is of. With no approval the card says "No data yet".
 */
export function RerunsPerApprovedCard({
  weeks,
  period = 'month',
}: {
  weeks: AnalyticsReviews['approvedFirstTime'];
  period?: AnalyticsPeriod;
}) {
  const rows = rerunRows(weeks, period);
  return (
    <AnalyticsCard
      {...cardCopy(period).rerunsPerApproved}
      className={ANALYTICS_LAYOUT.rerunsPerApproved}
    >
      {hasReruns(weeks) ? (
        <div className="flex h-full min-h-0 flex-col gap-1.5">
          <ValueLineChart
            rows={rows}
            labels={approvalLabels(weeks, period)}
            scale={scaleFor(
              rows.map((row) => row.value),
              {},
            )}
            formatTick={reruns}
            formatValue={reruns}
            seriesLabel="Median re-runs"
            ariaLabel={`Median re-runs per approved job by ${period === 'week' ? 'day' : 'week'}`}
          />
          <p className="shrink-0 text-xs text-muted-foreground">{rerunSummary(weeks)}</p>
        </div>
      ) : (
        <NoDataYet />
      )}
    </AnalyticsCard>
  );
}
