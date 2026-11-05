import type { LucideIcon } from 'lucide-react';
import { Users, Wallet } from 'lucide-react';
import { ListVideo } from '@/components/icons';
import type { SummaryJob } from '@/components/shell/engine-summary';
import { hasPhoneLayout, trimmedPath } from './phone-pages';
import { appBadgeCount } from './push/app-badge';

// The rules of the phone tab bar (boards MJobs, MClients, MMoney): which tabs there are, which one a
// page belongs to, where the bar shows, and what the white badge on Jobs counts.

export type PhoneTabId = 'jobs' | 'clients' | 'money';

export interface PhoneTab {
  id: PhoneTabId;
  label: string;
  to: '/jobs' | '/clients' | '/money';
  icon: LucideIcon;
}

/** The tabs, left to right. */
export const PHONE_TABS: readonly PhoneTab[] = [
  { id: 'jobs', label: 'Jobs', to: '/jobs', icon: ListVideo },
  { id: 'clients', label: 'Clients', to: '/clients', icon: Users },
  { id: 'money', label: 'Money', to: '/money', icon: Wallet },
];

/**
 * The tabs for the viewer: all three for the admin, Jobs and Clients for an editor (Money is the
 * admin's only, Team plan TM4). The admin's is the default, so a caller that does not know is as before.
 */
export function phoneTabsFor(admin = true): readonly PhoneTab[] {
  return admin ? PHONE_TABS : PHONE_TABS.filter((tab) => tab.id !== 'money');
}

/** The tab bar's height without the home-bar inset: the 1 px rule and the 48 px of tabs. */
export const TAB_BAR_HEIGHT = 49;

/**
 * The tab a page belongs to, or `null` when it belongs to none and the bar stays away: Settings,
 * and a page that has no phone layout yet (it sits under the shell's Back header, with a series'
 * own page among them). The jobs list is Jobs; the Clients list, a client's page and its Style
 * page are Clients; Money is Money.
 */
export function activeTab(pathname: string): PhoneTabId | null {
  if (!hasPhoneLayout(pathname)) return null;
  const path = trimmedPath(pathname);
  if (path === '/' || path === '/jobs') return 'jobs';
  if (path === '/money') return 'money';
  return path.startsWith('/clients') ? 'clients' : null;
}

/**
 * Whether the bar shows on the page at `pathname`: on the top-level pages (Jobs, Clients and the
 * client pages under it, Money), not in Settings. Review and every sheet are full-screen layers that sit
 * over the bar, so they need no rule of their own.
 */
export function showsTabBar(pathname: string): boolean {
  return activeTab(pathname) !== null;
}

/**
 * The number on the Jobs tab: the jobs in Review plus those that need attention, archived ones
 * left out, as the Mac header's summary counts them and as the app icon's badge does.
 */
export function jobsTabBadge(jobs: readonly SummaryJob[] | undefined): number {
  return jobs === undefined ? 0 : appBadgeCount(jobs);
}

/** What the badge shows: the count, or "99+" for a count that would not fit the pill. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}
