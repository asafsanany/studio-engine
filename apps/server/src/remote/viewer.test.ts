import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiErrorSchema, meResponseSchema } from '@studio/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { TeamService } from '../team/team-service.js';
import type { RemoteAccess } from './access.js';
import { decodeRfc2047, isLoopbackAddress, type ViewerLog, viewerMiddleware } from './viewer.js';

const MAC = 'studio-mac.tail1234.ts.net';
const OWNER = 'owner@example.com';
const remote: RemoteAccess = { hosts: [MAC], logins: [OWNER] };

let dir: string;
let team: TeamService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-viewer-'));
  team = new TeamService(join(dir, 'team.json'));
  team.upsertUser({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
  team.upsertUser({ email: 'boss@example.com', name: 'Boss', role: 'admin' });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** What Tailscale Serve adds when it proxies a request from `login`'s device. */
function viaServe(login: string | null, name?: string): Record<string, string> {
  return {
    'x-forwarded-for': '100.101.102.103',
    'x-forwarded-host': MAC,
    'x-forwarded-proto': 'https',
    ...(login === null ? {} : { 'tailscale-user-login': login }),
    ...(name === undefined ? {} : { 'tailscale-user-name': name }),
  };
}

/** The socket a request came in on, as `@hono/node-server` hands it to Hono. */
const socket = (remoteAddress: string | undefined) => ({ incoming: { socket: { remoteAddress } } });

function appWithTeam(access: RemoteAccess = remote) {
  return createApp({ remoteAccess: () => access, team });
}

function send(
  app: Hono,
  path: string,
  init: { host?: string; method?: string; headers?: Record<string, string>; env?: object } = {},
) {
  const host = init.host ?? '127.0.0.1:4310';
  return app.request(
    `http://${host}${path}`,
    { method: init.method ?? 'GET', headers: { host, ...init.headers } },
    init.env ?? socket('127.0.0.1'),
  );
}

async function me(res: Response) {
  expect(res.status).toBe(200);
  return meResponseSchema.parse(await res.json());
}

async function expectNotAllowed(res: Response) {
  expect(res.status).toBe(403);
  expect(apiErrorSchema.parse(await res.json())).toEqual({ error: 'Not allowed.' });
}

describe('GET /api/me', () => {
  it('a request from this Mac is the admin', async () => {
    expect(await me(await send(appWithTeam(), '/api/me'))).toEqual({
      email: 'local',
      name: 'This Mac',
      role: 'admin',
    });
  });

  it('is the admin for a request made in process too (no socket, as in tests)', async () => {
    const res = await createApp().request('/api/me');
    expect((await me(res)).role).toBe('admin');
  });

  it("the Mac's owner login is the admin", async () => {
    const res = await send(appWithTeam(), '/api/me', {
      host: MAC,
      headers: viaServe('Owner@Example.com', 'The owner'),
    });
    expect(await me(res)).toEqual({ email: 'owner@example.com', name: 'The owner', role: 'admin' });
  });

  it('a login from config.json (remoteLogins) is an admin too', async () => {
    const app = appWithTeam({ hosts: [MAC], logins: [OWNER, 'friend@github'] });
    const res = await send(app, '/api/me', { host: MAC, headers: viaServe('friend@github') });
    expect(await me(res)).toEqual({ email: 'friend@github', name: 'friend@github', role: 'admin' });
  });

  it('an editor login is an editor, with the name Tailscale sends', async () => {
    const res = await send(appWithTeam(), '/api/me', {
      host: MAC,
      headers: viaServe('yael@example.com', 'Yael Levi'),
    });
    expect(await me(res)).toEqual({ email: 'yael@example.com', name: 'Yael Levi', role: 'editor' });
  });

  it('falls back to the name in team.json, then to the login', async () => {
    const named = await send(appWithTeam(), '/api/me', {
      host: MAC,
      headers: viaServe('yael@example.com'),
    });
    expect((await me(named)).name).toBe('Yael');

    team.upsertUser({ email: 'nameless@example.com', name: '', role: 'editor' });
    const bare = await send(appWithTeam(), '/api/me', {
      host: MAC,
      headers: viaServe('nameless@example.com'),
    });
    expect((await me(bare)).name).toBe('nameless@example.com');
  });

  it('a team admin is an admin', async () => {
    const res = await send(appWithTeam(), '/api/me', {
      host: MAC,
      headers: viaServe('boss@example.com'),
    });
    expect((await me(res)).role).toBe('admin');
  });

  it('the owner stays an admin even when team.json lists the same login as an editor', async () => {
    team.upsertUser({ email: OWNER, name: 'The owner', role: 'editor' });
    const res = await send(appWithTeam(), '/api/me', { host: MAC, headers: viaServe(OWNER) });
    expect((await me(res)).role).toBe('admin');
  });

  it('refuses a login that is on no list', async () => {
    await expectNotAllowed(
      await send(appWithTeam(), '/api/me', {
        host: MAC,
        headers: viaServe('stranger@example.com'),
      }),
    );
  });

  it('refuses a request with no login (Funnel, a tagged device), never the admin', async () => {
    const app = appWithTeam();
    await expectNotAllowed(await send(app, '/api/me', { host: MAC, headers: viaServe(null) }));
    await expectNotAllowed(await send(app, '/api/me', { host: MAC }));
    await expectNotAllowed(
      await send(app, '/api/me', { headers: { 'tailscale-user-name': 'The owner' } }),
    );
    await expectNotAllowed(
      await send(app, '/api/me', { headers: { 'x-forwarded-for': '1.2.3.4' } }),
    );
  });

  it('takes who it is from the headers only, never the query, a cookie or a body', async () => {
    const app = appWithTeam();
    const query = await send(app, `/api/me?tailscale-user-login=${OWNER}`, {
      host: MAC,
      headers: viaServe(null),
    });
    await expectNotAllowed(query);
    await expectNotAllowed(
      await send(app, '/api/me', {
        host: MAC,
        headers: { ...viaServe(null), cookie: `tailscale-user-login=${OWNER}` },
      }),
    );
    // Local, with a login in the query: still the local admin, not that person.
    const local = await me(await send(app, `/api/me?login=yael@example.com`));
    expect(local.email).toBe('local');
  });
});

describe('a forged login from beyond this Mac', () => {
  it.each(['203.0.113.7', '100.101.102.103', '192.168.1.20', '::ffff:203.0.113.7', '2001:db8::1'])(
    'is not trusted when the socket is %s',
    async (address) => {
      const app = appWithTeam();
      await expectNotAllowed(
        await send(app, '/api/me', {
          host: MAC,
          headers: viaServe(OWNER),
          env: socket(address),
        }),
      );
      // Not even as this Mac's own request.
      await expectNotAllowed(await send(app, '/api/me', { env: socket(address) }));
    },
  );

  it('is refused when the socket does not know its peer', async () => {
    await expectNotAllowed(
      await send(appWithTeam(), '/api/me', {
        host: MAC,
        headers: viaServe(OWNER),
        env: socket(undefined),
      }),
    );
  });

  it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])(
    'trusts the loopback socket %s',
    async (address) => {
      const res = await send(appWithTeam(), '/api/me', {
        host: MAC,
        headers: viaServe(OWNER),
        env: socket(address),
      });
      expect(res.status).toBe(200);
    },
  );

  it('recognises loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('128.0.0.1')).toBe(false);
    expect(isLoopbackAddress('127.0.0.1.evil')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('who may come in', () => {
  it('reads the team live: adding Yael needs no restart, removing her closes the door', async () => {
    const empty = new TeamService(join(dir, 'later.json'));
    const app = createApp({ remoteAccess: () => remote, team: empty });
    const asYael = { host: MAC, headers: viaServe('yael@example.com') };

    await expectNotAllowed(await send(app, '/api/me', asYael));
    empty.upsertUser({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
    expect((await me(await send(app, '/api/me', asYael))).role).toBe('editor');
    empty.removeUser('yael@example.com');
    await expectNotAllowed(await send(app, '/api/me', asYael));
  });

  it('lets the team in to the web app and the API, not only /api/me', async () => {
    const app = appWithTeam();
    const res = await send(app, '/api/health', {
      host: MAC,
      headers: viaServe('yael@example.com'),
    });
    expect(res.status).toBe(200);
  });

  it('with no team given, only the owner and config logins come in', async () => {
    const app = createApp({ remoteAccess: () => remote });
    expect((await send(app, '/api/me', { host: MAC, headers: viaServe(OWNER) })).status).toBe(200);
    await expectNotAllowed(
      await send(app, '/api/me', { host: MAC, headers: viaServe('yael@example.com') }),
    );
  });

  it('answers a refused page with the small HTML page', async () => {
    const res = await send(appWithTeam(), '/', { host: MAC, headers: viaServe(null) });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('the name Tailscale sends (RFC 2047)', () => {
  it.each([
    ['Yael Levi', 'Yael Levi'],
    ['=?utf-8?q?Am=C3=ADt_S=C3=A1nany?=', 'Amít Sánany'],
    ['=?UTF-8?Q?Am=C3=ADt?=', 'Amít'],
    ['=?utf-8?b?w4FtaXQ=?=', 'Ámit'],
    ['=?utf-8?q?=D7=99=D7=A2=D7=9C?=', 'יעל'],
    ['=?iso-8859-1?q?Andr=E9?=', 'André'],
    ['=?utf-8?q?Yael?= =?utf-8?q?_Levi?=', 'Yael Levi'],
    ['=?utf-8?q?Yael?= Levi', 'Yael Levi'],
  ])('decodes %s', (raw, expected) => {
    expect(decodeRfc2047(raw)).toBe(expected);
  });

  it('shows up decoded in /api/me', async () => {
    const res = await send(appWithTeam(), '/api/me', {
      host: MAC,
      headers: viaServe('yael@example.com', '=?utf-8?q?Yael_L=C3=A9vi?='),
    });
    expect((await me(res)).name).toBe('Yael Lévi');
  });
});

describe('the audit log', () => {
  function logged() {
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    const log: ViewerLog = {
      info: (obj, msg) => lines.push({ obj: obj as Record<string, unknown>, msg }),
    };
    const app = new Hono();
    app.use('*', viewerMiddleware({ remote: () => remote, team, log }));
    app.get('/api/jobs', (c) => c.json([]));
    app.post('/api/jobs/1/hold', (c) => c.json({ held: true }));
    app.delete('/api/jobs/1', (c) => c.body(null, 204));
    return { app, lines };
  }

  it("logs who made every write, from this Mac or through Serve, and doesn't log reads", async () => {
    const { app, lines } = logged();
    await send(app, '/api/jobs');
    await send(app, '/api/jobs/1/hold', { method: 'POST' });
    await send(app, '/api/jobs/1', {
      method: 'DELETE',
      host: MAC,
      headers: viaServe('yael@example.com'),
    });

    expect(lines.map((l) => l.obj)).toEqual([
      expect.objectContaining({
        viewer: 'local',
        method: 'POST',
        path: '/api/jobs/1/hold',
        status: 200,
      }),
      expect.objectContaining({
        viewer: 'yael@example.com',
        role: 'editor',
        via: 'tailscale',
        method: 'DELETE',
        status: 204,
      }),
    ]);
  });

  it('logs nothing for a write that was refused', async () => {
    const { app, lines } = logged();
    await send(app, '/api/jobs/1/hold', { method: 'POST', host: MAC, headers: viaServe(null) });
    expect(lines).toEqual([]);
  });
});
