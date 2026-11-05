// Who is asking (Team plan, TM0). The access guard (access.ts) only lets people in or out; this
// middleware, right after it, says who each request is from and sets `c.var.viewer`:
//
//   - A request from this Mac itself (loopback Host, none of the headers Tailscale Serve adds) is
//     the admin, `via: 'local'`.
//   - A request through Tailscale Serve is the person in `Tailscale-User-Login` (lowercased, exactly
//     as Tailscale sends it: not always an email). Serve sets that header from the device that
//     made the request and replaces one the device sent itself. The Mac's owner (and any login in
//     config.json's `remoteLogins`) is an admin; the team (team.json) are admins or editors by
//     their role. Anyone else, and a request with no login (Funnel, a tagged device), is refused
//     with the same 403 "Not allowed." as the guard. Never the admin by default.
//   - The identity comes from those headers only: never from the query, a cookie or a body.
//   - Defence in depth: the engine listens on loopback, so every connection must come from a
//     loopback address. One that does not (or whose address is unknown) is refused before any header
//     is looked at. A request made in process (the tests, where Hono has no socket) has no address
//     to check and goes by its headers.
//
// Every write (anything but GET, HEAD and OPTIONS) is logged with who made it.

import { getConnInfo } from '@hono/node-server/conninfo';
import type { TeamRole, Viewer } from '@studio/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { cameThroughServe, NOT_ALLOWED_PAGE, type RemoteAccess } from './access.js';

/** The Hono environment of an app that has a viewer: `c.var.viewer` in every route. */
export type AppEnv = { Variables: { viewer: Viewer } };

/** What the viewer needs of the team: who is on it, and with which role. */
export interface TeamRoles {
  find(email: string): { name: string; role: TeamRole } | undefined;
}

export interface ViewerLog {
  info(obj: object, msg: string): void;
}

export interface ViewerOptions {
  /** The owner and `remoteLogins`, as known now: admins who are not in team.json. */
  remote?: () => RemoteAccess;
  /** The team, read live. Default: nobody. */
  team?: TeamRoles;
  /** Where writes are logged. */
  log?: ViewerLog;
}

/** The viewer of a request from this Mac itself. */
export const LOCAL_VIEWER: Viewer = {
  email: 'local',
  name: 'This Mac',
  role: 'admin',
  via: 'local',
};

const NOT_ALLOWED = 'Not allowed.';

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

function notAllowed(c: Context): Response {
  return isApiPath(c.req.path)
    ? c.json({ error: NOT_ALLOWED }, 403)
    : c.html(NOT_ALLOWED_PAGE, 403);
}

/** Whether `address` is the loopback interface (IPv4, IPv6, or IPv4 inside IPv6). */
export function isLoopbackAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::1') return true;
  const v4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * The address the connection came from: `undefined` when the request was made in process and there
 * is no socket to ask, `null` when there is a socket that does not know its peer.
 */
function peerAddress(c: Context): string | null | undefined {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return undefined;
  }
}

/**
 * Decodes a header written as RFC 2047 encoded words (`=?utf-8?q?Am=C3=ADt?=`, or `?b?` base64),
 * which is how Tailscale sends a name that is not plain ASCII. Anything else comes back as it was.
 */
export function decodeRfc2047(value: string): string {
  const word = /=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/g;
  // White space between two encoded words is not part of the text.
  const joined = value.replace(/(\?=)\s+(?==\?)/g, '$1');
  return joined.replace(word, (_, charset: string, encoding: string, text: string) => {
    try {
      const bytes =
        encoding.toLowerCase() === 'b'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9a-fA-F]{2})/g, (_m, hex: string) =>
                  String.fromCharCode(Number.parseInt(hex, 16)),
                ),
              'latin1',
            );
      return new TextDecoder(charset.replace(/\*.*$/, '')).decode(bytes);
    } catch {
      return text;
    }
  });
}

function viewerOf(c: Context, options: ViewerOptions): Viewer | null {
  const access = options.remote?.() ?? { hosts: [], logins: [] };
  if (!cameThroughServe(c, access.hosts)) return LOCAL_VIEWER;

  const login = c.req.header('tailscale-user-login')?.trim().toLowerCase();
  if (!login) return null;

  const rawName = c.req.header('tailscale-user-name')?.trim();
  const headerName = rawName ? decodeRfc2047(rawName).trim() : '';

  const member = options.team?.find(login);
  // The owner is an admin whatever team.json says about the same login.
  if (access.logins.includes(login)) {
    return {
      email: login,
      name: headerName || member?.name || login,
      role: 'admin',
      via: 'tailscale',
    };
  }
  if (member) {
    return {
      email: login,
      name: headerName || member.name || login,
      role: member.role,
      via: 'tailscale',
    };
  }
  return null;
}

export function viewerMiddleware(options: ViewerOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const address = peerAddress(c);
    if (address !== undefined && (address === null || !isLoopbackAddress(address))) {
      return notAllowed(c);
    }
    const viewer = viewerOf(c, options);
    if (viewer === null) return notAllowed(c);
    c.set('viewer', viewer);

    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      await next();
      return;
    }
    await next();
    options.log?.info(
      {
        viewer: viewer.email,
        role: viewer.role,
        via: viewer.via,
        method,
        path: c.req.path,
        status: c.res.status,
      },
      'write request',
    );
  };
}
