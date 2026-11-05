// What the Clients table says of a client's Instagram while Clients × Instagram is on (board
// CLList, L1), as pure functions: which kind of row a client is, the words of the three number
// columns and what each sorts by. The cells (columns.tsx) only lay these out.

import type { ChangeTone } from '@/features/analytics/jobs-tiles-view';
import {
  countText,
  NO_NUMBER,
  signedText,
  timesText,
} from '@/features/clients/instagram/instagram-text';
import type { ClientSummary } from './clients';

/**
 * What a row is:
 * - `account`: a client with an account a scan can read, with its numbers (or dashes until the
 *   first scan has read them).
 * - `private`: an account the scan cannot read past its profile ("Account is private").
 * - `none`: no account yet ("No Instagram yet").
 * The last two sit under the others and say so in place of the numbers, with Add Instagram.
 */
export type InstagramRowKind = 'account' | 'private' | 'none';

/** The kind of row the client is. A list sent without Instagram counts as no account. */
export function instagramRowKind(client: Pick<ClientSummary, 'instagram'>): InstagramRowKind {
  const { instagram } = client;
  if (instagram == null) return 'none';
  return instagram.private === true ? 'private' : 'account';
}

/**
 * Whether the Clients list draws the client's Instagram photo in its row. A private account keeps
 * its coloured initials there, as the board draws it (L1): its numbers are not read and the row says
 * so. The client page's header keeps the photo.
 */
export function rowShowsPhoto(client: Pick<ClientSummary, 'instagram'>): boolean {
  return instagramRowKind(client) !== 'private';
}

/** What a row without numbers says in place of them. */
export const NO_INSTAGRAM_TEXT = 'No Instagram yet';
export const PRIVATE_ACCOUNT_TEXT = 'Account is private';

/** The words of a row that has no numbers; `null` for a row that has them. */
export function instagramStatusText(kind: InstagramRowKind): string | null {
  if (kind === 'private') return PRIVATE_ACCOUNT_TEXT;
  return kind === 'none' ? NO_INSTAGRAM_TEXT : null;
}

/** "@falcon.fpv": the handle under the name of a client with an account; `null` for any other row. */
export function handleText(client: Pick<ClientSummary, 'instagram'>): string | null {
  const { instagram } = client;
  return instagramRowKind(client) === 'account' && instagram != null
    ? `@${instagram.handle}`
    : null;
}

/** Followers: "12,480", or a dash until a scan has read the profile. */
export function followersText(client: Pick<ClientSummary, 'instagram'>): string {
  const followers = client.instagram?.followers ?? null;
  return followers === null ? NO_NUMBER : countText(followers);
}

/** This week: "+312", "−42", "0", or a dash until two scans a week apart have read it. */
export function weekText(client: Pick<ClientSummary, 'instagram'>): string {
  const change = client.instagram?.weekChange ?? null;
  return change === null ? NO_NUMBER : signedText(change);
}

/** The colour of this week's change: green up, red down, muted for none. */
export function weekTone(client: Pick<ClientSummary, 'instagram'>): ChangeTone {
  const change = client.instagram?.weekChange ?? null;
  if (change === null || change === 0) return 'same';
  return change > 0 ? 'better' : 'worse';
}

/** Ours vs theirs: "3.6×" (our typical plays ÷ theirs), or a dash until there is a ratio. */
export function oursVsTheirsText(client: Pick<ClientSummary, 'instagram'>): string {
  const ratio = client.instagram?.oursVsTheirs ?? null;
  return ratio === null ? NO_NUMBER : timesText(ratio);
}

/**
 * What the three number columns sort by: the number, or `undefined` for a row that has none (no
 * account, a private one, nothing read yet), which the table puts last whichever way it sorts.
 */
export const CLIENT_INSTAGRAM_SORT_VALUE: Readonly<
  Record<'followers' | 'week' | 'ours', (client: ClientSummary) => number | undefined>
> = {
  followers: (client) =>
    instagramRowKind(client) === 'account' ? (client.instagram?.followers ?? undefined) : undefined,
  week: (client) =>
    instagramRowKind(client) === 'account'
      ? (client.instagram?.weekChange ?? undefined)
      : undefined,
  ours: (client) =>
    instagramRowKind(client) === 'account'
      ? (client.instagram?.oursVsTheirs ?? undefined)
      : undefined,
};
