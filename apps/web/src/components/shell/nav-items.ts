import {
  CaseSensitive,
  ChartColumn,
  type LucideIcon,
  MessageCircle,
  Palette,
  Send,
  Shapes,
  UserRoundCog,
  Users,
  Wallet,
} from 'lucide-react';
import { ListVideo, Settings } from '@/components/icons';

interface NavItemBase {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Pinned to the bottom of the nav (Settings). */
  bottom?: boolean;
}

/** A page that exists (Jobs, Clients, Graphics, LUTs, Fonts, Money, Analytics, Team, Settings): it has an address. */
export interface PageNavItem extends NavItemBase {
  enabled: true;
  to:
    | '/jobs'
    | '/clients'
    | '/graphics'
    | '/luts'
    | '/fonts'
    | '/dms'
    | '/money'
    | '/analytics'
    | '/settings/team'
    | '/settings';
}

/** A placeholder for a later phase: it goes nowhere. */
export interface FutureNavItem extends NavItemBase {
  enabled: false;
}

export type NavItem = PageNavItem | FutureNavItem;

/** The sidebar navigation, top to bottom. Icons are final (design canvas). */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'jobs', label: 'Jobs', icon: ListVideo, enabled: true, to: '/jobs' },
  { key: 'clients', label: 'Clients', icon: Users, enabled: true, to: '/clients' },
  { key: 'deliveries', label: 'Deliveries', icon: Send, enabled: false },
  { key: 'money', label: 'Money', icon: Wallet, enabled: true, to: '/money' },
  { key: 'analytics', label: 'Analytics', icon: ChartColumn, enabled: false },
  // The admin's only (ADMIN_ONLY_NAV_KEYS): who is on the team and which clients each editor sees.
  { key: 'team', label: 'Team', icon: UserRoundCog, enabled: true, to: '/settings/team' },
  // The admin's only: the feature switches (Graphics, Fonts, LUTs).
  {
    key: 'settings',
    label: 'Settings',
    icon: Settings,
    enabled: true,
    to: '/settings',
    bottom: true,
  },
];

/**
 * Analytics once its switch is on: the page exists. While the switch is off the Analytics item in
 * {@link NAV_ITEMS} stays the disabled "coming in a later phase" one.
 */
export const ANALYTICS_NAV_ITEM: PageNavItem = {
  key: 'analytics',
  label: 'Analytics',
  icon: ChartColumn,
  enabled: true,
  to: '/analytics',
};

/**
 * Graphics once its switch is on (Graphics plan): a page of its own, right after Clients. While
 * the switch is off there is no Graphics item at all.
 */
export const GRAPHICS_NAV_ITEM: PageNavItem = {
  key: 'graphics',
  label: 'Graphics',
  icon: Shapes,
  enabled: true,
  to: '/graphics',
};

/**
 * LUTs once its switch is on (LUTs plan): a page of its own, right after Graphics (after Clients
 * when Graphics is off). While the switch is off there is no LUTs item at all.
 */
export const LUTS_NAV_ITEM: PageNavItem = {
  key: 'luts',
  label: 'LUTs',
  icon: Palette,
  enabled: true,
  to: '/luts',
};

/**
 * Fonts once its switch is on (Fonts plan): a page of its own, right after LUTs (after Graphics
 * when LUTs is off, after Clients when both are). While the switch is off there is no Fonts item
 * at all.
 */
export const FONTS_NAV_ITEM: PageNavItem = {
  key: 'fonts',
  label: 'Fonts',
  icon: CaseSensitive,
  enabled: true,
  to: '/fonts',
};

/**
 * The Instagram DMs page once the engine has it (`/api/health` says `dms`): a page of its own,
 * after the library pages (Graphics, LUTs, Fonts), so right after Clients when they are off.
 */
export const DMS_NAV_ITEM: PageNavItem = {
  key: 'dms',
  label: 'DMs',
  icon: MessageCircle,
  enabled: true,
  to: '/dms',
};

/**
 * The pages only the admin has (Team plan, TM4): money, how the studio does, the graphics library,
 * the LUTs, the fonts, the team and the settings. An editor's sidebar leaves them out and their addresses lead
 * to Jobs. A page that is added later is gated by adding its key here.
 */
export const ADMIN_ONLY_NAV_KEYS: ReadonlySet<string> = new Set([
  'money',
  'analytics',
  'graphics',
  'team',
  'fonts',
  'luts',
  'dms',
  'settings',
]);

/**
 * Whether the page at `pathname` is one only the admin has (`/money`, `/analytics/…`, `/graphics/…`,
 * `/team`, `/settings`…). That is the Mac's pages: on the phone `/settings` is a page of its own,
 * for everyone.
 */
export function isAdminOnlyPath(pathname: string): boolean {
  return ADMIN_ONLY_NAV_KEYS.has(sectionOf(pathname));
}

/**
 * The nav key of the page at `pathname`: its first segment, except the Team page, which lives under
 * /settings (`/settings/team` is `team`; `/settings` on its own is `settings`).
 */
function sectionOf(pathname: string): string {
  const [first = '', second] = pathname.split('/').slice(1);
  return first === 'settings' && second === 'team' ? 'team' : first;
}

/**
 * The sidebar navigation for the switches as they are now: {@link NAV_ITEMS}, with Analytics a
 * page of its own while the Analytics switch is on, Graphics after Clients while the Graphics
 * switch is on, LUTs after those while the LUTs switch is on, and Fonts after those while the
 * Fonts switch is on. With all off it is NAV_ITEMS itself. For anyone but the admin (`admin: false`, which is also what it is until the engine has
 * said who is asking) the admin-only pages are left out ({@link ADMIN_ONLY_NAV_KEYS}).
 */
export function navItemsFor({
  analytics,
  graphics = false,
  luts = false,
  fonts = false,
  dms = false,
  admin = true,
}: {
  analytics: boolean;
  graphics?: boolean;
  luts?: boolean;
  fonts?: boolean;
  dms?: boolean;
  admin?: boolean;
}): readonly NavItem[] {
  const items =
    !analytics && !graphics && !luts && !fonts && !dms
      ? NAV_ITEMS
      : NAV_ITEMS.flatMap((item) => {
          const shown =
            analytics && item.key === ANALYTICS_NAV_ITEM.key ? ANALYTICS_NAV_ITEM : item;
          if (item.key !== 'clients') return [shown];
          return [
            shown,
            ...(graphics ? [GRAPHICS_NAV_ITEM] : []),
            ...(luts ? [LUTS_NAV_ITEM] : []),
            ...(fonts ? [FONTS_NAV_ITEM] : []),
            ...(dms ? [DMS_NAV_ITEM] : []),
          ];
        });
  return admin ? items : items.filter((item) => !ADMIN_ONLY_NAV_KEYS.has(item.key));
}

/**
 * The nav item the page at `pathname` belongs to: Clients for /clients and everything below it,
 * Graphics for /graphics and everything below it (when `items` has it), LUTs for /luts (likewise),
 * Fonts for /fonts (likewise), Money for /money, Team for /settings/team, Settings for /settings,
 * Analytics for /analytics (when `items` has it as a page), Jobs for / and /jobs. A path that is none of these (a page that does not exist) belongs to no item. `items`
 * is the navigation as it is now ({@link navItemsFor}); default {@link NAV_ITEMS}.
 */
export function navItemForPath(
  pathname: string,
  items: readonly NavItem[] = NAV_ITEMS,
): NavItem | undefined {
  const section = sectionOf(pathname);
  const key = section === '' ? 'jobs' : section;
  return items.find((item) => item.enabled && item.key === key);
}

/**
 * Tooltip of a disabled (future) nav item. On the icon rail the label is not visible, so the
 * tooltip repeats it.
 */
export function comingSoonTooltip(label: string, iconRail: boolean): string {
  return iconRail ? `${label} · coming in a later phase` : 'Coming in a later phase';
}

/** Accessible name of a disabled nav item (visible label plus why it does nothing). */
export function comingSoonLabel(label: string): string {
  return `${label} (coming in a later phase)`;
}
