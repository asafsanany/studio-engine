// The team API (Team plan, TM3): who may open the engine besides the owner, and which clients each
// editor sees. Admin only. Mounted at the root of the API, because it lives under /team and under
// /clients:
//
//   GET    /team                        { users, assignments }: the team (not the owner, who is the
//                                       admin and is never stored) and each assigned client's
//                                       editors
//   POST   /team                        { name, email, role } adds a person and answers them (201).
//                                       The login is lowercased. 400 for a missing name or login, a
//                                       role that is not admin or editor, or the owner's own login
//                                       (the owner is an admin already); 409 when the login is on
//                                       the team already
//   PUT    /team/:email                 { name?, role? } changes a person and answers them; 404
//                                       for someone not on the team, 400 for a bad name or role
//   DELETE /team/:email                 removes a person and every assignment of theirs (nothing is
//                                       reassigned: a client left with no editors is for the admin
//                                       only) and answers { ok: true }; 404 for someone not on the
//                                       team
//   PUT    /clients/:clientId/assignees { editors: [login, …] } replaces the editors of a client
//                                       and answers { clientId, client, editors }. An empty list
//                                       makes the client admin-only. 404 for an unknown client; 400
//                                       for a login that is not on the team or is an admin's (an
//                                       admin sees every client)
//
// Every route is for admins: an editor gets 403 "Not allowed.", checked here because the central
// scope guard is a separate piece. Every change publishes `access.changed` on the event bus.
// Every error answers `{ error: string }` (the shared `apiErrorSchema`).

import {
  type AssigneesResponse,
  addTeamUserRequestSchema,
  setAssigneesRequestSchema,
  type TeamResponse,
  type TeamUser,
  updateTeamUserRequestSchema,
} from '@studio/shared';
import { type Context, Hono } from 'hono';
import { type ClientSources, findClient } from '../clients/lookup.js';
import type { AppEnv } from '../remote/viewer.js';
import type { TeamService } from '../team/team-service.js';

export interface TeamRouteOptions {
  /** The team, read and written live. */
  team: Pick<
    TeamService,
    'users' | 'find' | 'assignments' | 'upsertUser' | 'removeUser' | 'setEditors'
  >;
  /** What tells which clients exist. */
  clients: ClientSources;
  /** Told after every change: the engine publishes `access.changed`. */
  onChanged: () => void;
  /**
   * The logins that are admins without being on the team (the owner and `remoteLogins`), lowercase.
   * They cannot be added to the team. Default: none.
   */
  ownerLogins?: () => readonly string[];
}

const NOT_ALLOWED = 'Not allowed.';

/** Null for an admin; the 403 answer for anyone else (an editor, or no viewer at all). */
export function requireAdmin(c: Context): Response | null {
  const viewer = (c as unknown as Context<AppEnv>).get('viewer');
  if (viewer?.role === 'admin') return null;
  return c.json({ error: NOT_ALLOWED }, 403);
}

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createTeamRoutes(options: TeamRouteOptions): Hono {
  const { team, clients, onChanged } = options;
  const routes = new Hono();

  const unknownPerson = (email: string) => ({ error: `${email} is not on the team.` });

  routes.get('/team', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const body: TeamResponse = { users: team.users(), assignments: team.assignments() };
    return c.json(body);
  });

  routes.post('/team', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const request = addTeamUserRequestSchema.safeParse(await readJson(c));
    if (!request.success) {
      return c.json({ error: 'Send { "name", "email", "role": "admin" | "editor" }.' }, 400);
    }
    const { name, role } = request.data;
    const email = normaliseEmail(request.data.email);
    if (email === '' || /\s/.test(email)) return c.json({ error: 'Give them a login.' }, 400);
    if (name.trim() === '') return c.json({ error: 'Give them a name.' }, 400);
    if ((options.ownerLogins?.() ?? []).includes(email)) {
      return c.json({ error: 'That login is the owner: it is an admin already.' }, 400);
    }
    if (team.find(email) !== undefined) {
      return c.json({ error: `${email} is on the team already.` }, 409);
    }
    const user: TeamUser = { email, name: name.trim().normalize('NFC'), role };
    team.upsertUser(user);
    onChanged();
    return c.json(user, 201);
  });

  routes.put('/team/:email', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const email = normaliseEmail(c.req.param('email'));
    const current = team.find(email);
    if (current === undefined) return c.json(unknownPerson(email), 404);
    const request = updateTeamUserRequestSchema.safeParse(await readJson(c));
    if (!request.success) {
      return c.json({ error: 'Send { "name"?, "role"?: "admin" | "editor" }.' }, 400);
    }
    const name = request.data.name?.trim().normalize('NFC');
    if (name === '') return c.json({ error: 'Give them a name.' }, 400);
    const user: TeamUser = {
      email,
      name: name ?? current.name,
      role: request.data.role ?? current.role,
    };
    team.upsertUser(user);
    onChanged();
    return c.json(user);
  });

  routes.delete('/team/:email', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const email = normaliseEmail(c.req.param('email'));
    if (team.find(email) === undefined) return c.json(unknownPerson(email), 404);
    team.removeUser(email);
    onChanged();
    return c.json({ ok: true });
  });

  routes.put('/clients/:clientId/assignees', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const clientId = c.req.param('clientId');
    const client = findClient(clientId, clients);
    if (client === null) return c.json({ error: `Client ${clientId} not found` }, 404);
    const request = setAssigneesRequestSchema.safeParse(await readJson(c));
    if (!request.success) {
      return c.json({ error: 'Send the editors as { "editors": ["login", …] }.' }, 400);
    }
    const editors = [...new Set(request.data.editors.map(normaliseEmail))];
    for (const email of editors) {
      const person = team.find(email);
      if (person === undefined) {
        return c.json({ error: `${email} is not on the team. Add them first.` }, 400);
      }
      if (person.role !== 'editor') {
        return c.json({ error: `${email} is an admin: they see every client already.` }, 400);
      }
    }
    team.setEditors(clientId, client, editors);
    onChanged();
    const body: AssigneesResponse = { clientId, client, editors };
    return c.json(body);
  });

  return routes;
}
