// The team (Team plan, TM5): who is on it and which editors each client is assigned to, from
// `GET /api/team` (admin only, so it is asked only while the viewer is the admin). The server does
// not push `access.changed` to the browser, so the mutations in team-mutations.ts refresh this
// query themselves. A second admin window is caught up when it is focused again.

import type { TeamResponse, TeamUser } from '@studio/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { type Api, ApiError, api } from './api';
import { useIsAdmin } from './hooks';

/** The TanStack Query key of the team. */
export const TEAM_KEY = ['team'] as const;

/** Only the admin changes the team, and does so through the mutations: half a minute is fresh. */
export const TEAM_STALE_MS = 30_000;

/** A 4xx (an editor, an engine too old to have the route) will not change by asking again. */
function retryUnless4xx(_count: number, error: ApiError): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/** Options of the `['team']` query. `enabled` is whether the viewer is the admin. */
export function teamQueryOptions(client: Api, enabled = true) {
  return queryOptions<TeamResponse, ApiError>({
    queryKey: TEAM_KEY,
    queryFn: ({ signal }) => client.getTeam(signal),
    staleTime: TEAM_STALE_MS,
    retry: retryUnless4xx,
    enabled,
  });
}

/**
 * The team, for the admin. `data` is `undefined` until the answer is in, and stays so for anyone
 * who is not the admin (nothing is asked).
 */
export function useTeam() {
  const admin = useIsAdmin();
  return useQuery(teamQueryOptions(api, admin));
}

/** Who may be assigned a client: the editors (an admin sees every client already), by name. */
export function assignableEditors(team: TeamResponse | undefined): TeamUser[] {
  return (team?.users ?? [])
    .filter((user) => user.role === 'editor')
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

/**
 * Whether the admin's "Assigned to" column on the Clients list has anything to show: the team has an
 * editor to assign a client to, or some client in the list is assigned to someone already (an editor
 * who has left the team still counts). With neither, every row would say "Unassigned", so the
 * column is left out (board L1 has four columns), and so it is when the team cannot be read.
 * While the team is still on its way (`pending`) the column holds its place, so a list that does
 * have a team does not jump when the answer comes.
 */
export function assignedColumnHasContent(
  team: TeamResponse | undefined,
  clientIds: readonly string[],
  pending = false,
): boolean {
  if (team === undefined) return pending;
  if (assignableEditors(team).length > 0) return true;
  return clientIds.some((clientId) => (team.assignments[clientId]?.editors ?? []).length > 0);
}

/** A person's name, or their login when they have none. */
export function displayName(user: Pick<TeamUser, 'name' | 'email'>): string {
  return user.name.trim() === '' ? user.email : user.name.trim();
}

/**
 * The names of the people a client is assigned to, in the order the assignment lists them; a login
 * that is not on the team (any more) is told by the login itself. An empty list: the client is for
 * the admin only. `undefined` until the team is known.
 */
export function assigneeNames(
  team: TeamResponse | undefined,
  clientId: string,
): string[] | undefined {
  if (team === undefined) return undefined;
  const emails = team.assignments[clientId]?.editors ?? [];
  return emails.map((email) => {
    const user = team.users.find((candidate) => candidate.email === email);
    return user === undefined ? email : displayName(user);
  });
}

/** The clients a person is assigned to, as the assignments name them, by name. */
export function clientsOfPerson(team: TeamResponse | undefined, email: string): string[] {
  if (team === undefined) return [];
  return Object.values(team.assignments)
    .filter((assignment) => assignment.editors.includes(email))
    .map((assignment) => assignment.client)
    .sort((a, b) => a.localeCompare(b));
}
