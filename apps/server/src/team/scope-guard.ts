// The scope guard (Team plan, TM1): the enforcement of "an editor sees only their clients".
//
// It runs on every /api request, after the viewer middleware (remote/viewer.ts) and before any
// route, and looks the request up in the route table (route-policies.ts):
//
//   - The admin passes everything.
//   - An editor passes a route only when every row that matches the request lets them: `any` and
//     `filtered` always, `job`, `client` and `series` when the thing the path (or the body) names
//     belongs to a client the editor is assigned to, `batch` when every id in the body does.
//   - A request that no row matches is refused: 403 "Not allowed.", whatever the path says, so it
//     never tells whether anything is there. Admin-only rows answer the same 403.
//   - A job, client or series that is out of scope answers 404 `{ error: "Not found" }`, which is
//     also the answer for one that does not exist (and for any path the engine has no route for):
//     whether it exists must not leak.
//
// The path is read the way Hono routes it (`c.req.path`: the percent-escapes decoded except the
// reserved characters, so `%2F` stays an escape) and split into segments; a segment that names an
// id is decoded once more, as Hono does for the route's params. Case, a trailing slash, an empty
// segment or `..` therefore either reach the same handler a plain path would (and are checked as
// such) or match no route and no row.

import type { TeamRole } from '@studio/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../remote/viewer.js';
import {
  type BodyCheck,
  PLANNED_ROUTES,
  ROUTE_POLICIES,
  type RoutePolicy,
  type Subject,
} from './route-policies.js';

/** What the guard asks of the engine. */
export interface ScopeResolver {
  /** Whether this viewer may see the client (an unassigned client is the admin's alone). */
  canSee(viewer: { email: string; role: TeamRole }, clientId: string): boolean;
  /** The client a job (or a delivery kept after its job) belongs to; null for an unknown id. */
  clientOfJob(jobId: string): string | null;
  /** The client a series belongs to; null for an unknown id. */
  clientOfSeries(seriesId: string): string | null;
}

/** Nobody is in scope: the resolver of an app that has no team. */
export const NO_SCOPE: ScopeResolver = {
  canSee: () => false,
  clientOfJob: () => null,
  clientOfSeries: () => null,
};

export const NOT_ALLOWED = 'Not allowed.';
export const NOT_FOUND = 'Not found';
const BAD_BODY = 'Send the request as JSON.';

/** Big enough for 200 ids, small enough to read twice. */
const MAX_BODY_BYTES = 256 * 1024;

type Segment =
  | { kind: 'literal'; text: string }
  | { kind: 'param'; name: string }
  | { kind: 'rest'; min: 0 | 1 };

interface CompiledRow {
  row: RoutePolicy;
  segments: Segment[];
}

function compile(row: RoutePolicy): CompiledRow {
  const segments = row.pattern
    .split('/')
    .slice(1)
    .map((part): Segment => {
      if (part === '*') return { kind: 'rest', min: 0 };
      if (part.startsWith(':')) {
        const name = part.slice(1);
        const rest = name.indexOf('{');
        if (rest !== -1) return { kind: 'rest', min: 1 };
        return { kind: 'param', name };
      }
      return { kind: 'literal', text: part };
    });
  return { row, segments };
}

/** The params of the pattern when the path is one it matches, else null. */
function matchPath(compiled: CompiledRow, parts: readonly string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  const { segments } = compiled;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined) return null;
    if (segment.kind === 'rest') {
      // A rest segment ends the pattern: what is left of the path must not be empty (`:path{.+}`),
      // or may be (`*`).
      const left = parts.slice(i);
      return segment.min === 0 || left.join('/') !== '' ? params : null;
    }
    const part = parts[i];
    if (part === undefined || part === '') return null;
    if (segment.kind === 'literal') {
      if (part !== segment.text) return null;
    } else {
      params[segment.name] = decodeParam(part);
    }
  }
  return parts.length === segments.length ? params : null;
}

/** A route param as Hono hands it to a handler: decoded once more when it holds an escape. */
function decodeParam(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function methodMatches(rowMethod: string, method: string): boolean {
  if (rowMethod === '*') return true;
  // Hono answers HEAD with the GET handler.
  return rowMethod === method || (method === 'HEAD' && rowMethod === 'GET');
}

export interface ScopeGuardOptions {
  scope?: ScopeResolver;
  /** Extra rows, for tests. Default: the table. */
  rows?: readonly RoutePolicy[];
}

export function scopeGuard(options: ScopeGuardOptions = {}): MiddlewareHandler<AppEnv> {
  const scope = options.scope ?? NO_SCOPE;
  const compiled = (options.rows ?? [...ROUTE_POLICIES, ...PLANNED_ROUTES]).map(compile);

  return async (c, next) => {
    const path = c.req.path;
    if (path !== '/api' && !path.startsWith('/api/')) {
      await next();
      return;
    }
    const viewer = c.get('viewer');
    if (viewer.role === 'admin') {
      await next();
      return;
    }

    const forbidden = () => c.json({ error: NOT_ALLOWED }, 403);
    const notFound = () => c.json({ error: NOT_FOUND }, 404);

    const parts = path.split('/').slice(1);
    const method = c.req.method;
    const matches: { row: RoutePolicy; params: Record<string, string> }[] = [];
    for (const candidate of compiled) {
      if (!methodMatches(candidate.row.method, method)) continue;
      const params = matchPath(candidate, parts);
      if (params !== null) matches.push({ row: candidate.row, params });
    }
    if (matches.length === 0) return forbidden();

    const inScope = (subject: Subject, id: string): boolean => {
      const clientId =
        subject === 'client'
          ? id
          : subject === 'job'
            ? scope.clientOfJob(id)
            : scope.clientOfSeries(id);
      return clientId !== null && scope.canSee(viewer, clientId);
    };

    // The body, read once and only when a row asks for it. Read from a copy: the handler reads it too.
    let body: Record<string, unknown> | null | undefined;
    const readBody = async (): Promise<Record<string, unknown> | null> => {
      if (body !== undefined) return body;
      body = null;
      const length = Number(c.req.header('content-length'));
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) return body;
      try {
        const text = await c.req.raw.clone().text();
        if (text.length > MAX_BODY_BYTES) return body;
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        // Not JSON: no ids to check, and the handler answers 400 for it.
      }
      return body;
    };

    /** Whether the body's field is in scope: true, false, or 'bad' when the body is not usable. */
    const bodyAllows = async (check: BodyCheck): Promise<boolean | 'bad'> => {
      const json = await readBody();
      if (json === null) return check.nullable === true ? true : 'bad';
      const value = json[check.field];
      if (check.nullable === true && (value === undefined || value === null)) return true;
      if (check.many === true) {
        if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return 'bad';
        return value.every((item: string) => inScope(check.subject, item));
      }
      if (typeof value !== 'string') return 'bad';
      return inScope(check.subject, value);
    };

    for (const { row, params } of matches) {
      switch (row.policy) {
        case 'any':
        case 'filtered':
          break;
        case 'admin':
          return forbidden();
        case 'job': {
          const id = params.id ?? params.jobId;
          if (id === undefined || !inScope('job', id)) return notFound();
          break;
        }
        case 'client': {
          const id = params.clientId ?? params.id;
          if (id === undefined || !inScope('client', id)) return notFound();
          break;
        }
        case 'series': {
          const id = params.seriesId ?? params.id;
          if (id === undefined || !inScope('series', id)) return notFound();
          break;
        }
        case 'batch':
          break;
      }
      for (const check of row.body ?? []) {
        const allowed = await bodyAllows(check);
        if (allowed === 'bad') return c.json({ error: BAD_BODY }, 400);
        if (!allowed) return notFound();
      }
    }
    await next();
  };
}
