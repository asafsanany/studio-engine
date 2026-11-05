import type { AnalyticsPeriod, AnalyticsReviews } from '@studio/shared';
import { AnalyticsCard, NoDataYet } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { cardCopy } from './analytics-copy';
import {
  APPROVAL_SCALE,
  approvalLabels,
  approvalRows,
  approvalSummary,
  hasApprovals,
  percent,
} from './approved-first-time-view';
import { ValueLineChart } from './charts/ValueLineChart';

/**
 * "Approved first time, by week": the share of the jobs approved each week that were approved
 * without notes, the last 12 weeks, as a line with a dot on each week (a gap where no job was
 * approved), on a 0 to 100% axis, and one line under it that says where the share went. In the
 * week period it is "by day", the last 14 days. With no approval in the whole stretch the card
 * says "No data yet". The chart fills its card and hovering a week (day) says its share and the
 * jobs it is of.
 */
export function ApprovedFirstTimeCard({
  weeks,
  period = 'month',
}: {
  weeks: AnalyticsReviews['approvedFirstTime'];
  period?: AnalyticsPeriod;
}) {
  return (
    <AnalyticsCard
      {...cardCopy(period).approvedFirstTime}
      className={ANALYTICS_LAYOUT.approvedFirstTime}
    >
      {hasApprovals(weeks) ? (
        <div className="flex h-full min-h-0 flex-col gap-1.5">
          <ValueLineChart
            rows={approvalRows(weeks, period)}
            labels={approvalLabels(weeks, period)}
            scale={APPROVAL_SCALE}
            formatTick={percent}
            formatValue={percent}
            seriesLabel="Approved first time"
            ariaLabel={`First-time approval by ${period === 'week' ? 'day' : 'week'}`}
          />
          <p className="shrink-0 text-xs text-muted-foreground">{approvalSummary(weeks, period)}</p>
        </div>
      ) : (
        <NoDataYet />
      )}
    </AnalyticsCard>
  );
}
