import { describe, expect, it } from 'vitest';
import {
  CLIENT_BOARD_ROWS,
  makeClientRow,
  makeEmptyClientRow,
} from '@/features/clients/test-clients';
import { CLIENT_IDS } from '@/features/jobs/test-jobs';
import {
  breadcrumbsFor,
  clientIdOfPath,
  graphicIdOfPath,
  NEW_GRAPHIC_CRUMB,
  UNKNOWN_CLIENT_CRUMB,
  UNKNOWN_GRAPHIC_CRUMB,
} from './breadcrumbs';

describe('breadcrumbsFor', () => {
  it('is Jobs for / and /jobs, with no link (it is the page that is open)', () => {
    for (const path of ['/', '/jobs']) {
      expect(breadcrumbsFor(path, CLIENT_BOARD_ROWS)).toEqual([{ label: 'Jobs' }]);
    }
  });

  it('is Money for /money, with no link (it is the page that is open)', () => {
    expect(breadcrumbsFor('/money', CLIENT_BOARD_ROWS)).toEqual([{ label: 'Money' }]);
    expect(breadcrumbsFor('/money', undefined)).toEqual([{ label: 'Money' }]);
  });

  it('is Settings for /settings and Team for /settings/team, with no link', () => {
    expect(breadcrumbsFor('/settings', CLIENT_BOARD_ROWS)).toEqual([{ label: 'Settings' }]);
    expect(breadcrumbsFor('/settings/team', CLIENT_BOARD_ROWS)).toEqual([{ label: 'Team' }]);
  });

  it('is Analytics for /analytics while its switch is on, with no link', () => {
    expect(breadcrumbsFor('/analytics', CLIENT_BOARD_ROWS, true)).toEqual([{ label: 'Analytics' }]);
    expect(breadcrumbsFor('/analytics', undefined, true)).toEqual([{ label: 'Analytics' }]);
  });

  it('is Page not found for /analytics while its switch is off (the default), like any page that is not there', () => {
    expect(breadcrumbsFor('/analytics', CLIENT_BOARD_ROWS)).toEqual([{ label: 'Page not found' }]);
    expect(breadcrumbsFor('/analytics', CLIENT_BOARD_ROWS, false)).toEqual([
      { label: 'Page not found' },
    ]);
  });

  it('does not let the Analytics switch change any other page', () => {
    expect(breadcrumbsFor('/money', undefined, true)).toEqual([{ label: 'Money' }]);
    expect(breadcrumbsFor('/jobs', undefined, true)).toEqual([{ label: 'Jobs' }]);
    expect(breadcrumbsFor('/analyticsish', undefined, true)).toEqual([{ label: 'Page not found' }]);
  });

  it('is Clients for /clients, with no link', () => {
    expect(breadcrumbsFor('/clients', CLIENT_BOARD_ROWS)).toEqual([{ label: 'Clients' }]);
  });

  it('is Clients › <name> for a client, and only Clients links', () => {
    const crumbs = breadcrumbsFor(`/clients/${CLIENT_IDS['Arc Fitness']}`, CLIENT_BOARD_ROWS);
    expect(crumbs).toEqual([
      { label: 'Clients', link: { to: '/clients' } },
      { label: 'Arc Fitness', bidi: true },
    ]);
    expect(crumbs.at(-1)?.link).toBeUndefined();
  });

  it('is Clients › <name> › Style for a client’s Style page: the first two link, the last is the page', () => {
    const id = CLIENT_IDS['Arc Fitness'];
    const crumbs = breadcrumbsFor(`/clients/${id}/style`, CLIENT_BOARD_ROWS);
    expect(crumbs).toEqual([
      { label: 'Clients', link: { to: '/clients' } },
      {
        label: 'Arc Fitness',
        bidi: true,
        link: { to: '/clients/$clientId', params: { clientId: id } },
      },
      { label: 'Style' },
    ]);
    expect(crumbs.at(-1)?.link).toBeUndefined();
  });

  it('is Clients › <name> › Series for a series’ page: the first two link, the last is the page', () => {
    const id = CLIENT_IDS['Arc Fitness'];
    const crumbs = breadcrumbsFor(`/clients/${id}/series/622212180eef`, CLIENT_BOARD_ROWS);
    expect(crumbs).toEqual([
      { label: 'Clients', link: { to: '/clients' } },
      {
        label: 'Arc Fitness',
        bidi: true,
        link: { to: '/clients/$clientId', params: { clientId: id } },
      },
      { label: 'Series' },
    ]);
    expect(crumbs.at(-1)?.link).toBeUndefined();
  });

  it('says "Client" on a series’ page until the client list has loaded, and still links to the client', () => {
    const id = CLIENT_IDS['Arc Fitness'];
    expect(breadcrumbsFor(`/clients/${id}/series/622212180eef`, undefined)).toEqual([
      { label: 'Clients', link: { to: '/clients' } },
      { label: 'Client', link: { to: '/clients/$clientId', params: { clientId: id } } },
      { label: 'Series' },
    ]);
  });

  it('knows no page below a series’ page, or a "series" with no id', () => {
    const id = CLIENT_IDS['Arc Fitness'];
    expect(breadcrumbsFor(`/clients/${id}/series`, CLIENT_BOARD_ROWS)).toEqual(
      breadcrumbsFor(`/clients/${id}`, CLIENT_BOARD_ROWS),
    );
    expect(breadcrumbsFor(`/clients/${id}/series/abc/extra`, CLIENT_BOARD_ROWS)).toEqual(
      breadcrumbsFor(`/clients/${id}`, CLIENT_BOARD_ROWS),
    );
  });

  it('names a client that has no jobs yet, the one whose Style page opens after New client', () => {
    const rows = [makeEmptyClientRow({ clientId: 'e0e0e0e0e0e0', client: 'Fresh Co' })];
    expect(breadcrumbsFor('/clients/e0e0e0e0e0e0/style', rows)).toEqual([
      { label: 'Clients', link: { to: '/clients' } },
      {
        label: 'Fresh Co',
        bidi: true,
        link: { to: '/clients/$clientId', params: { clientId: 'e0e0e0e0e0e0' } },
      },
      { label: 'Style' },
    ]);
  });

  it('keeps a Hebrew client’s name in its own direction on the Style page too', () => {
    const crumbs = breadcrumbsFor(
      `/clients/${CLIENT_IDS['מאפיית הצפון']}/style`,
      CLIENT_BOARD_ROWS,
    );
    expect(crumbs[1]).toMatchObject({ label: 'מאפיית הצפון', bidi: true });
  });

  it('says "Client" on the Style page until the client list has loaded, and still links to the client', () => {
    const id = CLIENT_IDS['Arc Fitness'];
    expect(breadcrumbsFor(`/clients/${id}/style`, undefined)).toEqual([
      { label: 'Clients', link: { to: '/clients' } },
      { label: UNKNOWN_CLIENT_CRUMB, link: { to: '/clients/$clientId', params: { clientId: id } } },
      { label: 'Style' },
    ]);
  });

  it('decodes an escaped id for the client’s link', () => {
    const crumbs = breadcrumbsFor('/clients/a%20b/style', CLIENT_BOARD_ROWS);
    expect(crumbs[1]?.link).toEqual({ to: '/clients/$clientId', params: { clientId: 'a b' } });
  });

  it("spells the client's name as the folder does", () => {
    const nfd = 'Café Mocha'.normalize('NFD');
    const rows = [makeClientRow({ clientId: 'x', client: nfd })];
    expect(breadcrumbsFor('/clients/x', rows)[1]?.label).toBe(nfd);
  });

  it('says "Client" until the client list has loaded', () => {
    expect(breadcrumbsFor(`/clients/${CLIENT_IDS['Arc Fitness']}`, undefined)).toEqual([
      { label: 'Clients', link: { to: '/clients' } },
      { label: UNKNOWN_CLIENT_CRUMB },
    ]);
  });

  it('says "Client" for an id the list does not hold', () => {
    expect(breadcrumbsFor('/clients/nosuchclient', CLIENT_BOARD_ROWS)[1]).toEqual({
      label: UNKNOWN_CLIENT_CRUMB,
    });
  });

  it('says so for a page that does not exist', () => {
    expect(breadcrumbsFor('/nowhere', CLIENT_BOARD_ROWS)).toEqual([{ label: 'Page not found' }]);
  });
});

describe('clientIdOfPath', () => {
  it('reads the id of a client page, and nothing from any other path', () => {
    expect(clientIdOfPath('/clients/4d337086919d')).toBe('4d337086919d');
    expect(clientIdOfPath('/clients/4d337086919d/')).toBe('4d337086919d');
    expect(clientIdOfPath('/clients/4d337086919d/style')).toBe('4d337086919d');
    expect(clientIdOfPath('/clients')).toBeUndefined();
    expect(clientIdOfPath('/jobs')).toBeUndefined();
    expect(clientIdOfPath('/')).toBeUndefined();
  });

  it('decodes an escaped id, and keeps one it cannot decode', () => {
    expect(clientIdOfPath('/clients/a%20b')).toBe('a b');
    expect(clientIdOfPath('/clients/%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('breadcrumbsFor the LUTs page', () => {
  it('is Page not found for /luts while the switch is off (the default)', () => {
    expect(breadcrumbsFor('/luts', CLIENT_BOARD_ROWS)).toEqual([{ label: 'Page not found' }]);
    expect(breadcrumbsFor('/luts', CLIENT_BOARD_ROWS, true, { enabled: true }, false)).toEqual([
      { label: 'Page not found' },
    ]);
  });

  it('is LUTs for /luts while the switch is on, with no link', () => {
    expect(breadcrumbsFor('/luts', undefined, false, { enabled: false }, true)).toEqual([
      { label: 'LUTs' },
    ]);
  });

  it('is Page not found for anything below /luts, whatever the switch says', () => {
    expect(
      breadcrumbsFor('/luts/golden-hour-warm', undefined, false, { enabled: false }, true),
    ).toEqual([{ label: 'Page not found' }]);
  });
});

describe('breadcrumbsFor the Fonts page', () => {
  it('is Page not found for /fonts while the switch is off (the default)', () => {
    expect(breadcrumbsFor('/fonts', CLIENT_BOARD_ROWS)).toEqual([{ label: 'Page not found' }]);
    expect(
      breadcrumbsFor('/fonts', CLIENT_BOARD_ROWS, true, { enabled: true }, true, false),
    ).toEqual([{ label: 'Page not found' }]);
  });

  it('is Fonts for /fonts while the switch is on, with no link', () => {
    expect(breadcrumbsFor('/fonts', undefined, false, { enabled: false }, false, true)).toEqual([
      { label: 'Fonts' },
    ]);
  });

  it('is Page not found for anything below /fonts, whatever the switch says', () => {
    expect(
      breadcrumbsFor('/fonts/heebo', undefined, false, { enabled: false }, false, true),
    ).toEqual([{ label: 'Page not found' }]);
  });
});

describe('breadcrumbsFor the Graphics pages', () => {
  const on = { enabled: true };

  it('is Page not found for /graphics and below while the switch is off (the default)', () => {
    for (const path of ['/graphics', '/graphics/new', '/graphics/3f9a1c2b7d4e']) {
      expect(breadcrumbsFor(path, CLIENT_BOARD_ROWS), path).toEqual([{ label: 'Page not found' }]);
      expect(breadcrumbsFor(path, CLIENT_BOARD_ROWS, true, { enabled: false }), path).toEqual([
        { label: 'Page not found' },
      ]);
    }
  });

  it('is Graphics for /graphics while the switch is on, with no link', () => {
    expect(breadcrumbsFor('/graphics', undefined, false, on)).toEqual([{ label: 'Graphics' }]);
  });

  it('is Graphics › New graphic for /graphics/new', () => {
    expect(breadcrumbsFor('/graphics/new', undefined, false, on)).toEqual([
      { label: 'Graphics', link: { to: '/graphics' } },
      { label: NEW_GRAPHIC_CRUMB },
    ]);
  });

  it('is Graphics › the graphic’s name, which picks its own direction', () => {
    expect(
      breadcrumbsFor('/graphics/3f9a1c2b7d4e', undefined, false, { enabled: true, name: 'שם' }),
    ).toEqual([
      { label: 'Graphics', link: { to: '/graphics' } },
      { label: 'שם', bidi: true },
    ]);
  });

  it('reads "Graphic" until the name is known', () => {
    expect(breadcrumbsFor('/graphics/3f9a1c2b7d4e', undefined, false, on)).toEqual([
      { label: 'Graphics', link: { to: '/graphics' } },
      { label: UNKNOWN_GRAPHIC_CRUMB },
    ]);
  });

  it('is Page not found below a graphic', () => {
    expect(breadcrumbsFor('/graphics/3f9a1c2b7d4e/more', undefined, false, on)).toEqual([
      { label: 'Page not found' },
    ]);
  });
});

describe('graphicIdOfPath', () => {
  it('reads the id of a graphic’s page, and nothing from any other path', () => {
    expect(graphicIdOfPath('/graphics/3f9a1c2b7d4e')).toBe('3f9a1c2b7d4e');
    expect(graphicIdOfPath('/graphics/new')).toBeUndefined();
    expect(graphicIdOfPath('/graphics')).toBeUndefined();
    expect(graphicIdOfPath('/graphics/3f9a1c2b7d4e/more')).toBeUndefined();
    expect(graphicIdOfPath('/clients/3f9a1c2b7d4e')).toBeUndefined();
    expect(graphicIdOfPath('/graphics/%E0%A4%A')).toBe('%E0%A4%A');
  });
});
