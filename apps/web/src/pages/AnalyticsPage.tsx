import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { jobsUnreachable, useAnalytics } from '@/data';
import { AnalyticsBody } from '@/features/analytics/AnalyticsBody';
import {
  ANALYTICS_SKELETON_DELAY_MS,
  AnalyticsUnreachable,
  PLAN_PROBE_RELOAD_MS,
} from '@/features/analytics/AnalyticsStates';
import { periodOfSearch, selectPeriod } from '@/features/analytics/analytics-search';
import { planReadingIsStale } from '@/features/analytics/budgets-view';
import { PeriodSwitch } from '@/features/analytics/PeriodSwitch';
import { useDelayedFlag } from '@/features/jobs/delayed-flag';

/**
 * The Analytics page: how much gets done and how long it takes (Jobs), how often the owner approves
 * first time and what their notes are about (Reviews), and what Claude use comes to (Claude use).
 * The title with the Week | Month switch at its right, then the three sections with their cards.
 * Read-only: the switch only changes how the numbers are counted (the last 7 days by day, or the
 * last 30 days by week, in the address as `?period=week`), and nothing else here can be clicked,
 * bar "Try again" when the engine cannot be reached. It only exists while the Analytics switch is
 * on (the route shows Not found otherwise). Loads like the Money page: nothing for the first
 * 300 ms, then grey placeholders of the cards' size, and "Can't reach the engine." if the first
 * load fails. Switching period keeps the page that is on screen until the other one's numbers
 * arrive.
 */
export function AnalyticsPage({
  skeletonDelayMs = ANALYTICS_SKELETON_DELAY_MS,
}: {
  /** How long the first load may take before grey placeholders appear (default 300 ms). */
  skeletonDelayMs?: number;
}) {
  const router = useRouter();
  const period = useRouterState({ select: (state) => periodOfSearch(state.location.search) });
  const { data, isError, failureCount, refetch } = useAnalytics(period);
  const unreachable = jobsUnreachable({ data, isError, failureCount });
  const showSkeleton = useDelayedFlag(data === undefined && !unreachable, skeletonDelayMs);

  // Opening the page makes the engine read the Max plan's limits in the background when the last
  // reading is stale (plan-probe.ts). That takes a few seconds, so the page asks once more a
  // little later and shows the fresh reading. Once per visit: a probe that fails is not chased.
  const planIsStale =
    data !== undefined && planReadingIsStale(data.claudeUse.plan, data.generatedAt);
  const reloadedForPlan = useRef(false);
  useEffect(() => {
    if (!planIsStale || reloadedForPlan.current) return;
    const timer = setTimeout(() => {
      reloadedForPlan.current = true;
      void refetch();
    }, PLAN_PROBE_RELOAD_MS);
    return () => clearTimeout(timer);
  }, [planIsStale, refetch]);

  return (
    <div className="flex max-w-[1400px] flex-col gap-6">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">Analytics</h1>
        <PeriodSwitch period={period} onChange={(next) => void selectPeriod(router, next)} />
      </div>
      {unreachable ? (
        <AnalyticsUnreachable onRetry={() => void refetch()} />
      ) : (
        <AnalyticsBody data={data} skeleton={showSkeleton} />
      )}
    </div>
  );
}
