// Who may talk to the engine (Mobile plan §4, PH1). The engine listens on loopback only, and the
// phone reaches it through Tailscale Serve, which proxies https://<mac>.<tailnet>.ts.net to it.
// Every request passes three checks before any route or file of the web app:
//
//   1. Host. Loopback (localhost, 127.0.0.1 or [::1], any port) or one of the remote hosts (the
//      Mac's Tailscale name). Anything else is refused, so a web page that points its own name at
//      127.0.0.1 (DNS rebinding) gets nothing.
//   2. Login. A request that came through Tailscale Serve must carry a `Tailscale-User-Login` from
//      the allowed list. Serve sets that header to the person whose device sent the request and
//      replaces one the device sent itself. "Came through Serve" is its Host being a remote host,
//      or any header Serve adds being there: Serve passes on the Host the device sent, so a device
//      on the tailnet could otherwise claim to be `localhost`. Only a request with a loopback Host
//      and none of those headers is this Mac's own, and needs no login.
//   3. Origin. A write (anything but GET and HEAD) that carries an `Origin` must come from the
//      request's own origin, so no other web page can post to the engine. Behind Serve the page is
//      https while the engine is plain http, so the scheme is the one Serve says the device used.
//
// The guard only lets people in or out. Who they are (admin or editor) is remote/viewer.ts, which
// runs right after it. The allowlist it is given is the owner, config.json's logins and the team.
//
// Every refusal is the same 403 "Not allowed.": JSON under /api (as every API error is), a small
// page anywhere else.

import type { Context, MiddlewareHandler } from 'hono';
import { normaliseHostname } from './tailscale-cli.js';

export interface RemoteAccess {
  /** Hostnames besides loopback that the engine answers: the Mac's Tailscale name. Normalised. */
  readonly hosts: readonly string[];
  /** The Tailscale logins let in through Serve. Lowercase. */
  readonly logins: readonly string[];
}

/** Only this Mac: no remote host, no login. */
export const NO_REMOTE_ACCESS: RemoteAccess = { hosts: [], logins: [] };

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Headers Tailscale Serve adds to every request it proxies. Nothing on this Mac sends them. */
const SERVE_HEADERS = [
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
] as const;

export type Refusal =
  | { reason: 'host'; host: string }
  | { reason: 'login'; host: string; login: string | null }
  | { reason: 'origin'; host: string; origin: string };

export interface AccessGuardOptions {
  /** Who may come in from outside this Mac, as known right now (it changes while the engine runs). */
  remote?: () => RemoteAccess;
  /** Told about every refused request, for the log. */
  onRefused?: (refusal: Refusal) => void;
}

const NOT_ALLOWED = 'Not allowed.';

/** The page a refused browser shows: one line, readable on a phone, light or dark. */
export const NOT_ALLOWED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Not allowed</title>
</head>
<body style="font: 16px -apple-system, system-ui, sans-serif; margin: 2rem;">
<p>${NOT_ALLOWED}</p>
</body>
</html>
`;

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

function notAllowed(c: Context): Response {
  return isApiPath(c.req.path)
    ? c.json({ error: NOT_ALLOWED }, 403)
    : c.html(NOT_ALLOWED_PAGE, 403);
}

/** The Host the request was sent to (`host:port`), or `null` when it can't be read as one. */
function requestHost(c: Context): string | null {
  const raw = c.req.header('host') ?? new URL(c.req.url).host;
  try {
    return new URL(`http://${raw}`).host;
  } catch {
    return null;
  }
}

function hostnameOf(host: string): string {
  return normaliseHostname(new URL(`http://${host}`).hostname);
}

/** The scheme the browser used: the one Serve reports, else the engine's own (plain http). */
function requestScheme(c: Context): string {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded === 'http' || forwarded === 'https') return forwarded;
  return new URL(c.req.url).protocol.replace(/:$/, '');
}

function isSameOrigin(c: Context, origin: string, host: string): boolean {
  try {
    return new URL(origin).origin === new URL(`${requestScheme(c)}://${host}`).origin;
  } catch {
    // `null`, or anything else that is not an origin.
    return false;
  }
}

/**
 * Whether the request came through Tailscale Serve: its Host is a remote host, or it carries any
 * header Serve adds. Only a request that did not is this Mac's own.
 */
export function cameThroughServe(c: Context, remoteHosts: readonly string[]): boolean {
  const host = requestHost(c);
  const hostname = host === null ? null : hostnameOf(host);
  return (
    (hostname !== null && remoteHosts.includes(hostname)) ||
    SERVE_HEADERS.some((name) => c.req.header(name) !== undefined)
  );
}

/** The three checks above, as middleware for every path. */
export function accessGuard({
  remote = () => NO_REMOTE_ACCESS,
  onRefused,
}: AccessGuardOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const access = remote();
    const host = requestHost(c);
    if (host === null) {
      onRefused?.({ reason: 'host', host: c.req.header('host') ?? '' });
      return notAllowed(c);
    }
    const hostname = hostnameOf(host);

    const isRemoteHost = access.hosts.includes(hostname);
    if (!LOOPBACK_HOSTNAMES.has(hostname) && !isRemoteHost) {
      onRefused?.({ reason: 'host', host });
      return notAllowed(c);
    }

    const throughServe =
      isRemoteHost || SERVE_HEADERS.some((name) => c.req.header(name) !== undefined);
    if (throughServe) {
      const login = c.req.header('tailscale-user-login')?.trim().toLowerCase() || null;
      if (login === null || !access.logins.includes(login)) {
        onRefused?.({ reason: 'login', host, login });
        return notAllowed(c);
      }
    }

    const origin = c.req.header('origin');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && origin !== undefined) {
      if (!isSameOrigin(c, origin, host)) {
        onRefused?.({ reason: 'origin', host, origin });
        return notAllowed(c);
      }
    }

    await next();
  };
}
