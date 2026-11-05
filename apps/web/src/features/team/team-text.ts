import type { TeamRole } from '@studio/shared';
import { ApiError } from '@/data';

/** The words of the Team page and its dialogs. */
export const TEAM_TEXT = {
  title: 'Team',
  intro: 'Editors see only the clients you assign to them. You see everything.',
  add: 'Add person',
  addTitle: 'Add person',
  addDescription: 'They sign in with their Tailscale login.',
  nameLabel: 'Name',
  emailLabel: 'Login',
  emailPlaceholder: 'name@example.com',
  roleLabel: 'Role',
  cancel: 'Cancel',
  create: 'Add',
  creating: 'Adding…',
  noName: 'Give them a name.',
  noEmail: 'Give them a login.',
  badEmail: 'A login has no spaces.',
  failed: 'Couldn’t add them.',
  empty: 'No one on the team yet.',
  emptyHint: 'Click Add person to give an editor access to some of your clients.',
  allClients: 'All clients',
  noClients: 'None yet',
  remove: 'Remove',
  removeKeep: 'Keep them',
  removing: 'Removing…',
  removeFailed: 'Couldn’t remove them',
  roleFailed: 'Couldn’t change the role',
} as const;

/** The two roles, in the order the dialog offers them, with a line each. */
export const ROLE_CHOICES: readonly { role: TeamRole; label: string; hint: string }[] = [
  { role: 'editor', label: 'Editor', hint: 'Sees only the clients assigned to them.' },
  { role: 'admin', label: 'Admin', hint: 'Sees everything, like you.' },
];

/** "Remove Yael?" */
export function removeTitle(name: string): string {
  return `Remove ${name}?`;
}

/** What removing a person does, said before they are removed. */
export const REMOVE_WARNING =
  'They can’t open the engine any more and their clients are no longer assigned to them. A client left with no editors is yours only.';

/** The menu item that flips a person's role. */
export function changeRoleLabel(role: TeamRole): string {
  return role === 'admin' ? 'Make editor' : 'Make admin';
}

/**
 * What to say under the fields about a person before they are sent, or `null` when they can go:
 * the same rules the server applies (a name, a login without spaces). Whether the login is on the
 * team already is the server's to say.
 */
export function addPersonProblem(name: string, email: string): string | null {
  if (name.trim() === '') return TEAM_TEXT.noName;
  if (email.trim() === '') return TEAM_TEXT.noEmail;
  if (/\s/.test(email.trim())) return TEAM_TEXT.badEmail;
  return null;
}

/** The server's own reason for a refusal, or a plain line when it gave none. */
export function teamErrorText(error: unknown, fallback: string = TEAM_TEXT.failed): string {
  if (error instanceof ApiError && error.message !== '') return error.message;
  return fallback;
}
