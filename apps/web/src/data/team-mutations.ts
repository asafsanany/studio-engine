// The team's actions (Team plan, TM5): add a person, change a role, remove a person, and set the
// editors of a client. The server decides (409 for a login that is on the team already, 400 for an
// admin named as an assignee), so nothing is optimistic. The server does not push `access.changed`
// to the browser, so every success loads the team and the client list again: the Team table, the
// Clients list's "Assigned to" column and the Assign to… dialog show the change at once.

import type {
  AddTeamUserRequest,
  AssigneesResponse,
  TeamUser,
  UpdateTeamUserRequest,
} from '@studio/shared';
import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { type Api, type ApiError, api } from './api';
import { CLIENTS_KEY } from './clients-query';
import { TEAM_KEY } from './team-query';

/** First element of each team mutation's key. */
export const TEAM_MUTATION_KEYS = {
  add: 'add-team-user',
  update: 'update-team-user',
  remove: 'remove-team-user',
  assign: 'set-client-assignees',
} as const;

export interface TeamMutationParams {
  queryClient: QueryClient;
  api: Api;
}

/** Loads the team and the client list again (the server's `access.changed` does not reach the web). */
export function reloadAccess(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: TEAM_KEY }),
    queryClient.invalidateQueries({ queryKey: CLIENTS_KEY }),
  ]);
}

/** Add person: resolves with the person; a refusal is an `ApiError` with the server's words. */
export function addTeamUserMutationOptions({ queryClient, api: client }: TeamMutationParams) {
  return mutationOptions<TeamUser, ApiError, AddTeamUserRequest>({
    mutationKey: [TEAM_MUTATION_KEYS.add],
    mutationFn: (person) => client.addTeamUser(person),
    onSuccess: () => reloadAccess(queryClient),
  });
}

/** Change a person's name and/or role. */
export function updateTeamUserMutationOptions({ queryClient, api: client }: TeamMutationParams) {
  return mutationOptions<TeamUser, ApiError, { email: string; patch: UpdateTeamUserRequest }>({
    mutationKey: [TEAM_MUTATION_KEYS.update],
    mutationFn: ({ email, patch }) => client.updateTeamUser(email, patch),
    onSuccess: () => reloadAccess(queryClient),
  });
}

/** Remove a person (and every assignment of theirs). */
export function removeTeamUserMutationOptions({ queryClient, api: client }: TeamMutationParams) {
  return mutationOptions<void, ApiError, string>({
    mutationKey: [TEAM_MUTATION_KEYS.remove],
    mutationFn: (email) => client.removeTeamUser(email),
    onSuccess: () => reloadAccess(queryClient),
  });
}

/** Replace the editors of a client. */
export function setAssigneesMutationOptions({ queryClient, api: client }: TeamMutationParams) {
  return mutationOptions<
    AssigneesResponse,
    ApiError,
    { clientId: string; editors: readonly string[] }
  >({
    mutationKey: [TEAM_MUTATION_KEYS.assign],
    mutationFn: ({ clientId, editors }) => client.setClientAssignees(clientId, editors),
    onSuccess: () => reloadAccess(queryClient),
  });
}

export function useAddTeamUser() {
  const queryClient = useQueryClient();
  return useMutation(addTeamUserMutationOptions({ queryClient, api }));
}

export function useUpdateTeamUser() {
  const queryClient = useQueryClient();
  return useMutation(updateTeamUserMutationOptions({ queryClient, api }));
}

export function useRemoveTeamUser() {
  const queryClient = useQueryClient();
  return useMutation(removeTeamUserMutationOptions({ queryClient, api }));
}

export function useSetAssignees() {
  const queryClient = useQueryClient();
  return useMutation(setAssigneesMutationOptions({ queryClient, api }));
}
