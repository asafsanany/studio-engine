// Who is asking (Team plan, TM4): `GET /api/me`. The server is the real gate (the scope guard); the
// web only tidies up: an editor is not shown what the server would refuse.
//
// Until the answer is in nothing admin-only is shown (unknown is not admin). To keep the owner's own
// screen from flickering on every reload, the last role the engine gave is kept in this browser and
// used for the first paint, like the Phone switch; the answer then corrects it.

import { type MeResponse, type TeamRole, teamRoleSchema } from '@studio/shared';
import { queryOptions } from '@tanstack/react-query';
import type { Api, ApiError } from './api';

/** The TanStack Query key of the viewer's answer. */
export const ME_KEY = ['me'] as const;

/** Who is asking changes rarely (an admin changes someone's role): a minute is fresh enough. */
export const ME_STALE_MS = 60_000;

/** An engine too old to answer is asked a few times, then left alone (the viewer stays unknown). */
const ME_RETRIES = 2;

/** Options of the `['me']` query. */
export function meQueryOptions(api: Api) {
  return queryOptions<MeResponse, ApiError>({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => api.getMe(signal),
    staleTime: ME_STALE_MS,
    retry: ME_RETRIES,
  });
}

/** Whether the viewer is the admin. Not for `undefined`: until the engine has said, nobody is. */
export function isAdmin(me: Pick<MeResponse, 'role'> | undefined): boolean {
  return me?.role === 'admin';
}

/** The label of a role, as the sidebar footer says it: "Editor", "Admin". */
export function roleLabel(role: TeamRole): string {
  return role === 'admin' ? 'Admin' : 'Editor';
}

/**
 * The words that say who is signed in: "Yael · Editor". A person with no name is told by their
 * login (`email`), which the engine always has.
 */
export function signedInAs(me: MeResponse): string {
  const name = me.name.trim() === '' ? me.email : me.name.trim();
  return `${name} · ${roleLabel(me.role)}`;
}

/** localStorage key of the last known role. Bump the `v1` suffix with the shape. */
export const ROLE_KEY = 'studio.me.role.v1';

/** The two `Storage` methods used here. */
export interface RoleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserRoleStorage(): RoleStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Reading `window.localStorage` can throw (blocked site data).
    return null;
  }
}

/** The role the last answer left in `storage`; `null` when there is none or it is odd. */
export function readRememberedRole(
  storage: RoleStorage | null = browserRoleStorage(),
): TeamRole | null {
  try {
    const parsed = teamRoleSchema.safeParse(storage?.getItem(ROLE_KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    // Blocked site data: nothing is remembered.
    return null;
  }
}

/** Keeps the role for the next cold open. Never throws. */
export function rememberRole(
  role: TeamRole,
  storage: RoleStorage | null = browserRoleStorage(),
): void {
  try {
    storage?.setItem(ROLE_KEY, role);
  } catch {
    // Blocked site data or a full quota: the next open waits for the answer instead.
  }
}
