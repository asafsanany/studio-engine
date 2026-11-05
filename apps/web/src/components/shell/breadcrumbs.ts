import type { ClientRow } from '@studio/shared';
import { findClient, summarizeClients } from '@/features/clients/clients';

/** Where a crumb goes. Only the pages that exist are listed. */
export type CrumbLink =
  | { to: '/jobs' | '/clients' | '/graphics' }
  | { to: '/clients/$clientId'; params: { clientId: string } };

/** One step of the header's trail. The last has no link: it is the page that is open. */
export interface Crumb {
  label: string;
  link?: CrumbLink;
  /** User-authored text (a client's name): it picks its own reading direction. */
  bidi?: boolean;
}

/** What the trail says for a client whose name is not known (yet, or at all). */
export const UNKNOWN_CLIENT_CRUMB = 'Client';

/** What the trail says for a graphic whose name is not known (yet, or at all). */
export const UNKNOWN_GRAPHIC_CRUMB = 'Graphic';

/** What the trail says on /graphics/new, before the first Send names the graphic. */
export const NEW_GRAPHIC_CRUMB = 'New graphic';

/** The graphics' side of the trail: whether the page exists, and the open graphic's name. */
export interface GraphicsCrumbs {
  /** The Graphics switch: off, /graphics and below are Not found. */
  enabled: boolean;
  /** The name of the graphic open at /graphics/<id>, once it is known. */
  name?: string;
}

/** The graphic id in /graphics/<id> (not /graphics/new), or `undefined` for any other path. */
export function graphicIdOfPath(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'graphics' || parts[1] === 'new') return undefined;
  try {
    return decodeURIComponent(parts[1] ?? '');
  } catch {
    return parts[1];
  }
}

/** The client id in /clients/<id>, or `undefined` for any other path. */
export function clientIdOfPath(pathname: string): string | undefined {
  const [section, id] = pathname.split('/').filter(Boolean);
  if (section !== 'clients' || id === undefined) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/**
 * The trail after "Studio Engine" for the page at `pathname`: Jobs; Money; Settings; Team; Analytics (while its
 * switch is on, `analytics`; off, the page is Not found); Graphics, Graphics › New graphic and
 * Graphics › <graphic> (while its switch is on, `graphics.enabled`; the graphic's name is
 * `graphics.name`, "Graphic" until it is known); LUTs (while its switch is on, `luts`); Fonts
 * (while its switch is on, `fonts`); Instagram DMs (while the engine has the page, `dms`); Clients;
 * Clients › <client>; Clients › <client> › Style; Clients › <client> › Series (a series' page,
 * /clients/<id>/series/<seriesId>: the series' own name is the page's title). Every step but the
 * last links to its page. The client's name comes from the client list; until it has loaded, or
 * for an id the list does not hold, the step reads "Client".
 */
export function breadcrumbsFor(
  pathname: string,
  clients: readonly ClientRow[] | undefined,
  analytics = false,
  graphics: GraphicsCrumbs = { enabled: false },
  luts = false,
  fonts = false,
  dms = false,
): Crumb[] {
  const parts = pathname.split('/').filter(Boolean);
  const [section] = parts;
  if (section === undefined || section === 'jobs') return [{ label: 'Jobs' }];
  if (section === 'money') return [{ label: 'Money' }];
  if (section === 'settings' && parts.length === 1) return [{ label: 'Settings' }];
  if (section === 'settings' && parts.length === 2 && parts[1] === 'team') {
    return [{ label: 'Team' }];
  }
  if (section === 'analytics') return [{ label: analytics ? 'Analytics' : 'Page not found' }];
  if (section === 'graphics') return graphicsCrumbs(parts, graphics);
  if (section === 'luts')
    return [{ label: luts && parts.length === 1 ? 'LUTs' : 'Page not found' }];
  if (section === 'fonts')
    return [{ label: fonts && parts.length === 1 ? 'Fonts' : 'Page not found' }];
  if (section === 'dms')
    return [{ label: dms && parts.length === 1 ? 'Instagram DMs' : 'Page not found' }];
  if (section !== 'clients') return [{ label: 'Page not found' }];
  if (parts.length === 1) return [{ label: 'Clients' }];

  const clientId = clientIdOfPath(pathname) ?? '';
  const name = clients ? findClient(summarizeClients(clients), clientId)?.name : undefined;
  const client: Crumb =
    name === undefined ? { label: UNKNOWN_CLIENT_CRUMB } : { label: name, bidi: true };
  const page =
    parts.length === 3 && parts[2] === 'style'
      ? 'Style'
      : parts.length === 4 && parts[2] === 'series'
        ? 'Series'
        : undefined;
  if (page !== undefined) {
    return [
      { label: 'Clients', link: { to: '/clients' } },
      { ...client, link: { to: '/clients/$clientId', params: { clientId } } },
      { label: page },
    ];
  }
  return [{ label: 'Clients', link: { to: '/clients' } }, client];
}

/** The trail of /graphics and below: Graphics, then the graphic (or New graphic). */
function graphicsCrumbs(parts: readonly string[], graphics: GraphicsCrumbs): Crumb[] {
  if (!graphics.enabled || parts.length > 2) return [{ label: 'Page not found' }];
  if (parts.length === 1) return [{ label: 'Graphics' }];
  const page: Crumb =
    parts[1] === 'new'
      ? { label: NEW_GRAPHIC_CRUMB }
      : graphics.name === undefined
        ? { label: UNKNOWN_GRAPHIC_CRUMB }
        : { label: graphics.name, bidi: true };
  return [{ label: 'Graphics', link: { to: '/graphics' } }, page];
}
