import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiErrorSchema, settingsResponseSchema } from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createApp } from '../app.js';
import { FeatureSettings } from '../settings/feature-settings.js';
import { TeamService } from '../team/team-service.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const MAC = 'studio-mac.tail1234.ts.net';
const OWNER = 'owner@example.com';

let root: string;
let configPath: string;
let restart: Mock<() => void>;
let app: Hono;

function build(canRestart: boolean, env: Record<string, string | undefined> = {}) {
  restart = vi.fn<() => void>();
  const team = new TeamService(join(root, 'team.json'));
  team.upsertUser({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
  app = createApp({
    remoteAccess: () => ({ hosts: [MAC], logins: [OWNER] }),
    team,
    settingsRoutes: {
      settings: new FeatureSettings({
        configPath,
        running: {
          graphics: true,
          fonts: true,
          luts: true,
          claudePlanOnly: true,
          draftChat: false,
          twoJobsAtOnce: true,
          quickFixes: true,
          instagram: false,
        },
        env,
      }),
      restart: canRestart ? restart : null,
      restartDelayMs: 0,
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-settings-routes-'));
  configPath = join(root, 'config.json');
  build(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, path: string, login: string | null, body?: unknown) {
  return app.request(
    `http://${MAC}${path}`,
    {
      method,
      headers: {
        host: MAC,
        'content-type': 'application/json',
        'x-forwarded-for': '100.64.0.1',
        ...(login === null ? {} : { 'tailscale-user-login': login }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
  );
}

describe('admin only', () => {
  it.each([
    ['GET', '/api/settings', undefined],
    ['PUT', '/api/settings', { graphics: false }],
    ['POST', '/api/settings/restart', undefined],
  ])('refuses an editor on %s %s', async (method, path, body) => {
    const res = await call(method, path, 'yael@example.com', body);
    expect(res.status).toBe(403);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: 'Not allowed.' });
    expect(restart).not.toHaveBeenCalled();
  });

  it('lets this Mac itself in', async () => {
    expect((await app.request('/api/settings')).status).toBe(200);
  });
});

describe('GET /api/settings', () => {
  it('tells the seven switches and whether the engine can restart itself', async () => {
    const res = await call('GET', '/api/settings', OWNER);
    expect(res.status).toBe(200);
    const body = settingsResponseSchema.parse(await res.json());
    expect(body.canRestart).toBe(true);
    expect(body.features.map((feature) => feature.key)).toEqual([
      'graphics',
      'fonts',
      'luts',
      'claudePlanOnly',
      'draftChat',
      'twoJobsAtOnce',
      'quickFixes',
      'instagram',
    ]);
  });

  it('says the engine cannot restart itself without the agent', async () => {
    build(false);
    const body = settingsResponseSchema.parse(
      await (await call('GET', '/api/settings', OWNER)).json(),
    );
    expect(body.canRestart).toBe(false);
  });
});

describe('PUT /api/settings', () => {
  it('saves a switch to config.json and tells it is waiting for a restart', async () => {
    const res = await call('PUT', '/api/settings', OWNER, { fonts: false });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ fonts: false });
    const body = settingsResponseSchema.parse(await res.json());
    expect(body.features.find((feature) => feature.key === 'fonts')).toMatchObject({
      running: true,
      saved: false,
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it('tells Which clients the Instagram scan reads, active until it is changed', async () => {
    const res = await call('GET', '/api/settings', OWNER);
    expect(settingsResponseSchema.parse(await res.json()).instagramClients).toEqual({
      running: 'active',
      saved: 'active',
      lockedByEnv: false,
    });
  });

  it('saves Which clients to config.json, which counts after a restart', async () => {
    const res = await call('PUT', '/api/settings', OWNER, { instagramClients: 'all' });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ instagramClients: 'all' });
    const body = settingsResponseSchema.parse(await res.json());
    expect(body.instagramClients).toEqual({ running: 'active', saved: 'all', lockedByEnv: false });
  });

  it('400 for a Which clients that is neither active nor all', async () => {
    const res = await call('PUT', '/api/settings', OWNER, { instagramClients: 'some' });
    expect(res.status).toBe(400);
  });

  it('409 for Which clients when the environment decides', async () => {
    build(true, { STUDIO_INSTAGRAM_CLIENTS: 'active' });
    const res = await call('PUT', '/api/settings', OWNER, { instagramClients: 'all' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('STUDIO_INSTAGRAM_CLIENTS');
  });

  it('saves Claude plan only, which counts after a restart', async () => {
    const res = await call('PUT', '/api/settings', OWNER, { claudePlanOnly: false });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ claudePlanOnly: false });
    const body = settingsResponseSchema.parse(await res.json());
    expect(body.features.find((feature) => feature.key === 'claudePlanOnly')).toMatchObject({
      running: true,
      saved: false,
    });
  });

  it.each([{}, { graphics: 'no' }, { colour: false }, 'graphics'])('400 for %j', async (body) => {
    const res = await call('PUT', '/api/settings', OWNER, body);
    expect(res.status).toBe(400);
    expect(apiErrorSchema.safeParse(await res.json()).success).toBe(true);
  });

  it('409 for a switch the environment decides', async () => {
    build(true, { STUDIO_LUTS: '1' });
    const res = await call('PUT', '/api/settings', OWNER, { luts: false });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('STUDIO_LUTS');
  });

  it('409 for a config.json that is not JSON', async () => {
    writeFileSync(configPath, '{ nope');
    const res = await call('PUT', '/api/settings', OWNER, { graphics: false });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/settings/restart', () => {
  it('answers, then restarts', async () => {
    const res = await call('POST', '/api/settings/restart', OWNER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  });

  it('409 when nothing would start the engine again', async () => {
    build(false);
    const res = await call('POST', '/api/settings/restart', OWNER);
    expect(res.status).toBe(409);
    expect(restart).not.toHaveBeenCalled();
  });
});
