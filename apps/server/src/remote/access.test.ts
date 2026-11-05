import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiErrorSchema } from '@studio/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { accessGuard, NOT_ALLOWED_PAGE, type Refusal, type RemoteAccess } from './access.js';

const MAC = 'studio-mac.tail1234.ts.net';
const OWNER = 'owner@example.com';
const remote: RemoteAccess = { hosts: [MAC], logins: [OWNER] };

/** The guard in front of one page, one API read and one API write, as in the app. */
function guarded(access: RemoteAccess = remote) {
  const refused: Refusal[] = [];
  const app = new Hono();
  app.use('*', accessGuard({ remote: () => access, onRefused: (r) => refused.push(r) }));
  app.get('/', (c) => c.text('the web app'));
  app.get('/api/jobs', (c) => c.json([]));
  app.post('/api/jobs/1/hold', (c) => c.json({ held: true }));
  app.delete('/api/jobs/1/notes/2', (c) => c.body(null, 204));
  return { app, refused };
}

/** A request as it reaches the engine: `host` is the Host header (and the URL's host). */
function send(
  app: Hono,
  host: string,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) {
  return app.request(`http://${host}${path}`, {
    method: init.method ?? 'GET',
    headers: { host, ...init.headers },
  });
}

/** What Tailscale Serve adds when it proxies a request from `login`'s device. */
function viaServe(login: string | null): Record<string, string> {
  return {
    'x-forwarded-for': '100.101.102.103',
    'x-forwarded-host': MAC,
    'x-forwarded-proto': 'https',
    ...(login === null ? {} : { 'tailscale-user-login': login }),
  };
}

async function expectNotAllowedJson(res: Response) {
  expect(res.status).toBe(403);
  expect(apiErrorSchema.parse(await res.json())).toEqual({ error: 'Not allowed.' });
}

describe('allowed hosts', () => {
  it.each([
    'localhost',
    'localhost:4310',
    '127.0.0.1',
    '127.0.0.1:4310',
    '127.0.0.1:5173',
    '[::1]:4310',
    'LOCALHOST:4310',
  ])('lets a loopback Host in, on any port, with no login: %s', async (host) => {
    const { app } = guarded();
    const res = await send(app, host, '/api/jobs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it.each([
    'evil.example',
    'evil.example:4310',
    '127.0.0.1.nip.io:4310',
    'localhost.evil.example',
    '192.168.1.20:4310',
    'other-mac.tail1234.ts.net',
  ])('refuses any other Host with 403 Not allowed (DNS rebinding too): %s', async (host) => {
    const { app, refused } = guarded();
    await expectNotAllowedJson(await send(app, host, '/api/jobs'));
    expect(refused).toEqual([{ reason: 'host', host }]);
  });

  it('answers a refused page with a small HTML page, and an API path with JSON', async () => {
    const { app } = guarded();

    const page = await send(app, 'evil.example', '/');
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toBe(NOT_ALLOWED_PAGE);
    expect(NOT_ALLOWED_PAGE).toContain('<p>Not allowed.</p>');

    await expectNotAllowedJson(await send(app, 'evil.example', '/api/jobs'));
  });

  it('with no remote access given, only loopback gets in', async () => {
    const app = new Hono();
    app.use('*', accessGuard());
    app.get('/api/jobs', (c) => c.json([]));

    expect((await send(app, '127.0.0.1:4310', '/api/jobs')).status).toBe(200);
    expect((await send(app, MAC, '/api/jobs', { headers: viaServe(OWNER) })).status).toBe(403);
  });
});

describe('the tailnet login', () => {
  it('lets the ts.net Host in with an allowed login', async () => {
    const { app } = guarded();
    const res = await send(app, MAC, '/api/jobs', { headers: viaServe(OWNER) });
    expect(res.status).toBe(200);
  });

  it('reads the Host and the login without regard to case, and the name with its trailing dot', async () => {
    const { app } = guarded();
    const res = await send(app, `${MAC.toUpperCase()}.`, '/', {
      headers: viaServe('Owner@Example.com'),
    });
    expect(res.status).toBe(200);
  });

  it('refuses the ts.net Host with another login', async () => {
    const { app, refused } = guarded();
    const res = await send(app, MAC, '/', { headers: viaServe('someone@else.example') });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe(NOT_ALLOWED_PAGE);
    expect(refused).toEqual([{ reason: 'login', host: MAC, login: 'someone@else.example' }]);
  });

  it('refuses the ts.net Host with no login (a tagged device, or Serve not adding it)', async () => {
    const { app } = guarded();
    await expectNotAllowedJson(await send(app, MAC, '/api/jobs', { headers: viaServe(null) }));
    await expectNotAllowedJson(await send(app, MAC, '/api/jobs'));
  });

  it('refuses everyone through the ts.net Host while no login is known', async () => {
    const { app } = guarded({ hosts: [MAC], logins: [] });
    await expectNotAllowedJson(await send(app, MAC, '/api/jobs', { headers: viaServe(OWNER) }));
  });

  it('a device on the tailnet that sends Host: localhost through Serve still needs the login', async () => {
    const { app, refused } = guarded();

    await expectNotAllowedJson(
      await send(app, 'localhost', '/api/jobs', { headers: viaServe('someone@else.example') }),
    );
    await expectNotAllowedJson(
      await send(app, 'localhost', '/api/jobs', { headers: viaServe(null) }),
    );
    expect(refused.map((r) => r.reason)).toEqual(['login', 'login']);

    expect((await send(app, 'localhost', '/api/jobs', { headers: viaServe(OWNER) })).status).toBe(
      200,
    );
  });

  it('any one of the headers Serve adds is enough to ask for the login', async () => {
    const { app } = guarded();
    for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) {
      const res = await send(app, '127.0.0.1:4310', '/api/jobs', { headers: { [header]: 'x' } });
      expect(res.status, header).toBe(403);
    }
    const loginOnly = await send(app, '127.0.0.1:4310', '/api/jobs', {
      headers: { 'tailscale-user-login': 'someone@else.example' },
    });
    expect(loginOnly.status).toBe(403);
  });
});

describe('same-origin writes', () => {
  it('lets a same-origin POST in, on loopback and through Serve', async () => {
    const { app } = guarded();

    const local = await send(app, '127.0.0.1:4310', '/api/jobs/1/hold', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4310' },
    });
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ held: true });

    // The Vite dev server proxies with the browser's own Host, so its origin matches too.
    const dev = await send(app, 'localhost:5173', '/api/jobs/1/hold', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(dev.status).toBe(200);

    // The phone's page is https; Serve says so, while the engine itself is plain http.
    const phone = await send(app, MAC, '/api/jobs/1/hold', {
      method: 'POST',
      headers: { ...viaServe(OWNER), origin: `https://${MAC}` },
    });
    expect(phone.status).toBe(200);
  });

  it('refuses a cross-origin POST', async () => {
    const { app, refused } = guarded();
    const res = await send(app, '127.0.0.1:4310', '/api/jobs/1/hold', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });

    await expectNotAllowedJson(res);
    expect(refused).toEqual([
      { reason: 'origin', host: '127.0.0.1:4310', origin: 'https://evil.example' },
    ]);
  });

  it.each([
    ['another port of this Mac', 'http://127.0.0.1:9999'],
    ['another loopback name', 'http://localhost:4310'],
    ['the plain-http phone origin', `http://${MAC}`],
    ['a sandboxed page', 'null'],
    ['nonsense', 'not an origin'],
  ])('refuses a write from %s', async (_, origin) => {
    const { app } = guarded();
    const host = origin.includes(MAC) ? MAC : '127.0.0.1:4310';
    const headers = { ...(host === MAC ? viaServe(OWNER) : {}), origin };
    const res = await send(app, host, '/api/jobs/1/notes/2', { method: 'DELETE', headers });
    expect(res.status).toBe(403);
  });

  it('lets a write with no Origin in (curl, the engine itself), and never checks reads', async () => {
    const { app } = guarded();

    const noOrigin = await send(app, '127.0.0.1:4310', '/api/jobs/1/hold', { method: 'POST' });
    expect(noOrigin.status).toBe(200);

    const read = await send(app, '127.0.0.1:4310', '/api/jobs', {
      headers: { origin: 'https://evil.example' },
    });
    expect(read.status).toBe(200);
  });
});

describe('in the app', () => {
  let webDist: string;
  beforeAll(() => {
    webDist = mkdtempSync(join(tmpdir(), 'studio-access-web-'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Studio Engine</title>');
  });
  afterAll(() => {
    rmSync(webDist, { recursive: true, force: true });
  });

  it('guards the API and the web app, given the remote access the boot passes', async () => {
    const app = createApp({ webDist, remoteAccess: () => remote });

    expect((await send(app, '127.0.0.1:4310', '/api/health')).status).toBe(200);
    expect((await send(app, '127.0.0.1:4310', '/')).status).toBe(200);
    expect((await send(app, MAC, '/', { headers: viaServe(OWNER) })).status).toBe(200);
    expect((await send(app, MAC, '/jobs/1', { headers: viaServe(OWNER) })).status).toBe(200);

    const page = await send(app, MAC, '/', { headers: viaServe('someone@else.example') });
    expect(page.status).toBe(403);
    expect(await page.text()).toBe(NOT_ALLOWED_PAGE);
    const asset = await send(app, 'evil.example', '/index.html');
    expect(asset.status).toBe(403);
    await expectNotAllowedJson(await send(app, 'evil.example', '/api/health'));
    await expectNotAllowedJson(await send(app, 'evil.example', '/api/nope'));
  });

  it('reads who may come in on every request, so a name found later counts at once', async () => {
    let access: RemoteAccess = { hosts: [], logins: [] };
    const app = createApp({ remoteAccess: () => access });

    expect((await send(app, MAC, '/api/health', { headers: viaServe(OWNER) })).status).toBe(403);
    access = remote;
    expect((await send(app, MAC, '/api/health', { headers: viaServe(OWNER) })).status).toBe(200);
  });

  it('lets the requests of the tests and of this Mac in by default (loopback, no remote access)', async () => {
    const res = await createApp().request('/api/health');
    expect(res.status).toBe(200);
  });
});
