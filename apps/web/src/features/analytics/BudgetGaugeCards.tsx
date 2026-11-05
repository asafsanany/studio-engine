import type { AnalyticsClaudeUse } from '@studio/shared';
import { AnalyticsCard } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { ANALYTICS_CARDS } from './analytics-copy';
import { FiveHourBar, GaugeLayout, GaugeWithTick, StatRow, StatusChip } from './BudgetParts';
import { creditsView, planView } from './budgets-view';
import { CHART_BLUE, CHART_ORANGE } from './charts/chart-colors';

/**
 * "API credits": the $200 a month the app's own runs are paid from. A half-circle gauge of the
 * share used, with a white tick for how much of the month has gone; beside it what is left (in
 * first passes), the spend per day, and where that pace takes the month. The chip says "Spending
 * fast" when the pace runs the credits out before the month ends. Always the current calendar
 * month, whatever period the page is set to.
 */
export function ApiCreditsCard({ credits }: { credits: AnalyticsClaudeUse['credits'] }) {
  const view = creditsView(credits);
  return (
    <AnalyticsCard
      title={ANALYTICS_CARDS.apiCredits.title}
      subtitle={view.subtitle}
      aside={view.chip === null ? undefined : <StatusChip chip={view.chip} />}
      className={ANALYTICS_LAYOUT.apiCredits}
    >
      <GaugeLayout
        gauge={<GaugeWithTick gauge={view.gauge} color={CHART_BLUE} />}
        stats={view.stats.map((stat) => <StatRow key={stat.label} stat={stat} />)}
      />
    </AnalyticsCard>
  );
}

/**
 * "Max plan, this week": the plan the owner's Claude Code sessions run on. A gauge of the weekly limit
 * with a white tick for how much of the 7 days has gone; beside it the five-hour window, what the
 * sessions would have cost at the API this week, and when the plan was last read. "Near the limit"
 * from 80%. With no reading for the week the gauge is empty and says so. Always the current
 * window, whatever period the page is set to.
 */
export function MaxPlanCard({
  plan,
  generatedAt,
  timeZone,
}: {
  plan: AnalyticsClaudeUse['plan'];
  generatedAt: string;
  timeZone: string;
}) {
  const view = planView(plan, generatedAt, timeZone);
  return (
    <AnalyticsCard
      title={ANALYTICS_CARDS.maxPlan.title}
      subtitle={view.subtitle}
      aside={view.chip === null ? undefined : <StatusChip chip={view.chip} />}
      className={ANALYTICS_LAYOUT.maxPlan}
    >
      <GaugeLayout
        gauge={<GaugeWithTick gauge={view.gauge} color={CHART_ORANGE} />}
        stats={
          <>
            {view.fiveHour !== null && (
              <FiveHourBar
                percent={view.fiveHour.percent}
                share={view.fiveHour.share}
                color={CHART_ORANGE}
              />
            )}
            {view.stats.map((stat) => (
              <StatRow key={stat.label} stat={stat} />
            ))}
          </>
        }
      />
    </AnalyticsCard>
  );
}
