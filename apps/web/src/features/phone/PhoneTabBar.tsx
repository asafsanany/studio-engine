import type { Job } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { useIsAdmin } from '@/data';
import { cn } from '@/lib/utils';
import { activeTab, badgeText, jobsTabBadge, phoneTabsFor, TAB_BAR_HEIGHT } from './phone-tabs';

/**
 * The tab bar at the bottom of the phone (boards MJobs, MClients, MMoney): Jobs, Clients and Money
 * in three equal parts (two for an editor, who has no Money), 63 px tall (the 49 px of the bar and 40% of
 * `env(safe-area-inset-bottom)`, which it brings itself). The tab the page belongs to is white and
 * the others muted (`aria-current="page"` says so to a screen reader); a client's page and its
 * Style page are Clients. Jobs carries a white badge with the number of jobs in Review or needing attention, the
 * same count as the Mac header's summary and the app icon (`jobsTabBadge`); none at 0.
 *
 * PhoneShell mounts it in its bottom slot, and it draws nothing on a page that belongs to no tab
 * (Settings, a page with no phone layout yet), so the slot is hidden there. Review and the sheets
 * are layers over the whole screen, bar included.
 */
export function PhoneTabBar({
  pathname,
  jobs,
}: {
  /** The page the shell is showing. */
  pathname: string;
  /** The live job list: `undefined` until the first load (no badge then). */
  jobs: readonly Job[] | undefined;
}) {
  const tabs = phoneTabsFor(useIsAdmin());
  const current = activeTab(pathname);
  if (current === null) return null;
  const badge = jobsTabBadge(jobs);

  return (
    <nav
      aria-label="Main"
      data-slot="phone-tab-bar"
      style={{ height: `calc(${TAB_BAR_HEIGHT}px + min(var(--safe-bottom) * 0.4, 12px))` }}
      // Equal parts, whatever their number: three for the admin, two for an editor.
      className={cn(
        'box-border grid border-t border-white/10 bg-background px-2 pb-[min(calc(var(--safe-bottom)*0.4),12px)] [-webkit-tap-highlight-color:transparent]',
        tabs.length === 2 ? 'grid-cols-2' : 'grid-cols-3',
      )}
    >
      {tabs.map((tab) => {
        const active = tab.id === current;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.id}
            to={tab.to}
            aria-current={active ? 'page' : undefined}
            data-tab={tab.id}
            className={cn(
              'flex h-12 cursor-pointer flex-col items-center justify-center gap-[3px] text-[11px] leading-[1.43] font-medium outline-none transition-colors duration-150 ease-in-out',
              active ? 'text-foreground' : 'text-muted-foreground active:text-foreground',
            )}
          >
            <span className="relative flex">
              <Icon className="size-[22px]" aria-hidden="true" />
              {tab.id === 'jobs' && badge > 0 && (
                <span
                  aria-hidden="true"
                  data-slot="phone-tab-badge"
                  className="absolute -top-[5px] -right-[11px] box-border h-[17px] min-w-[17px] rounded-full bg-foreground px-[5px] text-center text-[11px] leading-[17px] font-semibold text-background tabular-nums"
                >
                  {badgeText(badge)}
                </span>
              )}
            </span>
            <span>
              {tab.label}
              {tab.id === 'jobs' && badge > 0 && (
                <span className="sr-only">, {badge} need you</span>
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
