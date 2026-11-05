import { join } from 'node:path';
import type { Job } from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDirs, loadConfig } from '../config.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { createEngine, type Engine } from '../engine.js';
import { RunnerUnavailableError } from '../pipeline/create-runner.js';
import { makeTempDir, noBuiltInLuts } from '../test-temp.js';
import { PLANNED_ROUTES, ROUTE_POLICIES, type RoutePolicy } from './route-policies.js';
import { NOT_ALLOWED, NOT_FOUND } from './scope-guard.js';
import { TeamService } from './team-service.js';

// The scope guard on the whole engine (Team plan, TM1): every route has a row in the table, and an
// editor gets nothing of a client who is not theirs, whatever the path looks like.

const MAC = 'studio-mac.tail1234.ts.net';
const YAEL = 'yael@example.com';
const AMIT = 'amit@example.com';

const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
});

interface World {
  engine: Engine;
  team: TeamService;
  app: Hono;
  /** Yael's client, Amit's client and a client nobody is assigned to. */
  own: Job;
  other: Job;
  unassigned: Job;
  ownSeries: string;
  otherSeries: string;
}

function boot(env: Record<string, string>): World {
  const home = makeTempDir('studio-scope-');
  const config = loadConfig({ home, env });
  ensureDirs(config);
  const team = new TeamService(join(home, 'team.json'));
  team.upsertUser({ email: YAEL, name: 'Yael', role: 'editor' });
  team.upsertUser({ email: AMIT, name: 'Amit', role: 'editor' });

  const engine = createEngine({
    builtInLuts: noBuiltInLuts(),
    config,
    db: memoryDb(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createRunner: () => {
      throw new RunnerUnavailableError('claude', 'E3');
    },
    remoteAccess: () => ({ hosts: [MAC], logins: ['owner@example.com'] }),
    team,
    openFolder: async () => {},
    revealFile: async () => {},
    settings: { configPath: join(home, 'config.json'), restart: null },
  });
  engines.push(engine);

  const seed = (client: string): Job =>
    engine.jobs.upsertFromScan(makeScan(client, 'Edit one')).job;
  const own = seed('Yael Client');
  const other = seed('Amit Client');
  const unassigned = seed('Nobody Client');
  team.setEditors(own.clientId, own.client, [YAEL]);
  team.setEditors(other.clientId, other.client, [AMIT]);

  const series = (job: Job, name: string): string =>
    engine.seriesRepo.create({
      clientId: job.clientId,
      client: job.client,
      name,
      formatJobId: job.id,
      formatJob: job.name,
    }).id;
  return {
    engine,
    team,
    app: engine.app,
    own,
    other,
    unassigned,
    ownSeries: series(own, 'Own show'),
    otherSeries: series(other, 'Other show'),
  };
}

const ALL_ON = {
  STUDIO_MUSIC: '1',
  STUDIO_SONGS: '1',
  STUDIO_GRAPHICS: '1',
  STUDIO_ANALYTICS: '1',
  STUDIO_LUTS: '1',
  STUDIO_FONTS: '1',
  STUDIO_QUICK_FIXES: '1',
  STUDIO_GENERATE: '1',
  STUDIO_DRAFT_CHAT: '1',
  STUDIO_INSTAGRAM: '1',
};
const ALL_OFF = {
  STUDIO_MUSIC: '0',
  STUDIO_SONGS: '0',
  STUDIO_GRAPHICS: '0',
  STUDIO_ANALYTICS: '0',
  STUDIO_LUTS: '0',
  STUDIO_FONTS: '0',
  STUDIO_QUICK_FIXES: '0',
  STUDIO_GENERATE: '0',
  STUDIO_DRAFT_CHAT: '0',
  STUDIO_INSTAGRAM: '0',
};

type Who = 'admin' | typeof YAEL | typeof AMIT;

const socket = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

async function call(
  app: Hono,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const host = who === 'admin' ? '127.0.0.1:4310' : MAC;
  const headers: Record<string, string> = { host };
  if (who !== 'admin') {
    Object.assign(headers, {
      'x-forwarded-for': '100.101.102.103',
      'x-forwarded-host': MAC,
      'x-forwarded-proto': 'https',
      'tailscale-user-login': who,
    });
  }
  let payload: string | undefined;
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await app.request(
    `http://${host}${path}`,
    { method, headers, ...(payload === undefined ? {} : { body: payload }) },
    socket,
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: a file.
  }
  return { status: res.status, json, text };
}

const GUARD_404 = { error: NOT_FOUND };
const GUARD_403 = { error: NOT_ALLOWED };

// --- the table against the routes the app really has ------------------------------------------

/** `/api/jobs/:id/x` and `/api/jobs/:jobId/x` are the same route. */
const shape = (pattern: string): string => pattern.replace(/:[A-Za-z]+/g, ':p');

function routesOf(app: Hono): { method: string; path: string }[] {
  return app.routes
    .filter((route) => route.path.startsWith('/api/') && route.path !== '/api/*')
    .map(({ method, path }) => ({ method, path }));
}

function covers(row: RoutePolicy, route: { method: string; path: string }): boolean {
  if (row.method !== '*' && row.method !== route.method) return false;
  if (shape(row.pattern) === shape(route.path)) return true;
  if (row.pattern.endsWith('/*')) {
    const prefix = row.pattern.slice(0, -2);
    return route.path === prefix || route.path.startsWith(`${prefix}/`);
  }
  return false;
}

const TABLE = [...ROUTE_POLICIES, ...PLANNED_ROUTES];

describe('the route table', () => {
  it('has a policy for every route the app has, with every switch on and off', () => {
    const missing: string[] = [];
    for (const env of [ALL_ON, ALL_OFF]) {
      for (const route of routesOf(boot(env).app)) {
        if (!TABLE.some((row) => covers(row, route))) missing.push(`${route.method} ${route.path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has no row for a route that is not there (a typo would leave the real route closed)', () => {
    const routes = [...routesOf(boot(ALL_ON).app), ...routesOf(boot(ALL_OFF).app)];
    const stale = ROUTE_POLICIES.filter((row) => !routes.some((route) => covers(row, route)));
    expect(stale.map((row) => `${row.method} ${row.pattern}`)).toEqual([]);
  });
});

// --- an editor probes every route for a client that is not theirs ---------------------------------

/** A concrete path for a route, naming the job, client and series given. */
function concrete(
  path: string,
  ids: { job: string; client: string; series: string },
  rest = 'edit/index.html',
): string {
  return path
    .replace(/:path\{\.\+\}/, rest)
    .replace(/:(id|jobId)(?=\/|$)/, ids.job)
    .replace(':clientId', ids.client)
    .replace(':seriesId', ids.series)
    .replace(':noteId', 'note0000001')
    .replace(':fixId', 'fix0000001')
    .replace(':name', 'shot.png')
    .replace(':n', '1')
    .replace(':mid', 'mid')
    .replace(':file', 'frame.svg')
    .replace(':id', 'x')
    .replace(/\/\*$/, '/anything');
}

/** The request body that names the foreign things, for the routes that read one. */
function bodyFor(path: string, ids: { job: string; series: string; ownJob: string }): unknown {
  if (path === '/api/jobs/archive' || path === '/api/jobs/unarchive') {
    return { ids: [ids.ownJob, ids.job] };
  }
  if (path === '/api/payments' || path === '/api/payments/undo') {
    return { jobIds: [ids.ownJob, ids.job], paidOn: '2026-10-23' };
  }
  if (path === '/api/jobs/:jobId/series') return { seriesId: ids.series, name: 'Show' };
  if (path === '/api/series/:seriesId/format') return { jobId: ids.job };
  return { note: 'hello', effort: null, sec: 5, text: 'hello', ask: 'calm', name: 'Show' };
}

function rowFor(method: string, path: string): RoutePolicy {
  const row = TABLE.find((candidate) => covers(candidate, { method, path }));
  if (row === undefined) throw new Error(`no row for ${method} ${path}`);
  return row;
}

describe('an editor asks for a client that is not theirs', () => {
  let world: World;
  beforeEach(() => {
    world = boot(ALL_ON);
  });

  for (const target of ['other', 'unassigned'] as const) {
    it(`gets 404 or 403 from every route (${target} client), the same as for a missing one`, async () => {
      const { app, own } = world;
      const foreign = world[target];
      const foreignSeries = target === 'other' ? world.otherSeries : 'nosuchseries';
      const ids = { job: foreign.id, client: foreign.clientId, series: foreignSeries };
      const missing = { job: 'nosuchjob000', client: 'nosuchclient', series: 'nosuchseries' };
      const wrong: string[] = [];
      let probed = 0;

      for (const route of routesOf(app)) {
        const row = rowFor(route.method, route.path);
        if (row.policy === 'any' || row.policy === 'filtered') continue;
        const method = route.method === 'ALL' ? 'GET' : route.method;
        for (const [rest, extra] of [
          ['edit/index.html', ''],
          ['../../x', ''],
          ['..%2F..%2Fx', ''],
        ] as const) {
          if (!route.path.includes('{') && rest !== 'edit/index.html') continue;
          const send = (set: typeof ids) =>
            call(
              app,
              YAEL,
              method,
              concrete(route.path, set, rest) + extra,
              method === 'GET' || method === 'DELETE'
                ? undefined
                : bodyFor(route.path, { ...set, ownJob: own.id }),
            );
          const res = await send(ids);
          probed += 1;
          const expected = row.policy === 'admin' ? GUARD_403 : GUARD_404;
          const expectedStatus = row.policy === 'admin' ? 403 : 404;
          // `..` in the path is resolved by the URL parser before the app sees it, and what is
          // left may be a path no route has (403): refused either way.
          const resolved = rest !== 'edit/index.html' && res.status === 403;
          if (
            !resolved &&
            (res.status !== expectedStatus || JSON.stringify(res.json) !== JSON.stringify(expected))
          ) {
            wrong.push(`${method} ${route.path} -> ${res.status} ${res.text.slice(0, 80)}`);
          }
          // A job that does not exist is answered exactly like one that is not theirs.
          if (row.policy !== 'admin') {
            const gone = await send(missing);
            if (gone.status !== res.status || gone.text !== res.text) {
              wrong.push(`${method} ${route.path} differs for a missing one: ${gone.text}`);
            }
          }
        }
      }
      expect(probed).toBeGreaterThan(60);
      expect(wrong).toEqual([]);
    });
  }

  it('is refused every route that has no row, with the same 403 whatever the path', async () => {
    const { app, other } = world;
    for (const path of [
      '/api/nothing',
      '/api/jobs/x/y/z',
      `/api/jobs/${other.id}/unknown`,
      '/api/jobs/nosuchjob000/unknown',
      '/api/team/x',
    ]) {
      const res = await call(app, YAEL, 'GET', path);
      expect(res.status, path).toBe(403);
      expect(res.json, path).toEqual(GUARD_403);
    }
    // A write to a path whose GET is open is still a different route.
    const res = await call(app, YAEL, 'POST', '/api/jobs', {});
    expect(res.status).toBe(403);
  });

  it('reads nothing of the other client through path tricks', async () => {
    const { app, own, other } = world;
    const attempts: [string, string][] = [
      ['GET', `/api/jobs/${other.id.toUpperCase()}/steps`],
      ['GET', `/api/jobs/${other.id}/steps/`],
      ['GET', `/api/jobs/${other.id}/steps//`],
      ['GET', `//api/jobs/${other.id}/steps`],
      ['GET', `/api/jobs/${other.id}%00/steps`],
      ['GET', `/api/jobs/${other.id}%2Fsteps`],
      ['GET', `/api/jobs/${own.id}%2F..%2F${other.id}/steps`],
      ['GET', `/api/jobs/${own.id}/../${other.id}/steps`],
      ['GET', `/api/jobs/${own.id}/%2e%2e/${other.id}/steps`],
      ['GET', `/api/jobs/%2e%2e/${other.id}/steps`],
      ['GET', `/api/jobs/${own.id}/steps/../../${other.id}/steps`],
      ['GET', `/api/jobs/%${other.id.charCodeAt(0).toString(16)}${other.id.slice(1)}/steps`],
      ['GET', `/api/jobs/${other.id}/preview/edit/index.html`],
      ['GET', `/api/jobs/${own.id}/preview/..%2F..%2F${other.id}%2Fedit%2Findex.html`],
      ['GET', `/api/jobs/${own.id}/preview/%2e%2e/%2e%2e/${other.id}/edit/index.html`],
      ['GET', `/api/jobs/${other.id}/preview-poster`],
      ['GET', `/api/jobs/${other.id}/preview-video.mp4`],
      ['GET', `/api/jobs/${other.id}/download`],
      ['HEAD', `/api/jobs/${other.id}/download`],
      ['GET', `/api/jobs/${other.id}/review-export.mp4`],
      ['POST', `/api/jobs/${other.id}/review-export`],
      ['GET', `/api/jobs/${other.id}/notes/n1/audio`],
      ['GET', `/api/jobs/${other.id}/still`],
      ['GET', `/api/jobs/${other.id}/music`],
      ['GET', `/api/jobs/${other.id}/note`],
      ['POST', `/api/jobs/${other.id}/note/attachments`],
      ['GET', `/api/jobs/${other.id}/note/attachments/shot.png`],
      ['DELETE', `/api/jobs/${other.id}/note/attachments/shot.png`],
      ['GET', `/api/clients/${other.clientId}/style`],
      ['GET', `/api/clients/${other.clientId}/style/`],
      ['GET', `/api/clients/${other.clientId.toUpperCase()}/style`],
      ['GET', `/api/clients/${own.clientId}%2F..%2F${other.clientId}/style`],
      ['POST', `/api/clients/${other.clientId}/style/files`],
      ['GET', `/api/clients/${other.clientId}/series`],
      ['GET', `/api/series/${world.otherSeries}`],
      ['GET', `/api/series/${world.otherSeries}?x=${own.clientId}`],
      ['POST', `/api/series/${world.otherSeries}/retry`],
      ['DELETE', `/api/jobs/${other.id}`],
      ['POST', `/api/jobs/${other.id}/reveal`],
      ['POST', `/api/clients/${other.clientId}/reveal`],
      ['GET', '/api/money'],
      ['GET', '/api/analytics'],
      ['GET', '/api/graphics'],
      ['GET', '/api/graphics/assets/frame.svg'],
      ['GET', '/api/luts'],
      ['GET', '/api/luts/golden-hour-warm/preview/person/after.jpg'],
      ['GET', '/api/fonts'],
      ['GET', '/api/fonts/heebo'],
      ['GET', '/api/fonts/file/3f9a1c7e5b20'],
      ['GET', '/api/fonts/frame/person.jpg'],
      ['DELETE', '/api/fonts/requests/3f9a1c7e5b20'],
    ];
    for (const [method, path] of attempts) {
      const res = await call(app, YAEL, method, path);
      // Never a 2xx, never anything of the other client's.
      expect([403, 404], `${method} ${path} -> ${res.status} ${res.text.slice(0, 80)}`).toContain(
        res.status,
      );
      expect(res.text, `${method} ${path}`).not.toContain(other.client);
      expect(res.text, `${method} ${path}`).not.toContain(other.id);
    }
  });

  it('cannot reach a foreign job or series through a body either', async () => {
    const { app, own, other } = world;
    const cases: [string, string, unknown][] = [
      ['POST', '/api/jobs/archive', { ids: [own.id, other.id] }],
      ['POST', '/api/jobs/unarchive', { ids: [other.id] }],
      ['PUT', `/api/jobs/${own.id}/series`, { seriesId: world.otherSeries }],
      ['POST', `/api/series/${world.ownSeries}/format`, { jobId: other.id }],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(app, YAEL, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.json, `${method} ${path}`).toEqual(GUARD_404);
    }
    // Nothing was archived on the way.
    expect(world.engine.jobs.get(other.id)?.archivedAt ?? null).toBeNull();
    expect(world.engine.jobs.get(own.id)?.archivedAt ?? null).toBeNull();
  });

  it('answers a batch of unusable bodies with 400, not with anything of the jobs', async () => {
    const { app } = world;
    for (const body of [{}, { ids: 'x' }, { ids: [1] }, { ids: null }]) {
      const res = await call(app, YAEL, 'POST', '/api/jobs/archive', body);
      expect(res.status).toBe(400);
    }
  });
});

describe('an editor on their own client', () => {
  it('can use the routes of their own jobs, client and series', async () => {
    const { app, own, ownSeries } = boot(ALL_ON);
    const requests: [string, string, unknown?][] = [
      ['GET', `/api/jobs/${own.id}/steps`],
      ['GET', `/api/jobs/${own.id}/sent-notes`],
      ['GET', `/api/jobs/${own.id}/notes`],
      ['PUT', `/api/jobs/${own.id}/note`, { note: 'calm' }],
      ['GET', `/api/jobs/${own.id}/note`],
      ['DELETE', `/api/jobs/${own.id}/note/attachments/shot.png`],
      ['PUT', `/api/jobs/${own.id}/effort`, { effort: 'high' }],
      ['PUT', `/api/jobs/${own.id}/review-effort`, { effort: 'auto' }],
      ['POST', `/api/jobs/${own.id}/hold`],
      ['POST', `/api/jobs/${own.id}/release`],
      ['POST', `/api/jobs/${own.id}/start`],
      ['POST', `/api/jobs/${own.id}/retry`],
      ['POST', `/api/jobs/${own.id}/cancel`],
      ['POST', `/api/jobs/${own.id}/send-notes`],
      ['POST', `/api/jobs/${own.id}/approve`],
      ['POST', `/api/jobs/${own.id}/review-time`, { sec: 5 }],
      ['GET', `/api/jobs/${own.id}/download`],
      ['HEAD', `/api/jobs/${own.id}/download`],
      ['GET', `/api/jobs/${own.id}/preview/edit/index.html`],
      ['GET', `/api/jobs/${own.id}/preview-poster`],
      ['GET', `/api/jobs/${own.id}/preview-video`],
      ['POST', `/api/jobs/${own.id}/review-export`],
      ['GET', `/api/jobs/${own.id}/review-export`],
      ['GET', `/api/jobs/${own.id}/review-export.mp4`],
      ['POST', `/api/jobs/${own.id}/notes`, { text: 'tighter' }],
      ['POST', `/api/jobs/${own.id}/use-look`],
      ['GET', `/api/jobs/${own.id}/still`],
      ['GET', `/api/jobs/${own.id}/music`],
      ['PUT', `/api/jobs/${own.id}/series`, { seriesId: ownSeries }],
      ['PUT', `/api/jobs/${own.id}/series`, { seriesId: null }],
      ['POST', `/api/jobs/archive`, { ids: [own.id] }],
      ['POST', `/api/jobs/unarchive`, { ids: [own.id] }],
      ['GET', `/api/clients/${own.clientId}/style`],
      ['POST', `/api/clients/${own.clientId}/style/retry`],
      ['POST', `/api/clients/${own.clientId}/style/undo`],
      ['GET', `/api/clients/${own.clientId}/series`],
      ['GET', `/api/clients/${own.clientId}/instagram`],
      ['GET', `/api/clients/${own.clientId}/photo`],
      ['GET', `/api/series/${ownSeries}`],
      ['POST', `/api/series/${ownSeries}/retry`],
      ['GET', '/api/me'],
      ['GET', '/api/health'],
      ['GET', '/api/jobs'],
      ['GET', '/api/clients'],
    ];
    const blocked: string[] = [];
    for (const [method, path, body] of requests) {
      const res = await call(app, YAEL, method, path, body);
      const error = (res.json as { error?: string } | null)?.error;
      if (error === NOT_FOUND || error === NOT_ALLOWED || res.status === 403) {
        blocked.push(`${method} ${path} -> ${res.status} ${res.text.slice(0, 80)}`);
      }
    }
    expect(blocked).toEqual([]);
  });

  it('is refused the admin-only routes even on their own client', async () => {
    const { app, own } = boot(ALL_ON);
    for (const [method, path] of [
      ['DELETE', `/api/jobs/${own.id}`],
      ['POST', `/api/jobs/${own.id}/reveal`],
      ['POST', `/api/clients/${own.clientId}/reveal`],
      ['POST', '/api/instagram/reels/C9xYz12AbCd/link'],
      ['DELETE', '/api/instagram/reels/C9xYz12AbCd/link'],
      ['GET', '/api/money'],
      ['POST', `/api/jobs/${own.id}/deliver`],
      ['POST', `/api/jobs/${own.id}/undeliver`],
      ['POST', '/api/payments', { jobIds: [own.id], paidOn: '2026-10-23' }],
      ['POST', '/api/payments/undo', { jobIds: [own.id] }],
      ['GET', '/api/money/price'],
      ['GET', '/api/analytics'],
      ['GET', '/api/graphics'],
      ['POST', '/api/graphics'],
      ['GET', '/api/luts'],
      ['POST', '/api/luts/import'],
      ['GET', '/api/fonts'],
      ['POST', '/api/fonts/import'],
      ['POST', '/api/fonts/stage'],
      ['DELETE', '/api/fonts/heebo'],
      ['DELETE', '/api/fonts/requests/3f9a1c7e5b20'],
    ] as const) {
      const res = await call(app, YAEL, method, path, {});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json).toEqual(GUARD_403);
    }
  });

  it('sees only their own client when two editors share the engine', async () => {
    const w = boot(ALL_ON);
    expect((await call(w.app, AMIT, 'GET', `/api/jobs/${w.own.id}/steps`)).status).toBe(404);
    expect((await call(w.app, AMIT, 'GET', `/api/jobs/${w.other.id}/steps`)).status).toBe(200);
  });

  it('sees a client at once when it is assigned to them, and loses it when it is not (team.json is read live)', async () => {
    const w = boot(ALL_ON);
    const path = `/api/jobs/${w.unassigned.id}/steps`;
    expect((await call(w.app, YAEL, 'GET', path)).status).toBe(404);
    w.team.setEditors(w.unassigned.clientId, w.unassigned.client, [YAEL]);
    expect((await call(w.app, YAEL, 'GET', path)).status).toBe(200);
    w.team.setEditors(w.unassigned.clientId, w.unassigned.client, []);
    expect((await call(w.app, YAEL, 'GET', path)).status).toBe(404);
  });

  it('gets “Music is off.” from the handler for their own job, and the plain 404 for another', async () => {
    const w = boot(ALL_OFF);
    const own = await call(w.app, YAEL, 'GET', `/api/jobs/${w.own.id}/music`);
    expect(own.status).toBe(404);
    expect(own.json).not.toEqual(GUARD_404);
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const other = await call(w.app, YAEL, method, `/api/jobs/${w.other.id}/music/pick`);
      expect(other.json, method).toEqual(GUARD_404);
    }
  });
});

describe('the admin', () => {
  it('passes the guard everywhere, own client or not', async () => {
    const w = boot(ALL_ON);
    for (const [method, path] of [
      ['GET', `/api/jobs/${w.other.id}/steps`],
      ['GET', `/api/jobs/${w.unassigned.id}/notes`],
      ['GET', `/api/clients/${w.other.clientId}/style`],
      ['GET', `/api/series/${w.otherSeries}`],
      ['GET', '/api/money'],
      ['GET', '/api/graphics'],
      ['POST', `/api/jobs/${w.other.id}/hold`],
    ] as const) {
      const res = await call(w.app, 'admin', method, path);
      expect(res.status, `${method} ${path}`).not.toBe(403);
      expect(res.json, `${method} ${path}`).not.toEqual(GUARD_404);
    }
    expect((await call(w.app, 'admin', 'GET', '/api/jobs/nosuchjob/steps')).json).toEqual({
      error: 'Job nosuchjob not found',
    });
  });

  it('can delete a job and archive any jobs', async () => {
    const w = boot(ALL_ON);
    const archived = await call(w.app, 'admin', 'POST', '/api/jobs/archive', {
      ids: [w.own.id, w.other.id],
    });
    expect(archived.status).not.toBe(404);
    expect(archived.status).not.toBe(403);
    expect((await call(w.app, 'admin', 'DELETE', `/api/jobs/${w.other.id}`)).status).toBe(200);
  });
});

describe('without a team', () => {
  it('a plain request from this Mac is the admin and nothing is closed', async () => {
    const { createApp } = await import('../app.js');
    const app = createApp();
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/money')).status).toBe(404);
  });
});
