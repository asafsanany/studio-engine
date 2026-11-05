import type { AssigneesResponse, TeamResponse } from '@studio/shared';
import { MutationObserver, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from './api';
import { ApiError } from './api';
import { CLIENTS_KEY } from './clients-query';
import {
  addTeamUserMutationOptions,
  removeTeamUserMutationOptions,
  setAssigneesMutationOptions,
  updateTeamUserMutationOptions,
} from './team-mutations';
import {
  assignableEditors,
  assignedColumnHasContent,
  assigneeNames,
  clientsOfPerson,
  displayName,
  TEAM_KEY,
  teamQueryOptions,
} from './team-query';
import { createTestQueryClient, makeTeam } from './test-utils';

// The team query, its helpers and its mutations (TM5), over a fake Api.

function fakeApi(overrides: Partial<Api>): Api {
  return overrides as Api;
}

describe('the team helpers', () => {
  const team = makeTeam({
    users: [
      { email: 'zed@example.com', name: 'Zed', role: 'admin' },
      { email: 'yael@example.com', name: 'Yael', role: 'editor' },
      { email: 'amit@example.com', name: 'Amit', role: 'editor' },
      { email: 'dana@example.com', name: ' ', role: 'editor' },
    ],
    assignments: {
      c1: { client: 'Arc Fitness', editors: ['yael@example.com', 'amit@example.com'] },
      c2: { client: 'Kova Coffee', editors: ['yael@example.com'] },
      c3: { client: 'Gone', editors: ['ghost@example.com'] },
    },
  });

  it('offers only editors to assign, by name; an admin sees every client already', () => {
    expect(assignableEditors(team).map((user) => user.email)).toEqual([
      'amit@example.com',
      'dana@example.com',
      'yael@example.com',
    ]);
    expect(assignableEditors(undefined)).toEqual([]);
  });

  it('names a person, or tells them by their login when they have no name', () => {
    expect(displayName({ name: 'Yael', email: 'yael@example.com' })).toBe('Yael');
    expect(displayName({ name: ' ', email: 'dana@example.com' })).toBe('dana@example.com');
  });

  it('lists the names a client is assigned to, a login that left the team by the login', () => {
    expect(assigneeNames(team, 'c1')).toEqual(['Yael', 'Amit']);
    expect(assigneeNames(team, 'c3')).toEqual(['ghost@example.com']);
  });

  it('is empty for a client nobody has, and unknown until the team is', () => {
    expect(assigneeNames(team, 'nobody')).toEqual([]);
    expect(assigneeNames(undefined, 'c1')).toBeUndefined();
  });

  it('lists the clients a person is assigned to, by name', () => {
    expect(clientsOfPerson(team, 'yael@example.com')).toEqual(['Arc Fitness', 'Kova Coffee']);
    expect(clientsOfPerson(team, 'amit@example.com')).toEqual(['Arc Fitness']);
    expect(clientsOfPerson(undefined, 'yael@example.com')).toEqual([]);
  });
});

describe('assignedColumnHasContent: the Clients list’s Assigned to column', () => {
  const admin = { email: 'zed@example.com', name: 'Zed', role: 'admin' } as const;
  const yael = { email: 'yael@example.com', name: 'Yael', role: 'editor' } as const;

  it('is there while the team has an editor, assigned or not', () => {
    expect(
      assignedColumnHasContent(makeTeam({ users: [admin, yael], assignments: {} }), ['c1']),
    ).toBe(true);
  });

  it('is there when a client is assigned, even to a login that has left the team', () => {
    const team = makeTeam({
      users: [admin],
      assignments: { c3: { client: 'Gone', editors: ['ghost@example.com'] } },
    });
    expect(assignedColumnHasContent(team, ['c1', 'c3'])).toBe(true);
  });

  it('is left out when there is no editor and nobody in the list is assigned', () => {
    const noOne = makeTeam({ users: [admin], assignments: {} });
    expect(assignedColumnHasContent(noOne, ['c1', 'c2'])).toBe(false);
    expect(assignedColumnHasContent(noOne, [])).toBe(false);
    // An assignment of a client that is not in the list (or an empty one) shows nothing.
    const elsewhere = makeTeam({
      users: [admin],
      assignments: {
        c9: { client: 'Elsewhere', editors: ['ghost@example.com'] },
        c1: { client: 'Arc', editors: [] },
      },
    });
    expect(assignedColumnHasContent(elsewhere, ['c1', 'c2'])).toBe(false);
  });

  it('holds its place while the team is on its way, so a list with a team does not jump', () => {
    expect(assignedColumnHasContent(undefined, ['c1'], true)).toBe(true);
  });

  it('is left out when the team could not be read (nothing is known to show)', () => {
    expect(assignedColumnHasContent(undefined, ['c1'])).toBe(false);
    expect(assignedColumnHasContent(undefined, ['c1'], false)).toBe(false);
  });
});

describe('teamQueryOptions', () => {
  it("is cached under ['team'] and asks nothing for someone who is not the admin", () => {
    const api = fakeApi({ getTeam: vi.fn() });
    expect(teamQueryOptions(api).queryKey).toEqual(['team']);
    expect(teamQueryOptions(api, false).enabled).toBe(false);
  });

  it('loads the team', async () => {
    const api = fakeApi({ getTeam: async () => makeTeam() });
    const queryClient = createTestQueryClient();
    await expect(queryClient.fetchQuery(teamQueryOptions(api))).resolves.toEqual(makeTeam());
  });

  it('does not ask again after a 403 (an editor)', () => {
    const retry = teamQueryOptions(fakeApi({})).retry as (n: number, e: ApiError) => boolean;
    expect(retry(0, new ApiError(403, 'Not allowed.'))).toBe(false);
    expect(retry(0, new ApiError(0, 'down'))).toBe(true);
  });
});

describe('the team mutations', () => {
  function setup() {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(TEAM_KEY, makeTeam());
    queryClient.setQueryData(CLIENTS_KEY, []);
    return queryClient;
  }

  it('Add person sends the person and loads the team and the client list again', async () => {
    const added = { email: 'yael@example.com', name: 'Yael', role: 'editor' } as const;
    const addTeamUser = vi.fn(async () => added);
    const api = fakeApi({ addTeamUser });
    const queryClient = setup();
    const observer = new MutationObserver(
      queryClient,
      addTeamUserMutationOptions({ queryClient, api }),
    );
    await expect(
      observer.mutate({ name: 'Yael', email: 'yael@example.com', role: 'editor' }),
    ).resolves.toEqual(added);
    expect(addTeamUser).toHaveBeenCalledWith({
      name: 'Yael',
      email: 'yael@example.com',
      role: 'editor',
    });
    expect(queryClient.getQueryState(TEAM_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(CLIENTS_KEY)?.isInvalidated).toBe(true);
  });

  it('Add person hands the server’s refusal on, and loads nothing again', async () => {
    const api = fakeApi({
      addTeamUser: async () => {
        throw new ApiError(409, 'yael@example.com is on the team already.');
      },
    });
    const queryClient = setup();
    const observer = new MutationObserver(
      queryClient,
      addTeamUserMutationOptions({ queryClient, api }),
    );
    const refused = await observer
      .mutate({ name: 'Yael', email: 'yael@example.com', role: 'editor' })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({
      status: 409,
      message: 'yael@example.com is on the team already.',
    });
    expect(queryClient.getQueryState(TEAM_KEY)?.isInvalidated).toBe(false);
  });

  it('change role and Remove call the routes and refresh', async () => {
    const updateTeamUser = vi.fn(async () => ({
      email: 'yael@example.com',
      name: 'Yael',
      role: 'admin' as const,
    }));
    const removeTeamUser = vi.fn(async () => {});
    const api = fakeApi({ updateTeamUser, removeTeamUser });
    const queryClient = setup();
    await new MutationObserver(
      queryClient,
      updateTeamUserMutationOptions({ queryClient, api }),
    ).mutate({
      email: 'yael@example.com',
      patch: { role: 'admin' },
    });
    expect(updateTeamUser).toHaveBeenCalledWith('yael@example.com', { role: 'admin' });
    expect(queryClient.getQueryState(TEAM_KEY)?.isInvalidated).toBe(true);

    const second = setup();
    await new MutationObserver(
      second,
      removeTeamUserMutationOptions({ queryClient: second, api }),
    ).mutate('yael@example.com');
    expect(removeTeamUser).toHaveBeenCalledWith('yael@example.com');
    expect(second.getQueryState(TEAM_KEY)?.isInvalidated).toBe(true);
    expect(second.getQueryState(CLIENTS_KEY)?.isInvalidated).toBe(true);
  });
});

describe('the assign flow: Assign to… saves and the lists show it at once', () => {
  it('sends the ticked editors, and the watched team and client list are asked for again', async () => {
    // The fake server: the team as it is now, and what Assign to… changes.
    let team: TeamResponse = makeTeam();
    const getTeam = vi.fn(async () => team);
    const listClients = vi.fn(async () => []);
    const setClientAssignees = vi.fn(
      async (clientId: string, editors: readonly string[]): Promise<AssigneesResponse> => {
        team = {
          ...team,
          assignments: {
            ...team.assignments,
            [clientId]: { client: 'Kova Coffee', editors: [...editors] },
          },
        };
        return { clientId, client: 'Kova Coffee', editors: [...editors] };
      },
    );
    const api = fakeApi({ getTeam, listClients, setClientAssignees });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(CLIENTS_KEY, []);

    // A page that shows the team (the Team table) and one that shows the clients are open.
    const teamWatcher = new QueryObserver(queryClient, teamQueryOptions(api));
    const stop = teamWatcher.subscribe(() => {});
    const clientsWatcher = new QueryObserver(queryClient, {
      queryKey: CLIENTS_KEY,
      queryFn: () => api.listClients(),
      staleTime: Number.POSITIVE_INFINITY,
    });
    const stopClients = clientsWatcher.subscribe(() => {});
    await vi.waitFor(() => expect(teamWatcher.getCurrentResult().data).toEqual(makeTeam()));
    const clientsAsked = listClients.mock.calls.length;

    await new MutationObserver(
      queryClient,
      setAssigneesMutationOptions({ queryClient, api }),
    ).mutate({
      clientId: 'bbbbbbbbbbbb',
      editors: ['yael@example.com', 'amit@example.com'],
    });
    expect(setClientAssignees).toHaveBeenCalledWith('bbbbbbbbbbbb', [
      'yael@example.com',
      'amit@example.com',
    ]);

    // Both open lists ask the server again, and the team shows Yael and Amit on the client.
    await vi.waitFor(() => {
      expect(assigneeNames(teamWatcher.getCurrentResult().data, 'bbbbbbbbbbbb')).toEqual([
        'Yael',
        'Amit',
      ]);
      expect(listClients.mock.calls.length).toBeGreaterThan(clientsAsked);
    });
    stop();
    stopClients();
  });
});
