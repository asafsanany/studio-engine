import type { TeamUser } from '@studio/shared';

/** The ticked logins after the checkbox of `email` is set to `on`. */
export function tickedAfter(
  ticked: ReadonlySet<string>,
  email: string,
  on: boolean,
): ReadonlySet<string> {
  const next = new Set(ticked);
  if (on) next.add(email);
  else next.delete(email);
  return next;
}

/**
 * The list Save sends: the ticked logins that are editors on the team now (a login that was removed
 * from the team, or made an admin, is dropped: the server refuses both), in the team's order.
 */
export function editorsToSend(
  editors: readonly Pick<TeamUser, 'email'>[],
  ticked: ReadonlySet<string>,
): string[] {
  return editors.map((user) => user.email).filter((email) => ticked.has(email));
}
