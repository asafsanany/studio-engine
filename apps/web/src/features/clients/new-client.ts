import { clientNameProblem } from '@studio/shared';
import { ApiError } from '@/data';

/** The words of the New client dialog. */
export const NEW_CLIENT_TEXT = {
  open: 'New client',
  title: 'New client',
  description: 'A folder with this name is made in Studio Inbox.',
  nameLabel: 'Name',
  cancel: 'Cancel',
  create: 'Create',
  creating: 'Creating…',
  /** The optional Instagram field, shown while Clients × Instagram is on. */
  instagramLabel: 'Instagram (optional)',
  instagramPlaceholder: '@name or instagram.com/name',
  instagramHint: 'A name or a link. Its page is read once a week, about $0.05.',
  /** The client exists but its Instagram was not saved: the button goes on to the new client. */
  continue: 'Continue',
  /** The server refused a name that is taken (409). */
  taken: 'A client with that name already exists.',
  /** The request failed in a way that has no message of its own. */
  failed: 'Couldn’t create the client.',
} as const;

/**
 * What to say under the Name field about a name before it is sent, or `null` when it can go: the
 * same rules the server applies (empty, too long, `/` or `:`, a leading `.` or `_`, hidden characters, double spaces), so the answer
 * comes without a round trip. Whether the name is taken is the server's to say.
 */
export function newClientNameProblem(name: string): string | null {
  return clientNameProblem(name);
}

/**
 * What to say under the Name field about a refused request: the server's own reason for a name it
 * can't use (400), that the name is taken (409), "Cannot reach the Studio Engine server." when it
 * did not answer.
 */
export function newClientErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return NEW_CLIENT_TEXT.taken;
    return error.message === '' ? NEW_CLIENT_TEXT.failed : error.message;
  }
  return NEW_CLIENT_TEXT.failed;
}

/**
 * What to say under the Instagram field when the client was made but its account was not saved
 * (the server refused it, or did not answer): the reason, and where to add it again.
 */
export function newClientInstagramFailure(error: unknown): string {
  const reason = error instanceof Error && error.message !== '' ? error.message : '';
  const added = 'The client was created, but its Instagram was not saved.';
  return reason === ''
    ? `${added} Add it from the client’s menu.`
    : `${added} ${reason} Add it from the client’s menu.`;
}
