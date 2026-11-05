import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  assigneesResponseSchema,
  type ServerEvent,
  teamResponseSchema,
  teamUserSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ClientFolders } from '../clients/client-folders.js';
import { ClientStyleRepository, JobRepository, type StudioDb } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';
import { TeamService } from '../team/team-service.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The team API over a real TeamService on a temp team.json, the real routes and `app.request`.
// Callers come "through Tailscale Serve": the login header says who (the owner is owner, an admin;
// yael and amit are editors); a request with no header is from this Mac itself (the admin).

const MAC = 'studio-mac.tail1234.ts.net';
const OWNER = 'owner@example.com';

let root: string;
let db: StudioDb;
let team: TeamService;
let events: ServerEvent[];
let app: Hono;
let acme: string;
let beta: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-team-routes-'));
  const inbox = join(root, 'inbox');
  mkdirSync(join(inbox, 'Acme'), { recursive: true });
  mkdirSync(join(inbox, 'Beta'), { recursive: true });
  db = memoryDb();
  const bus = createEventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  const folders = new ClientFolders(bus);
  folders.seed(['Acme', 'Beta']);
  team = new TeamService(join(root, 'team.json'));
  team.upsertUser({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
  team.upsertUser({ email: 'amit@example.com', name: 'Amit', role: 'editor' });
  team.upsertUser({ email: 'boss@example.com', name: 'Boss', role: 'admin' });
  const clientStyles = new ClientStyleRepository(db);
  const jobs = new JobRepository(db);
  acme = clientIdFor('Acme');
  beta = clientIdFor('Beta');
  app = createApp({
    remoteAccess: () => ({ hosts: [MAC], logins: [OWNER] }),
    team,
    clients: {
      jobs,
      clientStyles,
      folders,
      inboxPath: inbox,
      openFolder: async () => {},
    },
    teamRoutes: {
      team,
      clients: { jobs, folders, clientStyles },
      onChanged: () => bus.publish({ type: 'access.changed' }),
    },
  });
});

afterEach(() => {
  if (db.sqlite.open) db.close();
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

const changed = () => events.filter((event) => event.type === 'access.changed').length;

describe('admin only', () => {
  const requests: Array<[string, string, unknown]> = [
    ['GET', '/api/team', undefined],
    ['POST', '/api/team', { name: 'X', email: 'x@example.com', role: 'editor' }],
    ['PUT', '/api/team/yael@example.com', { name: 'Yael K' }],
    ['DELETE', '/api/team/yael@example.com', undefined],
    ['PUT', '/api/clients/CLIENT/assignees', { editors: ['yael@example.com'] }],
  ];

  it.each(requests)('refuses an editor on %s %s', async (method, path, body) => {
    const res = await call(method, path.replace('CLIENT', acme), 'yael@example.com', body);
    expect(res.status).toBe(403);
    expect(apiErrorSchema.parse(await res.json())).toEqual({ error: 'Not allowed.' });
    expect(changed()).toBe(0);
    expect(team.find('yael@example.com')?.name).toBe('Yael');
    expect(team.editorsOf(acme)).toEqual([]);
  });

  it('lets the owner, a team admin and this Mac in', async () => {
    for (const login of [OWNER, 'boss@example.com']) {
      expect((await call('GET', '/api/team', login)).status).toBe(200);
    }
    // A request from this Mac itself (loopback Host, no Serve headers) is the admin.
    expect((await app.request('/api/team')).status).toBe(200);
  });
});

describe('GET /api/team', () => {
  it('lists the people and the editors of each assigned client', async () => {
    team.setEditors(acme, 'Acme', ['yael@example.com']);
    const res = await call('GET', '/api/team', OWNER);
    expect(res.status).toBe(200);
    const body = teamResponseSchema.parse(await res.json());
    expect(body.users.map((user) => user.email)).toEqual([
      'yael@example.com',
      'amit@example.com',
      'boss@example.com',
    ]);
    expect(body.assignments).toEqual({ [acme]: { client: 'Acme', editors: ['yael@example.com'] } });
    expect(changed()).toBe(0);
  });
});

describe('POST /api/team', () => {
  it('adds a person with a lowercased login and publishes access.changed', async () => {
    const res = await call('POST', '/api/team', OWNER, {
      name: ' Dana ',
      email: ' Dana@Example.COM ',
      role: 'editor',
    });
    expect(res.status).toBe(201);
    expect(teamUserSchema.parse(await res.json())).toEqual({
      email: 'dana@example.com',
      name: 'Dana',
      role: 'editor',
    });
    expect(team.find('dana@example.com')?.role).toBe('editor');
    expect(changed()).toBe(1);
  });

  it('refuses a login that is on the team already, whatever its case', async () => {
    const res = await call('POST', '/api/team', OWNER, {
      name: 'Yael Two',
      email: 'YAEL@example.com',
      role: 'editor',
    });
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toContain('yael@example.com');
    expect(team.find('yael@example.com')?.name).toBe('Yael');
    expect(changed()).toBe(0);
  });

  it('refuses the owner login: the owner is an admin already', async () => {
    const res = await call('POST', '/api/team', OWNER, {
      name: 'The owner',
      email: 'OWNER@example.com',
      role: 'editor',
    });
    expect(res.status).toBe(400);
    expect(team.find(OWNER)).toBeUndefined();
    expect(changed()).toBe(0);
  });

  it.each([
    ['a role that is not admin or editor', { name: 'X', email: 'x@example.com', role: 'owner' }],
    ['no role', { name: 'X', email: 'x@example.com' }],
    ['an empty login', { name: 'X', email: '  ', role: 'editor' }],
    ['a login with a space', { name: 'X', email: 'x y@example.com', role: 'editor' }],
    ['an empty name', { name: ' ', email: 'x@example.com', role: 'editor' }],
    ['a body that is not an object', 'hello'],
  ])('refuses %s', async (_label, body) => {
    const res = await call('POST', '/api/team', OWNER, body);
    expect(res.status).toBe(400);
    apiErrorSchema.parse(await res.json());
    expect(team.users()).toHaveLength(3);
    expect(changed()).toBe(0);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await app.request(
      `http://${MAC}/api/team`,
      {
        method: 'POST',
        headers: { host: MAC, 'x-forwarded-for': '100.64.0.1', 'tailscale-user-login': OWNER },
        body: '{nope',
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/team/:email', () => {
  it('changes the name and the role, keeping what is left out', async () => {
    const res = await call('PUT', '/api/team/Yael@Example.com', OWNER, { role: 'admin' });
    expect(res.status).toBe(200);
    expect(teamUserSchema.parse(await res.json())).toEqual({
      email: 'yael@example.com',
      name: 'Yael',
      role: 'admin',
    });
    const renamed = await call('PUT', '/api/team/yael@example.com', OWNER, { name: 'Yael K' });
    expect(teamUserSchema.parse(await renamed.json()).name).toBe('Yael K');
    expect(team.find('yael@example.com')).toEqual({
      email: 'yael@example.com',
      name: 'Yael K',
      role: 'admin',
    });
    expect(changed()).toBe(2);
  });

  it('answers 404 for someone who is not on the team and 400 for a bad role or name', async () => {
    expect((await call('PUT', '/api/team/who@example.com', OWNER, { name: 'X' })).status).toBe(404);
    expect((await call('PUT', '/api/team/yael@example.com', OWNER, { role: 'god' })).status).toBe(
      400,
    );
    expect((await call('PUT', '/api/team/yael@example.com', OWNER, { name: ' ' })).status).toBe(
      400,
    );
    expect(changed()).toBe(0);
  });
});

describe('DELETE /api/team/:email', () => {
  it('removes the person and their assignments, and reassigns nothing', async () => {
    team.setEditors(acme, 'Acme', ['yael@example.com', 'amit@example.com']);
    team.setEditors(beta, 'Beta', ['yael@example.com']);

    const res = await call('DELETE', '/api/team/yael@example.com', OWNER);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(team.find('yael@example.com')).toBeUndefined();
    expect(team.editorsOf(acme)).toEqual(['amit@example.com']);
    // Beta had only Yael: now for the admin only.
    expect(team.editorsOf(beta)).toEqual([]);
    expect(changed()).toBe(1);
  });

  it('answers 404 for someone who is not on the team', async () => {
    expect((await call('DELETE', '/api/team/who@example.com', OWNER)).status).toBe(404);
    expect(changed()).toBe(0);
  });
});

describe('PUT /api/clients/:clientId/assignees', () => {
  it('replaces the editors, lowercased and without repeats, and publishes access.changed', async () => {
    const res = await call('PUT', `/api/clients/${acme}/assignees`, OWNER, {
      editors: ['Yael@example.com', 'yael@example.com', 'amit@example.com'],
    });
    expect(res.status).toBe(200);
    expect(assigneesResponseSchema.parse(await res.json())).toEqual({
      clientId: acme,
      client: 'Acme',
      editors: ['yael@example.com', 'amit@example.com'],
    });
    expect(team.editorsOf(acme)).toEqual(['yael@example.com', 'amit@example.com']);
    expect(changed()).toBe(1);

    const again = await call('PUT', `/api/clients/${acme}/assignees`, OWNER, {
      editors: ['amit@example.com'],
    });
    expect(assigneesResponseSchema.parse(await again.json()).editors).toEqual(['amit@example.com']);
    expect(team.editorsOf(acme)).toEqual(['amit@example.com']);
    expect(changed()).toBe(2);
  });

  it('makes the client admin-only again with an empty list', async () => {
    team.setEditors(acme, 'Acme', ['yael@example.com']);
    const res = await call('PUT', `/api/clients/${acme}/assignees`, OWNER, { editors: [] });
    expect(res.status).toBe(200);
    expect(team.editorsOf(acme)).toEqual([]);
    expect(team.assignments()).toEqual({});
  });

  it('refuses a login that is not on the team, changing nothing', async () => {
    team.setEditors(acme, 'Acme', ['yael@example.com']);
    const res = await call('PUT', `/api/clients/${acme}/assignees`, OWNER, {
      editors: ['amit@example.com', 'ghost@example.com'],
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error).toContain('ghost@example.com');
    expect(team.editorsOf(acme)).toEqual(['yael@example.com']);
    expect(changed()).toBe(0);
  });

  it('refuses an admin as an editor of a client', async () => {
    const res = await call('PUT', `/api/clients/${acme}/assignees`, OWNER, {
      editors: ['boss@example.com'],
    });
    expect(res.status).toBe(400);
    expect(team.editorsOf(acme)).toEqual([]);
  });

  it('answers 404 for an unknown client and 400 for a body without editors', async () => {
    const unknown = await call('PUT', '/api/clients/nope/assignees', OWNER, { editors: [] });
    expect(unknown.status).toBe(404);
    const bad = await call('PUT', `/api/clients/${acme}/assignees`, OWNER, {
      editors: 'yael@example.com',
    });
    expect(bad.status).toBe(400);
    expect(changed()).toBe(0);
  });
});

describe('who sees an unassigned client', () => {
  it('is the admin only until editors are assigned', async () => {
    expect(team.canSee({ email: 'yael@example.com', role: 'editor' }, acme)).toBe(false);
    expect(team.canSee({ email: OWNER, role: 'admin' }, acme)).toBe(true);

    await call('PUT', `/api/clients/${acme}/assignees`, OWNER, { editors: ['yael@example.com'] });

    expect(team.canSee({ email: 'yael@example.com', role: 'editor' }, acme)).toBe(true);
    expect(team.canSee({ email: 'amit@example.com', role: 'editor' }, acme)).toBe(false);
    expect(team.canSee({ email: 'yael@example.com', role: 'editor' }, beta)).toBe(false);
  });
});

describe('without the team routes', () => {
  it('has no /api/team', async () => {
    const bare = createApp({});
    expect((await bare.request('/api/team')).status).toBe(404);
  });
});
