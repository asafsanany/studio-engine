import { countEngine, type SummaryJob } from '@/components/shell/engine-summary';

/**
 * The count on the app icon: the jobs that need the owner, in Review or needing attention (archived
 * ones left out), the same as the Mac header's summary and as the engine's pushes carry it.
 */
export function appBadgeCount(jobs: readonly SummaryJob[]): number {
  const counts = countEngine(jobs);
  return counts.review + counts.attention;
}

/** The Badging API (`navigator.setAppBadge`), where the browser has it. */
export interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * Puts `count` on the app icon, or clears it at 0. Never fails: a browser without badges, or
 * without the notification permission iOS asks for, leaves the icon as it is.
 */
export async function showAppBadge(nav: BadgeNavigator, count: number): Promise<void> {
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    // Not allowed or not there: nothing to do.
  }
}
