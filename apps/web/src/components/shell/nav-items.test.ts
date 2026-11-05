import { describe, expect, it } from 'vitest';
import {
  ADMIN_ONLY_NAV_KEYS,
  ANALYTICS_NAV_ITEM,
  comingSoonLabel,
  comingSoonTooltip,
  DMS_NAV_ITEM,
  FONTS_NAV_ITEM,
  GRAPHICS_NAV_ITEM,
  isAdminOnlyPath,
  LUTS_NAV_ITEM,
  NAV_ITEMS,
  navItemForPath,
  navItemsFor,
} from './nav-items';

describe('NAV_ITEMS', () => {
  it('lists Jobs, Clients, Deliveries, Money, Analytics, Team and Settings in order', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Jobs',
      'Clients',
      'Deliveries',
      'Money',
      'Analytics',
      'Team',
      'Settings',
    ]);
  });

  it('enables Jobs, Clients, Money, Team and Settings, each with its address; the other two are future pages', () => {
    const pages = NAV_ITEMS.filter((item) => item.enabled);
    expect(pages.map((item) => [item.label, item.to])).toEqual([
      ['Jobs', '/jobs'],
      ['Clients', '/clients'],
      ['Money', '/money'],
      ['Team', '/settings/team'],
      ['Settings', '/settings'],
    ]);
    expect(NAV_ITEMS.filter((item) => !item.enabled).map((item) => item.label)).toEqual([
      'Deliveries',
      'Analytics',
    ]);
  });

  it('pins only Settings to the bottom', () => {
    expect(NAV_ITEMS.filter((item) => item.bottom).map((item) => item.label)).toEqual(['Settings']);
  });

  it('gives every item its Lucide icon', () => {
    const names = Object.fromEntries(
      NAV_ITEMS.map((item) => [item.label, (item.icon as { displayName?: string }).displayName]),
    );
    expect(names).toEqual({
      Jobs: 'ListVideo',
      Clients: 'Users',
      Deliveries: 'Send',
      Money: 'Wallet',
      Analytics: 'ChartColumn',
      Team: 'UserRoundCog',
      Settings: 'Settings',
    });
  });
});

describe('navItemForPath', () => {
  const label = (path: string) => navItemForPath(path)?.label;

  it('puts / and /jobs under Jobs', () => {
    expect(label('/')).toBe('Jobs');
    expect(label('/jobs')).toBe('Jobs');
  });

  it('puts /clients and every page below it under Clients', () => {
    expect(label('/clients')).toBe('Clients');
    expect(label('/clients/4d337086919d')).toBe('Clients');
    expect(label('/clients/4d337086919d/style')).toBe('Clients');
  });

  it('puts /money under Money', () => {
    expect(label('/money')).toBe('Money');
    expect(navItemForPath('/money')).toMatchObject({ enabled: true, to: '/money' });
  });

  it('puts /settings/team under Team, and /settings on its own under Settings', () => {
    expect(label('/settings/team')).toBe('Team');
    expect(label('/settings')).toBe('Settings');
  });

  it('puts a page that does not exist, or has not been built, under nothing', () => {
    expect(label('/nowhere')).toBeUndefined();
    expect(label('/deliveries')).toBeUndefined();
    expect(label('/clientsish')).toBeUndefined();
  });
});

describe('navItemsFor: Analytics follows its switch', () => {
  it('is NAV_ITEMS itself while the switch is off: Analytics stays the disabled item', () => {
    const items = navItemsFor({ analytics: false });
    expect(items).toBe(NAV_ITEMS);
    expect(items.find((item) => item.key === 'analytics')).toMatchObject({ enabled: false });
  });

  it('makes Analytics a page of its own, at /analytics, while the switch is on', () => {
    const items = navItemsFor({ analytics: true });
    expect(items.find((item) => item.key === 'analytics')).toBe(ANALYTICS_NAV_ITEM);
    expect(ANALYTICS_NAV_ITEM).toMatchObject({
      label: 'Analytics',
      enabled: true,
      to: '/analytics',
    });
  });

  it('keeps every item in its place, with the same icon, and only changes Analytics', () => {
    const on = navItemsFor({ analytics: true });
    expect(on.map((item) => item.label)).toEqual(NAV_ITEMS.map((item) => item.label));
    expect(on.map((item) => item.enabled)).toEqual([true, true, false, true, true, true, true]);
    expect(ANALYTICS_NAV_ITEM.icon).toBe(NAV_ITEMS.find((item) => item.key === 'analytics')?.icon);
    for (const item of on.filter((i) => i.key !== 'analytics')) {
      expect(item).toBe(NAV_ITEMS.find((candidate) => candidate.key === item.key));
    }
  });

  it('does not touch NAV_ITEMS', () => {
    navItemsFor({ analytics: true });
    expect(NAV_ITEMS.find((item) => item.key === 'analytics')).toMatchObject({ enabled: false });
  });
});

describe('navItemForPath with Analytics', () => {
  it('puts /analytics under Analytics while its switch is on', () => {
    const items = navItemsFor({ analytics: true });
    expect(navItemForPath('/analytics', items)).toBe(ANALYTICS_NAV_ITEM);
  });

  it('puts /analytics under nothing while the switch is off: the page is Not found', () => {
    expect(navItemForPath('/analytics')).toBeUndefined();
    expect(navItemForPath('/analytics', navItemsFor({ analytics: false }))).toBeUndefined();
  });

  it('leaves the other pages where they were', () => {
    const items = navItemsFor({ analytics: true });
    expect(navItemForPath('/money', items)?.label).toBe('Money');
    expect(navItemForPath('/clients/4d337086919d', items)?.label).toBe('Clients');
    expect(navItemForPath('/', items)?.label).toBe('Jobs');
  });
});

describe('navItemsFor: Graphics follows its switch', () => {
  it('has no Graphics item while the switch is off', () => {
    expect(navItemsFor({ analytics: false, graphics: false })).toBe(NAV_ITEMS);
    expect(navItemsFor({ analytics: false }).some((item) => item.key === 'graphics')).toBe(false);
    expect(
      navItemsFor({ analytics: true, graphics: false }).some((item) => item.key === 'graphics'),
    ).toBe(false);
  });

  it('puts Graphics right after Clients while the switch is on, a page at /graphics', () => {
    const items = navItemsFor({ analytics: false, graphics: true });
    expect(items.map((item) => item.label)).toEqual([
      'Jobs',
      'Clients',
      'Graphics',
      'Deliveries',
      'Money',
      'Analytics',
      'Team',
      'Settings',
    ]);
    expect(GRAPHICS_NAV_ITEM).toMatchObject({ label: 'Graphics', enabled: true, to: '/graphics' });
    expect((GRAPHICS_NAV_ITEM.icon as { displayName?: string }).displayName).toBe('Shapes');
    expect(items.find((item) => item.key === 'analytics')).toMatchObject({ enabled: false });
  });

  it('goes with Analytics on as well', () => {
    const items = navItemsFor({ analytics: true, graphics: true });
    expect(items.map((item) => item.key)).toEqual([
      'jobs',
      'clients',
      'graphics',
      'deliveries',
      'money',
      'analytics',
      'team',
      'settings',
    ]);
    expect(items.find((item) => item.key === 'analytics')).toBe(ANALYTICS_NAV_ITEM);
  });

  it('puts /graphics and every page below it under Graphics while the switch is on', () => {
    const items = navItemsFor({ analytics: false, graphics: true });
    expect(navItemForPath('/graphics', items)).toBe(GRAPHICS_NAV_ITEM);
    expect(navItemForPath('/graphics/new', items)).toBe(GRAPHICS_NAV_ITEM);
    expect(navItemForPath('/graphics/3f9a1c2b7d4e', items)).toBe(GRAPHICS_NAV_ITEM);
    expect(navItemForPath('/graphics', navItemsFor({ analytics: false }))).toBeUndefined();
  });
});

describe('navItemsFor: LUTs follows its switch', () => {
  it('has no LUTs item while the switch is off', () => {
    expect(navItemsFor({ analytics: false, graphics: false, luts: false })).toBe(NAV_ITEMS);
    expect(
      navItemsFor({ analytics: true, graphics: true }).some((item) => item.key === 'luts'),
    ).toBe(false);
  });

  it('puts LUTs right after Clients while the switch is on, a page at /luts', () => {
    const items = navItemsFor({ analytics: false, luts: true });
    expect(items.map((item) => item.label)).toEqual([
      'Jobs',
      'Clients',
      'LUTs',
      'Deliveries',
      'Money',
      'Analytics',
      'Team',
      'Settings',
    ]);
    expect(LUTS_NAV_ITEM).toMatchObject({ label: 'LUTs', enabled: true, to: '/luts' });
    expect((LUTS_NAV_ITEM.icon as { displayName?: string }).displayName).toBe('Palette');
  });

  it('puts LUTs after Graphics when both are on, with Analytics on as well', () => {
    const items = navItemsFor({ analytics: true, graphics: true, luts: true });
    expect(items.map((item) => item.key)).toEqual([
      'jobs',
      'clients',
      'graphics',
      'luts',
      'deliveries',
      'money',
      'analytics',
      'team',
      'settings',
    ]);
    expect(items.find((item) => item.key === 'analytics')).toBe(ANALYTICS_NAV_ITEM);
  });

  it('puts /luts under LUTs while the switch is on', () => {
    const items = navItemsFor({ analytics: false, luts: true });
    expect(navItemForPath('/luts', items)).toBe(LUTS_NAV_ITEM);
    expect(navItemForPath('/luts', navItemsFor({ analytics: false }))).toBeUndefined();
  });
});

describe('navItemsFor: DMs follows the engine', () => {
  it('has no DMs item while the engine has no DMs page', () => {
    expect(navItemsFor({ analytics: false, dms: false })).toBe(NAV_ITEMS);
    expect(navItemsFor({ analytics: true, fonts: true }).some((item) => item.key === 'dms')).toBe(
      false,
    );
  });

  it('puts DMs right after Clients, a page at /dms with the message icon', () => {
    const items = navItemsFor({ analytics: false, dms: true });
    expect(items.map((item) => item.label).slice(0, 4)).toEqual([
      'Jobs',
      'Clients',
      'DMs',
      'Deliveries',
    ]);
    expect(DMS_NAV_ITEM).toMatchObject({ label: 'DMs', enabled: true, to: '/dms' });
    expect((DMS_NAV_ITEM.icon as { displayName?: string }).displayName).toBe('MessageCircle');
    expect(navItemForPath('/dms', items)).toBe(DMS_NAV_ITEM);
  });

  it('puts DMs after the library pages when they are on', () => {
    const items = navItemsFor({
      analytics: true,
      graphics: true,
      luts: true,
      fonts: true,
      dms: true,
    });
    expect(items.map((item) => item.key).slice(0, 6)).toEqual([
      'jobs',
      'clients',
      'graphics',
      'luts',
      'fonts',
      'dms',
    ]);
  });

  it('leaves DMs out for an editor', () => {
    const items = navItemsFor({ analytics: false, dms: true, admin: false });
    expect(items.some((item) => item.key === 'dms')).toBe(false);
  });
});

describe('navItemsFor: Fonts follows its switch', () => {
  it('has no Fonts item while the switch is off', () => {
    expect(navItemsFor({ analytics: false, graphics: false, luts: false, fonts: false })).toBe(
      NAV_ITEMS,
    );
    expect(
      navItemsFor({ analytics: true, graphics: true, luts: true }).some(
        (item) => item.key === 'fonts',
      ),
    ).toBe(false);
  });

  it('puts Fonts right after Clients while the switch is on, a page at /fonts', () => {
    const items = navItemsFor({ analytics: false, fonts: true });
    expect(items.map((item) => item.label)).toEqual([
      'Jobs',
      'Clients',
      'Fonts',
      'Deliveries',
      'Money',
      'Analytics',
      'Team',
      'Settings',
    ]);
    expect(FONTS_NAV_ITEM).toMatchObject({ label: 'Fonts', enabled: true, to: '/fonts' });
    expect((FONTS_NAV_ITEM.icon as { displayName?: string }).displayName).toBe('CaseSensitive');
  });

  it('puts Fonts after LUTs, and LUTs after Graphics, when all three are on', () => {
    const items = navItemsFor({ analytics: true, graphics: true, luts: true, fonts: true });
    expect(items.map((item) => item.key)).toEqual([
      'jobs',
      'clients',
      'graphics',
      'luts',
      'fonts',
      'deliveries',
      'money',
      'analytics',
      'team',
      'settings',
    ]);
  });

  it('puts Fonts after Graphics when LUTs is off', () => {
    const items = navItemsFor({ analytics: false, graphics: true, fonts: true });
    expect(items.map((item) => item.key).slice(0, 4)).toEqual([
      'jobs',
      'clients',
      'graphics',
      'fonts',
    ]);
  });

  it('puts /fonts under Fonts while the switch is on', () => {
    const items = navItemsFor({ analytics: false, fonts: true });
    expect(navItemForPath('/fonts', items)).toBe(FONTS_NAV_ITEM);
    expect(navItemForPath('/fonts', navItemsFor({ analytics: false }))).toBeUndefined();
  });

  it('leaves Fonts out for an editor, whatever the switch says', () => {
    const items = navItemsFor({
      analytics: true,
      graphics: true,
      luts: true,
      fonts: true,
      admin: false,
    });
    expect(items.map((item) => item.key)).toEqual(['jobs', 'clients', 'deliveries']);
  });
});

describe('coming-soon texts', () => {
  it('tooltip is plain when the label is visible and repeats the label on the icon rail', () => {
    expect(comingSoonTooltip('Clients', false)).toBe('Coming in a later phase');
    expect(comingSoonTooltip('Clients', true)).toBe('Clients · coming in a later phase');
  });

  it('accessible name carries the reason', () => {
    expect(comingSoonLabel('Analytics')).toBe('Analytics (coming in a later phase)');
  });
});

describe('navItemsFor: the admin and an editor', () => {
  const labels = (input: Parameters<typeof navItemsFor>[0]) =>
    navItemsFor(input).map((item) => item.label);

  it('gives the admin every item, as before (the default)', () => {
    expect(labels({ analytics: true, graphics: true })).toEqual([
      'Jobs',
      'Clients',
      'Graphics',
      'Deliveries',
      'Money',
      'Analytics',
      'Team',
      'Settings',
    ]);
    expect(navItemsFor({ analytics: false, admin: true })).toBe(NAV_ITEMS);
  });

  it('leaves Money, Analytics and Graphics out for an editor, whatever the switches say', () => {
    expect(labels({ analytics: true, graphics: true, admin: false })).toEqual([
      'Jobs',
      'Clients',
      'Deliveries',
    ]);
    expect(labels({ analytics: false, graphics: false, admin: false })).toEqual([
      'Jobs',
      'Clients',
      'Deliveries',
    ]);
  });

  it('names every admin-only page, the Team page, Settings, Fonts / LUTs and DMs included, for when they come', () => {
    expect([...ADMIN_ONLY_NAV_KEYS].sort()).toEqual([
      'analytics',
      'dms',
      'fonts',
      'graphics',
      'luts',
      'money',
      'settings',
      'team',
    ]);
    for (const path of [
      '/money',
      '/analytics',
      '/graphics/new',
      '/team',
      '/settings/team',
      '/settings',
      '/fonts',
      '/luts',
      '/dms',
    ]) {
      expect(isAdminOnlyPath(path), path).toBe(true);
    }
    for (const path of ['/', '/jobs', '/clients', '/clients/x/style']) {
      expect(isAdminOnlyPath(path), path).toBe(false);
    }
  });
});
